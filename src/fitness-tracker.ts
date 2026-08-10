import fs from 'fs';
import path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecallSignal {
  recallId: string;
  taskId: number;
  taskTitle: string;
  timestamp: string;
  retriggeredRetry: boolean;
  glueRatio: number;       // outTokens / baselineTokens
  referenced: boolean;     // recall's require path or an export name appeared in output
  glueTokens: number;
  baselineTokens: number;
}

export interface RecallFitness {
  recallId: string;
  taskCount: number;
  avgGlueRatio: number;
  referenceRate: number;   // fraction of tasks where recall was referenced
  retryRate: number;
  fitness: number;         // 0–100 composite
}

export interface LiveSignal {
  recallId: string;
  timestamp: string;
  project: string;
  outputFile: string;
  outputLines: number;
  outputTokenEst: number;
  referenced: boolean;
  exportNamesUsed: string[];
  glueFunctions: string[];
  unmetNeeds: string[];    // functions defined in glue but not in recall exports → recall gaps
}

interface SignalsFile {
  version: number;
  updated: string;
  signals: RecallSignal[];
  liveSignals?: LiveSignal[];
}

export function saveLiveSignal(signal: LiveSignal, cacheDir: string): void {
  const filePath = path.join(cacheDir, 'signals.json');
  let file: SignalsFile = { version: 1, updated: '', signals: [] };
  if (fs.existsSync(filePath)) {
    try { file = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* start fresh */ }
  }
  file.liveSignals = [...(file.liveSignals ?? []), signal];
  file.updated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
}

export function loadLiveSignals(cacheDir: string): LiveSignal[] {
  const filePath = path.join(cacheDir, 'signals.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const file = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SignalsFile;
    return file.liveSignals ?? [];
  } catch { return []; }
}

// ─── recordSignal ─────────────────────────────────────────────────────────────

export function recordSignal(
  taskId: number,
  taskTitle: string,
  recallId: string,
  outputText: string,
  outTokens: number,
  baselineTokens: number,
  recallExports: string[],
): RecallSignal {
  const lower = outputText.toLowerCase();

  const retriggeredRetry = outputText.trim().startsWith('{"action":"retry"}');

  // Check for require path or any known export name in the output
  const requirePath = `./strata/${recallId}`;
  let referenced = lower.includes(requirePath.toLowerCase());
  if (!referenced) {
    for (const exp of recallExports) {
      // Extract the leading identifier from export signatures like "createJWT(payload)" → "createJWT"
      const name = exp.trim().split(/[\s(]/)[0];
      if (name && name.length > 3 && lower.includes(name.toLowerCase())) {
        referenced = true;
        break;
      }
    }
  }

  return {
    recallId,
    taskId,
    taskTitle,
    timestamp: new Date().toISOString(),
    retriggeredRetry,
    glueRatio: baselineTokens > 0 ? outTokens / baselineTokens : 1,
    referenced,
    glueTokens: outTokens,
    baselineTokens,
  };
}

// ─── saveSignals ──────────────────────────────────────────────────────────────

export function saveSignals(newSignals: RecallSignal[], cacheDir: string): void {
  const filePath = path.join(cacheDir, 'signals.json');
  let existing: RecallSignal[] = [];

  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SignalsFile;
      existing = parsed.signals ?? [];
    } catch { /* start fresh if corrupt */ }
  }

  const merged: SignalsFile = {
    version: 1,
    updated: new Date().toISOString(),
    signals: [...existing, ...newSignals],
  };

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
}

// ─── loadSignals ──────────────────────────────────────────────────────────────

export function loadSignals(cacheDir: string): RecallSignal[] {
  const filePath = path.join(cacheDir, 'signals.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SignalsFile;
    return parsed.signals ?? [];
  } catch {
    return [];
  }
}

// ─── computeRecallFitness ─────────────────────────────────────────────────────

export function computeRecallFitness(recallId: string, signals: RecallSignal[]): RecallFitness {
  const mine = signals.filter(s => s.recallId === recallId);

  if (mine.length === 0) {
    return { recallId, taskCount: 0, avgGlueRatio: 1, referenceRate: 0, retryRate: 0, fitness: 100 };
  }

  const avgGlueRatio  = mine.reduce((s, x) => s + x.glueRatio, 0) / mine.length;
  const referenceRate = mine.filter(x => x.referenced).length / mine.length;
  const retryRate     = mine.filter(x => x.retriggeredRetry).length / mine.length;

  const fitness = Math.max(0,
    100
    - (avgGlueRatio  > 0.8 ? 40 : 0)
    - (referenceRate < 0.7 ? 30 : 0)
    - (retryRate     > 0.1 ? 30 : 0),
  );

  return { recallId, taskCount: mine.length, avgGlueRatio, referenceRate, retryRate, fitness };
}

// ─── buildFitnessMap ──────────────────────────────────────────────────────────

export function buildFitnessMap(cacheDir: string): Map<string, number> {
  const signals = loadSignals(cacheDir);
  const map = new Map<string, number>();
  const ids = new Set(signals.map(s => s.recallId));
  for (const id of ids) {
    map.set(id, computeRecallFitness(id, signals).fitness);
  }
  return map;
}
