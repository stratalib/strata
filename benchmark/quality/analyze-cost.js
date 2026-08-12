#!/usr/bin/env node
'use strict';
/**
 * Where the money actually goes in an agent session.
 *
 * The quality battery recorded a cost per run but never asked what that cost was MADE of. This
 * reconstructs it from the raw session logs: every assistant message carries a `usage` block, so
 * the context size at each turn is recoverable, and with it the shape of the cost curve.
 *
 * The question that matters commercially: Strata buys quality but currently costs more, and a user
 * feels "session limit hit" far more sharply than a bug they never had to debug. So the interesting
 * output is not "how much" but "which component, and does it scale with turns or with context".
 *
 *   node benchmark/quality/analyze-cost.js            # full report
 *   node benchmark/quality/analyze-cost.js --json     # machine-readable
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');

/* Published per-MTok prices, used only to ATTRIBUTE a recorded cost across components — the totals
   come from the harness, these split them. Cache reads are an order of magnitude cheaper than fresh
   input, which is exactly why they can dominate a bill without anyone noticing. */
const PRICE = {
  haiku:  { in: 1.00,  cacheWrite: 1.25,  cacheRead: 0.10,  out: 5.00 },
  sonnet: { in: 3.00,  cacheWrite: 3.75,  cacheRead: 0.30,  out: 15.00 },
  opus:   { in: 5.00,  cacheWrite: 6.25,  cacheRead: 0.50,  out: 25.00 },
};

function parseLog(file) {
  const turns = [];
  const tools = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'assistant' || !j.message) continue;

    const u = j.message.usage || {};
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    turns.push({
      ctx,
      inTok: u.input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      out: u.output_tokens || 0,
    });

    for (const b of j.message.content || []) {
      if (b.type === 'tool_use') tools[b.name] = (tools[b.name] || 0) + 1;
    }
  }
  return { turns, tools };
}

function load() {
  const out = [];
  for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
    if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
    const log = parseLog(path.join(RUNS, f.replace(/\.json$/, '.log')));
    out.push({ ...rec, name: f.replace(/\.json$/, ''), log });
  }
  return out;
}

/* ── grades, so cost can be put next to quality ── */
function loadGrades() {
  const p = path.join(RUNS, 'GRADES.json');
  if (!fs.existsSync(p)) return {};
  const g = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const byRun = {};
  const rows = Array.isArray(g) ? g : (g.results || g.runs || []);
  for (const r of rows) {
    const key = r.run || r.name || r.id;
    if (!key) continue;
    const checks = r.checks || r.results || [];
    const passed = Array.isArray(checks) ? checks.filter((c) => c.pass === true || c.ok === true).length : (r.passed ?? null);
    const total = Array.isArray(checks) ? checks.length : (r.total ?? null);
    byRun[key] = { passed, total, pct: total ? (passed / total) * 100 : null };
  }
  return byRun;
}

const runs = load();
const grades = loadGrades();

const fmt = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(d));
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(runs.map((r) => ({
    name: r.name, task: r.task, arm: r.arm, model: r.model, ok: r.ok,
    turns: r.turns, cost: r.costUsd,
    inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens,
    grade: grades[r.name] || null,
    tools: r.log ? r.log.tools : null,
    ctxCurve: r.log ? r.log.turns.map((t) => t.ctx) : null,
  })), null, 2));
  process.exit(0);
}

/* ═══════════════ 1 · WHAT IS THE BILL MADE OF? ═══════════════ */
console.log('\n═══ 1 · COST COMPOSITION ═══\n');
console.log('  Every turn re-reads the whole conversation. That re-read is billed as cache-read');
console.log('  tokens, which are cheap per token but enormous in volume.\n');

const valid = runs.filter((r) => r.ok === true);
let agg = {};
for (const r of valid) {
  const key = `${r.arm}-${r.model}`;
  agg[key] = agg[key] || { n: 0, cacheRead: 0, out: 0, in: 0, cost: 0, turns: 0 };
  const a = agg[key];
  a.n++; a.cacheRead += r.cacheReadTokens || 0; a.out += r.outputTokens || 0;
  a.in += r.inputTokens || 0; a.cost += r.costUsd || 0; a.turns += r.turns || 0;
}

console.log('  arm            n   cacheRead    output    in     $/run  turns   cacheRead:output');
console.log('  ' + '─'.repeat(84));
for (const [key, a] of Object.entries(agg).sort()) {
  const ratio = a.out ? (a.cacheRead / a.out) : 0;
  console.log('  ' + key.padEnd(15) + String(a.n).padStart(2) + '  ' +
    k(a.cacheRead / a.n).padStart(9) + '  ' + k(a.out / a.n).padStart(8) + '  ' +
    k(a.in / a.n).padStart(5) + '  ' + ('$' + (a.cost / a.n).toFixed(3)).padStart(7) + '  ' +
    fmt(a.turns / a.n, 0).padStart(5) + '   ' + fmt(ratio, 0).padStart(6) + ':1');
}

/* Attribute spend across components using published prices. */
console.log('\n  Share of the bill, by component:\n');
console.log('  arm             cacheRead%   output%    input%');
console.log('  ' + '─'.repeat(50));
for (const [key, a] of Object.entries(agg).sort()) {
  const model = key.split('-').pop();
  const p = PRICE[model];
  if (!p) continue;
  const cr = (a.cacheRead / 1e6) * p.cacheRead;
  const ou = (a.out / 1e6) * p.out;
  const ip = (a.in / 1e6) * p.in;
  const tot = cr + ou + ip;
  console.log('  ' + key.padEnd(15) + fmt((cr / tot) * 100).padStart(8) + '%' +
    fmt((ou / tot) * 100).padStart(9) + '%' + fmt((ip / tot) * 100).padStart(9) + '%');
}

/* ═══════════════ 2 · IS COST LINEAR IN TURNS? ═══════════════ */
console.log('\n\n═══ 2 · THE SHAPE OF THE COST CURVE ═══\n');
console.log('  If context were constant, cost would be linear in turns. It is not: context grows as');
console.log('  the session accumulates, and every later turn re-reads all of it. Cost is therefore');
console.log('  superlinear — the last turns of a session cost far more than the first.\n');

const withLogs = valid.filter((r) => r.log && r.log.turns.length > 4);
console.log('  Context growth within a session (mean across runs, by decile of session):\n');
const deciles = Array.from({ length: 10 }, () => []);
for (const r of withLogs) {
  const T = r.log.turns;
  for (let d = 0; d < 10; d++) {
    const i = Math.min(T.length - 1, Math.floor((d / 10) * T.length));
    deciles[d].push(T[i].ctx);
  }
}
const dmean = deciles.map((a) => a.reduce((s, v) => s + v, 0) / (a.length || 1));
const maxd = Math.max(...dmean);
for (let d = 0; d < 10; d++) {
  const bar = '█'.repeat(Math.round((dmean[d] / maxd) * 46));
  console.log('  ' + ((d * 10) + '–' + (d * 10 + 10) + '%').padEnd(9) + k(dmean[d]).padStart(7) + '  ' + bar);
}
const growth = dmean[9] / (dmean[0] || 1);
console.log(`\n  Context at the end of a session is ${fmt(growth)}× what it was at the start.`);
console.log('  Every additional turn is therefore charged against a LARGER context than the one before.');

/* Marginal cost of a turn: fit cost vs turns within each model. */
console.log('\n  Cost per turn, early vs late (mean cache-read tokens per turn):\n');
for (const model of ['haiku', 'sonnet', 'opus']) {
  const rs = withLogs.filter((r) => r.model === model);
  if (!rs.length) continue;
  let firstQ = 0, lastQ = 0, nf = 0, nl = 0;
  for (const r of rs) {
    const T = r.log.turns, q = Math.max(1, Math.floor(T.length / 4));
    for (let i = 0; i < q; i++) { firstQ += T[i].ctx; nf++; }
    for (let i = T.length - q; i < T.length; i++) { lastQ += T[i].ctx; nl++; }
  }
  const a = firstQ / nf, b = lastQ / nl;
  console.log('  ' + model.padEnd(8) + 'first quarter ' + k(a).padStart(7) +
    '   last quarter ' + k(b).padStart(7) + '   ratio ' + fmt(b / a) + '×');
}

/* ═══════════════ 3 · WHAT DOES STRATA CHANGE? ═══════════════ */
console.log('\n\n═══ 3 · STRATA vs BASELINE, SAME MODEL ═══\n');
const tasks = [...new Set(valid.map((r) => r.task))].sort();
console.log('  task          model    arm        turns   cacheRead    output     $      quality');
console.log('  ' + '─'.repeat(84));
for (const task of tasks) {
  for (const model of ['haiku', 'sonnet']) {
    for (const arm of ['baseline', 'strata']) {
      const rs = valid.filter((r) => r.task === task && r.model === model && r.arm === arm);
      if (!rs.length) continue;
      const m = (f) => rs.reduce((s, r) => s + (f(r) || 0), 0) / rs.length;
      const gs = rs.map((r) => grades[r.name]).filter((g) => g && g.pct !== null);
      const q = gs.length ? gs.reduce((s, g) => s + g.pct, 0) / gs.length : null;
      console.log('  ' + task.padEnd(13) + model.padEnd(9) + arm.padEnd(11) +
        fmt(m((r) => r.turns), 0).padStart(5) + '  ' + k(m((r) => r.cacheReadTokens)).padStart(9) + '  ' +
        k(m((r) => r.outputTokens)).padStart(8) + '  ' + ('$' + m((r) => r.costUsd).toFixed(2)).padStart(6) +
        '   ' + (q === null ? '   —' : fmt(q) + '%').padStart(7));
    }
  }
}

/* ═══════════════ 4 · WHERE DO TURNS GO? ═══════════════ */
console.log('\n\n═══ 4 · WHAT THE TURNS ARE SPENT ON ═══\n');
console.log('  A turn is only expensive because of the context it drags. So the question is which');
console.log('  ACTIONS the model repeats — those are what add turns.\n');

function toolProfile(filter) {
  const rs = valid.filter(filter).filter((r) => r.log);
  const t = {};
  for (const r of rs) for (const [n, c] of Object.entries(r.log.tools)) t[n] = (t[n] || 0) + c;
  const n = rs.length || 1;
  return { n, tools: Object.fromEntries(Object.entries(t).map(([kk, v]) => [kk, v / n])) };
}

const names = new Set();
const profiles = {};
for (const arm of ['baseline', 'strata']) {
  for (const model of ['haiku', 'sonnet']) {
    const p = toolProfile((r) => r.arm === arm && r.model === model);
    profiles[`${arm}-${model}`] = p;
    Object.keys(p.tools).forEach((x) => names.add(x));
  }
}
const cols = Object.keys(profiles);
console.log('  tool'.padEnd(20) + cols.map((c) => c.padStart(17)).join(''));
console.log('  ' + '─'.repeat(20 + cols.length * 17));
for (const nm of [...names].sort()) {
  const row = cols.map((c) => fmt(profiles[c].tools[nm] || 0, 1).padStart(17)).join('');
  console.log('  ' + nm.padEnd(20) + row);
}
console.log('  ' + '─'.repeat(20 + cols.length * 17));
console.log('  ' + 'TOTAL calls'.padEnd(20) +
  cols.map((c) => fmt(Object.values(profiles[c].tools).reduce((s, v) => s + v, 0), 1).padStart(17)).join(''));

console.log('\n');
