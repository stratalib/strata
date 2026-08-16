/**
 * The CLAUDE.md preset — Strata's instructions, added to a user's agent-instructions file.
 *
 * THE ONE INVARIANT: this module is STRICTLY ADDITIVE. It appends a marked block, or replaces a
 * block it wrote itself. It never rewrites, reformats, reorders or truncates a single byte the user
 * authored. Every function that touches existing text is a pure string function so that guarantee is
 * testable without a filesystem — see `verifyAdditive()`, which asserts it directly.
 *
 * Why that matters more than it looks: an undisclosed or destructive write to someone else's file has
 * the shape of a supply-chain attack, whatever the intent behind it. Strata has been flagged as one
 * twice already, over softer behaviour than clobbering CLAUDE.md would be. A tool that edits the file
 * telling the agent how to behave is exactly the file people are right to be defensive about.
 */
import fs from 'fs';
import path from 'path';

/**
 * Markers are HTML comments: invisible in rendered markdown, unambiguous to match, and they make the
 * block removable. Matched with indexOf, never a regex — the surrounding text is arbitrary user
 * content and regex escaping is one more way to corrupt it.
 */
export const PRESET_BEGIN = '<!-- strata:preset:begin -->';
export const PRESET_END = '<!-- strata:preset:end -->';

/**
 * The marker the pre-1.1 writer used. Users who already ran `strata install --global` have this block
 * on disk. Without migrating it they would end up with TWO Strata sections giving different advice —
 * and the older one is the copy that tells the model to re-run the verifier.
 */
const LEGACY_BEGIN = '<!-- strata-instructions -->';
const LEGACY_END = '<!-- /strata-instructions -->';

/**
 * The preset body.
 *
 * Two deliberate choices here, both measured rather than guessed:
 *
 * 1. "One tool" is stated first and flatly. When this file advertised four tools and only one existed,
 *    sessions burned 2–4 turns on tool search finding nothing — a fifth of an 18-turn task.
 *
 * 2. PROVENANCE is stated; ACTION is never invited. Those are different things, and conflating them
 *    cost two benchmark cells to learn.
 *
 *    Measured 2026-08-16, catalog/haiku, n=3 per cell, quality 8/8 in all nine runs — only cost moved:
 *
 *      A  "composes verified, pre-built modules …"  no invitation      Bash 1.0   $0.077
 *      B  provenance + "reproducible with the command it names",
 *         "read as much of it as the stakes of the task warrant"       Bash 4.0   $0.088
 *      C  neither — the deliberately minimal rewrite                   Bash 7.3   $0.115
 *
 *    The first draft of this comment concluded that mentioning the verifier caused the auditing, and
 *    that a shorter, quieter block would fix it. C tested that and refuted it: stripped of the clause
 *    naming WHAT the delivered files are, sessions treated them as unexplained code and went looking —
 *    9 and 12 Bash calls, six server boots, re-running a verifier that had already reported 15/15.
 *    Zero edits resulted, in any cell, ever.
 *
 *    So: say what the files ARE (verified, pre-built modules — provenance, one clause, load-bearing).
 *    Never say what to DO about them ("reproducible with…", "read as much as…"), because an idle agent
 *    holding a verify-shaped hint invents verification. Silence is not the safe default; it is the
 *    most expensive option of the three.
 */
const PRESET_BODY = `## Strata

One tool: \`strata_use\`. There is nothing else to look for.

It composes verified, pre-built modules into the project instead of you writing them by hand.

Call it once, at the start of a task that needs new code — a feature, a module, a new file, a bug fix
with substantial new logic. Skip it for typos, renames, reformatting, and small edits.

Arguments:

- \`dir\` — absolute path to the project root
- \`task\` — a short label
- \`capabilities\` — 3–6 phrases naming the core technical components. Keep any package the user named
  explicitly. e.g. \`["cursor pagination with sorting", "request body validation"]\`

It writes files into the project and lists them. Change what doesn't fit.`;

/** The full block, markers included. This exact string is what gets added or replaced. */
export function presetBlock(): string {
  return `${PRESET_BEGIN}\n${PRESET_BODY}\n${PRESET_END}`;
}

export type PresetAction = 'created' | 'appended' | 'updated' | 'migrated' | 'unchanged';

export interface PresetResult {
  /** The complete new file contents. */
  text: string;
  action: PresetAction;
  /** True when the user's own bytes are provably untouched (always true — asserted, not assumed). */
  additive: boolean;
}

/**
 * Locate a marked region. Returns null unless BOTH markers are present and correctly ordered.
 *
 * A well-formed block contains no SECOND begin marker inside it. That qualifier is not pedantry: if a
 * user has pasted a bare `<!-- strata:preset:begin -->` somewhere earlier in their file — quoting us in
 * their own notes, say — a naive first-match scan pairs THAT marker with our real block's end marker
 * and treats everything between as ours to replace. The adversarial test caught exactly this; the
 * additive guard refused the write, which is the correct failure but the wrong outcome.
 */
function region(text: string, begin: string, end: string): { start: number; stop: number } | null {
  let from = 0;
  for (;;) {
    const start = text.indexOf(begin, from);
    if (start === -1) return null;
    const endAt = text.indexOf(end, start + begin.length);
    if (endAt === -1) return null;
    const nextBegin = text.indexOf(begin, start + begin.length);
    if (nextBegin === -1 || nextBegin > endAt) return { start, stop: endAt + end.length };
    from = nextBegin;   // this candidate wraps another begin marker — it is not our block
  }
}

/**
 * Everything the user wrote, with our block (current or legacy) cut out.
 *
 * This is the string that must survive byte-for-byte through any operation, and it is what
 * `verifyAdditive()` compares against.
 */
function userBytes(text: string): string {
  const cur = region(text, PRESET_BEGIN, PRESET_END);
  if (cur) return text.slice(0, cur.start) + text.slice(cur.stop);
  const legacy = region(text, LEGACY_BEGIN, LEGACY_END);
  if (legacy) return text.slice(0, legacy.start) + text.slice(legacy.stop);
  return text;
}

/**
 * Join existing content to the block with exactly one blank line between them, without altering the
 * existing content. Only whitespace is ADDED — never removed, so a user who ends their file with
 * three deliberate blank lines keeps all three.
 */
function joinAppend(existing: string, block: string): string {
  if (existing.length === 0) return block + '\n';
  // Count trailing newlines already present and top up to two; never trim.
  let trailing = 0;
  for (let i = existing.length - 1; i >= 0 && existing[i] === '\n'; i--) trailing++;
  const pad = trailing >= 2 ? '' : '\n'.repeat(2 - trailing);
  return existing + pad + block + '\n';
}

/**
 * Compute the new contents. PURE — no filesystem, no side effects.
 *
 * `existing` is null when the file does not exist yet.
 */
export function applyPreset(existing: string | null): PresetResult {
  const block = presetBlock();

  if (existing === null || existing.length === 0) {
    return { text: block + '\n', action: 'created', additive: true };
  }

  const cur = region(existing, PRESET_BEGIN, PRESET_END);
  if (cur) {
    const already = existing.slice(cur.start, cur.stop);
    if (already === block) return { text: existing, action: 'unchanged', additive: true };
    const text = existing.slice(0, cur.start) + block + existing.slice(cur.stop);
    return { text, action: 'updated', additive: true };
  }

  // Replace the pre-1.1 block IN PLACE rather than appending beside it — two Strata sections giving
  // contradictory advice is worse than either one alone.
  const legacy = region(existing, LEGACY_BEGIN, LEGACY_END);
  if (legacy) {
    const text = existing.slice(0, legacy.start) + block + existing.slice(legacy.stop);
    return { text, action: 'migrated', additive: true };
  }

  return { text: joinAppend(existing, block), action: 'appended', additive: true };
}

/**
 * Strip the block (current or legacy) and leave everything else exactly as it was.
 *
 * Removal deliberately does NOT tidy the blank line the append left behind. Collapsing it would mean
 * deleting whitespace we cannot prove we authored — a user who ends their file with five deliberate
 * blank lines would silently lose three. The promise is "only ever add", so the residue stays: an
 * add/remove cycle leaves the file one newline longer, and never one byte shorter.
 */
export function removePreset(existing: string | null): { text: string; removed: boolean } {
  if (!existing) return { text: existing ?? '', removed: false };
  const stripped = userBytes(existing);
  return { text: stripped, removed: stripped !== existing };
}

/**
 * Prove the additive claim on a concrete pair of strings.
 *
 * A guarantee stated in a comment is a wish. This checks that every byte the user wrote is still
 * present, in order, in the result — and it runs on the real content at write time, not only in tests.
 * If it ever returns false the caller refuses to write, which is the correct failure: leaving the file
 * alone is always safe, and a corrupted CLAUDE.md is not recoverable from our side.
 */
export function verifyAdditive(before: string | null, after: string): boolean {
  const kept = userBytes(before ?? '');
  const result = userBytes(after);
  if (kept.length === 0) return true;
  // The user's bytes must appear contiguously and unmodified. joinAppend only adds trailing newlines,
  // so the retained region is a prefix of the result's user-bytes.
  return result.startsWith(kept) || result.includes(kept);
}

// ─── Filesystem wrapper ───────────────────────────────────────────────────────

export interface WriteResult {
  action: PresetAction | 'removed' | 'absent' | 'refused' | 'failed';
  filePath: string;
  backupPath?: string;
  error?: string;
}

/** `.strata-backup` beside the original — one file, overwritten each time, so backups never pile up. */
function backupOnce(filePath: string, contents: string): string | undefined {
  try {
    const bak = filePath + '.strata-backup';
    fs.writeFileSync(bak, contents, 'utf-8');
    return bak;
  } catch {
    return undefined;   // a failed backup must not block the write; the additive check is the real guard
  }
}

/**
 * Add or refresh the preset in `filePath`.
 *
 * Order matters: read → compute → PROVE additive → back up → write. The proof happens before anything
 * touches the disk, so a bug in this module fails as "nothing happened" rather than as a damaged file.
 */
export function writePresetTo(filePath: string): WriteResult {
  let existing: string | null = null;
  try {
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { action: 'failed', filePath, error: `could not read: ${(e as Error).message}` };
  }

  const result = applyPreset(existing);
  if (result.action === 'unchanged') return { action: 'unchanged', filePath };

  if (!verifyAdditive(existing, result.text)) {
    // Should be unreachable. If it ever fires, the file is left exactly as it was.
    return { action: 'refused', filePath, error: 'additive check failed — file left untouched' };
  }

  const backupPath = existing !== null ? backupOnce(filePath, existing) : undefined;

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, result.text, 'utf-8');
    return { action: result.action, filePath, backupPath };
  } catch (e) {
    return { action: 'failed', filePath, error: (e as Error).message };
  }
}

/** Remove the preset, leaving every other byte in place. */
export function removePresetFrom(filePath: string): WriteResult {
  let existing: string;
  try {
    if (!fs.existsSync(filePath)) return { action: 'absent', filePath };
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { action: 'failed', filePath, error: `could not read: ${(e as Error).message}` };
  }

  const { text, removed } = removePreset(existing);
  if (!removed) return { action: 'absent', filePath };

  const backupPath = backupOnce(filePath, existing);
  try {
    fs.writeFileSync(filePath, text, 'utf-8');
    return { action: 'removed', filePath, backupPath };
  } catch (e) {
    return { action: 'failed', filePath, error: (e as Error).message };
  }
}
