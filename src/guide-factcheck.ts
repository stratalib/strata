'use strict';
/**
 * Fact-check a strata.guide.json against the actual code. See STRATA-GUIDE.md §5.
 *
 * The guide is authored by an LLM, so it CAN be wrong — and a wrong guide silently corrupts every
 * deterministic generation downstream (an adapter built against a table that does not exist, a package
 * that is not installed). This module is the "gates earn trust" bar applied to the guide: pure,
 * deterministic checks that either clear the guide for codegen or list exactly what to fix. It never
 * edits the guide — it only reports. The LLM (or the human) repairs.
 *
 * Severity contract:
 *   - "error" → codegen against this claim would produce broken code. Callers MUST NOT generate the
 *     affected adapter until fixed (fall back to an INJECT slot or refuse).
 *   - "warn"  → probably fine, worth a human glance (a layout path we could not confirm, a provider
 *     package we could not find). Codegen may proceed.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  StrataGuide, Datastore,
  datastoreEntries, capabilityEntries, datastoreFor,
} from './guide.js';

export interface Violation {
  severity: 'error' | 'warn';
  where: string;   // e.g. "datastores.primaryDb" — points the fixer straight at the offending key
  message: string;
}

/** True iff the guide has no ERROR-level violations — i.e. it is safe to generate from. */
export function guideIsTrustworthy(violations: Violation[]): boolean {
  return !violations.some(v => v.severity === 'error');
}

export function factCheckGuide(guide: StrataGuide, projectDir: string): Violation[] {
  const v: Violation[] = [];
  const pkg = readPackageJson(projectDir);
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};

  // ── datastores: the thing adapters are generated against. These are the strict checks.
  for (const [alias, ds] of datastoreEntries(guide)) {
    // A named package must actually be installed, or the adapter's import throws at runtime.
    if (ds.package && !(ds.package in deps)) {
      v.push({ severity: 'error', where: `datastores.${alias}`,
        message: `package "${ds.package}" is not in package.json — the ${ds.kind} adapter would import a missing module.` });
    }
    // A declared schema file must exist, or a schema-backed adapter has nothing to bind to.
    if (ds.schemaFile && !exists(projectDir, ds.schemaFile)) {
      v.push({ severity: 'error', where: `datastores.${alias}`,
        message: `schemaFile "${ds.schemaFile}" does not exist.` });
    }
    if (!ds.kind) {
      v.push({ severity: 'error', where: `datastores.${alias}`, message: `missing "kind".` });
    }
  }

  // ── domains: entities bound to a store. Verify the binding resolves and (where checkable) the entity
  //    really lives where the guide says.
  for (const d of guide.domains ?? []) {
    if (d.store) {
      const ds = datastoreFor(guide, d.store);
      if (!ds) {
        v.push({ severity: 'error', where: `domains.${d.name}.store`,
          message: `store "${d.store}" is not a datastore alias — cannot pick an adapter.` });
      } else if (d.exists && ds.schemaFile) {
        // Only reliably checkable for schema-file-backed stores (Prisma/Drizzle/Mongoose schema).
        const modelName = d.collection ?? d.entity;
        if (modelName && !schemaDeclaresModel(projectDir, ds.schemaFile, modelName)) {
          v.push({ severity: 'warn', where: `domains.${d.name}`,
            message: `marked exists:true but model "${modelName}" was not found in ${ds.schemaFile}. If it lives elsewhere (e.g. an in-memory store), set the right \`store\`; otherwise set exists:false so recalls create it.` });
        }
      }
    }
    // Relations must point at real domains.
    for (const rel of d.relations ?? []) {
      if (rel.to && !(guide.domains ?? []).some(x => x.name === rel.to)) {
        v.push({ severity: 'warn', where: `domains.${d.name}.relations`,
          message: `relation "${rel.field}" points to unknown domain "${rel.to}".` });
      }
    }

    // ── Part 2 (domain capture) v1 checks — STRUCTURAL ONLY, per STRATA-GUIDE.md §10. This does not
    // attempt to verify a rule is TRUE of the code (that is v2, deliberately deferred); it only catches
    // a HALLUCINATED reference — a rule or operation pointing at a file that does not exist — which is
    // the dangerous failure mode: a wrong domain claim silently poisoning every future generation the
    // same way a wrong datastore claim would. A rule with no `enforcedAt` at all is not an error; an
    // unenforceable-by-reference rule is just a plain-language note, which is allowed.
    for (const rule of d.rules ?? []) {
      const file = rule.enforcedAt?.split(':')[0];
      if (file && !exists(projectDir, file)) {
        v.push({ severity: 'error', where: `domains.${d.name}.rules`,
          message: `rule "${rule.text.slice(0, 60)}…" claims enforcedAt "${rule.enforcedAt}" but "${file}" does not exist.` });
      }
      // A rule cannot claim to be verified without something that actually verified it — v2 does not
      // exist yet, so `verifiable:true` today is ALWAYS a false claim, worth catching as loudly as a
      // hallucinated file reference.
      if (rule.verifiable) {
        v.push({ severity: 'error', where: `domains.${d.name}.rules`,
          message: `rule "${rule.text.slice(0, 60)}…" is marked verifiable:true, but no v2 assertion mechanism exists yet — this can only be a false claim right now.` });
      }
    }
    for (const op of d.operations ?? []) {
      if (op.implementedIn && !exists(projectDir, op.implementedIn)) {
        v.push({ severity: 'error', where: `domains.${d.name}.operations.${op.name}`,
          message: `implementedIn "${op.implementedIn}" does not exist.` });
      }
    }
    for (const dep of d.dependsOn ?? []) {
      if (dep.domain && !(guide.domains ?? []).some(x => x.name === dep.domain)) {
        v.push({ severity: 'warn', where: `domains.${d.name}.dependsOn`,
          message: `dependsOn points to unknown domain "${dep.domain}".` });
      }
    }
  }

  // ── capabilities: cross-cutting ports → backing store/provider.
  for (const [port, cap] of capabilityEntries(guide)) {
    const backing = cap.backing ?? cap.defaultBacking;
    if (backing && !datastoreFor(guide, backing)) {
      v.push({ severity: 'error', where: `capabilities.${port}`,
        message: `backing "${backing}" is not a datastore alias.` });
    }
    // A provider (nodemailer, s3 sdk…) is an npm package we will import — warn (not error) if unseen,
    // since some providers are core modules or the recall bundles its own client.
    const providerPkg = providerPackage(cap.provider, cap.via);
    if (providerPkg && !(providerPkg in deps)) {
      v.push({ severity: 'warn', where: `capabilities.${port}`,
        message: `provider "${cap.provider ?? cap.via}" usually needs "${providerPkg}", not found in package.json.` });
    }
  }

  // ── layout: not fatal (the LLM may name a path it intends to create), but flag surprises.
  for (const key of ['sourceRoot', 'routes', 'services', 'dataAccess', 'entryPoint'] as const) {
    const rel = guide.layout?.[key];
    if (rel && !exists(projectDir, rel)) {
      v.push({ severity: 'warn', where: `layout.${key}`, message: `path "${rel}" does not exist yet.` });
    }
  }

  return v;
}

// ─── helpers (all deterministic, best-effort, never throwing on a weird project) ──────────────

function exists(projectDir: string, rel: string): boolean {
  try { return fs.existsSync(path.join(projectDir, rel)); } catch { return false; }
}

function readPackageJson(projectDir: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Does a schema file declare a model/table by name? Covers the common declaration syntaxes without a
 * full parser (which would be brittle across Prisma/Drizzle/Mongoose): Prisma `model User {`,
 * Drizzle/SQL `... "User" (`, Mongoose `new Schema(... 'User'`. A conservative regex — a miss is a WARN,
 * never a hard error, precisely because this check is heuristic.
 */
function schemaDeclaresModel(projectDir: string, schemaFile: string, model: string): boolean {
  let src: string;
  try { src = fs.readFileSync(path.join(projectDir, schemaFile), 'utf-8'); } catch { return false; }
  const m = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\bmodel\\s+${m}\\b`, 'i'),                 // Prisma
    new RegExp(`\\b(table|createTable)\\b[^\\n]*['"\`]?${m}['"\`]?`, 'i'), // Drizzle/Knex
    new RegExp(`['"\`]${m}['"\`]`),                         // fallback: the name appears quoted
  ];
  return patterns.some(re => re.test(src));
}

/** Best-effort provider → npm package. Extend as the adapter grid grows. */
function providerPackage(provider?: string, via?: string): string | null {
  const key = (provider ?? via ?? '').toLowerCase();
  const map: Record<string, string> = {
    nodemailer: 'nodemailer',
    resend: 'resend',
    sendgrid: '@sendgrid/mail',
    s3: '@aws-sdk/client-s3',
    'aws-sdk-v3': '@aws-sdk/client-s3',
    bullmq: 'bullmq',
    ioredis: 'ioredis',
    'node-redis': 'redis',
  };
  return map[key] ?? null;
}
