# FleetHub — Version History

## v3.7 — Primary law read; SUV/minibus multiplier bug fixed (Sep 2026)

**Ask:** stop trusting secondhand summaries of how toll is calculated —
read the actual law and rebuild the estimate engine on it.

**What was supplied:** the full National Highways Fee (Determination of
Rates and Collection) Rules, 2008 (with every amendment footnote through
2026), the Ministry's own "Formula for Toll Collection" PIB press release,
and the April 2026 Fourth Amendment gazette notification (overloading fee
via FASTag/UPI — recorded but not wired in; FleetHub doesn't model
overload weight).

**What it found — a real bug:** Rule 4(2) sets ONE base rate for the
"Car/Jeep/Van/Light Motor Vehicle" class and ONE for "Light Commercial
Vehicle/Light Goods Vehicle/Mini Bus" — there is no separate SUV or
minibus row in the law (an SUV registers as a car under the Motor
Vehicles Act). FleetHub's estimate-mode multipliers
(`NHAI_CLASS_MULT` — only used when no real plaza is matched) had
invented in-between values instead: `suv:1.5` and `minibus:2.6`, both
wrong. Checked against all 1,235 real plaza rates already in
`data/plazas.json`: **`suv == car` in 1235/1235 plazas, `tempo == minibus`
in 1235/1235** — so this isn't a legal technicality, it's what NHAI
actually charges everywhere, and the app's own real data already knew it.

**Fixed:** `NHAI_CLASS_MULT` is now `{cab:1.0, suv:1.0, tempo:1.615,
minibus:1.615, bus:3.385}` — the exact Rule 4(2) ratios, matching the
2026 real-data ratios (suv/car = 1.000, tempo-minibus/car = 1.609–1.616,
bus/car = 3.371–3.375) almost exactly. Every place in the app that reads
this constant (toll-breakdown explainer, Google-scaling estimate, per-km
fallback, live recalculation on vehicle-type change) picks it up
automatically — no separate hardcoded copies existed.

**Added:** `data/nh-fee-legal-basis.md` — the rule numbers, base rates,
expressway multiplier (1.25x), exempt vehicle classes, and the Rule 5(3)
annual-revision formula, as a permanent citation trail. The absolute
rupee numbers still come from NHAI's own live-published rates (already in
`data/plazas.json`) rather than FleetHub re-deriving 18 years of WPI
compounding itself — the law is used here to validate the *ratios*
between vehicle classes, which is what the estimate fallback needs and
what the bug was in.

2 regression tests replaced the old (accidentally-wrong) "multipliers
strictly increase" assertion with the correct legal/empirical equalities.

## v3.6 — Official NHAI roster loaded; real state-wise coverage (Sep 2026)

**Ask:** load the official NH toll-plaza source list and use it to build a
proper, auditable toll structure — not another guess at coverage.

**What was supplied:** a government-format "National Highway (NH) Fee
Plazas" master list (NETC Plaza Code, State, District, Section of Highway,
NH no., PIU, NHAI Regional Office) — 1,221 rows, extracted cleanly from the
PDF's own text layer (not OCR, so no transcription errors).

**What shipped:**
1. `data/nh_official_roster.json` — the cleaned 1,221-row roster, state
   names normalised (fixed ALL-CAPS variants, "Panjab"→Punjab,
   "Odisa"→Odisha, three rows where the source PDF had a district name
   sitting in the State column). This is identity/location data only — no
   rates — and is kept separate from `data/plazas.json` (the priced table)
   so it can never silently zero-out a real toll.
2. `scripts/coverage_report.py` — matches every roster plaza against the
   priced table (same-state name match first, nationwide fallback second,
   since the two datasets share no common ID) and prints real per-state
   coverage. Re-run any time the priced table changes.
3. **Real, computed coverage — not estimated:** 1,049 of 1,221 official
   plazas (85.9%) are priced in FleetHub today. By state: Telangana,
   West Bengal, Chhattisgarh, Jammu & Kashmir, Goa at 100%; Bihar 98%;
   most major states 80–95%; weakest are Delhi (25% — mostly unpriced
   Delhi-Meerut Expressway closed-loop plazas), Haryana (64%) and Gujarat
   (75%). Full table in `scripts/coverage_report.py` output.
4. `scripts/nh_fee_plazas_truly_missing.json` — the 172 roster plazas with
   no priced match yet, as the worklist for the next rate-table expansion.
2 new regression tests lock in that the roster loads and every row carries
the fields coverage-auditing needs.

## v3.5 — NHAI verify links: proving the toll source, plaza by plaza (Sep 2026)

**Ask:** confirm the single root source everyone (Google, TollGuru, FleetHub)
ultimately traces back to for Indian toll data, and give a concrete way to
check any specific plaza against it.

**Finding:** that root is NHAI itself — legally the National Highways Fee
(Determination of Rates and Collection) Rules, 2008 (revised every April 1),
operationally exposed live at `tis.nhai.gov.in`. Neither Google nor TollGuru
claims an independent dataset; TollGuru's own site links back to NHAI's own
portal rather than describing its own survey. FleetHub's plaza table was
itself built from NHAI's own official raw export, so it shares that same
root rather than a re-derived copy of it.

**What shipped:**
1. Every plaza already carried its real NHAI `TollPlazaID` inside its
   internal id (`nhai_1088` → `1088`) — it just wasn't surfaced. Added
   `nhaiIdOf()` / `nhaiVerifyUrl()` and wired them through
   `computeRouteToll()`, so each matched plaza now carries a live
   `tis.nhai.gov.in/TollInformation?TollPlazaID=<N>` link.
2. The toll-breakdown drawer (`showTollDetail`) shows a **"✓ Verify on
   NHAI ↗"** link under every plaza that has one — opens NHAI's own live
   rate table for that exact plaza, in a new tab.
3. Coverage check: **1,126 of 1,235 plazas (91%)** in `data/plazas.json`
   are NHAI-sourced and now carry a working verify link; the remaining 109
   are hand-verified community entries (expressway zones, etc.) with no
   single NHAI TollPlazaID and intentionally show no link rather than a
   fabricated one.
4. Confirmed the underlying raw NHAI dataset FleetHub already uses
   (`toll-api/data/india_tolls_raw_1674.json`) is identical, record for
   record, to the freshest available pull as of this release (same 1,674
   IDs, same `last_updated` timestamp) — so no data refresh was needed,
   only the ID → link plumbing.
5. Attempted to reach NHAI's own bulk "Toll Plazas at a Glance" listing
   page directly — it times out to automated fetches (only individual
   per-plaza pages are reachable that way), so the verify link is
   per-plaza rather than a bulk cross-check page; that per-plaza link is
   still the same government page a person would land on manually.
4 new regression tests lock in: the URL builder's exact output, that
non-NHAI community plazas never get a fabricated link, that every link on
a matched route is well-formed, and that a real route resolves at least
one true NHAI id.

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
