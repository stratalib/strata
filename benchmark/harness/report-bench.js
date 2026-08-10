#!/usr/bin/env node
'use strict';
// Aggregates N reps per cell into mean/min/max. Single samples are worthless here: the same task
// has swung 2.5x on identical inputs, which is why every single-sample conclusion in this project
// turned out to be wrong. Reports OUTPUT TOKENS first — that is Strata's only mechanism, and across
// every clean run to date it has never once moved.
const fs = require('fs');
const path = require('path');

const ROOT = process.env.STRATA_BENCH_ROOT || path.join(os.tmpdir(), 'strata-bench-auto');
const TASKS = (process.env.STRATA_BENCH_TASKS || 'stripe jwt reset chat rbac').split(/\s+/).filter(Boolean);
const REPS = parseInt(process.env.STRATA_BENCH_REPS || '1', 10);
const OUT = path.join(ROOT, '_out');

function loadCell(id, arm) {
  const runs = [];
  for (let r = 1; r <= REPS; r++) {
    const f = path.join(OUT, `${id}-${arm}-r${r}.json`);
    const legacy = path.join(OUT, `${id}-${arm}.json`);
    const file = fs.existsSync(f) ? f : (REPS === 1 && fs.existsSync(legacy) ? legacy : null);
    if (!file) continue;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // Skip corpses: a session killed by the usage limit still writes a valid-looking result.json
      // (is_error:true, 1 turn, $0.00). Averaging those in silently drags every mean toward zero.
      if (j.total_cost_usd == null || j.is_error === true || !(j.num_turns > 1)) continue;
      runs.push({
        cost: j.total_cost_usd,
        out: j.usage?.output_tokens ?? 0,
        turns: j.num_turns ?? 0,
        cr: j.usage?.cache_read_input_tokens ?? 0,
        cw: j.usage?.cache_creation_input_tokens ?? 0,
      });
    } catch { /* skip */ }
  }
  return runs;
}

const mean = (a, k) => (a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : null);
const min = (a, k) => (a.length ? Math.min(...a.map(x => x[k])) : null);
const max = (a, k) => (a.length ? Math.max(...a.map(x => x[k])) : null);
const pct = (b, s) => (b == null || s == null || b === 0 ? '—' : (((b - s) / b) * 100).toFixed(0) + '%');
const k = (v) => (v == null ? '—' : (v / 1000).toFixed(1) + 'k');
const d = (v) => (v == null ? '—' : '$' + v.toFixed(2));

console.log(`\nStrata benchmark — ${REPS} rep(s)/cell — ${ROOT}\n`);

for (const id of TASKS) {
  const b = loadCell(id, 'baseline');
  const s = loadCell(id, 'strata');
  if (!b.length && !s.length) continue;

  console.log(`### ${id}   (baseline n=${b.length}, strata n=${s.length})`);
  console.log('  metric        baseline (mean)      strata (mean)        delta');
  console.log('  ' + '-'.repeat(66));

  const rows = [
    ['OUTPUT tok', k(mean(b, 'out')), k(mean(s, 'out')), pct(mean(b, 'out'), mean(s, 'out')), '<-- THE metric'],
    ['cost', d(mean(b, 'cost')), d(mean(s, 'cost')), pct(mean(b, 'cost'), mean(s, 'cost')), ''],
    ['turns', (mean(b, 'turns') ?? 0).toFixed(0), (mean(s, 'turns') ?? 0).toFixed(0), pct(mean(b, 'turns'), mean(s, 'turns')), ''],
    ['cache read', k(mean(b, 'cr')), k(mean(s, 'cr')), pct(mean(b, 'cr'), mean(s, 'cr')), ''],
    ['cache write', k(mean(b, 'cw')), k(mean(s, 'cw')), pct(mean(b, 'cw'), mean(s, 'cw')), ''],
  ];
  for (const [n, bv, sv, dl, note] of rows) {
    console.log('  ' + n.padEnd(13) + String(bv).padEnd(20) + String(sv).padEnd(20) + String(dl).padEnd(8) + note);
  }
  if (b.length > 1 || s.length > 1) {
    console.log(`  spread: baseline cost ${d(min(b, 'cost'))}–${d(max(b, 'cost'))} | strata cost ${d(min(s, 'cost'))}–${d(max(s, 'cost'))}`);
  }

  // Pre-registered verdict (set BEFORE the data — no goalpost moving).
  const oB = mean(b, 'out'), oS = mean(s, 'out'), cB = mean(b, 'cost'), cS = mean(s, 'cost');
  if (oB && oS && cB && cS) {
    const outDrop = (oB - oS) / oB;
    const cheaper = cS < cB;
    const alive = outDrop >= 0.25 && cheaper;
    console.log('');
    console.log(`  VERDICT: output ${(outDrop * 100).toFixed(0)}% lower (bar: >=25%) | cost ${cheaper ? 'below' : 'ABOVE'} baseline (bar: below)`);
    console.log(`  ==> ${alive ? 'ALIVE' : 'DEAD'}`);
  }
  console.log('');
}
