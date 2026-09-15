#!/usr/bin/env node
'use strict';
/**
 * WEEKLY SYNC
 *
 * The auto-updating half of the model. Run this on a schedule (see the
 * GitHub Actions workflow alongside this file for a working weekly cron) and
 * it will:
 *
 *   1. Pull every configured source independently
 *   2. Cross-validate them (confidence.js) - agreement across sources is
 *      itself a signal, not just more rows
 *   3. Diff the merged result against the CURRENTLY LIVE rate set (diff.js)
 *   4. If anything material changed, write a NEW versioned rate set with its
 *      own effectiveFrom date and a changelog entry - it NEVER overwrites a
 *      live set in place, so every historical quote stays reproducible
 *   5. If nothing changed, it says so and exits - a sync that runs and finds
 *      no changes is a successful run, not a failure
 *
 * This is designed to run unattended. A human should still spot-check the
 * changelog after the first few runs, but the mechanism itself does not
 * require one.
 */

const fs = require('fs');
const path = require('path');
const { fetchGeohackerMirror } = require('../src/sources');
const { crossValidate } = require('../src/confidence');
const { diffPlazaSets } = require('../src/diff');
const { PlazaStore } = require('../src/store');

const DATA_DIR = process.env.TOLL_DATA_DIR || path.join(__dirname, '..', 'data');
const CHANGELOG_FILE = path.join(DATA_DIR, 'CHANGELOG.json');

function loadChangelog() {
  try { return JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8')); } catch { return []; }
}
function saveChangelog(log) {
  fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(log, null, 2));
}

/**
 * Sources wired in for this run. Each entry MUST return the normalised shape
 * from sources.js. Add more here as they come online (NHAI live, data.gov.in,
 * a future direct TIS per-plaza rate puller) without touching anything else -
 * the merge and diff steps are source-count-agnostic by design.
 */
async function pullAllSources() {
  const results = [];
  const errors = [];

  try {
    const gh = await fetchGeohackerMirror();
    console.log(`  [source] geohacker mirror: ${gh.length} plazas`);
    results.push(gh);
  } catch (e) {
    console.error(`  [source] geohacker mirror FAILED: ${e.message}`);
    errors.push({ source: 'geohacker_mirror', error: e.message });
  }

  // NHAI live endpoint is wired in sources.js (fetchNhaiLive) but only
  // returns location, not rates, in a single call - each plaza's rate page
  // must be fetched individually, which is a heavier job scheduled less
  // often. Left out of the weekly pass; run it as a separate monthly job.

  return { results, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  console.log(`FleetHub Toll Sync — ${new Date().toISOString()}`);
  console.log(dryRun ? '(dry run — no files will be written)' : '(live run)');

  console.log('\nStep 1: pulling sources...');
  const { results, errors } = await pullAllSources();
  if (!results.length) {
    console.error('All sources failed. Aborting without touching live data.');
    process.exit(1);
  }

  console.log('\nStep 2: cross-validating...');
  const { plazas, stats } = crossValidate(results);
  console.log(`  clusters: ${stats.totalClusters}  confirmed(2+ sources): ${stats.confirmed}  single-source: ${stats.singleSource}  conflicts: ${stats.conflicts}`);
  if (stats.conflicts > 0) {
    console.log(`  ⚠ ${stats.conflicts} plaza(s) have disagreeing source data — flagged, not auto-resolved. See changelog.`);
  }

  console.log('\nStep 3: diffing against live rate set...');
  const store = new PlazaStore();
  store.load();
  const current = store.setFor(null);
  const oldPlazas = current ? current.plazas : [];
  const withRates = plazas.filter((p) => Object.keys(p.rates || {}).length > 0);
  const diff = diffPlazaSets(oldPlazas, withRates);

  console.log(`  added: ${diff.summary.added}  removed: ${diff.summary.removed}  rate changes: ${diff.summary.rateChanged}  unchanged: ${diff.summary.unchanged}`);
  if (diff.summary.rateChanged) console.log(`  avg rate move: ${diff.summary.avgRateDeltaPct}%`);

  const materialChange = diff.summary.added > 0 || diff.summary.removed > 0 || diff.summary.rateChanged > 0;

  if (!materialChange && !force) {
    console.log('\nNo material change since last version. Nothing to write. Sync complete.');
    return;
  }

  const version = new Date().toISOString().slice(0, 10);
  const effectiveFrom = version;

  if (dryRun) {
    console.log(`\n[dry run] would write pending-${version}.json with ${withRates.length} rated plazas, awaiting approval.`);
    console.log(JSON.stringify(diff.rateChanged.slice(0, 5), null, 2));
    return;
  }

  /* CHANGED: a detected change no longer becomes live automatically. It is
     written to a PENDING folder and logged as awaiting approval - the
     operator reviews what changed (via /v1/updates/pending or the app's
     "Check for updates" panel) and explicitly approves or skips it. This is
     the "ask before updating" behaviour requested - the sync still runs
     unattended on schedule, but nothing reaches a live quote without a human
     saying yes first. */
  console.log('\nStep 4: writing PENDING update for review (not yet live)...');
  const pendingDir = path.join(DATA_DIR, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const pendingId = `pending-${version}`;
  const outFile = path.join(pendingDir, `${pendingId}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    version, effectiveFrom,
    source: 'weekly-sync: ' + results.map((_, i) => `source-${i}`).join('+'),
    crossValidation: stats,
    generatedAt: new Date().toISOString(),
    plazaCount: withRates.length,
    plazas: withRates,
  }, null, 2));
  console.log(`  wrote ${outFile}`);

  const pendingIndexFile = path.join(DATA_DIR, 'pending-updates.json');
  let pendingIndex = [];
  try { pendingIndex = JSON.parse(fs.readFileSync(pendingIndexFile, 'utf8')); } catch { /* none yet */ }
  pendingIndex.unshift({
    id: pendingId, version, effectiveFrom, generatedAt: new Date().toISOString(),
    status: 'awaiting_review',
    summary: diff.summary,
    headline: `${diff.summary.added} new, ${diff.summary.removed} removed, ${diff.summary.rateChanged} rate changes` +
      (diff.summary.rateChanged ? ` (avg move ${diff.summary.avgRateDeltaPct}%)` : ''),
    rateChanges: diff.rateChanged.slice(0, 20), // enough to show the operator without bloating the index
    added: diff.added, removed: diff.removed,
    sourceErrors: errors,
  });
  fs.writeFileSync(pendingIndexFile, JSON.stringify(pendingIndex.slice(0, 30), null, 2));
  console.log(`  pending-updates index updated: ${pendingIndexFile}`);

  console.log('\nSync complete. Update is PENDING REVIEW, not live.');
  console.log('Approve it with:');
  console.log(`  curl -XPOST $API_URL/v1/admin/approve-update -H "X-Api-Key: $KEY" -d '{"id":"${pendingId}"}'`);
  console.log('...or check it from the app\'s "Check for updates" panel.');
}

main().catch((e) => { console.error('Sync failed:', e); process.exit(1); });
