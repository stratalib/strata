import fs from 'fs';
import path from 'path';
import os from 'os';

interface PeersFile {
  peers: string[];
  bootstrap?: string;
}

const strataDir = path.join(os.homedir(), '.strata');
const peersFilePath = path.join(strataDir, 'peers.json');

function readPeersFile(): PeersFile {
  if (!fs.existsSync(peersFilePath)) return { peers: [] };
  try {
    return JSON.parse(fs.readFileSync(peersFilePath, 'utf-8'));
  } catch {
    return { peers: [] };
  }
}

function writePeersFile(data: PeersFile): void {
  if (!fs.existsSync(strataDir)) fs.mkdirSync(strataDir, { recursive: true });
  fs.writeFileSync(peersFilePath, JSON.stringify(data, null, 2));
}

export function loadPeers(): string[] {
  return readPeersFile().peers;
}

export function addPeer(url: string): void {
  const data = readPeersFile();
  const normalized = url.replace(/\/$/, '');
  if (!data.peers.includes(normalized)) {
    data.peers.push(normalized);
    writePeersFile(data);
  }
}

export function removePeer(url: string): void {
  const data = readPeersFile();
  data.peers = data.peers.filter(p => p !== url && p !== url.replace(/\/$/, ''));
  writePeersFile(data);
}

export function setBootstrap(url: string): void {
  const data = readPeersFile();
  data.bootstrap = url;
  writePeersFile(data);
}

export async function discoverPeers(): Promise<string[]> {
  const data = readPeersFile();
  const peers = new Set<string>(data.peers.map(p => p.replace(/\/$/, '')));

  if (data.bootstrap) {
    try {
      const res = await fetch(data.bootstrap, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const remote = await res.json() as string[];
        for (const p of remote) peers.add(p.replace(/\/$/, ''));
      }
    } catch {
      // bootstrap unreachable — use local list only
    }
  }

  return [...peers];
}
