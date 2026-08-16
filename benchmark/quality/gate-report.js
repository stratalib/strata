#!/usr/bin/env node
'use strict';
/**
 * The Step 5 gate: did removing the readable assembly change what the model reads, and what it costs?
 *
 * Compares a run directory against the recorded v1.0 numbers for the same cell. Reads are the causal
 * variable and are nearly immune to the hub-vs-local confound — the file either exists to be read or
 * it does not. Turns are the behavioural question and carry the confound; treat them as indicative.
 *
 *   node benchmark/quality/gate-report.js exp-v11
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs');
const dirName = process.argv[2] || 'exp-v11';
const est = (s) => Math.ceil((s || '').length / 4);

function profile(dir, stem) {
  let text;
  try { text = fs.readFileSync(path.join(dir, stem + '.log'), 'utf-8'); } catch { return null; }
  const pending = new Map();
  const reads = [];
  let turn = 0;
  const tools = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'assistant' && j.message) {
      turn++;
      for (const b of j.message.content || []) {
        if (b.type !== 'tool_use') continue;
        tools[b.name] = (tools[b.name] || 0) + 1;
        pending.set(b.id, { name: b.name, p: String((b.input || {}).file_path || ''), turn });
      }
    }
    if (j.type === 'user' && j.message) {
      for (const b of j.message.content || []) {
        if (b.type !== 'tool_result') continue;
        const m = pending.get(b.tool_use_id);
        if (!m || m.name !== 'Read') continue;
        const c = b.content;
        const body = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
        reads.push({ p: m.p.replace(/\\/g, '/'), tokens: est(body), turn: m.turn });
      }
    }
  }
  return { reads, turns: turn, tools };
}

const isDelivered = (p) => /strata\/lib\.js$|composed-pkg|strata-composed|strata\/verify\.js$|strata\/tests\//i.test(p);

const dir = path.join(RUNS, dirName);
if (!fs.existsSync(dir)) { console.log(`  no such run dir: ${dirName}`); process.exit(1); }

const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const pr = profile(dir, f.replace(/\.json$/, ''));
  if (!pr) continue;
  rows.push({
    name: f.replace(/\.json$/, ''), model: rec.model, turns: rec.turns, cost: rec.costUsd,
    allRead: pr.reads.reduce((s, r) => s + r.tokens, 0),
    delivered: pr.reads.filter((r) => isDelivered(r.p)).reduce((s, r) => s + r.tokens, 0),
    readCalls: pr.tools.Read || 0,
    bash: pr.tools.Bash || 0,
    reads: pr.reads,
  });
}

const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
const mean = (a, f) => (a.length ? a.reduce((s, x) => s + (f(x) || 0), 0) / a.length : NaN);

/* v1.0 recorded, catalog / haiku / strata (hub mode) — from benchmark/runs/exp-quality */
const V10 = { turns: 32.3, cost: 0.221, allRead: 11900, delivered: 5500, readCalls: 12.3, bash: 9.3 };

for (const model of ['haiku', 'sonnet']) {
  const rs = rows.filter((r) => r.model === model);
  if (!rs.length) continue;
  console.log(`\n═══ ${dirName} · catalog · ${model} · n=${rs.length} ═══\n`);
  console.log('  metric                v1.0        v1.1      change');
  console.log('  ' + '─'.repeat(52));
  const cmp = [
    ['turns', V10.turns, mean(rs, (r) => r.turns), 0],
    ['cost $', V10.cost, mean(rs, (r) => r.cost), 3],
    ['Read calls', V10.readCalls, mean(rs, (r) => r.readCalls), 1],
    ['Bash calls', V10.bash, mean(rs, (r) => r.bash), 1],
  ];
  for (const [label, a, b, d] of cmp) {
    const pct = a ? ((b - a) / a) * 100 : NaN;
    console.log('  ' + label.padEnd(20) + a.toFixed(d).padStart(7) + b.toFixed(d).padStart(11) +
      '   ' + ((pct >= 0 ? '+' : '') + pct.toFixed(0) + '%').padStart(7));
  }
  for (const [label, a, b] of [['tokens read', V10.allRead, mean(rs, (r) => r.allRead)],
                               ['delivered read', V10.delivered, mean(rs, (r) => r.delivered)]]) {
    const pct = a ? ((b - a) / a) * 100 : NaN;
    console.log('  ' + label.padEnd(20) + k(a).padStart(7) + k(b).padStart(11) +
      '   ' + ((pct >= 0 ? '+' : '') + pct.toFixed(0) + '%').padStart(7));
  }

  console.log('\n  what each run opened:');
  for (const r of rs) {
    const by = {};
    for (const rd of r.reads) {
      const short = rd.p.split('/').slice(-2).join('/');
      by[short] = (by[short] || 0) + rd.tokens;
    }
    console.log('    ' + r.name + `  (${r.turns} turns, $${r.cost.toFixed(3)})`);
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!top.length) console.log('        (read nothing)');
    for (const [p, t] of top) console.log('        ' + k(t).padStart(7) + '  ' + p);
  }
}
console.log('');
