#!/usr/bin/env node
'use strict';
/**
 * THIRD-PARTY static analysis over every archived delivery.
 *
 * WHY THIS EXISTS: the acceptance suite in ./suites.js is ours. It is pre-registered, hashed and
 * negative-controlled, and all its raw artefacts are published — but it is still a metric we wrote,
 * and "we invented the yardstick and we win on it" is a fair thing for a reader to suspect.
 *
 * So this runs rules NOBODY here authored:
 *   - eslint:recommended        the industry default correctness set
 *   - eslint-plugin-sonarjs     SonarQube's own bug-detection rules, as a plugin
 *   - eslint-plugin-security    OWASP-flavoured JS security rules
 *
 * WHAT IT CANNOT DO, stated plainly, because this is the reason the custom suite exists at all:
 * none of these detect a rate limiter that never refills (C6), a page 2 that re-serves page 1 (C3),
 * or an idempotency key that replays a DIFFERENT body as the original order (I3). Every one of those
 * is valid JavaScript that lints clean. They are semantic defects against a specification, and
 * catching them requires booting the app and exercising what was asked for. Static analysis is a
 * SECOND, INDEPENDENT AXIS — not a replacement, and not a tiebreaker.
 *
 * FAIRNESS: Strata ships a ~35 KB lib.js, so raw finding counts are biased against it purely by
 * volume. Findings are therefore reported per 1000 lines as well as raw, and split by who wrote the
 * file — the model's own code vs the code Strata delivered — because those answer different
 * questions. Conflating them would let either arm hide behind the other.
 *
 *   node benchmark/quality/static-analysis.js [runDir]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const runDir = process.argv[2] || path.join(__dirname, '..', 'runs', 'exp-quality');
const treesDir = path.join(runDir, 'trees');
const HARNESS = process.env.STRATA_LINT_HARNESS
  || path.join(process.env.TEMP || '/tmp', 'strata-static-analysis',
    '85a05ad2-b1cd-428d-93c5-fb5ed06f0b4b', 'scratchpad', 'lint');

if (!fs.existsSync(treesDir)) { console.error('no archived trees at', treesDir); process.exit(1); }
if (!fs.existsSync(path.join(HARNESS, 'node_modules', 'eslint'))) {
  console.error('lint harness not installed at', HARNESS);
  console.error('npm i eslint@9 eslint-plugin-sonarjs@2 eslint-plugin-security@3 in that directory');
  process.exit(1);
}

// Flat config, written into the harness so the project's own tree is never touched — the repo is the
// thing being published, and polluting its dependency graph to measure it would be its own defect.
// BARE specifiers, deliberately. Two earlier attempts failed differently and both failed SILENTLY:
//   - a raw Windows path ("c:\...") in an ESM import → ERR_UNSUPPORTED_ESM_URL_SCHEME;
//   - a file:// URL to a guessed entry file → ERR_MODULE_NOT_FOUND, because these packages resolve
//     through "exports", not through an index.js that may not exist.
// In both cases ESLint exited 0 with empty stdout, and a caller defaulting to "[]" would report a
// flawless codebase for a tool that never ran.
// This config file is written INTO the harness directory, which owns the node_modules, so ESM
// resolves bare names from there — no guessing at entry points, no path-scheme problems.
const CONFIG = `
import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import security from 'eslint-plugin-security';

export default [
  js.configs.recommended,
  sonarjs.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly', exports: 'writable',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', fetch: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', AbortSignal: 'readonly', crypto: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', structuredClone: 'readonly',
      },
    },
    rules: {
      // Crashes under ESLint 9 ("Cannot read properties of undefined (reading 'allow')") — the rule
      // reads an option object the flat-config preset never supplies. Disabled because it is broken
      // here, NOT because of what it reports: an empty function body is a style opinion, and it is
      // not one of the defect classes this analysis is being run to detect.
      'sonarjs/no-empty-function': 'off',
    },
  },
];
`;
const configPath = path.join(HARNESS, 'eslint.config.mjs');

/**
 * Some eslint-plugin-sonarjs@2 rules wrap ESLint core rules and read an options object that the flat
 * -config preset never supplies, so they throw at load time under ESLint 9 ("Cannot read properties
 * of undefined (reading 'allow' / 'allowShortCircuit')"). One crashing rule aborts the ENTIRE run,
 * which is how a whole-library analysis silently produced zero findings.
 *
 * Rather than hand-disable them one at a time, the crashing rule name is parsed out of stderr and the
 * run retried. Every rule dropped this way is RECORDED and printed, because a quietly shrinking
 * ruleset is a quietly weakening measurement — the reader needs to know which checks were not run.
 */
const disabledRules = [];
function writeConfig() {
  const extra = disabledRules.map(r => `      '${r}': 'off',`).join('\n');
  fs.writeFileSync(configPath, CONFIG.replace("      'sonarjs/no-empty-function': 'off',",
    `      'sonarjs/no-empty-function': 'off',\n${extra}`));
}
writeConfig();

function runEslint(cwd, files) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const r = spawnSync(
      process.execPath,
      [path.join(HARNESS, 'node_modules', 'eslint', 'bin', 'eslint.js'),
        '--no-config-lookup', '--config', configPath, '--format', 'json', ...files],
      { cwd, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024, timeout: 180_000 },
    );
    const crash = /Error while loading rule '([^']+)'/.exec(r.stderr || '');
    if (crash && !disabledRules.includes(crash[1])) {
      disabledRules.push(crash[1]);
      writeConfig();
      continue;                       // retry with the incompatible rule switched off
    }
    return r;
  }
  return null;
}

/**
 * THREE buckets, not two — and the third one matters.
 *
 * A first pass split only model-written vs Strata-delivered, which graded `strata/verify.js` and
 * `strata/tests/*` as if they were production code. Those are the PROOF Strata ships, not the product:
 * test files legitimately hardcode credentials, IPs and magic numbers, so linting them against
 * production rules penalises Strata precisely for generating tests. The baseline arms write no tests
 * at all, so they are never charged for this — the comparison was structurally unfair.
 *
 * Application code is what a user runs. That is the number that means something.
 */
function authorOf(rel) {
  const p = rel.replace(/\\/g, '/');
  if (/^strata\/(verify|selftest)\.js$/.test(p) || p.startsWith('strata/tests/')) return 'test';
  if (p.startsWith('strata/') || p.endsWith('server.reference.js')) return 'strata';
  return 'model';
}

/**
 * `security/detect-object-injection` fires on ANY `obj[key]` where key is a variable. It is the
 * best-known false-positive generator in eslint-plugin-security and flags ordinary map lookups.
 * Counted separately so "N security findings" is not quietly inflated by it — reporting 48 security
 * issues when 13 are this rule would mislead exactly as much as hiding them would.
 */
const NOISY_SECURITY = new Set(['security/detect-object-injection']);

function jsFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(full, base));
    else if (e.name.endsWith('.js')) out.push(path.relative(base, full));
  }
  return out;
}

const rows = [];
const trees = fs.readdirSync(treesDir).filter(t => fs.statSync(path.join(treesDir, t)).isDirectory());

for (const tree of trees) {
  const abs = path.join(treesDir, tree);
  const files = jsFiles(abs);
  if (!files.length) continue;

  const r = runEslint(abs, files);
  if (!r) { console.error(`
  FATAL ${tree}: eslint kept crashing after 25 rule-disable retries`); process.exit(1); }

  // NO SILENT ZEROS. Defaulting to '[]' on empty stdout turns "the linter crashed" into "the code is
  // flawless" — which is exactly how this script first reported 0 errors across all 22 deliveries
  // while ESLint was failing to load its config on every single one. An analysis that cannot fail is
  // worth nothing, so a run producing no results for files that demonstrably exist is a hard error.
  let results;
  try { results = JSON.parse(r.stdout || ''); }
  catch {
    console.error(`\n  FATAL ${tree}: eslint produced no parseable output for ${files.length} files.`);
    console.error(`  stderr: ${(r.stderr || '').slice(0, 400)}`);
    process.exit(1);
  }
  if (!Array.isArray(results) || results.length === 0) {
    console.error(`\n  FATAL ${tree}: eslint returned no results for ${files.length} js files.`);
    process.exit(1);
  }

  // NOT named model/strata: spreading them into a row that also carries a `model` field (haiku /
  // sonnet / opus) overwrote it with an object, and every cell printed "[object Object]+baseline".
  const blank = () => ({ errors: 0, warnings: 0, security: 0, noisy: 0, sonar: 0, loc: 0, files: 0 });
  const acc = { byModel: blank(), byStrata: blank(), byTest: blank() };

  for (const f of results) {
    const rel = path.relative(abs, f.filePath);
    const who = authorOf(rel);
    const a = who === 'strata' ? acc.byStrata : who === 'test' ? acc.byTest : acc.byModel;
    a.files++;
    try { a.loc += fs.readFileSync(f.filePath, 'utf-8').split('\n').length; } catch { /* unreadable */ }
    for (const m of f.messages) {
      if (m.severity === 2) a.errors++; else a.warnings++;
      const rule = m.ruleId || '';
      if (rule.startsWith('security/')) { if (NOISY_SECURITY.has(rule)) a.noisy++; else a.security++; }
      if (rule.startsWith('sonarjs/')) a.sonar++;
    }
  }

  const meta = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(abs, '_ARCHIVE.json'), 'utf-8')); }
    catch { return {}; }
  })();

  rows.push({ tree, task: meta.task, arm: meta.arm, model: meta.model, run: meta.run, byModel: acc.byModel, byStrata: acc.byStrata, byTest: acc.byTest });
  process.stdout.write('.');
}
console.log('\n');

const per1k = (n, loc) => (loc ? +(n / (loc / 1000)).toFixed(1) : 0);
const cellOf = (r) => `${r.model}+${r.arm}`;

const report = { generatedAt: new Date().toISOString(), tool: 'eslint9 + sonarjs2 + security3', rows, cells: {} };

for (const task of [...new Set(rows.map(r => r.task))].filter(Boolean)) {
  console.log(`\n=== ${task} ===`);
  console.log('  cell               n   APP CODE (tests excluded)      MODEL-WRITTEN ONLY');
  console.log('                         err  warn  sec  sonar /kLOC    err  warn  sec  sonar /kLOC');
  const cells = [...new Set(rows.filter(r => r.task === task).map(cellOf))].sort();
  for (const cell of cells) {
    const rs = rows.filter(r => r.task === task && cellOf(r) === cell);
    const sum = (sel, k) => rs.reduce((a, r) => a + (sel === 'app' ? r.byModel[k] + r.byStrata[k] : sel === 'model' ? r.byModel[k] : sel === 'test' ? r.byTest[k] : r.byStrata[k]), 0);
    const allLoc = sum('app', 'loc'), mLoc = sum('model', 'loc');
    const allIssues = sum('app', 'errors') + sum('app', 'warnings');
    const mIssues = sum('model', 'errors') + sum('model', 'warnings');
    console.log(`  ${cell.padEnd(18)} ${String(rs.length).padEnd(3)} `
      + `${String(sum('app', 'errors')).padEnd(4)} ${String(sum('app', 'warnings')).padEnd(5)} `
      + `${String(sum('app', 'security')).padEnd(4)} ${String(sum('app', 'sonar')).padEnd(5)} `
      + `${String(per1k(allIssues, allLoc)).padEnd(8)}  `
      + `${String(sum('model', 'errors')).padEnd(4)} ${String(sum('model', 'warnings')).padEnd(5)} `
      + `${String(sum('model', 'security')).padEnd(4)} ${String(sum('model', 'sonar')).padEnd(5)} `
      + `${per1k(mIssues, mLoc)}`);
    report.cells[`${task}|${cell}`] = {
      n: rs.length,
      all: { errors: sum('app', 'errors'), warnings: sum('app', 'warnings'), security: sum('app', 'security'), sonar: sum('app', 'sonar'), loc: allLoc, per1k: per1k(allIssues, allLoc) },
      modelWritten: { errors: sum('model', 'errors'), warnings: sum('model', 'warnings'), security: sum('model', 'security'), sonar: sum('model', 'sonar'), loc: mLoc, per1k: per1k(mIssues, mLoc) },
      strataDelivered: { errors: sum('strata', 'errors'), warnings: sum('strata', 'warnings'), security: sum('strata', 'security'), sonar: sum('strata', 'sonar'), loc: sum('strata', 'loc') },
    };
  }
}

report.disabledIncompatibleRules = disabledRules;
if (disabledRules.length) {
  console.log(`
Rules disabled as incompatible with ESLint 9 (recorded, not hidden): ${disabledRules.join(', ')}`);
}
fs.writeFileSync(path.join(runDir, 'STATIC-ANALYSIS.json'), JSON.stringify(report, null, 2));
console.log(`\nwrote ${path.join(runDir, 'STATIC-ANALYSIS.json')}`);
console.log('\nNOTE: these rules cannot detect C6/C3/I3-class defects — those are valid JavaScript.');
console.log('This is a second axis, not a replacement for the behavioural suite.');
