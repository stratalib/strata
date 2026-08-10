#!/usr/bin/env node
'use strict';
/**
 * Quick answer to "is it safe to run benchmarks right now, or is the environment degraded again?"
 *
 * 2026-07-28, 2026-07-29, and especially 2026-07-31 all lost significant time to an intermittent
 * exit-127 (sometimes exit-137/SIGKILL) failure in claude CLI spawns — general, time-varying, NOT
 * specific to prompt complexity or this project's code (confirmed by reproducing the harness's exact
 * spawn call standalone: it can succeed once and fail immediately after with identical inputs). This
 * script is the fast version of that whole diagnostic, so it doesn't need re-deriving by hand again.
 *
 * Usage: node benchmark/health-check.js
 */
const { spawnSync } = require('child_process');

function claudeHealthy() {
  const r = spawnSync('claude -p "OK" --model haiku', { shell: true, encoding: 'utf-8', timeout: 30000 });
  return { ok: r.status === 0 && !r.error, status: r.status, error: r.error?.message, stderr: (r.stderr || '').slice(0, 300) };
}

/**
 * COMMIT CHARGE — reported as CONTEXT ONLY. It was promoted to a hard gate on 2026-08-01 and
 * FALSIFIED the same evening. Do not re-promote it without new evidence.
 *
 * The story it replaced was right about one thing: free physical RAM is definitely not the metric
 * (9.42 GB free failed; 9.46 GB free succeeded — identical, opposite outcomes). Commit looked like the
 * variable that separated them: 65% when failing, 34.9% when working.
 *
 * Then, 2026-08-01 17:51-17:53, from the session transcript:
 *
 *   17:51:53  this script printed "Commit charge: 69%  FAIL — heavy runs will die at exit 127"
 *   17:53:03  Get-Process: opera 51 procs / 12.3 GB, commit 22.26 / 31.45 GB = 70.8%
 *   17:53:28  two idempotency+Strata runs launched anyway — both exit 0, 9/9 checks, $0.23 / $0.24
 *
 * Higher commit than the level declared fatal, same browser open, ninety seconds later, clean pass.
 * n=2 does not disprove a correlation, but it does disprove a GATE, and a gate is what this was. The
 * cost of leaving it in is not neutral: it tells the operator to stop when the honest answer is "we do
 * not know", which burns sessions closing a browser that was never the cause — it was closed repeatedly
 * on this advice and the failures continued.
 *
 * WHAT ACTUALLY CORRELATES, on the evidence available: the SHAPE OF THE HARNESS, not the machine.
 *
 *   failing  — run-quality-battery.js: ONE node parent alive 30-60 min spawning N claude children
 *   working  — run-one.js in a shell loop: a fresh node process per run, dead within minutes
 *
 * That also explains the observation the memory theory never could — a plain express server
 * (server/hub.js, no claude CLI anywhere) printed "[hub] listening on :8099", served real requests,
 * and then died at exit 127 with no output. It is a long-lived node process too. The common factor in
 * every death is a node process that stays alive too long, and the heaviest arms died first because
 * they keep the parent alive longest, not because they commit the most.
 *
 * Until that is nailed down: PREFER ONE PROCESS PER RUN. It is free insurance either way.
 */
function commitPercent() {
  if (process.platform !== 'win32') return null;
  const ps = 'Get-CimInstance Win32_OperatingSystem | ForEach-Object { '
    + '[math]::Round((($_.TotalVirtualMemorySize - $_.FreeVirtualMemory)/$_.TotalVirtualMemorySize)*100,1) }';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf-8', timeout: 20000 });
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) ? v : null;
}

function orphanCount() {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV', { shell: true, encoding: 'utf-8' });
  const lines = (r.stdout || '').trim().split('\n').filter(l => l.includes('claude.exe'));
  return lines.length;
}

(async () => {
  console.log('=== Strata benchmark environment health check ===\n');

  const h1 = claudeHealthy();
  console.log(`Direct health probe:  ${h1.ok ? 'PASS' : 'FAIL'}` + (h1.ok ? '' : ` (status=${h1.status} error=${h1.error || h1.stderr})`));

  const orphans = orphanCount();
  if (orphans !== null) console.log(`Orphaned claude.exe:  ${orphans}` + (orphans > 5 ? '  (high — may be worth investigating)' : ''));

  const commit = commitPercent();
  if (commit !== null) {
    console.log(`Commit charge:        ${commit}%   (context only — NOT a gate, see note above)`);
    if (commit >= 60) {
      console.log('  High, but runs have completed cleanly at 70.8%. This number has never been shown');
      console.log('  to predict an outcome. Do not close a browser on account of it.');
    }
  }

  console.log('\nRunning a second probe 5s later, to check for the known intermittent pattern...');
  await new Promise(r => setTimeout(r, 5000));
  const h2 = claudeHealthy();
  console.log(`Second probe:          ${h2.ok ? 'PASS' : 'FAIL'}` + (h2.ok ? '' : ` (status=${h2.status} error=${h2.error || h2.stderr})`));

  console.log();

  // The ONLY advice this script can give that has ever survived contact with the data.
  //
  // Nothing measured above predicts a batch outcome — not the probes (too small to commit anything),
  // not commit charge (falsified 90 minutes after it was adopted), not orphan count (never grew
  // monotonically). Rather than dress that up as a verdict, say the one thing that has actually
  // separated a working evening from a failing one, every time it has been checked.
  console.log('HOW TO RUN, regardless of what the numbers above say:');
  console.log('  Use ONE PROCESS PER RUN, not a long-lived batch parent:');
  console.log('    for r in 1 2 3; do node benchmark/run-one.js <task> <arm> --model <m> \\');
  console.log('      --out exp-quality --run $r; done');
  console.log('  Every death on record — including a plain express server with no claude CLI near it —');
  console.log('  was a node process that had been alive for tens of minutes. run-one.js is not.');
  console.log('  Background it too, so no tool timeout can reap the loop either.');
  console.log();

  if (h1.ok && h2.ok) {
    console.log('Both probes passed. Reasonably safe to start a benchmark run — but this environment has');
    console.log('failed mid-batch before even after clean probes, so don\'t walk away from a long batch');
    console.log('unattended without checking back at least once.');
  } else if (!h1.ok && !h2.ok) {
    console.log('Both probes failed. This matches the documented degraded-environment pattern');
    console.log('pattern documented for this harness — do not sink time into');
    console.log('retrying benchmark runs right now. Try again in a while, or in a fresh session.');
  } else {
    console.log('Inconsistent (one passed, one failed) — this IS the pattern itself: time-varying,');
    console.log('not a clean up/down state. A successful benchmark run right now is possible but not');
    console.log('guaranteed to stay that way mid-batch.');
  }
})();
