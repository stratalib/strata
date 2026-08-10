import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface UsageEntry {
  timestamp: string;
  projectId: string;           // sha256(cwd).slice(0,12) — consistent across sessions, never reveals path
  capabilities: string[];      // decomposed capability phrases — NOT the raw task query
  recallIds: string[];
  recallCount: number;
  estimatedTokensSaved: number;
  hasGlue: boolean;
  gluePatternCount: number;    // how many glue templates matched and were injected
  hasLocalRecalls: boolean;
  recallLayers: number[];      // which recall layers (L1–L5) fired
  strataVersion: string;
  mode: string;
}

const STRATA_DIR = path.join(os.homedir(), '.strata');
const LOG_DIR    = path.join(STRATA_DIR, 'logs');
const LOG_FILE   = path.join(LOG_DIR, 'usage.jsonl');
const CFG_FILE   = path.join(STRATA_DIR, 'config.json');

// ─── Project ID ───────────────────────────────────────────────────────────────

export function hashProject(absPath: string): string {
  return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 12);
}

// ─── Global config (telemetry flag, consent) ──────────────────────────────────

function readGlobalConfig(): Record<string, unknown> {
  try {
    if (!fs.existsSync(CFG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf-8'));
  } catch { return {}; }
}

function writeGlobalConfig(data: Record<string, unknown>): void {
  if (!fs.existsSync(STRATA_DIR)) fs.mkdirSync(STRATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(data, null, 2));
}

export function telemetryEnabled(): boolean {
  return readGlobalConfig().telemetry !== false;  // default on until opt-out
}

export function setTelemetry(enabled: boolean): void {
  const cfg = readGlobalConfig();
  cfg.telemetry = enabled;
  writeGlobalConfig(cfg);
}

export function consentAlreadyShown(): boolean {
  return readGlobalConfig().consentShown === true;
}

export function markConsentShown(telemetry: boolean): void {
  const cfg = readGlobalConfig();
  cfg.consentShown = true;
  cfg.telemetry = telemetry;
  writeGlobalConfig(cfg);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export function appendUsageLog(entry: UsageEntry): void {
  try {
    if (!telemetryEnabled()) return;
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // best-effort — never crash the MCP server over a log write
  }
}

export function readUsageLogs(): UsageEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return fs.readFileSync(LOG_FILE, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as UsageEntry);
  } catch {
    return [];
  }
}

export function usageSummary(entries: UsageEntry[]) {
  return {
    totalCalls:   entries.length,
    totalRecalls: entries.reduce((s, e) => s + e.recallCount, 0),
    totalTokens:  entries.reduce((s, e) => s + e.estimatedTokensSaved, 0),
  };
}
