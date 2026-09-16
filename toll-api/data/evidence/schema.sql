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
