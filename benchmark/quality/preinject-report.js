#!/usr/bin/env node
'use strict';
/**
 * Did pre-injection kill the audit?
 *
 * The hypothesis: the model reads delivered code because a tool handed it over, not because the code
 * is there. If that is right, the preinject arm — same bytes, already committed, no delivery event —
 * should read like BASELINE (~1k tokens, late) rather than like STRATA (~12k tokens, early).
 *
 * Outcome variable is tokens-read and re-billed token-turns, not cost. Cost is downstream of those
 * and noisier at small n.
 *
 * Also repairs armValid on preinject records written before the rule was generalised: those runs
 * completed correctly and only their label was wrong.
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const est = (s) => Math.ceil((s || '').length / 4);

/* ── repair mislabelled preinject records ───────────────────────────────────────────────────── */
let repaired = 0;
for (const f of fs.readdirSync(RUNS).filter((x) => /-preinject-.*\.json$/.test(x))) {
  const p = path.join(RUNS, f);
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (j.arm === 'preinject' && j.ok === true && j.strataCalls === 0 && j.armValid !== true) {
    j.armValid = true;
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
    repaired++;
  }
}
if (repaired) console.log(`\n  repaired armValid on ${repaired} preinject record(s)\n`);

/* ── read profile per run ───────────────────────────────────────────────────────────────────── */
function profile(stem) {
  let text;
  try { text = fs.readFileSync(path.join(RUNS, stem + '.log'), 'utf-8'); } catch { return null; }
  const pending = new Map();
  const reads = [];
  let turn = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'assistant' && j.message) {
      turn++;
      for (const b of j.message.content || []) {
        if (b.type === 'tool_use') pending.set(b.id, { name: b.name, p: String((b.input || {}).file_path || ''), turn });
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
  return { reads, turns: turn };
}

/** The file under test, per arm: the delivered implementation by whatever name it goes by. */
const isImpl = (p) => /strata\/lib\.js$|composed-pkg|strata-composed|src\/lib\/toolkit\.js$/i.test(p);

const rows = [];
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const stem = f.replace(/\.json$/, '');
  const pr = profile(stem);
  if (!pr) continue;
  const implTok = pr.reads.filter((r) => isImpl(r.p)).reduce((s, r) => s + r.tokens, 0);
  const allTok = pr.reads.reduce((s, r) => s + r.tokens, 0);
  const rebill = pr.reads.reduce((s, r) => s + r.tokens * Math.max(0, pr.turns - r.turn), 0);
  rows.push({ stem, task: rec.task, arm: rec.arm, model: rec.model,
              turns: rec.turns, cost: rec.costUsd, reads: pr.reads.length, implTok, allTok, rebill });
}

const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const mean = (a, f) => (a.length ? a.reduce((s, x) => s + (f(x) || 0), 0) / a.length : NaN);
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');

const tasks = [...new Set(rows.filter((r) => r.arm === 'preinject').map((r) => r.task))];
if (!tasks.length) { console.log('  no preinject runs yet\n'); process.exit(0); }

console.log('═══ DID PRE-INJECTION STOP THE AUDIT? ═══\n');
console.log('  Same implementation in every strata/preinject cell — the only difference is whether a');
console.log('  tool handed it over or it was already committed.\n');
console.log('  task      model    arm         n   turns      $     reads   impl read   all read   re-billed');
console.log('  ' + '─'.repeat(96));
for (const task of tasks) {
  for (const model of ['haiku', 'sonnet']) {
    for (const arm of ['baseline', 'preinject', 'strata']) {
      const rs = rows.filter((r) => r.task === task && r.model === model && r.arm === arm);
      if (!rs.length) continue;
      const mark = arm === 'preinject' ? '»' : ' ';
      console.log(' ' + mark + task.padEnd(10) + model.padEnd(9) + arm.padEnd(11) +
        String(rs.length).padStart(2) + '  ' +
        mean(rs, (r) => r.turns).toFixed(0).padStart(5) + '  ' +
        ('$' + f2(mean(rs, (r) => r.cost))).padStart(6) + '  ' +
        mean(rs, (r) => r.reads).toFixed(1).padStart(6) + '  ' +
        k(mean(rs, (r) => r.implTok)).padStart(10) + '  ' +
        k(mean(rs, (r) => r.allTok)).padStart(9) + '  ' +
        k(mean(rs, (r) => r.rebill)).padStart(10));
    }
  }
}

console.log('\n\n═══ WHAT THE PRE-INJECT RUNS ACTUALLY OPENED ═══\n');
for (const r of rows.filter((x) => x.arm === 'preinject')) {
  console.log('  ' + r.stem + '   ' + r.turns + ' turns · $' + f2(r.cost));
  const pr = profile(r.stem);
  const byPath = {};
  for (const rd of pr.reads) {
    const short = rd.p.split('/').slice(-2).join('/');
    byPath[short] = byPath[short] || { n: 0, t: 0, first: rd.turn };
    byPath[short].n++; byPath[short].t += rd.tokens;
  }
  for (const [p, v] of Object.entries(byPath).sort((a, b) => b[1].t - a[1].t).slice(0, 6)) {
    console.log('      ' + k(v.t).padStart(7) + ' tok  ×' + String(v.n).padStart(2) +
      '  first@turn ' + String(v.first).padStart(3) + '   ' + p);
  }
  console.log('');
}
