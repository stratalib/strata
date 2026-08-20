#!/usr/bin/env node
'use strict';
/**
 * The savings board — tokens, turns and latency, before and after, on one task.
 *
 * FORM. This is a magnitude comparison of paired quantities, so it is paired bars, not a scatter and
 * not a line: the reader's job is to see how much shorter the second bar is, and length is the encoding
 * the eye reads most accurately. Each pair shares an axis so the two bars are directly comparable, and
 * the reduction is direct-labelled on the row because that number is the point.
 *
 * ONE TASK, NOT AN AVERAGE. catalog is shown alone rather than a mean across tasks, because averaging a
 * task the library covers with one it barely covers produces a number that describes neither. The tasks
 * where coverage is partial are published too — see the benchmark page — but they do not belong inside
 * this comparison.
 *
 *   node scripts/render-savings-svg.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = 'exp-v12';
const TASK = 'catalog';

function cell(arm) {
  const rows = [];
  for (const r of [1, 2, 3]) {
    const p = path.join(ROOT, 'benchmark', 'runs', DIR, `${TASK}-${arm}-haiku-${r}.json`);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!j.ok || !j.armValid || j.synthetic) continue;
    rows.push(j);
  }
  const m = f => rows.reduce((s, x) => s + f(x), 0) / rows.length;
  return {
    tokens: m(j => (j.inputTokens || 0) + (j.outputTokens || 0) + (j.cacheReadTokens || 0)),
    turns: m(j => j.turns),
    secs: m(j => (j.wallMs || 0) / 1000),
  };
}

const b = cell('baseline');
const s = cell('strata');

const fmtTok = v => (v / 1000).toFixed(0) + 'k';
const METRICS = [
  { key: 'tokens', label: 'tokens read + written', fmt: fmtTok },
  { key: 'turns',  label: 'turns',                 fmt: v => v.toFixed(1) },
  { key: 'secs',   label: 'wall-clock time',       fmt: v => v.toFixed(0) + 's' },
];

const W = 760;
// The right margin is a reserved column for the reduction badge, not slack: at r=116 the longest
// bar's own value label ran under the badge and the two collided.
const M = { l: 168, r: 150, t: 62, b: 40 };
const BAND = 76;
const H = M.t + METRICS.length * BAND + M.b;
const plotW = W - M.l - M.r;

function render(t) {
  const rows = METRICS.map((metric, i) => {
    const y = M.t + i * BAND;
    const bv = b[metric.key], sv = s[metric.key];
    const max = Math.max(bv, sv);
    const wOf = v => Math.max((v / max) * plotW, 3);
    const cut = Math.round((1 - sv / bv) * 100);

    const bar = (v, yy, color, name) =>
      `<rect x="${M.l}" y="${yy}" width="${wOf(v).toFixed(1)}" height="16" rx="4" fill="${color}"/>
  <text x="${M.l - 12}" y="${yy + 12}" text-anchor="end" fill="${t.dim}" font-size="11" font-family="ui-monospace,monospace">${name}</text>
  <text x="${(M.l + wOf(v) + 10).toFixed(1)}" y="${yy + 12}" fill="${t.text}" font-size="11.5" font-weight="600" font-family="ui-monospace,monospace">${metric.fmt(v)}</text>`;

    return `<text x="${M.l - 12}" y="${y + 4}" text-anchor="end" fill="${t.text}" font-size="12" font-weight="600" font-family="ui-monospace,monospace">${metric.label}</text>
  ${bar(bv, y + 14, t.base, 'without')}
  ${bar(sv, y + 38, t.accent, 'Strata')}
  <text x="${W - 24}" y="${y + 34}" text-anchor="end" fill="${t.accent}" font-size="19" font-weight="700" font-family="ui-monospace,monospace">−${cut}%</text>`;
  }).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="On one backend task: ${Math.round((1 - s.tokens / b.tokens) * 100)} percent fewer tokens, ${Math.round((1 - s.turns / b.turns) * 100)} percent fewer turns, ${Math.round((1 - s.secs / b.secs) * 100)} percent less wall-clock time.">
  <rect width="${W}" height="${H}" fill="${t.bg}"/>
  <text x="24" y="28" fill="${t.text}" font-size="14" font-weight="600" font-family="ui-monospace,monospace">Same task. Same model. Same prompt.</text>
  <text x="24" y="46" fill="${t.dim}" font-size="11" font-family="ui-monospace,monospace">product API — pagination, per-IP rate limiting, request logging · haiku · mean of 3 runs</text>
  ${rows}
</svg>
`;
}

const light = render({ bg: '#FFFFFF', grid: 'rgba(17,17,18,0.07)', text: '#17191B', dim: '#5C6469', accent: '#2A7FA8', base: '#B8622E' });
const dark  = render({ bg: '#0B0F14', grid: 'rgba(255,255,255,0.06)', text: '#E6EDF3', dim: '#8892A0', accent: '#3E97BD', base: '#C4763F' });

// SVG is parsed as XML, which defines only amp/lt/gt/quot/apos. An HTML entity like &minus; is a
// parse error, and the browser's only symptom is a broken image — the file still serves 200 with the
// right mime type. Use literal characters and assert it here rather than discover it on the page.
for (const svg of [light, dark]) {
  const bad = [...new Set([...svg.matchAll(/&([a-zA-Z][a-zA-Z0-9]*);/g)].map(m => m[1]))]
    .filter(e => !['amp', 'lt', 'gt', 'quot', 'apos'].includes(e));
  if (bad.length) throw new Error('entity not defined in XML: &' + bad.join('; &') + ';');
}

fs.writeFileSync(path.join(ROOT, 'docs', 'assets', 'savings-light.svg'), light);
fs.writeFileSync(path.join(ROOT, 'docs', 'assets', 'savings-dark.svg'), dark);

console.log('\n  wrote docs/assets/savings-{light,dark}.svg\n');
for (const m of METRICS) {
  console.log(`  ${m.label.padEnd(24)} ${m.fmt(b[m.key]).padStart(8)} -> ${m.fmt(s[m.key]).padStart(8)}   -${Math.round((1 - s[m.key] / b[m.key]) * 100)}%`);
}
console.log('');
