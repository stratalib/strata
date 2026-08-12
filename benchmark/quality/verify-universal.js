#!/usr/bin/env node
'use strict';
/**
 * Verify the strongest claim in the battery before anyone repeats it in public:
 * that some checks are failed by EVERY baseline model at EVERY tier, and passed by Strata.
 *
 * A claim like "no model tier fixes this" is only worth making if the counts are exact, so this
 * prints raw pass/total per model rather than a rounded rate.
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

const tally = {};
const detail = {};
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const name = f.replace(/\.json$/, '');
  const tmp = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
  const gr = byKey.get(name) || byKey.get(tmp);
  if (!gr) continue;

  for (const r of gr.results || []) {
    const t = (tally[r.id] = tally[r.id] || { base: { p: 0, n: 0 }, str: { p: 0, n: 0 }, models: {} });
    const side = rec.arm === 'strata' ? 'str' : 'base';
    t[side].n++; if (r.pass === true) t[side].p++;
    const mk = (rec.arm === 'strata' ? '+' : '') + rec.model;
    const m = (t.models[mk] = t.models[mk] || { p: 0, n: 0 });
    m.n++; if (r.pass === true) m.p++;
    if (r.pass !== true && r.detail && !detail[r.id]) detail[r.id] = r.detail;
  }
}

/* A "universal" failure: no baseline run at any tier passed it, and Strata passed all of them. */
const universal = Object.entries(tally)
  .filter(([, t]) => t.base.n >= 6 && t.base.p === 0 && t.str.n >= 4 && t.str.p === t.str.n)
  .sort((a, b) => b[1].base.n - a[1].base.n);

console.log('\n═══ FAILED BY EVERY BASELINE RUN, AT EVERY TIER — PASSED BY EVERY STRATA RUN ═══\n');
if (!universal.length) console.log('  (none)');
for (const [id, t] of universal) {
  console.log('  ' + id);
  console.log('     baseline ' + t.base.p + '/' + t.base.n + '        strata ' + t.str.p + '/' + t.str.n);
  console.log('     ' + Object.entries(t.models).map(([m, v]) => m + ' ' + v.p + '/' + v.n).join('   '));
  if (detail[id]) console.log('     grader: ' + String(detail[id]).slice(0, 90));
  console.log('');
}

/* Near-universal: baseline mostly fails, Strata mostly passes. Still quotable, with honest numbers. */
const near = Object.entries(tally)
  .filter(([id, t]) => !universal.find(([u]) => u === id))
  .filter(([, t]) => t.base.n >= 6 && t.str.n >= 4 && (t.base.p / t.base.n) <= 0.34 && (t.str.p / t.str.n) >= 0.8)
  .sort((a, b) => (a[1].base.p / a[1].base.n) - (b[1].base.p / b[1].base.n));

console.log('\n═══ NEAR-UNIVERSAL (baseline ≤34%, Strata ≥80%) ═══\n');
for (const [id, t] of near) {
  console.log('  ' + id.padEnd(34) + 'baseline ' + String(t.base.p + '/' + t.base.n).padStart(6) +
    '   strata ' + String(t.str.p + '/' + t.str.n).padStart(6));
  if (detail[id]) console.log('     grader: ' + String(detail[id]).slice(0, 90));
}
console.log('');
