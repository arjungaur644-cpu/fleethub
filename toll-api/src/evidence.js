'use strict';
/**
 * EVIDENCE STORE
 *
 * Queries the SQLite database that links every rate to an actual source
 * document. This is deliberately separate from PlazaStore (the fast, flat
 * JSON the live toll engine reads on every request) — evidence lookups are
 * rare (an operator asking "prove this number"), not on the hot path, so
 * they get their own slower, richer, joinable store instead of bloating the
 * JSON every request already pays to parse.
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'evidence', 'toll_evidence.db');

function openEvidenceDb() {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

/** Full trace for one plaza: every rate we hold for it, each with its source. */
function getEvidenceForPlaza(plazaId) {
  const db = openEvidenceDb();
  try {
    const rows = db.prepare(`
      SELECT rv.vehicle_class, rv.rate, rv.effective_from, rv.effective_to,
             sd.title, sd.source_url, sd.trust_tier, sd.doc_type, sd.captured_at, sd.notes
      FROM rate_versions rv
      JOIN source_documents sd ON rv.source_document_id = sd.id
      WHERE rv.plaza_id = ?
      ORDER BY rv.vehicle_class, rv.effective_from DESC
    `).all(plazaId);
    return rows;
  } finally {
    db.close();
  }
}

/** Every document currently in the store, for an at-a-glance trust audit. */
function listAllDocuments() {
  const db = openEvidenceDb();
  try {
    return db.prepare(`
      SELECT id, doc_type, trust_tier, title, source_url, captured_at, notes
      FROM source_documents ORDER BY trust_tier, captured_at DESC
    `).all();
  } finally {
    db.close();
  }
}

/** Coverage summary: how many plazas actually have government-tier evidence
    vs. how many are still running on community data with no traceable source. */
function evidenceCoverageSummary() {
  const db = openEvidenceDb();
  try {
    const byTier = db.prepare(`
      SELECT sd.trust_tier, COUNT(DISTINCT rv.plaza_id) as plaza_count
      FROM rate_versions rv JOIN source_documents sd ON rv.source_document_id = sd.id
      GROUP BY sd.trust_tier
    `).all();
    const totalPlazas = db.prepare('SELECT COUNT(*) as n FROM plazas').get().n;
    return { totalPlazasInEvidenceDb: totalPlazas, byTrustTier: byTier };
  } finally {
    db.close();
  }
}

/** Every vehicle type with its sourced specs and which official NHAI class it falls under. */
function listVehicleTypes() {
  const db = openEvidenceDb();
  try {
    return db.prepare(`
      SELECT vt.*, vc.official_name as nhai_official_name, vc.toll_multiplier_of_car
      FROM vehicle_types vt JOIN vehicle_classes vc ON vt.nhai_class_code = vc.code
      ORDER BY vt.seats_min
    `).all();
  } finally {
    db.close();
  }
}

/** The 7 official toll classes with their sourced multiplier. */
function listVehicleClasses() {
  const db = openEvidenceDb();
  try {
    return db.prepare('SELECT * FROM vehicle_classes ORDER BY toll_multiplier_of_car').all();
  } finally {
    db.close();
  }
}

/** Classify by seat count alone - the deterministic fallback when no LLM call is made. */
function classifyBySeats(seats) {
  const db = openEvidenceDb();
  try {
    const row = db.prepare(`
      SELECT * FROM vehicle_types WHERE ? BETWEEN seats_min AND seats_max ORDER BY seats_min LIMIT 1
    `).get(seats);
    return row || null;
  } finally {
    db.close();
  }
}

module.exports = {
  getEvidenceForPlaza, listAllDocuments, evidenceCoverageSummary,
  listVehicleTypes, listVehicleClasses, classifyBySeats,
  DB_PATH,
};
