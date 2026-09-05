#!/usr/bin/env node
'use strict';
/**
 * FLEETHUB REGRESSION TESTS
 *
 * Every test here corresponds to a REAL bug found in live use. The point is
 * not coverage for its own sake — it is that each of these was spotted by the
 * operator rather than by me, and each one now fails loudly here before a
 * release instead of quietly on someone's phone.
 *
 * Run:  node tests/regression.js
 * Exits non-zero on any failure, so it can gate a deploy.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : `\n          got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`));
  ok ? pass++ : fail++;
}
function checkTrue(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : `\n          ${detail || ''}`));
  cond ? pass++ : fail++;
}

/* ── 1. SYNTAX: every inline script must parse ───────────────────
   Broke the live app three separate times by inserting code into the middle
   of an existing comment block. This catches that instantly. */
console.log('\n[1] Script syntax');
{
  const vm = require('vm');
  const blocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  let bad = 0;
  blocks.forEach((b, i) => {
    const body = b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    if (!body.trim()) return;
    try { new vm.Script(body); } catch (e) { bad++; console.log(`        block ${i}: ${e.message}`); }
  });
  checkTrue('all inline scripts parse', bad === 0, `${bad} block(s) failed`);
}

/* ── 2. PLACE COVERAGE ───────────────────────────────────────────
   Ranisati resolved ~900km away. Sanwariya Seth did not resolve at all.
   Both were found by the operator, not by testing. These assert that the
   pilgrimage sites operators actually quote are present AND plausible. */
console.log('\n[2] Place coverage & plausibility');
{
  const ccMatch = html.match(/var CC=\{[\s\S]*?\};/);
  checkTrue('CC place table found', !!ccMatch);
  const CC = ccMatch ? eval('(' + ccMatch[0].replace(/^var CC=/, '').replace(/;$/, '') + ')') : {};

  // Places operators in this region genuinely quote. Adding a name here means
  // the next release cannot ship without it resolving.
  const MUST_HAVE = {
    'khurja': [28.25, 77.85], 'khatu shyam': [27.40, 75.40], 'ranisati': [28.13, 75.40],
    'mehandipur balaji': [26.80, 76.55], 'sawariya seth': [24.66, 74.40],
    'salasar': [27.61, 74.73], 'vrindavan': [27.57, 77.66], 'govardhan': [27.50, 77.46],
    'nathdwara': [24.94, 73.82], 'katra': [32.99, 74.93], 'haridwar': [29.95, 78.16],
  };
  Object.keys(MUST_HAVE).forEach((name) => {
    const got = CC[name];
    if (!got) { checkTrue(`"${name}" present in place table`, false, 'MISSING — will fall through to geocoder and may match the wrong place'); return; }
    const [eLat, eLng] = MUST_HAVE[name];
    const off = Math.abs(got[0] - eLat) + Math.abs(got[1] - eLng);
    checkTrue(`"${name}" resolves near its real location`, off < 0.5,
      `got [${got}] expected ~[${eLat},${eLng}] — off by ${off.toFixed(2)} degrees`);
  });

  // Every coordinate must be inside India's bounding box. A typo'd sign or
  // transposed lat/lng is exactly how a stop ends up in the wrong hemisphere.
  let outOfBounds = [];
  Object.keys(CC).forEach((k) => {
    const c = CC[k];
    if (!Array.isArray(c) || c.length !== 2) { outOfBounds.push(k + ' (malformed)'); return; }
    if (c[0] < 6 || c[0] > 37 || c[1] < 68 || c[1] > 98) outOfBounds.push(`${k} [${c}]`);
  });
  checkTrue('all coordinates inside India', outOfBounds.length === 0, outOfBounds.join(', '));
}

/* ── 3. DISTANCE DISPLAY CONSISTENCY ─────────────────────────────
   The 819-vs-909 bug: distance shown in several places, updated by separate
   code paths, one forgot to update. Assert there is now ONE setter and that
   no code path writes these elements directly behind its back. */
console.log('\n[3] Distance display single-source-of-truth');
{
  checkTrue('setTripDistance() exists', /function setTripDistance\(/.test(html));
  checkTrue('auditDistanceConsistency() exists', /function auditDistanceConsistency\(/.test(html));

  // Direct writes to heroTotalKm outside the setter are how the bug returns.
  const heroWrites = (html.match(/getElementById\('heroTotalKm'\)/g) || []).length;
  checkTrue('heroTotalKm only touched inside setTripDistance/audit', heroWrites <= 2,
    `${heroWrites} references — expected 2 (one in setter, one in auditor)`);
}

/* ── 4. TOLL ENGINE SANITY ───────────────────────────────────────
   Guards the vehicle-class multipliers and the per-km fallback rate against
   silent edits — these directly scale every toll figure quoted. */
console.log('\n[4] Toll constants');
{
  const multMatch = html.match(/var NHAI_CLASS_MULT=\{[^}]*\}/);
  checkTrue('NHAI_CLASS_MULT present', !!multMatch);
  if (multMatch) {
    const M = eval('(' + multMatch[0].replace(/^var NHAI_CLASS_MULT=/, '') + ')');
    check('car multiplier is 1.0 (baseline)', M.cab, 1.0);
    checkTrue('bus multiplier in NHAI band 3.0-4.0', M.bus >= 3.0 && M.bus <= 4.0, `got ${M.bus}`);
    checkTrue('multipliers increase with vehicle size',
      M.cab < M.suv && M.suv < M.tempo && M.tempo < M.minibus && M.minibus < M.bus);
  }
  const perKm = html.match(/var TOLL_PER_KM_CAR=([\d.]+)/);
  checkTrue('per-km fallback rate is plausible (Rs1-3/km for a car)',
    perKm && +perKm[1] >= 1 && +perKm[1] <= 3, perKm ? `got ${perKm[1]}` : 'not found');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
