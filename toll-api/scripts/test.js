#!/usr/bin/env node
'use strict';
/* Regression tests. The Khurja->Ujjain case is anchored to a REAL measured
   figure (TollGuru: Rs 1,445 by car), so a future change that breaks the
   closed-system model fails here instead of in a customer quote. */
const { computeToll } = require('../src/engine');
const db = require('../data/plazas-2026-09-national.json');

function interp(a,b,n){const o=[];for(let i=0;i<=n;i++)o.push([a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n]);return o;}
const dme=[[28.2536,77.8556],[28.22,77.06],[27.48,76.74],[26.83,76.42],[26.56,76.47],[25.25,76.05],[24.59,76.16],[24.22,75.95],[23.45,75.82],[23.1765,75.7885]];
let poly=[];for(let i=0;i<dme.length-1;i++)poly=poly.concat(interp(dme[i],dme[i+1],90));

let pass=0, fail=0;
function check(name, actual, expected, tolPct){
  const ok = tolPct!=null
    ? Math.abs(actual-expected)/expected*100 <= tolPct
    : actual===expected;
  console.log((ok?'  PASS  ':'  FAIL  ')+name+'  got='+actual+' expected='+expected+(tolPct?` (+/-${tolPct}%)`:''));
  ok?pass++:fail++;
}

console.log('\nKhurja -> Ujjain via Delhi-Mumbai Expressway');
const car = computeToll(poly, db.plazas, {vehicle:'cab', tripType:'oneway'});
check('car one-way matches TollGuru measured Rs1445', car.total, 1445, 8);
check('finds 8 plazas', car.plazaCount, 8);
check('confidence high', car.confidence, 'high');

const bus = computeToll(poly, db.plazas, {vehicle:'bus', tripType:'oneway'});
check('bus one-way > car', bus.total > car.total, true);
check('bus/car ratio in NHAI band 3.0-4.0', bus.total/car.total > 3 && bus.total/car.total < 4, true);

const busRT = computeToll(poly, db.plazas, {vehicle:'bus', tripType:'roundtrip'});
check('round trip is exactly 2x one-way', busRT.total, bus.total*2);
check('outbound equals return', busRT.outboundTotal, busRT.returnTotal);

console.log('\nEmpty-region guard');
const empty = computeToll([[12.9,77.6],[13.0,77.7]], db.plazas, {vehicle:'bus'});
check('returns no_data instead of a guess', empty.status, 'no_data');
check('total is null, not zero', empty.total, null);

/* Regression: Khurja->Aligarh was reported as "no toll" by the app when a real
   plaza (Somna/Gabhana, NH-91) exists on that route - confirmed against
   tis.nhai.gov.in TollPlazaID=430. Locked in so the gap cannot silently return. */
console.log('\nKhurja -> Aligarh via NH-91 (Somna/Gabhana toll plaza)');
function interp2(a,b,n){const o=[];for(let i=0;i<=n;i++)o.push([a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n]);return o;}
const nh91=[[28.2536,77.8556],[28.15,77.90],[28.0492,77.9610],[27.95,78.00],[27.8974,78.0880]];
let poly91=[];for(let i=0;i<nh91.length-1;i++)poly91=poly91.concat(interp2(nh91[i],nh91[i+1],60));
const alig=computeToll(poly91, db.plazas, {vehicle:'bus', tripType:'oneway'});
check('finds the Somna plaza (not no_data)', alig.status, 'ok');
check('bus one-way matches NHAI published rate exactly', alig.total, 935);
const aligRT=computeToll(poly91, db.plazas, {vehicle:'bus', tripType:'roundtrip'});
check('round trip = 2x single (no same-day discount requested)', aligRT.total, 1870);
const aligSameDay=computeToll(poly91, db.plazas, {vehicle:'bus', tripType:'roundtrip', sameDayReturn:true});
check('same-day return uses the REAL per-class NHAI rate, not the car rate', aligSameDay.total, 1400);
check('same-day return is cheaper than two full crossings', aligSameDay.total < aligRT.total, true);

/* Regression: merging the national mirror with our verified corridor set
   double-counted Somna (two source records for the same physical plaza,
   2.1km apart, under the name-blind clustering radius). A single bus
   crossing must be charged ONCE, not twice. */
check('Somna is not double-counted across merged sources', alig.plazaCount, 1);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
