#!/usr/bin/env node
'use strict';
/**
 * RATE INGESTION
 *
 * Where the numbers come from, in order of authority:
 *
 *  1. NHAI Toll Information System  https://tis.nhai.gov.in
 *     The authoritative source. Publishes every plaza with its rates by vehicle
 *     class. No documented public API - it is a server-rendered portal, so this
 *     runs SERVER SIDE (a browser cannot reach it: no CORS headers).
 *
 *  2. data.gov.in NHAI datasets      https://data.gov.in
 *     Official open-data catalogue. Carries periodic plaza/fee CSV releases.
 *     Has a real API with a key. Slower to update than TIS but easier to parse.
 *
 *  3. NHAI / MoRTH fee notifications
 *     The annual 1 April revision is published as a gazette notification. Worth
 *     watching because it states the revision percentage, which lets you sanity
 *     check a scraped set before it goes live.
 *
 *  4. Operator FASTag statements (via /v1/corrections)
 *     Ground truth for the routes your operators actually run. Highest quality
 *     per-route data you will ever get, and it costs nothing.
 *
 * This script normalises whatever it fetches into one versioned rate set:
 *   data/plazas-<version>.json
 *
 * IMPORTANT: it never silently overwrites a live set. A new set is written with
 * its own effectiveFrom date and the API resolves which one applies per journey
 * date, so a quote raised in March stays reproducible after the April revision.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TOLL_DATA_DIR || path.join(__dirname, '..', 'data');
const DATAGOV_KEY = process.env.DATAGOV_API_KEY || '';

/** NHAI fee-rule classes we normalise everything into. */
const CLASSES = ['car', 'lcv', 'bus2', 'bus3', 'truck3', 'oversized'];

/**
 * Column-name variants seen across NHAI/data.gov.in releases. Kept explicit
 * because these headers change between releases and a silent mismatch would
 * write zeros into a live rate set.
 */
const COLUMN_ALIASES = {
  name: ['tollname', 'plaza_name', 'plazaname', 'name_of_toll_plaza', 'tollplazaname'],
  lat: ['latitude', 'lat', 'plaza_latitude'],
  lng: ['longitude', 'lon', 'lng', 'plaza_longitude'],
  highway: ['nh_number', 'nh_no', 'highway', 'nhno', 'national_highway'],
  state: ['state', 'state_name'],
  car: ['car_jeep_van', 'car', 'carjeepvan', 'single_journey_car'],
  lcv: ['lcv', 'lcv_lgv_mini_bus', 'light_commercial_vehicle'],
  bus2: ['bus_truck', 'bus_and_truck', 'bus2axle', 'bus_truck_2_axle'],
  bus3: ['three_axle', '3_axle_vehicle', 'threeaxlevehicle', 'bus3axle'],
  truck3: ['hcm_eme', 'heavy_construction_machinery', 'hcm'],
  oversized: ['oversized_vehicle', 'oversized', 'seven_or_more_axle'],
};

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function pick(row, field) {
  const aliases = COLUMN_ALIASES[field] || [];
  for (const key of Object.keys(row)) {
    const nk = norm(key);
    if (aliases.some((a) => norm(a) === nk)) return row[key];
  }
  for (const key of Object.keys(row)) {
    const nk = norm(key);
    if (aliases.some((a) => nk.includes(norm(a)))) return row[key];
  }
  return null;
}

function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Normalise a raw record into our plaza schema. Returns null if unusable. */
function normalisePlaza(row, idx) {
  const lat = num(pick(row, 'lat'));
  const lng = num(pick(row, 'lng'));
  const name = pick(row, 'name');
  // A plaza with no usable coordinates cannot be matched to a route, so it is
  // dropped rather than stored as an unmatched dead record.
  if (!lat || !lng || lat < 6 || lat > 38 || lng < 68 || lng > 98) return null;

  const rates = {};
  for (const c of CLASSES) {
    const v = num(pick(row, c));
    if (v != null && v > 0) rates[c] = Math.round(v);
  }
  if (!Object.keys(rates).length) return null;

  // Fill missing classes from the NHAI class ratios rather than leaving holes,
  // and mark them so a consumer knows which figures were derived.
  const derived = [];
  const RATIO = { car: 1, lcv: 1.6, bus2: 3.3, bus3: 3.6, truck3: 5.2, oversized: 6.3 };
  const base = rates.car || (rates.lcv ? rates.lcv / RATIO.lcv : null) || (rates.bus2 ? rates.bus2 / RATIO.bus2 : null);
  if (base) {
    for (const c of CLASSES) {
      if (rates[c] == null) { rates[c] = Math.round(base * RATIO[c]); derived.push(c); }
    }
  }

  return {
    id: `nhai_${idx}_${norm(name).slice(0, 24)}`,
    name: String(name || 'Toll plaza').trim(),
    highway: String(pick(row, 'highway') || '').trim(),
    state: String(pick(row, 'state') || '').trim(),
    lat, lng,
    direction: 'both',   // refine per plaza where known; see engine.js
    rates,
    derivedClasses: derived,
  };
}

/** data.gov.in resource fetch (paginated). */
async function fetchDataGov(resourceId) {
  if (!DATAGOV_KEY) throw new Error('DATAGOV_API_KEY not set - get one free at data.gov.in');
  const all = [];
  const LIMIT = 1000;
  for (let offset = 0; offset < 20000; offset += LIMIT) {
    const u = `https://api.data.gov.in/resource/${resourceId}?api-key=${DATAGOV_KEY}&format=json&limit=${LIMIT}&offset=${offset}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`data.gov.in HTTP ${r.status}`);
    const d = await r.json();
    const recs = d.records || [];
    all.push(...recs);
    if (recs.length < LIMIT) break;
  }
  return all;
}

/** Load a local CSV/JSON export (the reliable path when a portal has no API). */
function loadLocal(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : (j.records || j.plazas || []);
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    const o = {};
    headers.forEach((h, i) => { o[h] = String(cells[i] ?? '').replace(/^"|"$/g, ''); });
    return o;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = Object.fromEntries(
    args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; })
  );

  const version = opt.version || new Date().toISOString().slice(0, 7);
  const effectiveFrom = opt.effectiveFrom || `${new Date().getFullYear()}-04-01`;

  let rows = [];
  let source = '';
  if (opt.file) {
    rows = loadLocal(opt.file);
    source = `local:${path.basename(opt.file)}`;
  } else if (opt.resource) {
    rows = await fetchDataGov(opt.resource);
    source = `data.gov.in:${opt.resource}`;
  } else {
    console.error(`
Usage:
  node scripts/ingest.js --file=nhai-plazas.csv --version=2026-04 --effectiveFrom=2026-04-01
  node scripts/ingest.js --resource=<data.gov.in resource id> --version=2026-04

Getting the source data:
  * tis.nhai.gov.in  - browse to the plaza list, export, save the CSV, use --file
  * data.gov.in      - search "toll plaza", copy the resource id, use --resource
                       (set DATAGOV_API_KEY first)
`);
    process.exit(1);
  }

  const plazas = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const p = normalisePlaza(r, i);
    if (p) plazas.push(p); else skipped++;
  });

  if (!plazas.length) {
    console.error('No usable plaza records were parsed. Check the column names against COLUMN_ALIASES.');
    process.exit(1);
  }

  /* Sanity gate: refuse to write a set that looks broken. Writing a bad rate set
     is worse than writing none, because every quote downstream inherits it. */
  const withCar = plazas.filter((p) => p.rates.car > 0);
  const medianCar = withCar.map((p) => p.rates.car).sort((a, b) => a - b)[Math.floor(withCar.length / 2)];
  if (!medianCar || medianCar < 20 || medianCar > 500) {
    console.error(`Refusing to write: median car rate ₹${medianCar} is outside the plausible ₹20-500 band. Parsing is probably wrong.`);
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = path.join(DATA_DIR, `plazas-${version}.json`);
  fs.writeFileSync(out, JSON.stringify({
    version, effectiveFrom, source,
    generatedAt: new Date().toISOString(),
    plazaCount: plazas.length,
    plazas,
  }, null, 2));

  console.log(`Wrote ${out}`);
  console.log(`  plazas kept   : ${plazas.length}`);
  console.log(`  rows skipped  : ${skipped} (no coordinates or no rates)`);
  console.log(`  median car    : ₹${medianCar}`);
  console.log(`  effective from: ${effectiveFrom}`);
  console.log(`\nReload the running API:  curl -XPOST localhost:8080/v1/admin/reload -H "X-Api-Key: ..."`);
}

main().catch((e) => { console.error(e); process.exit(1); });
