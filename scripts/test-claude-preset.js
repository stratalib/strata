#!/usr/bin/env node
'use strict';
/**
 * Prove the CLAUDE.md preset is strictly additive.
 *
 * The promise made to users is narrow and absolute: Strata ADDS a block to your instructions file and
 * never rewrites what you wrote. That promise is worth exactly as much as the test behind it, so this
 * checks the property directly — every byte of the user's original text still present, in order —
 * rather than eyeballing the output.
 *
 * The adversarial cases are the point. A file that merely says "hello" proves nothing; a file
 * containing regex metacharacters, CRLF line endings, a half-written marker, and the literal string
 * `strata_use` is where a naive implementation corrupts data.
 *
 *   node scripts/test-claude-preset.js
 */
const assert = require('assert');
const path = require('path');

const M = require(path.join(__dirname, '..', 'dist', 'src', 'claude-preset.js'));
const { applyPreset, removePreset, verifyAdditive, presetBlock, PRESET_BEGIN, PRESET_END } = M;

let passed = 0;
const checks = [];
function check(name, fn) {
  try { fn(); checks.push(['PASS', name]); passed++; }
  catch (e) { checks.push(['FAIL', `${name} — ${e.message}`]); }
}

/** The property under test: nothing the user wrote may be lost or reordered. */
function assertUserBytesIntact(before, after, label) {
  if (!before) return;
  assert.ok(after.includes(before),
    `${label}: user's original text is no longer present verbatim`);
  assert.ok(verifyAdditive(before, after),
    `${label}: verifyAdditive() rejected the result`);
}

/**
 * Count OUR blocks, by matching the exact block text.
 *
 * Counting bare `PRESET_BEGIN` markers is wrong and the adversarial suite proves it: a user who pasted
 * our begin marker into their own notes has one in their file legitimately, and preserving it is the
 * whole promise. A marker occurrence is not a block.
 */
function blockCount(text) {
  return text.split(presetBlock()).length - 1;
}

// ── 1. No file yet ───────────────────────────────────────────────────────────
check('creates the block when no file exists', () => {
  const r = applyPreset(null);
  assert.strictEqual(r.action, 'created');
  assert.ok(r.text.includes(PRESET_BEGIN) && r.text.includes(PRESET_END));
});

check('empty file is treated as create, not append', () => {
  assert.strictEqual(applyPreset('').action, 'created');
});

// ── 2. Ordinary user file ────────────────────────────────────────────────────
const USER = `# My Project Rules

Always use tabs. Never use semicolons.

## Deploy
Run \`make ship\`. Ask me first.
`;

check('appends to an existing file without touching it', () => {
  const r = applyPreset(USER);
  assert.strictEqual(r.action, 'appended');
  assertUserBytesIntact(USER, r.text, 'append');
  assert.ok(r.text.indexOf(USER) === 0, 'user content must remain at the top, unmoved');
});

// ── 3. Idempotency ───────────────────────────────────────────────────────────
check('running twice changes nothing the second time', () => {
  const once = applyPreset(USER).text;
  const twice = applyPreset(once);
  assert.strictEqual(twice.action, 'unchanged');
  assert.strictEqual(twice.text, once, 'second run must be a byte-for-byte no-op');
});

check('ten runs produce exactly one block', () => {
  let t = USER;
  for (let i = 0; i < 10; i++) t = applyPreset(t).text;
  const n = blockCount(t);
  assert.strictEqual(n, 1, `expected 1 block, found ${n}`);
  assertUserBytesIntact(USER, t, 'ten runs');
});

// ── 4. Stale preset gets refreshed in place ──────────────────────────────────
check('a stale block is replaced, not duplicated', () => {
  const stale = `${USER}\n${PRESET_BEGIN}\nOLD AND WRONG ADVICE\n${PRESET_END}\n`;
  const r = applyPreset(stale);
  assert.strictEqual(r.action, 'updated');
  assert.ok(!r.text.includes('OLD AND WRONG ADVICE'), 'stale body must be gone');
  assert.strictEqual(blockCount(r.text), 1);
  assertUserBytesIntact(USER, r.text, 'stale');
});

check('content AFTER the block survives an update', () => {
  const tail = '\n## My own notes below\nkeep me\n';
  const withTail = `${USER}\n${PRESET_BEGIN}\nOLD\n${PRESET_END}${tail}`;
  const r = applyPreset(withTail);
  assert.ok(r.text.includes('## My own notes below'), 'trailing user content was dropped');
  assert.ok(r.text.includes('keep me'));
});

// ── 5. Legacy block migration ────────────────────────────────────────────────
check('the pre-1.1 block is migrated, not duplicated', () => {
  const legacy = `${USER}\n<!-- strata-instructions -->\n## Strata\nRunning it is the fastest way to find out whether any of it is wrong.\n<!-- /strata-instructions -->\n`;
  const r = applyPreset(legacy);
  assert.strictEqual(r.action, 'migrated');
  assert.ok(!r.text.includes('<!-- strata-instructions -->'), 'legacy marker must be gone');
  assert.ok(!r.text.includes('fastest way to find out'), 'the re-verify instruction must be gone');
  assert.strictEqual(blockCount(r.text), 1);
  assertUserBytesIntact(USER, r.text, 'migrate');
});

// ── 6. Removal ───────────────────────────────────────────────────────────────
check('removal leaves the user file intact', () => {
  const withBlock = applyPreset(USER).text;
  const { text, removed } = removePreset(withBlock);
  assert.ok(removed);
  assert.ok(!text.includes(PRESET_BEGIN));
  assert.ok(text.includes('Always use tabs'), 'user content lost on removal');
  assert.ok(text.includes('Run `make ship`'), 'user content lost on removal');
});

check('removal on a file without the block is a no-op', () => {
  const { text, removed } = removePreset(USER);
  assert.strictEqual(removed, false);
  assert.strictEqual(text, USER);
});

check('add → remove differs from the original ONLY by trailing whitespace', () => {
  // The deliberate trade: we leave the separator newline rather than trim whitespace we cannot prove
  // we authored. What must never happen is losing a byte, so assert exactly that.
  const round = removePreset(applyPreset(USER).text).text;
  assert.ok(round.startsWith(USER), 'the original must survive unchanged as a prefix');
  assert.strictEqual(round.replace(/\s+$/, ''), USER.replace(/\s+$/, ''),
    'add→remove changed something other than trailing whitespace');
  assert.ok(round.length >= USER.length, 'removal must never shorten the user file');
});

check('repeated add/remove cycles never lose content', () => {
  let t = USER;
  for (let i = 0; i < 5; i++) t = removePreset(applyPreset(t).text).text;
  assert.ok(t.startsWith(USER), 'user content lost across cycles');
  assert.strictEqual(t.replace(/\s+$/, ''), USER.replace(/\s+$/, ''));
});

// ── 7. Adversarial content ───────────────────────────────────────────────────
const NASTY = [
  ['regex metacharacters', 'Use /^(a|b)+$/ and [\\d{2,3}] and $1 \\n literals.\n'],
  ['CRLF line endings', '# Windows\r\n\r\nUse CRLF here.\r\n'],
  ['mentions strata_use', 'Note: do not call strata_use on Fridays.\n'],
  ['a half-written marker', 'I once pasted <!-- strata:preset:begin --> alone with no end marker.\n'],
  ['unicode and emoji', '# Règles — 日本語 — 🚀\n\nGarder ça.\n'],
  ['no trailing newline', '# No newline at EOF'],
  ['many trailing newlines', '# Spaced out\n\n\n\n\n'],
  ['looks like a code fence', '```md\n<!-- strata:preset:end -->\n```\n'],
];

for (const [label, body] of NASTY) {
  check(`survives: ${label}`, () => {
    const r = applyPreset(body);
    assertUserBytesIntact(body, r.text, label);
    // and is still idempotent on that content
    const again = applyPreset(r.text);
    assert.strictEqual(again.action, 'unchanged',
      `second pass must be a no-op, got ${again.action}`);
    assert.strictEqual(again.text, r.text, 'second pass changed the file');
    assert.strictEqual(blockCount(r.text), 1, 'exactly one block must exist');
  });
}

check('trailing blank lines are never trimmed', () => {
  const spaced = '# Spaced out\n\n\n\n\n';
  const r = applyPreset(spaced);
  assert.ok(r.text.startsWith(spaced), 'existing trailing newlines were altered');
});

// ── 8. The block itself says the right thing ─────────────────────────────────
check('the block does not instruct the model to re-run the verifier', () => {
  const b = presetBlock();
  assert.ok(!/fastest way to find out/i.test(b));
  assert.ok(!/\brun it\b/i.test(b), 'must not direct the model to run the verifier');
});

/**
 * Measured 2026-08-16 (catalog/haiku/n=3): mentioning the verifier here at all — even factually, even
 * only that the result is "reproducible" — put 2 of 3 sessions into re-verifying a 15/15 PASS, one of
 * them booting the server on four ports. The control, whose text mentioned none of it, re-verified
 * zero times. These assertions exist so that finding cannot be undone by a well-meaning rewrite.
 */
check('the block never points at the verifier', () => {
  const b = presetBlock();
  // Naming the verifier or its reproducibility is what put 2 of 3 sessions into re-running a 15/15
  // PASS. Note this bans "verifier"/"verification", NOT the word "verified" describing the modules —
  // that clause is provenance and is required by the check below.
  for (const w of [/verifier/i, /verification/i, /reproducib/i, /\bchecks? passed\b/i]) {
    assert.ok(!w.test(b), `must not mention ${w} — it invites re-running the verifier`);
  }
});

check('the block does not invite reading the delivered code', () => {
  const b = presetBlock();
  assert.ok(!/read as much/i.test(b));
  assert.ok(!/\bread it\b/i.test(b));
  assert.ok(!/stakes of the task/i.test(b));
});

/**
 * The load-bearing clause, kept by measurement rather than taste.
 *
 * Removing it (cell C, 2026-08-16) took Bash from 1.0 to 7.3 and cost from $0.077 to $0.115: without a
 * word for WHAT the delivered files are, sessions treat them as unexplained code and go looking. This
 * is the audit-inversion result in miniature — provenance is what stops the audit.
 */
check('the block states provenance', () => {
  const b = presetBlock();
  assert.ok(/pre-built/i.test(b), 'must say the modules are pre-built');
  assert.ok(/verified/i.test(b), 'must say the modules are verified');
});

check('the block does not editorialise about trustworthiness', () => {
  const b = presetBlock();
  for (const w of [/black box/i, /\bsafe\b/i, /\bmeasured judgement\b/i, /don't worry/i]) {
    assert.ok(!w.test(b), `must not editorialise (${w})`);
  }
});

check('the block stays short', () => {
  const words = presetBlock().split(/\s+/).length;
  assert.ok(words < 130, `preset is ${words} words — every extra sentence is re-billed each turn`);
});

check('the block does not tell the model to skip checking', () => {
  const b = presetBlock();
  // The opposite failure: "trust me, do not verify" is the supply-chain smell that got Strata
  // flagged twice. State what ran; never issue an instruction about the model's judgement.
  assert.ok(!/do not (verify|check|read)/i.test(b));
  assert.ok(!/no need to (verify|check)/i.test(b));
  assert.ok(!/trust\b/i.test(b));
});

check('the block states there is exactly one tool', () => {
  const b = presetBlock();
  assert.ok(b.includes('strata_use'));
  assert.ok(/one tool/i.test(b));
  assert.ok(!/strata_signal|strata_list|strata_imprint/.test(b),
    'must not name tools that no longer exist');
});

// ── report ───────────────────────────────────────────────────────────────────
console.log('\n  CLAUDE.md preset — additive guarantee\n');
for (const [status, name] of checks) {
  console.log(`  ${status === 'PASS' ? 'PASS ' : 'FAIL '} ${name}`);
}
console.log(`\n  ${passed}/${checks.length} checks passed\n`);
process.exit(passed === checks.length ? 0 : 1);
