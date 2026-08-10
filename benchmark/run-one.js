// Run ONE session and write its artifact. Independent process per session — a crash cannot take down
// a batch. Usage: node run-one.js <task> <arm> [--model m] [--out folder]
process.argv.push('--out', (process.argv.includes('--out') ? '' : 'exp-sonnet'));  // default folder
const { TASKS, runOnce } = require('./agent-bench.js');
const task = process.argv[2], arm = process.argv[3];
const runFlag = process.argv.indexOf('--run');
const runIdx = runFlag > -1 ? parseInt(process.argv[runFlag + 1], 10) : 1;  // distinct index => distinct artifact file, no clobber
if (!TASKS[task] || !['baseline', 'strata'].includes(arm)) { console.error('usage: run-one.js <task> <baseline|strata> [--run N]'); process.exit(1); }
try {
  const r = runOnce(task, TASKS[task], arm, runIdx);
  console.log(`${task} ${arm}: ${r.ok ? r.turns + ' turns · $' + (r.costUsd||0).toFixed(2) + ' · synthetic=' + r.synthetic + ' · delivered=[' + (r.deliveredRecalls||[]).join(',') + '] · verify=' + JSON.stringify(r.verifyResult) : 'NO REPORT'}`);
} catch (e) { console.error('CRASH:', e.stack || e.message); process.exit(1); }
