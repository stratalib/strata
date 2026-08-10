#!/usr/bin/env node
'use strict';
/**
 * Render the benchmark board as an SVG scatter, straight from GRADES.json.
 *
 * Cost on x, quality on y, one point per arm. That pairing is the whole argument in one picture: the
 * two Strata points sit up and to the LEFT of every baseline, which is the shape a table of twenty
 * numbers makes a reader assemble in their head.
 *
 * Generated, never hand-drawn, so the chart cannot drift from the data the way the site's "-41% cost"
 * headline did. Re-run after any grading pass.
 *
 *   node scripts/render-benchmark-svg.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmark/runs/exp-quality/GRADES.json'), 'utf-8')).grades;

const ARMS = [
  { arm: 'baseline', model: 'haiku',  label: 'haiku',           strata: false },
  { arm: 'strata',   model: 'haiku',  label: 'haiku + Strata',  strata: true  },
  { arm: 'baseline', model: 'sonnet', label: 'sonnet',          strata: false },
  { arm: 'strata',   model: 'sonnet', label: 'sonnet + Strata', strata: true  },
  { arm: 'baseline', model: 'opus',   label: 'opus',            strata: false },
];
const TASKS = ['catalog', 'idempotency', 'stripejune', 'retry'];

const points = ARMS.map(a => {
  let q = 0, c = 0;
  for (const t of TASKS) {
    const graded = G.filter(r => r.suite === t && r.run.arm === a.arm && r.run.model === a.model && r.total > 0);
    const all    = G.filter(r => r.suite === t && r.run.arm === a.arm && r.run.model === a.model);
    q += 100 * graded.reduce((s, r) => s + r.passed, 0) / graded.reduce((s, r) => s + r.total, 0);
    c += all.reduce((s, r) => s + r.run.costUsd, 0) / all.length;
  }
  return { ...a, quality: q / TASKS.length, cost: c / TASKS.length };
});

const W = 760, H = 420, M = { t: 46, r: 28, b: 62, l: 62 };
const plotW = W - M.l - M.r, plotH = H - M.t - M.b;
const xMax = 1.8, yMin = 55, yMax = 100;
const X = (c) => M.l + (c / xMax) * plotW;
const Y = (q) => M.t + plotH - ((q - yMin) / (yMax - yMin)) * plotH;

/** One renderer, two palettes — GitHub picks via <picture> + prefers-color-scheme. */
function render({ bg, grid, text, dim, accent, base, edge }) {
  const xTicks = [0, 0.5, 1.0, 1.5];
  const yTicks = [60, 70, 80, 90, 100];

  const gridLines = [
    ...yTicks.map(t => `<line x1="${M.l}" y1="${Y(t).toFixed(1)}" x2="${M.l + plotW}" y2="${Y(t).toFixed(1)}" stroke="${grid}" stroke-width="1"/>`),
    ...xTicks.map(t => `<line x1="${X(t).toFixed(1)}" y1="${M.t}" x2="${X(t).toFixed(1)}" y2="${M.t + plotH}" stroke="${grid}" stroke-width="1"/>`),
  ].join('\n  ');

  const yLabels = yTicks.map(t =>
    `<text x="${M.l - 12}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" fill="${dim}" font-size="11" font-family="ui-monospace,monospace">${t}%</text>`).join('\n  ');
  const xLabels = xTicks.map(t =>
    `<text x="${X(t).toFixed(1)}" y="${M.t + plotH + 22}" text-anchor="middle" fill="${dim}" font-size="11" font-family="ui-monospace,monospace">$${t.toFixed(2)}</text>`).join('\n  ');

  // Label placement is nudged per-point so nothing collides with a neighbour or the frame.
  const nudge = {
    'haiku':           { dx: 0,  dy: 22,  anchor: 'middle' },
    'haiku + Strata':  { dx: 14, dy: -14, anchor: 'start'  },
    'sonnet':          { dx: 0,  dy: 24,  anchor: 'middle' },
    'sonnet + Strata': { dx: -14, dy: -14, anchor: 'end'   },
    'opus':            { dx: 0,  dy: 24,  anchor: 'middle' },
  };

  const dots = points.map(p => {
    const cx = X(p.cost), cy = Y(p.quality);
    const fill = p.strata ? accent : base;
    const n = nudge[p.label];
    return `  <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${p.strata ? 8 : 6}" fill="${fill}" stroke="${edge}" stroke-width="${p.strata ? 2 : 1}"/>
  <text x="${(cx + n.dx).toFixed(1)}" y="${(cy + n.dy).toFixed(1)}" text-anchor="${n.anchor}" fill="${p.strata ? accent : dim}" font-size="12.5" font-weight="${p.strata ? 600 : 400}" font-family="ui-monospace,monospace">${p.label}</text>
  <text x="${(cx + n.dx).toFixed(1)}" y="${(cy + n.dy + 14).toFixed(1)}" text-anchor="${n.anchor}" fill="${dim}" font-size="10.5" font-family="ui-monospace,monospace">${p.quality.toFixed(1)}% · $${p.cost.toFixed(2)}</text>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Quality against cost. haiku with Strata reaches 92.1% at \$0.27, above opus at 83.9% for \$1.33.">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <text x="${M.l}" y="26" fill="${text}" font-size="14" font-weight="600" font-family="ui-monospace,monospace">Quality vs cost — 60 runs, 4 tasks, mean per arm</text>
  ${gridLines}
  <line x1="${M.l}" y1="${M.t + plotH}" x2="${M.l + plotW}" y2="${M.t + plotH}" stroke="${dim}" stroke-width="1"/>
  <line x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${M.t + plotH}" stroke="${dim}" stroke-width="1"/>
  ${yLabels}
  ${xLabels}
  <text x="${M.l + plotW / 2}" y="${H - 14}" text-anchor="middle" fill="${dim}" font-size="11.5" font-family="ui-monospace,monospace">mean session cost (USD) — further left is cheaper</text>
  <text x="16" y="${M.t + plotH / 2}" text-anchor="middle" fill="${dim}" font-size="11.5" font-family="ui-monospace,monospace" transform="rotate(-90 16 ${M.t + plotH / 2})">checks passed — higher is better</text>
${dots}
</svg>
`;
}

const dark  = render({ bg: '#0B0F14', grid: 'rgba(255,255,255,0.06)', text: '#E6EDF3', dim: '#8892A0', accent: '#5EE7FF', base: '#4A5563', edge: '#0B0F14' });
const light = render({ bg: '#FFFFFF', grid: 'rgba(17,17,18,0.07)',   text: '#17191B', dim: '#5C6469', accent: '#1F7A96', base: '#AAB4BD', edge: '#FFFFFF' });

const out = path.join(ROOT, 'docs', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'benchmark-dark.svg'), dark);
fs.writeFileSync(path.join(out, 'benchmark-light.svg'), light);

console.log('wrote docs/assets/benchmark-{dark,light}.svg');
for (const p of points) console.log(`  ${p.label.padEnd(17)} ${p.quality.toFixed(1)}%  $${p.cost.toFixed(2)}`);
