'use strict';
/**
 * strata.guide.json — the project's data map. See STRATA-GUIDE.md for the full design.
 *
 * This module is the FOUNDATION: the type of the guide, a loader, and staleness detection. It is pure
 * (fs + crypto only, no LLM, no network) so it can be unit-tested and so `strata_use` can read a guide
 * on every call at zero token cost. Authoring the guide (the LLM pass) and generating adapters FROM it
 * live in later modules — this one only turns the file on disk into a typed object and answers "is it
 * still true?".
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const GUIDE_FILENAME = 'strata.guide.json';
export const GUIDE_SCHEMA = 'strata-guide/v1';

// ─── Types ────────────────────────────────────────────────────────────────────
// These mirror strata.guide.example.json exactly. Kept deliberately permissive (open string unions,
// optional everything the engine can live without) because the guide is authored by an LLM against real,
// varied projects — a type too strict would reject valid maps of stacks we did not anticipate, which is
// the opposite of "adaptable to anything commonly used".

export interface GuideMeta {
  authoredBy?: string;
  authoredAt?: string;
  reviewedByHuman?: boolean;
  /** sha256 over the files this guide describes; a mismatch means the guide is stale. */
  sourceHash?: string;
}

export interface Stack {
  language?: string;       // "javascript" | "typescript" | …
  moduleSystem?: string;   // "commonjs" | "esm"
  framework?: string;      // "express" | "fastify" | "hono" | …
  runtime?: string;        // "node" | …
}

export interface Layout {
  sourceRoot?: string;
  entryPoint?: string;
  routes?: string;
  services?: string;
  dataAccess?: string;
  envFile?: string;
}

export interface Conventions {
  naming?: string;
  asyncStyle?: string;
  errorHandling?: string;
  routeStyle?: string;
}

/** THE X — a storage harness. `kind`/`via` are open strings so any store is expressible. */
export interface Datastore {
  kind: string;            // "postgres" | "redis" | "in-memory" | "s3" | …
  via?: string;            // "prisma" | "ioredis" | "aws-sdk-v3" | "module-array" | …
  package?: string;
  access?: string;         // snippet that constructs `handle`
  handle?: string;         // the variable adapters call into
  schemaFile?: string;     // e.g. prisma/schema.prisma — hashed for staleness
  bucketEnv?: string;
  liveAtRuntime?: boolean; // the "aspirational schema" nuance
  _note?: string;
}

export interface DomainField {
  name: string;
  type: string;            // "string" | "number" | "boolean" | "date" | "enum" | "array"
  isId?: boolean;
  generated?: boolean;
  required?: boolean;
  /**
   * Value a new record starts with when the caller supplies none.
   *
   * Load-bearing for state fields. A transition declares which states it may run FROM; if a freshly
   * created record has no state at all, every transition refuses it — measured, as a 409 from a
   * cancelOrder whose order had `status: undefined` because `status` was not a required field and so
   * nothing ever set it. Where this is absent for an enum, the generated store falls back to the FIRST
   * enum member, which is the conventional lifecycle order (building/ready/promoted,
   * pending/paid/cancelled, active/paused/cancelled) and is proven by the generated check either way.
   */
  default?: unknown;
  /**
   * For `type: "array"` — the shape of ONE element, so a list of records can be validated.
   *
   * Without it a list is checked for existence and then waved through: `items: [{ sku, qty: -5 }]`
   * reaches the handler because the array is present and non-empty. Declaring the element shape is
   * what lets generated validation reject it, and it is the difference between a list being
   * *supplied* and a list being *valid*.
   *
   * Generic on purpose — order lines, invoice rows, cart entries, shipment parcels and batch payloads
   * are all the same shape of problem.
   */
  items?: Record<string, { type: string; required?: boolean; min?: number; max?: number; enumValues?: string[] }>;
  unique?: boolean;
  min?: number;
  minLength?: number;
  enumValues?: string[];
}

export interface Relation {
  field: string;
  to: string;              // another domain's `name`
  kind: string;            // "one-to-many" | "many-to-one" | "one-to-one" | "many-to-many"
  foreignKey?: string;
}

/**
 * A plain-language business invariant (STRATA-GUIDE.md §9, Part 2 — domain capture).
 * `enforcedAt` is what makes this fact-checkable at all (v1, §10): a file/function reference must
 * resolve to something real. `verifiable` is honest bookkeeping — false until the rule carries an
 * assertion that has ACTUALLY been run and passed (v2, deferred — do not build ahead of v1).
 */
export interface DomainRule {
  text: string;
  /** e.g. "src/routes/orders.js:createOrder" — the file (and optionally function) that enforces this. */
  enforcedAt?: string;
  /** Always false until a v2 runnable assertion exists and has passed. Never asserted true by an LLM. */
  verifiable?: boolean;
  _note?: string;
}

/** A named use-case with a contract — richer than a bare route, so a LATER task doesn't have to re-read
 *  the implementation to learn what createOrder actually guarantees. */
export interface DomainOperation {
  name: string;
  route?: string;
  requires?: string[];
  guarantees?: string;
  /** e.g. "src/routes/orders.js" — must resolve (v1 fact-check). */
  implementedIn?: string;
  /**
   * A state transition, declared as DATA rather than left to be read out of prose.
   *
   * `on` is any field that carries state — an enum, a boolean flag, or a nullable timestamp; all three
   * are common and picking one would make this serve a third of the cases it should. `to` is an enum
   * member, true/false, or "now"/null. `idempotent` is the author's call and nothing else's: one
   * company answers a repeated cancel with the current order, another with 409, and neither is derivable
   * from the word "cancel".
   *
   * Optional. Without it the engine will try to compile the same information out of `requires` and
   * `guarantees`, and will emit an INJECT slot rather than guess if it cannot.
   */
  transition?: {
    on: string;
    from?: string[];
    to: string | boolean | null;
    idempotent?: boolean;
  };
  _note?: string;
}

/** A CONSTRAINT one domain places on another — the business-rule shape, not the DB-foreign-key shape
 *  (`relations[]` already covers FKs). `domain` must be a real domain name (v1 fact-check). */
export interface DomainDependency {
  domain: string;
  via: string;
  _note?: string;
}

/** THE Y (entity) — a business domain, bound to a datastore by alias. */
export interface Domain {
  name: string;
  entity: string;
  exists?: boolean;
  store?: string;          // datastore alias, or null/absent when no store yet
  collection?: string;     // table / model / collection name in that store
  idField?: string;
  route?: string;
  storeInterface?: string[];
  /** port-method → project-method, e.g. { "findById": "getById" }. Kills wiring-guess mismatches. */
  methodAliases?: Record<string, string>;
  fields?: DomainField[];
  relations?: Relation[];
  /** Business shape, not just data shape (Part 2). Optional — Case-A domains (shape-only) stay valid
   *  without any of these three. */
  rules?: DomainRule[];
  operations?: DomainOperation[];
  dependsOn?: DomainDependency[];
  _note?: string;
}

/** THE Y (cross-cutting port) — bound to a backing datastore alias or an external provider. */
export interface Capability {
  backing?: string;        // datastore alias
  defaultBacking?: string; // for EntityStore fallback
  provider?: string;       // e.g. "nodemailer", "s3"
  transport?: string;
  via?: string;            // e.g. "bullmq"
  envSlots?: string[];
  _note?: string;
}

export interface EnvSpec {
  declared?: string[];
  casing?: string;
}

export interface StrataGuide {
  schema: string;
  meta?: GuideMeta;
  /**
   * One authoritative sentence the LLM writes about this project's data reality, surfaced verbatim in
   * every delivery. This is what stops the model reconciling against a data layer that isn't really
   * there — e.g. "Persistence is in-memory; @prisma/client is NOT installed and the Prisma schema is
   * aspirational — do not add Prisma; new stores are in-memory." The single highest-value line in the file.
   */
  guidance?: string;
  stack?: Stack;
  layout?: Layout;
  conventions?: Conventions;
  datastores?: Record<string, Datastore>;
  domains?: Domain[];
  capabilities?: Record<string, Capability>;
  env?: EnvSpec;
}

// ─── Load ───────────────────────────────────────────────────────────────────

/**
 * Load a project's guide. Returns null when ABSENT (the first-run signal — the caller triggers
 * authoring). THROWS on a present-but-broken guide, deliberately: a malformed guide silently ignored
 * would drop the engine back to no-adaptation and reintroduce the reconciliation tax invisibly, which is
 * exactly the kind of silent-wrong-result this project treats as the worst failure mode. Loud beats wrong.
 */
export function loadGuide(projectDir: string): StrataGuide | null {
  const p = path.join(projectDir, GUIDE_FILENAME);
  if (!fs.existsSync(p)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    throw new Error(`${GUIDE_FILENAME} exists but could not be read: ${errMsg(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // The LLM authored this; a trailing comma should be a clear, fixable error, not a mystery.
    throw new Error(`${GUIDE_FILENAME} is not valid JSON: ${errMsg(e)}`);
  }

  const guide = parsed as StrataGuide;
  if (!guide || typeof guide !== 'object' || Array.isArray(guide)) {
    throw new Error(`${GUIDE_FILENAME} must be a JSON object.`);
  }
  if (typeof guide.schema !== 'string' || !guide.schema.startsWith('strata-guide/')) {
    throw new Error(`${GUIDE_FILENAME} is missing a "schema" field like "${GUIDE_SCHEMA}".`);
  }
  return guide;
}

/** Resolve a domain by name, or a capability's port name — the two ways a recall's `requires` binds in. */
export function domainByName(guide: StrataGuide, name: string): Domain | undefined {
  return (guide.domains ?? []).find(d => d.name === name || d.entity === name);
}

/**
 * JSON has no comments, so `_`-prefixed keys are our inline-comment convention (`_note`). EVERY consumer
 * must read maps through these accessors, never Object.entries directly — otherwise adapter generation
 * would iterate a phantom datastore/capability named "_note". Centralised here so the rule is enforced
 * in one place, not re-remembered at every call site.
 */
function realEntries<T>(map: Record<string, T> | undefined): Array<[string, T]> {
  return Object.entries(map ?? {}).filter(([k]) => !k.startsWith('_'));
}

export function datastoreEntries(guide: StrataGuide): Array<[string, Datastore]> {
  return realEntries(guide.datastores);
}

export function capabilityEntries(guide: StrataGuide): Array<[string, Capability]> {
  return realEntries(guide.capabilities);
}

/** The datastore a domain (or capability backing) points at, by alias. */
export function datastoreFor(guide: StrataGuide, alias: string | undefined): Datastore | undefined {
  if (!alias || alias.startsWith('_')) return undefined;
  return guide.datastores?.[alias];
}

// ─── Staleness ────────────────────────────────────────────────────────────────

/**
 * The set of files whose content the guide's truth depends on. If any change, the guide may be lying —
 * so we hash exactly these and store the digest in meta.sourceHash. We hash CONTENT, not mtime: a
 * `git checkout` rewinds mtimes but not content, and content is what the guide actually describes.
 */
export function describedSources(guide: StrataGuide, projectDir: string): string[] {
  const rel = new Set<string>();
  rel.add('package.json');
  if (guide.layout?.entryPoint) rel.add(guide.layout.entryPoint);
  for (const [, ds] of datastoreEntries(guide)) {
    if (ds.schemaFile) rel.add(ds.schemaFile);
  }
  // Absolute, existing, de-duplicated, sorted → a deterministic digest input.
  return [...rel]
    .map(r => path.join(projectDir, r))
    .filter(fs.existsSync)
    .sort();
}

/** sha256 over the described sources' content. Sorted paths + length-prefixed content = order-stable. */
export function hashSources(guide: StrataGuide, projectDir: string): string {
  const h = crypto.createHash('sha256');
  for (const abs of describedSources(guide, projectDir)) {
    const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
    let content: Buffer;
    try {
      content = fs.readFileSync(abs);
    } catch {
      content = Buffer.alloc(0);
    }
    // Frame each file so "ab"+"c" and "a"+"bc" can never collide across the boundary.
    h.update(rel);
    h.update('\0');
    h.update(String(content.length));
    h.update('\0');
    h.update(content);
  }
  return 'sha256:' + h.digest('hex');
}

/**
 * Is the guide out of date with the code it describes? A guide with no recorded hash is treated as stale
 * (it was never anchored to a source snapshot). Callers use this to trigger an LLM refresh of the drifted
 * sections, never to silently regenerate.
 */
export function isStale(guide: StrataGuide, projectDir: string): boolean {
  const recorded = guide.meta?.sourceHash;
  if (!recorded) return true;
  return recorded !== hashSources(guide, projectDir);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
