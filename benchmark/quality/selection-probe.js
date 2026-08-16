#!/usr/bin/env node
'use strict';
/**
 * Score every verified recall against a task's REAL capabilities, and show what selection would pick.
 *
 * Built after api.idempotency.v1 lost the idempotency task. Two faults compounded, and neither was
 * visible from the outside — the delivery reported 8/8 PASSED for logging and validation checks while
 * the actual requirement (duplicate order prevention) was never delivered:
 *
 *   1. MORPHOLOGY. Scoring is substring-based, and "idempotent" is not a substring of "idempotency".
 *      The two highest-weight fields (id=12, name=8) therefore scored ZERO on the single most on-point
 *      token, despite the recall being named "Idempotency Keys for Express".
 *   2. PER_LAYER_CAP. At most 2 candidates per layer, so the third-placed L2 recall is dropped even
 *      when it is the only one that does what was asked.
 *
 * This is a REGRESSION harness, not a one-off: selection scoring is global, so a change that fixes one
 * task can silently break another. Capture before, change, capture after, diff.
 *
 *   node benchmark/quality/selection-probe.js                 # all tasks
 *   node benchmark/quality/selection-probe.js --task idempotency
 *   node benchmark/quality/selection-probe.js --json > before.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const ONLY = argOf('--task', null);
const JSON_OUT = process.argv.includes('--json');

/**
 * The capabilities a real session actually sent, lifted from the recorded runs rather than invented
 * here. Inventing them would make this probe measure my idea of the task instead of the model's, and
 * the model's phrasing is the input selection really receives.
 */
const OBSERVED = {
  idempotency: {
    primary: 'idempotent order creation with request validation and logging',
    capabilities: ['idempotent POST requests', 'request body validation', 'attempt logging', 'duplicate prevention'],
    mustSelect: ['api.idempotency.v1'],
  },
  catalog: {
    primary: 'pagination for products list, rate limiting per IP, request logging with tracing ID',
    capabilities: ['cursor pagination', 'per-IP rate limiting', 'request logging with correlation id'],
    mustSelect: ['api.pagination.v1', 'cache.ratelimit.v1'],
  },
  stripejune: {
    primary: 'stripe payment processing with webhook signature verification',
    capabilities: ['stripe webhook signature verification', 'payment intent handling', 'idempotent event processing'],
    mustSelect: ['payment.stripe-webhook.v1'],
  },
  retry: {
    primary: 'retry a flaky API call with exponential backoff',
    capabilities: ['exponential backoff retry', 'http client with retries'],
    mustSelect: ['http.resilient-client.v1'],
  },
};

const SCORE_STOPWORDS = new Set([
  'mapping', 'service', 'system', 'module', 'manager', 'handler',
  'provider', 'helper', 'checker', 'builder', 'processor', 'generator',
  'validator', 'hook', 'wrapper', 'adapter', 'plugin', 'layer',
]);
const tokenize = (s) => s.toLowerCase().split(/[\s,.\-_/]+/).filter(t => t.length > 1 && !SCORE_STOPWORDS.has(t));

/**
 * Mirrors src/mcp-server.ts `fieldHit`. Kept in sync by test, not by hope — scripts/test-selection.js
 * asserts the two agree, because a probe that scores differently from the engine is worse than none.
 */
const STEM_MIN = 6;
function fieldHit(field, token) {
  if (field.includes(token)) return true;
  if (token.length < STEM_MIN) return false;
  const stem = token.slice(0, STEM_MIN);
  for (const w of field.split(/[^a-z0-9]+/)) {
    if (w.length >= STEM_MIN && w.slice(0, STEM_MIN) === stem) return true;
  }
  return false;
}

const USE_STEM = process.env.PROBE_STEM !== '0';
const hit = (field, token) => USE_STEM ? fieldHit(field, token) : field.includes(token);

function loadMetas() {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'verified-recalls.json'), 'utf-8'));
  const want = new Set((idx.verified || []).map(r => r.id || r));
  const metas = new Map();
  (function walk(d, depth) {
    if (depth > 5) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      const mp = path.join(p, 'metadata.json');
      if (fs.existsSync(mp)) {
        try { const m = JSON.parse(fs.readFileSync(mp, 'utf-8')); if (want.has(m.id) && !metas.has(m.id)) metas.set(m.id, m); } catch { /* skip */ }
      }
      walk(p, depth + 1);
    }
  })(path.join(ROOT, 'recalls'), 0);
  return metas;
}

const PER_LAYER_CAP = 2;
const LAYER_BONUS = 4;

function rank(metas, spec) {
  const primary = new Set(tokenize(spec.primary));
  const toks = spec.capabilities.flatMap(tokenize);
  const rows = [];
  for (const m of metas.values()) {
    const id = String(m.id || '').toLowerCase();
    const name = String(m.name || '').toLowerCase();
    const desc = String(m.description || '').toLowerCase();
    const tags = (m.tags || []).join(' ').toLowerCase();
    let s = 0;
    for (const t of toks) {
      const b = primary.has(t) ? 2 : 1;
      s += b * ((hit(id, t) ? 12 : 0) + (hit(name, t) ? 8 : 0) + (hit(desc, t) ? 5 : 0) + (hit(tags, t) ? 4 : 0));
    }
    rows.push({ id: m.id, layer: m.layer ?? 2, score: s + LAYER_BONUS * (m.layer ?? 2) });
  }
  rows.sort((a, b) => b.score - a.score);
  // Apply the per-layer cap the engine applies, so "would it actually be delivered" is answerable.
  const perLayer = new Map();
  const selected = [];
  for (const r of rows) {
    const n = perLayer.get(r.layer) || 0;
    if (n >= PER_LAYER_CAP) continue;
    perLayer.set(r.layer, n + 1);
    selected.push(r);
  }
  return { rows, selected: selected.slice(0, 5) };
}

const metas = loadMetas();
const out = {};
for (const [task, spec] of Object.entries(OBSERVED)) {
  if (ONLY && task !== ONLY) continue;
  const { rows, selected } = rank(metas, spec);
  const selIds = selected.map(r => r.id);
  const missing = (spec.mustSelect || []).filter(id => !selIds.includes(id));
  out[task] = { top: rows.slice(0, 6), selected: selIds, missing };

  if (JSON_OUT) continue;
  console.log(`\n  ${task}${USE_STEM ? '' : '  (stemming OFF)'}`);
  for (const r of rows.slice(0, 6)) {
    const mark = (spec.mustSelect || []).includes(r.id) ? '  <<< required' : '';
    const sel = selIds.includes(r.id) ? ' [SELECTED]' : '';
    console.log(`    ${String(r.score).padStart(4)}  L${r.layer}  ${r.id.padEnd(28)}${sel}${mark}`);
  }
  console.log(missing.length ? `    MISSING: ${missing.join(', ')}` : '    all required recalls selected');
}
if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else console.log('');
