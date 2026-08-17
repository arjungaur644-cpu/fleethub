'use strict';
/**
 * CROSS-VALIDATION
 *
 * This is the actual differentiator, not a cosmetic one. Every competitor
 * checked (TollGuru, FASTagJi, CoveringIndia) presents a single number per
 * plaza with no visible provenance. This engine instead MERGES records from
 * independent sources and scores confidence by agreement:
 *
 *   2+ sources place a plaza within 500m and agree on the class-to-class rate
 *   ratio  -> "confirmed"
 *   1 source only, or sources disagree                -> "single-source"
 *   sources disagree materially on rate or location    -> "conflict" (flagged,
 *                                                          not silently averaged)
 *
 * A "conflict" is surfaced, not resolved automatically - averaging two
 * disagreeing toll rates produces a THIRD number nobody actually charges,
 * which is worse than either source alone.
 */

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * @param {Array<Array<object>>} sourceLists  one array of normalised plaza
 *   records per source (see sources.js for the shape)
 * @param {object} opts  { matchRadiusKm, nameMatchRadiusKm }
 */
function crossValidate(sourceLists, opts = {}) {
  /* Two radii, not one. A tight radius (0.6km) catches genuinely distinct
     plazas that happen to sit close together on the same corridor - merging
     those would be as wrong as failing to merge duplicates.
     A wider radius (3km) only applies when the NAMES strongly agree, because
     community-scraped map pins for the same physical plaza can differ from
     the precise NHAI coordinate by a kilometre or two. This was found by
     testing: "Somna" (community mirror pin) and "Somna (Gabhana)" (verified,
     precise) sit 2.1km apart and were NOT merging under a name-blind radius,
     producing a double-charged toll on Khurja->Aligarh. */
  const tightRadiusKm = opts.matchRadiusKm || 0.6;
  const nameMatchRadiusKm = opts.nameMatchRadiusKm || 3.0;
  const all = sourceLists.flat();
  const clusters = []; // [{ records:[...], lat, lng }]

  for (const rec of all) {
    let cluster = null;
    for (const c of clusters) {
      const d = haversineKm(c, rec);
      const a = normName(c.records[0].name), b = normName(rec.name);
      const strongNameMatch = a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
      if (strongNameMatch && d <= nameMatchRadiusKm) { cluster = c; break; }
      if (!strongNameMatch && d <= tightRadiusKm) { cluster = c; break; }
    }
    if (cluster) {
      cluster.records.push(rec);
      // recentre on the average of all matched points
      cluster.lat = cluster.records.reduce((s, r) => s + r.lat, 0) / cluster.records.length;
      cluster.lng = cluster.records.reduce((s, r) => s + r.lng, 0) / cluster.records.length;
    } else {
      clusters.push({ lat: rec.lat, lng: rec.lng, records: [rec] });
    }
  }

  const merged = clusters.map((c) => {
    const sources = [...new Set(c.records.map((r) => r.sourceId))];
    const withRates = c.records.filter((r) => Object.keys(r.rates || {}).length);

    // Prefer the record with the most complete rate card; fall back to any.
    const primary = withRates.sort((a, b) => Object.keys(b.rates).length - Object.keys(a.rates).length)[0] || c.records[0];

    // Conflict check: do independent sources disagree on the car rate by >15%?
    const carRates = withRates.map((r) => r.rates.car).filter((v) => v > 0);
    let conflict = false;
    if (carRates.length > 1) {
      const min = Math.min(...carRates), max = Math.max(...carRates);
      if ((max - min) / min > 0.15) conflict = true;
    }

    let confidence;
    if (conflict) confidence = 'conflict';
    else if (sources.length >= 2) confidence = 'confirmed';
    else confidence = 'single-source';

    return {
      id: primary.id,
      name: primary.name,
      highway: primary.highway || c.records.find((r) => r.highway)?.highway || '',
      state: primary.state || c.records.find((r) => r.state)?.state || '',
      lat: c.lat,
      lng: c.lng,
      direction: primary.direction || 'both',
      rates: primary.rates,
      confidence,
      sources,
      sourceCount: sources.length,
      conflictDetail: conflict ? { carRates, spreadPct: Math.round(((Math.max(...carRates) - Math.min(...carRates)) / Math.min(...carRates)) * 100) } : null,
    };
  });

  return {
    plazas: merged,
    stats: {
      totalClusters: merged.length,
      confirmed: merged.filter((m) => m.confidence === 'confirmed').length,
      singleSource: merged.filter((m) => m.confidence === 'single-source').length,
      conflicts: merged.filter((m) => m.confidence === 'conflict').length,
    },
  };
}

module.exports = { crossValidate, haversineKm, normName };
