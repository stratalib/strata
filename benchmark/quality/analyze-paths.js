#!/usr/bin/env node
'use strict';
/**
 * Exactly WHICH files a Strata session opens, and how many tokens each one plants in context.
 *
 * DELIVER_AS_DEP has been on by default since 2026-07-23 precisely so the composed implementation
 * arrives as an installed dependency (which models leave alone) rather than as project source (which
 * they audit). If delivered-code reads are still large in this battery, either the flag was not
 * active for these runs or the assembly is still reachable somewhere the model treats as source.
 * This prints the raw paths so that question is answered by evidence, not inference.
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const est = (s) => Math.ceil((s || '').length / 4);
const norm = (p) => String(p || '').replace(/\\/g, '/');

/** Collapse a machine path to the part that matters, dropping the temp-dir prefix. */
function shorten(p) {
  const s = norm(p);
  const m = s.match(/(?:bench-[A-Za-z0-9]+|tmp[^/]*)\/(.*)$/i);
  return m ? m[1] : s.split('/').slice(-3).join('/');
}

const byPath = {};
const armOf = {};

for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true || rec.arm !== 'strata') continue;

  let text;
  try { text = fs.readFileSync(path.join(RUNS, f.replace(/\.json$/, '.log')), 'utf-8'); } catch { continue; }

  const pending = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }

    if (j.type === 'assistant' && j.message) {
      for (const b of j.message.content || []) {
        if (b.type === 'tool_use' && b.name === 'Read') pending.set(b.id, (b.input || {}).file_path);
      }
    }
    if (j.type === 'user' && j.message) {
      for (const b of j.message.content || []) {
        if (b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
        const p = shorten(pending.get(b.tool_use_id));
        const c = b.content;
        const body = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
        byPath[p] = byPath[p] || { reads: 0, tokens: 0 };
        byPath[p].reads++;
        byPath[p].tokens += est(body);
        (armOf[p] = armOf[p] || new Set()).add(rec.model);
      }
    }
  }
}

const rows = Object.entries(byPath).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 28);
const k = (n) => (n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

console.log('\n═══ FILES OPENED ACROSS ALL 24 STRATA RUNS ═══\n');
console.log('  tokens    reads   path');
console.log('  ' + '─'.repeat(84));
let deliveredTok = 0, otherTok = 0;
for (const [p, v] of rows) {
  console.log('  ' + k(v.tokens).padStart(7) + '  ' + String(v.reads).padStart(6) + '   ' + p.slice(0, 62));
}
for (const [p, v] of Object.entries(byPath)) {
  if (/strata\//i.test(p) || /strata-composed/i.test(p)) deliveredTok += v.tokens; else otherTok += v.tokens;
}
console.log('  ' + '─'.repeat(84));
console.log('  delivered-code tokens read: ' + k(deliveredTok) + '   everything else: ' + k(otherTok));

/* Is the composed assembly reachable as source, as a dependency, or both? */
console.log('\n\n═══ WHERE THE ASSEMBLY LIVES IN THE TREES ═══\n');
const trees = path.join(RUNS, 'trees');
if (fs.existsSync(trees)) {
  const seen = {};
  for (const d of fs.readdirSync(trees)) {
    if (!/strata/.test(d)) continue;
    for (const probe of [
      'strata/lib.js', 'strata/composed-pkg/index.js', 'strata/composed-pkg/package.json',
      'node_modules/strata-composed/index.js', 'strata/verify.js', 'strata/selftest.js',
    ]) {
      const hit = fs.existsSync(path.join(trees, d, probe));
      seen[probe] = seen[probe] || { yes: 0, no: 0 };
      hit ? seen[probe].yes++ : seen[probe].no++;
    }
  }
  console.log('  path                                    present / absent');
  console.log('  ' + '─'.repeat(60));
  for (const [p, v] of Object.entries(seen)) {
    console.log('  ' + p.padEnd(40) + String(v.yes).padStart(5) + ' / ' + String(v.no).padStart(5));
  }
} else {
  console.log('  (archived trees not present)');
}
console.log('\n');
