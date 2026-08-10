import crypto from 'crypto';
import { SearchEntry } from './peer-server.js';
import { CachedRecall } from './peer-cache.js';

const TIMEOUT_MS = 5000;

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json() as Promise<T>;
}

export async function checkPeerHealth(peerUrl: string): Promise<{ healthy: boolean; recalls?: number }> {
  try {
    const data = await fetchJson<{ recalls: number }>(
      `${peerUrl}/health`
    );
    return { healthy: true, recalls: data.recalls };
  } catch {
    return { healthy: false };
  }
}

export async function fetchPeerIndex(peerUrl: string): Promise<SearchEntry[]> {
  try {
    return await fetchJson<SearchEntry[]>(`${peerUrl}/index`);
  } catch {
    return [];
  }
}

export async function fetchRecallFromPeer(
  peerUrl: string,
  id: string
): Promise<CachedRecall | null> {
  try {
    const data = await fetchJson<{
      id: string;
      description: string;
      tags: string[];
      implementation: string;
      readme?: string;
      hash: string;
    }>(`${peerUrl}/recall/${encodeURIComponent(id)}`);

    // Verify integrity
    const computed = sha256(data.implementation);
    if (computed !== data.hash) {
      console.error(`[strata] Hash mismatch for "${id}" from ${peerUrl} — rejecting`);
      return null;
    }

    return {
      id: data.id,
      description: data.description,
      tags: data.tags,
      implementation: data.implementation,
      readme: data.readme,
      hash: data.hash,
      cachedAt: new Date().toISOString(),
      peer: peerUrl,
    };
  } catch {
    return null;
  }
}

export async function findRecallAcrossPeers(
  peers: string[],
  id: string
): Promise<CachedRecall | null> {
  for (const peer of peers) {
    const recall = await fetchRecallFromPeer(peer, id);
    if (recall) return recall;
  }
  return null;
}
