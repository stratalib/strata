#!/usr/bin/env node
'use strict';
/**
 * The audit tax: what a Strata session READS, and what that reading costs.
 *
 * analyze-cost.js established that 66–78% of a bill is cache-read — the re-reading of accumulated
 * context on every turn — and that Strata sessions issue ~2.2× as many Read calls as baseline ones.
 * This measures the consequence directly: which files get read, how many tokens each read plants in
 * context, and how much of the final context is code the model did not write.
 *
 * A token read once is not paid once. It sits in context and is re-billed on EVERY subsequent turn.
 * So a 4k-token file read at turn 10 of a 40-turn session is charged roughly 30 more times.
 *
 *   node benchmark/quality/analyze-reads.js
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const est = (s) => Math.ceil((s || '').length / 4);      // ~4 chars/token, good enough for shares

/** Classify a path by what it means for the cost story. */
function classify(p) {
  const s = String(p || '').replace(/\\/g, '/').toLowerCase();
  if (/\/strata\/(lib|composed-pkg)/.test(s) || /\/strata\/tests?\//.test(s)) return 'delivered impl';
  if (/\/strata\/verify\.js$/.test(s)) return 'delivered verifier';
  if (/\/strata\//.test(s)) return 'delivered other';
  if (/package(-lock)?\.json$/.test(s)) return 'package.json';
  if (/\/(src|lib|routes|models|data|db)\//.test(s)) return 'project source';
  if (/readme|\.md$/.test(s)) return 'docs';
  return 'other';
}

function analyse(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }

  const pending = new Map();            // tool_use_id -> {name, path}
  const reads = [];                     // {path, kind, tokens, turnIndex}
  let turnIndex = 0, lastCtx = 0, firstCtx = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }

    if (j.type === 'assistant' && j.message) {
      turnIndex++;
      const u = j.message.usage || {};
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (!firstCtx) firstCtx = ctx;
      lastCtx = Math.max(lastCtx, ctx);
      for (const b of j.message.content || []) {
        if (b.type === 'tool_use') pending.set(b.id, { name: b.name, path: (b.input || {}).file_path || (b.input || {}).path, turnIndex });
      }
    }

    if (j.type === 'user' && j.message) {
      for (const b of j.message.content || []) {
        if (b.type !== 'tool_result') continue;
        const meta = pending.get(b.tool_use_id);
        if (!meta || meta.name !== 'Read') continue;
        const c = b.content;
        const body = typeof c === 'string' ? c
          : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
        reads.push({ path: meta.path, kind: classify(meta.path), tokens: est(body), turnIndex: meta.turnIndex });
      }
    }
  }
  return { reads, turns: turnIndex, firstCtx, lastCtx };
}

const rows = [];
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const a = analyse(path.join(RUNS, f.replace(/\.json$/, '.log')));
  if (!a) continue;
  rows.push({ ...rec, name: f.replace(/\.json$/, ''), ...a });
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));

/* ═══ 1 · read volume by arm ═══ */
console.log('\n═══ 1 · HOW MUCH IS READ INTO CONTEXT ═══\n');
console.log('  arm             runs   reads/run   tokens read/run   as % of peak context');
console.log('  ' + '─'.repeat(74));
const groups = {};
for (const r of rows) {
  const g = `${r.arm}-${r.model}`;
  groups[g] = groups[g] || [];
  groups[g].push(r);
}
for (const [g, rs] of Object.entries(groups).sort()) {
  const reads = rs.reduce((s, r) => s + r.reads.length, 0) / rs.length;
  const toks = rs.reduce((s, r) => s + r.reads.reduce((a, x) => a + x.tokens, 0), 0) / rs.length;
  const peak = rs.reduce((s, r) => s + r.lastCtx, 0) / rs.length;
  console.log('  ' + g.padEnd(16) + String(rs.length).padStart(4) + '   ' +
    fmt(reads, 1).padStart(8) + '   ' + k(toks).padStart(14) + '   ' + fmt((toks / peak) * 100, 1).padStart(15) + '%');
}

/* ═══ 2 · what is being read ═══ */
console.log('\n\n═══ 2 · WHAT IS BEING READ (tokens per run) ═══\n');
const kinds = ['delivered impl', 'delivered verifier', 'delivered other', 'project source', 'package.json', 'docs', 'other'];
const cols = Object.keys(groups).sort();
console.log('  ' + 'kind'.padEnd(20) + cols.map((c) => c.padStart(17)).join(''));
console.log('  ' + '─'.repeat(20 + cols.length * 17));
for (const kind of kinds) {
  const row = cols.map((c) => {
    const rs = groups[c];
    const t = rs.reduce((s, r) => s + r.reads.filter((x) => x.kind === kind).reduce((a, x) => a + x.tokens, 0), 0) / rs.length;
    return (t ? k(t) : '·').padStart(17);
  }).join('');
  console.log('  ' + kind.padEnd(20) + row);
}

/* ═══ 3 · the re-billing multiplier ═══ */
console.log('\n\n═══ 3 · WHAT A READ ACTUALLY COSTS ═══\n');
console.log('  A read at turn N of a T-turn session is re-billed on every remaining turn. So its true');
console.log('  cost is tokens × (T − N) — reading EARLY is far more expensive than reading late.\n');
console.log('  arm             tokens read   mean read turn   re-billed token-turns   vs baseline');
console.log('  ' + '─'.repeat(82));
const rebill = {};
for (const [g, rs] of Object.entries(groups).sort()) {
  let tt = 0, wsum = 0, wtot = 0;
  for (const r of rs) {
    for (const x of r.reads) {
      tt += x.tokens;
      wsum += x.tokens * Math.max(0, r.turns - x.turnIndex);
      wtot += x.tokens * x.turnIndex;
    }
  }
  const n = rs.length;
  rebill[g] = wsum / n;
  const meanTurn = tt ? wtot / tt : 0;
  console.log('  ' + g.padEnd(16) + k(tt / n).padStart(11) + '   ' + fmt(meanTurn, 1).padStart(14) + '   ' + k(wsum / n).padStart(21));
}
for (const model of ['haiku', 'sonnet']) {
  const b = rebill[`baseline-${model}`], s = rebill[`strata-${model}`];
  if (b && s) console.log(`\n  ${model}: Strata re-bills ${fmt(s / b, 2)}× the read-tokens of baseline.`);
}

/* ═══ 4 · per-run detail, worst first ═══ */
console.log('\n\n═══ 4 · WORST OFFENDERS (most delivered-code tokens read) ═══\n');
const scored = rows.map((r) => ({
  name: r.name,
  turns: r.turns,
  cost: r.costUsd,
  delivered: r.reads.filter((x) => x.kind.startsWith('delivered')).reduce((a, x) => a + x.tokens, 0),
  total: r.reads.reduce((a, x) => a + x.tokens, 0),
})).sort((a, b) => b.delivered - a.delivered).slice(0, 12);
console.log('  run                              turns     $     delivered read   all reads');
console.log('  ' + '─'.repeat(78));
for (const s of scored) {
  console.log('  ' + s.name.padEnd(32) + String(s.turns).padStart(4) + '  ' +
    ('$' + fmt(s.cost, 2)).padStart(6) + '  ' + k(s.delivered).padStart(14) + '  ' + k(s.total).padStart(10));
}
console.log('\n');
