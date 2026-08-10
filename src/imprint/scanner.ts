/**
 * Imprint Scanner
 * Walks a project directory, extracts exported functions and classes,
 * and returns structured patterns ready for local recall registration.
 *
 * Pure regex — no AST parser, no additional dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
export type { ScanOptions } from './types';
import { ExtractedPattern, ScanOptions, ScanResult } from './types';

/* ── Exclusion defaults ─────────────────────────────────────────── */

const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.nyc_output', '__pycache__', '.git', '.turbo', '.cache',
  'strata', 'recalls',  // skip Strata's own output dirs
]);

const EXCLUDED_FILE_SUFFIXES = [
  '.test.ts', '.test.js', '.test.tsx', '.test.jsx',
  '.spec.ts', '.spec.js', '.spec.tsx', '.spec.jsx',
  '.d.ts', '.min.js', '.bundle.js',
];

const EXCLUDED_FILE_NAMES = new Set([
  'jest.config.ts', 'jest.config.js', 'vitest.config.ts',
  'webpack.config.js', 'rollup.config.js', 'vite.config.ts',
  'tailwind.config.js', 'postcss.config.js',
  'next.config.js', 'next.config.ts',
  'tsconfig.json', 'package.json',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/* ── Domain inference ───────────────────────────────────────────── */

const DOMAIN_SEGMENTS: [string[], string][] = [
  [['auth', 'login', 'logout', 'session', 'password', 'jwt', 'token', 'oauth', 'sso', 'credential', 'user', 'account', 'profile', 'identity'], 'auth'],
  [['api', 'route', 'routes', 'router', 'controller', 'controllers', 'endpoint', 'endpoints', 'handler', 'handlers', 'rest', 'graphql'], 'api'],
  [['middleware', 'middlewares', 'guard', 'guards', 'interceptor'], 'middleware'],
  [['db', 'database', 'model', 'models', 'schema', 'schemas', 'migration', 'migrations', 'repository', 'repo', 'orm', 'prisma', 'sequelize', 'mongoose'], 'database'],
  [['queue', 'job', 'jobs', 'worker', 'workers', 'task', 'tasks', 'bull', 'agenda', 'cron'], 'queue'],
  [['cache', 'redis', 'memcache', 'memcached'], 'cache'],
  [['config', 'configuration', 'env', 'environment', 'settings', 'constants', 'vars'], 'config'],
  [['email', 'mail', 'mailer', 'smtp', 'sendgrid', 'mailgun', 'notification', 'notifications'], 'notification'],
  [['webhook', 'webhooks', 'event', 'events', 'pubsub', 'bus'], 'webhook'],
  [['payment', 'payments', 'billing', 'stripe', 'invoice', 'subscription', 'charge'], 'payment'],
  [['file', 'files', 'upload', 'uploads', 'storage', 's3', 'bucket', 'media'], 'storage'],
  [['util', 'utils', 'utility', 'utilities', 'helper', 'helpers', 'lib', 'libs', 'shared', 'common', 'misc'], 'utility'],
  [['service', 'services', 'svc'], 'service'],
  [['validation', 'validator', 'validate', 'schema', 'zod', 'yup', 'joi'], 'validation'],
  [['crypto', 'encryption', 'hash', 'hmac', 'cipher'], 'security'],
  [['log', 'logger', 'logging', 'audit', 'telemetry', 'metrics', 'monitoring'], 'observability'],
];

function inferDomain(relativePath: string): { domain: string; subdomain: string } {
  const parts = relativePath.split(/[\\/]/).map(p => p.toLowerCase());
  // remove the filename
  const segments = parts.slice(0, -1);

  for (const segment of segments) {
    for (const [keys, domain] of DOMAIN_SEGMENTS) {
      if (keys.some(k => segment === k || segment.startsWith(k))) {
        const subdomain = segments.length > 1
          ? segments[segments.indexOf(segment) + 1] || segment
          : segment;
        return { domain, subdomain: subdomain.replace(/[^a-z0-9]/g, '') || segment };
      }
    }
  }

  // Fallback: use first non-src segment, or 'utility'
  const meaningful = segments.filter(s => s !== 'src' && s !== 'app' && s !== 'lib' && s !== 'source');
  const domain = meaningful[0] || 'utility';
  const subdomain = meaningful[1] || domain;
  return { domain, subdomain };
}

/* ── JSDoc extraction ───────────────────────────────────────────── */

function extractJsDoc(lines: string[], declLine: number): string {
  let i = declLine - 1;
  // skip blank lines between jsdoc and declaration
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0 || !lines[i].trim().endsWith('*/')) return '';

  const docLines: string[] = [];
  while (i >= 0 && !lines[i].trimStart().startsWith('/**')) {
    docLines.unshift(lines[i]);
    i--;
  }
  if (i >= 0) docLines.unshift(lines[i]);

  return docLines
    .join('\n')
    .replace(/\/\*\*|\*\/|\*\s?/g, '')
    .replace(/@\w+.*\n?/g, '')
    .trim()
    .slice(0, 300);
}

/* ── Source snippet extraction ──────────────────────────────────── */

function extractSnippet(lines: string[], startLine: number, maxLines = 14): string {
  return lines
    .slice(startLine, startLine + maxLines)
    .join('\n')
    .trimEnd();
}

/* ── Param parsing ──────────────────────────────────────────────── */

function parseParams(raw: string): string[] {
  if (!raw.trim()) return [];
  // Split on commas that are NOT inside <> [] () brackets
  const params: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if ('<([{'.includes(ch)) depth++;
    else if ('>)]}' .includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      const p = current.trim();
      if (p) params.push(p);
      current = '';
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) params.push(last);
  return params.filter(p => {
    const name = p.split(':')[0].split('=')[0].trim().replace(/^\.\.\./, '').replace(/[?]/g, '');
    return name.length >= 2 && !name.startsWith('{') && !name.startsWith('[');
  });
}

/* ── Core export extraction ─────────────────────────────────────── */

interface RawExport {
  name: string;
  kind: ExtractedPattern['kind'];
  params: string[];
  returnType: string;
  isAsync: boolean;
  isExportDefault: boolean;
  lineIndex: number;
}

function extractExports(source: string): RawExport[] {
  const lines = source.split('\n');
  const results: RawExport[] = [];
  const seen = new Set<string>();
  const SKIP_NAMES = new Set([
    'if', 'for', 'while', 'switch', 'try', 'catch', 'return',
    'const', 'let', 'var', 'function', 'class', 'type', 'interface',
    'default', 'new', 'delete', 'typeof', 'instanceof', 'import', 'export',
  ]);

  function add(e: RawExport): void {
    if (!e.name || e.name.length < 2 || e.name.length > 60) return;
    if (SKIP_NAMES.has(e.name)) return;
    if (/^[A-Z_][A-Z_0-9]+$/.test(e.name)) return; // ALL_CAPS constants
    if (seen.has(e.name)) return;
    seen.add(e.name);
    results.push(e);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip: type/interface/enum/import/re-export-from
    if (/^export\s+(type|interface|enum)\s/.test(trimmed)) continue;
    if (/^export\s*\{/.test(trimmed)) continue;  // re-export barrel
    if (/from\s+['"]/.test(trimmed) && /^export/.test(trimmed)) continue;

    // 1. export [async] function name(params): return
    const fnMatch = trimmed.match(/^export\s+(async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)(?:\s*:\s*([^{;\n]+))?/);
    if (fnMatch) {
      add({
        name: fnMatch[2],
        kind: 'function',
        params: parseParams(fnMatch[3]),
        returnType: fnMatch[4]?.trim() || (fnMatch[1] ? 'Promise<void>' : 'void'),
        isAsync: !!fnMatch[1],
        isExportDefault: false,
        lineIndex: i,
      });
      continue;
    }

    // 2. export const name = [async] (params) => [return type]
    const arrowMatch = trimmed.match(/^export\s+const\s+([\w$]+)\s*=\s*(async\s+)?\(([^)]*)\)(?:\s*:\s*([^=>{;\n]+))?\s*=>/);
    if (arrowMatch) {
      add({
        name: arrowMatch[1],
        kind: 'arrow',
        params: parseParams(arrowMatch[3]),
        returnType: arrowMatch[4]?.trim() || (arrowMatch[2] ? 'Promise<void>' : 'void'),
        isAsync: !!arrowMatch[2],
        isExportDefault: false,
        lineIndex: i,
      });
      continue;
    }

    // 3. export const name = async singleParam =>
    const arrowSingleMatch = trimmed.match(/^export\s+const\s+([\w$]+)\s*=\s*(async\s+)([\w$]+)\s*=>/);
    if (arrowSingleMatch) {
      add({
        name: arrowSingleMatch[1],
        kind: 'arrow',
        params: [arrowSingleMatch[3]],
        returnType: 'Promise<void>',
        isAsync: true,
        isExportDefault: false,
        lineIndex: i,
      });
      continue;
    }

    // 4. export class Name / export abstract class Name
    const classMatch = trimmed.match(/^export\s+(?:abstract\s+)?class\s+([\w$]+)/);
    if (classMatch) {
      add({
        name: classMatch[1],
        kind: 'class',
        params: [],
        returnType: classMatch[1],
        isAsync: false,
        isExportDefault: false,
        lineIndex: i,
      });
      continue;
    }

    // 5. export default function [name](params)
    const defaultFnMatch = trimmed.match(/^export\s+default\s+(async\s+)?function\s*([\w$]*)\s*\(([^)]*)\)(?:\s*:\s*([^{;\n]+))?/);
    if (defaultFnMatch) {
      const name = defaultFnMatch[2] || 'default';
      add({
        name,
        kind: 'default',
        params: parseParams(defaultFnMatch[3]),
        returnType: defaultFnMatch[4]?.trim() || 'void',
        isAsync: !!defaultFnMatch[1],
        isExportDefault: true,
        lineIndex: i,
      });
      continue;
    }

    // 6. export default class [Name]
    const defaultClassMatch = trimmed.match(/^export\s+default\s+class\s*([\w$]+)?/);
    if (defaultClassMatch) {
      const name = defaultClassMatch[1] || 'DefaultClass';
      add({
        name,
        kind: 'default',
        params: [],
        returnType: name,
        isAsync: false,
        isExportDefault: true,
        lineIndex: i,
      });
      continue;
    }
  }

  return results;
}

/* ── File walker ────────────────────────────────────────────────── */

function walk(
  dir: string,
  root: string,
  opts: Required<ScanOptions>,
  files: string[],
  skipped: ScanResult['skipped'],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    skipped.push({ path: dir, reason: 'unreadable directory' });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const isSymlink = entry.isSymbolicLink();

    if (isSymlink && !opts.followSymlinks) continue;
    const resolved = isSymlink ? fs.realpathSync(fullPath) : fullPath;

    if (entry.isDirectory() || (isSymlink && fs.statSync(resolved).isDirectory())) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (opts.exclude.some(ex => entry.name === ex || fullPath.includes(ex))) continue;
      walk(resolved, root, opts, files, skipped);
      continue;
    }

    if (!entry.isFile() && !isSymlink) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (EXCLUDED_FILE_NAMES.has(entry.name)) continue;
    if (EXCLUDED_FILE_SUFFIXES.some(s => entry.name.endsWith(s))) continue;

    // Skip __tests__ directories (caught by walk, but belt+suspenders via path check)
    if (fullPath.includes('__tests__') || fullPath.includes('__mocks__')) continue;

    const stat = fs.statSync(resolved);
    if (stat.size > opts.maxFileSize) {
      skipped.push({ path: fullPath, reason: `file too large (${Math.round(stat.size / 1024)}KB)` });
      continue;
    }

    files.push(resolved);
  }
}

/* ── Main scan function ─────────────────────────────────────────── */

export function scan(scanRoot: string, opts: ScanOptions = {}): ScanResult {
  const options: Required<ScanOptions> = {
    exclude: opts.exclude ?? [],
    maxFileSize: opts.maxFileSize ?? 200 * 1024,
    followSymlinks: opts.followSymlinks ?? false,
  };

  const resolvedRoot = path.resolve(scanRoot);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Scan root does not exist: ${resolvedRoot}`);
  }

  const files: string[] = [];
  const skipped: ScanResult['skipped'] = [];
  walk(resolvedRoot, resolvedRoot, options, files, skipped);

  const patterns: ExtractedPattern[] = [];

  for (const filePath of files) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch {
      skipped.push({ path: filePath, reason: 'read error' });
      continue;
    }

    // Skip files with zero exports or that are likely generated
    if (!source.includes('export ')) continue;
    if (source.startsWith('// @generated') || source.startsWith('/* eslint-disable */\n// @ts-nocheck')) continue;

    const rawExports = extractExports(source);
    if (rawExports.length === 0) continue;

    const lines = source.split('\n');
    const relativePath = path.relative(resolvedRoot, filePath).replace(/\\/g, '/');
    const { domain, subdomain } = inferDomain(relativePath);

    for (const raw of rawExports) {
      patterns.push({
        name: raw.name,
        kind: raw.kind,
        filePath,
        relativePath,
        domain,
        subdomain,
        params: raw.params,
        returnType: raw.returnType,
        jsdoc: extractJsDoc(lines, raw.lineIndex),
        sourceSnippet: extractSnippet(lines, raw.lineIndex),
        isAsync: raw.isAsync,
        isExportDefault: raw.isExportDefault,
      });
    }
  }

  return {
    root: resolvedRoot,
    filesScanned: files.length,
    patterns,
    skipped,
  };
}
