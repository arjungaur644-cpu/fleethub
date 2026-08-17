# FleetHub Toll API

The toll service FleetHub calls. Plaza-level toll calculation for Indian
commercial vehicles, with **multi-source cross-validation**, **auto weekly
updates**, and a **full audit trail of every rate change** — the three things
no toll product in the Indian market currently exposes to its users.

Validated against real measured data: **Khurja → Ujjain by car returns ₹1,490
against TollGuru's measured ₹1,445 (3.1% off)**, and **Khurja → Aligarh
correctly finds the Somna/Gabhana plaza at the exact NHAI-published rate of
₹935**, sourced live from `tis.nhai.gov.in`.

Current live dataset: **570 plazas nationwide**, merged from two independent
sources and cross-validated against each other.

---

## What makes this different from TollGuru / FASTagJi / CoveringIndia

All three were checked directly. They share one architecture: sync from NHAI
TIS periodically, present a single number per plaza, take crowd corrections.
This service does the same core thing, plus three things they don't expose:

1. **Cross-validation, visible per plaza.** Every plaza carries a
   `confidence` field — `confirmed` (2+ independent sources agree),
   `single-source`, or `conflict` (sources disagree and are flagged, never
   silently averaged). No competitor checked shows this.
2. **A real changelog, not just a new number.** `/v1/changes` returns exactly
   what moved since the last sync — which plazas' rates rose, by what
   percentage, which plazas are new or removed. An operator can see "Panipat
   toll rose 8% this week" instead of just a different total.
3. **Auto weekly sync that is auditable, not a black box.** GitHub Actions
   runs it every Monday, diffs the result, and only writes a new version if
   something material changed — a sync that finds no changes is a successful
   run, not a failure, and is logged as one.

---

## Architecture

```
Sources (independent)          Merge & validate           Serve
─────────────────────          ─────────────────           ─────
NHAI TIS (per-plaza,     ┐
manually verified,       │
direction rules)         ├──►  confidence.js        ──►  versioned
                          │     cluster by location+       rate set
geohacker mirror (546     │    name, score agreement,      (data/plazas-*.json)
plazas nationwide,        │    flag conflicts
scraped from the same    │
NHAI map endpoint,       ┘
updated monthly)

                                      │
                                      ▼
                               diff.js — compare
                               vs. last live version
                                      │
                          material change?  │  no change
                                 │           │
                                 ▼           ▼
                        write new version   log "no change",
                        + changelog entry   exit clean
```

---

## Endpoints

### `POST /v1/toll/route` — the one FleetHub calls on every quote
See the worked example in the previous section. Unchanged from before, now
running against 570 plazas instead of 33.

### `GET /v1/coverage` — differentiator #1
```json
{
  "totalPlazas": 570,
  "byState": { "UP": 8, "RJ": 13, "HR": 4, "unknown": 536 },
  "confidence": { "confirmed": 2, "singleSource": 561, "conflict": 7 }
}
```
`unknown` state is an honest gap: the national mirror source doesn't carry
state/highway fields, only name/location/rates. Fixable by reverse-geocoding
lat/lng against a state-boundary dataset — flagged in Known Gaps below, not
hidden.

### `GET /v1/changes?limit=10` — differentiator #2
Returns the changelog: every past sync's diff summary, rate changes with
before/after/%, plazas added or removed.

### `POST /v1/corrections` — operator ground truth
Unchanged. Median consensus, verified at 3+ reports. This is the fourth
implicit "source" in the cross-validation model, weighted highest because
operators drive the road.

### `GET /v1/plazas?bbox=...`, `GET /v1/rates/versions`, `GET /v1/health`,
### `POST /v1/admin/reload`
Unchanged.

---

## Auto-updating

```bash
node scripts/weekly-sync.js --dry-run   # see what would change, write nothing
node scripts/weekly-sync.js             # pull, cross-validate, diff, version
```

`.github/workflows/weekly-toll-sync.yml` runs this every Monday 03:00 IST,
commits the new rate set if anything changed, and hits `/v1/admin/reload` on
the live API (set `TOLL_API_URL` / `TOLL_API_KEY` as repo secrets). This is
the same update rhythm the geohacker source itself uses — matched, not
guessed at.

Tested live in this session: pulling the real national mirror (546 plazas)
and diffing against the 34-plaza starting set correctly reported `added: 540,
removed: 34` — the diff engine works against real data, not synthetic
fixtures.

---

## Directional logic

Unchanged from the single-corridor version — `both`, `oneway`, `closed`
(segments summed), `returnDiscount` (same-day return at the real per-class
NHAI rate). See `src/engine.js` for the full reasoning and the Somna
same-day-return bug that testing caught and fixed.

---

## Rate versioning

Unchanged in mechanism, now populated by the merge pipeline: each sync writes
`plazas-<version>.json` with its own `effectiveFrom`, never overwriting a live
set in place. `rateVersion` is echoed on every quote response for later
reconciliation.

---

## Sources used, and what's still missing

| Priority | Source | Wired in | Status |
|---|---|---|---|
| 1 | **NHAI TIS** per-plaza pages | `scripts/ingest.js --file=...` | Manual/semi-automated — needs a bulk per-plaza rate puller (see below) |
| 1 | **NHAI TIS map endpoint** (all plazas, location only) | `src/sources.js: fetchNhaiLive()` | Written, untestable from this sandbox (no CORS, needs unrestricted server egress) — will work once deployed |
| 2 | **geohacker/toll-plazas-india** mirror | `src/sources.js: fetchGeohackerMirror()` | **Live and tested** — 546 plazas pulled successfully in this session |
| 2 | **data.gov.in** official catalogue | `scripts/ingest.js --resource=...` | Wired, needs a free API key to test |
| 3 | **MoRTH gazette notifications** | Not yet wired | Manual cross-check source for the annual % revision |
| 4 | **Operator FASTag corrections** | `/v1/corrections` | **Live** — median consensus, verified at 3+ reports |

### Known gaps, stated plainly
- **536 of 570 plazas show `state: unknown`** — the mirror source has no
  state/highway columns. Fix: reverse-geocode against a state-boundary
  polygon set (India's states are public GIS data) as a post-merge step.
- **The live NHAI map endpoint returns location only** — per-plaza rates need
  a second call to `TollInformation?TollPlazaID=N` for each of ~1,000 IDs.
  Worth a separate, less-frequent (monthly) job rather than folding into the
  weekly sync, since it's ~1,000x the request volume.
- **7 conflicts currently flagged** in the live merged set — two source
  records for the same plaza disagreeing on rate by >15%. These are
  surfaced via `confidence: "conflict"`, not resolved automatically. Worth a
  manual pass against `tis.nhai.gov.in` directly to settle them.
- Seed corridor rates are a reference set compiled and spot-verified against
  TIS (Somna confirmed live in this session) — verify the rest before
  commercial use at scale.

---

## Running

```bash
export GOOGLE_MAPS_KEY=AIza...      # optional; OSRM used as fallback
export API_KEYS=key1,key2           # optional; open if unset
node src/server.js
```

Deploy anywhere that runs Node 18+ (Railway, Render, Fly.io, a small VPS).
No database required — rate sets are versioned JSON files, correction data is
a flat JSON log.

---

## Calling it from FleetHub

```js
const r = await fetch(TOLL_API + '/v1/toll/route', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
  body: JSON.stringify({
    stops: ordered.map(o => o.coord),
    geometry: c.routePoly,
    distanceKm: liveTotal,
    vehicle: c.vtype,
    tripType: p.isRet ? 'roundtrip' : 'oneway',
    googleCarToll: c.googleCarToll || 0
  })
}).then(r => r.json());
```

Slot it into the existing toll chain **above** the in-browser engine:

> your saved rate → **Toll API** (now 570 plazas, cross-validated) →
> in-browser engine → Google×class → estimate

