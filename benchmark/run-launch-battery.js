// The launch benchmark battery — one process, sequential, so it's a single background task instead of
// nine separate ones (each separate `claude` spawn this week has occasionally hit an exit-127
// environmental issue; one long-running process is more robust than nine short-lived launches).
// Runs baseline vs strata (hub-mode, nudged — both now the harness default) across a task set chosen
// to show the real range: a proven multi-recall win, this week's most-forensically-tracked task, a
// hard/audit-inversion-prone domain, and a known honest decline — plus one sonnet reference point.
'use strict';
// OUT is an IIFE evaluated once at require-time inside agent-bench.js, so --out must be in argv
// BEFORE the require below — setting it per-iteration inside the loop would have no effect.
process.argv = ['node', 'run-launch-battery.js', '--out', 'exp-launch'];
const { TASKS, runOnce } = require('./agent-bench.js');

const PLAN = [
  ['catalog', 'baseline', 'haiku', 1],
  ['catalog', 'strata', 'haiku', 1],
  ['catalog', 'baseline', 'sonnet', 1],
  ['idempotency', 'baseline', 'haiku', 1],
  ['idempotency', 'strata', 'haiku', 1],
  ['stripejune', 'baseline', 'haiku', 1],
  ['stripejune', 'strata', 'haiku', 1],
  ['retry', 'baseline', 'haiku', 1],
  ['retry', 'strata', 'haiku', 1],
];

(async () => {
  const results = [];
  for (const [taskName, arm, model, runIndex] of PLAN) {
    const task = TASKS[taskName];
    // --model IS read dynamically (arg() re-scans process.argv on every call), unlike --out.
    process.argv = ['node', 'run-launch-battery.js', '--out', 'exp-launch', '--model', model];
    const t0 = Date.now();
    console.log(`\n=== ${taskName} ${arm} ${model} run${runIndex} ===`);
    try {
      // runOnce reads --model/--out/--run from process.argv itself via the shared arg() helper.
      const r = runOnce(taskName, task, arm, runIndex);
      results.push(r);
      console.log(`${taskName} ${arm}: ${r.turns} turns · $${(r.costUsd || 0).toFixed(4)} · strataCalls=${r.strataCalls} · armValid=${r.armValid} · hubComposed=${r.diagnosis.hubComposed} · (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (e) {
      console.error(`${taskName} ${arm} FAILED: ${e.message}`);
    }
  }
  console.log('\n=== BATTERY COMPLETE ===');
  console.log(JSON.stringify(results.map(r => ({
    task: r.task, arm: r.arm, turns: r.turns, cost: r.costUsd, strataCalls: r.strataCalls,
    armValid: r.armValid, hubComposed: r.diagnosis.hubComposed,
  })), null, 2));
})();
