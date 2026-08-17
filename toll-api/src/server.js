'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { computeToll, decodePolyline, cumulativeKm, CLASS_MAP } = require('./engine');

/** Total length of a polyline in km. */
function polyLengthKm(poly) { const c = cumulativeKm(poly); return c[c.length - 1] || 0; }
const { PlazaStore, CorrectionStore, DATA_DIR } = require('./store');

const PORT = process.env.PORT || 8080;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY || '';
const API_KEYS = (process.env.API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);

const plazaStore = new PlazaStore();
const corrections = new CorrectionStore();
plazaStore.load();

/* ── helpers ────────────────────────────────────────────────── */

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 2e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function authed(req) {
  if (!API_KEYS.length) return true; // open in dev; set API_KEYS in production
  const k = req.headers['x-api-key'];
  return k && API_KEYS.includes(String(k));
}

/** Stable hash of the ordered stop list - the key corrections are stored under. */
function routeHash(points) {
  const s = points.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(';');
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/**
 * Fetch road geometry. Google first (best Indian coverage and traffic-aware
 * timing), OSRM as the free fallback so the service still answers with no key.
 */
async function fetchRoute(points) {
  if (GOOGLE_KEY) {
    try {
      const body = {
        origin: { location: { latLng: { latitude: points[0][0], longitude: points[0][1] } } },
        destination: { location: { latLng: { latitude: points[points.length - 1][0], longitude: points[points.length - 1][1] } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        extraComputations: ['TOLLS'],
      };
      const mids = points.slice(1, -1);
      if (mids.length) body.intermediates = mids.map((p) => ({ location: { latLng: { latitude: p[0], longitude: p[1] } } }));
      const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask':
            'routes.distanceMeters,routes.duration,routes.description,routes.polyline.encodedPolyline,routes.travelAdvisory.tollInfo',
        },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      const rt = d?.routes?.[0];
      if (rt?.polyline?.encodedPolyline) {
        return {
          poly: decodePolyline(rt.polyline.encodedPolyline),
          km: Math.round((rt.distanceMeters || 0) / 1000),
          durSec: parseInt(String(rt.duration || '0').replace('s', ''), 10) || 0,
          description: rt.description || '',
          googleCarToll: (() => {
            try {
              const tp = rt.travelAdvisory.tollInfo.estimatedPrice;
              const inr = tp.find((x) => x.currencyCode === 'INR') || tp[0];
              return Math.round(parseFloat(inr.units || 0) + (inr.nanos ? inr.nanos / 1e9 : 0));
            } catch { return 0; }
          })(),
          provider: 'google',
        };
      }
    } catch (e) { console.error('[route] google failed:', e.message); }
  }
  // OSRM fallback
  const coordStr = points.map((p) => `${p[1]},${p[0]}`).join(';');
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`);
  const d = await r.json();
  const rt = d?.routes?.[0];
  if (!rt) throw new Error('no route from any provider');
  return {
    poly: rt.geometry.coordinates.map((x) => [x[1], x[0]]),
    km: Math.round(rt.distance / 1000),
    durSec: Math.round(rt.duration || 0),
    description: '',
    googleCarToll: 0,
    provider: 'osrm',
  };
}

/* ── routes ─────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (p === '/v1/health') {
    return send(res, 200, {
      ok: true,
      rateSets: plazaStore.versions(),
      nextRevision: plazaStore.nextRevision(),
      routeProvider: GOOGLE_KEY ? 'google+osrm' : 'osrm',
    });
  }

  if (p === '/v1/coverage') {
    const plazas = plazaStore.plazasFor(url.searchParams.get('date'));
    const byState = {};
    let confirmed = 0, single = 0, conflict = 0;
    for (const z of plazas) {
      const st = z.state || 'unknown';
      byState[st] = (byState[st] || 0) + 1;
      if (z.confidence === 'confirmed') confirmed++;
      else if (z.confidence === 'conflict') conflict++;
      else single++;
    }
    return send(res, 200, {
      totalPlazas: plazas.length,
      byState,
      confidence: { confirmed, singleSource: single, conflict },
      rateVersion: plazaStore.setFor(url.searchParams.get('date'))?.version || null,
    });
  }

  if (p === '/v1/changes') {
    const file = path.join(DATA_DIR, 'CHANGELOG.json');
    let log = [];
    try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no changelog yet */ }
    const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10));
    return send(res, 200, { entries: log.slice(0, limit) });
  }

  if (p === '/v1/rates/versions') {
    return send(res, 200, { versions: plazaStore.versions(), nextRevision: plazaStore.nextRevision() });
  }

  if (p === '/v1/plazas' && req.method === 'GET') {
    const plazas = plazaStore.plazasFor(url.searchParams.get('date'));
    const bbox = url.searchParams.get('bbox'); // minLat,minLng,maxLat,maxLng
    let out = plazas;
    if (bbox) {
      const [a, b, c, d] = bbox.split(',').map(Number);
      out = plazas.filter((z) => z.lat >= a && z.lat <= c && z.lng >= b && z.lng <= d);
    }
    return send(res, 200, { count: out.length, plazas: out.slice(0, 2000) });
  }

  if (p === '/v1/toll/route' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: 'invalid api key' });
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'invalid JSON body' }); }

    const stops = body.stops;
    if (!Array.isArray(stops) || stops.length < 2) {
      return send(res, 400, { error: 'stops must be an array of at least 2 [lat,lng] points' });
    }
    const tripType = body.tripType === 'roundtrip' ? 'roundtrip' : 'oneway';
    const vehicle = body.vehicle || 'bus';
    const sameDayReturn = !!body.sameDayReturn;
    const journeyDate = body.journeyDate || null;

    // For a round trip the vehicle physically returns to the origin, so the
    // geometry must include the return leg - otherwise plazas that only exist
    // on the return path are missed entirely.
    const points = tripType === 'roundtrip' ? [...stops, stops[0]] : stops;

    let route;
    /* If the caller already has the route geometry (FleetHub does - it draws the
       map from it), accept it directly. This avoids paying for and waiting on a
       second routing call, and guarantees the toll is computed against exactly
       the path shown to the operator rather than a re-routed approximation. */
    if (Array.isArray(body.geometry) && body.geometry.length > 1) {
      const poly = body.geometry;
      route = { poly, km: body.distanceKm || Math.round(polyLengthKm(poly)), durSec: body.durationSec || 0,
                description: body.routeDescription || '', googleCarToll: body.googleCarToll || 0, provider: 'client-supplied' };
    } else if (typeof body.polyline === 'string' && body.polyline.length > 10) {
      const poly = decodePolyline(body.polyline);
      route = { poly, km: body.distanceKm || Math.round(polyLengthKm(poly)), durSec: body.durationSec || 0,
                description: body.routeDescription || '', googleCarToll: body.googleCarToll || 0, provider: 'client-polyline' };
    } else {
      try { route = await fetchRoute(points); }
      catch (e) { return send(res, 502, { error: 'routing failed', detail: e.message }); }
    }

    const rateSet = plazaStore.setFor(journeyDate);
    const plazas = rateSet ? rateSet.plazas : [];

    // For a round trip the returned polyline already covers both directions, so
    // each plaza is met once per direction - pass tripType 'oneway' to the
    // engine and let the geometry account for the second crossing.
    const result = computeToll(route.poly, plazas, {
      vehicle,
      tripType: 'oneway',
      sameDayReturn,
      corridorKm: body.corridorKm || 1.2,
    });

    const hash = routeHash(stops);
    const cons = corrections.consensus(hash, result.vehicleClass, tripType);

    return send(res, 200, {
      routeHash: hash,
      tripType,
      vehicle,
      vehicleClass: result.vehicleClass,
      journeyDate: journeyDate || new Date().toISOString().slice(0, 10),
      distanceKm: route.km,
      durationSec: route.durSec,
      routeDescription: route.description,
      routeProvider: route.provider,
      rateVersion: rateSet ? rateSet.version : null,
      rateEffectiveFrom: rateSet ? rateSet.effectiveFrom : null,
      nextRevision: plazaStore.nextRevision(),
      toll: {
        status: result.status,
        total: result.total,
        currency: 'INR',
        plazaCount: result.plazaCount,
        coveragePct: result.coveragePct,
        confidence: result.confidence,
        highways: result.highways,
        plazas: result.plazas,
        warning: result.warning,
      },
      crossCheck: {
        googleCarToll: route.googleCarToll || null,
        note: route.googleCarToll
          ? 'Google publishes a NON-COMMERCIAL (car) toll. Useful only as a sanity check against the car class, never as a commercial vehicle total.'
          : null,
      },
      operatorConsensus: cons,
    });
  }

  if (p === '/v1/corrections' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: 'invalid api key' });
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
    const { routeHash: rh, vehicleClass, tripType, reportedTotal, operatorId, note } = body;
    if (!rh || !reportedTotal) return send(res, 400, { error: 'routeHash and reportedTotal are required' });
    const cons = corrections.add({
      routeHash: rh,
      vehicleClass: vehicleClass || 'bus3',
      tripType: tripType || 'oneway',
      reportedTotal,
      operatorId,
      note,
    });
    return send(res, 200, { ok: true, consensus: cons });
  }

  if (p === '/v1/admin/reload' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: 'invalid api key' });
    const n = plazaStore.load();
    return send(res, 200, { ok: true, rateSetsLoaded: n, versions: plazaStore.versions() });
  }

  return send(res, 404, { error: 'not found', see: '/v1/health' });
});

server.listen(PORT, () => {
  console.log(`FleetHub Toll API listening on :${PORT}`);
  console.log(`rate sets: ${JSON.stringify(plazaStore.versions())}`);
});

module.exports = server;
