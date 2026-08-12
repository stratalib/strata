#!/usr/bin/env node
'use strict';
/**
 * Cost per unit of WORKING software — the only cost comparison that is fair.
 *
 * The published board compares dollars per session. That silently rewards failure: a baseline run
 * that crashes at turn 20 is cheap, and two of the three haiku payments baselines scored 0/8 because
 * the app never started. Averaging their cost into "baseline is cheaper" credits the baseline for
 * dying early.
 *
 * A user does not buy sessions. They buy a working feature. So the denominator has to be checks
 * actually passed, not attempts made.
 */
const fs = require('fs');
const path = require('path');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');

/**
 * Join grades to runs on BOTH keys.
 *
 * GRADES.json rows are keyed by whatever directory was graded — for most runs that is the archived
 * tree (named after the run), but for 20 of them it is the original temp dir (`bench-XXXXXX`),
 * because those were graded live before archiving. Matching on the run name alone silently dropped
 * all 15 retry runs and 5 stripejune-strata runs — including the three most expensive sessions in
 * the whole battery — which made Strata look dramatically better than it is. The run record carries
 * its own temp path in `dir`, so both keys are available; use them.
 */
const gradeByKey = new Map();
{
  const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));
  for (const row of g.grades || []) {
    const key = String(row.dir || '').split(/[\\/]/).filter(Boolean).pop();
    if (!key) continue;
    const res = row.results || [];
    gradeByKey.set(key, { passed: res.filter((r) => r.pass === true).length, total: res.length, booted: row.booted });
  }
}

const runs = [];
const unmatched = [];
for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true) continue;
  const name = f.replace(/\.json$/, '');
  const tmpKey = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
  const g = gradeByKey.get(name) || gradeByKey.get(tmpKey);
  if (!g || !g.total) { unmatched.push(name); continue; }
  runs.push({ name, task: rec.task, model: rec.model, arm: rec.arm, cost: rec.costUsd,
              turns: rec.turns, passed: g.passed, total: g.total, booted: g.booted });
}
if (unmatched.length) {
  console.log('\n  !! still unmatched after two-key join: ' + unmatched.length);
  for (const u of unmatched) console.log('       ' + u);
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

console.log('\n═══ 1 · DOES THE BASELINE GET CREDIT FOR FAILING CHEAPLY? ═══\n');
console.log('  A run that never boots is cheap. If those are averaged into the cost column, the');
console.log('  baseline looks thriftier than it is.\n');
console.log('  arm-model         runs   didn\'t boot   $ booted   $ dead   dead runs drag mean by');
console.log('  ' + '─'.repeat(82));
for (const arm of ['baseline', 'strata']) {
  for (const model of ['haiku', 'sonnet', 'opus']) {
    const rs = runs.filter((r) => r.arm === arm && r.model === model);
    if (!rs.length) continue;
    const dead = rs.filter((r) => r.passed === 0 || r.booted === false);
    const live = rs.filter((r) => !(r.passed === 0 || r.booted === false));
    const mAll = sum(rs, (r) => r.cost) / rs.length;
    const mLive = live.length ? sum(live, (r) => r.cost) / live.length : NaN;
    const mDead = dead.length ? sum(dead, (r) => r.cost) / dead.length : NaN;
    console.log('  ' + (arm + '-' + model).padEnd(18) + String(rs.length).padStart(4) +
      String(dead.length).padStart(13) + '   ' + ('$' + fmt(mLive)).padStart(8) +
      '  ' + (dead.length ? '$' + fmt(mDead) : '—').padStart(7) +
      '   ' + (dead.length ? fmt(((mAll / mLive) - 1) * 100, 1) + '%' : '—').padStart(20));
  }
}

console.log('\n\n═══ 2 · COST PER PASSING CHECK ═══\n');
console.log('  Total spend divided by total checks passed. Failure is no longer a discount.\n');
console.log('  arm-model         total $   checks passed   $ / passing check   vs baseline');
console.log('  ' + '─'.repeat(78));
const perCheck = {};
for (const arm of ['baseline', 'strata']) {
  for (const model of ['haiku', 'sonnet', 'opus']) {
    const rs = runs.filter((r) => r.arm === arm && r.model === model);
    if (!rs.length) continue;
    const c = sum(rs, (r) => r.cost), p = sum(rs, (r) => r.passed);
    const v = p ? c / p : NaN;
    perCheck[arm + '-' + model] = v;
    const base = perCheck['baseline-' + model];
    const rel = arm === 'strata' && Number.isFinite(base) ? v / base : NaN;
    console.log('  ' + (arm + '-' + model).padEnd(18) + ('$' + fmt(c)).padStart(7) +
      String(p).padStart(16) + '   ' + ('$' + fmt(v, 4)).padStart(17) +
      '   ' + (Number.isFinite(rel) ? fmt(rel) + '×' : '—').padStart(11));
  }
}

console.log('\n  Cross-tier — the comparison the product actually claims:\n');
const hs = perCheck['strata-haiku'], ob = perCheck['baseline-opus'], sb = perCheck['baseline-sonnet'];
if (hs && ob) console.log('    haiku + Strata vs opus baseline   : ' + fmt(ob / hs) + '× cheaper per passing check');
if (hs && sb) console.log('    haiku + Strata vs sonnet baseline : ' + fmt(sb / hs) + '× cheaper per passing check');

console.log('\n\n═══ 3 · COST OF A COMPLETE FEATURE ═══\n');
console.log('  Share of runs that passed EVERY check, and the expected spend to obtain one such run');
console.log('  (cost per attempt ÷ probability of a clean run).\n');
console.log('  arm-model         clean runs   P(clean)   $/attempt   expected $ for a clean run');
console.log('  ' + '─'.repeat(84));
for (const arm of ['baseline', 'strata']) {
  for (const model of ['haiku', 'sonnet', 'opus']) {
    const rs = runs.filter((r) => r.arm === arm && r.model === model);
    if (!rs.length) continue;
    const clean = rs.filter((r) => r.passed === r.total).length;
    const p = clean / rs.length;
    const cpa = sum(rs, (r) => r.cost) / rs.length;
    console.log('  ' + (arm + '-' + model).padEnd(18) + (clean + '/' + rs.length).padStart(10) +
      fmt(p * 100, 0).padStart(10) + '%   ' + ('$' + fmt(cpa)).padStart(9) +
      '   ' + (p > 0 ? '$' + fmt(cpa / p) : 'never observed').padStart(26));
  }
}
console.log('\n');
