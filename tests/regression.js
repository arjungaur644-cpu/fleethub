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

/* ── 5. Khatu–Salasar circuit (live bug, Sep 2026) ───────────────
   "Khurja se jaegi Khatu shyam salasar balaji jeernamata jaipur Pushkar
   vrindavan vapis khurja" was quoted ONE-WAY (vapis not recognised), split
   "salasar balaji" into Salasar + Mehendipur, dropped Jeen Mata and kept
   "jaegi" as a place. Runs the real parser in jsdom when available. */
console.log('\n[5] Rajasthan circuit enquiry');
{
  let JSDOM = null;
  try { JSDOM = require('jsdom').JSDOM; } catch (e) {}
  checkTrue('jeen mata in place table', /'jeen mata':\[27\.44/.test(html));
  checkTrue('model is not the retired gemini-1.5-flash', !/gemini-1\.5-flash:generateContent/.test(html));
  checkTrue('map markers are numbers, not letters', !/String\.fromCharCode\(65\+i\)/.test(html));
  if (!JSDOM) { console.log('        (jsdom not installed — parser run skipped: npm i jsdom)'); }
  else {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.github.io/fleethub/' });
    const r = dom.window.parseTrip('Khurja se jaegi Khatu shyam salasar balaji jeernamata jaipur Pushkar vrindavan vapis khurja Bus AC ,54 seater');
    check('stops parsed', r.cities, ['khurja','khatu shyam','salasar','jeen mata','jaipur','pushkar','vrindavan']);
    check('"vapis khurja" = round trip', r.isRet, true);
    check('seats', r.seats, 54);
    check('Ghabhana spelling → Gabhana, "hindon ghaziabad" = one stop',
      dom.window.parseTrip('Ghabhana se hindon ghaziabad Traveller 20 seater').cities, ['gabhana','hindon']);
    check('locality + city = one stop', dom.window.parseTrip('Gabhana se raj nagar ghaziabad').cities, ['gabhana','raj nagar']);
    checkTrue('unlocated stop stops the quote (no silent drop)', /askPlaceQuestion\(stillMissing\[0\],\{status:'missing',opts:\[\]\},function\(\)\{runCalc\(\);\}\);\s*return;/.test(html));
    const w=dom.window;
    check('spelling normaliser: Ghabhana ≈ Gabhana', w.nameSim('ghabhana','Gabhana') >= 0.9, true);
    check('clear winner is used, not asked',
      w.decidePlace('ghabhana',[{title:'Gabhana',sim:1,score:0.95,km:30,co:[28.05,77.96]},{title:'Gobana',sim:0.7,score:0.5,km:600,co:[25,80]}]).status, 'ok');
    check('two real matches → ask with options',
      w.decidePlace('rampur',[{title:'Rampur',sim:1,score:0.9,km:120,co:[28.8,79.0]},{title:'Rampur',sim:1,score:0.85,km:300,co:[31.4,77.6]}]).status, 'ask');
    check('nothing matching well → ask "did you mean"',
      w.decidePlace('xyzpur',[{title:'Ajaypur',sim:0.5,score:0.4,km:50,co:[28,78]}]).kind, 'spelling');
    /* RCA Sep 2026: Pahasu → Rithala missed Luharali (NH-34, Sikandrabad–Dadri) */
    const nat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'plazas.json'), 'utf8'));
    w.eval('PLAZA_DB = mergePlazas(' + JSON.stringify(nat.plazas) + ')');
    const nh34 = [[28.2536,77.855],[28.407,77.8498],[28.451,77.695],[28.552,77.553],[28.62,77.42]];
    const t = w.computeRouteToll(nh34, 'bus', false);
    check('Luharali matched on the GT Road (NH-34) corridor', !!(t && t.plazas.some(z => /luhar/i.test(z.name))), true);
    check('national plaza table loaded (1,000+ plazas)', w.eval('PLAZA_DB.length') > 1000, true);
    check('hand-verified Yamuna Expwy plazas kept', w.eval("PLAZA_DB.some(function(z){return z.id==='ye_jewar';})"), true);
    check('"mehandipur balaji" still resolves', dom.window.parseTrip('khurja se mehandipur balaji').cities, ['khurja','mehendipur balaji']);
    dom.window.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
