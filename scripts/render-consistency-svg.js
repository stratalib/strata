#!/usr/bin/env node
'use strict';
/**
 * Render the v1.1 consistency board — per-RUN quality, not the mean.
 *
 * WHY A DOT PLOT AND NOT BARS. The finding this chart exists to show is spread: three runs of one task
 * with one model, and whether you get the same answer each time. A bar of the mean destroys exactly
 * that — baseline's 52.4% average on idempotency is made of 14%, 71%, 71%, and the 14% is the whole
 * point. Averaging is the anti-pattern here, so every run is a mark and the range is drawn behind them.
 *
 * Generated from GRADES.json, never hand-drawn, for the same reason as render-benchmark-svg.js: a
 * hand-written headline drifts from the data and nobody notices.
 *
 *   node scripts/render-consistency-svg.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Cells, each naming the run directory it came from.
 *
 * catalog is measured on a slightly earlier prompt (the harness later told BOTH arms not to write
 * throwaway test scripts). It is included because the spread it shows does not depend on that change,
 * and excluded from the cost claims elsewhere that do. Provenance is printed on the chart rather than
 * left in a commit message.
 */
const CELLS = [
  { task: 'catalog',     dir: 'exp-v12', label: 'pagination · rate limit · logging' },
  { task: 'idempotency', dir: 'exp-v22', label: 'idempotent order creation' },
  { task: 'stripejune',  dir: 'exp-v20', label: 'stripe webhooks · queue · receipts' },
];

function runsFor(dir, task, arm) {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmark', 'runs', dir, 'GRADES.json'), 'utf-8'));
  const out = [];
  for (const [stem, v] of Object.entries(g)) {
    if (!stem.startsWith(`${task}-${arm}-haiku-`)) continue;
    if (!v || !v.total) continue;
    out.push(100 * v.passed / v.total);
  }
  return out.sort((a, b) => a - b);
}

const data = CELLS.map(c => ({
  ...c,
  baseline: runsFor(c.dir, c.task, 'baseline'),
  strata: runsFor(c.dir, c.task, 'strata'),
})).filter(c => c.baseline.length && c.strata.length);

// ─── geometry ────────────────────────────────────────────────────────────────
const W = 760;
const M = { l: 132, r: 96, t: 64, b: 52 };
const BAND = 84;                       // vertical space per task
const H = M.t + data.length * BAND + M.b;
const plotW = W - M.l - M.r;
const X = q => M.l + (q / 100) * plotW;

function render(t) {
  const rows = data.map((c, i) => {
    const y0 = M.t + i * BAND;
    const yb = y0 + 24;                // baseline row
    const ys = y0 + 52;                // strata row

    const series = (vals, y, color, name) => {
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const spread = hi - lo;
      // The range bar IS the message: a long bar means "you cannot predict what you get".
      const bar = `<rect x="${X(lo).toFixed(1)}" y="${(y - 3).toFixed(1)}" width="${Math.max(X(hi) - X(lo), 2).toFixed(1)}" height="6" rx="3" fill="${color}" opacity="0.22"/>`;
      // Identical runs land on the same coordinate — that overlap is the finding, so it is drawn with a
      // surface ring and counted rather than hidden by transparency.
      const counts = new Map();
      for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
      // Count sits BESIDE the dot, not above it: above collides with the task caption on the first row
      // of every band, and a label that overlaps a heading is worse than no label.
      const dots = [...counts.entries()].map(([v, n]) => {
        const cx = X(v);
        // Nudge left when the dot is at the far right, so "×3" cannot run under the value column.
        const right = cx > X(92);
        return `<circle cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="${color}" stroke="${t.bg}" stroke-width="2"/>`
          + (n > 1 ? `<text x="${(cx + (right ? -10 : 10)).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="${right ? 'end' : 'start'}" fill="${t.dim}" font-size="9.5" font-family="ui-monospace,monospace">×${n}</text>` : '');
      }).join('');
      const label = `<text x="${M.l - 12}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="${t.dim}" font-size="11" font-family="ui-monospace,monospace">${name}</text>`;
      const val = `<text x="${W - M.r + 12}" y="${(y + 4).toFixed(1)}" fill="${t.text}" font-size="11" font-family="ui-monospace,monospace">${mean.toFixed(0)}%${spread > 0 ? ` <tspan fill="${t.dim}">±${(spread / 2).toFixed(0)}</tspan>` : ` <tspan fill="${t.dim}">exact</tspan>`}</text>`;
      return bar + dots + label + val;
    };

    return `<text x="${M.l - 12}" y="${(y0 + 6).toFixed(1)}" text-anchor="end" fill="${t.text}" font-size="12" font-weight="600" font-family="ui-monospace,monospace">${c.task}</text>
  <text x="${M.l}" y="${(y0 + 6).toFixed(1)}" fill="${t.dim}" font-size="10.5" font-family="ui-monospace,monospace">${c.label}</text>
  ${series(c.baseline, yb, t.base, 'no Strata')}
  ${series(c.strata, ys, t.accent, 'Strata')}`;
  }).join('\n  ');

  const ticks = [0, 25, 50, 75, 100].map(q =>
    `<line x1="${X(q).toFixed(1)}" y1="${M.t - 12}" x2="${X(q).toFixed(1)}" y2="${H - M.b + 6}" stroke="${t.grid}" stroke-width="1"/>
  <text x="${X(q).toFixed(1)}" y="${H - M.b + 22}" text-anchor="middle" fill="${t.dim}" font-size="10.5" font-family="ui-monospace,monospace">${q}%</text>`).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Quality of every individual run, three runs per arm per task. Without Strata the results scatter — on idempotency 14%, 71% and 71%. With Strata every run of a task lands on the same score.">
  <rect width="${W}" height="${H}" fill="${t.bg}"/>
  <text x="${M.l - 120}" y="26" fill="${t.text}" font-size="14" font-weight="600" font-family="ui-monospace,monospace">Every run, not the average — haiku, 3 runs per arm</text>
  <text x="${M.l - 120}" y="44" fill="${t.dim}" font-size="11" font-family="ui-monospace,monospace">each dot is one run · the bar is the spread between best and worst</text>
  <circle cx="${W - M.r - 118}" cy="22" r="5.5" fill="${t.base}" stroke="${t.bg}" stroke-width="2"/>
  <text x="${W - M.r - 106}" y="26" fill="${t.dim}" font-size="10.5" font-family="ui-monospace,monospace">no Strata</text>
  <circle cx="${W - M.r - 44}" cy="22" r="5.5" fill="${t.accent}" stroke="${t.bg}" stroke-width="2"/>
  <text x="${W - M.r - 32}" y="26" fill="${t.dim}" font-size="10.5" font-family="ui-monospace,monospace">Strata</text>
  ${ticks}
  ${rows}
  <text x="${M.l - 120}" y="${H - 12}" fill="${t.dim}" font-size="10" font-family="ui-monospace,monospace">catalog measured before a later prompt change that applies to both arms; the spread it shows is unaffected.</text>
</svg>
`;
}

// Steps validated with the dataviz palette checker: light and dark each get their OWN pair, both
// passing lightness band, chroma floor, CVD separation, normal-vision floor and contrast.
const light = render({ bg: '#FFFFFF', grid: 'rgba(17,17,18,0.07)', text: '#17191B', dim: '#5C6469', accent: '#2A7FA8', base: '#B8622E' });
const dark  = render({ bg: '#0B0F14', grid: 'rgba(255,255,255,0.06)', text: '#E6EDF3', dim: '#8892A0', accent: '#3E97BD', base: '#C4763F' });

fs.writeFileSync(path.join(ROOT, 'docs', 'assets', 'consistency-light.svg'), light);
fs.writeFileSync(path.join(ROOT, 'docs', 'assets', 'consistency-dark.svg'), dark);

console.log('\n  wrote docs/assets/consistency-{light,dark}.svg\n');
for (const c of data) {
  const f = a => a.map(v => v.toFixed(0) + '%').join(' ');
  console.log(`  ${c.task.padEnd(13)} no Strata ${f(c.baseline).padEnd(20)}  Strata ${f(c.strata)}`);
}
console.log('');
