# Legal basis for FleetHub's toll numbers

This is the primary law FleetHub's toll engine ultimately answers to —
supplied directly by Arjun (government PDFs), not sourced secondhand.

## The rules
**National Highways Fee (Determination of Rates and Collection) Rules, 2008**
(G.S.R. 838(E), 5 Dec 2008, made under s.9 of the National Highways Act,
1956), as amended (most recently the Fourth Amendment, G.S.R. 279(E),
13 Apr 2026 — that amendment only added an overloading-fee rule; it did not
touch the base rates below).

### Rule 4(2) — base rate of fee per km, base year 2007-08
| Vehicle class | Rs/km | Ratio to car |
|---|---|---|
| Car, Jeep, Van or Light Motor Vehicle | 0.65 | 1.00x |
| Light Commercial Vehicle, Light Goods Vehicle or Mini Bus | 1.05 | 1.615x |
| Bus or Truck (two axles) | 2.20 | 3.385x |
| Three-axle commercial vehicles | 2.40 | 3.69x |
| HCM / EME / Multi-Axle Vehicle (4-6 axles) | 3.45 | 5.31x |
| Oversized vehicles (7+ axles) | 4.20 | 6.46x |

Rule 4(7): an **expressway** is charged at **1.25x** this rate.
Rule 3(4): two-wheelers, three-wheelers, tractors, combine harvesters and
animal-drawn vehicles pay **no fee**.

**Important:** "Car/Jeep/Van/LMV" is ONE class (an SUV registers under this
class under the Motor Vehicles Act, 1988) and "LCV/Light Goods
Vehicle/Mini Bus" is ONE class — there's no separate "SUV" or "minibus"
row in the law. Confirmed empirically too: across all 1,235 real plaza
rates in `data/plazas.json`, `suv == car` in 1235/1235 and
`tempo == minibus` in 1235/1235. FleetHub's `NHAI_CLASS_MULT` in
`index.html` reflects this (fixed Sep 2026 — it previously used made-up
in-between multipliers for suv/minibus).

### Rule 5(3) — annual revision formula
```
Applicable rate = base rate + base rate x [(WPI_A - WPI_B) / WPI_B] x 0.4
```
- **WPI_B** is fixed forever at **208.7** (wholesale price index, week
  ending 6 Jan 2007).
- **WPI_A** is the WPI for **December of the year immediately preceding**
  the 1-April revision.
- Revision is capped at 40% of the WPI increase, and rates round to the
  nearest Rs 5 (Rule 4(5)).

FleetHub does **not** re-derive today's rupee rate from this formula —
that would need the exact WPI series back to 2007 and is one more place to
get it slightly wrong. Instead FleetHub's priced table
(`data/plazas.json`) is built from NHAI's own live, already-revised
current rates (see `nh_official_roster.json`'s sibling priced dataset),
so the *absolute* rupee numbers come straight from NHAI having already
applied this formula. What this legal text is used for is validating the
*ratios between vehicle classes*, which stay constant across the annual
revision because every class is scaled by the same factor — that's the
check above.

## Source documents
Supplied by Arjun, 26 Sep 2026:
- National Highways Fee (Determination of Rates and Collection) Rules,
  2008 — full consolidated text with amendment footnotes through 2026.
- Ministry of Road Transport & Highways, "Formula for Toll Collection"
  (PIB press release, 6 Dec 2023, PRID 1983060) — plain-language summary
  of the same Rule 4/5 mechanism, from a written Rajya Sabha reply by the
  Minister.
- G.S.R. 279(E), 13 Apr 2026 (Gazette of India) — Fourth Amendment Rules,
  2026, substituting Rule 10 (overloading fee via FASTag/UPI). Not wired
  into FleetHub's calculator — FleetHub doesn't currently model overload
  detection — but recorded here so it isn't lost.
