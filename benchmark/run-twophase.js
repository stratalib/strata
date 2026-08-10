#!/usr/bin/env node
'use strict';
/**
 * TWO-PHASE BENCHMARK: stop hand-placing strata.guide.json and test the
 * REAL workflow instead.
 *
 * Every guide number so far came from a guide *I* pre-wrote and dropped into the temp dir — that proves
 * the MECHANISM (a data-layer note kills Prisma reconciliation) but skips the actual cost of getting a
 * guide onto disk, and it never exercises the authoring step (STRATA-GUIDE.md §6 step 5) at all.
 *
 * This runs the thing users would actually do:
 *   PHASE 1 (analyze) — a fresh `claude` session, NO Strata tool, told to explore the project and author
 *                        strata.guide.json. Measured on its own — this is the one-time amortized cost.
 *   PHASE 2 (task)    — a SECOND, fresh `claude` session (new context — the whole point is that oauth's
 *                        16 "re-learn this app" reads shouldn't have to happen again), in the SAME
 *                        directory, given the real task. The guide from phase 1 is just sitting there.
 *
 * Reuses agent-bench.js's trusted `sh`/`prepareDir`/`writeMcpConfig` — see its module.exports comment —
 * so both phases spawn `claude` exactly the way every other benchmark number was produced.
 *
 * Usage: node benchmark/run-twophase.js oauth --model sonnet [--run 1] [--out exp-twophase]
 */

const fs = require('fs');
const path = require('path');
const {
  TASKS, ROOT, sh, prepareDir, writeMcpConfig, measureWork, countFiles, arg,
} = require('./agent-bench.js');

const OUT = path.join(__dirname, 'runs', arg('--out', 'exp-twophase'));
const runIdx = arg('--run', '1');
const model = arg('--model', '');
// TERSENESS — kept byte-identical to agent-bench.js's own addition (2026-07-27); see that file's comment
// for the full finding. Applied to the TASK prompt only (not ANALYZE_PROMPT/repairPrompt/capturePrompt —
// those are already narrow, single-purpose prompts with no doc-sprawl risk of their own).
const TERSE = ' Do not create documentation files (README, ARCHITECTURE, DEPLOYMENT, DECISIONS, '
  + 'SUMMARY, QUICKSTART, COMPONENTS, or similar) unless the task explicitly asks for documentation - '
  + 'a short code comment where genuinely non-obvious is enough. Do not write example or demo scripts '
  + 'unless asked. Spend your effort on working, tested code, not on narrating what you built.';

const AUTONOMY = ' Work autonomously and make sensible choices without checking in - I am not '
  + 'available to answer questions. If something is ambiguous, pick the option you would defend and '
  + 'note it at the end.' + TERSE;

// ONE continuous line, no embedded newlines — every other prompt in this file (agent-bench.js TASKS)
// follows this rule. A multi-line template literal here broke sh()'s Windows shell-quoting (cmd.exe
// mangles a quoted arg containing a raw newline) and the very first smoke run produced zero output.
const ANALYZE_PROMPT = 'Analyze this codebase as if you were about to work in it for months, and write a '
  + 'machine-readable map of it to ./strata.guide.json (project root). A reference file showing the '
  + 'EXACT schema shape is at ./.strata-guide-example.json in this directory - read it FIRST. Adapt its '
  + 'SHAPE to what THIS project actually has; do not copy its content or invent fields it does not show. '
  + 'Capture, as accurately as the code actually shows (read the real files, do not guess): '
  + '(1) stack - language, module system, framework, runtime. '
  + '(2) layout - source root, entry point, routes/services/data-access directories, env file. '
  + '(3) datastores - every storage harness this project ACTUALLY uses, keyed by a short alias. For '
  + 'each: what kind it is, how it is accessed, and CRITICALLY whether it is genuinely LIVE at runtime '
  + 'or merely declared/aspirational (e.g. a schema file exists but its client package is not installed, '
  + 'or nothing in the running code path actually imports/uses it) - getting this wrong is the single '
  + 'most expensive mistake a generator can make against this project. '
  + '(4) domains - the real business entities, each bound to a datastore by alias, with their real field '
  + 'names, id field, and - if the project already has its own store module for that entity - a '
  + 'methodAliases map from standard names (findById, findByEmail, create, list) onto the project\'s '
  + 'ACTUAL method names. '
  + '(5) capabilities - any cross-cutting concern (sessions, caching, rate limiting, idempotency, '
  + 'background jobs) and which datastore alias would realistically back it in this project, if one were '
  + 'added. '
  + '(6) guidance - ONE sentence stating the most important, easy-to-get-wrong fact about this project\'s '
  + 'data reality (the thing a naive generator would screw up first). '
  + 'When done, DELETE ./.strata-guide-example.json - it was only a reference, not part of the project. '
  + 'Do not implement any feature, do not modify any other file. This is a mapping task only.' + AUTONOMY;

function run(cmd, args, dir) {
  const t0 = Date.now();
  const r = sh(cmd, args, { cwd: dir, timeout: 45 * 60 * 1000 });
  const raw = (r.stdout || '') + (r.stderr || '');
  let report = null, strataCalls = 0, synthetic = false;
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
      }
    }
  }
  const usage = (report && (report.usage || (report.modelUsage && Object.values(report.modelUsage)[0]))) || {};
  return {
    ok: r.status === 0 && !!report,
    turns: report ? (report.num_turns ?? null) : null,
    costUsd: report ? (report.total_cost_usd ?? null) : null,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    wallMs: Date.now() - t0,
    strataCalls,
    synthetic,
    finalSummary: report ? String(report.result || '').slice(0, 1500) : '',
    raw,
  };
}

function claudeArgs(prompt, mcpPath) {
  return [
    '-p', prompt,
    ...(model ? ['--model', model] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', '120',
    '--dangerously-skip-permissions',
    '--strict-mcp-config',
    '--mcp-config', mcpPath,
  ];
}

// Two claude sessions back-to-back in ONE process is too long a background job to survive — the first
// smoke test's phase 2 was silently torn down mid-run with no error trace, the exact "long background
// job gets reaped" pattern from the 2026-07-26 showcase sweep. Split at the phase boundary instead:
// `analyze` runs and exits; `task` is launched as its OWN process afterward and picks up via a small
// state file. Mirrors run-one.js — the one pattern proven to survive this harness.
function statePath(taskName) {
  fs.mkdirSync(OUT, { recursive: true });
  return path.join(OUT, `${taskName}-twophase-${runIdx}.state.json`);
}

function snapshotPath(taskName) {
  return path.join(OUT, `${taskName}-twophase-${runIdx}.snapshot`);
}

/**
 * Freeze the directory the moment the guide is final (trustworthy) — "each run begins from an identical
 * tree" is the same discipline agent-bench.js's prepareDir already enforces; skipping it here is what let
 * a crashed first `task` attempt's leftover strata/ delivery silently contaminate its own retry (the
 * retry found a FINISHED oauth implementation already sitting there and just audited it — strataCalls=0,
 * an invalid measurement that looked like a valid one until the transcript was read).
 */
function snapshotGuideDir(taskName, dir) {
  const snap = snapshotPath(taskName);
  fs.rmSync(snap, { recursive: true, force: true });
  fs.cpSync(dir, snap, { recursive: true });
  console.log(`  snapshotted guide-authored dir -> ${snap}`);
}

function cmdAnalyze(taskName, task) {
  console.log(`\n=== TWO-PHASE / ANALYZE: ${taskName} (run ${runIdx}) ===\n`);
  const dir = prepareDir(task);
  fs.copyFileSync(
    path.join(ROOT, 'strata.guide.example.json'),
    path.join(dir, '.strata-guide-example.json'),
  );

  // No Strata tool: plain exploration+authoring, isolated exactly like the baseline arm so
  // "did it call strata_use" can never leak in and confuse the measurement.
  console.log('--- analyzing & authoring strata.guide.json ---');
  const emptyMcp = path.join(dir, '.mcp-empty.json');
  fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }, null, 2));
  const p1 = run('claude', claudeArgs(ANALYZE_PROMPT, emptyMcp), dir);
  console.log(`  turns=${p1.turns} cost=$${(p1.costUsd || 0).toFixed(2)} ok=${p1.ok} synthetic=${p1.synthetic}`);

  const guideWritten = fs.existsSync(path.join(dir, 'strata.guide.json'));
  console.log(`  strata.guide.json written: ${guideWritten}`);

  // Fact-check what it produced — deterministic, zero cost, the same gate live delivery uses.
  let factCheck = { trustworthy: false, errors: [], warnings: [] };
  if (guideWritten) {
    try {
      const { loadGuide } = require(path.join(ROOT, 'dist', 'src', 'guide.js'));
      const { factCheckGuide, guideIsTrustworthy } = require(path.join(ROOT, 'dist', 'src', 'guide-factcheck.js'));
      const guide = loadGuide(dir);
      const violations = factCheckGuide(guide, dir);
      factCheck = {
        trustworthy: guideIsTrustworthy(violations),
        errors: violations.filter(v => v.severity === 'error').map(v => `${v.where}: ${v.message}`),
        warnings: violations.filter(v => v.severity === 'warn').map(v => `${v.where}: ${v.message}`),
      };
    } catch (e) {
      factCheck = { trustworthy: false, errors: [`guide unreadable: ${e.message}`], warnings: [] };
    }
  }
  console.log(`  fact-check: trustworthy=${factCheck.trustworthy} errors=${factCheck.errors.length} warnings=${factCheck.warnings.length}`);
  factCheck.errors.forEach(e => console.log('    ERROR ' + e));
  if (factCheck.trustworthy) snapshotGuideDir(taskName, dir);

  fs.mkdirSync(OUT, { recursive: true });
  const stem = `${taskName}-twophase-${runIdx}`;
  fs.writeFileSync(path.join(OUT, stem + '-phase1.log'), (p1.raw || '').slice(0, 4 * 1024 * 1024));
  fs.writeFileSync(statePath(taskName), JSON.stringify({
    task: taskName, model: model || 'default', run: runIdx, dir,
    phase1: { ...p1, raw: undefined }, guideWritten, factCheck,
  }, null, 2));
  console.log(`\nstate saved — next: node benchmark/run-twophase.js task ${taskName} --model ${model || '<model>'} --run ${runIdx}`);
}

// A guide that fails fact-check is INVISIBLE to the live engine (guideIsTrustworthy gates both the
// adapters AND the data-layer note — see guide-generate.ts) — running the task phase against it would
// silently measure "no guide" and waste real spend answering nothing. This mirrors the SAME
// feedback-retry pattern scripts/vertex-author.js already uses for recall admission: hand back the
// exact violations, ask for a minimal targeted fix, re-check. Real authoring will sometimes need one
// repair pass; this is that pass, not a hand-edit.
function cmdRepair(taskName, task) {
  const sp = statePath(taskName);
  if (!fs.existsSync(sp)) { console.error(`no analyze state found at ${sp} — run "analyze" first.`); process.exit(1); }
  const state = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  const { dir, factCheck } = state;
  if (factCheck.trustworthy) { console.log('guide already trustworthy — nothing to repair.'); return; }

  console.log(`\n=== TWO-PHASE / REPAIR: ${taskName} (run ${runIdx}) ===`);
  console.log(`  ${factCheck.errors.length} error(s) to fix:`);
  factCheck.errors.forEach(e => console.log('    ' + e));

  const repairPrompt = 'Your ./strata.guide.json failed a deterministic fact-check against this '
    + 'project\'s real files. Fix ONLY these problems, minimally, by editing strata.guide.json - do not '
    + 'rewrite unrelated sections: '
    + factCheck.errors.map((e, i) => `(${i + 1}) ${e}`).join(' ')
    + '. If a datastore is not actually usable in this project (e.g. its package is not installed), '
    + 'either remove that datastore or mark it correctly as not live at runtime and rebind any domain '
    + 'that pointed at it to a datastore that IS real. Do not touch any other file.' + AUTONOMY;

  const emptyMcp = path.join(dir, '.mcp-empty.json');
  const pr = run('claude', claudeArgs(repairPrompt, emptyMcp), dir);
  console.log(`  turns=${pr.turns} cost=$${(pr.costUsd || 0).toFixed(2)} ok=${pr.ok}`);

  const { loadGuide } = require(path.join(ROOT, 'dist', 'src', 'guide.js'));
  const { factCheckGuide, guideIsTrustworthy } = require(path.join(ROOT, 'dist', 'src', 'guide-factcheck.js'));
  let newFactCheck;
  try {
    const guide = loadGuide(dir);
    const violations = factCheckGuide(guide, dir);
    newFactCheck = {
      trustworthy: guideIsTrustworthy(violations),
      errors: violations.filter(v => v.severity === 'error').map(v => `${v.where}: ${v.message}`),
      warnings: violations.filter(v => v.severity === 'warn').map(v => `${v.where}: ${v.message}`),
    };
  } catch (e) {
    newFactCheck = { trustworthy: false, errors: [`guide unreadable: ${e.message}`], warnings: [] };
  }
  console.log(`  fact-check after repair: trustworthy=${newFactCheck.trustworthy} errors=${newFactCheck.errors.length}`);
  newFactCheck.errors.forEach(e => console.log('    ERROR ' + e));
  if (newFactCheck.trustworthy) snapshotGuideDir(taskName, dir);

  // Fold the repair's cost into phase1 (it is part of the one-time authoring cost, not the task).
  const combinedPhase1 = { ...state.phase1,
    turns: (state.phase1.turns || 0) + (pr.turns || 0),
    costUsd: (state.phase1.costUsd || 0) + (pr.costUsd || 0),
  };
  fs.writeFileSync(statePath(taskName), JSON.stringify({
    ...state, phase1: combinedPhase1, factCheck: newFactCheck, repaired: true,
  }, null, 2));
  console.log(`\nstate updated — next: node benchmark/run-twophase.js task ${taskName} --model ${model || '<model>'} --run ${runIdx}`);
}

// Retroactive domain capture (STRATA-GUIDE.md Part 2, §11). Run AFTER a `task` completes: the session
// that just built a new domain (e.g. `order`) still exists in its own transcript/summary, but the NEXT
// session that touches that domain gets none of that context unless it is captured now, while it is
// cheap to state. This does NOT re-derive anything from scratch — it feeds the model exactly what it (or
// a prior session) already built and asks for a MINIMAL domains[] addition, same feedback-driven shape
// as `repair`. Produces a NEW, separate ".captured.snapshot" — the original analyze/repair snapshot is
// left untouched, so `task <taskName>` without --seed still reproduces the ORIGINAL (uncaptured) baseline
// exactly as before; only a task launched with `--seed <captured.snapshot>` sees the enriched guide.
function cmdCapture(taskName, task) {
  const resultPath = path.join(OUT, `${taskName}-twophase-${runIdx}.json`);
  if (!fs.existsSync(resultPath)) {
    console.error(`no completed task-phase result at ${resultPath} — run "task" first for this task/run.`);
    process.exit(1);
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
  const dir = result.taskDir;
  if (!dir || !fs.existsSync(dir)) {
    console.error(`taskDir from ${resultPath} is gone: ${dir}. Capture must run before that temp dir is cleaned up.`);
    process.exit(1);
  }

  console.log(`\n=== TWO-PHASE / CAPTURE: ${taskName} (run ${runIdx}) ===`);
  console.log(`  capturing from: ${dir}`);

  const summary = (result.phase2 && result.phase2.finalSummary) || '';
  // ONE continuous line — same shell-quoting discipline as ANALYZE_PROMPT/repairPrompt (§ the newline bug).
  const capturePrompt = 'A prior session in this exact project completed this task: "' + task.prompt.replace(/"/g, "'") + '". '
    + 'Its own closing summary was: "' + summary.replace(/"/g, "'").slice(0, 600) + '". '
    + 'Read the CURRENT ./strata.guide.json and the real files that session created. For every business '
    + 'domain that work introduced which strata.guide.json does NOT already describe (e.g. it built an '
    + 'order-creation endpoint but the guide has no "order" domain), ADD a domains[] entry: fields, '
    + 'idField, route, storeInterface/methodAliases if it has a real store, PLUS rules[] (plain-language '
    + 'invariants it actually enforced, each with enforcedAt pointing at the real file and function that '
    + 'enforces it - never mark verifiable:true, that mechanism does not exist yet), operations[] (the '
    + 'operations it implemented, each with implementedIn pointing at the real file), and dependsOn[] for '
    + 'any other domain this one relies on. If a domain the guide already describes is unaffected, leave '
    + 'it untouched - this is a targeted ADDITION, not a re-author. Update strata.guide.json directly. Do '
    + 'not touch any other file.' + AUTONOMY;

  const emptyMcp = path.join(dir, '.mcp-empty.json');
  fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }, null, 2));
  const cap = run('claude', claudeArgs(capturePrompt, emptyMcp), dir);
  console.log(`  turns=${cap.turns} cost=$${(cap.costUsd || 0).toFixed(2)} ok=${cap.ok}`);

  const { loadGuide } = require(path.join(ROOT, 'dist', 'src', 'guide.js'));
  const { factCheckGuide, guideIsTrustworthy } = require(path.join(ROOT, 'dist', 'src', 'guide-factcheck.js'));
  let factCheck;
  try {
    const guide = loadGuide(dir);
    const violations = factCheckGuide(guide, dir);
    factCheck = {
      trustworthy: guideIsTrustworthy(violations),
      errors: violations.filter(v => v.severity === 'error').map(v => `${v.where}: ${v.message}`),
      warnings: violations.filter(v => v.severity === 'warn').map(v => `${v.where}: ${v.message}`),
    };
  } catch (e) {
    factCheck = { trustworthy: false, errors: [`guide unreadable: ${e.message}`], warnings: [] };
  }
  console.log(`  fact-check: trustworthy=${factCheck.trustworthy} errors=${factCheck.errors.length} warnings=${factCheck.warnings.length}`);
  factCheck.errors.forEach(e => console.log('    ERROR ' + e));

  const stem = `${taskName}-twophase-${runIdx}`;
  fs.writeFileSync(path.join(OUT, stem + '-capture.log'), (cap.raw || '').slice(0, 4 * 1024 * 1024));

  if (!factCheck.trustworthy) {
    // No auto-repair loop for capture in v1 (unlike analyze/repair) — a wrong DOMAIN claim is a more
    // dangerous failure mode than a wrong datastore claim (§10), so this stops for a human to look at
    // rather than looping a fix blind. Nothing is snapshotted; a later `task --seed` has nothing new to use.
    console.log('\n  NOT trustworthy — no captured snapshot written. Inspect the guide by hand before retrying.');
    return;
  }

  const capturedSnap = path.join(OUT, `${stem}.captured.snapshot`);
  fs.rmSync(capturedSnap, { recursive: true, force: true });
  fs.cpSync(dir, capturedSnap, { recursive: true });
  console.log(`\n  captured snapshot -> ${capturedSnap}`);
  console.log(`  next (a DIFFERENT, related task B): node benchmark/run-twophase.js task <taskB> --model ${model || '<model>'} --run 1 --seed ${capturedSnap}`);
}

function cmdTask(taskName, task) {
  // --seed lets a DIFFERENT task restore from another task's CAPTURED snapshot (§12's two-task
  // experiment: task B needs to start from task A's already-built code + enriched guide, not from its
  // own fresh analyze). Without --seed, task restores its own analyze/repair snapshot as before.
  const seedOverride = arg('--seed', '');
  let phase1, snap, analyzeDir;
  if (seedOverride) {
    snap = seedOverride;
    phase1 = undefined;   // seeded runs have no analyze/repair cost of their own to report
    analyzeDir = undefined;
    if (!fs.existsSync(snap)) { console.error(`--seed snapshot not found: ${snap}`); process.exit(1); }
  } else {
    const sp = statePath(taskName);
    if (!fs.existsSync(sp)) {
      console.error(`no analyze state found at ${sp} — run "analyze" first for this task/model/run.`);
      process.exit(1);
    }
    const state = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    phase1 = state.phase1;
    analyzeDir = state.dir;
    snap = snapshotPath(taskName);
    if (!fs.existsSync(snap)) {
      console.error(`no trustworthy-guide snapshot at ${snap} — run "analyze" (and "repair" if it flagged errors) first.`);
      process.exit(1);
    }
  }

  console.log(`\n=== TWO-PHASE / TASK: ${taskName} (run ${runIdx}) ===`);
  // ALWAYS restore into a FRESH dir from the frozen snapshot — never touch it or reuse a prior task
  // attempt's directory directly. A crashed first attempt's file-system writes (a Write/Edit tool call
  // survives even if the claude process itself gets torn down) would otherwise silently contaminate
  // every retry, exactly as it did here once: the model found a FINISHED oauth delivery already sitting
  // on disk from a killed prior run, audited it instead of building it, and strataCalls=0 looked like a
  // valid-but-boring result instead of the invalid one it actually was. "Each run begins from an
  // identical tree" (agent-bench.js's prepareDir) applies here too.
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'twophase-task-'));
  fs.cpSync(snap, dir, { recursive: true });
  console.log(`  restored guide-authored snapshot -> ${dir}`);

  // The real task, FRESH session, on the freshly-restored dir. This is the steady-state cost the
  // two-phase idea is actually testing.
  writeMcpConfig(dir);
  const mcpPath = path.join(dir, '.mcp.json');
  const p2 = run('claude', claudeArgs(task.prompt + AUTONOMY, mcpPath), dir);
  console.log(`  turns=${p2.turns} cost=$${(p2.costUsd || 0).toFixed(2)} ok=${p2.ok} strataCalls=${p2.strataCalls} synthetic=${p2.synthetic}`);

  // FRAMING RULE (learned 2026-07-27, do not re-break it): task-phase cost is what compares to a cold
  // baseline. Do not print/compare a "combined" figure here for the same reason it was wrong before —
  // baseline pays its own grounding/prior-domain-invention cost too, invisibly, every time it touches
  // this domain; only the un-seeded (own-analyze) case even has a phase1 to report at all.
  if (seedOverride) {
    console.log(`\n=== TASK-PHASE (seeded from ${seedOverride}): $${(p2.costUsd || 0).toFixed(2)} — compare to THIS task's OWN cold baseline, never to task A's cost ===`);
  } else {
    console.log(`\n=== TASK-PHASE: $${(p2.costUsd || 0).toFixed(2)}  (this run's own analyze+repair cost, reported separately above, was $${(phase1.costUsd || 0).toFixed(2)} — do NOT sum them against baseline) ===`);
  }

  const result = {
    task: taskName, model: model || 'default', run: runIdx,
    seededFrom: seedOverride || undefined,
    phase1,
    analyzeDir,
    taskDir: dir,            // a FRESH restore of the snapshot — where phase 2 actually ran
    phase2: { ...p2, raw: undefined },
    work: measureWork(dir, task),
    fileCount: countFiles(dir),
  };

  const stem = `${taskName}-twophase-${runIdx}`;
  fs.writeFileSync(path.join(OUT, stem + '.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, stem + '-phase2.log'), (p2.raw || '').slice(0, 4 * 1024 * 1024));
  console.log(`\nartifact: ${path.join(OUT, stem + '.json')}`);
}

(async () => {
  const mode = process.argv[2];
  const taskName = process.argv[3];
  const task = TASKS[taskName];
  if (!['analyze', 'repair', 'capture', 'task'].includes(mode) || !task || !task.fixture) {
    console.error('usage: run-twophase.js <analyze|repair|capture|task> <brownfield-task> [--model m] [--run N] [--out folder] [--seed <captured.snapshot>]');
    process.exit(1);
  }
  if (mode === 'analyze') cmdAnalyze(taskName, task);
  else if (mode === 'repair') cmdRepair(taskName, task);
  else if (mode === 'capture') cmdCapture(taskName, task);
  else cmdTask(taskName, task);
})();
