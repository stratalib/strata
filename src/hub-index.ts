/**
 * HUB INDEX SYNC — the client half of "the library lives in the cloud".
 *
 * THE BUG THIS EXISTS TO FIX, because it would have shipped:
 *
 * package.json's `files` field publishes dist/, templates/, README and LICENSE. It deliberately does
 * NOT publish recalls/ or cache/verified-recalls.json — recalls are served from the hub, never from
 * npm. But SELECTION reads that local index, in every mode. So a real `npm i stratalib` install had a
 * library of exactly zero recalls, and every task fell through to the honest-miss message:
 *
 *     [strata] WARNING: no verified-recalls.json — running in LEGACY mode
 *     [strata] Loaded 0 recalls
 *     → "No verified Strata recall covers ... Build it from scratch the normal way."
 *
 * Measured on 2026-07-31 by running the real server out of a tree containing only the published files.
 * The failure is silent and it wears a disguise: declining is NORMAL, designed behaviour, so a totally
 * dead install is indistinguishable from a library that simply had no match. Nobody would have filed a
 * bug; they would have concluded Strata never has anything.
 *
 * WHY A SYNC AND NOT A LOOKUP: selection scores the whole index and must stay local and instant. Two
 * benchmark runs were already lost to a 3.4s startup stall that made the server look offline — the
 * session gave up and wrote everything from scratch, and still got counted as a Strata result. A
 * network round-trip in front of every strata_use would reintroduce exactly that, break offline work,
 * and make our uptime the user's uptime. So: fetch once, cache on disk, serve every later start from
 * the cache and refresh in the background. server/hub.js's own architecture note specified this from
 * the beginning; only the client half was missing.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface HubIndexRecall {
  id: string;
  hash?: string;
  version?: string;
  layer?: number;
  [key: string]: unknown;
}

export interface HubIndex {
  generatedAt: string;
  count: number;
  recalls: HubIndexRecall[];
}

/** Not under the package directory: a global npx cache is wiped between runs, and re-downloading the
 *  index on every invocation is the stall this module exists to avoid. */
export const indexCachePath = path.join(os.homedir(), '.strata', 'index.json');

function isUsable(idx: unknown): idx is HubIndex {
  if (!idx || typeof idx !== 'object') return false;
  const r = (idx as HubIndex).recalls;
  return Array.isArray(r) && r.length > 0 && r.every(x => x && typeof x.id === 'string');
}

export function readCachedIndex(): HubIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexCachePath, 'utf-8'));
    return isUsable(parsed) ? parsed : null;
  } catch {
    return null;                        // absent or corrupt are the same thing to a caller
  }
}

export function writeCachedIndex(idx: HubIndex): void {
  try {
    fs.mkdirSync(path.dirname(indexCachePath), { recursive: true });
    // Write-then-rename: a process killed mid-write must not leave a truncated index that then parses
    // as "usable" with half the library missing. Losing recalls silently is this file's whole theme.
    const tmp = `${indexCachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx));
    fs.renameSync(tmp, indexCachePath);
  } catch {
    /* a read-only or full home directory degrades to re-fetching next start, which still works */
  }
}

/** Throws on any failure. Callers fall back to the cache, then to local recalls, then to honest-miss. */
export async function fetchHubIndex(hubUrl: string, timeoutMs = 10_000): Promise<HubIndex> {
  const url = `${hubUrl.replace(/\/$/, '')}/v1/index`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`hub index returned ${res.status}`);
  const body = await res.json();
  if (!isUsable(body)) throw new Error('hub index was empty or malformed');
  return body;
}

/**
 * The index a client should actually use, plus where it came from.
 *
 * Cache first and refresh in the BACKGROUND: a cached index is always good enough to select with, and
 * making startup wait on the network is the failure mode we are explicitly avoiding. `refreshing` is
 * exposed so tests can await the refresh instead of racing it.
 */
export function loadHubIndex(hubUrl: string): {
  index: HubIndex | null;
  source: 'cache' | 'none';
  refreshing: Promise<HubIndex | null>;
} {
  const cached = readCachedIndex();

  const refreshing = fetchHubIndex(hubUrl)
    .then(fresh => {
      if (!cached || fresh.generatedAt !== cached.generatedAt) writeCachedIndex(fresh);
      return fresh;
    })
    .catch(() => null);                 // offline is not an error when a cache exists

  return { index: cached, source: cached ? 'cache' : 'none', refreshing };
}
