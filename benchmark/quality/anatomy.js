#!/usr/bin/env node
'use strict';
/**
 * Decompose a run into WHERE THE TURNS WENT.
 *
 * Aggregate turn and cost totals say an arm lost without saying to what, and the three candidate
 * explanations need completely different fixes:
 *
 *   toolFlail   — turns spent resolving/invoking the MCP tool, before any work happens. Pure overhead
 *                 that only the Strata arm can incur, so it belongs in its own column rather than
 *                 buried in "turns". Counted as ToolSearch calls plus any Agent spawned before the
 *                 first strata_use, plus Bash that merely pokes at the tool.
 *   auditDeliv  — reads and greps of files STRATA delivered (composed-pkg, strata/, strata-wiring).
 *                 This is the audit-inversion cost; the fix is delivery shape.
 *   integration — Write/Edit on the project's own source. This is real work, and a high number here
 *                 is Strata delivering something that still needed fitting, not waste.
 *   demoScript  — writing throwaway `test-` / `demo-` scripts the task never asked for, then running
 *                 them. TERSE already forbids docs; this is the same instinct wearing a different hat.
 *   reverify    — running strata/verify.js after being handed its result.
 *
 * Usage:
 *   node benchmark/quality/anatomy.js exp-tasks-n1
 *   node benchmark/quality/anatomy.js exp-tasks-n1 --task idempotency
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'runs', process.argv[2] || 'exp-tasks-n1');
const only = (() => { const i = process.argv.indexOf('--task'); return i !== -1 ? process.argv[i + 1] : null; })();

const DELIVERED = /composed-pkg|[\\/]strata[\\/]|strata-wiring|strata-composed/i;
const DEMO = /\b(test|demo|example|scratch|check|try)[-_.]/i;

function anatomy(stem) {
  const log = path.join(dir, stem + '.log');
  const js = path.join(dir, stem + '.json');
  if (!fs.existsSync(log) || !fs.existsSync(js)) return null;
  const meta = JSON.parse(fs.readFileSync(js, 'utf-8'));

  let turns = 0, firstStrata = Infinity, idx = 0;
  const calls = [];
  for (const line of fs.readFileSync(log, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'assistant' || !j.message) continue;
    turns++;
    for (const b of j.message.content || []) {
      if (b.type !== 'tool_use') continue;
      idx++;
      const i = b.input || {};
      const arg = i.command || i.file_path || i.pattern || JSON.stringify(i).slice(0, 200);
      if (b.name === 'mcp__strata__strata_use') firstStrata = Math.min(firstStrata, idx);
      calls.push({ idx, name: b.name, arg: String(arg) });
    }
  }

  const c = { toolFlail: 0, auditDeliv: 0, integration: 0, demoScript: 0, reverify: 0, other: 0 };
  for (const k of calls) {
    const before = k.idx < firstStrata;
    if (k.name === 'ToolSearch' || (k.name === 'Agent' && before)) { c.toolFlail++; continue; }
    if (k.name === 'Bash' && before && /require\(['"]mcp|strata_use/.test(k.arg)) { c.toolFlail++; continue; }
    if (/verify\.js/.test(k.arg)) { c.reverify++; continue; }
    if ((k.name === 'Write' || k.name === 'Edit') && DEMO.test(path.basename(k.arg))) { c.demoScript++; continue; }
    if (k.name === 'Bash' && DEMO.test(k.arg) && /node /.test(k.arg)) { c.demoScript++; continue; }
    if ((k.name === 'Read' || k.name === 'Grep' || k.name === 'Bash') && DELIVERED.test(k.arg)) { c.auditDeliv++; continue; }
    if (k.name === 'Write' || k.name === 'Edit') { c.integration++; continue; }
    c.other++;
  }

  return { stem, turns, tools: calls.length, cost: meta.costUsd, ...c,
    strataCalls: meta.strataCalls, firstStrataAt: firstStrata === Infinity ? null : firstStrata };
}

const stems = [...new Set(fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')))]
  .filter(s => !only || s.startsWith(only + '-'))
  .sort();

console.log(`\n  WHERE THE TURNS WENT — ${path.basename(dir)}\n`);
console.log('  run                                turns  tools   $      flail  audit  integ  demo  rever  other');
console.log('  ' + '─'.repeat(103));
for (const s of stems) {
  const a = anatomy(s);
  if (!a) continue;
  const p = (n, w) => String(n).padStart(w);
  console.log(`  ${a.stem.padEnd(33)}${p(a.turns, 5)}${p(a.tools, 7)}  $${a.cost.toFixed(3)}`
    + `${p(a.toolFlail, 7)}${p(a.auditDeliv, 7)}${p(a.integration, 7)}${p(a.demoScript, 6)}${p(a.reverify, 7)}${p(a.other, 7)}`);
}
console.log('');
