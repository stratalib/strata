#!/usr/bin/env node
'use strict';
/**
 * MUTATION SWEEP — who tests the tests?
 *
 * Every quality number in this project comes from tools we wrote ourselves: the selftests, the
 * admission bar, the selection regression, the coverage probe. If those are flawed, the numbers are
 * theatre. That is not paranoia — it has already happened three times:
 *
 *   • a generated verifier PASSED against deliberately broken code
 *   • the coverage probe ranked candidates by the OLD policy and pointed at the wrong recalls
 *   • the L1 cache replayed known-wrong answers, silently, three separate times
 *
 * "432 assertions pass" can mean the code is good, or it can mean the assertions are decorative.
 * This script tells them apart the only way you can: BREAK THE CODE ON PURPOSE and see if the tests
 * notice.
 *
 * Each mutation is a small, realistic bug injected into implementation.js — a flipped comparison, an
 * off-by-one boundary, a zeroed limit, an inverted return. Then the recall's own selftest runs against
 * the mutant:
 *
 *   KILLED    the selftest failed  → the test is real, it caught the bug
 *   SURVIVED  the selftest passed  → THE TEST HAS A HOLE. Broken code would ship.
 *
 * A surviving mutant is not always a bug — some mutations are semantically equivalent (changing a
 * number that only affects a log message). But a LOW kill rate means the suite is confirmatory, which
 * is exactly the failure the admission bar exists to prevent.
 *
 * Usage: node scripts/mutation-sweep.js [recall-id]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ALLOWLIST = path.join(ROOT, 'cache', 'verified-recalls.json');
const MAX_PER_RECALL = 26;

/** Is this line real code, or a comment/blank we must not mutate? */
function isCode(line) {
  const t = line.trim();
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}

/**
 * Mutation operators. Each returns the mutated line, or null if it does not apply.
 * Deliberately small and realistic — these are the bugs people actually write.
 */
const OPERATORS = [
  { name: 'flip ===',      apply: (l) => l.includes('===') ? l.replace('===', '!==') : null },
  { name: 'flip !==',      apply: (l) => l.includes('!==') ? l.replace('!==', '===') : null },
  { name: 'boundary <',    apply: (l) => /[^<>=]<[^<=]/.test(l) ? l.replace(/([^<>=])<([^<=])/, '$1<=$2') : null },
  { name: 'boundary >',    apply: (l) => /[^<>=]>[^>=]/.test(l) ? l.replace(/([^<>=])>([^>=])/, '$1>=$2') : null },
  { name: '&& -> ||',      apply: (l) => l.includes('&&') ? l.replace('&&', '||') : null },
  { name: 'return true',   apply: (l) => /return true\b/.test(l) ? l.replace('return true', 'return false') : null },
  { name: 'return false',  apply: (l) => /return false\b/.test(l) ? l.replace('return false', 'return true') : null },
  { name: 'drop negation', apply: (l) => /if \(!/.test(l) ? l.replace('if (!', 'if (') : null },
  // Zero out a numeric literal that is not an index/version — catches missing bounds and limits.
  { name: 'literal -> 0',  apply: (l) => {
      const m = l.match(/(?<![\w.])([1-9]\d{1,})(?![\w.])/);   // 2+ digit numbers only
      return m ? l.replace(m[1], '0') : null;
    } },
];

function mutantsFor(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isCode(lines[i])) continue;
    for (const op of OPERATORS) {
      const mutated = op.apply(lines[i]);
      if (mutated === null || mutated === lines[i]) continue;
      const copy = lines.slice();
      copy[i] = mutated;
      out.push({ line: i + 1, op: op.name, src: copy.join('\n'), before: lines[i].trim().slice(0, 62) });
    }
  }
  return out;
}

/** Run a recall's selftest against a mutated implementation, in a subprocess so a hang cannot wedge us. */
function selftestPasses(mutantPath, selftestPath) {
  const runner = `
    const m = require(${JSON.stringify(mutantPath)});
    const t = require(${JSON.stringify(selftestPath)});
    let failed = 0;
    const assert = (c) => { if (!c) failed++; };
    Promise.resolve(t.run(m, assert))
      .then(() => process.exit(failed ? 1 : 0))
      .catch(() => process.exit(1));
  `;
  const r = spawnSync(process.execPath, ['-e', runner], { encoding: 'utf-8', timeout: 20000 });
  return r.status === 0;   // exit 0 = every assertion passed = the mutant SURVIVED
}

function sweep(recallId, dir) {
  const implPath = path.join(dir, 'implementation.js');
  const selfPath = path.join(dir, 'selftest.js');
  if (!fs.existsSync(implPath) || !fs.existsSync(selfPath)) return null;

  const src = fs.readFileSync(implPath, 'utf-8');
  let mutants = mutantsFor(src);

  // Evenly sample when there are many, so we cover the whole file rather than just the top.
  if (mutants.length > MAX_PER_RECALL) {
    const step = mutants.length / MAX_PER_RECALL;
    mutants = Array.from({ length: MAX_PER_RECALL }, (_, i) => mutants[Math.floor(i * step)]);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-'));
  let killed = 0;
  const survivors = [];

  for (let i = 0; i < mutants.length; i++) {
    const mp = path.join(tmp, `m${i}.js`);
    fs.writeFileSync(mp, mutants[i].src);
    if (selftestPasses(mp, selfPath)) survivors.push(mutants[i]);
    else killed++;
    process.stdout.write(killed + survivors.length === mutants.length ? '' : '');
  }

  return { recallId, total: mutants.length, killed, survivors };
}

(function main() {
  const only = process.argv[2];
  const allow = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf-8'));
  const ids = only ? [only] : allow.verified;

  console.log('\n  MUTATION SWEEP — breaking the code on purpose to see if the tests notice\n');
  console.log('  recall                        mutants  killed  survived   kill rate');
  console.log('  ' + '-'.repeat(68));

  let totAll = 0, killAll = 0;
  const allSurvivors = [];

  for (const id of ids) {
    const dir = path.join(ROOT, allow.paths[id]);
    const r = sweep(id, dir);
    if (!r) { console.log(`  ${id.padEnd(30)}  (skipped — no implementation/selftest)`); continue; }
    const rate = r.total ? Math.round((r.killed / r.total) * 100) : 0;
    totAll += r.total; killAll += r.killed;
    for (const s of r.survivors) allSurvivors.push({ id, ...s });
    const flag = rate >= 80 ? '' : rate >= 60 ? '  <-- thin' : '  <-- WEAK';
    console.log(`  ${id.padEnd(30)}${String(r.total).padStart(6)}${String(r.killed).padStart(8)}${String(r.survivors.length).padStart(10)}${String(rate + '%').padStart(11)}${flag}`);
  }

  const overall = totAll ? Math.round((killAll / totAll) * 100) : 0;
  console.log('  ' + '-'.repeat(68));
  console.log(`  ${'OVERALL'.padEnd(30)}${String(totAll).padStart(6)}${String(killAll).padStart(8)}${String(totAll - killAll).padStart(10)}${String(overall + '%').padStart(11)}`);
  console.log(`\n  SCORE: ${overall}/100 — the share of deliberately-injected bugs our own tests caught.\n`);

  if (allSurvivors.length) {
    console.log('  SURVIVORS (broken code the selftest did NOT notice — each is a hole or an equivalent mutant):');
    for (const s of allSurvivors.slice(0, 20)) {
      console.log(`   • ${s.id}  L${s.line}  [${s.op}]`);
      console.log(`     ${s.before}`);
    }
    if (allSurvivors.length > 20) console.log(`   ... and ${allSurvivors.length - 20} more`);
    console.log('');
  }
})();
