import fs from 'fs';
import path from 'path';
import { SearchEntry } from './peer-server.js';
import { startHubServer, generateApiKey, listApiKeys, revokeApiKey } from './hub-server.js';

// ─── Library loading ──────────────────────────────────────────────────────────

interface IndexEntry {
  id: string;
  name: string;
  domain: string;
  lineCount: number;
  tags: string[];
  path: string;
}

interface LibraryIndex {
  stats: { totalSnippets: number; totalCodes: number; totalSystems: number; totalRecalls: number };
  snippets: IndexEntry[];
  codes: IndexEntry[];
  searchIndex: SearchEntry[];
}

const recallsDir = path.join(__dirname, '..', '..', 'recalls');
const indexPath = path.join(recallsDir, 'library-index.json');

let rawIndex: LibraryIndex;
try {
  rawIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
} catch (e) {
  console.error('[strata-hub] Failed to load library-index.json:', e);
  process.exit(1);
}

const searchMap = new Map<string, SearchEntry>();
for (const entry of rawIndex.searchIndex) searchMap.set(entry.id, entry);

const pathMap = new Map<string, string>();
for (const entry of [...rawIndex.snippets, ...rawIndex.codes]) {
  if (!pathMap.has(entry.id)) pathMap.set(entry.id, entry.path);
}

console.log(`[strata-hub] Loaded ${searchMap.size} recalls`);

// ─── CLI commands ─────────────────────────────────────────────────────────────

const command = process.argv[2];

if (command === 'key:add') {
  const label = process.argv[3] || 'unnamed';
  const limit = parseInt(process.argv[4] || '200', 10);
  const key = generateApiKey(label, limit);
  console.log(`\nAPI key created for "${label}" (limit: ${limit}/day):\n\n  ${key}\n`);
  process.exit(0);
}

if (command === 'key:list') {
  const keys = listApiKeys();
  if (keys.length === 0) {
    console.log('No API keys found. Use: node hub-main.js key:add <label>');
  } else {
    console.log('\nAPI Keys:');
    for (const k of keys) {
      console.log(`  ${k.label.padEnd(20)} limit: ${k.dailyLimit}/day   created: ${k.createdAt.split('T')[0]}   ${k.key.slice(0, 16)}...`);
    }
    console.log();
  }
  process.exit(0);
}

if (command === 'key:revoke') {
  const key = process.argv[3];
  if (!key) { console.error('Usage: node hub-main.js key:revoke <key>'); process.exit(1); }
  const ok = revokeApiKey(key);
  console.log(ok ? 'Key revoked.' : 'Key not found.');
  process.exit(0);
}

// ─── Start server ─────────────────────────────────────────────────────────────

const port = parseInt(process.env.HUB_PORT || '7338', 10);
startHubServer(port, recallsDir, searchMap, pathMap);
