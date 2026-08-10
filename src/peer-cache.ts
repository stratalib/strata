import fs from 'fs';
import path from 'path';
import os from 'os';

export interface CachedRecall {
  id: string;
  description: string;
  tags: string[];
  implementation: string;
  readme?: string;
  hash: string;
  cachedAt: string;
  peer: string;
}

const cacheDir = path.join(os.homedir(), '.strata', 'cache');

function cacheFilePath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(cacheDir, `${safe}.json`);
}

export function cacheRecall(recall: CachedRecall): void {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  fs.writeFileSync(cacheFilePath(recall.id), JSON.stringify(recall, null, 2));
}

export function getCachedRecall(id: string): CachedRecall | null {
  const p = cacheFilePath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function isCached(id: string): boolean {
  return fs.existsSync(cacheFilePath(id));
}
