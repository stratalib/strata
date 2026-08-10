/**
 * Conventions Extractor
 * Scans a project's source files, runs extraction regexes from each glue
 * template, and frequency-counts the matches to produce a ConventionMap —
 * the project's canonical slot values (DB_CLIENT, AUTH_MIDDLEWARE, etc.).
 *
 * The resulting ConventionMap is written to {scanRoot}/strata/conventions.json
 * so subsequent strata_use calls can fill glue template slots without any LLM.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConventionMap, GlueRecallMetadata } from './types';

/* ── Load all glue extractors from the glue library ────────────────── */

function loadExtractors(glueDir: string): Record<string, string[]> {
  // Merged map: slot → all regex strings across all glue templates
  const merged: Record<string, string[]> = {};

  if (!fs.existsSync(glueDir)) return merged;

  for (const templateName of fs.readdirSync(glueDir)) {
    const metaPath = path.join(glueDir, templateName, 'v1', 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;

    let meta: GlueRecallMetadata;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      continue;
    }

    if (!meta.extractors) continue;
    for (const [slot, patterns] of Object.entries(meta.extractors)) {
      if (!merged[slot]) merged[slot] = [];
      for (const p of patterns) {
        if (!merged[slot].includes(p)) merged[slot].push(p);
      }
    }
  }

  return merged;
}

/* ── Walk source files ──────────────────────────────────────────────── */

const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.git', 'strata', 'recalls',
  'coverage', '.nyc_output', '__pycache__',
]);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_SUFFIXES = ['.test.ts', '.test.js', '.spec.ts', '.spec.js', '.d.ts'];

function walkSources(dir: string, files: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walkSources(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) continue;
    if (SKIP_SUFFIXES.some(s => entry.name.endsWith(s))) continue;
    files.push(full);
  }
}

/* ── Run a regex against text, return first non-empty capture group ─── */

function firstCapture(source: string, regexStr: string): string | null {
  let re: RegExp;
  try { re = new RegExp(regexStr, 'g'); } catch { return null; }

  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Find first non-empty capture group (skip group 0 = full match)
    for (let i = 1; i < m.length; i++) {
      if (m[i] && m[i].trim()) return m[i].trim();
    }
  }
  return null;
}

/* ── Scan .env.example / .env for available env var names ──────────── */

export function scanEnvFile(dir: string): string[] {
  for (const filename of ['.env.example', '.env']) {
    const fullPath = path.join(path.resolve(dir), filename);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const vars: string[] = [];
      for (const line of content.split('\n')) {
        const m = line.match(/^([A-Z][A-Z0-9_]+)=/);
        if (m) vars.push(m[1]);
      }
      return vars;
    } catch {
      return [];
    }
  }
  return [];
}

/* ── Main extraction function ───────────────────────────────────────── */

export function extractConventions(
  scanRoot: string,
  glueDir: string,
  /** Where to write conventions.json — defaults to scanRoot (use project root for multi-dir scans) */
  outputRoot?: string,
): ConventionMap {
  const extractors = loadExtractors(glueDir);
  const slots = Object.keys(extractors);

  if (slots.length === 0) return {};

  // Frequency map: slot → { value → count }
  const freq: Record<string, Record<string, number>> = {};
  for (const slot of slots) freq[slot] = {};

  const files: string[] = [];
  walkSources(path.resolve(scanRoot), files);

  for (const filePath of files) {
    let source: string;
    try { source = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    if (source.length > 300_000) continue; // skip huge generated files

    for (const slot of slots) {
      for (const regexStr of extractors[slot]) {
        const value = firstCapture(source, regexStr);
        if (value) {
          freq[slot][value] = (freq[slot][value] || 0) + 1;
        }
      }
    }
  }

  // Pick most frequent non-empty value per slot
  const conventions: ConventionMap = {};
  for (const slot of slots) {
    const counts = freq[slot];
    const entries = Object.entries(counts);
    if (entries.length === 0) continue;
    entries.sort((a, b) => b[1] - a[1]);
    const [best] = entries[0];
    if (best) conventions[slot] = best;
  }

  // Scan .env.example / .env and record which env var names are available in this project
  const envVars = scanEnvFile(scanRoot);
  if (envVars.length > 0) {
    conventions['ENV_VARS'] = envVars.join(',');
  }

  // Persist to strata/conventions.json — use outputRoot if provided, otherwise scanRoot
  try {
    const strataDir = path.join(path.resolve(outputRoot ?? scanRoot), 'strata');
    fs.mkdirSync(strataDir, { recursive: true });
    fs.writeFileSync(
      path.join(strataDir, 'conventions.json'),
      JSON.stringify(conventions, null, 2),
    );
  } catch {
    // non-fatal — we still return the map
  }

  return conventions;
}
