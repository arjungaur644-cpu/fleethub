# FleetHub — Version History

## v3.4 — RCA: Khurja → Aurangabad → Gurugram → Khurja (Sep 2026)

**Reported:** toll ₹3,836 and 275 km looked wrong vs Google Maps; the maths
underneath did not match the totals.

**Root causes:**
1. **No Google on the new site.** The Google key is saved in the browser per
   website. After moving from Netlify to GitHub Pages the key was not there,
   so distance came from free OpenStreetMap (OSRM) — shown only as a small
   "OSRM ✓". OSRM takes the shortest road, which here was the EPE → KMP →
   Sohna detour through 5 tolled plazas, not the Delhi road Google picks
   (car toll ₹155 vs ₹620).
2. **Round-trip toll doubled a full loop.** The route line already included
   the return leg, and the engine still multiplied by 2.
3. **Stale formula text.** "274 km × ₹5.95/km — no NHAI route match" was
   written at first paint and never updated after 5 plazas were found.
4. **Legs did not add up.** 35 + 121 + 118 = 274 vs 275 total (each leg
   rounded separately); fuel line kept the first-paint km.
5. **Gurgaon was not in the verified places table** (nor Faridabad, Sonipat …).
6. Changing vehicle type re-priced tolls from an old fixed-leg table.

**Fixes:** loud warning with a Fix button whenever Google is not used
(names the reason, incl. Google's own error text); plaza engine counts each
separate pass and never doubles a full-trip line; toll/fuel formula text
follows the live numbers; legs always sum to the total; NCR hubs added;
vehicle change re-prices from the real route. 4 new regression tests.

## v3.3 — Toll RCA: missed Luharali plaza (Sep 2026)

**Incident:** "Pahasu se rithala delhi" (bus) showed toll ₹785. The route runs
on NH-34 through the Luharali plaza (between Sikandrabad and Dadri, bus ₹495),
which was not listed. ₹785 = 132 km × ₹1.75 × 3.4 — the per-km guess (tier 5).

**Root cause — every tier above the guess failed silently:**
1. Toll API (Cloud Run) gave no usable answer within 9 s — most likely a cold
   start (the service scales to zero).
2. The in-browser fallback held only ~40 hand-seeded plazas. Luharali was not
   one of them. A loader for a full table existed but was never wired up.
3. Google returned no toll price: the request did not include the FASTag pass.
4. The per-km guess was shown as "TOLLS (EST)" without saying no plaza was found.

**Fixes:**
- `data/plazas.json`: national table (NHAI official FY26-27 rates + FleetHub
  merged set, 1,235 plazas, de-duplicated) built by
  `scripts/build_browser_plazas.py`, loaded by the app from the same site.
- Duplicate guard: the same plaza within 2.5 km (or 8 km with a shared name) is
  counted once, so a bigger table cannot double-charge.
- Toll API answer is rejected if it sees fewer plazas than the national table.
- Toll API woken on page load; timeout 12 s.
- Google requests ask for the FASTag price (retry without if rejected).
- Guess now labelled "estimate — no plaza data for this road, verify".
- Two-stop trips now show real road options (e.g. GT Road vs expressway), each
  with its own plaza-matched toll.
- Regression test: Luharali must match on the NH-34 corridor.

**To refresh the table:** run `python3 scripts/build_browser_plazas.py` after
the weekly toll sync, then commit `data/plazas.json`.

## v3.0 — National Toll Engine (current)
**Commit:** `75cf457`

- Wired a **self-hosted FleetHub Toll API** as a configurable toll source
  (Accuracy settings → "FleetHub Toll Engine"). When you deploy the backend
  service and paste its URL, it outranks TollGuru in the toll chain.
- If the API flags a plaza-data **conflict**, FleetHub skips it rather than
  trusting disputed data — falls through to the next tier cleanly.
- Live health-check on save: shows plaza count and rate version the moment
  you connect it.
- Toll chain is now 6 tiers: your saved rate → **FleetHub Toll API** →
  TollGuru → in-browser engine → Google×class → per-km estimate.

*Note: the backend service itself (570-plaza national database,
cross-validation, weekly auto-sync) is built and tested, but not yet
deployed to a public URL — that needs your own hosting account (Railway /
Render / Fly). See the separate `fleethub-toll-api` package delivered
earlier in this conversation.*

---

## v2.x — Toll accuracy and credibility (this session)
Commits `2ea7db3` → `326000d`

- **Provider chain engine**: 5 ranked source chains (language, places,
  distance, optimize, toll) with automatic fallback, timeouts, and visible
  provenance — replaces ad-hoc if/else fallback logic everywhere.
- **Real toll engine**: geometric plaza matching against the actual route
  polyline, replacing per-km guessing. Validated within 3% of a real
  TollGuru measurement.
- **Fixed a 92% toll under-count** on closed-system expressways (Yamuna
  Expwy, Delhi-Mumbai Expwy) — each segment gantry is now summed correctly
  instead of charged once per direction.
- **Fixed the Khurja→Aligarh "no toll" bug** — added the real Somna/Gabhana
  plaza sourced live from `tis.nhai.gov.in`, and caught two more bugs while
  testing it (same-day return using the wrong vehicle class, single-plaza
  routes wrongly marked low-confidence).
- Google's car-only toll is now scaled by NHAI vehicle class before use —
  previously under-quoted buses ~3.5×.
- TollGuru integration as a real plaza-data source (optional key).
- TollGuru-style presentation: trip summary strip, toll plaza pins on the
  map, FASTag vs cash per plaza.
- Google Places knowledge base as the primary place resolver, replacing a
  finite hand-written list — fixed "wagha border" and similar multi-word
  name splitting.
- Quote self-check audit card: 8 independently-recomputed checks, honest
  about which numbers are real data vs estimates.
- Sources card showing which tier answered at every step.

---

## v2.0 — AI trip understanding
Commits `052f450` → `2ea7db3`

- Gemini-based trip parsing with rule-based fallback (works with no API key).
- Fixed voice input duplication (cumulative transcript merging, session-scoped
  commits across Android's pause-restart behaviour).
- AI route agent: ranks real computed route options, never invents numbers.
- Hindi/Devanagari place-name understanding, spoken filler-word filtering.
- 2-opt route optimizer replacing naive nearest-neighbour ordering.
- Multi-state place disambiguation ("which Bageshwar?") with tappable options.

---

## v1.x — Core calculator fixes
Commits `d2e9ed7` → `faa4c64`

- Fixed multi-stop parsing (comma/dash/Hindi separators) — was only reading
  the first two stops.
- Region-biased geocoding — stopped matching wrong far-away villages.
- Gemini Vision for Hindi handwriting OCR.
- Cache-control headers so updates appear instantly on the live app.

---

## What each version actually fixed, in one line

| Version | The one thing that was broken before |
|---|---|
| v1.x | Multi-stop trips silently became 2-stop trips |
| v2.0 | Voice input repeated itself; AI couldn't understand free-form Hindi |
| v2.x | Tolls were guessed, not calculated; wrong places matched wrong states |
| v3.0 | No path to plug in a real, comprehensive, self-hosted toll database |
