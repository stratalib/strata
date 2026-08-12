/* Recompute the published board from GRADES.json with the corrected two-key join, and diff it
   against docs/BENCHMARK.md. If the published numbers came from a name-only join they inherit the
   same 20-run drop that nearly corrupted the cost analysis. */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));

const byKey = new Map();
for (const row of g.grades || []) {
  const key = String(row.dir || '').split(/[\\/]/).filter(Boolean).pop();
  if (key) byKey.set(key, row.results || []);
}

const cells = {};
let joined = 0, dropped = 0;
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const name = f.replace(/\.json$/, '');
  const tmp = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
  const res = byKey.get(name) || byKey.get(tmp);
  if (!res || !res.length) { dropped++; continue; }
  joined++;
  const arm = rec.arm === 'strata' ? rec.model + ' + Strata' : rec.model;
  const k = arm + '|' + rec.task;
  cells[k] = cells[k] || { pass: 0, tot: 0, n: 0 };
  cells[k].pass += res.filter((r) => r.pass === true).length;
  cells[k].tot += res.length;
  cells[k].n++;
}

console.log('\n  joined ' + joined + ' runs, dropped ' + dropped + '\n');

const arms = ['haiku', 'haiku + Strata', 'sonnet', 'sonnet + Strata', 'opus'];
const tasks = ['catalog', 'idempotency', 'stripejune', 'retry'];
const PUBLISHED = {
  'haiku': 63.1, 'haiku + Strata': 92.1, 'sonnet': 77.1, 'sonnet + Strata': 97.8, 'opus': 83.9,
};

console.log('  arm                catalog  idempot.  payments   retry  |  recomputed  published   diff');
console.log('  ' + '─'.repeat(92));
for (const arm of arms) {
  const parts = [];
  let p = 0, t = 0;
  const perTask = [];
  for (const task of tasks) {
    const c = cells[arm + '|' + task];
    if (!c) { perTask.push('   —  '); continue; }
    perTask.push(((c.pass / c.tot) * 100).toFixed(1).padStart(6));
    p += c.pass; t += c.tot;
  }
  // The published average is the mean of per-task percentages, not the pooled check ratio.
  const taskPcts = tasks.map((task) => {
    const c = cells[arm + '|' + task];
    return c ? (c.pass / c.tot) * 100 : null;
  }).filter((x) => x !== null);
  const avg = taskPcts.reduce((s, x) => s + x, 0) / taskPcts.length;
  const pub = PUBLISHED[arm];
  const diff = pub === undefined ? NaN : avg - pub;
  console.log('  ' + arm.padEnd(18) + perTask.join('   ') + '  |  ' +
    avg.toFixed(1).padStart(9) + '  ' + String(pub).padStart(9) + '  ' +
    (Number.isFinite(diff) ? (diff >= 0 ? '+' : '') + diff.toFixed(1) : '—').padStart(6));
}
console.log('\n  (recomputed average = mean of the four per-task percentages, matching the published method)\n');
