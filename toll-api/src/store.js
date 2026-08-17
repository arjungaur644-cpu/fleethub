'use strict';
const fs = require('fs');
const path = require('path');

/**
 * PLAZA STORE + RATE VERSIONING
 *
 * NHAI revises toll rates every year on 1 April (and occasionally at individual
 * plazas mid-year). A quote generated in March must not silently use April's
 * rates, and a quote generated today must not use last year's.
 *
 * So rates are stored as VERSIONED SETS with effective dates, and every lookup
 * resolves the set that was in force on the journey date. The API echoes the
 * rate version it used, so a quote can always be reconciled later - which is
 * what makes disputed tolls resolvable instead of arguable.
 */

const DATA_DIR = process.env.TOLL_DATA_DIR || path.join(__dirname, '..', 'data');

class PlazaStore {
  constructor() {
    this.sets = [];      // [{ version, effectiveFrom, source, plazas: [...] }]
    this.loaded = false;
  }

  load() {
    this.sets = [];
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('plazas-') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (raw && Array.isArray(raw.plazas)) {
          this.sets.push({
            version: raw.version || f.replace(/^plazas-|\.json$/g, ''),
            effectiveFrom: raw.effectiveFrom || '1970-01-01',
            source: raw.source || 'unknown',
            plazas: raw.plazas,
          });
        }
      } catch (e) {
        console.error(`[store] skipping malformed ${f}: ${e.message}`);
      }
    }
    this.sets.sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));
    this.loaded = true;
    return this.sets.length;
  }

  /** The rate set in force on a given date (defaults to today). */
  setFor(dateISO) {
    if (!this.loaded) this.load();
    const when = dateISO ? new Date(dateISO) : new Date();
    for (const s of this.sets) {
      if (new Date(s.effectiveFrom) <= when) return s;
    }
    return this.sets[this.sets.length - 1] || null;
  }

  plazasFor(dateISO) {
    const s = this.setFor(dateISO);
    return s ? s.plazas : [];
  }

  versions() {
    if (!this.loaded) this.load();
    return this.sets.map((s) => ({
      version: s.version,
      effectiveFrom: s.effectiveFrom,
      source: s.source,
      plazaCount: s.plazas.length,
    }));
  }

  /**
   * Days until the next annual revision. Surfaced in the API so a consumer can
   * warn an operator that a quote for a future journey may be priced on rates
   * that will have changed by the time the trip runs.
   */
  nextRevision() {
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
    const next = new Date(`${year}-04-01T00:00:00Z`);
    return { date: next.toISOString().slice(0, 10), daysAway: Math.ceil((next - now) / 86400000) };
  }
}

/**
 * OPERATOR CORRECTIONS
 *
 * Operators cross these plazas daily and hold FASTag statements. Their reported
 * figures are the highest-quality ground truth available, so corrections are
 * stored and aggregated by MEDIAN (resistant to a single mistyped entry).
 * A route with 3+ independent corrections is treated as verified.
 */
class CorrectionStore {
  constructor(file = path.join(DATA_DIR, 'corrections.json')) {
    this.file = file;
    this.rows = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) this.rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { this.rows = []; }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.rows, null, 2));
    } catch (e) { console.error('[corrections] save failed', e.message); }
  }

  key(routeHash, vehicleClass, tripType) {
    return `${routeHash}|${vehicleClass}|${tripType}`;
  }

  add({ routeHash, vehicleClass, tripType, reportedTotal, operatorId, note }) {
    this.rows.push({
      key: this.key(routeHash, vehicleClass, tripType),
      reportedTotal: Number(reportedTotal),
      operatorId: operatorId || 'anon',
      note: note || '',
      at: new Date().toISOString(),
    });
    this.save();
    return this.consensus(routeHash, vehicleClass, tripType);
  }

  consensus(routeHash, vehicleClass, tripType) {
    const k = this.key(routeHash, vehicleClass, tripType);
    const vals = this.rows.filter((r) => r.key === k).map((r) => r.reportedTotal).filter((n) => n > 0).sort((a, b) => a - b);
    if (!vals.length) return null;
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
    return {
      median,
      reports: vals.length,
      spread: vals.length > 1 ? vals[vals.length - 1] - vals[0] : 0,
      verified: vals.length >= 3,
    };
  }
}

module.exports = { PlazaStore, CorrectionStore, DATA_DIR };
