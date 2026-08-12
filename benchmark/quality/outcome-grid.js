#!/usr/bin/env node
'use strict';
/**
 * The benchmark as ATTEMPTS rather than averages.
 *
 * "Expected cost per clean run" is true but needs two steps of reasoning — estimate P(clean), then
 * divide. Nobody does two steps. A row of twelve squares, one per run, needs none: you can see that
 * one row has no green in it at all.
 *
 * Emits the per-run outcome grid used by the shareable graphic.
 *
 *   node benchmark/quality/outcome-grid.js          # text
 *   node benchmark/quality/outcome-grid.js --json   # data for the renderer
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');

const byKey = new Map();
{
  const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));
  for (const row of g.grades || []) {
    const key = String(row.dir || '').split(/[\\/]/).filter(Boolean).pop();
    if (key) byKey.set(key, row);
  }
}

const ARMS = [
  ['haiku',           'baseline', 'haiku'],
  ['haiku + Strata',  'strata',   'haiku'],
  ['sonnet',          'baseline', 'sonnet'],
  ['sonnet + Strata', 'strata',   'sonnet'],
  ['opus',            'baseline', 'opus'],
];

const rows = [];
for (const [label, arm, model] of ARMS) {
  const runs = [];
  for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
    if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
    if (rec.ok !== true || rec.arm !== arm || rec.model !== model) continue;
    const name = f.replace(/\.json$/, '');
    const tmp = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
    const g = byKey.get(name) || byKey.get(tmp);
    const res = g ? (g.results || []) : [];
    const passed = res.filter((r) => r.pass === true).length;
    const total = res.length;

    // Three states, because "broken" and "never started" are different experiences for a user.
    let state = 'ungraded';
    if (total) {
      if (g.booted === false) state = 'dead';
      else if (passed === total) state = 'clean';
      else state = 'partial';
    }
    runs.push({ name, task: rec.task, state, passed, total, cost: rec.costUsd, turns: rec.turns });
  }
  runs.sort((a, b) => a.task.localeCompare(b.task) || a.name.localeCompare(b.name));

  const graded = runs.filter((r) => r.state !== 'ungraded');
  const clean = graded.filter((r) => r.state === 'clean').length;
  const costPer = runs.reduce((s, r) => s + (r.cost || 0), 0) / (runs.length || 1);
  const p = graded.length ? clean / graded.length : 0;
  rows.push({
    label, arm, model, runs,
    graded: graded.length, clean, costPer,
    toShip: p > 0 ? costPer / p : null,
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const GLYPH = { clean: '#', partial: '+', dead: '.', ungraded: ' ' };
console.log('\n  Each square is one real run.  # every check passed   + some failed   . never started\n');
const w = Math.max(...rows.map((r) => r.label.length));
for (const r of rows) {
  const strip = r.runs.map((x) => GLYPH[x.state]).join('');
  console.log('  ' + r.label.padEnd(w) + '  ' + strip.padEnd(14) +
    '  ' + (r.clean + '/' + r.graded + ' clean').padStart(12) +
    '   $' + r.costPer.toFixed(2) + '/try   ' +
    (r.toShip === null ? 'never shipped' : '$' + r.toShip.toFixed(2) + ' to ship one'));
}
console.log('');
