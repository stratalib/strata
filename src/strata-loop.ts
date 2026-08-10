// ─── Strata Loop ────────────────────────────────────────────────────────────
// The extraction loop's local store. Every strata_signal call can deposit three
// kinds of LLM-authored records here. Routing by sensitivity is intentional and
// enforced in code, not left to a prompt:
//
//   signal    — fitness telemetry (no raw code)      → upload: 'auto'
//   finding   — a defect/quality issue in a Strata    → upload: 'auto'
//               recall (feedback about Strata's code)
//   candidate — reusable code the user wrote that the  → upload: 'staged'
//               library lacks (the USER's code)          never auto-sent
//
// 'auto' records are mirrored into outbox/ for upload. 'staged' records are the
// user's own code — they sit in candidates/ marked pending-approval and NEVER
// leave the machine until a human promotes them. This split is the consent gate.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type UploadPolicy = 'auto' | 'staged' | 'local';

export interface SessionMeta {
  timestamp: string;
  projectHash: string;   // sha256(projectPath).slice(0,12) — never a raw path
  model?: string;
}

export interface LoopSignal {
  kind: 'signal';
  recallId: string;
  referenced: boolean;
  exportNamesUsed: string[];
  unmetNeeds: string[];
  outputLines: number;
  session: SessionMeta;
  upload: 'auto';
}

export interface LoopFinding {
  kind: 'finding';
  type: 'bug' | 'improvement';
  recallId: string;
  target?: string;                       // export name or file the defect is in
  description: string;
  severity?: 'high' | 'medium' | 'low';
  session: SessionMeta;
  upload: 'auto';
  status: 'open';
}

export interface LoopCandidate {
  kind: 'candidate';
  proposedId: string;
  exports: string[];
  description: string;
  domain?: string;
  codeRef?: string;                      // pointer like "worker.js:12-48" — NOT the code
  session: SessionMeta;
  upload: 'staged';
  status: 'pending-approval';
}

export type LoopRecord = LoopSignal | LoopFinding | LoopCandidate;

const LOOP_DIRNAME = 'strata-loop';
const SUBDIRS = ['signals', 'findings', 'candidates', 'outbox'] as const;

export function loopDir(cacheDir: string): string {
  return path.join(cacheDir, LOOP_DIRNAME);
}

export function ensureLoopDirs(cacheDir: string): string {
  const root = loopDir(cacheDir);
  for (const sub of SUBDIRS) fs.mkdirSync(path.join(root, sub), { recursive: true });
  return root;
}

export function hashProject(projectPath: string): string {
  return crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

export function makeSession(projectPath: string, model?: string): SessionMeta {
  return { timestamp: new Date().toISOString(), projectHash: hashProject(projectPath), model };
}

function recordFilename(rec: LoopRecord): string {
  const stamp = rec.session.timestamp.replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${rec.kind}-${stamp}-${rand}.json`;
}

function subdirFor(rec: LoopRecord): string {
  if (rec.kind === 'signal') return 'signals';
  if (rec.kind === 'finding') return 'findings';
  return 'candidates';
}

// Writes a record to its subdir. 'auto' records are also copied to outbox/ for
// upload. 'staged' candidates are never queued — they wait for human approval.
export function writeRecord(cacheDir: string, rec: LoopRecord): string {
  const root = ensureLoopDirs(cacheDir);
  const name = recordFilename(rec);
  const dest = path.join(root, subdirFor(rec), name);
  fs.writeFileSync(dest, JSON.stringify(rec, null, 2));
  if (rec.upload === 'auto') {
    fs.writeFileSync(path.join(root, 'outbox', name), JSON.stringify(rec, null, 2));
  }
  return dest;
}

// Reads all queued 'auto' records awaiting upload.
export function readOutbox(cacheDir: string): Array<{ file: string; record: LoopRecord }> {
  const dir = path.join(loopDir(cacheDir), 'outbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const file = path.join(dir, f);
      try {
        return { file, record: JSON.parse(fs.readFileSync(file, 'utf-8')) as LoopRecord };
      } catch {
        return null;
      }
    })
    .filter((x): x is { file: string; record: LoopRecord } => x !== null);
}

export function clearOutboxItems(files: string[]): void {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
}
