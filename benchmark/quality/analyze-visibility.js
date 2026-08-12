#!/usr/bin/env node
'use strict';
/**
 * Could the person who asked for this have NOTICED it was broken?
 *
 * The cost-to-working metric assumes a user who checks and asks again. A developer shipping a side
 * project with four users mostly does not: they accept whatever comes back and move on. If Strata's
 * advantage lives in defects nobody can perceive, then the advantage is real and unsellable — and
 * that changes who the customer is, not how the pitch is worded.
 *
 * So each check is classified by how it would surface to the person who requested the feature:
 *
 *   blocking   the app does not start. Impossible to miss.
 *   obvious    wrong answer to an ordinary request. Anyone who tries their own endpoint once sees it.
 *   edge       needs deliberately hostile or malformed input. Most people never send it.
 *   load       needs traffic, timing, concurrency or a retry to appear.
 *   silent     a correctness or security defect that surfaces only as a later incident.
 *
 * The classification is a judgement call and is stated here rather than buried, so it can be argued
 * with. Nothing else in the analysis depends on it being exactly right — the shape is what matters.
 */
const fs = require('fs');
const path = require('path');

const VISIBILITY = {
  // catalog
  'C1-list-works': 'obvious',
  'C2-limit-respected': 'obvious',
  'C3-page2-disjoint': 'obvious',
  'C4-hostile-paging-input': 'edge',
  'C5-ratelimit-triggers': 'load',
  'C6-ratelimit-refills': 'load',
  'C7-request-id-traceable': 'silent',
  'C8-malformed-json': 'edge',
  // idempotency
  'I1-create-works': 'obvious',
  'I2-replay-deduplicates': 'load',
  'I3-same-key-different-body': 'silent',
  'I4-malformed-json': 'edge',
  'I5-validation-rejects-bad-body': 'edge',
  'I6-concurrent-duplicate': 'load',
  'I7-attempt-logged': 'silent',
  // payments
  'P1-webhook-accepts-valid-signature': 'obvious',
  'P2-unsigned-rejected': 'silent',
  'P3-forged-signature-rejected': 'silent',
  'P4-raw-body-verification': 'silent',
  'P5-replay-window-enforced': 'silent',
  'P6-duplicate-event-once': 'load',
  'P7-webhook-answers-promptly': 'load',
  'P8-no-secret-or-stack-leak': 'silent',
  // retry helper
  'R1-retries-then-succeeds': 'obvious',
  'R2-gives-up-eventually': 'load',
  'R3-actually-waits': 'load',
  'R4-backoff-grows': 'load',
  'R5-no-retry-on-4xx': 'silent',
  'R6-surfaces-the-failure': 'obvious',
  'R7-succeeds-first-time-without-waiting': 'obvious',
};

const ORDER = ['blocking', 'obvious', 'edge', 'load', 'silent'];
const NOTICED = { blocking: 'always', obvious: 'likely', edge: 'rarely', load: 'rarely', silent: 'never' };

const RUNS = path.join(__dirname, '..', 'runs', 'exp-quality');
const byKey = new Map();
{
  const g = JSON.parse(fs.readFileSync(path.join(RUNS, 'GRADES.json'), 'utf-8'));
  for (const row of g.grades || []) {
    const k = String(row.dir || '').split(/[\\/]/).filter(Boolean).pop();
    if (k) byKey.set(k, row);
  }
}

const tally = {};   // class -> arm -> {pass, n}
let bootFail = { baseline: 0, strata: 0, nBase: 0, nStr: 0 };

for (const f of fs.readdirSync(RUNS).filter((x) => x.endsWith('.json'))) {
  if (/GRADES|SUMMARY|STATIC|BOARD/i.test(f)) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf-8'));
  if (rec.ok !== true || rec.arm === 'preinject') continue;
  const name = f.replace(/\.json$/, '');
  const tmp = String(rec.dir || '').split(/[\\/]/).filter(Boolean).pop();
  const g = byKey.get(name) || byKey.get(tmp);
  if (!g || !(g.results || []).length) continue;

  const side = rec.arm === 'strata' ? 'strata' : 'baseline';
  if (side === 'baseline') { bootFail.nBase++; if (g.booted === false) bootFail.baseline++; }
  else { bootFail.nStr++; if (g.booted === false) bootFail.strata++; }

  for (const r of g.results) {
    const cls = VISIBILITY[r.id];
    if (!cls) continue;
    tally[cls] = tally[cls] || { baseline: { pass: 0, n: 0 }, strata: { pass: 0, n: 0 } };
    tally[cls][side].n++;
    if (r.pass === true) tally[cls][side].pass++;
  }
}

const pct = (o) => (o.n ? (o.pass / o.n) * 100 : NaN);
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');

console.log('\n═══ WHERE STRATA\'S ADVANTAGE ACTUALLY LIVES ═══\n');
console.log('  Would the person who asked for the feature notice it was broken?\n');
console.log('  class      noticed?   baseline   strata    Strata\'s gain');
console.log('  ' + '─'.repeat(64));

let visibleGain = 0, invisibleGain = 0, visibleWeight = 0, invisibleWeight = 0;
for (const cls of ORDER) {
  const t = tally[cls];
  if (!t) continue;
  const b = pct(t.baseline), s = pct(t.strata);
  const gain = s - b;
  const bar = gain > 0 ? '█'.repeat(Math.round(gain / 4)) : '';
  console.log('  ' + cls.padEnd(11) + NOTICED[cls].padEnd(10) +
    (f1(b) + '%').padStart(9) + (f1(s) + '%').padStart(9) + '   ' +
    ((gain >= 0 ? '+' : '') + f1(gain) + ' pts').padStart(10) + '  ' + bar);

  if (cls === 'obvious') { visibleGain += gain * t.baseline.n; visibleWeight += t.baseline.n; }
  else if (cls !== 'blocking') { invisibleGain += gain * t.baseline.n; invisibleWeight += t.baseline.n; }
}

console.log('\n  boot failures (blocking, always noticed):');
console.log('    baseline ' + bootFail.baseline + '/' + bootFail.nBase +
            '     strata ' + bootFail.strata + '/' + bootFail.nStr);

const vg = visibleWeight ? visibleGain / visibleWeight : 0;
const ig = invisibleWeight ? invisibleGain / invisibleWeight : 0;
console.log('\n\n═══ THE ANSWER ═══\n');
console.log('  Gain on defects a user WOULD notice ....... ' + (vg >= 0 ? '+' : '') + f1(vg) + ' pts');
console.log('  Gain on defects a user would NOT notice ... ' + (ig >= 0 ? '+' : '') + f1(ig) + ' pts');
console.log('');
if (ig > vg * 1.4) {
  console.log('  Most of the advantage is invisible to the person who asked for the feature.');
  console.log('  It is real, and they cannot perceive it — so it cannot be sold to them as quality.');
  console.log('  It has to be either MADE visible (the verifier) or sold to whoever eats the incident.');
} else {
  console.log('  A meaningful share of the advantage is in defects the user would hit themselves.');
}
console.log('');
