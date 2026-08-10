import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { SearchEntry } from './peer-server.js';

// ─── Key + usage storage ──────────────────────────────────────────────────────

const hubDir = path.join(os.homedir(), '.strata', 'hub');
const keysPath = path.join(hubDir, 'keys.json');
const usagePath = path.join(hubDir, 'usage.json');

interface KeyRecord {
  key: string;
  label: string;
  createdAt: string;
  dailyLimit: number;
}

interface UsageRecord {
  [key: string]: { date: string; count: number };
}

function ensureHubDir() {
  if (!fs.existsSync(hubDir)) fs.mkdirSync(hubDir, { recursive: true });
}

function loadKeys(): KeyRecord[] {
  if (!fs.existsSync(keysPath)) return [];
  try { return JSON.parse(fs.readFileSync(keysPath, 'utf-8')); } catch { return []; }
}

function loadUsage(): UsageRecord {
  if (!fs.existsSync(usagePath)) return {};
  try { return JSON.parse(fs.readFileSync(usagePath, 'utf-8')); } catch { return {}; }
}

function saveUsage(usage: UsageRecord): void {
  ensureHubDir();
  fs.writeFileSync(usagePath, JSON.stringify(usage, null, 2));
}

function checkRateLimit(key: string, limit: number): boolean {
  const usage = loadUsage();
  const today = new Date().toISOString().split('T')[0];
  const entry = usage[key];
  if (!entry || entry.date !== today) {
    usage[key] = { date: today, count: 1 };
    saveUsage(usage);
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  saveUsage(usage);
  return true;
}

function validateKey(apiKey: string): KeyRecord | null {
  return loadKeys().find(k => k.key === apiKey) || null;
}

// ─── Public: generate API key (run on the hub machine) ───────────────────────

export function generateApiKey(label: string, dailyLimit = 200): string {
  ensureHubDir();
  const key = 'sk-' + crypto.randomBytes(24).toString('hex');
  const keys = loadKeys();
  keys.push({ key, label, createdAt: new Date().toISOString(), dailyLimit });
  fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));
  return key;
}

export function listApiKeys(): KeyRecord[] {
  return loadKeys();
}

export function revokeApiKey(key: string): boolean {
  const keys = loadKeys();
  const filtered = keys.filter(k => k.key !== key);
  if (filtered.length === keys.length) return false;
  ensureHubDir();
  fs.writeFileSync(keysPath, JSON.stringify(filtered, null, 2));
  return true;
}

// ─── Hub HTTP server ──────────────────────────────────────────────────────────

export function startHubServer(
  port: number,
  recallsDir: string,
  searchMap: Map<string, SearchEntry>,
  pathMap: Map<string, string>
): http.Server {
  function score(entry: SearchEntry, terms: string[]): number {
    let s = 0;
    const id = entry.id.toLowerCase();
    const desc = (entry.description || '').toLowerCase();
    const tags = (entry.tags || []).map(t => t.toLowerCase());
    for (const term of terms) {
      if (id.includes(term)) s += 10;
      if (desc.includes(term)) s += 5;
      if (tags.some(t => t.includes(term))) s += 3;
    }
    return s;
  }

  function resolveImpl(id: string): string | null {
    const rel = pathMap.get(id);
    if (rel) {
      const abs = path.join(recallsDir, rel);
      if (fs.existsSync(abs)) return abs;
    }
    const parts = id.replace(/\.v\d+$/, '').split('.');
    const prefixes = ['', 'snippets', 'codes'];
    for (const prefix of prefixes) {
      const candidate = prefix
        ? path.join(recallsDir, prefix, ...parts, 'v1', 'implementation.js')
        : path.join(recallsDir, ...parts, 'v1', 'implementation.js');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  function json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-API-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawUrl = req.url || '/';
    const parsed = new URL(rawUrl, `http://localhost:${port}`);
    const pathname = parsed.pathname;

    // /health is public
    if (pathname === '/health') {
      json(res, 200, { name: 'strata-hub', recalls: searchMap.size, version: '1.0.0' });
      return;
    }

    // All other routes require API key
    const apiKey = (req.headers['x-api-key'] as string) || '';
    const keyRecord = validateKey(apiKey);
    if (!keyRecord) {
      json(res, 401, { error: 'Invalid or missing API key' });
      return;
    }

    // Rate limit
    if (!checkRateLimit(keyRecord.key, keyRecord.dailyLimit)) {
      json(res, 429, { error: 'Daily limit reached', limit: keyRecord.dailyLimit });
      return;
    }

    // GET /search?q=...&limit=10
    if (pathname === '/search') {
      const query = parsed.searchParams.get('q') || '';
      const limit = Math.min(parseInt(parsed.searchParams.get('limit') || '10', 10), 50);
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

      const results = [...searchMap.values()]
        .map(e => ({ entry: e, score: score(e, terms) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => ({
          id: x.entry.id,
          name: x.entry.name,
          description: x.entry.description || x.entry.name,
          tags: x.entry.tags || [],
          layer: x.entry.layer,
          score: x.score,
          source: 'hub' as const,
        }));

      json(res, 200, results);
      return;
    }

    // GET /list?domain=...
    if (pathname === '/list') {
      const domain = parsed.searchParams.get('domain');
      if (domain) {
        const filtered = [...searchMap.values()]
          .filter(e => e.id.startsWith(domain + '.') || e.layer === domain)
          .map(e => ({ id: e.id, description: e.description || e.name }));
        json(res, 200, { domain, recalls: filtered });
        return;
      }
      const domainCounts = new Map<string, number>();
      for (const e of searchMap.values()) {
        const d = e.id.split('.')[0];
        domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
      }
      const domains = [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));
      json(res, 200, { total: searchMap.size, domains });
      return;
    }

    // GET /recall/:id
    const recallMatch = pathname.match(/^\/recall\/(.+)$/);
    if (recallMatch) {
      const id = decodeURIComponent(recallMatch[1]);
      const entry = searchMap.get(id);
      const implPath = resolveImpl(id);
      if (!implPath) {
        json(res, 404, { error: `Recall "${id}" not found` });
        return;
      }
      const implementation = fs.readFileSync(implPath, 'utf-8');
      const readmePath = path.join(path.dirname(implPath), 'README.md');
      const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : undefined;
      json(res, 200, { id, description: entry?.description || '', tags: entry?.tags || [], implementation, readme });
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  server.listen(port, () => {
    console.log(`[strata-hub] Listening on port ${port} — ${searchMap.size} recalls ready`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[strata-hub] Port ${port} already in use`);
      process.exit(1);
    } else {
      console.error('[strata-hub] Error:', err.message);
    }
  });

  return server;
}
