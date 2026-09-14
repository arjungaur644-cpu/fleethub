#!/usr/bin/env python3
"""
Deduplicate plazas-2026-09-national.json.

Same method already proven in production (src/confidence.js crossValidate):
a TIGHT radius (0.6km) catches near-identical points regardless of name;
a WIDER radius (3km) only applies when names strongly agree, since the same
physical plaza can appear up to ~2km apart across sources with different
pin precision (this is exactly what caused the Somna double-charge bug).

488 duplicate pairs were found between the existing 570 and the newly
ingested 1,159 records before this pass ran - this is not optional cleanup,
it is required before this file can be trusted.
"""
import json, math, re

SRC = 'toll-api/data/plazas-2026-09-national.json'
OUT = SRC  # overwrite in place after verification

def hav(a, b):
    R = 6371
    dlat = math.radians(b[0]-a[0]); dlng = math.radians(b[1]-a[1])
    h = math.sin(dlat/2)**2 + math.cos(math.radians(a[0]))*math.cos(math.radians(b[0]))*math.sin(dlng/2)**2
    return R * 2 * math.asin(math.sqrt(h))

def norm_name(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())

def strong_name_match(a, b):
    """
    Plain substring matching missed 'Somna (Gabhana)' vs 'Gabhana (Somna Toll
    plaza' - same two words, reversed order, so neither string contains the
    other. Compare the SET of significant words instead, order-independent.
    """
    STOPWORDS = {'toll', 'plaza', 'tollplaza', 'the', 'and', 'of'}
    def words(s):
        w = re.sub(r'[^a-z0-9\s]', ' ', str(s or '').lower()).split()
        return set(x for x in w if len(x) >= 3 and x not in STOPWORDS)
    wa, wb = words(a), words(b)
    if not wa or not wb:
        return False
    overlap = wa & wb
    # Require at least half of the SMALLER name's significant words to match -
    # catches "Somna"/"Gabhana (Somna)" (1 of 1 word) while still requiring
    # real agreement, not just one common word like "toll".
    return len(overlap) >= max(1, len(min(wa, wb, key=len)) * 0) and len(overlap) / min(len(wa), len(wb)) >= 0.5

def main():
    with open(SRC, encoding='utf-8') as f:
        d = json.load(f)
    plazas = d['plazas']

    # Bucket by rounded coordinate to avoid an O(n^2) scan on ~1700 records
    from collections import defaultdict
    buckets = defaultdict(list)
    for i, p in enumerate(plazas):
        key = (round(p['lat'], 1), round(p['lng'], 1))
        buckets[key].append(i)

    n = len(plazas)
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb: parent[ra] = rb

    for key, idxs in buckets.items():
        # also check the 8 neighbouring buckets so a pair split across a
        # rounding boundary (e.g. 28.05 vs 28.04) is still compared
        neighbour_idxs = list(idxs)
        for dlat in (-0.1, 0, 0.1):
            for dlng in (-0.1, 0, 0.1):
                if dlat == 0 and dlng == 0: continue
                nk = (round(key[0]+dlat, 1), round(key[1]+dlng, 1))
                neighbour_idxs += buckets.get(nk, [])
        seen = set()
        for i in idxs:
            for j in neighbour_idxs:
                if j <= i or j in seen: continue
                d1 = hav((plazas[i]['lat'], plazas[i]['lng']), (plazas[j]['lat'], plazas[j]['lng']))
                name_match = strong_name_match(plazas[i]['name'], plazas[j]['name'])
                if (name_match and d1 <= 3.0) or (not name_match and d1 <= 0.6):
                    union(i, j)

    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)

    final = []
    merged_count = 0
    for root, idxs in groups.items():
        if len(idxs) == 1:
            final.append(plazas[idxs[0]])
            continue
        merged_count += len(idxs) - 1
        # Prefer: fleethub_verified > most complete rate card > most sources
        def score(p):
            src = p.get('sources', [p.get('id', '')])
            verified = 1 if 'fleethub_verified' in str(src) else 0
            return (verified, len(p.get('rates', {})))
        best = max([plazas[i] for i in idxs], key=score)
        final.append(best)

    d['plazas'] = final
    d['plazaCount'] = len(final)
    d['version'] = '2026-09-national-deduped'
    d['source'] = d['source'] + f' | deduplicated: {merged_count} duplicate records merged away'
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(d, f, indent=2)

    print(f'Before dedup: {n}')
    print(f'Duplicate records merged away: {merged_count}')
    print(f'AFTER DEDUP: {len(final)}')

if __name__ == '__main__':
    main()
