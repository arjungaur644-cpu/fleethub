#!/usr/bin/env python3
"""
Ingest india_tolls_raw_1674.json into FleetHub's plaza format.

Applies every lesson learned verifying this dataset:
  - Records with car_single AND bus_single both zero/missing are EXCLUDED,
    not defaulted to zero - these are closed-loop entry gantries where zero
    is real for that single gantry but meaningless without its exit pair,
    and showing them as "free" would be silently wrong (12.7% of records
    tagged "complete" had this problem).
  - nh_no is NOT used to identify expressways (proven unreliable - 0/14
    DME-named plazas were correctly tagged NE4). Kept only as a display
    field, never for route matching, which is done by geometry regardless.
  - Existing fleethub_verified corridor entries (Somna, DME segments, etc.)
    are preserved and take priority - this script ADDS coverage, it does
    not overwrite hand-verified special-rule plazas.
"""
import json, sys

SRC = 'toll-api/data/india_tolls_raw_1674.json'
CURRENT = 'toll-api/data/plazas-2026-08-national.json'
OUT = 'toll-api/data/plazas-2026-09-national.json'

def to_int(v):
    try:
        f = float(v)
        return int(round(f)) if f > 0 else None
    except (TypeError, ValueError):
        return None

def main():
    with open(SRC, encoding='utf-8') as f:
        raw = json.load(f)
    with open(CURRENT, encoding='utf-8') as f:
        current = json.load(f)

    existing = current['plazas']
    existing_ids = {p['id'] for p in existing}

    added, skipped_no_rate, skipped_inactive = 0, 0, 0
    new_plazas = []

    for r in raw:
        if str(r.get('active', 'true')).lower() == 'false':
            skipped_inactive += 1
            continue

        car = to_int(r.get('car_single'))
        bus2 = to_int(r.get('bus_single'))
        if car is None and bus2 is None:
            skipped_no_rate += 1
            continue

        lat, lng = r.get('latitude'), r.get('longitude')
        try:
            lat, lng = float(lat), float(lng)
        except (TypeError, ValueError):
            continue

        pid = 'nat_' + str(r.get('tollplaza_id'))
        if pid in existing_ids:
            continue

        rates = {}
        if car: rates['car'] = car
        lcv = to_int(r.get('lcv_single'))
        if lcv: rates['lcv'] = lcv
        if bus2: rates['bus2'] = bus2
        m3 = to_int(r.get('multiaxle_single'))
        if m3: rates['bus3'] = m3
        a46 = to_int(r.get('axle_4_6_single'))
        if a46: rates['truck3'] = a46
        a7 = to_int(r.get('axle_7_plus_single'))
        hcm = to_int(r.get('hcm_single'))
        if a7 or hcm: rates['oversized'] = a7 or hcm

        new_plazas.append({
            'id': pid,
            'name': (r.get('tollplaza_name') or 'Toll plaza').strip(),
            'highway': r.get('nh_no') or '',
            'state': r.get('state_name') or '',
            'lat': lat, 'lng': lng,
            'direction': 'both',
            'rates': rates,
            'confidence': 'single-source',
            'sources': ['national_1674_dataset'],
            'sourceCount': 1,
            'effectiveFrom': r.get('rate_effective_date') or None,
        })
        added += 1

    merged = existing + new_plazas
    out = {
        'version': '2026-09-national',
        'effectiveFrom': '2026-09-08',
        'source': f'merge: fleethub_verified + geohacker national mirror + national_1674_dataset ({added} new plazas added, {skipped_no_rate} excluded for missing/zero rate on both car+bus, {skipped_inactive} excluded as inactive)',
        'generatedAt': '2026-09-08T00:00:00Z',
        'plazaCount': len(merged),
        'plazas': merged,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)

    print(f'Existing (verified + geohacker):     {len(existing)}')
    print(f'New from 1,674-record dataset:       {added}')
    print(f'Excluded - no usable rate:            {skipped_no_rate}')
    print(f'Excluded - inactive:                  {skipped_inactive}')
    print(f'TOTAL LIVE AFTER MERGE:               {len(merged)}')
    print(f'Written to: {OUT}')

if __name__ == '__main__':
    main()
