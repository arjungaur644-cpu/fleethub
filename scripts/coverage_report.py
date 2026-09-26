"""
Coverage report: how much of the OFFICIAL NHAI toll-plaza roster
(data/nh_official_roster.json) is actually priced in FleetHub's live
toll database (data/plazas.json)?

The roster has no rates -- it's identity/location only (NETC code, state,
district, highway, PIU, regional office), taken from the government-format
master list the user supplied. Matching a roster row to a priced plaza is
done name-first within the same state, then a looser name-only pass
nationwide (handles state-column typos / NCR cross-border naming), since
there's no shared ID between the two datasets.

Run:  python3 scripts/coverage_report.py
Writes: scripts/nh_fee_plazas_truly_missing.json (roster rows with no
priced match -- candidates for the priced table's next refresh).
"""
import json, re, difflib
from collections import defaultdict, Counter

ROSTER = json.load(open('data/nh_official_roster.json'))['plazas']
PRICED = json.load(open('data/plazas.json'))['plazas']

def norm(s):
    s = (s or '').lower()
    s = re.sub(r'\btoll\b|\bplaza\b|\bfee\b|\btp\b|\(.*?\)', '', s)
    s = re.sub(r'[^a-z0-9 ]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def state_of(p):
    return (p.get('state') or p.get('st') or '').strip().lower()

by_state = defaultdict(list)
for p in PRICED:
    by_state[state_of(p)].append(p)

def best(name, cands):
    n = norm(name)
    best_p, best_score = None, 0
    for p in cands:
        score = difflib.SequenceMatcher(None, n, norm(p['name'])).ratio()
        if score > best_score:
            best_p, best_score = p, score
    return best_p, best_score

def is_covered(row):
    cands = by_state[state_of(row)] + by_state['']
    _, score = best(row['name'], cands)
    if score >= 0.72:
        return True
    _, score2 = best(row['name'], PRICED)          # nationwide fallback
    return score2 >= 0.8

missing, by_state_totals, by_state_covered = [], Counter(), Counter()
for r in ROSTER:
    by_state_totals[r['state']] += 1
    if is_covered(r):
        by_state_covered[r['state']] += 1
    else:
        missing.append(r)

print(f"{'State':22} {'official':>8} {'priced':>8} {'coverage':>9}")
for st in sorted(by_state_totals, key=lambda s: -by_state_totals[s]):
    tot, cov = by_state_totals[st], by_state_covered[st]
    print(f"{st:22} {tot:8} {cov:8} {round(100*cov/tot):8}%")
print()
print('TOTAL', sum(by_state_totals.values()), 'covered', sum(by_state_covered.values()),
      '=', round(100*sum(by_state_covered.values())/sum(by_state_totals.values()), 1), '%')

json.dump(missing, open('scripts/nh_fee_plazas_truly_missing.json', 'w'), ensure_ascii=False, indent=1)
print(f'\n{len(missing)} roster plazas have no priced match yet -> scripts/nh_fee_plazas_truly_missing.json')
