#!/usr/bin/env node
'use strict';
/**
 * The OUTCOME board — an alternative to the published quality board.
 *
 * The published board answers "what share of checks passed", which is the right question for a
 * methods section and the wrong one for a reader deciding whether to install something. This one
 * answers what they actually asked: did it work, how long did I wait, and what did a working result
 * cost me.
 *
 * Every column is derived from the same raw grades and run records as the published board — this is
 * a re-presentation, not a re-measurement.
 *
 *   node benchmark/quality/outcome-board.js            # markdown
 *   node benchmark/quality/outcome-board.js --json     # for the renderer
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');

const byKey = new Map();
{
  const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));
  for (const row of g.grades || []) {
    const k = String(row.dir || '').split(/[\\/]/).filter(Boolean).pop();
    if (k) byKey.set(k, row);
  }
}

const ARMS = [
  { label: 'haiku',           arm: 'baseline', model: 'haiku' },
  { label: 'haiku + Strata',  arm: 'strata',   model: 'haiku' },
  { label: 'sonnet',          arm: 'baseline', model: 'sonnet' },
  { label: 'sonnet + Strata', arm: 'strata',   model: 'sonnet' },
  { label: 'opus',            arm: 'baseline', model: 'opus' },
];

const records = [];
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const name = f.replace(/\.json$/, '');
  const tmp = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
  const g = byKey.get(name) || byKey.get(tmp);
  const res = g ? (g.results || []) : [];
  records.push({
    arm: rec.arm, model: rec.model, task: rec.task,
    turns: rec.turns, mins: (rec.wallMs || 0) / 60000, cost: rec.costUsd,
    passed: res.filter((r) => r.pass === true).length,
    total: res.length,
    graded: res.length > 0,
  });
}

const mean = (a, f) => (a.length ? a.reduce((s, x) => s + (f(x) || 0), 0) / a.length : NaN);

const board = ARMS.map(({ label, arm, model }) => {
  const rs = records.filter((r) => r.arm === arm && r.model === model);
  const gr = rs.filter((r) => r.graded);
  const clean = gr.filter((r) => r.passed === r.total).length;
  const pClean = gr.length ? clean / gr.length : 0;
  const costRun = mean(rs, (r) => r.cost);

  // Quality, computed the way the published board computes it: mean of per-task percentages.
  const tasks = [...new Set(gr.map((r) => r.task))];
  const perTask = tasks.map((t) => {
    const sub = gr.filter((r) => r.task === t);
    const p = sub.reduce((s, r) => s + r.passed, 0);
    const n = sub.reduce((s, r) => s + r.total, 0);
    return n ? (p / n) * 100 : null;
  }).filter((x) => x !== null);
  const quality = perTask.length ? perTask.reduce((s, x) => s + x, 0) / perTask.length : NaN;

  return {
    label, strata: arm === 'strata',
    clean, graded: gr.length, pClean,
    mins: mean(rs, (r) => r.mins),
    turns: mean(rs, (r) => r.turns),
    costRun,
    costShip: pClean > 0 ? costRun / pClean : null,
    quality,
  };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(board, null, 2));
  process.exit(0);
}

const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');

console.log('\n## The outcome board\n');
console.log('What you get, rather than what the grader scored.\n');
console.log('| Arm | Worked first try | Wall time | Turns | Cost / run | Cost of one working feature | Checks passed |');
console.log('|---|---|---|---|---|---|---|');
for (const b of board) {
  const bold = b.strata ? '**' : '';
  console.log(`| ${bold}${b.label}${bold} | ${b.clean}/${b.graded} — ${(b.pClean * 100).toFixed(0)}% | ${f1(b.mins)} min | ${f1(b.turns)} | $${f2(b.costRun)} | ${b.costShip === null ? '**never produced one**' : '$' + f2(b.costShip)} | ${f1(b.quality)}% |`);
}
console.log('\n"Worked first try" = every pre-registered check passed on that run, with no second attempt.');
console.log('"Cost of one working feature" = cost per run ÷ share of runs that fully worked.\n');
