/**
 * Imprint — public API
 * Usage:
 *   import { imprint } from './src/imprint';
 *   const result = imprint('./src', { projectRoot: process.cwd() });
 */

import * as fs from 'fs';
import * as path from 'path';
import { scan, ScanOptions } from './scanner';
import { register, RegisterOptions, RegisterResult } from './register';
import { extractConventions } from './conventions';
import { ExtractedPattern, ScanResult, ConventionMap } from './types';

export type { ExtractedPattern, ScanResult, RegisterOptions, RegisterResult, ConventionMap };

export interface ImprintOptions extends ScanOptions, Omit<RegisterOptions, 'projectRoot'> {
  projectRoot?: string;
  /** Log progress to stdout (default: true) */
  verbose?: boolean;
}

export interface ImprintResult {
  scan: ScanResult;
  register: RegisterResult;
  conventions: ConventionMap;
}

export function imprint(scanPath: string, opts: ImprintOptions = {}): ImprintResult {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const verbose = opts.verbose ?? true;

  if (verbose) {
    process.stdout.write(`\n  Scanning ${scanPath}...\n`);
  }

  const scanResult = scan(scanPath, {
    exclude: opts.exclude,
    maxFileSize: opts.maxFileSize,
    followSymlinks: opts.followSymlinks,
  });

  if (verbose) {
    process.stdout.write(
      `  Found ${scanResult.patterns.length} patterns across ${scanResult.filesScanned} files\n`,
    );
    if (scanResult.skipped.length) {
      process.stdout.write(`  Skipped ${scanResult.skipped.length} files\n`);
    }
    process.stdout.write(`  Registering local recalls...\n`);
  }

  const registerResult = register(scanResult.patterns, {
    projectRoot,
    outputDir: opts.outputDir,
    overwrite: opts.overwrite,
  });

  if (verbose) {
    process.stdout.write(
      `  Written: ${registerResult.written}  Skipped (existing): ${registerResult.skipped}\n`,
    );
    if (registerResult.errors.length) {
      process.stdout.write(`  Errors: ${registerResult.errors.length}\n`);
      registerResult.errors.forEach(e =>
        process.stdout.write(`    ! ${e.pattern}: ${e.reason}\n`),
      );
    }
  }

  // Extract project conventions from glue library extractors
  const glueDir = path.join(findStrataRoot(__dirname), 'recalls', 'glue');
  const conventions = extractConventions(scanPath, glueDir, projectRoot);

  if (verbose) {
    const count = Object.keys(conventions).length;
    if (count > 0) {
      process.stdout.write(`\n  Conventions extracted (${count} slots):\n`);
      for (const [slot, value] of Object.entries(conventions)) {
        const truncated = value.length > 60 ? value.slice(0, 57) + '...' : value;
        process.stdout.write(`    ${slot.padEnd(20)} → ${truncated}\n`);
      }
    } else {
      process.stdout.write(`  No conventions extracted (no matching patterns found)\n`);
    }
    process.stdout.write('\n');
  }

  return { scan: scanResult, register: registerResult, conventions };
}

/** Walk up from startDir until we find a directory containing 'recalls/' — works in ts-node and compiled dist/ */
function findStrataRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'recalls'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export { scan } from './scanner';
export { register } from './register';
export { extractConventions, scanEnvFile } from './conventions';
export { resolveGlue, loadConventions } from './glue-matcher';
