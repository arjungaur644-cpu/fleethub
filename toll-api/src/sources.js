'use strict';
/**
 * SOURCE FETCHERS
 *
 * Every function here returns the SAME normalised shape so the merge/diff
 * engine downstream never needs to know which source a record came from:
 *
 *   { id, name, highway, state, lat, lng, rates:{...}, sourceId, sourceUrl, fetchedAt }
 *
 * Two independent sources are wired in deliberately, not for redundancy
 * theatre but because CROSS-VALIDATION is the actual product feature: a plaza
 * confirmed by two independent pulls is trustworthy in a way a single scrape
 * can never claim to be. See confidence.js for how that gets scored.
 */

const CLASS_FROM_CSV = {
  car_multi: 'car', car_single: 'car',
  lcv_multi: 'lcv', lcv_single: 'lcv',
  bus_multi: 'bus2', bus_single: 'bus2',
  multiaxle_multi: 'bus3', multiaxle_single: 'bus3',
  four_six_axle_multi: 'truck3', four_six_axle_single: 'truck3',
  hcm_multi: 'oversized', hcm_single: 'oversized',
  seven_plus_axle_multi: 'oversized', seven_plus_axle_single: 'oversized',
};

/** Minimal CSV parser that handles the embedded-JSON quoting this dataset uses. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      } else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * SOURCE B: community mirror of the NHAI map endpoint, updated monthly via
 * GitHub Actions. github.com/geohacker/toll-plazas-india
 *
 * This is the SAME underlying NHAI data (it scrapes tis.nhai.gov.in's own
 * map service) but fetched independently on a different schedule - useful as
 * a cross-check even before considering it a fallback.
 */
async function fetchGeohackerMirror(csvUrl) {
  const url = csvUrl || 'https://raw.githubusercontent.com/geohacker/toll-plazas-india/master/data/01-09-2020/tolls-with-metadata.csv';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geohacker mirror HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h.replace(/^"|"$/g, ''), i]));

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < header.length - 2) continue;
    const name = row[idx.name];
    const lat = parseFloat(row[idx.lat]);
    const lng = parseFloat(row[idx.lon]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    let ratesRaw = {};
    try { ratesRaw = JSON.parse(row[idx.rates]); } catch { /* leave empty */ }

    const rates = {};
    for (const [csvKey, cls] of Object.entries(CLASS_FROM_CSV)) {
      const v = ratesRaw[csvKey];
      if (v != null && v > 0 && rates[cls] == null) rates[cls] = Math.round(v);
    }
    if (!Object.keys(rates).length) continue;

    out.push({
      id: `gh_${row[idx.id] || r}`,
      name: name.trim(),
      highway: '',
      state: '',
      lat, lng,
      rates,
      direction: 'both',
      feeEffectiveDate: row[idx.fee_effective_date] || null,
      sourceId: 'geohacker_mirror',
      sourceUrl: 'https://github.com/geohacker/toll-plazas-india',
      fetchedAt: new Date().toISOString(),
    });
  }
  return out;
}

/**
 * SOURCE A: the live NHAI endpoint directly. This is the same endpoint the
 * geohacker mirror itself scrapes, called fresh instead of relying on their
 * monthly cadence. NOTE: this must run from a server with unrestricted
 * outbound HTTPS - it will not work from a sandboxed/browser environment
 * (tis.nhai.gov.in has no CORS headers, which is the whole reason a backend
 * service is required at all).
 */
async function fetchNhaiLive() {
  const res = await fetch('https://tis.nhai.gov.in/TollPlazaService.asmx/GetTollPlazaInfoForMapOnPC', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://tis.nhai.gov.in/map1.htm',
      'User-Agent': 'Mozilla/5.0 (compatible; FleetHubTollSync/1.0)',
    },
    body: '',
  });
  if (!res.ok) throw new Error(`NHAI live endpoint HTTP ${res.status}`);
  const data = await res.json();
  const list = data.d ? JSON.parse(data.d) : data;
  if (!Array.isArray(list)) throw new Error('unexpected NHAI response shape');

  return list.map((p, i) => ({
    id: `nhai_live_${p.TollPlazaID || i}`,
    name: (p.TollPlazaName || p.tollPlazaName || 'Toll plaza').trim(),
    highway: p.NHNo || p.nhNo || '',
    state: p.StateName || p.stateName || '',
    lat: parseFloat(p.Latitude || p.latitude),
    lng: parseFloat(p.Longitude || p.longitude),
    rates: {}, // the map endpoint gives location only; per-plaza rates need a follow-up TollInformation?TollPlazaID=N call
    direction: 'both',
    tollPlazaId: p.TollPlazaID || p.tollPlazaID || null,
    sourceId: 'nhai_tis_live',
    sourceUrl: 'https://tis.nhai.gov.in',
    fetchedAt: new Date().toISOString(),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

module.exports = { fetchGeohackerMirror, fetchNhaiLive, parseCsv, CLASS_FROM_CSV };
