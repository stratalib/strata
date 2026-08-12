#!/usr/bin/env node
'use strict';
/**
 * What a user actually FEELS during a session, as opposed to what a grader measures.
 *
 * Correctness defects are invisible until a project has real traffic. Wall-clock time, turn count
 * and "did it work on the first go" are felt immediately, by everyone. If Strata has a story for
 * people who are not yet running anything in production, it has to live in these columns.
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

const rows = [];
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const name = f.replace(/\.json$/, '');
  const tmp = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
  const g = byKey.get(name) || byKey.get(tmp);
  const res = g ? (g.results || []) : [];
  rows.push({
    arm: rec.arm === 'strata' ? rec.model + ' + Strata' : rec.model,
    task: rec.task,
    turns: rec.turns,
    mins: (rec.wallMs || 0) / 60000,
    cost: rec.costUsd,
    booted: g ? g.booted !== false : null,
    clean: res.length ? res.filter((r) => r.pass === true).length === res.length : null,
    graded: res.length > 0,
  });
}

const ORDER = ['haiku', 'haiku + Strata', 'sonnet', 'sonnet + Strata', 'opus'];
const mean = (a, f) => (a.length ? a.reduce((s, x) => s + (f(x) || 0), 0) / a.length : NaN);
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

console.log('\n═══ WHAT THE USER SITS THROUGH ═══\n');
console.log('  arm                runs   minutes   turns    booted first try   every check first try');
console.log('  ' + '─'.repeat(88));
for (const arm of ORDER) {
  const rs = rows.filter((r) => r.arm === arm);
  if (!rs.length) continue;
  const gr = rs.filter((r) => r.graded);
  const booted = gr.filter((r) => r.booted).length;
  const clean = gr.filter((r) => r.clean).length;
  console.log('  ' + arm.padEnd(18) + String(rs.length).padStart(4) +
    fmt(mean(rs, (r) => r.mins), 1).padStart(10) +
    fmt(mean(rs, (r) => r.turns), 0).padStart(8) +
    ('  ' + booted + '/' + gr.length + '  ' + fmt((booted / gr.length) * 100, 0) + '%').padStart(19) +
    ('  ' + clean + '/' + gr.length + '  ' + fmt((clean / gr.length) * 100, 0) + '%').padStart(23));
}

console.log('\n\n═══ IS IT FASTER? (wall-clock minutes, same model) ═══\n');
for (const model of ['haiku', 'sonnet']) {
  const b = rows.filter((r) => r.arm === model);
  const s = rows.filter((r) => r.arm === model + ' + Strata');
  if (!b.length || !s.length) continue;
  const bm = mean(b, (r) => r.mins), sm = mean(s, (r) => r.mins);
  const verdict = sm < bm ? 'FASTER' : 'SLOWER';
  console.log('  ' + model.padEnd(8) + 'baseline ' + fmt(bm, 1) + ' min   strata ' + fmt(sm, 1) +
    ' min   → ' + verdict + ' by ' + fmt(Math.abs(sm - bm), 1) + ' min (' + fmt((sm / bm - 1) * 100, 0) + '%)');
}

console.log('\n  Per task:\n');
const tasks = [...new Set(rows.map((r) => r.task))].sort();
console.log('  task           model     baseline min   strata min   delta');
console.log('  ' + '─'.repeat(62));
for (const task of tasks) {
  for (const model of ['haiku', 'sonnet']) {
    const b = rows.filter((r) => r.arm === model && r.task === task);
    const s = rows.filter((r) => r.arm === model + ' + Strata' && r.task === task);
    if (!b.length || !s.length) continue;
    const bm = mean(b, (r) => r.mins), sm = mean(s, (r) => r.mins);
    const d = sm - bm;
    console.log('  ' + task.padEnd(14) + model.padEnd(10) + fmt(bm, 1).padStart(12) +
      fmt(sm, 1).padStart(13) + ('   ' + (d >= 0 ? '+' : '') + fmt(d, 1) + ' min').padStart(14));
  }
}
console.log('');
