-- FleetHub Toll Evidence Database
--
-- The core idea this schema exists for: every rate a customer gets quoted
-- should be traceable back to an actual document, not just a number sitting
-- in a JSON file. TollGuru and every other calculator we checked just show a
-- total. This lets an operator (or Claude, on request) answer "prove it" for
-- any figure in the system.

CREATE TABLE IF NOT EXISTS plazas (
  id TEXT PRIMARY KEY,              -- e.g. 'nh91_somna'
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  highway TEXT,
  state TEXT,
  system_id TEXT,                   -- e.g. 'epe', 'dme' for closed-loop corridors
  direction_rule TEXT DEFAULT 'both' -- both | closed | oneway | returnDiscount
);

-- Rate HISTORY, not just current rate. NHAI revises rates every 1 April;
-- keeping every version means a quote from March stays reproducible after
-- the April revision, and a dispute can be checked against what was actually
-- in force on the journey date.
CREATE TABLE IF NOT EXISTS rate_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plaza_id TEXT NOT NULL REFERENCES plazas(id),
  vehicle_class TEXT NOT NULL,      -- car | lcv | bus2 | bus3 | truck3 | oversized
  rate INTEGER NOT NULL,
  effective_from TEXT NOT NULL,     -- ISO date
  effective_to TEXT,                -- NULL = still current
  source_document_id INTEGER REFERENCES source_documents(id),
  UNIQUE(plaza_id, vehicle_class, effective_from)
);

-- The actual evidence. Every rate should point here. trust_tier is what lets
-- the app show "government-verified" vs "pending" vs "commercial cross-check
-- only" honestly, instead of presenting everything at the same confidence.
CREATE TABLE IF NOT EXISTS source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,           -- nhtis_page | gazette_pdf | community_dataset | news_report | operator_correction
  trust_tier TEXT NOT NULL,         -- government | community | commercial_crosscheck | operator
  title TEXT NOT NULL,
  source_url TEXT,
  captured_at TEXT NOT NULL,        -- when WE captured/fetched it
  raw_content TEXT,                 -- verbatim text/HTML we actually retrieved, for pages
  file_path TEXT,                   -- path to a stored PDF/file, if any
  content_hash TEXT,                -- sha256 of raw_content, so we can detect if a page changed since capture
  notes TEXT
);

-- Operator FASTag corrections - the ground truth tier, same schema pattern
-- so a correction is just another kind of evidence, traceable the same way.
CREATE TABLE IF NOT EXISTS operator_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_signature TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  reported_total INTEGER NOT NULL,
  operator_id TEXT,
  reported_at TEXT NOT NULL,
  verified INTEGER DEFAULT 0        -- 1 once 3+ independent reports agree
);

CREATE INDEX IF NOT EXISTS idx_rate_versions_plaza ON rate_versions(plaza_id);
CREATE INDEX IF NOT EXISTS idx_rate_versions_current ON rate_versions(plaza_id, effective_to);
CREATE INDEX IF NOT EXISTS idx_corrections_route ON operator_corrections(route_signature);

-- ═══════════════════════════════════════════════════════════════
-- DOMAIN 2: VEHICLE INFORMATION
--
-- Two layers, because they answer two different questions:
--   vehicle_classes  = the 7 OFFICIAL NHAI/IHMCL toll categories a plaza
--                       actually charges by. Sourced verbatim from the
--                       Kherki Daula NHTIS page (see source_documents) —
--                       these are exactly the 7 rows on every real NHAI
--                       rate board, not an invented simplification.
--   vehicle_types    = how an OPERATOR actually describes a vehicle
--                       ("21 seater tempo traveller"), with real specs
--                       (seats, axles, GVW), mapped to which official
--                       class it falls under. This is the layer an LLM
--                       classifier grounds against.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_classes (
  code TEXT PRIMARY KEY,             -- car | lcv | bus2 | upto3axle | axle4to6 | hcm | axle7plus
  official_name TEXT NOT NULL,       -- exact wording from the NHAI rate board
  toll_multiplier_of_car REAL,       -- this class's rate ÷ the car rate, at Kherki Daula (a real ratio, not assumed)
  source_document_id INTEGER REFERENCES source_documents(id)
);

CREATE TABLE IF NOT EXISTS vehicle_types (
  id TEXT PRIMARY KEY,               -- e.g. 'tempo_traveller_26'
  display_name TEXT NOT NULL,        -- 'Tempo Traveller (26-seat / Force Traveller 26)'
  category TEXT NOT NULL,            -- car | suv | tempo | minibus | bus
  seats_min INTEGER,
  seats_max INTEGER,
  axles INTEGER NOT NULL,
  gvw_kg_min INTEGER,                -- Gross Vehicle Weight range, real manufacturer spec
  gvw_kg_max INTEGER,
  nhai_class_code TEXT NOT NULL REFERENCES vehicle_classes(code),
  spec_source_document_id INTEGER REFERENCES source_documents(id),
  notes TEXT
);

-- ═══════════════════════════════════════════════════════════════
-- DOMAIN 3: ROUTES & DISTANCES
--
-- Caches a computed route so the same stop-sequence isn't re-fetched from
-- Google/OSRM every time, AND keeps a record of which source answered and
-- when — the same "know where every number came from" principle as tolls.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS route_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stop_signature TEXT NOT NULL,      -- ordered stop names joined, e.g. 'khurja>ranisati>khatu shyam'
  distance_km REAL NOT NULL,
  duration_sec INTEGER,
  polyline TEXT,                     -- encoded polyline, so a cached route can still feed the toll engine's geometric matching
  source TEXT NOT NULL,              -- google | osrm | estimate
  computed_at TEXT NOT NULL,
  expires_at TEXT,                   -- traffic-aware distances go stale; NULL = cache indefinitely (e.g. an OSRM/geometric result)
  UNIQUE(stop_signature, source)
);

-- Every distinct ordering considered for a stop-set, from the exhaustive
-- search — lets "which order did we check, and what did each one cost"
-- be answered later without re-running the search.
CREATE TABLE IF NOT EXISTS route_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stop_set_signature TEXT NOT NULL,  -- unordered set of stops, e.g. sorted+joined
  ordered_sequence TEXT NOT NULL,    -- the specific order this row represents
  distance_km REAL NOT NULL,
  rank INTEGER NOT NULL,             -- 1 = best of all combinations checked
  is_exhaustive INTEGER DEFAULT 0,   -- 1 if every permutation was actually checked (small trip), 0 if heuristic
  computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_route_cache_sig ON route_cache(stop_signature);
CREATE INDEX IF NOT EXISTS idx_route_options_set ON route_options(stop_set_signature);
