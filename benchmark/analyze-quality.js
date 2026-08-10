#!/usr/bin/env node
'use strict';
/**
 * Roll GRADES.json into the answer to one question:
 *
 *     Does  haiku + Strata  reach the quality of  sonnet without Strata ?
 *
 * Cost is reported as CONTEXT, never as the verdict. Under the current thesis a cheaper arm that
 * scores the same quality is the product working; a cheaper arm that scores worse is just a cheaper
 * arm. The old analyzer scored cost deltas and called them wins, which is how a cross-model price gap
 * once got reported as a 79% Strata victory.
 *
 *   node benchmark/analyze-quality.js
 */
const fs = require('fs');
const path = require('path');

const runsDir = process.argv[2] || path.join(__dirname, 'runs', 'exp-quality');
const gradesPath = path.join(runsDir, 'GRADES.json');
if (!fs.existsSync(gradesPath)) {
  console.error(`no GRADES.json in ${runsDir} — run: node benchmark/quality/grade.js --all`);
  process.exit(1);
}
const { suiteHash, grades } = JSON.parse(fs.readFileSync(gradesPath, 'utf-8'));

const cellOf = (g) => `${g.run.model}+${g.run.arm}`;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const tasks = [...new Set(grades.map(g => g.run.task))].sort();
const report = { generatedAt: new Date().toISOString(), suiteHash, runsGraded: grades.length, tasks: {} };

for (const task of tasks) {
  const gs = grades.filter(g => g.run.task === task);
  const cells = [...new Set(gs.map(cellOf))].sort();

  const cellStats = {};
  for (const cell of cells) {
    const rows = gs.filter(g => cellOf(g) === cell);
    cellStats[cell] = {
      n: rows.length,
      scores: rows.map(r => `${r.passed}/${r.total}`),
      meanPassPct: Math.round(mean(rows.map(r => pct(r.passed, r.total)))),
      bootFailures: rows.filter(r => !r.booted).length,
      meanCostUsd: Number((mean(rows.map(r => r.run.costUsd || 0))).toFixed(4)),
      meanTurns: Math.round(mean(rows.map(r => r.run.turns || 0))),
    };
  }

  // Which individual checks separate the arms — the part that makes a result showcase-worthy.
  // "77% vs 74%" is a shrug; "haiku alone fails the refill check 3/3, haiku+Strata passes 3/3" is not.
  const allCheckIds = [...new Set(gs.flatMap(g => g.results.map(r => r.id)))];
  const perCheck = {};
  for (const id of allCheckIds) {
    perCheck[id] = {};
    for (const cell of cells) {
      const rows = gs.filter(g => cellOf(g) === cell);
      const passes = rows.filter(g => (g.results.find(r => r.id === id) || {}).pass).length;
      perCheck[id][cell] = `${passes}/${rows.length}`;
    }
  }

  // THE headline comparison. Deliberately cross-model: that is the claim.
  const product = cellStats['haiku+strata'];
  const target = cellStats['sonnet+baseline'];
  const floor = cellStats['haiku+baseline'];

  let verdict = 'insufficient data';
  if (product && target) {
    const gap = product.meanPassPct - target.meanPassPct;
    const nOk = product.n >= 2 && target.n >= 2;
    verdict =
      !nOk ? `PRELIMINARY (n=${product.n} vs ${target.n}) — ${product.meanPassPct}% vs ${target.meanPassPct}%`
      : gap >= 0 ? `CLAIM HOLDS — haiku+Strata ${product.meanPassPct}% >= sonnet baseline ${target.meanPassPct}%`
      : gap >= -10 ? `CLOSE — haiku+Strata ${product.meanPassPct}% vs sonnet baseline ${target.meanPassPct}% (${gap} pts)`
      : `CLAIM FAILS — haiku+Strata ${product.meanPassPct}% vs sonnet baseline ${target.meanPassPct}% (${gap} pts)`;
  }

  report.tasks[task] = {
    cells: cellStats,
    perCheck,
    headline: {
      floorPct: floor ? floor.meanPassPct : null,
      productPct: product ? product.meanPassPct : null,
      targetPct: target ? target.meanPassPct : null,
      // Did Strata move the cheap model toward the expensive one, and by how much of the gap?
      // Only meaningful when the target is actually ABOVE the floor. On catalog it is not — sonnet
      // baseline (63%) scores BELOW haiku baseline (71%), so the "gap" is negative and the ratio
      // reported a nonsense -212%. A more capable model scoring lower is a real and important result;
      // it just makes "percent of the gap closed" the wrong sentence for it.
      gapClosedPct: (floor && product && target && target.meanPassPct > floor.meanPassPct)
        ? Math.round(((product.meanPassPct - floor.meanPassPct) / (target.meanPassPct - floor.meanPassPct)) * 100)
        : null,
      targetBelowFloor: !!(floor && target && target.meanPassPct < floor.meanPassPct),
      verdict,
    },
  };
}

fs.writeFileSync(path.join(runsDir, 'QUALITY-SUMMARY.json'), JSON.stringify(report, null, 2));

// ── human-readable ──────────────────────────────────────────────────────────────
console.log(`\n=== QUALITY BENCHMARK (suite ${suiteHash}, ${grades.length} runs graded) ===`);
for (const task of tasks) {
  const t = report.tasks[task];
  console.log(`\n── ${task} ─────────────────────────────────────`);
  console.log('  cell                n   scores        quality   turns    cost');
  for (const [cell, s] of Object.entries(t.cells)) {
    console.log(`  ${cell.padEnd(18)} ${String(s.n).padEnd(3)} ${s.scores.join(' ').padEnd(13)} `
      + `${String(s.meanPassPct + '%').padEnd(9)} ${String(s.meanTurns).padEnd(8)} $${s.meanCostUsd}`
      + (s.bootFailures ? `   (${s.bootFailures} never booted)` : ''));
  }
  console.log(`\n  VERDICT: ${t.headline.verdict}`);
  if (t.headline.gapClosedPct !== null) {
    console.log(`  Strata closed ${t.headline.gapClosedPct}% of the haiku→sonnet quality gap.`);
  } else if (t.headline.targetBelowFloor) {
    console.log(`  NOTE: sonnet baseline (${t.headline.targetPct}%) scored BELOW haiku baseline `
      + `(${t.headline.floorPct}%) — there is no gap to close. The more capable model measured worse.`);
  }

  // Only print checks that actually differ between cells — the rest is noise.
  const cells = Object.keys(t.cells);
  const rows = Object.entries(t.perCheck).filter(([, byCell]) =>
    new Set(cells.map(c => byCell[c])).size > 1);
  if (rows.length) {
    console.log(`\n  checks that SEPARATE the arms:`);
    console.log(`    ${'check'.padEnd(34)}${cells.map(c => c.padEnd(16)).join('')}`);
    for (const [id, byCell] of rows) {
      console.log(`    ${id.padEnd(34)}${cells.map(c => String(byCell[c] || '-').padEnd(16)).join('')}`);
    }
  }
}
console.log(`\nwrote ${path.join(runsDir, 'QUALITY-SUMMARY.json')}`);
