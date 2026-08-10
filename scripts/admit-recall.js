#!/usr/bin/env node
'use strict';
/**
 * THE ADMISSION BAR — every recall must pass this before it can be served.
 *
 * WHY IT EXISTS
 *
 * Strata's value is COMPOSITION, and composition value scales with how many recalls can compose:
 *
 *     recalls   task        cost     turns
 *        1      retry       +21%     +25%    LOSS
 *        4      catalog     -41%     -41%    WIN
 *
 * So coverage IS the product. But hand-authoring a recall takes hours, which makes coverage a grind
 * and a bottleneck. The way out is to make admission MACHINE-CHECKABLE: generate a recall, run six
 * gates, promote or DISCARD.
 *
 * THE RULE: a recall that fails admission is DISCARDED, not hand-patched. The moment we hand-fix
 * generated recalls, we are back to craft and coverage stops scaling.
 *
 * WHY THE ADVERSARIAL GATE IS THE ONE THAT MATTERS
 *
 * Every hand-written recall in this library shipped with a real bug its own tests did not catch:
 *
 *   - http.resilient-client: a 404 called breaker.onSuccess(), RESETTING the consecutive-failure
 *     count, so 500,500,404,500,500 never tripped the breaker. The selftest passed because it tested
 *     4xx only in ISOLATION, never interleaved with real failures.
 *   - data.csv-import: the Prisma enum constraint was dropped — category=BANANA imported cleanly.
 *   - observability.logging: an attacker-controlled x-request-id was echoed into a response header and
 *     into every log line. CRLF gave you a 500 on demand, and forged log entries.
 *   - the verifier itself used an INVALID enum value as its "valid" sample, so the import check went
 *     green while the constraint was being ignored entirely.
 *
 * Every one was caught by a benchmark session, not by me. A CONFIRMATORY suite admits mediocre code.
 * Scale that and Strata's reputation dies on first contact with a real user. The selftest must try to
 * BREAK the code, not confirm it works.
 *
 * Usage:
 *   node scripts/admit-recall.js                        # every verified recall
 *   node scripts/admit-recall.js recalls/api/pagination/v1
 *
 * Env:
 *   STRATA_TEST_NODE_PATH=<dir>   where third-party deps (pino, csv-parse, express) are installed
 *   STRATA_ADMIT_SKIP_BOOT=1      skip the slow composed-boot gate
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXTRA_NODE_PATH = process.env.STRATA_TEST_NODE_PATH || '';

const gate = (name, ok, detail) => ({ gate: name, ok, detail });

/**
 * Pull the ACTUAL error out of a node crash dump.
 *
 * `.pop()` on the stderr lines returns "Node.js v24.13.1" — the version banner — which tells you
 * nothing and hides the real cause. A diagnostic that reports the wrong thing is worse than none: it
 * sends you looking in the wrong place.
 */
function firstError(stderr) {
  const lines = (stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const real = lines.find((l) => /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|MISSING|FAILED|Cannot find)/.test(l));
  if (real) return real;
  // A missing dependency surfaces as "Cannot find module 'pino'" a line or two down.
  const mod = lines.find((l) => /Cannot find module/.test(l));
  if (mod) return mod;
  return lines.find((l) => !/^Node\.js v/.test(l) && !/^\s*\^/.test(l)) || 'failed with no error message';
}

function loadRecall(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf-8'));
    return { dir, id: meta.id || path.basename(dir), meta };
  } catch {
    return null;
  }
}

const exportNames = (meta) =>
  (Array.isArray(meta.outputs) ? meta.outputs : []).map((o) => String(o).split('(')[0].trim());

// ── GATE 1 — it loads, and every export it CLAIMS exists at runtime ──────────
// A recall that advertises createLogger() but does not export it produces an assembly with a dangling
// name: the composed app dies at require time, and the session pays turns to discover the tool lied.
function checkExports(r) {
  const impl = path.join(r.dir, 'implementation.js');
  if (!fs.existsSync(impl)) return gate('exports', false, 'no implementation.js');

  const want = exportNames(r.meta);
  if (want.length === 0) return gate('exports', false, 'metadata declares no outputs');

  const probe =
    'const m = require(' + JSON.stringify(impl) + ');' +
    'const want = ' + JSON.stringify(want) + ';' +
    'const missing = want.filter(function (n) { return m[n] === undefined; });' +
    'if (missing.length) { console.error("MISSING: " + missing.join(", ")); process.exit(1); }';

  const res = spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf-8',
    env: Object.assign({}, process.env, { NODE_PATH: EXTRA_NODE_PATH }),
  });

  if (res.status !== 0) return gate('exports', false, firstError(res.stderr).slice(0, 120));
  return gate('exports', true, want.length + ' exports reachable');
}

// ── GATE 2 — the selftest passes, AND passes CONSISTENTLY ────────────────────
//
// It runs N times, not once. A suite that passes 3 runs and fails the 4th is FLAKY, and flaky is a
// defect in its own right even when the implementation is correct: it fails admissions at random, it
// makes every downstream composed-boot unreliable, and it poisons the benchmark. This exact hole let
// a rate-limiter test that asserted `retryAfterMs === 1000` against the REAL clock through gate 7 at
// 95/100 — mutation testing measures whether tests catch injected bugs, never whether they are stable.
// A benchmark session found it, fixed it, and cost us hours of misdiagnosis first.
//
// Determinism is also asserted: the assertion COUNT must be identical across runs. A suite whose count
// wanders is branching on wall-clock time or randomness somewhere, which is the same disease one step
// upstream.
function checkSelftest(r) {
  const st = path.join(r.dir, 'selftest.js');
  if (!fs.existsSync(st)) return gate('selftest', false, 'no selftest.js');

  const runner =
    '(async () => {' +
    '  const impl = require(' + JSON.stringify(path.join(r.dir, 'implementation.js')) + ');' +
    '  const suite = require(' + JSON.stringify(st) + ');' +
    '  let pass = 0; const fails = [];' +
    '  const assert = (c, m) => { if (c) pass++; else fails.push(m); };' +
    '  try { await suite.run(impl, assert); } catch (e) { fails.push("THREW: " + e.message); }' +
    '  if (fails.length) { console.error("FAILED: " + fails.slice(0, 3).join(" | ")); process.exit(1); }' +
    '  console.log(String(pass));' +
    '})();';

  const RUNS = Number(process.env.STRATA_SELFTEST_RUNS || 5);
  const counts = [];
  for (let i = 0; i < RUNS; i++) {
    const res = spawnSync(process.execPath, ['-e', runner], {
      encoding: 'utf-8',
      env: Object.assign({}, process.env, { NODE_PATH: EXTRA_NODE_PATH }),
      timeout: 60000,
    });
    if (res.status !== 0) {
      const flaked = counts.length > 0;   // it passed earlier and just failed → definitively flaky
      return gate('selftest', false,
        (flaked ? `FLAKY: passed ${counts.length}x then failed on run ${i + 1} — ` : '')
        + firstError(res.stderr).slice(0, 120));
    }
    counts.push(Number((res.stdout || '0').trim()));
  }

  const unique = [...new Set(counts)];
  if (unique.length > 1) {
    return gate('selftest', false,
      `assertion count is not deterministic across ${RUNS} runs (${unique.join(', ')}) — the suite branches on time or randomness`);
  }
  return gate('selftest', true, `${counts[0]} assertions, stable across ${RUNS} runs`);
}

// ── GATE 3 — is the selftest ADVERSARIAL, or merely confirmatory? ────────────
//
// This gate decides whether Strata ships scaffoldable code or "random code with tests". A suite that
// only walks the happy path admits exactly the bugs that already shipped in this library.
//
// We cannot check "did you think hard enough". We CAN check for the structural signatures of a suite
// that tries to break things: hostile/edge inputs, and assertions that something must NOT happen.
// A crude proxy, deliberately — it cannot prove a suite is good, but it catches one that never tries.
function checkAdversarial(r) {
  const st = path.join(r.dir, 'selftest.js');
  if (!fs.existsSync(st)) return gate('adversarial', false, 'no selftest.js');

  const src = fs.readFileSync(st, 'utf-8');
  const assertions = (src.match(/assert\s*\(/g) || []).length;

  const HOSTILE = /null|undefined|''|""|\[\]|\{\}|-1|NaN|Infinity|\\r\\n|\\n|malformed|invalid|empty|missing|hostile|attacker|evil|overflow|exceed|DROP TABLE|\.\.\/|garbage|stale|corrupt|999/i;
  const NEGATIVE = /not |never |must not|should not|rejected|refused|throws|does not|fails|=== null|=== undefined|=== false|\bfalse\b/i;

  const problems = [];
  if (assertions < 8) problems.push('only ' + assertions + ' assertions');
  if (!HOSTILE.test(src)) problems.push('no hostile/edge inputs');
  if (!NEGATIVE.test(src)) problems.push('no negative assertions — nothing is required to FAIL');

  if (problems.length) {
    return gate('adversarial', false, problems.join('; ') + ' — a confirmatory suite admits broken code');
  }
  return gate('adversarial', true, assertions + ' assertions, probes failure paths');
}

// ── GATE 4 — the compose metadata is valid ──────────────────────────────────
// A recall with no valid compose block cannot be scaffolded, so it cannot contribute to a composition,
// so it cannot deliver Strata's only proven value.
function checkCompose(r) {
  const c = r.meta.compose && r.meta.compose.server;
  if (!c) return gate('compose', false, 'no compose.server — cannot be scaffolded');

  const declared = new Set(exportNames(r.meta));
  const problems = [];
  const frags = [].concat(c.setup || [], c.middleware || [], c.errorHandlers || []);

  for (const f of frags) {
    if (typeof f.rank !== 'number') problems.push('fragment ' + (f.file || f.factory) + ' has no rank');
    const label = f.file || f.factory || '(unnamed fragment)';

    // A fragment must contribute SOMETHING: raw source, or a factory to register.
    if (!f.file && !f.factory) problems.push('fragment has neither `file` nor `factory`');
    if (f.file && !fs.existsSync(path.join(r.dir, f.file))) problems.push('missing fragment: ' + f.file);
    if (f.factory && !declared.has(f.factory)) {
      problems.push('factory "' + f.factory + '" is not a declared output');
    }

    if (f.when) {
      // A CONTROL CHARACTER in a `when` regex is always the JSON escaping bug: "\b" in JSON is a
      // BACKSPACE (0x08), not a regex word boundary — you need "\\b". It has bitten this repo twice,
      // and it fails SILENTLY: the regex compiles fine and simply never matches, so the fragment is
      // quietly dropped and nobody finds out until the feature is missing from the generated app.
      if (/[\x00-\x1f]/.test(f.when)) {
        problems.push('`when` on ' + label + ' contains a control character — you wrote "\\b" where JSON needs "\\\\b"');
      }
      try { new RegExp(f.when); } catch { problems.push('invalid `when` regex on ' + label); }
    }

    for (const imp of f.imports || []) {
      if (!declared.has(imp)) problems.push(label + ' imports "' + imp + '" which is not a declared output');
    }
  }

  if (c.routesFile && !fs.existsSync(path.join(r.dir, c.routesFile))) {
    problems.push('missing routesFile: ' + c.routesFile);
  }
  for (const imp of c.imports || []) {
    if (!declared.has(imp)) problems.push('compose imports "' + imp + '" which is not a declared output');
  }

  // A recall must CONTRIBUTE something, or it composes into nothing. Declaring `compose.server` with
  // no fragments and no routes is a recall that occupies a slot in the assembly and adds no code —
  // which still costs the session the tokens to read it.
  const contributes = frags.length + (c.routesFile ? 1 : 0);
  if (contributes === 0) problems.push('contributes nothing — no fragments, no routes');

  if (problems.length) return gate('compose', false, problems.slice(0, 3).join('; '));
  return gate('compose', true, contributes + ' contribution(s), ranks + imports valid');
}

// ── GATE 5 — no exported-name collisions with the recalls it composes beside ──
// Two recalls both exporting `sanitize` produce an assembly where one silently SHADOWS the other. The
// app boots. The tests pass. The behaviour is wrong. That is the quietest failure a composed system
// can have, so it gets its own gate.
function checkCollisions(r, others) {
  const mine = new Set(exportNames(r.meta));
  const clashes = [];

  for (const o of others) {
    if (o.id === r.id) continue;
    for (const name of exportNames(o.meta)) {
      if (mine.has(name)) clashes.push(name + ' (also in ' + o.id + ')');
    }
  }

  if (clashes.length) return gate('collisions', false, 'name collision: ' + clashes.slice(0, 3).join(', '));
  return gate('collisions', true, 'no name collisions');
}

// ── GATE 6 — it composes, the app BOOTS, and verify.js passes end to end ─────
// The only gate that proves the recall works IN A COMPOSITION. Everything above can pass while the
// composed app dies on boot — exactly what happened when a setupFile -> setup[] migration silently
// emitted an EMPTY setup block, leaving `logger` undefined in the middleware that referenced it.
function checkComposedBoot(r) {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'src', 'mcp-server.js'))) {
    return gate('composed-boot', false, 'dist not built — run tsc first');
  }
  const harness = path.join(ROOT, 'scripts', 'compose-and-verify.js');
  if (!fs.existsSync(harness)) return gate('composed-boot', false, 'compose-and-verify.js missing');

  const res = spawnSync(process.execPath, [harness, r.id], {
    encoding: 'utf-8',
    timeout: 180000,
    env: Object.assign({}, process.env, { NODE_PATH: EXTRA_NODE_PATH }),
  });

  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const last = out.split('\n').filter(Boolean).pop() || '';

  if (res.status !== 0) return gate('composed-boot', false, last.slice(0, 140));
  return gate('composed-boot', true, last.slice(0, 100));
}

// ── Runner ───────────────────────────────────────────────────────────────────

function verifiedRecallDirs() {
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'verified-recalls.json'), 'utf-8'));
  return Object.values(allow.paths || {}).map((p) => path.join(ROOT, String(p)));
}

(function main() {
  const arg = process.argv[2];
  const dirs = arg ? [path.resolve(arg)] : verifiedRecallDirs();

  const all = dirs.map(loadRecall).filter(Boolean);
  if (all.length === 0) {
    console.error('no recalls found');
    process.exit(1);
  }

  const skipBoot = process.env.STRATA_ADMIT_SKIP_BOOT === '1';
  let admitted = 0;
  const rejected = [];

  for (const r of all) {
    const gates = [
      checkExports(r),
      checkSelftest(r),
      checkAdversarial(r),
      checkCompose(r),
      checkCollisions(r, all),
    ];
    if (!skipBoot) gates.push(checkComposedBoot(r));

    const failed = gates.filter((g) => !g.ok);
    console.log((failed.length === 0 ? 'ADMIT ' : 'REJECT') + ' ' + r.id);
    for (const g of gates) {
      console.log('         ' + (g.ok ? 'ok  ' : 'FAIL') + '  ' + g.gate.padEnd(14) + ' ' + g.detail);
    }
    console.log('');

    if (failed.length === 0) admitted++;
    else for (const f of failed) rejected.push({ id: r.id, gate: f.gate, detail: f.detail });
  }

  console.log('─'.repeat(78));
  console.log(admitted + '/' + all.length + ' admitted');

  if (rejected.length) {
    console.log('');
    console.log('REJECTED — discard and regenerate. Do NOT hand-patch: the moment we hand-fix generated');
    console.log('recalls we are back to craft, and coverage stops scaling.');
    for (const x of rejected) console.log('  ' + x.id + '  [' + x.gate + ']  ' + x.detail);
  }

  process.exit(rejected.length ? 1 : 0);
})();
