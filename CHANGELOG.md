# FleetHub — Version History

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
