/**
 * Imprint Register
 * Takes ExtractedPattern[] from the scanner and writes each one as a local
 * recall to recalls/local/{domain}/{slug}/v1/
 *
 * ID format:  {domain}.{slug}.local.v1
 * Local recalls are composable with the 7,825-recall public library via the
 * same retrieval API — no special-casing required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExtractedPattern } from './types';

export interface RegisterOptions {
  /** Project root — used to build relative require paths in templates */
  projectRoot: string;
  /** Where to write local recalls (default: <projectRoot>/recalls/local) */
  outputDir?: string;
  /** If true, overwrite existing recall files (default: false — skip existing) */
  overwrite?: boolean;
}

export interface RegisterResult {
  written: number;
  skipped: number;
  errors: { pattern: string; reason: string }[];
  recalls: { id: string; path: string }[];
}

/* ── ID / slug helpers ──────────────────────────────────────────── */

function toKebab(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function makeId(domain: string, name: string): string {
  return `${domain}.${toKebab(name)}.local.v1`;
}

/* ── Template builders ──────────────────────────────────────────── */

function inferLayer(paramCount: number, isClass: boolean): number {
  if (isClass) return 3;
  if (paramCount === 0) return 1;
  if (paramCount <= 2) return 2;
  return 3;
}

function buildCallExample(p: ExtractedPattern, requirePath: string): string {
  const mod = p.isExportDefault ? p.name : `{ ${p.name} }`;
  const args = p.params.slice(0, 3).map(param => {
    const name = param.split(':')[0].replace(/[?.]/g, '').trim();
    if (!name || name.length < 2) return 'options';
    return `req.body.${name}`;
  });

  const callArgs = args.length ? args.join(', ') : '';
  const awaitKw = p.isAsync ? 'await ' : '';
  const callLine = p.kind === 'class'
    ? `const instance = new ${p.name}(${callArgs});`
    : `const result = ${awaitKw}${p.name}(${callArgs});`;

  return [
    `const ${mod} = require('${requirePath}');`,
    '',
    `app.post('/api', async (req, res) => {`,
    `  try {`,
    `    ${callLine}`,
    `    res.json({ result });`,
    `  } catch (err) {`,
    `    res.status(500).json({ error: err.message });`,
    `  }`,
    `});`,
  ].join('\n');
}

function buildGlueTemplate(p: ExtractedPattern, requirePath: string, id: string): string {
  const mod = p.isExportDefault ? p.name : `{ ${p.name} }`;
  const args = p.params.slice(0, 3).map(param => {
    const name = param.split(':')[0].replace(/[?.]/g, '').trim();
    return (!name || name.length < 2) ? 'options' : `req.body.${name}`;
  });
  const callArgs = args.length ? args.join(', ') : '';
  const awaitKw = p.isAsync ? 'await ' : '';
  const callLine = p.kind === 'class'
    ? `const instance = new ${p.name}(${callArgs});`
    : `const result = ${awaitKw}${p.name}(${callArgs});`;
  const resultLine = p.kind === 'class'
    ? `res.json({ success: true });`
    : `res.json({ result });`;

  return [
    `'use strict';`,
    `const express = require('express');`,
    `const router = express.Router();`,
    `const ${mod} = require('${requirePath}');`,
    ``,
    `router.post('/', async (req, res) => {`,
    `  try {`,
    `    ${callLine}`,
    `    ${resultLine}`,
    `  } catch (err) {`,
    `    console.error('[${id}]', err.message);`,
    `    res.status(500).json({ success: false, error: err.message });`,
    `  }`,
    `});`,
    ``,
    `module.exports = router;`,
  ].join('\n');
}

function buildImplementation(p: ExtractedPattern, requirePath: string): string {
  const mod = p.isExportDefault ? `module.exports` : `module.exports.${p.name}`;
  return [
    `'use strict';`,
    `// Imprint local recall — auto-generated`,
    `// Source: ${p.relativePath}`,
    `const _src = require('${requirePath}');`,
    p.isExportDefault
      ? `module.exports = _src.default || _src;`
      : `${mod} = _src.${p.name};`,
  ].join('\n');
}

function buildReadme(p: ExtractedPattern, id: string, requirePath: string): string {
  const paramList = p.params.length
    ? p.params.map(p => `- \`${p}\``).join('\n')
    : '- _(none)_';

  const description = p.jsdoc
    || `Exported ${p.kind} from \`${p.relativePath}\`.`;

  return [
    `# ${p.name}`,
    ``,
    `**ID:** \`${id}\`  `,
    `**Source:** \`${p.relativePath}\`  `,
    `**Domain:** ${p.domain} / ${p.subdomain}`,
    ``,
    description,
    ``,
    `## Parameters`,
    ``,
    paramList,
    ``,
    `## Usage`,
    ``,
    `\`\`\`js`,
    `const ${p.isExportDefault ? p.name : `{ ${p.name} }`} = require('${requirePath}');`,
    `\`\`\``,
    ``,
    `## Source snippet`,
    ``,
    `\`\`\`typescript`,
    p.sourceSnippet,
    `\`\`\``,
  ].join('\n');
}

/* ── Main register function ─────────────────────────────────────── */

export function register(
  patterns: ExtractedPattern[],
  opts: RegisterOptions,
): RegisterResult {
  const projectRoot = path.resolve(opts.projectRoot);
  const outputDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : path.join(projectRoot, 'recalls', 'local');

  const result: RegisterResult = { written: 0, skipped: 0, errors: [], recalls: [] };

  for (const p of patterns) {
    const id = makeId(p.domain, p.name);
    const slug = toKebab(p.name);
    const recallDir = path.join(outputDir, p.domain, slug, 'v1');
    const metadataPath = path.join(recallDir, 'metadata.json');

    // Skip if already exists and not overwriting
    if (!opts.overwrite && fs.existsSync(metadataPath)) {
      result.skipped++;
      continue;
    }

    try {
      fs.mkdirSync(recallDir, { recursive: true });

      // Build a relative require path from the project root to the source file
      // e.g.  src/auth/validateUser.ts  →  ../../src/auth/validateUser
      const relFromRecall = path.relative(recallDir, p.filePath)
        .replace(/\\/g, '/')
        .replace(/\.(ts|tsx|mts)$/, '');  // strip TS ext so require() works on compiled JS
      const requirePath = relFromRecall.startsWith('.') ? relFromRecall : `./${relFromRecall}`;

      const metadata = {
        id,
        name: p.name,
        description: p.jsdoc || `Exported ${p.kind} from ${p.relativePath}.`,
        domain: p.domain,
        subdomain: p.subdomain,
        layer: inferLayer(p.params.length, p.kind === 'class'),
        tags: [
          p.domain,
          p.subdomain,
          toKebab(p.name),
          p.isAsync ? 'async' : 'sync',
          p.kind,
          'local',
          'imprint',
        ].filter((t, i, a) => t && a.indexOf(t) === i),
        inputs: p.params,
        outputs: [p.returnType].filter(Boolean),
        callExample: buildCallExample(p, requirePath),
        glueTemplate: buildGlueTemplate(p, requirePath, id),
        dependencies: [],
        implementationPath: path.relative(
          path.join(projectRoot, 'recalls'),
          path.join(recallDir, 'implementation.js'),
        ).replace(/\\/g, '/'),
        source: {
          origin: 'imprint',
          file: p.relativePath,
          scannedAt: new Date().toISOString(),
        },
      };

      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      fs.writeFileSync(
        path.join(recallDir, 'implementation.js'),
        buildImplementation(p, requirePath),
      );
      fs.writeFileSync(
        path.join(recallDir, 'README.md'),
        buildReadme(p, id, requirePath),
      );

      result.written++;
      result.recalls.push({ id, path: recallDir });
    } catch (err: any) {
      result.errors.push({ pattern: `${p.domain}.${p.name}`, reason: err.message });
    }
  }

  return result;
}
