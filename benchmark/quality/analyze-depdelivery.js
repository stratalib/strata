#!/usr/bin/env node
'use strict';
/**
 * Natural experiment: did dependency delivery actually change what the model read — and what it cost?
 *
 * DELIVER_AS_DEP installs the composed assembly as `strata-composed` so it reads as a dependency
 * (imported, not audited) instead of project source (audited). But the assembly is COPIED, not
 * moved — strata/lib.js stays on disk so the verifier's relative import keeps working. That leaves
 * the audited copy exactly where a model will find it.
 *
 * `strata/composed-pkg/` is archived (node_modules is not), so its presence is a reliable marker of
 * which runs took the dependency path. Splitting the Strata arm on that marker and comparing against
 * the matching baseline cell isolates the effect from task and model.
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const TREES = path.join(RUNS, 'trees');
const est = (s) => Math.ceil((s || '').length / 4);

function readsOf(logFile) {
  let text;
  try { text = fs.readFileSync(logFile, 'utf-8'); } catch { return null; }
  const pending = new Map();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'assistant' && j.message) {
      for (const b of j.message.content || []) {
        if (b.type === 'tool_use' && b.name === 'Read') pending.set(b.id, String((b.input || {}).file_path || ''));
      }
    }
    if (j.type === 'user' && j.message) {
      for (const b of j.message.content || []) {
        if (b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
        const p = pending.get(b.tool_use_id).replace(/\\/g, '/');
        const c = b.content;
        const body = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
        out.push({ p, tokens: est(body) });
      }
    }
  }
  return out;
}

const rows = [];
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const name = f.replace(/\.json$/, '');
  const reads = readsOf(path.join(RUNS, name + '.log')) || [];
  const dep = fs.existsSync(path.join(TREES, name, 'strata', 'composed-pkg', 'index.js'));
  const libRead = reads.filter((r) => /strata\/lib\.js$/i.test(r.p)).reduce((s, r) => s + r.tokens, 0);
  const pkgRead = reads.filter((r) => /composed-pkg/i.test(r.p)).reduce((s, r) => s + r.tokens, 0);
  const delivered = reads.filter((r) => /\/strata\//i.test(r.p)).reduce((s, r) => s + r.tokens, 0);
  rows.push({ name, task: rec.task, model: rec.model, arm: rec.arm, dep,
              turns: rec.turns, cost: rec.costUsd, libRead, pkgRead, delivered });
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const k = (n) => (n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const mean = (a, f) => (a.length ? a.reduce((s, x) => s + (f(x) || 0), 0) / a.length : NaN);

console.log('\n═══ 1 · DID THE DEPENDENCY PATH RUN? ═══\n');
const st = rows.filter((r) => r.arm === 'strata');
console.log('  strata runs with strata/composed-pkg present: ' + st.filter((r) => r.dep).length + ' / ' + st.length);
console.log('  (node_modules is excluded from archiving, so composed-pkg is the reliable marker)\n');
console.log('  task          model    dep?   runs   lib.js read   composed-pkg read   turns      $');
console.log('  ' + '─'.repeat(88));
const tasks = [...new Set(st.map((r) => r.task))].sort();
for (const task of tasks) {
  for (const model of ['haiku', 'sonnet']) {
    for (const dep of [true, false]) {
      const rs = st.filter((r) => r.task === task && r.model === model && r.dep === dep);
      if (!rs.length) continue;
      console.log('  ' + task.padEnd(13) + model.padEnd(9) + (dep ? 'yes' : 'no').padEnd(7) +
        String(rs.length).padStart(4) + '   ' + k(mean(rs, (r) => r.libRead)).padStart(11) +
        '   ' + k(mean(rs, (r) => r.pkgRead)).padStart(17) + '   ' +
        fmt(mean(rs, (r) => r.turns), 0).padStart(5) + '  ' + ('$' + fmt(mean(rs, (r) => r.cost))).padStart(6));
    }
  }
}

console.log('\n\n═══ 2 · COST vs THE MATCHING BASELINE CELL ═══\n');
console.log('  Strata cost as a multiple of the same model + same task WITHOUT Strata.\n');
console.log('  task          model    dep-delivered      source-delivered');
console.log('  ' + '─'.repeat(62));
let depRatios = [], srcRatios = [];
for (const task of tasks) {
  for (const model of ['haiku', 'sonnet']) {
    const base = mean(rows.filter((r) => r.arm === 'baseline' && r.task === task && r.model === model), (r) => r.cost);
    if (!Number.isFinite(base) || base <= 0) continue;
    const d = st.filter((r) => r.task === task && r.model === model && r.dep);
    const s = st.filter((r) => r.task === task && r.model === model && !r.dep);
    const dv = d.length ? mean(d, (r) => r.cost) / base : NaN;
    const sv = s.length ? mean(s, (r) => r.cost) / base : NaN;
    if (Number.isFinite(dv)) depRatios.push(dv);
    if (Number.isFinite(sv)) srcRatios.push(sv);
    console.log('  ' + task.padEnd(13) + model.padEnd(9) +
      (Number.isFinite(dv) ? fmt(dv) + '×' : '—').padStart(13) + '      ' +
      (Number.isFinite(sv) ? fmt(sv) + '×' : '—').padStart(13));
  }
}
const m = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log('  ' + '─'.repeat(62));
console.log('  ' + 'MEAN'.padEnd(22) + (fmt(m(depRatios)) + '×').padStart(13) + '      ' + (fmt(m(srcRatios)) + '×').padStart(13));

console.log('\n\n═══ 3 · THE READ THAT COSTS THE MOST ═══\n');
const libTotal = st.reduce((s, r) => s + r.libRead, 0);
const pkgTotal = st.reduce((s, r) => s + r.pkgRead, 0);
const allDelivered = st.reduce((s, r) => s + r.delivered, 0);
console.log('  strata/lib.js .................. ' + k(libTotal) + ' tokens   (' + fmt((libTotal / allDelivered) * 100, 0) + '% of delivered reads)');
console.log('  strata/composed-pkg/index.js ... ' + k(pkgTotal) + ' tokens   (' + fmt((pkgTotal / allDelivered) * 100, 0) + '%)');
console.log('  all delivered-code reads ....... ' + k(allDelivered) + ' tokens');
console.log('\n  lib.js is the copy left behind so the verifier\'s relative import keeps working.');
console.log('  It is also the file the model opens most.\n');
