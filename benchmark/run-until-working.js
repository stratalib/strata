#!/usr/bin/env node
'use strict';
/**
 * COST TO WORKING — the measurement the published battery cannot make.
 *
 * The quality battery gives every arm exactly ONE attempt and stops. That silently credits failure:
 * plain haiku produced 0 fully-working features in 11 tries, and the board still records $0.21 per
 * run as though the user received something. Nobody buys attempts. They buy a feature that works, and
 * when it doesn't they prompt again — another session, another full context, another bill.
 *
 * This measures that: run, grade, and if it failed, report the symptoms back and let it try again.
 * Sum the cost across attempts. Report how many attempts it actually took.
 *
 *   node benchmark/run-until-working.js --tasks catalog --arms baseline,strata --models haiku
 *   node benchmark/run-until-working.js --tasks catalog --attempts 3 --runs 1
 *
 * ── THE METHODOLOGICAL CONSTRAINT ──
 *
 * The pre-registered checks must never reach the model. If they did, both arms would be optimising
 * against a visible grader and every number in the battery would be worthless.
 *
 * So the feedback carries SYMPTOMS, never checks: the grader's own observation of what the running
 * app did ("limit=5 → 200, 20 items"), with the check id and the assertion stripped. That is
 * information a user genuinely has — they can see the endpoint return twenty items when they asked
 * for five — and it is what they would put in a follow-up message. What the model never receives is
 * a check id, an assertion, the list of checks, or how many there are.
 *
 * The same function builds the feedback for every arm, so whatever leakage remains is identical
 * across arms and cannot favour one.
 */
const fs = require('fs');
const path = require('path');

process.argv = process.argv.includes('--out') ? process.argv : [...process.argv, '--out', 'exp-costtoworking'];

const { TASKS, runOnce, OUT } = require('./agent-bench.js');
const { gradeDir } = require('./quality/grade.js');

const argOf = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const TASKS_WANTED = argOf('--tasks', 'catalog').split(',').filter(Boolean);
const ARMS = argOf('--arms', 'baseline,strata').split(',').filter(Boolean);
const MODELS = argOf('--models', 'haiku').split(',').filter(Boolean);
const RUNS = Number(argOf('--runs', '1'));
const MAX_ATTEMPTS = Number(argOf('--attempts', '3'));

/**
 * Turn a failed grade into what a user would actually say.
 *
 * Deliberately plain and non-technical in framing: a user reports what they saw, not what a suite
 * asserted. Symptoms are capped so a wholesale failure does not turn into a specification the model
 * can simply implement line by line — the cap is what keeps this a nudge rather than a new brief.
 */
function feedbackFrom(grade, task) {
  const failures = (grade.results || []).filter((r) => r.pass !== true);
  const lines = [];

  if (grade.booted === false) {
    lines.push('The app does not start. When I run it I get:');
    lines.push(String(grade.bootError || grade.error || 'it exits immediately with an error').slice(0, 600));
  } else {
    lines.push('I tried the feature and parts of it are not behaving correctly. What I saw:');
    for (const f of failures.slice(0, 6)) {
      const detail = String(f.detail || '').trim();
      if (detail) lines.push('  - ' + detail.slice(0, 160));
    }
  }

  return [
    'That is not working yet.',
    '',
    lines.join('\n'),
    '',
    'Please fix it so the original request actually works:',
    '"' + task.prompt.trim() + '"',
    '',
    'Verify it yourself before you finish.',
  ].join('\n');
}

const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

// Exported so the feedback can be inspected without spending anything on sessions — what goes back
// to the model is the one part of this experiment that could invalidate it.
module.exports = { feedbackFrom };
if (require.main !== module) return;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];

  for (let run = 1; run <= RUNS; run++) {
    for (const taskName of TASKS_WANTED) {
      const task = TASKS[taskName];
      if (!task) { console.log(`  unknown task: ${taskName}`); continue; }

      for (const model of MODELS) {
        for (const arm of ARMS) {
          const stem = `${taskName}-${arm}-${model}-${run}`;
          console.log(`\n=== ${stem}`);

          const attempts = [];
          let dir = null, passed = false, grade = null;

          for (let a = 1; a <= MAX_ATTEMPTS; a++) {
            process.argv = ['node', 'run-until-working.js', '--out', path.basename(OUT),
                            '--model', model, '--run', String(run)];

            const opts = a === 1 ? {} : { dir, prompt: feedbackFrom(grade, task), stemSuffix: `-a${a}` };
            const t0 = Date.now();
            let r;
            try { r = runOnce(taskName, task, arm, run, opts); }
            catch (e) { console.log(`  attempt ${a}: THREW — ${e.message}`); break; }

            dir = r.dir;
            attempts.push({ attempt: a, ok: r.ok, turns: r.turns, cost: r.costUsd, secs: (Date.now() - t0) / 1000 });
            if (!r.ok) { console.log(`  attempt ${a}: run failed (ok=false) — stopping this cell`); break; }

            try { grade = await gradeDir(dir, taskName); }
            catch (e) { console.log(`  attempt ${a}: grading threw — ${e.message}`); break; }

            const p = (grade.results || []).filter((x) => x.pass === true).length;
            const t = (grade.results || []).length;
            passed = t > 0 && p === t;
            console.log(`  attempt ${a}: ${r.turns} turns · $${(r.costUsd || 0).toFixed(3)} · ${p}/${t} checks` +
                        (passed ? '  ✓ WORKING' : ''));
            if (passed) break;
          }

          const row = {
            task: taskName, arm, model, run,
            attemptsUsed: attempts.length,
            reachedWorking: passed,
            totalCost: sum(attempts, (x) => x.cost),
            totalTurns: sum(attempts, (x) => x.turns),
            totalSecs: sum(attempts, (x) => x.secs),
            perAttempt: attempts,
          };
          results.push(row);
          fs.writeFileSync(path.join(OUT, `costtoworking-${stem}.json`), JSON.stringify(row, null, 2));
          console.log(`  → ${passed ? 'WORKING' : 'never worked'} after ${attempts.length} attempt(s), ` +
                      `$${row.totalCost.toFixed(3)} total`);
        }
      }
    }
  }

  console.log('\n\n═══ COST TO A WORKING FEATURE ═══\n');
  console.log('  task        model    arm        attempts   working   total $   total turns');
  console.log('  ' + '─'.repeat(76));
  for (const r of results) {
    console.log('  ' + r.task.padEnd(12) + r.model.padEnd(9) + r.arm.padEnd(11) +
      String(r.attemptsUsed).padStart(6) + '   ' + (r.reachedWorking ? '  yes' : '   no').padStart(7) +
      '   ' + ('$' + r.totalCost.toFixed(2)).padStart(7) + '   ' + String(r.totalTurns).padStart(11));
  }
  console.log('');
})();
