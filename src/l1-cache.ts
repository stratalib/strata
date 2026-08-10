import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface SelectionEntry {
  recallIds: string[];
  hitCount: number;
  firstSeen: string;
  lastUsed: string;
}

interface SelectionsFile {
  version: string;
  updated: string;
  entries: Record<string, SelectionEntry>;
}

// A cache HIT skips selection entirely — so a selection-logic fix is invisible to any capability
// combination that was already cached, and stays invisible (no expiry; LRU-evicted only past 500
// entries). The cache does not merely go stale, it CONFIDENTLY REPLAYS A KNOWN-WRONG ANSWER, and it
// does so with no error and no log line. That is the worst failure shape a cache can have.
//
// This used to be a hand-bumped integer, and it bit us TWICE:
//   - auth-strata-2 replayed a pre-fix selection (missing the password-hashing recall entirely)
//     hours after the DOMAIN_PRIORITY fix that should have caught it.
//   - a fix to GENERIC_EVIDENCE_TOKENS (stopwording "schema", to stop validation.request.v1 leaking
//     into the CSV task) ran, changed nothing, and the regression kept failing — because the integer
//     had already been bumped once that session, so the FIRST, buggy run's answer was cached under
//     the new version and served back forever.
//
// "Remember to bump the constant on every selection-logic change" is not a mechanism, it is a hope.
// So the version is now DERIVED: a hash of everything a selection depends on. Any change to it
// invalidates every entry automatically. It over-invalidates (an unrelated edit also resets the
// cache), and that is the correct direction to be wrong in: selection is pure in-memory scoring, so a
// miss costs microseconds, while a stale hit costs a silently wrong delivery.
//
// Selection output depends on TWO inputs, and both must be in the key:
//   1. the selection LOGIC (mcp-server.js) — scoring, thresholds, stopwords, DOMAIN_PRIORITY;
//   2. the AVAILABLE RECALL SET (verified-recalls.json) — the third bite of the same bug. Hashing only
//      the logic meant that ADDING a recall (api.idempotency.v1) did not invalidate the cache, so an
//      "idempotent writes" task cached before that recall existed would replay a result that could
//      never contain it. A new recall must be able to appear in an old capability's selection.
const SELECTION_LOGIC_VERSION: string = (() => {
  try {
    const h = crypto.createHash('sha1');
    // (1) the module that actually decides selection.
    h.update(fs.readFileSync(path.join(__dirname, 'mcp-server.js'), 'utf-8'));
    // (2) the allowlist — the set of recalls a selection is allowed to draw from. Its absence is fine
    // (dev before the cache is built); a present-but-changed file must move the key.
    try {
      const allowlistPath = path.join(__dirname, '..', '..', 'cache', 'verified-recalls.json');
      const allowRaw = fs.readFileSync(allowlistPath, 'utf-8');
      h.update(allowRaw);

      // (3) every admitted recall's METADATA. Tags and descriptions are what selection actually scores,
      // so editing them changes the right answer — but the key above would not move, and a warm cache
      // would replay the old selection forever. That is not hypothetical: `data.export.v1` shipped with
      // bare `csv`/`json` tags and was wrongly pulled into a CSV *import* task; fixing the tags changed
      // nothing until the cache was deleted by hand. A user would never have known to do that.
      //
      // Sorted for a stable digest, and cheap — 18 small JSON files, ~1ms, well inside the startup budget.
      const allow = JSON.parse(allowRaw) as { verified: string[]; paths: Record<string, string> };
      const root = path.join(__dirname, '..', '..');
      for (const id of [...allow.verified].sort()) {
        try {
          h.update(fs.readFileSync(path.join(root, allow.paths[id], 'metadata.json'), 'utf-8'));
        } catch { /* a recall listed but not on disk cannot affect selection anyway */ }
      }
    } catch { /* allowlist not found — logic hash alone still keys the cache */ }
    return h.digest('hex').slice(0, 12);
  } catch {
    // If we cannot read the logic, we cannot prove the cache is fresh — refuse to trust any entry.
    return `unknown-${Date.now()}`;
  }
})();

let selectionsMap = new Map<string, string[]>();
let _cacheDir = '';

/**
 * Identity of the recall set when it came from the HUB rather than from disk.
 *
 * (2) above hashes cache/verified-recalls.json to make "the library gained a recall" invalidate the
 * cache. An installed package has no such file — the recall set arrives over the network — so that
 * clause silently contributes nothing and the key collapses to the logic hash alone. That is exactly
 * the bug documented above, on its FOURTH appearance: a task cached today would keep replaying its
 * selection after the hub admits a recall that should now win, forever, with no error and no log line.
 * Worse than the disk version, because the hub is meant to add recalls without a client update — the
 * whole point of serving the library remotely.
 *
 * So the hub index's identity joins the key. Set before loadSelections() runs.
 */
let recallSetFingerprint = '';

export function setRecallSetFingerprint(fp: string): void {
  recallSetFingerprint = fp;
}

/** The version actually written to and compared against disk. */
function effectiveVersion(): string {
  return recallSetFingerprint
    ? `${SELECTION_LOGIC_VERSION}.${recallSetFingerprint}`
    : SELECTION_LOGIC_VERSION;
}

export function capKey(capabilities: string[]): string {
  return [...capabilities].sort().join('+');
}

export function loadSelections(cacheDir: string): void {
  _cacheDir = cacheDir;
  const filePath = path.join(cacheDir, 'selections.json');
  if (!fs.existsSync(filePath)) return;
  try {
    const data: SelectionsFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (data.version !== effectiveVersion()) {
      selectionsMap = new Map(); // selection logic moved on — every cached entry is suspect
      return;
    }
    selectionsMap = new Map(
      Object.entries(data.entries).map(([k, v]) => [k, v.recallIds])
    );
  } catch {
    selectionsMap = new Map();
  }
}

export function lookupSelection(capabilities: string[]): string[] | null {
  const key = capKey(capabilities);
  return selectionsMap.get(key) ?? null;
}

export function saveSelection(cacheDir: string, capabilities: string[], recallIds: string[]): void {
  const key = capKey(capabilities);
  const filePath = path.join(cacheDir, 'selections.json');

  let data: SelectionsFile = { version: effectiveVersion(), updated: '', entries: {} };
  try {
    if (fs.existsSync(filePath)) {
      const onDisk: SelectionsFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // Same invalidation as loadSelections: a version mismatch means the whole file is stale,
      // not just this one key — start this write from a clean slate instead of merging into it.
      if (onDisk.version === effectiveVersion()) data = onDisk;
    }
  } catch { /* start fresh */ }
  data.version = effectiveVersion();

  const now = new Date().toISOString();
  const existing = data.entries[key];
  data.entries[key] = {
    recallIds,
    hitCount: existing ? existing.hitCount + 1 : 0,
    firstSeen: existing ? existing.firstSeen : now,
    lastUsed: now,
  };
  data.updated = now;

  // In-memory first: a cache that cannot persist is still a perfectly good cache for this process.
  selectionsMap.set(key, recallIds);

  // The directory is NOT guaranteed to exist. cache/ is not in package.json's `files`, so an installed
  // package has no cache/ at all, and this line threw ENOENT out through the tool handler — turning
  // every strata_use call in every install into "Strata error: ... Write from scratch." A hard error,
  // on the happy path, from a write whose only job is to make the NEXT call faster.
  //
  // A global npx directory can also be read-only. Persisting the L1 cache is an optimisation; failing
  // to persist it must cost a few milliseconds next time, never the call in progress.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    if (!_warnedUnwritable) {
      _warnedUnwritable = true;
      console.error(`[strata] selection cache is not writable (${(e as Error).message}) — continuing `
        + 'in memory; selection will simply re-run on each start.');
    }
  }
}

let _warnedUnwritable = false;
