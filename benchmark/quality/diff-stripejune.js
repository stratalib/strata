#!/usr/bin/env node
'use strict';
/**
 * The same task swung from 0.60x baseline cost to 2.94x across builds. Find what differs.
 *
 * If the cost outcome is driven by the BUILD rather than the task, then "Strata cannot be cheaper"
 * is the wrong conclusion — the right one is "it was cheaper once and something regressed", which is
 * a bug hunt rather than a law of nature.
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs');
const out = [];

for (const d of fs.readdirSync(RUNS).filter((x) => fs.statSync(path.join(RUNS, x)).isDirectory())) {
  for (const f of fs.readdirSync(path.join(RUNS, d)).filter((x) => x.endsWith('.json'))) {
    if (!/stripejune/i.test(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(RUNS, d, f), 'utf-8')); } catch { continue; }
    if (j.ok !== true) continue;
    out.push({
      dir: d, file: f.replace(/\.json$/, ''), arm: j.arm, model: j.model || 'default',
      turns: j.turns, cost: j.costUsd,
      cacheRead: j.cacheReadTokens, output: j.outputTokens,
      build: j.strataBuild ? String(j.strataBuild).slice(0, 8) : null,
      recalls: (j.deliveredRecalls || []).join(', ') || null,
      calls: j.strataCalls,
      verify: j.verifyResult || null,
      dep: j.diagnosis ? j.diagnosis.hubComposed : null,
    });
  }
}

const k = (n) => (!Number.isFinite(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));

out.sort((a, b) => (a.dir + a.arm).localeCompare(b.dir + b.arm));

console.log('\n  dir                  arm       model            turns      $   cacheRead  output   build     calls');
console.log('  ' + '─'.repeat(108));
for (const r of out) {
  console.log('  ' + r.dir.slice(0, 20).padEnd(21) + r.arm.padEnd(10) + r.model.slice(0, 15).padEnd(17) +
    String(r.turns).padStart(5) + '  ' + ('$' + (r.cost || 0).toFixed(2)).padStart(6) + '  ' +
    k(r.cacheRead).padStart(10) + '  ' + k(r.output).padStart(6) + '   ' +
    (r.build || '—').padEnd(9) + String(r.calls ?? '—').padStart(4));
}

console.log('\n\n  ── what each STRATA run was actually given ──\n');
for (const r of out.filter((x) => x.arm === 'strata')) {
  console.log('  ' + r.file.slice(0, 40).padEnd(41) + '[' + r.dir.slice(0, 16) + ']');
  console.log('      modules : ' + (r.recalls || '(none recorded)'));
  console.log('      verify  : ' + (r.verify || '—') + '     turns ' + r.turns + '   $' + (r.cost || 0).toFixed(2));
}
console.log('');
