#!/usr/bin/env node
'use strict';
/**
 * Turn benchmark/runs/exp-launch/*.json into one structured summary — the analysis pass this project
 * has done by hand, forensically, all week (armValid checks, hub-composition rates, root-cause digging
 * on anything that underperformed). Doing it here means the number is right the first time it's read,
 * not after a manual transcript dig.
 *
 * Usage: node benchmark/analyze-launch.js [runDir]   (defaults to benchmark/runs/exp-launch)
 * Writes: <runDir>/SUMMARY.json — consumed by the launch report artifact.
 */
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2] || path.join(__dirname, 'runs', 'exp-launch');
if (!fs.existsSync(runDir)) { console.error('no such dir:', runDir); process.exit(1); }

const runs = fs.readdirSync(runDir).filter(f => f.endsWith('.json') && f !== 'SUMMARY.json')
  .map(f => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')));

const tasks = [...new Set(runs.map(r => r.task))];

function rootCause(r) {
  if (!r) return null;
  if (r.arm === 'baseline') return null;
  if (!r.armValid) return 'strata_use was never called (strataCalls=0) — this run is not a Strata measurement, it is a second baseline by omission.';
  if (r.diagnosis?.bodyParserBugLanguage) return 'transcript shows body-parser-ordering language — possible mountWiring regression, needs a manual look.';
  if (!r.diagnosis?.verifyRan) return 'verify.js never ran in this session — the model may not have checked its own work.';
  if (r.diagnosis?.hubUnreachableFellBackLocal) return 'hub was unreachable this run; fell back to local composition (announced, not silent).';
  return null;
}

// A run with no recorded model predates the fix that started recording it (see agent-bench.js). Its
// number cannot be attributed, so it cannot be compared — say so rather than guessing.
const UNKNOWN = 'unknown-model';
const modelOf = (r) => r.model || UNKNOWN;

/**
 * Pair within one model — for THIS analyzer, which reports COST deltas.
 *
 * Two separate things went wrong here and they must not be conflated:
 *
 * 1. `r.model !== 'sonnet'` was a guard written against exactly this hazard, and inert, because
 *    nothing ever WROTE r.model. `undefined !== 'sonnet'` is true, so the run it was designed to
 *    exclude passed straight through. A defence that reads a field nobody populates is
 *    indistinguishable from no defence at all. That part was a real bug and is fixed.
 *
 * 2. Concluding from it that cross-model comparison is invalid was WRONG, and briefly got hard-coded
 *    here as a same-model requirement. Strata's actual claim is cross-model — "haiku + Strata reaches
 *    sonnet quality" — so a same-model rule makes the product's central claim unmeasurable by
 *    construction. See benchmark/analyze-quality.js, which pairs cross-model on purpose.
 *
 * The narrow truth worth keeping: a COST delta across two models measures the price list, not Strata.
 * So this file, which reports cost, pairs within a model. Quality comparisons live in the other
 * analyzer and are deliberately cross-model. The variable decides the pairing, not a blanket rule.
 */
const pairs = [];
for (const task of tasks) {
  for (const model of [...new Set(runs.filter(r => r.task === task).map(modelOf))]) {
    pairs.push({ task, model });
  }
}

const rows = pairs.map(({ task, model }) => {
  const b = runs.find(r => r.task === task && r.arm === 'baseline' && modelOf(r) === model && r.ok);
  const s = runs.find(r => r.task === task && r.arm === 'strata' && modelOf(r) === model && r.ok);
  const bTurns = b?.turns ?? null, sTurns = s?.turns ?? null;
  const bCost = b?.costUsd ?? null, sCost = s?.costUsd ?? null;
  const pct = (base, val) => (base && val != null && base > 0) ? Math.round(((val - base) / base) * 100) : null;
  return {
    task,
    model,
    baseline: b ? { turns: b.turns, costUsd: b.costUsd, ok: b.ok } : null,
    strata: s ? {
      turns: s.turns, costUsd: s.costUsd, ok: s.ok, armValid: s.armValid, strataCalls: s.strataCalls,
      hubComposed: !!s.diagnosis?.hubComposed, verifyRan: !!s.diagnosis?.verifyRan,
      deliveredRecalls: s.deliveredRecalls, verifyResult: s.verifyResult,
    } : null,
    turnsDeltaPct: pct(bTurns, sTurns),
    costDeltaPct: pct(bCost, sCost),
    rootCause: rootCause(s),
    verdict:
      !s ? 'no strata run'
      : !b ? 'no comparable baseline (same model) — not a measurement'
      : model === UNKNOWN ? 'UNATTRIBUTABLE — run predates model recording'
      : !s.armValid ? 'INVALID — excluded'
      : (pct(bCost, sCost) ?? 0) < 0 ? 'WIN' : 'loss',
  };
});

const validStrataRuns = runs.filter(r => r.arm === 'strata' && r.armValid);
const invalidStrataRuns = runs.filter(r => r.arm === 'strata' && !r.armValid);
const hubComposedCount = validStrataRuns.filter(r => r.diagnosis?.hubComposed).length;

const summary = {
  generatedAt: new Date().toISOString(),
  runDir,
  totalRuns: runs.length,
  strataArmRuns: runs.filter(r => r.arm === 'strata').length,
  validStrataRuns: validStrataRuns.length,
  invalidStrataRuns: invalidStrataRuns.length,
  invalidStrataRunNames: invalidStrataRuns.map(r => `${r.task}-${r.arm}-${modelOf(r)}-${r.run}`),
  unattributableRuns: runs.filter(r => !r.model).length,
  hubComposedCount,
  hubComposedRate: validStrataRuns.length ? Math.round((hubComposedCount / validStrataRuns.length) * 100) : null,
  rows,
};

fs.writeFileSync(path.join(runDir, 'SUMMARY.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
