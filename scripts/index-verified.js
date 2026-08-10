#!/usr/bin/env node
'use strict';
/**
 * Record WHERE the verified recalls live, so the MCP server never has to go looking.
 *
 * THE BUG THIS FIXES — the most expensive one in the system.
 *
 * loadLibrary() walked the recall tree with fs.readdirSync: 15,750 directories, 7,691 metadata files,
 * to locate the SEVENTEEN recalls we actually serve. A 452:1 ratio. And readdirSync is SYNCHRONOUS, so
 * it blocked the event loop for ~3.4s on an idle disk — far longer under concurrency.
 *
 * The server registers its tools before that scan starts, but a blocked event loop cannot answer
 * anything. So `tools/list` went unanswered, Claude Code reported "MCP server strata-lib is still
 * connecting", the model searched twice, gave up, and built the whole feature from scratch.
 *
 * Measured cost: TWO of three `platform` benchmark runs were lost this way — 84 turns / $2.32 and
 * 63 turns / $1.58 — and both looked like ordinary Strata results in the output. A tool that silently
 * fails to load is worse than one that errors: the session degrades to baseline-plus-overhead and
 * nobody finds out.
 *
 * Run this after promoting a recall into cache/verified-recalls.json.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOWLIST = path.join(ROOT, 'cache', 'verified-recalls.json');

const allow = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf-8'));
const want = new Set(allow.verified);

const found = {};

function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, depth + 1); continue; }
    if (e.name !== 'metadata.json') continue;
    try {
      const meta = JSON.parse(fs.readFileSync(full, 'utf-8'));
      if (meta.id && want.has(meta.id)) {
        found[meta.id] = path.relative(ROOT, dir).split(path.sep).join('/');
      }
    } catch { /* unreadable metadata — skip */ }
  }
}

walk(path.join(ROOT, 'recalls'), 0);

const missing = [...want].filter(id => !found[id]);

allow.paths = found;
allow.generatedAt = new Date().toISOString();
allow.note =
  'Allowlist of verified recalls. Selection delivers ONLY these. `paths` exists so startup reads these ' +
  'metadata files DIRECTLY instead of walking 15,750 directories with a SYNCHRONOUS readdirSync — that ' +
  'walk blocked the event loop for 3.4s+ and meant tools/list never answered, so sessions gave up on ' +
  'Strata and built from scratch. Regenerate with: node scripts/index-verified.js';

fs.writeFileSync(ALLOWLIST, JSON.stringify(allow, null, 2) + '\n');

console.log(`  indexed ${Object.keys(found).length}/${want.size} verified recalls`);
if (missing.length) {
  console.log(`  WARNING — verified but NOT FOUND on disk: ${missing.join(', ')}`);
  console.log('  (these will silently never be delivered)');
}
