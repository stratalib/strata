#!/usr/bin/env node
'use strict';
/**
 * AGENT-SESSION BENCHMARK — the instrument the claims actually need.
 *
 * The old harness (benchmark/run.ts) drives the Anthropic API directly. That measures API calls, and
 * our whole thesis is about TURNS IN AN AGENT SESSION — where the model boots servers, curls
 * endpoints, reads files, and re-pays the entire context on every turn. A scripted API loop has no
 * such turns, so it cannot produce the number we want to publish.
 *
 * This drives the real coding agent headlessly, once per run, and reads the turn count and token
 * usage out of its own report.
 *
 * Design rules, all from benchmark/PLAN.md and all pre-registered:
 *   - identical prompt in both arms; the ONLY difference is whether Strata's MCP server is present
 *   - fixture reset with `git checkout` before every run — never rm -rf on a shared directory
 *   - correctness and adoption are recorded per run, because a cheaper WRONG answer is not a win
 *   - raw transcripts are kept, so any number here can be re-derived rather than trusted
 *
 * Usage:
 *   node benchmark/agent-bench.js --smoke                 # 1 task, 1 run per arm
 *   node benchmark/agent-bench.js --task catalog --n 3
 *   node benchmark/agent-bench.js --all --n 3
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// --out lets several batch invocations write into ONE folder so the report can combine them. A batch
// run avoids the rate limit by doing 2-3 tasks at a time with pauses between, but all batches must land
// in the same place. Falls back to a fresh timestamp folder when not given.
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  const name = i !== -1 ? process.argv[i + 1] : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  return path.join(__dirname, 'runs', name);
})();
const SERVER = path.join(ROOT, 'dist', 'src', 'mcp-server.js');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(f);

/**
 * WHICH STRATA BUILT THIS RESULT.
 *
 * Without it, every Strata-side fix invalidates every prior Strata-arm run, because nothing on disk
 * says which build produced which number — so the only safe move is to throw the batch away and
 * re-run. That is an analysis-retry loop with no exit: fix, invalidate, re-run, find something else,
 * repeat, never ship.
 *
 * Stamping the build breaks it. A run stays permanently ATTRIBUTABLE instead of permanently suspect:
 * compare within a build for free, compare across builds deliberately and with the difference visible.
 * Small upgrades then get validated by a targeted probe against the check that changed, and the full
 * battery runs ONCE, on a frozen build, as the thing that actually ships.
 *
 * Covers the engine and the recall set, because selection output depends on both — the same pair the
 * L1 cache key learned to hash after being poisoned three times.
 */
const strataBuildId = (() => {
  try {
    const h = require('crypto').createHash('sha256');
    h.update(fs.readFileSync(path.join(ROOT, 'dist', 'src', 'mcp-server.js')));
    try { h.update(fs.readFileSync(path.join(ROOT, 'cache', 'verified-recalls.json'))); }
    catch { h.update('no-allowlist'); }
    return h.digest('hex').slice(0, 12);
  } catch {
    return 'unbuilt';        // baseline arms never load it; recorded honestly rather than faked
  }
})();

/**
 * The tasks. Each names the fixture it runs against and the mode it belongs to.
 *
 * `retry` is here deliberately: we expect Strata to LOSE on it, and publishing that is the most
 * credible thing on the site.
 */
const TASKS = {
  catalog: {
    mode: 'brownfield', fixture: 'catalog-service',
    prompt: 'Add pagination to the products list endpoint, rate limit the API per IP, and log every request '
      + 'with an id I can trace. Make sure it runs.',
  },
  auth: {
    mode: 'brownfield', fixture: 'catalog-service',
    prompt: 'Add signup and login with email and password, keep people signed in with a session cookie, and '
      + 'let them reset a forgotten password. Make sure it runs.',
  },
  rbac: {
    mode: 'brownfield', fixture: 'catalog-service',
    prompt: 'Only admins should be able to edit or delete products - everyone else should be refused. Keep a '
      + 'record of who changed what and when, and let me page through it. Make sure it runs.',
  },
  idempotency: {
    mode: 'brownfield', fixture: 'catalog-service',
    prompt: 'If a client retries the same order request it should not create two orders. Validate the request '
      + 'body properly and log each attempt. Make sure it runs.',
  },
  // TASK B for STRATA-GUIDE.md Part 2's two-task-same-project experiment (§12) — deliberately touches the
  // SAME `order` domain `idempotency` creates, from a DIFFERENT angle (status transitions + lookup, not
  // creation), so it needs the domain's fields/rules/operations without re-doing idempotency's own work.
  // Run via `run-twophase.js task ordercancel --seed <idempotency's captured.snapshot>` and compare
  // against its OWN cold baseline (`task ordercancel` with no --seed) — never against idempotency's cost.
  ordercancel: {
    mode: 'brownfield', fixture: 'catalog-service', tier: 'domain-capture-test',
    prompt: 'Let a customer cancel a pending order, and let them see their past orders. A cancelled order '
      + 'should not be payable afterward. Make sure it runs.',
  },
  publicapi: {
    mode: 'greenfield', fixture: null,
    prompt: 'Build me a small Express API for products with pagination, per-IP rate limiting, request logging, '
      + 'and responses that do not leak internal fields. Make sure it runs.',
  },
  search: {
    mode: 'greenfield', fixture: null,
    prompt: 'Build an Express endpoint that searches products by keyword with filters and pagination, rejects '
      + 'bad input with a clear error, and caches results. Make sure it runs.',
  },
  // THE KITCHEN SINK. Every capability our current library composes, asked for in one go.
  //
  // The cost model (STATUS.md) says Strata wins when baseline minus glue exceeds fixed overhead plus
  // rework. The per-session
  // overhead is paid ONCE no matter how big the task, so the bigger the covered surface, the more of it
  // is amortised. If that is right, this is where the win is largest — and 'ask for the whole feature
  // at once' becomes advice we can actually give users.
  megabuild: {
    mode: 'brownfield', fixture: 'catalog-service',
    prompt: 'I need this service production-ready. Add signup and login with sessions and password reset. '
      + 'Only admins should be able to change products, everyone else refused, and keep an audit trail of '
      + 'who changed what that I can page through. Validate every request body properly. Rate limit the API '
      + 'per IP. Log every request with an id I can trace. Paginate the product list. Make sure responses '
      + 'never leak internal fields. Make sure it all runs.'
      + " Work autonomously and make sensible choices without checking in - I am not available to answer questions. If something is ambiguous, pick the option you would defend and note it at the end.",
  },
  retry: {
    mode: 'greenfield', fixture: null,
    // The known loss. One small helper, well under the ~45-turn break-even where Strata stops paying off.
    prompt: 'Write a helper that calls a flaky API and retries with backoff when it fails.',
  },

  // ── JUNE REPRODUCTION — the exact pinned prompts that scored −47% (jwt) and near-parity (reset).
  //    Greenfield 'build a X system', package-heavy, in-memory. The old scaffold-format recalls deliver
  //    these via buildScaffold (a path dep-delivery never touched), so this reproduces June's delivery.
  jwtjune: { mode: 'greenfield', fixture: null, tier: 'hard',
    prompt: 'Build a user authentication system in Node.js + Express (plain JavaScript, no TypeScript): signup and login endpoints, JWT access + refresh tokens (jsonwebtoken package), hashed passwords, and protected-route middleware. Use an in-memory store for users (no database/ORM). Return the refresh token in the JSON response body, not a cookie.' },
  resetjune: { mode: 'greenfield', fixture: null, tier: 'hard',
    prompt: 'Build a password reset flow in Node.js + Express (plain JavaScript, no TypeScript): forgot-password request that emails a reset link via Nodemailer/SMTP, and a reset-confirmation endpoint that sets a new hashed password. Use an in-memory store for reset tokens and users (no database/ORM).' },

  stripejune: { mode: 'greenfield', fixture: null, tier: 'hard',
    prompt: 'Build a payment processing system in Node.js + Express (plain JavaScript, no TypeScript): Stripe webhooks with signature verification, email confirmation on purchase via Nodemailer/SMTP, and a background job (BullMQ + Redis) that generates a PDF receipt (PDFKit) and emails it.' },

  // ── HARD-CAPABILITY tasks — where the model would otherwise write insecure or wrong code, and where
  //    Strata's verified/hardened recalls should actually pay off. This is the cohort the thesis lives in.
  oauth: {
    mode: 'brownfield', fixture: 'catalog-service', tier: 'hard',
    prompt: 'Add "sign in with Google" using OAuth. When someone comes back from Google, log them in and '
      + 'keep them signed in. Make it secure - I do not want CSRF or code-interception problems. Make sure it runs.',
  },
  securepw: {
    mode: 'brownfield', fixture: 'catalog-service', tier: 'hard',
    prompt: 'Add signup and login with email and password. Hash the passwords properly, do not leak whether '
      + 'an email exists, and let people reset a forgotten password securely. Make sure it runs.',
  },
  export: {
    mode: 'brownfield', fixture: 'catalog-service', tier: 'commodity',
    prompt: 'Add an endpoint that exports all products as CSV or JSON without loading everything into memory '
      + 'at once. Make sure it runs.',
  },
};

// Which tasks stress the "hard capability" hypothesis vs commodity plumbing.
const TIER = {
  securepw: 'hard', auth: 'hard', oauth: 'hard', rbac: 'hard', idempotency: 'hard',
  catalog: 'commodity', search: 'commodity', publicapi: 'commodity', export: 'commodity',
  validation: 'commodity', retry: 'commodity', megabuild: 'kitchen-sink',
};

/**
 * On Windows `claude` is a .cmd shim, and since CVE-2024-27980 Node refuses to spawn one directly —
 * it fails with EINVAL and NO output at all, which looks exactly like "the agent produced nothing".
 * shell:true is required there. Arguments are passed via a temp prompt FILE rather than the command
 * line, because a multi-line task prompt containing quotes cannot survive shell concatenation intact
 * — and a silently mangled prompt would corrupt every measurement without ever looking wrong.
 */
function sh(cmd, args, opts) {
  const base = Object.assign({ encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }, opts || {});
  if (process.platform !== 'win32') return spawnSync(cmd, args, base);

  const quoted = args.map(a => (/^[\w.@/:\\-]+$/.test(a) ? a : '"' + String(a).replace(/(["\\])/g, '\\$1') + '"'));
  return spawnSync(`${cmd} ${quoted.join(' ')}`, Object.assign({ shell: true }, base));
}

/**
 * Prepare a clean working directory for one run.
 *
 * Brownfield copies the committed fixture; greenfield starts empty. Either way each run begins from an
 * identical tree — a fixture that drifts between runs makes the two arms incomparable, and the drift
 * is invisible in the results.
 */
function prepareDir(task, arm, taskName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  if (task.fixture) {
    const src = path.join(ROOT, 'benchmark', 'fixtures', task.fixture);
    if (!fs.existsSync(src)) throw new Error('fixture not found: ' + src);
    fs.cpSync(src, dir, { recursive: true });
    // node_modules is not part of the fixture's identity and copying it is slow; the agent installs
    // what it needs, and that install is part of what we are measuring.
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  } else {
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'bench-greenfield', version: '1.0.0', private: true }, null, 2));
  }
  if (arm === 'preinject') injectPreCommitted(dir, taskName);
  return dir;
}

/**
 * THE PRE-INJECTION ARM.
 *
 * Hypothesis: the audit that drives Strata's cost overrun is triggered by PROVENANCE, not by the code.
 * A model that watches a tool hand it an implementation reads that implementation (2.2× the Read calls
 * of baseline, 12–14k tokens, early, re-billed every remaining turn). A model that opens a repo and
 * finds the same bytes already committed has no delivery event to react to.
 *
 * So this arm gives the model the SAME implementation the Strata arm was given — byte-for-byte, taken
 * from that task's own archived Strata run — but as ordinary project source that was simply already
 * there. No MCP server, no tool call, no strata/ directory, no verifier.
 *
 * Three things must be true for the comparison to mean anything:
 *
 *   1. The bytes are the real delivery, not a paraphrase. Sourced from the archived tree.
 *   2. NOTHING identifies it as generated. The delivered file opens with a five-line banner naming
 *      the recalls and pointing at `strata/verify.js` — that banner IS the provenance signal under
 *      test, so it is stripped and replaced with an ordinary project header. Verified: every mention
 *      of "strata"/"recall" in these files lives in that banner and nowhere else.
 *   3. It has to actually resolve. The file requires `pino`, which the fixture does not declare, so
 *      the dependency is added — a human who committed this file would have added it too.
 */
function injectPreCommitted(dir, taskName) {
  const srcLib = path.join(ROOT, 'benchmark', 'runs', 'exp-quality', 'trees',
    `${taskName}-strata-haiku-1`, 'strata', 'lib.js');
  if (!fs.existsSync(srcLib)) {
    throw new Error(`preinject: no archived delivery for ${taskName} at ${srcLib}`);
  }

  let code = fs.readFileSync(srcLib, 'utf-8');

  // Strip the generated banner: every leading comment line before the first line of real code.
  const lines = code.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim().startsWith('//') || lines[i].trim() === '')) i++;
  code = lines.slice(i).join('\n');

  // Two deliveries also mention the vocabulary incidentally inside ordinary doc comments — "a sibling
  // recall's test once asserted…", "the recall's own tests run anywhere". Those are prose, not banners,
  // but they still identify where the file came from, so the words are neutralised. Only comments are
  // touched: check-preinject.js asserts the non-comment lines are byte-identical to the delivery.
  code = code.replace(/\brecalls\b/gi, 'modules').replace(/\brecall\b/gi, 'module')
             .replace(/\bStrata\b/g, 'toolkit').replace(/\bstrata\b/g, 'toolkit');

  if (/strata|recall/i.test(code)) {
    // Fail loudly rather than run an arm whose "pre-existing" file still advertises where it came from.
    throw new Error('preinject: provenance leaked past the banner — aborting rather than measuring a broken control');
  }

  const header = '// Shared HTTP helpers for this service.\n' +
                 '// Logging, list-query parsing/pagination, caching and rate limiting.\n\n';
  const libDir = path.join(dir, 'src', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'toolkit.js'), header + code);

  // Declare what the file needs, as a committing human would have.
  const pkgPath = path.join(dir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.dependencies = pkg.dependencies || {};
    if (/require\('pino'\)/.test(code) && !pkg.dependencies.pino) pkg.dependencies.pino = '^9.0.0';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  } catch { /* greenfield package.json is ours and always parses; ignore anything exotic */ }

  // Document it the way the fixture documents its other modules — discoverability is part of the
  // hypothesis, and a file nobody can find tests nothing.
  const readme = path.join(dir, 'README.md');
  const note = '- Shared HTTP helpers live in `src/lib/toolkit.js` — structured logging, list-query' +
               ' parsing with pagination, caching and rate limiting. Already unit-tested; prefer these' +
               ' over writing your own.\n';
  if (fs.existsSync(readme)) fs.appendFileSync(readme, note);
  else fs.writeFileSync(readme, '# service\n\n' + note);
}

/** Write the MCP config for the Strata arm. Its absence IS the baseline arm. */
function writeMcpConfig(dir) {
  // Pass the delivery-mode flag INTO the spawned MCP server via its own env block — the agent does not
  // reliably forward the harness's process env to the servers it launches, so the config must carry it.
  // Default '1' now that dependency delivery is the engine default and the shipping behaviour — the
  // benchmark must test what users get, not the retired source-delivery path. Override with =0 to A/B.
  // STRATA_MODE must be forwarded for the same reason as the flag above: Claude Code does not pass the
  // harness's env to MCP servers it launches, so anything not written into this file is lost.
  //
  // It is load-bearing for any experiment on a recall that is not yet on the hub. Strata defaults to
  // HUB mode, so a benchmark run composes against the deployed 21-recall library no matter what the
  // local checkout contains. Fifteen stripejune runs were collected that way — measuring the hub while
  // the local library had just gained the Stripe recall those runs were supposed to test. Nothing in
  // the transcripts distinguished the two, and the result read as "Strata does not help on payments".
  const cfg = { mcpServers: { strata: { command: 'node', args: [SERVER],
    env: {
      STRATA_DELIVER_AS_DEP: process.env.STRATA_DELIVER_AS_DEP || '1',
      ...(process.env.STRATA_MODE ? { STRATA_MODE: process.env.STRATA_MODE } : {}),
    } } } };
  const p = path.join(dir, '.mcp.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/** One agent session. Returns the measured run, or a record explaining why it failed. */
/**
 * `opts` exists for the cost-to-working driver (run-until-working.js), which needs to run a SECOND
 * session against the SAME tree the first one left behind:
 *
 *   dir        — reuse an existing working directory instead of preparing a fresh one
 *   prompt     — replace the task prompt (attempt 2+ reports symptoms instead of restating the task)
 *   stemSuffix — keep each attempt's record and log separate rather than overwriting attempt 1
 *
 * Absent all three this behaves exactly as before, so the published battery is unaffected.
 */
function runOnce(taskName, task, arm, runIndex, opts = {}) {
  const reuse = !!opts.dir;
  const dir = opts.dir || prepareDir(task, arm, taskName);
  if (arm === 'strata' && !reuse) writeMcpConfig(dir);

  // strata.guide.json — dropped into the STRATA arm only (baseline stays a clean control; a baseline
  // agent would just read a file it doesn't understand). Simulates the steady state where the guide has
  // already been authored + reviewed. Committed OUTSIDE the fixture (fixtures are measurement
  // instruments — never edit them). Toggle off with STRATA_GUIDE=0 to A/B the guide's effect.
  if (arm === 'strata' && !reuse && task.fixture && process.env.STRATA_GUIDE !== '0') {
    // --guide overrides the default `${fixture}.guide.json` with an arbitrary file — e.g. a
    // proactively hand-authored guide that specifies a domain BEFORE any task has ever built it
    // (STRATA-GUIDE.md Part 2, the untested "Case B path 2" lever). Without this flag every task
    // sharing a fixture is stuck sharing that fixture's ONE default guide — overwriting the shared file
    // to test a variant would silently corrupt every other benchmark that fixture's default guide backs.
    const guideOverride = arg('--guide', '');
    const guideSrc = guideOverride
      ? path.join(ROOT, guideOverride)
      : path.join(ROOT, 'benchmark', 'fixtures-guides', `${task.fixture}.guide.json`);
    if (fs.existsSync(guideSrc)) {
      fs.copyFileSync(guideSrc, path.join(dir, 'strata.guide.json'));
      console.log(`  [guide] dropped ${path.relative(ROOT, guideSrc)} into strata arm`);
    } else if (guideOverride) {
      // An explicit --guide that doesn't resolve is almost certainly a typo'd path, not "no guide for
      // this task" (the default case, which silently no-ops) — fail loudly instead of running a
      // "strata" arm that got no guide and quietly looks like the ungrounded baseline.
      throw new Error(`--guide ${guideOverride} does not exist (resolved: ${guideSrc})`);
    }
  }

  // Headless agents have nobody to ask.
  //
  // Both arms of megabuild stopped mid-task to ask whether the Prisma schema or the in-memory repo was
  // the real data source — correct behaviour with a human present, fatal in a benchmark, where the turn
  // just ends and the run scores as "cheap". Appended here rather than baked into each prompt so it is
  // provably identical in both arms.
  // TERSENESS, added 2026-07-27 after a Haiku stripe run lost on cost for a reason that had nothing to
  // do with Strata: both arms wrote ~10 markdown files each (README/ARCHITECTURE/DEPLOYMENT/DECISIONS/
  // COMPONENTS/SUMMARY/INDEX/...), and the STRATA arm's docs were ~28% bigger per file despite having
  // 88% less real code to describe (8,448 vs 19,177 bytes of actual .js) — total output tokens ended up
  // HIGHER for strata than baseline, even though strata wrote one file and baseline wrote ten. This is a
  // model-verbosity artifact, not an audit or code-quality effect (verified: reads/edits were both LOW in
  // that run — it never even ran the free verify.js check). Appended here, not just in Strata's own
  // delivery prompt ("Be terse — code, not prose." already lives there and evidently was not enough on
  // its own, since strata's arm still produced the same doc sprawl) — so it reaches BOTH arms identically
  // and the comparison stays fair. Same single-line discipline as AUTONOMY itself: a raw newline here
  // breaks sh()'s Windows shell-quoting (see run-twophase.js's ANALYZE_PROMPT comment).
  const TERSE = ' Do not create documentation files (README, ARCHITECTURE, DEPLOYMENT, DECISIONS, '
    + 'SUMMARY, QUICKSTART, COMPONENTS, or similar) unless the task explicitly asks for documentation - '
    + 'a short code comment where genuinely non-obvious is enough. Do not write example or demo scripts '
    + 'unless asked. Spend your effort on working, tested code, not on narrating what you built.';

  const AUTONOMY = ' Work autonomously and make sensible choices without checking in - I am not '
    + 'available to answer questions. If something is ambiguous, pick the option you would defend and '
    + 'note it at the end.' + TERSE;

  // ON BY DEFAULT as of 2026-07-31 — this graduated from an A/B experiment to a load-bearing part of
  // the harness. The 2026-07-30 finding: 4 of 5 strata-arm runs never called strata_use at all
  // (ToolSearch just never fired), independent of greenfield/brownfield — vs 2/2 WITH this nudge.
  // Un-nudged strata-arm data is mostly noise (a second baseline by omission), not a weaker signal, so
  // defaulting it off would mean most of this harness's spend buys nothing. Real users get this nudge
  // for free from their own CLAUDE.md ("Strata exposes exactly ONE MCP tool: strata_use..."); the
  // benchmark fixture deliberately has no CLAUDE.md, so without this the harness measures a colder
  // start than any real installed project ever sees. Mirrors that real doc text verbatim. Set
  // STRATA_NUDGE=0 to run the un-nudged control deliberately (e.g. to keep re-confirming the effect
  // itself) — never omit the flag by accident, since silence now means ON, not off.
  const NUDGE = (process.env.STRATA_NUDGE !== '0' && arm === 'strata')
    ? ' This project uses Strata, an MCP tool that exposes exactly one tool: strata_use. Call it ONCE, '
      + 'at the start of a task that needs meaningful new code (a feature, a module, a new file, a bug '
      + 'fix requiring substantial new logic) - it composes verified, pre-built modules into your '
      + 'project instead of you writing them by hand. Skip it for typos, renames, or trivial edits.'
    : '';

  // The model matters more than any other variable. Strata's value is INVERSELY related to model
  // capability — a frontier model (Fable) writes infra cheaply and correctly itself, so composing +
  // integrating recalls is pure overhead; a mainstream agent model (Sonnet, what most Claude Code
  // users actually run) writes it slower and audits it less, which is exactly where Strata pays off.
  // Benchmark the model your USERS run, not the most capable one available.
  const model = arg('--model', '');

  const args = [
    '-p', (opts.prompt || task.prompt) + AUTONOMY + NUDGE,
    ...(model ? ['--model', model] : []),
    // stream-json emits every tool call, not just the final message. With plain `json` we only see the
    // closing summary, so "did it call strata_use?" is unanswerable — and I answered it wrongly once by
    // treating a silent summary as proof the tool went unused.
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', '120',
    '--dangerously-skip-permissions',   // unattended; the run happens in a throwaway temp dir
    // THE CRITICAL FLAG. Without it Claude Code also loads the user's GLOBAL MCP servers — and this
    // machine has Strata installed globally, so the "baseline" arm had Strata available and used it.
    // Both arms were Strata. Every number from that harness measured nothing.
    '--strict-mcp-config',
  ];
  // --strict-mcp-config means ONLY this file's servers load. The baseline passes an empty set, so its
  // isolation is enforced rather than assumed.
  const mcpPath = path.join(dir, arm === 'strata' ? '.mcp.json' : '.mcp-empty.json');
  if (arm !== 'strata') fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2));
  args.push('--mcp-config', mcpPath);

  // RETRY on a rate-limited / synthetic result. Every batch this week died because a throttled session
  // returns model "<synthetic>" or no report at all — which looks like a fast cheap run and silently
  // corrupts the data. Detect it and wait it out rather than recording a lie. Sleeping between attempts
  // lets the limit window pass.
  const t0 = Date.now();
  let raw = '', report = null, strataCalls = 0, deliveredRecalls = [], synthetic = false, exitStatus = 1;
  const MAX_TRY = 4;
  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    const r = sh('claude', args, { cwd: dir, timeout: 45 * 60 * 1000 });
    exitStatus = r.status;
    raw = (r.stdout || '') + (r.stderr || '');
    report = null; strataCalls = 0; deliveredRecalls = []; synthetic = false;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let ev; try { ev = JSON.parse(t); } catch { continue; }
      if (ev.type === 'result') report = ev;
      if (ev?.message?.model === '<synthetic>') synthetic = true;
      const content = ev?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_use' && /strata_use/.test(String(b.name || ''))) strataCalls++;
          if (b && b.type === 'tool_result') {
            const s = typeof b.content === 'string' ? b.content
              : (Array.isArray(b.content) ? b.content.map(x => x.text || '').join('') : '');
            if (/Exports available/.test(s)) {
              for (const m of s.matchAll(/^\s{2}([a-z][a-z0-9]*\.[a-z0-9-]+\.v\d+)/gm)) deliveredRecalls.push(m[1]);
            }
          }
        }
      }
    }
    const rateLimited = synthetic || !report
      || (report && report.is_error && /rate|limit|overloaded|unavailable/i.test(JSON.stringify(report)));
    // A strata-arm run that never called strata_use is not a slower measurement, it is a non-run — a
    // second baseline by omission (2026-07-30/31 finding: un-nudged, this was 4/5; with the nudge
    // above, still not guaranteed). Retrying it here, automatically, is strictly better than recording
    // it and hoping whoever reads the artifact remembers to check strataCalls by hand — that discipline
    // was re-derived from scratch three separate times this week alone.
    const invalidStrataArm = arm === 'strata' && strataCalls === 0 && !synthetic && !!report;
    if (!rateLimited && !invalidStrataArm) break;
    if (attempt < MAX_TRY) {
      // Short waits (30s) instead of minutes: a long blocking Atomics.wait is exactly when a background
      // job gets torn down, so every retry-heavy run vanished with no artifact. Better to fail fast and
      // record the synthetic result than to sit in a sleep that gets the process killed.
      const waitMs = 30000;
      const why = rateLimited ? 'rate-limited' : 'strata_use never called';
      process.stdout.write(`(${why}, retry ${attempt + 1}/${MAX_TRY} after ${waitMs / 1000}s) `);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);   // real blocking sleep, no CPU peg
    }
  }
  const wallMs = Date.now() - t0;
  deliveredRecalls = [...new Set(deliveredRecalls)];

  // What the composed verifier concluded, pulled from the transcript for the artifact folder.
  const vm = raw.match(/(\d+)\/(\d+) checks passed|(\d+) passed, (\d+) FAILED/);
  const verifyResult = vm ? vm[0] : (fs.existsSync(path.join(dir, 'strata', 'verify.js')) ? 'verify.js present, result not captured' : 'no verify.js');

  // AUTOMATIC FORENSICS — this is the discipline that took a manual transcript dig every single time
  // this week (the mountWiring bug, the tool-discovery finding, the audit-inversion pattern all started
  // as "why is this expensive?" followed by 20 minutes of grep). Doing the first pass here means the
  // artifact JSON already says what happened, and a human only has to dig further when this doesn't
  // explain it.
  const diagnosis = {
    toolSearchFired: /"name"\s*:\s*"ToolSearch"/.test(raw),
    strataUseFired: strataCalls > 0,
    hubComposed: /\[strata\] composed on hub/.test(raw),
    hubUnreachableFellBackLocal: /hub composition failed, composing locally instead|hub unreachable/i.test(raw),
    hubDeclined: /Strata is declining this task|No verified Strata recall covers/.test(raw) && /\[strata\] Running in hub mode/.test(raw),
    verifyRan: /npm install && node strata\/verify\.js|checks passed/i.test(raw),
    // Known historical bug signatures — kept as an allowlist, not a guess, so a NEW failure mode still
    // shows up as "uncategorized" rather than silently matching the wrong known bug.
    bodyParserBugLanguage: /req\.body is undefined|before express\.json|runs before.*express\.json/i.test(raw),
  };

  const usage = (report && (report.usage || (report.modelUsage && Object.values(report.modelUsage)[0]))) || {};
  const run = {
    task: taskName,
    mode: task.mode,
    arm,
    run: runIndex,
    // WHICH MODEL PRODUCED THIS NUMBER. Absent, and a cost figure means nothing: haiku and sonnet
    // differ by ~6x on the same task, so an un-labelled artifact cannot be compared with anything.
    // This field was missing entirely, and the omission produced a fabricated headline — see the
    // filename comment below.
    model: model || 'default',
    // Only meaningful for the strata arm; recorded on baselines too so a batch can be checked for
    // having been produced by one build without special-casing which rows to look at.
    strataBuild: arm === 'strata' ? strataBuildId : null,
    ok: exitStatus === 0 && !!report,
    turns: report ? (report.num_turns ?? null) : null,
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? null,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    costUsd: report ? (report.total_cost_usd ?? null) : null,
    wallMs,
    dir,
    // Recorded, NOT judged here. Correctness and adoption need a look at the tree; the analysis step
    // reads these back. Auto-scoring them would be the easiest place to fool ourselves.
    // Recorded as a first-class field: a Strata arm where the tool never fired is not a slower Strata,
    // it is a second baseline, and it must never be averaged in as though it were a measurement.
    strataCalls,
    // Only the strata arm requires the tool to have fired. EVERY other arm — baseline, preinject —
    // requires that it did NOT. The old rule tested `arm === 'baseline'`, so any third arm was
    // silently required to call strata_use and could never be valid.
    armValid: arm === 'strata' ? strataCalls > 0 : strataCalls === 0,
    synthetic,
    deliveredRecalls,
    verifyResult,
    diagnosis,
    finalSummary: report ? String(report.result || '').slice(0, 2000) : '',
    verifyPresent: fs.existsSync(path.join(dir, 'strata', 'verify.js')),
    // A run that added fewer than 2 files did not attempt the task. Recorded, and excluded from the
    // summary — otherwise "cheapest" rewards whichever arm gave up soonest.
    work: measureWork(dir, task),
    fileCount: countFiles(dir),
  };

  fs.mkdirSync(OUT, { recursive: true });

  // THE MODEL IS PART OF A RUN'S IDENTITY, so it is part of the filename.
  //
  // It was `${taskName}-${arm}-${runIndex}`, which is the same string for haiku and sonnet. The launch
  // battery runs `catalog baseline haiku` and `catalog baseline sonnet` — the second silently
  // overwrote the first, and since `model` was not recorded inside the JSON either, nothing on disk
  // showed which model had survived.
  //
  // What that produced, on 2026-07-31: the analyzer paired a haiku STRATA run ($0.192) against what
  // was left in the baseline slot — the SONNET baseline ($0.919) — and reported "costDeltaPct: -79,
  // verdict: WIN". A 79% cost saving that is entirely the price difference between two models, ready
  // to be published on a launch page as evidence. No step in the pipeline could have caught it,
  // because by then the haiku baseline no longer existed.
  //
  // A measurement that silently overwrites another measurement is worse than a missing one.
  const stem = `${taskName}-${arm}-${model || 'default'}-${runIndex}${opts.stemSuffix || ''}`;
  fs.writeFileSync(path.join(OUT, stem + '.json'), JSON.stringify(run, null, 2));
  // The raw transcript is kept so every number above can be re-derived instead of trusted.
  fs.writeFileSync(path.join(OUT, stem + '.log'), raw.slice(0, 4 * 1024 * 1024));
  return run;
}


/**
 * Did the run actually BUILD anything?
 *
 * A session that writes one file and stops is not a cheap success, it is a non-attempt — and it will
 * outscore a real implementation on every cost metric if nothing checks. This is deliberately crude
 * (files added, and whether the entry point grew): it cannot confirm the feature is correct, only that
 * work happened. Correctness still needs a human, per PLAN.md.
 */
function measureWork(dir, task) {
  const baseline = task.fixture ? 7 : 1;   // files the fixture ships with
  let entryBytes = 0;
  for (const rel of ['src/server.js', 'server.js', 'index.js']) {
    try { entryBytes = Math.max(entryBytes, fs.statSync(path.join(dir, rel)).size); } catch { /* absent */ }
  }
  const added = countFiles(dir) - baseline;
  return { filesAdded: added, entryBytes, attempted: added >= 2 };
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return n;
}

// A require() of this file must NEVER launch benchmark runs. It already did once: a one-line
// `node -e "require(...)"` probe kicked off real agent sessions and spent quota nobody asked for.
// Same trap as recall-factory.js — a file that is both a program and a library has to know which it is.
if (require.main !== module) {
  // Additive only — reused by run-twophase.js so the analyze/task sessions spawn `claude` with the
  // EXACT same trusted invocation (flags, shell-quoting, MCP isolation) as every other benchmark run,
  // instead of a second hand-rolled copy that could silently drift from what this file actually does.
  module.exports = { TASKS, runOnce, OUT, ROOT, SERVER, sh, prepareDir, writeMcpConfig, measureWork, countFiles, arg };
  return;
}

// A single run, executed in a child process so the pool can hold several in flight.
if (process.env.BENCH_CHILD) {
  const [taskName, arm, runIndex] = process.env.BENCH_CHILD.split('|');
  const out = runOnce(taskName, TASKS[taskName], arm, Number(runIndex));
  process.stdout.write('\n__RESULT__' + JSON.stringify(out) + '\n');
  process.exit(0);
}

(async function main() {
  const { spawn } = require('child_process');
  const n = Number(arg('--n', 3));
  const CONCURRENCY = Number(arg('--concurrency', 3));

  let names;
  if (has('--smoke')) names = ['retry'];
  else if (has('--all')) names = Object.keys(TASKS);
  else names = String(arg('--task', 'catalog')).split(',').map(x => x.trim()).filter(Boolean);

  const runsPerArm = has('--smoke') ? 1 : n;
  const bad = names.filter(t => !TASKS[t]);
  if (bad.length) { console.error('unknown task(s): ' + bad.join(', ')); process.exit(1); }

  const jobs = [];
  for (const name of names) {
    for (const arm of ['baseline', 'strata']) {
      for (let i = 1; i <= runsPerArm; i++) jobs.push({ name, arm, i });
    }
  }

  console.log(`\n  AGENT BENCHMARK — ${jobs.length} sessions, ${CONCURRENCY} at a time`);
  console.log('  wall time is NOT comparable under parallelism; turns and tokens are.\n');

  const results = [];
  let next = 0;
  const t0 = Date.now();

  const logResult = (r, j) => {
    if (r) {
      results.push(r);
      console.log(`  ${r.task.padEnd(11)}${r.arm.padEnd(9)}run ${r.run}  `
        + (r.ok
          ? `${String(r.turns).padStart(3)} turns · $${(r.costUsd ?? 0).toFixed(2)} · +${r.work.filesAdded} files · `
            + `calls=${r.strataCalls} · valid=${r.armValid} · attempted=${r.work.attempted}`
          : 'FAILED (no report)'));
    } else {
      console.log(`  ${j.name.padEnd(11)}${j.arm.padEnd(9)}run ${j.i}  CHILD PRODUCED NOTHING`);
    }
  };

  if (CONCURRENCY <= 1) {
    // SEQUENTIAL: call runOnce directly. No child process — the child-spawn pool was the fragile part
    // ("CHILD PRODUCED NOTHING" when a child was killed mid-retry). Direct calls cannot lose a result.
    for (const j of jobs) {
      let r = null;
      try { r = runOnce(j.name, TASKS[j.name], j.arm, j.i); } catch (e) { console.log('  ERROR', e.message); }
      logResult(r, j);
    }
  } else {
    const runJob = (j) => new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename], {
        env: Object.assign({}, process.env, { BENCH_CHILD: `${j.name}|${j.arm}|${j.i}` }),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.on('close', () => {
        const m = buf.match(/__RESULT__(.*)/);
        let r = null;
        try { r = m ? JSON.parse(m[1]) : null; } catch { /* malformed */ }
        logResult(r, j);
        resolve();
      });
    });
    const queue = jobs.slice();
    const worker = async () => { while (queue.length) await runJob(queue.shift()); };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  }

  console.log('\n  ── SUMMARY ─────────────────────────────────');
  const invalid = results.filter(r => r.ok && !r.armValid);
  if (invalid.length) {
    console.log(`  WARNING: ${invalid.length} run(s) had an invalid arm (Strata fired in a baseline, or`);
    console.log('  never fired in a Strata arm). Those are NOT measurements and are excluded below.\n');
  }
  const nonAttempts = results.filter(r => r.ok && r.armValid && !r.work.attempted);
  if (nonAttempts.length) {
    console.log(`  WARNING: ${nonAttempts.length} run(s) added fewer than 2 files — the task was not`);
    console.log('  attempted. Excluded: a non-attempt beats every real implementation on cost.\n');
  }
  const valid = results.filter(r => r.ok && r.armValid && r.work.attempted);

  for (const name of names) {
    const b = valid.filter(r => r.task === name && r.arm === 'baseline');
    const s2 = valid.filter(r => r.task === name && r.arm === 'strata');
    if (!b.length || !s2.length) { console.log(`  ${name}: incomplete`); continue; }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const bt = med(b.map(r => r.turns));
    const st = med(s2.map(r => r.turns));
    const bc = med(b.map(r => r.costUsd || 0));
    const sc = med(s2.map(r => r.costUsd || 0));
    const wins = s2.filter(r => r.turns < bt).length;
    const pct = bc > 0 ? (((sc - bc) / bc) * 100).toFixed(0) : '?';
    console.log(`  ${name.padEnd(12)} turns ${bt} -> ${st}  ·  cost ${bc.toFixed(2)} -> ${sc.toFixed(2)} (${pct > 0 ? '+' : ''}${pct}%)`
      + `  ·  strata under baseline in ${wins}/${s2.length}`);
  }
  console.log(`\n  elapsed ${((Date.now() - t0) / 60000).toFixed(0)}m · raw runs: ${OUT}`);
  console.log('  Correctness and adoption are NOT scored here — see benchmark/PLAN.md.\n');
})();
