/* Verify the GRADES.json → run-record join before trusting any number computed from it.
   An uneven join silently biases every per-arm average. */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));

const graded = new Map();
for (const r of g.grades || []) {
  const name = String(r.dir || '').split(/[\\/]/).filter(Boolean).pop();
  if (name) graded.set(name, (r.results || []).length);
}

const records = fs.readdirSync(RUNS)
  .filter((f) => f.endsWith('.json') && !/GRADES|SUMMARY|STATIC|BOARD/i.test(f))
  .map((f) => f.replace(/\.json$/, ''));

console.log('\n  GRADES.json rows        : ' + (g.grades || []).length);
console.log('  unique graded run names : ' + graded.size);
console.log('  run records on disk     : ' + records.length);

const missing = records.filter((r) => !graded.has(r));
console.log('\n  records WITHOUT a grade : ' + missing.length);
for (const m of missing) {
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, m + '.json'), 'utf-8'));
  console.log('      ' + m.padEnd(34) + 'ok=' + rec.ok + '  turns=' + rec.turns + '  $' + (rec.costUsd || 0).toFixed(2));
}

const orphan = [...graded.keys()].filter((k) => !records.includes(k));
console.log('\n  grades with NO run record: ' + orphan.length);
for (const o of orphan) console.log('      ' + o);

/* Coverage per cell — this is what actually biases averages. */
console.log('\n  coverage by cell (graded / records):\n');
const cells = {};
for (const r of records) {
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, r + '.json'), 'utf-8'));
  const key = rec.arm + '-' + rec.model;
  cells[key] = cells[key] || { n: 0, g: 0, okFalse: 0 };
  cells[key].n++;
  if (graded.has(r)) cells[key].g++;
  if (rec.ok !== true) cells[key].okFalse++;
}
for (const [k, v] of Object.entries(cells).sort()) {
  console.log('    ' + k.padEnd(18) + String(v.g).padStart(3) + ' / ' + String(v.n).padStart(3) +
    '   (ok!==true: ' + v.okFalse + ')');
}
console.log('');
