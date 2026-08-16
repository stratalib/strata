#!/usr/bin/env node
'use strict';
/**
 * Print a session as a timeline: what the model said, what it ran, what came back.
 *
 * Aggregate tool counts say Bash went 9.3 → 26 without saying WHY. A cause needs the order and the
 * arguments: which commands, at which turn, in response to what. Everything else is inference.
 *
 *   node benchmark/quality/transcript.js exp-v11 catalog-strata-haiku-1
 *   node benchmark/quality/transcript.js exp-v11 catalog-strata-haiku-1 --full
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'runs', process.argv[2] || 'exp-v11');
const stem = process.argv[3];
const FULL = process.argv.includes('--full');
const text = fs.readFileSync(path.join(dir, stem + '.log'), 'utf-8');

const clip = (s, n) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

const results = new Map();   // tool_use_id -> first line of result
let turn = 0;
const events = [];

for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }

  if (j.type === 'user' && j.message) {
    for (const b of j.message.content || []) {
      if (b.type !== 'tool_result') continue;
      const c = b.content;
      const body = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
      results.set(b.tool_use_id, body);
    }
  }

  if (j.type !== 'assistant' || !j.message) continue;
  turn++;
  for (const b of j.message.content || []) {
    if (b.type === 'text' && b.text.trim()) {
      events.push({ turn, kind: 'say', text: b.text });
    } else if (b.type === 'tool_use') {
      const i = b.input || {};
      const arg = b.name === 'Bash' || b.name === 'PowerShell' ? (i.command || '')
        : b.name === 'Read' ? (i.file_path || '')
        : b.name === 'Write' || b.name === 'Edit' ? (i.file_path || '')
        : JSON.stringify(i);
      events.push({ turn, kind: 'tool', name: b.name, arg, id: b.id });
    }
  }
}

console.log(`\n  ${stem} — ${turn} assistant turns\n`);
for (const e of events) {
  if (e.kind === 'say') {
    if (FULL) console.log(`  ${String(e.turn).padStart(3)}  · ${clip(e.text, 220)}`);
    continue;
  }
  const out = results.get(e.id) || '';
  const firstLine = clip(out.split('\n').find((l) => l.trim()) || '', 90);
  console.log(`  ${String(e.turn).padStart(3)}  ${e.name.padEnd(6)} ${clip(e.arg, 96)}`);
  if (out && /error|fail|cannot|refus|not found|EADDR|throw/i.test(firstLine)) {
    console.log(`       ↳ ${firstLine}`);
  }
}
console.log('');
