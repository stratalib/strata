#!/usr/bin/env node
'use strict';
/**
 * THE QUALITY BATTERY — the experiment for the current thesis.
 *
 * The claim under test is NOT "Strata is cheaper". It is:
 *
 *     haiku + Strata  produces code of the same QUALITY as  sonnet without Strata.
 *
 * So the arms are deliberately CROSS-MODEL. An earlier version of the analyzer treated exactly this
 * pairing as invalid and refused to report it — a same-model rule that made the product's central
 * claim unmeasurable by construction. Cross-model is the point; what must never happen is a run whose
 * model is unknown, or a run that overwrites another run. Both are handled in agent-bench.js now
 * (model in the filename AND in the JSON).
 *
 * Cost is NOT the outcome variable here. It is context. Quality is graded separately and later, by
 * benchmark/quality/grade.js, against a pre-registered suite that neither arm can see — never by the
 * strata/verify.js that Strata itself generates, which would be marking its own homework.
 *
 * RESUMABLE, because this machine intermittently reaps long-running node processes (exit 127 with an
 * empty log, even for a plain express server). Every completed run is left on disk and skipped on the
 * next invocation, so this can be re-run as many times as it takes without losing or duplicating work.
 *
 *   node benchmark/run-quality-battery.js            # work the queue until it is done
 *   node benchmark/run-quality-battery.js --max 6    # do at most 6 runs then stop
 */
process.argv = process.argv.includes('--out') ? process.argv : [...process.argv, '--out', 'exp-quality'];

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TASKS, runOnce, OUT } = require('./agent-bench.js');

const argOf = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const MAX = Number(argOf('--max', '999'));

/**
 * --arms baseline   collect ONLY the arms that do not involve Strata.
 *
 * Baseline results are DURABLE: no change to Strata can affect them, so they can be collected while
 * the engine is being worked on. Strata results cannot — a run made against a build that is being
 * changed underneath it measures neither the old build nor the new one. This flag is what lets
 * benchmark collection and engine fixes happen on the same day without contaminating either.
 */
const ARMS = argOf('--arms', '').split(',').filter(Boolean);

/**
 * Ordered so that COMPLETE COMPARABLE SETS land first.
 *
 * The machine may kill this at any point, so the queue is interleaved rather than grouped by arm: after
 * three runs there is one whole catalog triple to analyse, after six there are two whole triples. A
 * queue ordered by arm would, if interrupted, leave nine haiku baselines and nothing to compare them to.
 *
 * The triple IS the experiment:
 *   haiku baseline  — the floor (what the cheap model does alone)
 *   haiku strata    — the product
 *   sonnet baseline — the target quality to match
 */
const TASKS_WANTED = (argOf('--tasks', 'catalog,idempotency')).split(',').filter(Boolean);

/**
 * The five arms. The first three are the core claim; the last two map its boundary.
 *
 *   haiku baseline  — the floor
 *   haiku + Strata  — the product
 *   sonnet baseline — the quality target to match
 *   sonnet + Strata — does the lift replicate one rung up, or is it pure overhead on a strong model
 *   opus baseline   — the ceiling: is there ANY model tier that fixes the checks Strata fixes
 */
const ARM_PLAN = [
  ['baseline', 'haiku'],
  ['strata', 'haiku'],
  ['baseline', 'sonnet'],
  ['strata', 'sonnet'],
  ['baseline', 'opus'],
  // PRE-INJECTION — the provenance experiment. Same implementation the Strata arm received, taken
  // byte-for-byte from that task's own archived Strata run, but already committed as ordinary project
  // source: no MCP server, no tool call, no strata/ directory, no banner identifying it as generated.
  // Tests whether the audit that drives Strata's cost overrun is caused by the code or by watching a
  // tool hand it over. Opt in with `--arms preinject`; it is NOT part of the default queue, so the
  // published five-arm battery is unaffected.
  ['preinject', 'haiku'],
  ['preinject', 'sonnet'],
];

const QUEUE = [];
for (const run of [1, 2, 3]) {
  for (const task of TASKS_WANTED) {
    for (const [arm, model] of ARM_PLAN) QUEUE.push([task, arm, model, run]);
  }
}

const stemOf = (task, arm, model, run) => `${task}-${arm}-${model}-${run}`;

/** A run counts as done only if its artifact exists AND parses AND reports ok — a reaped run leaves
 *  nothing, but a half-written file must not be mistaken for a result. */
function alreadyDone(task, arm, model, run) {
  const p = path.join(OUT, stemOf(task, arm, model, run) + '.json');
  if (!fs.existsSync(p)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j.ok === true && j.armValid === true;
  } catch { return false; }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const todo = QUEUE
    .filter(([, arm]) => !ARMS.length || ARMS.includes(arm))
    .filter(([t, a, m, r]) => !alreadyDone(t, a, m, r));
  if (ARMS.length) console.log(`arms filter: ${ARMS.join(', ')}`);
  // Counted against the SELECTED arms, not the whole queue — subtracting todo from QUEUE.length
  // reported everything the filter excluded as "already done", which is the opposite of true.
  const selected = QUEUE.filter(([, arm]) => !ARMS.length || ARMS.includes(arm));
  console.log(`queue: ${selected.length} selected, ${selected.length - todo.length} already done, ${todo.length} remaining`);

  let done = 0, failed = 0;
  for (const [taskName, arm, model, runIndex] of todo) {
    if (done >= MAX) { console.log(`--max ${MAX} reached, stopping cleanly`); break; }
    const stem = stemOf(taskName, arm, model, runIndex);

    // --model and --run are read dynamically by agent-bench's arg() on every call; --out is not (it is
    // an IIFE evaluated at require time), which is why it is set at the top of this file instead.
    process.argv = ['node', 'run-quality-battery.js', '--out', 'exp-quality', '--model', model, '--run', String(runIndex)];

    const t0 = Date.now();
    process.stdout.write(`\n=== ${stem} ... `);
    try {
      const r = runOnce(taskName, TASKS[taskName], arm, runIndex);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (!r.ok || !r.armValid) {
        failed++;
        console.log(`INVALID (ok=${r.ok} armValid=${r.armValid} strataCalls=${r.strataCalls}) ${secs}s — will retry on next invocation`);
      } else {
        done++;
        console.log(`ok · ${r.turns} turns · $${(r.costUsd || 0).toFixed(3)} · ${secs}s`);
        // ARCHIVE IMMEDIATELY, not at the end of the batch.
        //
        // The tree lives in os.tmpdir(), which Windows clears on its own schedule, and this batch is
        // reaped mid-run routinely. Archiving per-run means a killed batch still leaves every
        // completed run's evidence intact — the same reason the run JSON is written per-run.
        try {
          spawnSync(process.execPath, [path.join(__dirname, 'archive-trees.js'), OUT],
            { stdio: 'ignore', timeout: 120_000 });
          console.log(`    tree: ${r.dir}  → archived`);
        } catch {
          console.log(`    tree: ${r.dir}  (ARCHIVE FAILED — copy it before Temp is cleared)`);
        }
      }
    } catch (e) {
      failed++;
      console.log(`FAILED: ${e.message} — will retry on next invocation`);
    }
  }

  const remaining = QUEUE.filter(([t, a, m, r]) => !alreadyDone(t, a, m, r)).length;
  console.log(`\n=== batch over: ${done} completed this pass, ${failed} to retry, ${remaining} still outstanding`);
  if (remaining) console.log('re-run this same command to continue; completed runs are skipped');
})();
