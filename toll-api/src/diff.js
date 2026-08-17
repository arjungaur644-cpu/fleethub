'use strict';
/**
 * DIFF ENGINE
 *
 * Turns "we pulled new data" into "here is exactly what changed since last
 * week" - new plazas, removed plazas, and rate changes with the percentage
 * move. This is what makes the weekly sync auditable instead of a black box
 * that silently swaps numbers under a fleet operator's feet.
 *
 * It is also a real product feature none of the competitors checked expose:
 * an operator can see "Panipat toll rose 8% this cycle" rather than just a
 * new total with no explanation.
 */

function diffPlazaSets(oldPlazas, newPlazas) {
  const oldById = new Map(oldPlazas.map((p) => [p.id, p]));
  const newById = new Map(newPlazas.map((p) => [p.id, p]));

  const added = [];
  const removed = [];
  const rateChanged = [];
  let unchanged = 0;

  for (const [id, np] of newById) {
    const op = oldById.get(id);
    if (!op) { added.push({ id, name: np.name, state: np.state }); continue; }

    const classes = new Set([...Object.keys(op.rates || {}), ...Object.keys(np.rates || {})]);
    const changes = [];
    for (const cls of classes) {
      const before = op.rates?.[cls];
      const after = np.rates?.[cls];
      if (before == null || after == null || before === after) continue;
      changes.push({ class: cls, before, after, deltaPct: Math.round(((after - before) / before) * 1000) / 10 });
    }
    if (changes.length) rateChanged.push({ id, name: np.name, state: np.state, changes });
    else unchanged++;
  }

  for (const [id, op] of oldById) {
    if (!newById.has(id)) removed.push({ id, name: op.name, state: op.state });
  }

  const avgDelta = rateChanged.length
    ? Math.round((rateChanged.flatMap((r) => r.changes.map((c) => c.deltaPct)).reduce((s, v) => s + v, 0) /
        rateChanged.flatMap((r) => r.changes).length) * 10) / 10
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      added: added.length,
      removed: removed.length,
      rateChanged: rateChanged.length,
      unchanged,
      avgRateDeltaPct: avgDelta,
    },
    added, removed, rateChanged,
  };
}

module.exports = { diffPlazaSets };
