import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * RECALL REQUESTS — the honest-miss capture loop, stored per-USER, captured DETERMINISTICALLY.
 *
 * The first version asked the MODEL to notice a miss, ask the user, and hand-write a request file. In a
 * real session that never happened: the model was mid-build and skipped the paperwork, so the folder
 * stayed empty. That was the wrong design — Strata already HAS everything a request needs (the task and
 * the capabilities it just decomposed), so making the LLM re-produce it is the exact anti-pattern Strata
 * exists to kill. Capture is code's job, not the model's.
 *
 * So now: on any miss/decline, Strata itself writes a gap file, immediately, from data in hand. Stored
 * per-user, never in the project:
 *
 *   ~/.strata/config.json      preferences (see RequestPrefs)
 *   ~/.strata/requests/        one Markdown gap per missed task — the queue the swarm will drain
 *
 * Consent (asked once at install) controls the behaviour, not whether capture is reliable:
 *   always  — record silently.
 *   ask     — record, and tell the model to mention it so the user can veto (delete the file).
 *   never   — do not record at all.
 *
 * Nothing leaves the machine; `~/.strata/requests/` is local. Nothing touches the user's project or any
 * file they authored.
 */

function strataHome(): string { return path.join(os.homedir(), '.strata'); }
function requestsDir(): string { return path.join(strataHome(), 'requests'); }
function configPath(): string { return path.join(strataHome(), 'config.json'); }

export type RecallRequestMode = 'ask' | 'always' | 'never';

export interface RequestPrefs {
  /** ask = record + tell the user; always = record silently; never = don't record. */
  recallRequests: RecallRequestMode;
  /** Gaps recorded while in "ask" mode — drives the offer to switch to silent ("always"). */
  askApprovals: number;
}

const DEFAULT_PREFS: RequestPrefs = { recallRequests: 'ask', askApprovals: 0 };
const PROMOTE_AFTER = 3;   // after this many recorded gaps in "ask" mode, offer to go silent

export function loadPrefs(): RequestPrefs {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    const mode: RecallRequestMode =
      c.recallRequests === 'always' || c.recallRequests === 'never' ? c.recallRequests : 'ask';
    return { recallRequests: mode, askApprovals: Number.isFinite(c.askApprovals) ? c.askApprovals : 0 };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(c: RequestPrefs): void {
  try {
    fs.mkdirSync(strataHome(), { recursive: true });
    // MERGE, never overwrite. config.json is SHARED — it also holds mode, hub, provider,
    // globalActivation (written by the CLI). Writing only our two fields would silently delete the rest.
    let full: Record<string, unknown> = {};
    try { full = JSON.parse(fs.readFileSync(configPath(), 'utf-8')); } catch { /* first write */ }
    full.recallRequests = c.recallRequests;
    full.askApprovals = c.askApprovals;
    fs.writeFileSync(configPath(), JSON.stringify(full, null, 2) + '\n');
  } catch { /* a preferences write must never break a delivery */ }
}

/** A short, safe filename slug derived from the task. */
export function slugForTask(task: string): string {
  const s = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'recall-request';
}

/** The gap file Strata writes. Everything here is data Strata already has — no model needed. */
function gapMarkdown(task: string, capabilities: string[], projectDir: string): string {
  const caps = capabilities.length
    ? capabilities.map(c => `  - ${c}`).join('\n')
    : '  - (none decomposed)';
  return (
    `---\n` +
    `task: ${JSON.stringify(task)}\n` +
    `capabilities:\n${caps}\n` +
    `source: ${JSON.stringify(path.resolve(projectDir))}\n` +
    `capturedAt: ${new Date().toISOString()}\n` +
    `status: gap — awaiting drafting by the recall factory\n` +
    `---\n\n` +
    `# Recall request (auto-captured on a miss)\n\n` +
    `## What Strata was asked for\n${task}\n\n` +
    `## Capabilities it decomposed\n${capabilities.map(c => `- ${c}`).join('\n') || '- (none)'}\n\n` +
    `## To be drafted by the recall factory\n` +
    `- **Exports:** the reusable functions this module should provide.\n` +
    `- **Edge cases it must handle:** the hostile inputs and failure modes that make it trustworthy\n` +
    `  (empty, null, malformed, concurrent, oversized, timeouts, ...).\n` +
    `- **Example usage:** how a caller wires it in.\n`
  );
}

/**
 * Record a missed task as a gap. Deterministic and idempotent: the same task (by content hash) is only
 * recorded once. Returns a short note for the response, and whether a new gap was written.
 *
 * This is the whole capture — it does NOT depend on the model doing anything.
 */
export function captureMiss(
  prefs: RequestPrefs,
  task: string,
  capabilities: string[],
  projectDir: string,
): { note: string; captured: boolean } {
  if (prefs.recallRequests === 'never') return { note: '', captured: false };

  const dir = requestsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  // Dedup by task content: <slug>-<hash6>.md. Same task twice = one gap.
  const hash6 = crypto.createHash('sha1').update(task).digest('hex').slice(0, 6);
  const file = path.join(dir, `${slugForTask(task)}-${hash6}.md`);

  const alreadyHad = fs.existsSync(file);
  if (!alreadyHad) {
    try { fs.writeFileSync(file, gapMarkdown(task, capabilities, projectDir)); }
    catch { return { note: '', captured: false }; }   // a failed record must never break the miss

    // Count only genuinely new gaps in "ask" mode, for the promote-to-silent offer.
    if (prefs.recallRequests === 'ask') {
      savePrefs({ ...prefs, askApprovals: prefs.askApprovals + 1 });
      prefs = { ...prefs, askApprovals: prefs.askApprovals + 1 };
    }
  }

  // Already recorded earlier — say nothing, do nothing.
  if (alreadyHad) return { note: '', captured: false };

  const head = `\n\n— Growing the library —\n`;

  if (prefs.recallRequests === 'always') {
    return {
      captured: true,
      note: head + `Strata logged this gap to ${file} so the missing module can be built into the `
        + `library later. It stays on your machine.`,
    };
  }

  // ask mode: record + let the user know, so they can veto.
  const promote = prefs.askApprovals >= PROMOTE_AFTER
    ? ` Strata has recorded ${prefs.askApprovals} gaps this way; if the user would like it to do so `
      + `silently from now on, set "recallRequests": "always" in ${configPath()}.`
    : '';
  return {
    captured: true,
    note: head + `Strata logged this gap to ${file} to help grow the library (it stays on your machine). `
      + `Let the user know, and delete that file if they'd rather it not be recorded — set `
      + `"recallRequests": "never" in ${configPath()} to stop recording gaps entirely.${promote}`,
  };
}
