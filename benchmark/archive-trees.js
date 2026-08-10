#!/usr/bin/env node
'use strict';
/**
 * Copy every run's OUTPUT TREE — the code the session actually wrote — into the repo.
 *
 * The run JSON records metrics and the .log records the transcript, but the thing those numbers are
 * ABOUT lived only in `os.tmpdir()/bench-XXXXXX`. That is Windows Temp: Storage Sense and Disk Cleanup
 * delete it on their own schedule, and this machine already reaps processes unpredictably. So the
 * single artefact that cannot be regenerated — a specific model's specific delivery, the thing every
 * quality grade is computed from — was the one artefact with no durable copy.
 *
 * Losing it does not merely lose a file. It makes every grade in GRADES.json unauditable: you can read
 * that a run scored 6/8 but never again ask WHY, or re-grade it when the suite improves. This project
 * has already had to reconstruct a destroyed allowlist from a .gitignore; that lesson was cheap only
 * because a second independent source happened to exist.
 *
 * node_modules is excluded — it is reinstallable, it is 99% of the bytes, and it is not evidence.
 * Everything else goes in verbatim: 0.86 MB for fifteen runs.
 *
 *   node benchmark/archive-trees.js [runDir]
 */
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2] || path.join(__dirname, 'runs', 'exp-quality');
const treesDir = path.join(runDir, 'trees');

const SKIP = new Set(['node_modules', '.git', '.strata']);

function copyTree(src, dest) {
  let files = 0, bytes = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      const r = copyTree(s, d);
      files += r.files; bytes += r.bytes;
    } else if (e.isFile()) {
      // A single pathological file should not abort the whole archive.
      try {
        fs.copyFileSync(s, d);
        files++; bytes += fs.statSync(s).size;
      } catch { /* unreadable — skipped, and the count will show it */ }
    }
  }
  return { files, bytes };
}

/**
 * Run artifacts are lowercase `<task>-<arm>-<model>-<run>.json`. Report files are SHOUTED
 * (GRADES.json, QUALITY-SUMMARY.json, STATIC-ANALYSIS.json) and must never be mistaken for runs.
 *
 * The filter used to name them individually and missed STATIC-ANALYSIS.json when it was added, so the
 * archiver treated a report as a run with no `dir` and announced "1 lost — a lost tree cannot be
 * regenerated". Nothing was lost. A false alarm about destroyed evidence is expensive in its own
 * right: it sends someone hunting for data that was never missing, and it trains people to ignore the
 * warning that will one day be real. Matching the shape instead of a blocklist means the next report
 * file added is handled correctly without anyone remembering to update this line.
 */
const runs = fs.readdirSync(runDir)
  .filter(f => f.endsWith('.json') && !/[A-Z]/.test(f));
let archived = 0, skipped = 0, missing = 0, stubs = 0, replaced = 0, totalBytes = 0;

for (const f of runs) {
  const stem = f.replace(/\.json$/, '');
  const run = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf-8'));
  const dest = path.join(treesDir, stem);

  /**
   * A run that produced NO REPORT is not evidence and must never be archived.
   *
   * On 2026-08-01 a session limit hit mid-batch and thirteen stripejune runs died at the spawn, each
   * leaving a three-file stub (package.json, .mcp-empty.json, and this archiver's own manifest). All
   * thirteen were archived as though they were results — "1 archived ... 0.00 MB", thirteen times.
   *
   * That is worse than wasted bytes, because of the rule immediately below: the stub then OWNS the
   * stem, and the skip-if-exists guard would have silently dropped the real tree when the run was
   * retried. The archiver would have printed "already present" and moved on, and the only copy of the
   * genuine delivery would have stayed in Temp until Windows cleared it.
   */
  if (run.ok !== true) { stubs++; continue; }

  if (fs.existsSync(dest)) {
    // Already archived — but archived from THIS run, or from an earlier attempt at the same cell?
    // Run indices are reused on retry, so stem collisions are normal, not exceptional. Comparing the
    // manifest's originalDir is what distinguishes "already done" from "stale copy of a dead attempt".
    let sameRun = false;
    try {
      sameRun = JSON.parse(fs.readFileSync(path.join(dest, '_ARCHIVE.json'), 'utf-8')).originalDir === run.dir;
    } catch { /* no manifest / unreadable — treat as stale and re-archive */ }
    if (sameRun) { skipped++; continue; }
    fs.rmSync(dest, { recursive: true, force: true });
    replaced++;
  }
  if (!run.dir || !fs.existsSync(run.dir)) {
    console.log(`MISSING  ${stem} — tree is gone (${run.dir})`);
    missing++;
    continue;
  }

  const { files, bytes } = copyTree(run.dir, dest);
  // A manifest, so an archived tree still knows what produced it even if the run JSON is separated
  // from it later.
  fs.writeFileSync(path.join(dest, '_ARCHIVE.json'), JSON.stringify({
    archivedAt: new Date().toISOString(),
    originalDir: run.dir,
    task: run.task, arm: run.arm, model: run.model, run: run.run,
    strataBuild: run.strataBuild ?? null,
    turns: run.turns, costUsd: run.costUsd,
    deliveredRecalls: run.deliveredRecalls ?? [],
    verifyResult: run.verifyResult ?? null,
    note: 'node_modules excluded — reinstallable, not evidence.',
  }, null, 2));

  totalBytes += bytes;
  archived++;
  console.log(`archived ${stem.padEnd(34)} ${String(files).padStart(4)} files  ${(bytes / 1024).toFixed(0)} KB`);
}

console.log(`\n${archived} archived, ${skipped} already present, ${replaced} replaced (stale attempt),`
  + ` ${stubs} skipped (no report — not evidence), ${missing} lost`
  + ` — ${(totalBytes / 1048576).toFixed(2)} MB into ${path.relative(process.cwd(), treesDir)}`);
if (missing) console.log('A "lost" tree cannot be regenerated. Archive earlier next time.');
