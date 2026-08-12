#!/usr/bin/env node
'use strict';
/**
 * WHICH checks fail, and how often, per arm.
 *
 * "92.1% of checks passed" is a number people nod at. "In 9 of 11 runs, page two repeated page one"
 * is a number people feel. This finds the concrete, nameable failures — the ones worth quoting —
 * and, more usefully, the ones Strata fixes that no model tier fixes on its own.
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

const arms = {};
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const name = f.replace(/\.json$/, '');
  const tmp = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
  const g = byKey.get(name) || byKey.get(tmp);
  if (!g || !(g.results || []).length) continue;

  const key = rec.arm === 'strata' ? `${rec.model} + Strata` : rec.model;
  arms[key] = arms[key] || {};
  for (const r of g.results) {
    const c = (arms[key][r.id] = arms[key][r.id] || { pass: 0, fail: 0 });
    r.pass === true ? c.pass++ : c.fail++;
  }
}

const ORDER = ['haiku', 'haiku + Strata', 'sonnet', 'sonnet + Strata', 'opus'];
const ids = [...new Set(Object.values(arms).flatMap((a) => Object.keys(a)))].sort();

const rate = (a, id) => {
  const c = arms[a] && arms[a][id];
  if (!c || (c.pass + c.fail) === 0) return null;
  return c.pass / (c.pass + c.fail);
};

console.log('\n═══ CHECKS STRATA FIXES THAT NO MODEL TIER FIXES ═══\n');
console.log('  Pass rate per check. A check where every baseline struggles and both Strata arms');
console.log('  succeed is a capability difference, not a model-quality difference.\n');
console.log('  check                          ' + ORDER.map((a) => a.slice(0, 13).padStart(15)).join(''));
console.log('  ' + '─'.repeat(31 + ORDER.length * 15));

const rows = [];
for (const id of ids) {
  const r = Object.fromEntries(ORDER.map((a) => [a, rate(a, id)]));
  const baseAvg = ['haiku', 'sonnet', 'opus'].map((a) => r[a]).filter((x) => x !== null);
  const strAvg = ['haiku + Strata', 'sonnet + Strata'].map((a) => r[a]).filter((x) => x !== null);
  if (!baseAvg.length || !strAvg.length) continue;
  const b = baseAvg.reduce((s, x) => s + x, 0) / baseAvg.length;
  const s = strAvg.reduce((s2, x) => s2 + x, 0) / strAvg.length;
  rows.push({ id, r, gap: s - b, b, s });
}
rows.sort((a, b) => b.gap - a.gap);

for (const row of rows.slice(0, 14)) {
  console.log('  ' + row.id.slice(0, 30).padEnd(31) +
    ORDER.map((a) => (row.r[a] === null ? '—' : Math.round(row.r[a] * 100) + '%').padStart(15)).join(''));
}

console.log('\n\n═══ THE QUOTABLE FAILURES ═══\n');
console.log('  Checks a majority of BASELINE runs failed, with the grader\'s own words.\n');
const detail = {};
{
  const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));
  for (const row of g.grades || []) {
    for (const r of row.results || []) {
      if (r.pass !== true && r.detail && !detail[r.id]) detail[r.id] = r.detail;
    }
  }
}
for (const row of rows.slice(0, 10)) {
  if (row.b > 0.55) continue;
  const pct = Math.round((1 - row.b) * 100);
  console.log('  ' + row.id);
  console.log('     baseline failed ' + pct + '% of the time · Strata passes ' + Math.round(row.s * 100) + '%');
  if (detail[row.id]) console.log('     e.g. ' + String(detail[row.id]).slice(0, 96));
  console.log('');
}
