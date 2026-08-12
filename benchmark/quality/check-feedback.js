#!/usr/bin/env node
'use strict';
/**
 * Inspect exactly what the retry loop would send back to the model — before spending on sessions.
 *
 * If the pre-registered checks leak into this text, every number the battery has ever produced
 * becomes worthless, so this is worth reading with suspicion. Assert the obvious tells are absent:
 * check ids, the word "check", counts of checks, and the suite vocabulary.
 */
const fs = require('fs');
const path = require('path');
const { feedbackFrom } = require('../run-until-working.js');
const { TASKS } = require('../agent-bench.js');

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));

const pick = (re) => (g.grades || []).find((r) => re.test(String(r.dir)) &&
  (r.results || []).some((x) => x.pass !== true));

const cases = [
  ['catalog',     pick(/catalog-baseline-haiku/)],
  ['idempotency', pick(/idempotency-baseline-haiku/)],
];

let bad = 0;
for (const [taskName, grade] of cases) {
  if (!grade) { console.log(`  ${taskName}: no failing grade found`); continue; }
  const text = feedbackFrom(grade, TASKS[taskName]);

  const tells = [
    ['no check ids (C1-, I3-, P6-, R5-)', !/\b[CIPR]\d+-[a-z]/i.test(text)],
    ['does not say "check"', !/\bchecks?\b/i.test(text)],
    ['no pass/fail vocabulary', !/\bPASS\b|\bFAIL\b/.test(text)],
    ['no suite/grader mention', !/suite|grader|graded|pre-registered/i.test(text)],
    ['restates the original task', text.includes(TASKS[taskName].prompt.trim().slice(0, 40))],
    ['carries observable symptoms', /- /.test(text) || /does not start/.test(text)],
  ];

  const failed = tells.filter(([, ok]) => !ok);
  if (failed.length) bad++;
  console.log(`\n  ── ${taskName} ${failed.length ? 'LEAK RISK' : 'ok'} ──`);
  for (const [label, ok] of tells) console.log('     ' + (ok ? '✓' : '✗') + ' ' + label);
  console.log('\n' + text.split('\n').map((l) => '     │ ' + l).join('\n'));
}

console.log(bad ? `\n  ${bad} case(s) LEAK — do not run\n` : '\n  feedback carries symptoms only\n');
process.exit(bad ? 1 : 0);
