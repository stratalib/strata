#!/usr/bin/env node
'use strict';
/**
 * The cross-task board: every task x arm, cost and quality side by side, with per-run detail.
 *
 * Grades are CACHED into <runsdir>/GRADES.json keyed by run stem + the grader's own suiteHash, because
 * grading boots the delivered app and takes ~20s a run — re-grading eighteen runs on every analysis
 * pass is four minutes of nothing. Keying on suiteHash means a change to the grader or the suites
 * invalidates the cache automatically rather than silently comparing runs scored by two instruments,
 * which is the precise mistake this project has already made once.
 *
 *   node benchmark/quality/matrix.js exp-fixed            # grade what is missing, print the board
 *   node benchmark/quality/matrix.js exp-fixed --regrade  # ignore the cache
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const dirName = process.argv[2] || 'exp-fixed';
const RUNS = path.join(ROOT, 'benchmark', 'runs', dirName);
const REGRADE = process.argv.includes('--regrade');
const CACHE = path.join(RUNS, 'GRADES.json');

const SUITE_FOR = { catalog: 'catalog', idempotency: 'idempotency', stripejune: 'stripejune', retry: 'retry' };

function loadCache() {
  if (REGRADE || !fs.existsSync(CACHE)) return {};
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf-8')); } catch { return {}; }
}
const cache = loadCache();
const unstable = [];

/** One grading pass. */
function gradeOnce(stem, suite) {
  const tree = path.join(RUNS, 'trees', stem);
  if (!fs.existsSync(tree)) return null;
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'grade.js'), tree, '--suite', suite],
    { encoding: 'utf-8', timeout: 300_000, cwd: ROOT });
  try {
    const j = JSON.parse(r.stdout);
    return { passed: j.passed, total: j.total, suiteHash: j.suiteHash, unmeasurable: j.unmeasurable || null,
      failing: (j.results || []).filter(x => !x.pass).map(x => x.id).sort().join(',') };
  } catch { return null; }
}

/** Block for `ms` without a busy loop — grading boots servers, and they need a moment to let go. */
function settle(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore', timeout: ms + 5000 });
}

/**
 * Grade until the answer is STABLE, and say so when it is not.
 *
 * Grading straight after a batch produced systematically worse scores than the same trees graded a
 * minute later: an exp-v20 cell recorded 6/7, 5/7, 5/7 on its first pass and then returned 6/7 twelve
 * times in a row. The runs had only just finished, and grade.js boots the delivered app — so the first
 * pass was competing with whatever the benchmark had not finished tearing down.
 *
 * Averaging that in makes an instrument artefact look like a product defect, which is the wrong
 * direction to be wrong in: it UNDERSTATES the thing being measured, so nobody goes looking. Two
 * agreeing passes are required; a disagreement is broken by a third and reported rather than hidden,
 * because a check that scores the same bytes two ways is a finding in its own right.
 */
function gradeOne(stem, suite) {
  settle(2500);
  const a = gradeOnce(stem, suite);
  if (!a) return null;
  const b = gradeOnce(stem, suite);
  if (!b) return a;
  if (a.passed === b.passed && a.failing === b.failing) return a;

  const c = gradeOnce(stem, suite);
  const votes = [a, b, c].filter(Boolean);
  const best = votes.sort((x, y) =>
    votes.filter(v => v.passed === y.passed).length - votes.filter(v => v.passed === x.passed).length)[0];
  unstable.push(`${stem}: graded ${votes.map(v => v.passed + '/' + v.total).join(' then ')} — using ${best.passed}/${best.total}`);
  return best;
}

const stems = fs.existsSync(RUNS)
  ? [...new Set(fs.readdirSync(RUNS).filter(f => f.endsWith('.json') && f !== 'GRADES.json').map(f => f.replace(/\.json$/, '')))].sort()
  : [];

const rows = [];
const skipped = [];
for (const stem of stems) {
  const m = stem.match(/^(.+?)-(baseline|strata|preinject)-(\w+)-(\d+)$/);
  if (!m) continue;
  const [, task, arm, model, run] = m;
  const suite = SUITE_FOR[task];
  const meta = JSON.parse(fs.readFileSync(path.join(RUNS, stem + '.json'), 'utf-8'));

  /**
   * SKIP runs the harness already judged invalid.
   *
   * A session that hits the usage limit still writes a record: turns 1, cost $0, `synthetic: true`,
   * and a transcript whose only content is "You've hit your session limit". Read uncritically that
   * averages in as a free, one-turn, perfect-looking run — the first draft of this file printed a
   * catalog board of "1.0 turns, $0.0000" for six such records and would have reported it as a
   * result. agent-bench already sets ok/armValid correctly; the analyzer just has to honour them.
   */
  if (meta.ok !== true || meta.armValid !== true || meta.synthetic === true) {
    skipped.push({ stem, why: meta.synthetic ? 'rate-limited (synthetic)' : `ok=${meta.ok} armValid=${meta.armValid}` });
    continue;
  }

  let g = cache[stem] || null;
  if (!g && suite) { g = gradeOne(stem, suite); if (g) { cache[stem] = g; fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2)); } }

  rows.push({ task, arm, model, run: Number(run), turns: meta.turns, cost: meta.costUsd,
    secs: meta.wallSecs ?? null, passed: g ? g.passed : null, total: g ? g.total : null,
    unmeasurable: g ? g.unmeasurable : null });
}

const tasks = [...new Set(rows.map(r => r.task))];

// A tree that scores two ways is a finding, not a rounding error. Print it above the board so it is
// read before the numbers it affects, never after.
if (unstable.length) {
  console.log('\n  UNSTABLE GRADING — the same tree scored differently on repeat passes:');
  for (const u of unstable) console.log('    ' + u);
}
if (skipped.length) {
  console.log('\n  EXCLUDED — the harness marked these invalid, they are not data:');
  for (const s of skipped) console.log('    ' + s.stem.padEnd(34) + s.why);
}

console.log(`\n  RUNS — ${dirName}\n`);
console.log('  run                             turns      $     checks');
console.log('  ' + '─'.repeat(58));
for (const r of rows) {
  const q = r.total ? `${r.passed}/${r.total}` : (r.unmeasurable ? 'unmeasurable' : '—');
  console.log(`  ${(r.task + '-' + r.arm + '-' + r.model + '-' + r.run).padEnd(32)}${String(r.turns).padStart(4)}  $${r.cost.toFixed(3)}   ${q}`);
}

console.log(`\n  BOARD — mean per cell\n`);
console.log('  task           arm        n   turns      $        quality');
console.log('  ' + '─'.repeat(62));
for (const task of tasks) {
  for (const arm of ['baseline', 'strata']) {
    const rs = rows.filter(r => r.task === task && r.arm === arm);
    if (!rs.length) continue;
    const mean = f => rs.reduce((s, x) => s + f(x), 0) / rs.length;
    const graded = rs.filter(r => r.total);
    const qual = graded.length
      ? (100 * graded.reduce((s, r) => s + r.passed / r.total, 0) / graded.length).toFixed(1) + '%'
      : 'n/a';
    console.log(`  ${task.padEnd(14)} ${arm.padEnd(10)}${String(rs.length).padStart(2)}`
      + `${mean(r => r.turns).toFixed(1).padStart(8)}  $${mean(r => r.cost).toFixed(4)}   ${qual.padStart(7)}`);
  }
  const b = rows.filter(r => r.task === task && r.arm === 'baseline');
  const s = rows.filter(r => r.task === task && r.arm === 'strata');
  if (b.length && s.length) {
    const mc = a => a.reduce((x, y) => x + y.cost, 0) / a.length;
    const mt = a => a.reduce((x, y) => x + y.turns, 0) / a.length;
    console.log(`  ${''.padEnd(14)} ${'ratio'.padEnd(10)}  ${(mt(s) / mt(b)).toFixed(2).padStart(7)}x  ${(mc(s) / mc(b)).toFixed(2)}x`);
  }
  console.log('');
}
