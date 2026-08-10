import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface SearchEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  layer: string;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resolveImplPath(
  id: string,
  recallsDir: string,
  pathMap: Map<string, string>
): string | null {
  const relPath = pathMap.get(id);
  if (relPath) {
    const abs = path.join(recallsDir, relPath);
    if (fs.existsSync(abs)) return abs;
  }
  const parts = id.replace(/\.v\d+$/, '').split('.');
  if (parts.length >= 2) {
    const candidates = [
      path.join(recallsDir, ...parts, 'v1', 'implementation.js'),
      path.join(recallsDir, 'snippets', ...parts, 'v1', 'implementation.js'),
      path.join(recallsDir, 'codes', ...parts, 'v1', 'implementation.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

export function startPeerServer(
  port: number,
  recallsDir: string,
  searchMap: Map<string, SearchEntry>,
  pathMap: Map<string, string>
): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = req.url || '/';

    // GET /health
    if (url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({
        name: 'strata-lib',
        version: '1.0.0',
        recalls: searchMap.size,
      }));
      return;
    }

    // GET /index
    if (url === '/index') {
      const entries = [...searchMap.values()];
      res.writeHead(200);
      res.end(JSON.stringify(entries));
      return;
    }

    // GET /recall/:id
    const recallMatch = url.match(/^\/recall\/(.+)$/);
    if (recallMatch) {
      const id = decodeURIComponent(recallMatch[1]);
      const entry = searchMap.get(id);
      const implPath = resolveImplPath(id, recallsDir, pathMap);

      if (!implPath) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Recall "${id}" not found` }));
        return;
      }

      const implementation = fs.readFileSync(implPath, 'utf-8');
      const readmePath = path.join(path.dirname(implPath), 'README.md');
      const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : undefined;

      res.writeHead(200);
      res.end(JSON.stringify({
        id,
        description: entry?.description || '',
        tags: entry?.tags || [],
        implementation,
        readme,
        hash: sha256(implementation),
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.error(`[strata] Peer server listening on port ${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[strata] Port ${port} in use — peer server disabled`);
    } else {
      console.error('[strata] Peer server error:', err.message);
    }
  });

  return server;
}
