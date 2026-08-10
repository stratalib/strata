// Sequential showcase sweep — run a fixed list of (task, arm) one at a time, in-process (like
// run-one.js, which is the only reliably-working pattern), into exp-sonnet on Sonnet. Each runOnce
// writes its artifact before returning, so a crash mid-sweep loses only the in-flight task. One long
// background job beats a swarm of parallel `claude` sessions that would rate-limit each other.
//
// Usage: node benchmark/run-showcase.js
process.env.STRATA_DELIVER_AS_DEP = process.env.STRATA_DELIVER_AS_DEP || '1';
if (!process.argv.includes('--out')) process.argv.push('--out', 'exp-sonnet');
if (!process.argv.includes('--model')) process.argv.push('--model', 'sonnet');

const { TASKS, runOnce } = require('./agent-bench.js');

// Ordered by showcase priority: complete the package-heavy win-trio first, then the stretch win, then
// the broader hard cohort, then the honest losses (commodity/retry) last. jwtjune is OMITTED — it is
// already running in a separate process; don't double-run it.
const PLAN = [
  ['resetjune', 'baseline'], ['resetjune', 'strata'],   // completes auth/reset/payments trio
  ['oauth', 'strata'],                                    // baseline already measured (62t/$1.67)
  ['idempotency', 'baseline'], ['idempotency', 'strata'],
  ['rbac', 'baseline'], ['rbac', 'strata'],
  ['auth', 'baseline'], ['auth', 'strata'],
  ['retry', 'baseline'], ['retry', 'strata'],            // the known loss — kept for credibility
  ['export', 'baseline'], ['export', 'strata'],
  ['catalog', 'baseline'], ['catalog', 'strata'],
  ['search', 'baseline'], ['search', 'strata'],
];

const fs = require('fs');
const path = require('path');
const { OUT } = require('./agent-bench.js');
// Resume-safe: an artifact already on disk means that (task,arm) ran — skip it. Lets a torn-down sweep
// be relaunched to finish the rest without redoing (or clobbering) completed work.
const done = (task, arm) => fs.existsSync(path.join(OUT, `${task}-${arm}-1.json`));

(async () => {
  console.log(`SHOWCASE SWEEP — ${PLAN.length} runs, sequential, model=sonnet, out=exp-sonnet`);
  const results = [];
  for (let i = 0; i < PLAN.length; i++) {
    const [task, arm] = PLAN[i];
    if (!TASKS[task]) { console.log(`[${i + 1}/${PLAN.length}] SKIP ${task} (unknown task)`); continue; }
    if (done(task, arm)) { console.log(`[${i + 1}/${PLAN.length}] SKIP ${task} ${arm} (artifact exists)`); continue; }
    const started = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${i + 1}/${PLAN.length}] ${started} ${task} ${arm} ... `);
    try {
      const r = runOnce(task, TASKS[task], arm, 1);
      const line = `${r.ok ? 'OK' : 'NO-REPORT'} · ${r.turns} turns · $${(r.costUsd || 0).toFixed(2)}`
        + ` · +${r.work.filesAdded} files · armValid=${r.armValid} · synthetic=${r.synthetic}`
        + ` · delivered=[${(r.deliveredRecalls || []).join(',')}]`;
      console.log(line);
      results.push({ task, arm, ...{ turns: r.turns, cost: r.costUsd, armValid: r.armValid, synthetic: r.synthetic } });
    } catch (e) {
      console.log('CRASH: ' + (e.stack || e.message).split('\n')[0]);
      results.push({ task, arm, crash: String(e.message || e) });
    }
  }
  console.log('\n=== SWEEP DONE ===');
  for (const r of results) console.log(JSON.stringify(r));
})();
