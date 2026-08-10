#!/usr/bin/env node
'use strict';
/**
 * Guarantee the recall library never reaches the public repo.
 *
 * THIS SCRIPT USED TO DO THE OPPOSITE, and the inversion is the whole point of the file now.
 *
 * `recalls/` holds 7,000+ directories from an abandoned npm-scraping experiment plus the admitted
 * library. The original design shipped the admitted recalls in git and quarantined the rest, so this
 * script DERIVED an allowlist — excluding `recalls/*` and then re-including each admitted recall by
 * name, ancestor by ancestor. That allowlist was correct for the design it was written for.
 *
 * The design changed on 2026-07-31: **recalls live ONLY on the hub, never in git and never in npm.**
 * Implementations are the thing worth protecting, and keeping them server-side is also what lets the
 * library grow without shipping a client update. Under that decision the generated allowlist was no
 * longer a safeguard — it was the leak. It named all 21 admitted recalls and re-included every one of
 * them, so the first `git push` would have published the entire library. The block was generated on
 * 22 July and the decision was made on 31 July; nothing had re-derived it in between, and nothing
 * would have failed loudly if it hadn't been caught.
 *
 * So the derivation is inverted. There is no allowlist. `recalls/` is excluded whole, and --check
 * asserts it against git itself rather than against the text of this file — a correct-looking
 * .gitignore does not prove an earlier `git add -f` didn't already track something.
 *
 *   node scripts/sync-gitignore.js          # rewrite the block
 *   node scripts/sync-gitignore.js --check  # exit 1 if the block is stale OR a recall is tracked
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GITIGNORE = path.join(ROOT, '.gitignore');

const BEGIN = '# >>> BEGIN generated recall exclusion — edit scripts/sync-gitignore.js, not this block';
const END = '# <<< END generated recall exclusion';

// The marker the allowlist era used. Kept so this script can migrate a .gitignore written by the
// previous version of itself, instead of appending a second block beside the one that leaks.
const LEGACY_BEGIN = '# >>> BEGIN generated recall allowlist — edit scripts/sync-gitignore.js, not this block';
const LEGACY_END = '# <<< END generated recall allowlist';

function buildBlock() {
  return [
    BEGIN,
    '# The recall library is served from the hub and is NOT part of this repository. Everything under',
    '# recalls/ stays local: the admitted recalls (their implementations are the project\'s actual IP)',
    '# and the quarantined npm-scrape junkyard alike. No exceptions, no re-included paths — a single',
    '# `!` line here would put an implementation on GitHub permanently.',
    '/recalls/',
    END,
  ].join('\n');
}

function findBlock(text, begin, end) {
  const i = text.indexOf(begin);
  const j = text.indexOf(end);
  return (i === -1 || j === -1 || j < i) ? null : text.slice(i, j + end.length);
}

/** Recalls that git is ALREADY tracking. .gitignore does not apply to tracked files. */
function trackedRecalls() {
  const r = spawnSync('git', ['ls-files', 'recalls/', 'cache/verified-recalls.json'], {
    cwd: ROOT, encoding: 'utf-8',
  });
  if (r.status !== 0) return [];               // not a git repo yet, or git unavailable
  return (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
}

const text = fs.readFileSync(GITIGNORE, 'utf-8');
const wanted = buildBlock();
const existing = findBlock(text, BEGIN, END);
const legacy = findBlock(text, LEGACY_BEGIN, LEGACY_END);

if (process.argv.includes('--check')) {
  const problems = [];
  if (existing !== wanted) {
    problems.push('.gitignore recall exclusion is STALE — run: node scripts/sync-gitignore.js');
  }
  if (legacy !== null) {
    problems.push('.gitignore still contains the LEGACY allowlist block, which re-includes admitted '
      + 'recalls — run: node scripts/sync-gitignore.js');
  }
  const tracked = trackedRecalls();
  if (tracked.length) {
    problems.push(`git is TRACKING ${tracked.length} recall file(s) — .gitignore cannot help here, `
      + `they must be removed from the index:\n  git rm --cached -r recalls/\n  first few: `
      + tracked.slice(0, 5).join(', '));
  }
  if (!problems.length) { console.log('recalls are excluded from the repo, and none are tracked'); process.exit(0); }
  for (const p of problems) console.error(p);
  process.exit(1);
}

let next;
if (existing !== null) {
  next = text.replace(existing, wanted);
} else if (legacy !== null) {
  next = text.replace(legacy, wanted);
} else {
  const stripped = text
    .split('\n')
    .filter(l => !/^!?\/recalls\//.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  next = stripped.trimEnd() + '\n\n' + wanted + '\n';
}

fs.writeFileSync(GITIGNORE, next);

const tracked = trackedRecalls();
if (tracked.length) {
  console.error(`.gitignore synced, BUT git already tracks ${tracked.length} recall file(s). `
    + 'Ignoring a tracked file does nothing — run: git rm --cached -r recalls/');
  process.exit(1);
}
console.log('.gitignore synced — recalls/ is excluded whole; the library ships from the hub only');
