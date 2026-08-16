#!/usr/bin/env node
'use strict';
/**
 * Did Strata EVER cost less than baseline — and on what?
 *
 * The published battery says it is a premium on three of four tasks, and that conclusion has been
 * driving strategy. But that battery is four tasks chosen months ago, and there are two dozen other
 * run directories on disk from earlier experiments. Before concluding "cheaper is unreachable", ask
 * the whole corpus rather than the one slice.
 *
 * Pairs baseline against strata within (directory, task, model) — never across builds or dates,
 * because a Strata run from a different build measures a different program.
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs');
const rows = [];

for (const d of fs.readdirSync(RUNS).filter((x) => fs.statSync(path.join(RUNS, x)).isDirectory())) {
  for (const f of fs.readdirSync(path.join(RUNS, d)).filter((x) => x.endsWith('.json'))) {
    if (/GRADES|SUMMARY|STATIC|BOARD|costtoworking/i.test(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(RUNS, d, f), 'utf-8')); } catch { continue; }
    if (!j.task || !j.arm || j.ok !== true) continue;
    if (typeof j.costUsd !== 'number' || j.costUsd <= 0) continue;
    rows.push({ dir: d, task: j.task, arm: j.arm, model: j.model || 'default',
                turns: j.turns, cost: j.costUsd, strataCalls: j.strataCalls });
  }
}

const mean = (a, f) => (a.length ? a.reduce((s, x) => s + (f(x) || 0), 0) / a.length : NaN);
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');

/* Pair within a directory so both arms came from the same build and the same day. */
const cells = {};
for (const r of rows) {
  const k = `${r.dir}|${r.task}|${r.model}`;
  cells[k] = cells[k] || { baseline: [], strata: [] };
  if (r.arm === 'baseline') cells[k].baseline.push(r);
  else if (r.arm === 'strata' && r.strataCalls > 0) cells[k].strata.push(r);
}

const pairs = [];
for (const [k, v] of Object.entries(cells)) {
  if (!v.baseline.length || !v.strata.length) continue;
  const [dir, task, model] = k.split('|');
  const b = mean(v.baseline, (x) => x.cost), s = mean(v.strata, (x) => x.cost);
  const bt = mean(v.baseline, (x) => x.turns), st = mean(v.strata, (x) => x.turns);
  pairs.push({ dir, task, model, b, s, ratio: s / b, bt, st,
               nb: v.baseline.length, ns: v.strata.length });
}
pairs.sort((a, b) => a.ratio - b.ratio);

console.log(`\n  ${rows.length} usable runs across ${new Set(rows.map(r => r.dir)).size} directories`);
console.log(`  ${pairs.length} comparable baseline-vs-strata cells (same dir, task, model)\n`);

console.log('  ratio   task          model    runs      baseline      strata     turns b→s   where');
console.log('  ' + '─'.repeat(100));
for (const p of pairs) {
  const win = p.ratio < 1 ? '★' : ' ';
  console.log(' ' + win + f2(p.ratio) + '×  ' + p.task.padEnd(13) + p.model.padEnd(9) +
    (p.nb + 'v' + p.ns).padStart(5) + '   ' + ('$' + f2(p.b)).padStart(9) + '   ' + ('$' + f2(p.s)).padStart(9) +
    '   ' + (Math.round(p.bt) + '→' + Math.round(p.st)).padStart(9) + '   ' + p.dir.slice(0, 22));
}

const wins = pairs.filter((p) => p.ratio < 1);
console.log('\n  ' + '─'.repeat(100));
console.log(`  Strata cost LESS in ${wins.length} of ${pairs.length} comparable cells.`);
if (wins.length) {
  console.log('  Wins:');
  for (const w of wins) {
    console.log(`    ${w.task}/${w.model} — ${f2(w.ratio)}× ($${f2(w.b)} → $${f2(w.s)}), ` +
                `turns ${Math.round(w.bt)}→${Math.round(w.st)}  [${w.dir}]`);
  }
}

/* Does the advantage scale with how big the job is? Use baseline turns as the size proxy. */
console.log('\n\n  ── does it scale with task size? (baseline turns as proxy) ──\n');
const buckets = [[0, 20], [20, 35], [35, 50], [50, 999]];
console.log('  baseline turns    cells   mean ratio   best');
console.log('  ' + '─'.repeat(54));
for (const [lo, hi] of buckets) {
  const inB = pairs.filter((p) => p.bt >= lo && p.bt < hi);
  if (!inB.length) continue;
  const m = mean(inB, (x) => x.ratio);
  const best = Math.min(...inB.map((x) => x.ratio));
  console.log('  ' + (lo + '–' + (hi === 999 ? '∞' : hi)).padEnd(18) +
    String(inB.length).padStart(4) + '   ' + f2(m).padStart(10) + '×   ' + f2(best) + '×');
}
console.log('');
