'use strict';
/**
 * Step 4 — turn a guide + the delivered recalls into ready store adapters. See STRATA-GUIDE.md §6.
 *
 * The recalls already ship their own store factories with in-memory defaults (`createUserStore`,
 * `createSessionStore`, `createIdempotencyStore(opts)`) AND an injection point
 * (`idempotencyMiddleware(store)`, `createIdentityService(store)`). The brownfield tax was the model
 * HAND-WRITING a persistence-backed store to inject in place of the default. This module does that
 * deterministically: for each recall that exposes a `create*Store`, it reads the guide's binding for that
 * concept and renders the matching adapter — the exact file the losses paid turns to write.
 *
 * It is pure (guide + recall metadata + fs reads via the fact-checker) so it runs with ZERO LLM cost and
 * can be proven by booting the generated adapters directly.
 */

import * as path from 'path';
import {
  StrataGuide, Domain, Datastore, domainByName, datastoreFor, capabilityEntries, datastoreEntries,
} from './guide.js';
import { factCheckGuide, guideIsTrustworthy, Violation } from './guide-factcheck.js';
import { renderEntityStore, renderKeyValueStore, RenderedAdapter } from './adapters.js';

/** The minimal recall shape this needs — just an id and its export signatures. */
export interface RecallLike {
  id: string;
  outputs?: string[];
}

export interface GeneratedFile {
  /** Path relative to the project root, e.g. "src/data/userStore.js". */
  rel: string;
  code: string;
  /** The factory the wiring calls, e.g. "createUserStore". */
  factory: string;
  /** How the model should inject it — one line, so the wire-up is trivial not derived. */
  inject: string;
  gaps: string[];
}

export interface GenerateResult {
  trustworthy: boolean;
  violations: Violation[];
  files: GeneratedFile[];
  /** Concepts a recall exposed a store for but the guide did not bind — left as the recall's default. */
  unbound: string[];
  /** One authoritative line about the project's data reality, surfaced in the delivery. */
  dataLayerNote: string;
}

/**
 * The data-reality line surfaced in every guide-bearing delivery. The LLM's explicit `guidance` leads
 * (it stops the model reconciling against a data layer that isn't there); a derived summary of the live
 * vs aspirational datastores backs it up so the note is never empty when a guide exists.
 */
export function dataLayerNote(guide: StrataGuide): string {
  const parts: string[] = [];
  if (guide.guidance) parts.push(guide.guidance.trim());

  const dss = datastoreEntries(guide);
  const live = dss.filter(([, d]) => d.liveAtRuntime !== false).map(([a, d]) => `${a}=${d.kind}${d.via ? `(${d.via})` : ''}`);
  const dead = dss.filter(([, d]) => d.liveAtRuntime === false);
  if (live.length) parts.push(`Live persistence: ${live.join(', ')}.`);
  for (const [a, d] of dead) {
    parts.push(`${a}${d.schemaFile ? ` (${d.schemaFile})` : ''} is NOT live at runtime — do not persist against it.`);
  }
  return parts.join(' ');
}

// The KV-family capability ports. A `create<Port>` export whose port is one of these gets a KV adapter.
const KV_PORTS = new Set(['SessionStore', 'IdempotencyStore', 'RateLimiterStore', 'Cache']);

/**
 * Generate persistence adapters for the delivered recalls from the guide. Never throws on a weird recall
 * set — an unmatched store factory is simply left `unbound` (the recall keeps its default).
 */
export function generateAdapters(
  guide: StrataGuide,
  recalls: RecallLike[],
  projectDir: string,
): GenerateResult {
  const violations = factCheckGuide(guide, projectDir);
  if (!guideIsTrustworthy(violations)) {
    // A guide that fails its own checks is not generated from — reintroducing a wrong adapter is worse
    // than leaving the recall's default and letting the model see the fact-check errors.
    return { trustworthy: false, violations, files: [], unbound: [], dataLayerNote: '' };
  }

  const dataDir = guide.layout?.dataAccess || guide.layout?.sourceRoot || '.';
  const files: GeneratedFile[] = [];
  const unbound: string[] = [];
  const seen = new Set<string>();   // dedupe by factory across recalls

  for (const recall of recalls) {
    for (const concept of storeConcepts(recall.outputs ?? [])) {
      if (seen.has(concept.factory)) continue;

      const rendered = renderFor(guide, concept);
      if (!rendered) { unbound.push(concept.name); continue; }
      seen.add(rendered.factory);

      files.push({
        rel: path.posix.join(dataDir, rendered.filename),
        code: rendered.code,
        factory: rendered.factory,
        inject: injectionHint(recall, concept, rendered),
        gaps: rendered.gaps,
      });
    }
  }

  return { trustworthy: true, violations, files, unbound, dataLayerNote: dataLayerNote(guide) };
}

// ─── matching ──────────────────────────────────────────────────────────────────

interface StoreConcept {
  /** The bare concept, e.g. "User" or "Session". */
  name: string;
  /** The recall's own factory export, e.g. "createUserStore". */
  factory: string;
  /** true if the concept names a KV-family capability port rather than a domain entity. */
  isKv: boolean;
  port?: string;   // e.g. "SessionStore"
}

/** Find `create<X>Store` exports and classify each as an entity store or a KV-family port. */
function storeConcepts(outputs: string[]): StoreConcept[] {
  const out: StoreConcept[] = [];
  for (const sig of outputs) {
    const m = sig.match(/^create([A-Z]\w*?)Store\b/);
    if (!m) continue;
    const name = m[1];                 // "User", "Session", "Idempotency"
    const port = `${name}Store`;       // "SessionStore", "IdempotencyStore"
    out.push({ name, factory: `create${name}Store`, isKv: KV_PORTS.has(port), port });
  }
  return out;
}

// Every recall already ships an in-memory default store, so generating an in-memory adapter is a pure
// no-op DUPLICATE — it adds nothing and forces the model to reconcile two identical stores (this hurt
// the idempotency run). So we generate ONLY when the guide binds to a REAL backend the recall does not
// default to (prisma/redis/mongo/…), or when wrapping an EXISTING project store (methodAliases). An
// in-memory binding leaves the recall's own default in place — the guidance NOTE still ships either way.
function isInMemory(ds: Datastore | undefined): boolean {
  const v = `${ds?.kind ?? ''} ${ds?.via ?? ''}`.toLowerCase();
  return /in-memory|module-array/.test(v);
}

function renderFor(guide: StrataGuide, concept: StoreConcept): RenderedAdapter | null {
  if (concept.isKv && concept.port) {
    // Bind the port to its backing datastore via the guide's capabilities map.
    const cap = capabilityEntries(guide).find(([p]) => p === concept.port)?.[1];
    const backing = cap?.backing ?? cap?.defaultBacking;
    const ds = datastoreFor(guide, backing);
    if (!ds || isInMemory(ds)) return null;   // redundant with the recall's in-memory default
    return renderKeyValueStore(concept.port, ds);
  }
  // Entity store: match the concept to a domain (User -> user).
  const domain: Domain | undefined = domainByName(guide, concept.name) ?? domainByName(guide, concept.name.toLowerCase());
  if (!domain) return null;
  const isWrapper = !!(domain.methodAliases && Object.keys(domain.methodAliases).length);
  const ds: Datastore | undefined =
    datastoreFor(guide, domain.store) ??
    datastoreFor(guide, guide.capabilities?.EntityStore?.defaultBacking);
  // Wrapping an existing store is never redundant (it maps port names onto real methods) — keep it.
  if (isWrapper) return renderEntityStore(domain, ds ?? { kind: 'in-memory', via: 'in-memory' });
  // A fresh store is only worth generating against a real backend; in-memory would duplicate the default.
  if (!ds || isInMemory(ds)) return null;
  return renderEntityStore(domain, ds);
}

/** One-line, copy-pasteable injection guidance, so the model's only job is to wire, not to derive. */
function injectionHint(recall: RecallLike, concept: StoreConcept, r: RenderedAdapter): string {
  return `${recall.id}: import { ${r.factory} } from './${r.filename.replace(/\.js$/, '')}' and pass ${r.factory}(…) `
    + `where the recall takes its ${concept.name} store, replacing the default in-memory one.`;
}
