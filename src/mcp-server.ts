import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { exec } from 'child_process';
// NOTE: no LLM client is imported here, and that is deliberate. Strata's delivery path is now fully
// deterministic — it makes zero API calls and needs no ANTHROPIC_API_KEY. Task decomposition used to
// fire a live Haiku call on the critical path; it was redundant (the calling model already enumerated
// the components), it cost API money on a subscription product, and one flaky HTTP call could void an
// entire delivery. See decomposeTask().

// Load .env for optional hub credentials (STRATA_HUB_*). No API key is required to run Strata.
;(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1 || line.startsWith('#')) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
})();

import { SearchEntry } from './peer-server.js';
import { loadConfig } from './config.js';
import { loadHubIndex, type HubIndexRecall } from './hub-index.js';
import { hubSearch, hubRead, hubList, hubUpload } from './hub-client.js';
import {
  ensureLoopDirs, writeRecord, makeSession, readOutbox, clearOutboxItems,
  type LoopSignal, type LoopFinding, type LoopCandidate,
} from './strata-loop.js';
import { imprint as runImprint, resolveGlue, loadConventions, scanEnvFile } from './imprint/index.js';
import { extractEntities, resolveEntity, resolveDataSource, sortableFields, filterableFields, routePath, csvSchemaFor, Entity, EntityField } from './imprint/entities.js';
import { detectProjectShape, mountWiring, appVarName, ProjectShape } from './imprint/project-shape.js';
import { buildVerifierScript } from './verifier.js';
import { loadGuide } from './guide.js';
import { generateAdapters } from './guide-generate.js';
import { appendUsageLog, hashProject } from './logger.js';
import { embedText, cosineSimilarity } from './embeddings.js';
import pkg from '../package.json';
import { buildFitnessMap, saveLiveSignal } from './fitness-tracker.js';
import { loadPrefs, captureMiss } from './requests.js';
import { loadSelections, lookupSelection, saveSelection, setRecallSetFingerprint } from './l1-cache.js';

// Composing FOR THE HUB: leave every {{PLACEHOLDER}} in place, because the hub is not allowed to know
// anything project-specific. The client substitutes locally from a schema that never left the machine.
import { composeOnHub, HubUnavailable, rejectUnsafePaths } from './remote-compose.js';

// `config.mode === 'hub'` (see config.ts — now the default for a fresh install) is already the
// deliberate signal to compose remotely. A second env-var gate on top of it was dead weight — nobody
// sets a hub URL and then doesn't want it used, and requiring an undocumented extra flag is exactly
// how a real feature ships invisible. Local mode is still one line of config away for anyone who wants
// their own recalls/ checkout to be authoritative instead.

const COMPOSE_DEFERRED = process.env.STRATA_COMPOSE_DEFERRED === '1';

// Deliver the composed implementation as an installed node_modules dependency, not as source in
// strata/lib.js. DEFAULT ON since 2026-07-23: measured, a model audits source (reads it, re-verifies,
// rewrites) but leaves a dependency alone, and that audit was the entire cost overrun — dependency
// delivery took catalog from +118% over baseline to +3%. Opt out with STRATA_DELIVER_AS_DEP=0. See
// STRATA-BENCHMARK-FINDINGS.md. If the install ever fails, the helper returns undefined and the caller
// falls back to source delivery, so this can never produce a broken import.
const DELIVER_AS_DEP = process.env.STRATA_DELIVER_AS_DEP !== '0';
const COMPOSED_DEP_NAME = 'strata-composed';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A ranked contribution to the composed server.
 *
 * TWO FORMS, and the difference is whether the recall is framework-portable.
 *
 *   file    — raw source. Whatever it contains is emitted verbatim, so `app.use(x)` locks the recall
 *             to Express forever. Fine for SETUP (constructing a logger is framework-neutral code);
 *             wrong for anything that mounts.
 *
 *   factory — DECLARATIVE. "register `requestLogger(logger)` as middleware at rank 10." The recall says
 *             WHAT to register; the framework renderer decides HOW.
 *
 * The declarative form is the IR, and it is cheap because Connect-style middleware is already the
 * lingua franca: Fastify consumes it through @fastify/middie, Koa through koa-connect. So a recall
 * exporting `(req, res, next)` handlers is ALREADY portable — it just must not hardcode `app.use`.
 *
 * That turns framework support from O(recalls x frameworks) into O(recalls + frameworks): one renderer
 * per framework, no per-recall adapters. Author new recalls declaratively and they come along free.
 */
interface ComposeFragment {
  /** Lower runs first. Middleware order is order-dependent, and order is what teams get wrong. */
  rank: number;
  /** Raw source, emitted verbatim. Framework-specific — use `factory` for anything that mounts. */
  file?: string;
  /** DECLARATIVE: the exported function to register, e.g. "requestLogger". Framework-portable. */
  factory?: string;
  /** Arguments to the factory, emitted verbatim as expressions, e.g. ["logger"]. */
  args?: string[];
  /**
   * A regex the TASK must match for this fragment to be emitted at all.
   *
   * Recalls bundle related capabilities — cache.ratelimit.v1 ships a response cache alongside the
   * token-bucket limiter. Ask for rate limiting and you used to get a cache too. A benchmark session
   * called it exactly right: "the response cache is an UNREQUESTED addition baked into both the wiring
   * and its own test suite. I'll remove it since it wasn't asked for" — and paid turns to rip it out.
   *
   * Over-generation is a tax, not a bonus. Code nobody asked for costs turns to notice, understand and
   * delete, and it makes everything shipped alongside it look less deliberate. Absent `when`, a
   * fragment is always included.
   */
  when?: string;
  /** Exports this fragment needs. Only imported when the fragment is actually included. */
  imports?: string[];
}

interface ComposeServer {
  /** Exports this recall always needs, regardless of which fragments are included. */
  imports?: string[];
  /** Verbatim require lines that are not assembly imports (e.g. a local data module). */
  extraRequires?: string[];
  /** Instance creation — `const logger = createLogger(...)`. Runs before `app` exists. */
  setup?: ComposeFragment[];
  /** Legacy single-file setup. Superseded by `setup`, kept so older recalls keep working. */
  setupFile?: string;
  /** `app.use(...)` registrations. */
  middleware?: ComposeFragment[];
  /** Route definitions. */
  routesFile?: string;
  /** Terminal error handlers. Always emitted last, after every route. */
  errorHandlers?: ComposeFragment[];
  /**
   * Runs AFTER `const server = app.listen(...)`, with `server` in scope. This is the only slot that
   * gets the http.Server handle — needed by anything that has to act on the running server itself:
   * graceful shutdown (`server.close()`), a websocket upgrade, a keep-alive tuning call. Its presence
   * is what makes the skeleton capture `server` at all; without it, `app.listen(...)` stays bare.
   */
  afterListen?: ComposeFragment[];
  /**
   * This recall contributes a real `/health` route, so the skeleton must NOT also emit its throwaway
   * stub. Two `/health` handlers is dead duplicate code — exactly the unrequested output we tax
   * ourselves for elsewhere.
   */
  providesHealth?: boolean;
}

interface RecallEntry {
  /**
   * Checks this recall declares for its own delivered behaviour, run against the live server by
   * `strata/verify.js`. Coverage travels WITH the recall — the engine no longer needs a per-recall
   * flag, which was an O(N) engine edit per recall and left 5 of 11 recalls proving nothing.
   */
  verifierChecks?: Array<{ name: string; code: string }>;
  id: string;
  name: string;
  description: string;
  domain: string;
  tags: string[];
  complexity?: string;
  dependencies?: string[];
  useCases?: string[];
  inputs?: string[];
  outputs?: string[];
  callExample?: string;
  fullContextRequired?: boolean;
  envSlots?: string[];
  wiringTemplate?: string;
  scaffold?: {
    serverRole?: 'primary' | 'setup';
    workerRole?: 'primary' | 'setup';
    serverImports?: string[];
    workerImports?: string[];
    npmPackages?: Record<string, string>;
  };
  // V4 composition. The `scaffold` block above is winner-take-all: buildScaffold picks ONE recall
  // whose serverRole is 'primary' and uses its whole scaffold-server.js as the app. When several
  // recalls each declare 'primary' — measured: the `platform` task selected FOUR — the losers are
  // silently dropped, contributing no imports, no setup and no routes. The session then hand-wrote
  // all of it, which is exactly the output Strata exists to eliminate.
  //
  // Here, no recall owns the app. Strata owns the skeleton (templates/express-skeleton.js) and every
  // recall merely CONTRIBUTES. Composition becomes additive, so N recalls compose for any N.
  compose?: {
    server?: ComposeServer;
    npmPackages?: Record<string, string>;
  };
  // Ports & adapters (STRATA-PORTS.md) — which abstract capability contract(s) this
  // recall satisfies (provides) or depends on (requires). Enables "exactly one adapter
  // per port" selection, deterministic composition without per-shape hand-authoring.
  provides?: string[];
  requires?: string[];
  providerName?: string;
  physicalPath: string;
  layer: number;
}

type ScoredRecall = RecallEntry & { score: number };

interface DeliveredRecall {
  id: string;
  name: string;
  description: string;
  filename: string;
  inputs?: string[];
  outputs?: string[];
  callExample?: string;
  callExamples?: string[];
  useCases?: string[];
  isComposite?: boolean;
  compositeIds?: string[];
}

interface LibraryIndex {
  stats: { totalSnippets: number; totalCodes: number; totalSystems: number; totalRecalls: number };
  snippets: Array<{ id: string; name: string; domain: string; lineCount: number; tags: string[]; path: string }>;
  codes: Array<{ id: string; name: string; domain: string; lineCount: number; tags: string[]; path: string }>;
  searchIndex: SearchEntry[];
}

// ─── Config + mode ────────────────────────────────────────────────────────────

const config = loadConfig();
const isHub = config.mode === 'hub' && !!config.hub;

if (isHub) {
  console.error(`[strata] Running in hub mode → ${config.hub!.url}`);
} else {
  console.error('[strata] Running in local mode');
}

// ─── Local library ────────────────────────────────────────────────────────────

const recallsDir = path.join(__dirname, '..', '..', 'recalls');

/**
 * Where mutable cache state lives.
 *
 * The repo's own cache/ when it exists — development, where fitness data, selections and delivery
 * receipts are read by hand. Otherwise the user's home directory, because an INSTALLED package has no
 * cache/ at all (it is not in package.json's `files`) and a global npx directory can be read-only.
 *
 * Writing runtime state inside a package directory is only correct when that directory is a checkout.
 * It was doing so unconditionally, and the missing directory threw ENOENT straight out through the
 * tool handler: every strata_use call in every install failed with "Strata error: ... Write from
 * scratch", from a write whose only purpose was to speed up the next call.
 */
function resolveCacheDir(): string {
  const packageCache = path.join(__dirname, '..', '..', 'cache');
  if (fs.existsSync(packageCache)) return packageCache;
  return path.join(os.homedir(), '.strata', 'cache');
}

const recallMap = new Map<string, RecallEntry>();
const allRecalls: RecallEntry[] = [];
const searchIndexMap = new Map<string, SearchEntry>();
let fitnessMap = new Map<string, number>(); // recallId → fitness 0-100, loaded after walkRecalls

// ─── The curated allowlist (curated, not scraped) ──────────────────────────────
// Strata delivers ONLY recalls that have passed scripts/verify-recalls.ts (render-and-run:
// require-loads, every claimed export reachable at runtime, scaffold templates parse). The
// ~7,300 scraped recalls are NOT on this list and are quarantined — never indexed, never
// delivered. This is the structural fix for the entire class of benchmark failures this week:
// every interloper that broke a run (auth.full.express.v1, queue-worker-pool, empty stubs) was
// a non-curated recall, so they simply cease to exist in the selection pool. The guard/ports/
// fat-consolidation pipeline still runs but over a small clean pool, where it's a harmless no-op.
// The library grows ONLY by a recall passing verification and being added to the allowlist —
// never by scraping. When a task has no verified match, that's an honest miss: the session writes
// from scratch and contributes the code back as a candidate (strata_signal), which gets verified
// and promoted. Generation + verification replaces scraping.
const verifiedIds = new Set<string>();
let verifiedListLoaded = false;

function loadVerifiedAllowlist(): void {
  const p = path.join(__dirname, '..', '..', 'cache', 'verified-recalls.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const ids = Array.isArray(parsed?.verified) ? parsed.verified : [];
    for (const id of ids) if (typeof id === 'string') verifiedIds.add(id);
    verifiedListLoaded = verifiedIds.size > 0;
    if (verifiedListLoaded) {
      console.error(`[strata] curated allowlist active: ${verifiedIds.size} verified recall(s); everything else quarantined.`);
    }
  } catch {
    // Missing/empty allowlist → degraded legacy mode: index everything (old scraped behavior)
    // rather than brick delivery. A warning so this state is never silent.
    verifiedListLoaded = false;

    // ...but in an INSTALLED package the file is absent BY DESIGN — cache/ is not published, because
    // the library is served from the hub. There is no local recalls/ tree to "index everything" from
    // and no scripts/ directory to run, so the legacy warning described a situation that cannot exist
    // and prescribed a fix the user does not have. Alarming on the normal path trains people to
    // ignore the log, which is where the real warnings live.
    if (fs.existsSync(recallsDir)) {
      console.error('[strata] WARNING: no verified-recalls.json — running in LEGACY mode (all recalls indexed, incl. unverified scraped ones). Run scripts/verify-recalls.ts to enable the curated allowlist.');
    }
  }
}

// recallId → precomputed embedding, from recalls/recall-embeddings.json (npm run recalls:embed).
// Used as a semantic precision filter on top of lexical scoring — see embeddings.ts for why.
// A recall missing an embedding (e.g. just-added, before the next embed run) isn't penalized;
// it falls back to lexical-only scoring rather than being silently excluded.
const embeddingMap = new Map<string, Float32Array>();
// Calibrated against real data (2026-07-03), not a guess: 5 needed recalls scored 0.544-0.736
// against their real per-capability decompose phrases; the 4 recalls that wrongly polluted
// AB-scaffold-9's assembly scored at most 0.438 against the redundant capability phrase that
// dragged them in ("redis-job-storage", when the correctly-matching recall was already claimed
// by an earlier phrase). 0.45 sits in the real gap between those two clusters with margin on
// both sides. Re-validate if this starts rejecting legitimate recalls or admitting bad ones —
// this is one data point (9 recall/phrase pairs), not a large-sample calibration.
const MIN_SEMANTIC_SIMILARITY = 0.45;

// ─── Layer system ─────────────────────────────────────────────────────────────

const LAYER_THRESHOLDS: Record<number, number> = { 5: 45, 4: 35, 3: 25, 2: 15, 1: 8 };

function inferLayer(physicalPath: string): number {
  const implPath = path.join(physicalPath, 'implementation.js');
  if (!fs.existsSync(implPath)) return 1;
  const lines = fs.readFileSync(implPath, 'utf-8').split('\n').length;
  if (lines <= 20)  return 1;
  if (lines <= 60)  return 2;
  if (lines <= 120) return 3;
  if (lines <= 250) return 4;
  return 5;
}

// Personal-project snippet folders extracted by imprint — never global recalls.
// Identified by: spaces in name, uppercase start, or known project names.
const SNIPPET_PROJECT_EXCLUSIONS = new Set([
  'Recall V2', 'Recall', 'borsaV2', 'safkan', 'ai hub', '15m trading bot', 'ai-build-guide',
]);

function isPersonalSnippetFolder(parentDir: string, name: string): boolean {
  if (!parentDir.endsWith(`${path.sep}snippets`) && !parentDir.endsWith('/snippets')) return false;
  return SNIPPET_PROJECT_EXCLUSIONS.has(name) || /[A-Z]/.test(name[0]) || name.includes(' ');
}

// Only trust a metadata field as a string array if it actually is one — see the
// "provides"/"requires" comment at the walkRecalls() call site for why this matters.
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(v => typeof v === 'string') ? value : undefined;
}

// A recall is a stub — treated as if it doesn't exist for selection purposes — if its
// implementation is an explicit TODO marker, if the file is genuinely empty/near-empty, if
// it has no module.exports at all (nothing is actually exported regardless of what metadata
// claims), or if metadata claims exports that appear NOWHERE in the file at all. Confirmed
// real (2026-07-06, STRIPE test run): several recalls in one assembly had 'use strict'; with
// no body but still listed real function names in outputs — would throw a ReferenceError at
// require() time had the assembly been used verbatim instead of caught by verification.
//
// IMPORTANT: check against the FULL file content, not a module.exports-stripped version. A
// huge, entirely legitimate category of recalls are thin re-export wrappers around a real npm
// package — e.g. `module.exports = { cancel: _pkg.cancel }` — where the claimed name's ONLY
// appearance in the file is inside the export statement itself. An earlier version of this
// check stripped module.exports before searching and flagged ~87% of the library as "stubs,"
// including fully working wrappers like api.absinthe-socket.v1. Search the whole file.
// A stray top-level ES-module `export` statement in an otherwise-CommonJS recall (require()
// calls, module.exports at the bottom) makes Node's module-syntax detection reinterpret the
// whole file as ESM — module.exports still executes without error, but require() from outside
// only sees the genuine `export`-marked binding; every OTHER name in module.exports silently
// vanishes. This is worse than a crash: the claimed names are present as TEXT (so the plain
// "claimed name appears in the file" check below doesn't catch it) but not actually reachable
// at runtime. Confirmed on 15 real recalls — auth.jwt.tokenhandling.v1 only exposed `execute`,
// silently dropping signJWT/verifyJWT/createTokenPair/etc despite module.exports listing them.
const STRAY_EXPORT_RE = /^export (async function|function|const|class)\b/m;

// require()ing another recall by relative path (e.g. require('../../../api/format/response/v1/
// implementation')) only works while the file sits in its original recalls/ location. buildAssembly
// copies/concatenates recall content into strata/assembly_*.js, a different directory entirely —
// the relative path then resolves to nothing and throws MODULE_NOT_FOUND at require time. Confirmed
// real: 113 recalls do this (both ../ parent-crossing and ./ same-dir forms), including recalls
// that got pulled into a real test session's assembly. No dependency-graph-aware inliner exists
// yet to make these work, so exclude rather than ship something that can never load correctly.
const RELATIVE_REQUIRE_RE = /require\(['"]\.\.?\//;

function isStubImplementation(implContent: string, outputs: unknown): boolean {
  if (implContent.includes('TODO: Implement')) return true;

  const withoutUseStrict = implContent.trim().replace(/^['"]use strict['"];?\s*/, '').trim();
  if (withoutUseStrict.length < 10) return true;
  if (!implContent.includes('module.exports')) return true;
  if (STRAY_EXPORT_RE.test(implContent)) return true;
  if (RELATIVE_REQUIRE_RE.test(implContent)) return true;

  const claimedOutputs = asStringArray(outputs);
  if (claimedOutputs && claimedOutputs.length > 0) {
    const claimedNames = claimedOutputs
      .map(out => (out.includes('(') ? out.split('(')[0].trim() : ''))
      .filter(Boolean);
    if (claimedNames.length > 0) {
      const noneFound = claimedNames.every(name => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return !new RegExp(`\\b${escaped}\\b`).test(implContent);
      });
      if (noneFound) return true;
    }
  }
  return false;
}

function walkRecalls(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isPersonalSnippetFolder(dir, entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const metaPath = path.join(fullPath, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const rawId: string = meta.id || entry.name;
        // Curated allowlist gate: when active, quarantine anything not verified. This is the
        // one filter that makes all the downstream stub/collision/guard logic mostly redundant —
        // the junkyard never enters the pool. In legacy mode (no allowlist) fall through to the
        // old scraped behavior so a fresh checkout isn't bricked.
        if (verifiedListLoaded && !verifiedIds.has(rawId)) continue;
        // Skip stubs — TODO markers, empty bodies, or claimed exports that don't exist —
        // so a hollow recall never gets selected and never lands in an assembly (see
        // isStubImplementation for why this matters more than it sounds).
        const implPath = path.join(fullPath, 'implementation.js');
        if (fs.existsSync(implPath)) {
          const implContent = fs.readFileSync(implPath, 'utf-8');
          if (isStubImplementation(implContent, meta.outputs)) continue;
        }
        let id = rawId;
        if (recallMap.has(id)) {
          // Derive stable id from path on collision
          id = path.relative(recallsDir, fullPath)
            .replace(/[\\/]+/g, '.')
            .replace(/[^a-zA-Z0-9.\-_]/g, '-');
        }
        if (!recallMap.has(id)) {
          const record: RecallEntry = {
            id,
            name: meta.name || rawId,
            description: meta.description || '',
            domain: meta.domain || meta.category || 'general',
            tags: meta.tags || [],
            complexity: meta.complexity,
            dependencies: meta.dependencies,
            useCases: meta.useCases,
            // Defensive, same reason as provides/requires below: this library has scraped
            // recalls using an entirely different metadata schema for inputs/outputs (e.g.
            // db.transaction.v1 has outputs: {"success": "boolean"}, a return-type schema
            // object, not the string[] "fn(args)" convention everything else uses). Every
            // call site assumed string[] with no runtime check — found via a live crash
            // (2026-07-06): "object is not iterable" inside buildAssembly's for-of loop.
            inputs: asStringArray(meta.inputs),
            outputs: asStringArray(meta.outputs),
            callExample: meta.callExample,
            fullContextRequired: meta.fullContextRequired ?? false,
            envSlots: meta.envSlots,
            wiringTemplate: meta.wiringTemplate,
            scaffold: meta.scaffold,
            compose: meta.compose,
            // Checks the recall declares for its own delivered behaviour. Mapped EXPLICITLY because
            // this constructor whitelists fields — a new metadata key is silently dropped otherwise,
            // which is exactly how these checks first went missing at runtime.
            verifierChecks: Array.isArray(meta.verifierChecks) ? meta.verifierChecks : undefined,
            // Defensive: this library has ~7,700+ scraped recalls with uncontrolled metadata
            // shapes. "provides"/"requires" are fields Strata invented (2026-07-04) for the
            // ports system, but a scraped recall's own source metadata could coincidentally
            // already have a field with that name in some other shape (an object, a string,
            // whatever the original package.json meant by it). Only trust it if it's actually
            // a string array — anything else silently ignored rather than crashing every
            // strata_use call that happens to score this recall as a candidate.
            provides: asStringArray(meta.provides),
            requires: asStringArray(meta.requires),
            providerName: typeof meta.providerName === 'string' ? meta.providerName : undefined,
            physicalPath: fullPath,
            layer: typeof meta.layer === 'number' ? meta.layer : inferLayer(fullPath),
          };
          recallMap.set(id, record);
          allRecalls.push(record);
        }
      } catch {
        // skip corrupt metadata
      }
    } else {
      walkRecalls(fullPath);
    }
  }
}

/** Turn one metadata.json into a RecallEntry. Shared so the fast path and the walk cannot drift. */
function buildRecallRecord(fullPath: string, meta: Record<string, unknown>, rawId: string): RecallEntry {
  return {
    id: rawId,
    name: (meta.name as string) || rawId,
    description: (meta.description as string) || '',
    domain: (meta.domain as string) || (meta.category as string) || 'general',
    tags: (meta.tags as string[]) || [],
    complexity: meta.complexity as string | undefined,
    dependencies: meta.dependencies as string[] | undefined,
    useCases: meta.useCases as string[] | undefined,
    inputs: asStringArray(meta.inputs),
    outputs: asStringArray(meta.outputs),
    callExample: meta.callExample as string | undefined,
    fullContextRequired: (meta.fullContextRequired as boolean) ?? false,
    envSlots: meta.envSlots as string[] | undefined,
    wiringTemplate: meta.wiringTemplate as string | undefined,
    scaffold: meta.scaffold as RecallEntry['scaffold'],
    compose: meta.compose as RecallEntry['compose'],
    // Checks the recall declares for its own delivered behaviour. Mapped EXPLICITLY because this
    // constructor whitelists fields — a new metadata key is silently dropped otherwise, which is
    // exactly how these checks went missing on their first run: written in metadata, typed on the
    // interface, parsed from JSON, and then discarded here without a word.
    verifierChecks: Array.isArray(meta.verifierChecks)
      ? (meta.verifierChecks as RecallEntry['verifierChecks'])
      : undefined,
    provides: asStringArray(meta.provides),
    requires: asStringArray(meta.requires),
    providerName: typeof meta.providerName === 'string' ? meta.providerName : undefined,
    physicalPath: fullPath,
    layer: typeof meta.layer === 'number' ? meta.layer : inferLayer(fullPath),
  };
}

/**
 * Register a recall the HUB described, which therefore has no directory on this machine.
 *
 * `physicalPath: ''` is the marker for "remote". Everything that composes locally joins onto that
 * path to read implementation.js / scaffold-*.js / selftest.js, so an empty value must be treated as
 * "no local source available" rather than resolved — see the guard at the local-composition entry.
 *
 * `layer` is taken ONLY from metadata and never inferred. inferLayer() counts the lines of a local
 * implementation.js; with no local file it returns 1 for every recall, unconditionally and silently.
 * Selection ranks by layer, so that would flatten the entire library into one band and quietly
 * reorder every result — the same shape as the "selection ranked by layer, not score" bug in
 * STRATA-LAUNCH.md, which made a score-159 recall lose to a score-54 one. A missing layer is a hub
 * data defect and says so out loud instead of guessing.
 */
function addRemoteRecall(meta: HubIndexRecall): void {
  const id = meta.id;
  if (!id || recallMap.has(id)) return;

  if (typeof meta.layer !== 'number') {
    console.error(`[strata] hub index entry "${id}" has no layer — selection will rank it poorly. `
      + 'Regenerate the hub index (server/hub.js loadLibrary).');
  }

  const record = buildRecallRecord('', meta as Record<string, unknown>, id);
  record.layer = typeof meta.layer === 'number' ? meta.layer : 3;   // mid-band, not silently top
  recallMap.set(id, record);
  allRecalls.push(record);
}

/**
 * Load ONLY the recalls we actually serve, straight from their recorded paths.
 *
 * 17 file reads instead of 15,750 directory reads. The walk it replaces was synchronous, took 3.4s on
 * an idle disk, blocked the event loop, and made the whole server look offline — which cost two
 * benchmark runs that then built everything from scratch and still got counted as Strata results.
 *
 * Returns false when there is no path index, so the caller can fall back to the (correct, slow) walk.
 */
function loadVerifiedRecallsDirect(): boolean {
  const allowPath = path.join(__dirname, '..', '..', 'cache', 'verified-recalls.json');

  let paths: Record<string, string>;
  try {
    const allow = JSON.parse(fs.readFileSync(allowPath, 'utf-8')) as { paths?: Record<string, string> };
    if (!allow.paths || Object.keys(allow.paths).length === 0) return false;
    paths = allow.paths;
  } catch {
    return false;
  }

  const root = path.join(__dirname, '..', '..');
  let loaded = 0;

  for (const [id, relPath] of Object.entries(paths)) {
    const fullPath = path.join(root, relPath);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(fullPath, 'metadata.json'), 'utf-8'));

      // Still refuse a hollow recall — a stub that reaches an assembly is worse than a miss.
      const implPath = path.join(fullPath, 'implementation.js');
      if (fs.existsSync(implPath)) {
        if (isStubImplementation(fs.readFileSync(implPath, 'utf-8'), meta.outputs)) continue;
      }

      if (recallMap.has(id)) continue;
      const record = buildRecallRecord(fullPath, meta, id);
      recallMap.set(id, record);
      allRecalls.push(record);
      loaded++;
    } catch {
      console.error(`[strata] verified recall "${id}" is indexed at ${relPath} but could not be read`);
    }
  }

  return loaded > 0;
}

// libraryReady resolves once the recalls + fitness map are loaded.
// Tool handlers await this so the MCP handshake is never blocked by disk I/O.
let libraryReady: Promise<void> = Promise.resolve();

function loadLibrary(): Promise<void> {
  return new Promise<void>((resolve) => {
    // NOT skipped for isHub. Selection (mapCapabilitiesToRecalls, several call-sites down) reads
    // recallMap/searchIndexMap regardless of mode — hub mode changes where the WINNING recall's code
    // comes from, not how a task decides which recalls are relevant, and every hub-composition failure
    // falls back to this same local path. Skipping this load in hub mode left recallMap permanently
    // empty, so selection always returned zero matches and every hub-mode call hit the honest-miss
    // message before composeOnHub was ever reached — the hub was unreachable in practice, always,
    // regardless of whether the server itself was up. Measured directly: 2026-07-31.

    // Defer to the next tick so the MCP initialize handshake goes out first.
    //
    // But deferring was never enough, and the comment that used to sit here ("blocks the event loop
    // for ~12s") should have been treated as a bug report rather than a caveat. A BLOCKED EVENT LOOP
    // CANNOT ANSWER ANYTHING. tools/list went unanswered, Claude Code told the model "strata-lib is
    // still connecting", the model searched twice, gave up, and wrote the entire feature from scratch.
    //
    // Measured: two of three `platform` benchmark runs were lost exactly this way — 84 turns / $2.32
    // and 63 turns / $1.58 — and both looked like ordinary Strata results. A tool that silently fails
    // to load is worse than one that throws: the session quietly degrades to baseline-plus-overhead
    // and nobody ever finds out why.
    //
    // The walk read 15,750 directories to locate the SEVENTEEN recalls we actually serve — a 452:1
    // ratio. cache/verified-recalls.json now carries their paths, so we read exactly what we deliver.
    setImmediate(async () => {
      loadVerifiedAllowlist();

      const loadedDirect = loadVerifiedRecallsDirect();
      if (!loadedDirect && fs.existsSync(recallsDir)) {
        // No path index, but a recalls/ tree is present — a development checkout whose allowlist was
        // edited by hand. Fall back to the full walk: correct, just slow, and say so loudly enough
        // that someone regenerates the index.
        //
        // Guarded on the directory EXISTING, which it does not in an installed package. Unguarded,
        // this walked a path that was never published and reported "Loaded 0 recalls" as if that were
        // an ordinary result.
        console.error('[strata] No path index in cache/verified-recalls.json — falling back to a full '
          + 'directory walk. This BLOCKS the event loop for seconds and can make Strata look offline. '
          + 'Run: node scripts/index-verified.js');
        walkRecalls(recallsDir);
      }

      // An INSTALLED package has no recalls/ and no allowlist — both are deliberately unpublished,
      // because the library is served from the hub. Without this branch the map stays empty, selection
      // matches nothing, and every task in every install returns the honest-miss message. That is not
      // a degraded mode, it is a dead product wearing the costume of a working one.
      if (recallMap.size === 0 && isHub && config.hub) {
        const { index, refreshing } = loadHubIndex(config.hub.url);
        // Only WAIT on the network when there is no cache to fall back on — i.e. genuinely the first
        // run after install. Every later start reads the cache and refreshes behind the handshake.
        const usable = index ?? await refreshing;
        if (usable) {
          for (const meta of usable.recalls) addRemoteRecall(meta);
          // The recall set is half of what a selection depends on, and it now arrives over the network
          // instead of from the allowlist file the cache key hashes. Without this, adding a recall on
          // the hub would never invalidate a client's cached selections — the exact bug that has now
          // bitten this project three times on disk. generatedAt changes on every hub reload; the id
          // list is what actually matters, so hash that.
          setRecallSetFingerprint(
            crypto.createHash('sha1')
              .update(usable.recalls.map(r => `${r.id}@${r.hash ?? r.version ?? ''}`).sort().join('\n'))
              .digest('hex').slice(0, 12),
          );
          console.error(`[strata] library synced from hub: ${recallMap.size} recalls`
            + `${index ? ' (cached)' : ' (first run — downloaded)'}`);
        } else {
          console.error('[strata] hub unreachable and no cached index — Strata will decline every '
            + `task until ${config.hub.url} is reachable once.`);
        }
      }

      const cacheDir = resolveCacheDir();
      fitnessMap = buildFitnessMap(cacheDir);
      loadSelections(cacheDir);

      for (const [id, entry] of searchIndexMap) {
        const record = recallMap.get(id);
        if (record && !record.description && entry.description) {
          record.description = entry.description;
        }
      }

      console.error(`[strata] Loaded ${recallMap.size} recalls`);
      resolve();
    });
  });
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

// Structural suffix words that appear in recall IDs/names but carry no domain signal.
// Filtering prevents "role-permission-mapping" from matching "rest-to-graphql-mapping"
// via the high-weight ID match on "mapping".
const SCORE_STOPWORDS = new Set([
  'mapping', 'service', 'system', 'module', 'manager', 'handler',
  'provider', 'helper', 'checker', 'builder', 'processor', 'generator',
  'validator', 'hook', 'wrapper', 'adapter', 'plugin', 'layer',
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s,.\-_/]+/).filter(t => t.length > 1 && !SCORE_STOPWORDS.has(t));
}

function scoreRecall(r: RecallEntry, tokens: string[], primaryTokens: Set<string>): number {
  const id   = r.id.toLowerCase();
  const name = r.name.toLowerCase();
  const desc = r.description.toLowerCase();
  const tags = r.tags.map(t => t.toLowerCase()).join(' ');
  let score = tokens.reduce((s, t) => {
    const boost = primaryTokens.size > 0 && primaryTokens.has(t) ? 2 : 1;
    return s + boost * (
      (id.includes(t)   ? 12 : 0) +
      (name.includes(t) ?  8 : 0) +
      (desc.includes(t) ?  5 : 0) +
      (tags.includes(t) ?  4 : 0)
    );
  }, 0);
  // Soft-deprioritize low-fitness recalls (benchmark-derived signal).
  // Halve score for fitness < 40; new recalls with no signal data are unaffected.
  const fit = fitnessMap.get(r.id);
  if (fit !== undefined && fit < 40) score = Math.round(score * 0.5);
  return score;
}

// At most 2 candidates per layer so a single spurious fat-recall hit
// can't crowd out relevant thin recalls from lower layers.
const PER_LAYER_CAP = 2;

// A recall on a higher layer is a broader, more consolidated pattern, so it is worth a nudge — but
// only a NUDGE. This used to be absolute, and that was a bug (see below). One layer of separation is
// worth less than a handful of matched tokens.
const LAYER_BONUS = 4;

// Search: score every recall that clears its layer's threshold, then rank by SCORE.
//
// This used to CASCADE — walk layers 5→1 and stop as soon as one layer filled the quota. Layer
// therefore beat score absolutely, and that silently broke selection:
//
//   capability: "schema validation that coerces query-string 30 into the number 30"
//     api.pagination.v1      L3  score  54   <- won, purely for being on a higher layer
//     validation.request.v1  L2  score 159   <- never even considered
//
// The per-capability call uses limit=1, so pagination took the only slot; the evidence gate then
// (correctly) threw it out for having nothing to do with validation — and the capability ended up
// selecting NOTHING. A recall scoring 3x higher lost to one that merely sat a layer above it, and the
// failure was invisible: no error, just a recall that could never be chosen.
//
// Layers still matter, so they get LAYER_BONUS instead of a veto. Per-layer thresholds are unchanged:
// a layer-5 fat recall must still clear 45 to be considered at all, where a layer-1 one needs only 8.
//
// Two-stage filter: lexical threshold first (cheap, runs over all recalls), then a semantic veto
// (embeddings, only computed for the small set that already cleared the lexical bar) drops anything
// that only matched on incidental token overlap — e.g. "job" matching an unrelated domain's recall.
// See embeddings.ts for the full rationale.
async function searchRecalls(
  query: string,
  limit = 5,
  primaryQuery?: string,
  minLayer = 1,
  maxLayer = 5,
): Promise<ScoredRecall[]> {
  const tokens = tokenize(query);
  const primaryTokens: Set<string> = primaryQuery ? new Set(tokenize(primaryQuery)) : new Set();

  // Embed the query once, reused across every layer below. Skipped (pure lexical
  // fallback) if no recall embeddings are loaded — e.g. before `npm run recalls:embed`.
  let queryEmbedding: Float32Array | null = null;
  if (embeddingMap.size > 0) {
    try {
      queryEmbedding = await embedText(primaryQuery ? `${query} ${primaryQuery}` : query);
    } catch (e) {
      console.error('[strata] Query embedding failed, falling back to lexical-only scoring:', e);
    }
  }

  const pool: ScoredRecall[] = [];

  for (let layer = maxLayer; layer >= minLayer; layer--) {
    const threshold = LAYER_THRESHOLDS[layer] ?? 25;
    const layerResults = allRecalls
      .filter(r => r.layer === layer)
      .map(r => ({ ...r, score: scoreRecall(r, tokens, primaryTokens) }))
      .filter(x => x.score >= threshold)
      .filter(x => {
        if (!queryEmbedding) return true; // no embeddings loaded — lexical-only mode
        const recallEmbedding = embeddingMap.get(x.id);
        if (!recallEmbedding) return true; // recall not yet embedded — don't penalize it
        return cosineSimilarity(queryEmbedding, recallEmbedding) >= MIN_SEMANTIC_SIMILARITY;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, PER_LAYER_CAP);   // still at most 2 per layer, so one fat layer can't flood the pool

    pool.push(...layerResults);
  }

  // Rank across ALL layers by score. The layer is a tie-break-sized nudge, not a veto.
  return pool
    .sort((a, b) => (b.score + b.layer * LAYER_BONUS) - (a.score + a.layer * LAYER_BONUS))
    .slice(0, limit);
}


// ─── Capability → Recall mapper ───────────────────────────────────────────────

const FAT_CONSOLIDATION_THRESHOLD = 60;
// Sanity ceiling only — NOT a target count. Relevance is decided per-capability by
// scoreRecall()'s layer threshold inside searchRecalls(); a recall that clears that bar
// is needed by the task, full stop. The natural ceiling is already ~7-8 (decomposeTask
// caps at 7 capability phrases, top-1 recall per phrase, plus domain-priority forces) —
// this constant only exists to catch a pathological/malformed decompose output, not to
// second-guess a normal task. Do NOT lower this to "control cost": every recall excluded
// here is NOT free — Claude writes it from scratch as output tokens instead, which costs
// more than the recall would have. Capping by count previously caused receipt.pdfkit.v1
// to be silently dropped and hand-rewritten five times across real sessions.
const MAX_ASSEMBLY = 20;

// ─── Task decomposition — deterministic, no API call ──────────────────────────
//
// This used to fire a live Haiku API call on the critical path of EVERY delivery. That was wrong on
// four counts:
//
//   1. REDUNDANT. The calling model has already read the full task, in full context, and CLAUDE.md
//      explicitly instructs it to enumerate the components itself and pass them in. Strata then threw
//      that away and paid a weaker model to re-derive it from a 500-char truncation.
//   2. A SINGLE POINT OF FAILURE. Measured: a transient decompose failure in `platform-strata-r1`
//      meant Strata delivered NOTHING; the session hand-wrote all 14 files and cost more than
//      baseline. One flaky HTTP call could void the entire product.
//   3. IT COST API MONEY, on a system whose users are paying by subscription.
//   4. IT CONTRADICTED THE THESIS. Strata's whole argument is that deterministic work belongs
//      OUTSIDE the model loop. Putting a non-deterministic LLM call at the front of the pipeline is
//      the exact thing we tell everyone else not to do.
//
// Decomposition is now free, instant, offline, and cannot fail.

const CAP_STOPWORDS = new Set([
  'build', 'a', 'an', 'the', 'and', 'with', 'using', 'in', 'for', 'that', 'plain', 'javascript',
  'typescript', 'no', 'node', 'nodejs', 'js', 'express', 'app', 'api', 'server', 'service',
]);

/**
 * Turn the task string into capability phrases, deterministically.
 *
 * The model is asked to pass `capabilities` directly (it is the best-placed thing in the system to
 * produce them). When it doesn't, we split the task on its natural clause boundaries — which works
 * because a well-formed Strata task IS a component list: "pino structured logging with correlation
 * ids, token-bucket rate limiting, cursor pagination, CSV import with row validation".
 */
function decomposeTask(taskPrompt: string, provided?: string[]): string[] {
  if (provided && provided.length > 0) {
    const caps = provided.map(c => c.trim()).filter(Boolean).slice(0, 7);
    if (caps.length > 0) return caps;
  }

  // Split on clause boundaries: commas, semicolons, colons, newlines, and "(1) (2)" enumerations.
  const clauses = taskPrompt
    .split(/[,;:\n]+|\(\s*\d+\s*\)/)
    .map(s => s.replace(/^\s*[-*\d.)\s]+/, '').trim())
    .filter(Boolean);

  const caps: string[] = [];
  for (const clause of clauses) {
    // A clause has to carry real signal. Strip the filler and see if anything domain-specific is
    // left — "in Node.js (plain JavaScript, no TypeScript)" must not become a capability.
    const meaningful = clause
      .toLowerCase()
      .split(/[^a-z0-9.+-]+/)
      .filter(w => w.length > 2 && !CAP_STOPWORDS.has(w));
    if (meaningful.length < 2) continue;

    caps.push(clause.slice(0, 120));
    if (caps.length >= 7) break;
  }

  // A task with no punctuation at all ("build a jwt auth system") yields no clauses — fall back to
  // the whole string as a single capability rather than to noisy stopword-laden tokens.
  return caps.length > 0 ? caps : [taskPrompt.slice(0, 120)];
}

async function mapCapabilitiesToRecalls(capabilities: string[], taskPrompt: string): Promise<RecallEntry[]> {
  const seenIds = new Set<string>();
  const candidates: RecallEntry[] = [];
  // Ports & adapters (STRATA-PORTS.md): at most one adapter per abstract capability
  // contract, ever, in one assembly. This is the fix for the redundancy problem —
  // email.nodemailer.v1 and communication.email.full.v1 both legitimately score well
  // against "email confirmation" (0.542 similarity, a real overlap, not a false
  // positive), but only one should ever be selected. Whichever claims a port first wins;
  // anything else declaring the same provides[] entry is excluded regardless of score.
  const claimedPorts = new Set<string>();
  function claimPorts(r: RecallEntry): void {
    for (const p of r.provides ?? []) claimedPorts.add(p);
  }
  function portAlreadyClaimed(r: RecallEntry): boolean {
    return (r.provides ?? []).some(p => claimedPorts.has(p));
  }

  const capabilitiesText = capabilities.join(' ').toLowerCase();
  const taskLower = taskPrompt.toLowerCase().slice(0, 300);

  // Haystack for the generic topical-evidence gate. Punctuation is flattened to spaces so a tag like
  // "rate-limit" matches "rate limiting" in prose, and the FULL task is used (not the 300-char slice
  // above) — evidence for a recall can legitimately sit in the last clause of a long task string.
  const evidenceHaystack = ` ${taskPrompt} ${capabilities.join(' ')} `
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

  // Specificity guards — prevent high-scoring but wrong-domain recalls from firing.
  // Each guarded recall ID is only allowed when the task explicitly involves that domain.

  // Tightened after a real miss: decomposeTask hallucinated the capability phrase
  // "jwt-reset-token-generation" for a plain password-reset task (no JWT involved at all).
  // The old bare /\bjwt\b/ check let this guard through, and generic scoring then picked
  // auth.jwt.tokenhandling.v1 over the correct auth-password-reset-flow via this exact path —
  // a separate selection path from DOMAIN_PRIORITY forcing, which needed the same fix.
  const JWT_RECALL_ID = 'auth.jwt.tokenhandling.v1';
  const jwtAllowed = /\bjwt\b.*(?:signup|login|access.token|protected.route|middleware|bearer)|(?:signup|login|access.token|protected.route|middleware|bearer).*\bjwt\b|jsonwebtoken|token.sign|sign.token/.test(capabilitiesText)
    || /\bjwt\b.*(?:signup|login|access.token|protected.route|middleware|bearer)|(?:signup|login|access.token|protected.route|middleware|bearer).*\bjwt\b|jsonwebtoken/.test(taskLower);

  // search.in-memory.v1 matches any "in-memory" capability but only useful for search/filter/sort
  const SEARCH_INMEMORY_RECALL_ID = 'search.in-memory.v1';
  const searchInMemoryAllowed = /\bsearch\b|keyword|filter.sort|sort.filter/.test(capabilitiesText)
    || /\bsearch\b|keyword search/.test(taskLower);

  // cart.session.express.v1 is L5 and fires on any "session" capability
  const CART_SESSION_RECALL_ID = 'cart.session.express.v1';
  const cartAllowed = /\bcart\b|\bshopping/.test(capabilitiesText)
    || /\bcart\b|\bshopping cart/.test(taskLower);

  // api.format.response.v1 matches many tasks via generic "response" tokens
  const API_FORMAT_RECALL_ID = 'api.format.response.v1';
  const apiFormatAllowed = /response.format|format.response|api.response|standard.response|error.format/.test(capabilitiesText);

  // The low-stakes recalls over-match badly on shared infrastructure vocabulary. Measured: a pure
  // pino-logging task pulled in data.csv-import.v1 and shipped csv-parse as a dependency, purely on
  // tokens like "validation"/"error"/"parse". The session then spent turns noticing the module was
  // irrelevant, deleting it, and stripping csv-parse from package.json — Strata's own noise cost
  // more than Strata saved. Irrelevant delivery is not free; it is actively expensive.
  //
  // ARCHITECTURAL DEBT: this is the eleventh hand-written per-recall guard. It does not scale to a
  // library of thousands. The real fix is a generic topical-evidence gate — a recall is only
  // eligible when a distinctive token from its OWN metadata appears in the task text — which would
  // replace every guard in this block. Deferred deliberately: not while a benchmark is in flight.
  const CSV_IMPORT_RECALL_ID = 'data.csv-import.v1';
  const csvImportAllowed = /\bcsv\b|spreadsheet|\bexcel\b|bulk.import|import.*(?:file|rows|records)|row.*validation/.test(capabilitiesText)
    || /\bcsv\b|spreadsheet|\bexcel\b/.test(taskLower);

  const HTTP_RESILIENT_RECALL_ID = 'http.resilient-client.v1';
  // NOTE the tokens deliberately absent: "retry-after", "429", "rate-limit", and a bare "retry".
  // Those describe what a SERVER emits, and they collide head-on with cache.ratelimit.v1. A task
  // saying "429 with Retry-After" is describing its RATE LIMITER — and that phrase alone used to drag
  // this entire recall into the assembly, where a benchmark session correctly called it "not needed
  // for this task (no outbound calls) ... harmless dead weight". It was ~2k of a 9.6k-token assembly
  // the model reads into context and re-pays for on EVERY turn. This recall is about CALLING a flaky
  // upstream, so it must be identified only by tokens it alone would own.
  // `idempoten` REMOVED from this trigger, and it is worth saying why at length, because the same
  // mistake is available to every recall in the library.
  //
  // This recall RESPECTS idempotency — it retries only idempotent HTTP methods, never blindly a POST.
  // That is a caveat about its own behaviour toward an upstream. It does not PROVIDE idempotency to
  // the caller. But the trigger was written from the recall's description, so `idempoten` let it fire
  // on any task mentioning the word — and its metadata makes the identical claim (tags: `idempotent`,
  // `idempotency`), so hasTopicalEvidence() waved it through on exactly the same token.
  //
  // Measured 2026-07-31: the model asked for ["idempotent order creation", "request body validation",
  // "request logging", "duplicate detection via idempotency key"] — four correct capabilities, none
  // about HTTP clients. Selection added http.resilient-client.v1 anyway and shipped an entire
  // /proxy/:id route with a circuit breaker into a project about orders. The model asked for exactly
  // the right things; the engine invented the rest.
  //
  // The direction of the word is the whole distinction: "a client retries OUR endpoint" is
  // idempotency; "WE retry a flaky upstream" is this recall. Same token, opposite subject. The
  // retr(y|ies)-near-(request|call|upstream|api|vendor) clause below already covers the legitimate
  // phrasing ("retry idempotent requests to a vendor API"), so nothing real is lost.
  const httpResilientAllowed = /circuit.breaker|backoff|jitter|flaky|upstream|third.party|resilient|retr(?:y|ies).{0,20}(?:request|call|upstream|api|vendor)/.test(capabilitiesText)
    || /circuit.breaker|backoff|flaky|upstream|third.party|resilient.*client/.test(taskLower);

  const PAGINATION_RECALL_ID = 'api.pagination.v1';
  const paginationAllowed = /paginat|\bcursor\b|keyset|\boffset\b|infinite.scroll|has.?more|page.*size|list.*endpoint/.test(capabilitiesText)
    || /paginat|\bcursor\b|infinite.scroll/.test(taskLower);

  const CACHE_RATELIMIT_RECALL_ID = 'cache.ratelimit.v1';
  const cacheRatelimitAllowed = /rate.limit|ratelimit|throttl|token.bucket|\bcach|\blru\b|\bttl\b|memoiz/.test(capabilitiesText)
    || /rate.limit|throttl|\bcach/.test(taskLower);

  const LOGGING_RECALL_ID = 'observability.logging.v1';
  const loggingAllowed = /\blog|\bpino\b|\bwinston\b|correlation.id|request.id|redact|observability|structured.log/.test(capabilitiesText)
    || /\blogging\b|\blogger\b|\bpino\b/.test(taskLower);

  // queue-worker-pool fires on email tasks via "async sending"/"retry" — email recall already has retry.
  // It's also a fundamentally different technology (worker_threads CPU pool) from a Redis-backed
  // job queue (bullmq) — but shares enough vocabulary ("queue"/"worker"/"job"/"pool"/"background")
  // that a legitimate BullMQ task satisfies this lexical guard too, AND queue-worker-pool has no
  // `provides` tag, so the one-adapter-per-port rule can't catch it as a QueueProvider competitor
  // either. Confirmed root cause of a real regression: it slipped in alongside bullmq and both
  // declared a `Worker` binding (bullmq's vs worker_threads') — a straight SyntaxError that broke
  // the whole assembly file. Excluded outright once a QueueProvider is already claimed, below.
  const QUEUE_WORKER_RECALL_ID = 'queue-worker-pool';
  const queueAllowed = /\bqueue\b.*(?:worker|job|pool|concurrent|background)|(?:worker|job|pool|background).*\bqueue\b/.test(capabilitiesText)
    || /\bqueue\b.*(?:worker|job|pool)|job.queue/.test(taskLower);

  // auth-email-verification-flow: only for auth flows that SEND verification emails to users.
  // "verification" alone is too broad — "webhook signature verification" matches it. Require email context.
  const EMAIL_VERIF_RECALL_ID = 'auth-email-verification-flow';
  const emailVerifAllowed = /email.verif|verif.*email|activat.*email|email.*activat/.test(capabilitiesText)
    || /email.verif|verif.*email|email.*activat|account.verif|signup.verif/.test(taskLower);

  // auth-multitenant-context: "multi" substring matches "multi-field-*" capabilities
  const MULTITENANT_RECALL_ID = 'auth-multitenant-context';
  const multitenantAllowed = /\btenant|\bmultitenant/.test(capabilitiesText)
    || /\btenant|\bmulti.tenant/.test(taskLower);

  // auth.session.sessionmanagement.v1 is L5, fires on any "session"/"user-tracking" capability.
  // Only useful for HTTP server-side sessions — not WebSocket in-memory user maps.
  const AUTH_SESSION_RECALL_ID = 'auth.session.sessionmanagement.v1';
  const authSessionAllowed = /express.session|session.store|cookie.session|http.session/.test(capabilitiesText)
    || /express-session|session middleware|cookie-session/.test(taskLower);

  // api-webhook-retry-handler is for OUTBOUND webhook retries (sending to 3rd parties).
  // Block it when task is about RECEIVING webhooks (stripe, github, twilio, etc.)
  const WEBHOOK_RETRY_RECALL_ID = 'api-webhook-retry-handler';
  const webhookRetryAllowed = /outbound.webhook|retry.webhook|webhook.retry|forward.webhook|deliver.webhook/.test(capabilitiesText)
    && !/\bstripe\b|\btwilio\b|\bgithub\b|\bpayment\b/.test(taskLower);

  // api-webhook-signature-verification is a generic HMAC verifier. Providers with their own
  // webhook recall (stripe.webhook-patterns.v1's constructWebhookEvent, etc.) already handle
  // signature verification — this recall is redundant there and just adds noise/cost.
  // Fitness-flagged low (30) in the benchmark; confirmed unused-but-selected in AB-scaffold-8.
  const API_WEBHOOK_SIG_RECALL_ID = 'api-webhook-signature-verification';
  const apiWebhookSigAllowed = !/\bstripe\b|\btwilio\b|\bgithub\b|\bpayment\b/.test(taskLower);

  // queue-job-deduplication dedupes BullMQ JOB PAYLOADS by content hash — a different concern
  // from webhook EVENT idempotency, which stripe.webhook-patterns.v1's router already handles
  // via its own processedEvents Set. "idempotent webhook event processing"-shaped capability
  // phrasing kept matching it anyway: flagged via strata_signal in five straight real sessions
  // (STRIPE, stripe 1-4), never once actually wired into any of their server.js/worker.js —
  // pure verification-cost, zero delivered value in this context every single time.
  const JOB_DEDUP_RECALL_ID = 'queue-job-deduplication';
  const jobDedupAllowed = !/\bstripe\b|\btwilio\b|\bgithub\b|\bpayment\b|\bwebhook\b/.test(taskLower);

  // auth.full.express.v1 is a "complete" auth system (router + hashing + JWT, all bundled) that
  // directly overlaps auth.jwt.tokenhandling.v1 + auth.password.passwordhashing.v1's hand-paired
  // combo. Confirmed real: it kept getting pulled in alongside the forced pair on the JWT auth
  // shape, its own exports (hashPassword/comparePassword/createAuthRouter) never actually used by
  // the scaffold — pure verification-cost dead weight, same pattern as queue-worker-pool. Excluded
  // whenever auth.jwt.tokenhandling.v1 itself gets force-included (checked via forcedIds below,
  // computed after DOMAIN_PRIORITY runs) rather than re-matching text — ties the two conditions
  // to the same ground truth instead of two independent, driftable regexes.
  const AUTH_FULL_EXPRESS_RECALL_ID = 'auth.full.express.v1';

  // Domain-keyword → priority recall: when a specific package is mentioned by name,
  // force the matching recall into the assembly regardless of scoring position.
  const DOMAIN_PRIORITY: Array<{ pattern: RegExp; recallId: string }> = [
    { pattern: /\bstripe\b|webhook.*signature|signature.*webhook|\bwhsec\b/, recallId: 'payment.stripe-webhook.v1' },
    { pattern: /\bnodemailer\b/, recallId: 'email.nodemailer.v1' },
    { pattern: /\bbullmq\b|background.job.queue|job.queue.for|receipt.queue|pdf.receipt.generat|async.job|enqueue.job/, recallId: 'queue.bullmq.v1' },
    { pattern: /\bprisma\b/, recallId: 'database.prisma.client.v1' },
    { pattern: /\bsocket\.io\b|\bsocketio\b/, recallId: 'realtime.socketio.v1' },
    // receipt.pdfkit.v1: promoted from the loop after 4 independent sessions hand-wrote the
    // same PDF-receipt module. Force it in on any receipt/PDF-generation phrasing so it can't
    // lose a generic scoring slot to an unrelated but higher-scoring recall.
    { pattern: /receipt.*generat|generat.*receipt|pdf.*receipt|receipt.*pdf/, recallId: 'receipt.pdfkit.v1' },
    // JWT auth shape. Confirmed necessary the hard way: without forcing, generic scoring picked
    // a DIFFERENT bcrypt-flavored recall over the hand-paired auth.password.passwordhashing.v1,
    // and since their function names didn't collide, deconfliction had no reason to drop either
    // — result was a real assembly pairing a bcrypt hash with a PBKDF2 verify function, silently
    // breaking every login (found via strata_signal on a real test session, 2026-07-07).
    // Requires "jwt" to co-occur with actual token-issuance context, not a bare substring match —
    // decomposeTask hallucinated the capability phrase "jwt-reset-token-generation" for a plain
    // password-reset task (nothing to do with JWT), which under the old bare /\bjwt\b/ pattern
    // force-included this recall and let it win the "primary" scaffold slot over the correct
    // auth-password-reset-flow (both tagged primary; buildScaffold takes the first match).
    { pattern: /\bjwt\b.*(?:signup|login|access.token|protected.route|middleware|bearer)|(?:signup|login|access.token|protected.route|middleware|bearer).*\bjwt\b|jsonwebtoken/, recallId: 'auth.jwt.tokenhandling.v1' },
    // passwordhashing.v1 is forced across every shape that touches password hashing (JWT signup,
    // password reset's new-password hash) — not just the JWT pattern above, or the reset flow
    // would hit the same wrong-recall problem for its own hashPassword call.
    { pattern: /\bjwt\b|password.*reset|reset.*password|forgot.password|password.*hash|hash.*password|\bbcrypt\b|\bpbkdf2\b/, recallId: 'auth.password.passwordhashing.v1' },
    { pattern: /password.*reset|reset.*password|forgot.password/, recallId: 'auth-password-reset-flow' },
    { pattern: /\bwebsocket\b|chat.*room|room.*chat|real.?time.*chat/, recallId: 'realtime.ws.chat.v1' },
    { pattern: /\brbac\b|role.based.access|role.*permission|permission.*role|admin.*editor.*viewer/, recallId: 'auth.rbac.express.v1' },
    // TAIL APIs — packages where the model holds a confidently WRONG prior from a popular sibling:
    //   Valibot: parse/safeParse are STANDALONE (v.parse(schema, data)) — Zod habits write schema.parse(data)
    //   Hono:    handlers RETURN c.json(body, status) and serve({fetch: app.fetch, port}) — Express habits write res.json()/app.listen()
    // This is the domain where Strata should actually earn its keep: the model can't write it from
    // memory, so it has no strong prior to override the recall with.
    { pattern: /\bvalibot\b/, recallId: 'validation.valibot.v1' },
    { pattern: /\bhono\b/, recallId: 'web.hono.v1' },
    // Low-stakes domains. Every recall above this line is auth/payments/crypto — the one class of
    // code a careful model SHOULD refuse to take on trust. These three are the control group.
    { pattern: /\bpino\b|structured.log|json.log|request.log|log.*correlat|correlat.*log|request.id|redact|\blogging\b|\blogger\b/, recallId: 'observability.logging.v1' },
    { pattern: /\bcsv\b|bulk.import|spreadsheet|import.*rows|row.*validation|csv.parse/, recallId: 'data.csv-import.v1' },
    // "retry-after" REMOVED. DOMAIN_PRIORITY forces a recall in regardless of score AND bypasses the
    // topical-evidence gate, so a single stray token here is unappealable — which is exactly how the
    // rate limiter's "429 with Retry-After" kept force-selecting an HTTP client into a task with no
    // outbound calls at all.
    { pattern: /circuit.breaker|exponential.backoff|retry.*backoff|backoff.*retry|retry.*upstream|resilient.*client|retry.*failed.request|flaky.*(?:api|upstream|service)/, recallId: 'http.resilient-client.v1' },
    { pattern: /\bpaginat|\bcursor\b|keyset|infinite.scroll|list.endpoint|sort.*filter.*page|page.*size|has.?more|next.?cursor/, recallId: 'api.pagination.v1' },
    { pattern: /rate.limit|ratelimit|throttl|token.bucket|\blru\b|response.cach|cache.middleware|\bcaching\b/, recallId: 'cache.ratelimit.v1' },
  ];

  /**
   * A forcing rule that names a recall the library does not have is a SILENT no-op, and it is the
   * most expensive kind of dead code in this system.
   *
   * Measured, 2026-08-02: five of these pointed at recalls that no longer existed — `payment.stripe.v1`,
   * `stripe.webhook-patterns.v1`, `email.nodemailer.v1`, `queue.bullmq.v1`, `receipt.pdfkit.v1`. The
   * library had been migrated to the generic V4 taxonomy and this table was never re-derived. So a task
   * saying "Stripe webhooks with signature verification ... BullMQ ... PDFKit" matched THREE rules,
   * forced NOTHING, and shipped an assembly of `comm.email` + `comm.notifications` — the peripheral
   * bits — while the model hand-wrote every line of payment code in both arms.
   *
   * The cost was not a bad assembly, it was a MEANINGLESS BENCHMARK: fifteen stripejune runs measuring
   * a Strata that had nothing to contribute, read as "Strata does not help on payments". `if (!forced)
   * continue;` is what made it invisible — the rule matched, found no recall, and moved on without a
   * word. Nothing downstream could tell that apart from a rule that never matched.
   */
  const danglingForces = DOMAIN_PRIORITY.filter(d => !recallMap.has(d.recallId)).map(d => d.recallId);
  if (danglingForces.length) {
    console.error(`[strata] DOMAIN_PRIORITY names ${danglingForces.length} recall(s) that are not in the `
      + `library and can never be forced: ${danglingForces.join(', ')}. These rules are dead — either `
      + `the recall was renamed/removed, or it was never admitted. Fix the table or admit the recall.`);
  }

  // Domain-priority injection runs FIRST — explicit package names in task reserve slots
  // before generic scoring can fill them with wrong recalls.
  const domainSource = taskPrompt.toLowerCase() + ' ' + capabilitiesText;
  const forcedIds = new Set<string>();
  for (const { pattern, recallId } of DOMAIN_PRIORITY) {
    if (candidates.length >= MAX_ASSEMBLY) break;
    if (!pattern.test(domainSource)) continue;
    if (seenIds.has(recallId)) continue;
    const forced = recallMap.get(recallId);
    if (!forced) continue;
    if (portAlreadyClaimed(forced)) continue;
    seenIds.add(recallId);
    forcedIds.add(recallId);
    claimPorts(forced);
    candidates.push(forced);
  }

  // Broadened after a real miss: auth.full.express.v1 is redundant with ANY of the hand-built
  // auth scaffolds, not just the JWT one — it was still winning the password-reset task (jwt
  // correctly excluded, but this guard's old condition only checked for jwt.tokenhandling
  // specifically, so full.express slipped back in via generic scoring for a different capability
  // phrase). auth-password-reset-flow, passwordhashing, and rbac all overlap it too.
  const authFullExpressAllowed = !['auth.jwt.tokenhandling.v1', 'auth-password-reset-flow', 'auth.password.passwordhashing.v1', 'auth.rbac.express.v1']
    .some(id => forcedIds.has(id));

  for (const cap of capabilities) {
    if (candidates.length >= MAX_ASSEMBLY) break;
    const results = await searchRecalls(cap, 1, cap);
    for (const recall of results) {
      if (seenIds.has(recall.id)) continue;

      // GENERIC TOPICAL-EVIDENCE GATE.
      //
      // The semantic scorer's recall is fine; its PRECISION is not. Measured leaks: data.csv-import
      // delivered into a pure pino-logging task, validation.valibot delivered into an HTTP-retry
      // task — both purely on shared infrastructure vocabulary. Each leak is not merely wasted; it
      // is actively expensive, because the session pays turns to notice the module is irrelevant,
      // delete it, and strip its dependency from package.json. Strata's own noise cost more than
      // Strata saved.
      //
      // The per-recall guards below are whack-a-mole: I wrote five and valibot still slipped past.
      // This gate is derived from the recall's OWN metadata instead, so it scales to a library of
      // thousands with no new rules. Forced (DOMAIN_PRIORITY) recalls bypass it — an explicit
      // keyword match IS the evidence.
      if (!forcedIds.has(recall.id) && !hasTopicalEvidence(recall, evidenceHaystack)) continue;

      if (recall.id === JWT_RECALL_ID && !jwtAllowed) continue;
      if (recall.id === SEARCH_INMEMORY_RECALL_ID && !searchInMemoryAllowed) continue;
      if (recall.id === CART_SESSION_RECALL_ID && !cartAllowed) continue;
      if (recall.id === API_FORMAT_RECALL_ID && !apiFormatAllowed) continue;
      if (recall.id === CSV_IMPORT_RECALL_ID && !csvImportAllowed) continue;
      if (recall.id === HTTP_RESILIENT_RECALL_ID && !httpResilientAllowed) continue;
      if (recall.id === PAGINATION_RECALL_ID && !paginationAllowed) continue;
      if (recall.id === CACHE_RATELIMIT_RECALL_ID && !cacheRatelimitAllowed) continue;
      if (recall.id === LOGGING_RECALL_ID && !loggingAllowed) continue;
      if (recall.id === QUEUE_WORKER_RECALL_ID && (!queueAllowed || claimedPorts.has('QueueProvider'))) continue;
      if (recall.id === EMAIL_VERIF_RECALL_ID && !emailVerifAllowed) continue;
      if (recall.id === MULTITENANT_RECALL_ID && !multitenantAllowed) continue;
      if (recall.id === AUTH_SESSION_RECALL_ID && !authSessionAllowed) continue;
      if (recall.id === WEBHOOK_RETRY_RECALL_ID && !webhookRetryAllowed) continue;
      if (recall.id === API_WEBHOOK_SIG_RECALL_ID && !apiWebhookSigAllowed) continue;
      if (recall.id === JOB_DEDUP_RECALL_ID && !jobDedupAllowed) continue;
      if (recall.id === AUTH_FULL_EXPRESS_RECALL_ID && !authFullExpressAllowed) continue;
      if (portAlreadyClaimed(recall)) continue; // another recall already provides this port
      seenIds.add(recall.id);
      claimPorts(recall);
      candidates.push(recall);
      break; // top-1 per capability only
    }
  }

  // Fat recall consolidation: if an L4/L5 recall scores high against ALL capabilities
  // combined, it absorbs thin recalls from its domain.
  const combined = capabilities.join(' ');
  const fatResults = await searchRecalls(combined, 3, taskPrompt, 4, 5);

  for (const fatRecall of fatResults) {
    if (fatRecall.score < FAT_CONSOLIDATION_THRESHOLD) continue;

    // THE SAME EVIDENCE GATE AS THE MAIN LOOP. This path had none, and it is a second, independent
    // way into the assembly — so gating the main loop achieved nothing for anything that arrived here.
    //
    // Measured: auth.rbac.express.v1 (layer 4) scored high against a PURE LOGGING task and was
    // unshifted straight in. The main loop had correctly rejected it moments earlier
    // (forced=false, evidence=false); this loop admitted it anyway.
    //
    // That leak also defeats the composition gate below: a 1-recall task becomes a 2-recall task, so
    // Strata fires on work it should decline. A precision bug that INFLATES the recall count is
    // strictly worse than one that merely adds noise.
    if (!forcedIds.has(fatRecall.id) && !hasTopicalEvidence(fatRecall, evidenceHaystack)) continue;

    const kept: RecallEntry[] = [];
    const dropped: RecallEntry[] = [];
    for (const c of candidates) {
      // DOMAIN_PRIORITY-forced recalls are a deliberate, hand-verified choice for this exact
      // task shape — never let this cruder heuristic silently override that decision. This is
      // exactly what broke the JWT auth shape: auth.password.passwordhashing.v1 (93 lines, infers
      // layer 3) got swept away by auth.full.express.v1 consolidating the "auth" domain, while
      // auth.jwt.tokenhandling.v1 (194 lines, infers layer 4) survived by accident of line count
      // — same forcing intent, different fate, because fat-consolidation didn't know either was
      // forced on purpose.
      if (forcedIds.has(c.id)) { kept.push(c); continue; }
      if (c.layer < 4 && c.domain === fatRecall.domain) dropped.push(c);
      else kept.push(c);
    }

    // Don't admit a fat recall whose port is already satisfied by something surviving
    // the drop — same one-adapter-per-port rule as the main loop above.
    const stillClaimed = new Set(kept.flatMap(c => c.provides ?? []));
    if ((fatRecall.provides ?? []).some(p => stillClaimed.has(p))) continue;

    if (dropped.length > 0) {
      candidates.length = 0;
      candidates.push(...kept);
      if (!seenIds.has(fatRecall.id)) {
        candidates.unshift(fatRecall);
        seenIds.add(fatRecall.id);
      }
      break;
    }
  }

  return candidates;
}

// ─── Dependency resolver ──────────────────────────────────────────────────────

function resolveDependencies(recalls: RecallEntry[]): RecallEntry[] {
  const resolved = new Map<string, RecallEntry>();
  const queue = [...(recalls ?? [])];

  while (queue.length > 0) {
    const r = queue.shift()!;
    if (resolved.has(r.id)) continue;
    resolved.set(r.id, r);
    for (const depId of (r.dependencies ?? [])) {
      if (!resolved.has(depId)) {
        const dep = recallMap.get(depId);
        if (dep) queue.push(dep);
      }
    }
  }

  const originalIds = recalls.map(r => r.id);
  const ordered: RecallEntry[] = [];
  for (const id of originalIds) { const r = resolved.get(id); if (r) ordered.push(r); }
  for (const [id, r] of resolved) { if (!originalIds.includes(id)) ordered.push(r); }
  return ordered;
}

// ─── Assembly engine ──────────────────────────────────────────────────────────

function extractExportName(outputStr: string): string {
  // Only treat as an export if it looks like a function signature: "fn(args)" or "ClassName(args)"
  // Plain field names like "items", "nextCursor" are result properties, not module exports — skip them.
  if (!outputStr.includes('(')) return '';
  return outputStr.split('(')[0].trim();
}

/**
 * The names a recall's implementation ACTUALLY exports — parsed from its own `module.exports`.
 *
 * This is ground truth, and it replaces guessing from the metadata's prose `outputs` list. The guess
 * (extractExportName, above) requires a "(" and so silently drops everything that is not a function:
 *
 *   outputs: ["createHttpClient(opts)", "HttpError", "CircuitOpenError"]
 *                                        ^^^^^^^^^   ^^^^^^^^^^^^^^^^^  both dropped
 *
 * Two bugs fell out of that, and both were invisible:
 *   1. The composed lib.js never re-exported the error classes. The recall's own documentation says
 *      `catch (e) { if (e instanceof CircuitOpenError) ... }` — which, against the delivered
 *      assembly, is `instanceof undefined`: a TypeError, in the error path, where nobody looks.
 *   2. Worse: deconflictRecallContents treats "is an export" as "must never be renamed". A class it
 *      did not know was exported was therefore eligible for RENAMING on a collision — quietly
 *      changing a documented public name.
 *
 * A metadata typo can no longer break the delivered interface, because metadata is no longer what
 * decides it.
 */
function extractModuleExportNames(content: string): Set<string> {
  const names = new Set<string>();

  // module.exports = { a, b: internalB, C };
  const block = content.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?\s*$/);
  if (block) {
    for (const part of block[1].split(',')) {
      const cleaned = part.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!cleaned) continue;
      const key = cleaned.split(':')[0].trim();   // { publicName: internalName } -> publicName
      if (/^[\w$]+$/.test(key)) names.add(key);
    }
  }

  // exports.foo = ... / module.exports.foo = ...
  for (const m of content.matchAll(/^(?:module\.)?exports\.([\w$]+)\s*=/gm)) names.add(m[1]);

  return names;
}

// Module-level regex: string.replace() resets lastIndex before each call, so this is safe.
const REQUIRE_RE = /^const\s+(?:\{[^}]+\}|[\w$]+)\s*=\s*require\(['"]([^'"]+)['"]\);?\s*$/gm;

// ─── Assembly deconfliction ───────────────────────────────────────────────────
// Independently-authored recalls get concatenated into ONE shared top-level scope. Any two
// that happen to reuse a common generic name (Worker, Queue, client, db...) for different
// things will collide — const/let redeclaration throws a SyntaxError (loud, at least visible),
// but var/reassignment would silently shadow one another (invisible, worse). Confirmed real:
// queue.bullmq.v1's `const { Queue, Worker } = require('bullmq')` collided with
// queue-worker-pool's `const { Worker } = require('worker_threads')` and broke the whole
// assembly file. This runs before concatenation so it catches ANY such pair, not just this one.

interface NameOccurrence { name: string; module?: string; isDestructured: boolean; }

// Every top-level binding a recall's own source introduces: require targets (both
// `const X = require(mod)` and destructured `const { A, B } = require(mod)`), and other
// top-level const/let/var/function/class declarations.
function extractTopLevelNames(content: string): NameOccurrence[] {
  const names: NameOccurrence[] = [];

  for (const m of content.matchAll(/^const\s+([\w$]+)\s*=\s*require\(['"]([^'"]+)['"]\)/gm)) {
    names.push({ name: m[1], module: m[2], isDestructured: false });
  }
  for (const m of content.matchAll(/^const\s*\{([^}]+)\}\s*=\s*require\(['"]([^'"]+)['"]\)/gm)) {
    const mod = m[2];
    for (const part of m[1].split(',')) {
      const boundName = part.split(':').pop()!.trim();
      if (boundName) names.push({ name: boundName, module: mod, isDestructured: true });
    }
  }
  for (const m of content.matchAll(/^(?:const|let|var)\s+([\w$]+)\s*=(?!\s*require\()/gm)) {
    names.push({ name: m[1], isDestructured: false });
  }
  for (const m of content.matchAll(/^(?:async\s+)?function\s+([\w$]+)\s*\(/gm)) {
    names.push({ name: m[1], isDestructured: false });
  }
  for (const m of content.matchAll(/^class\s+([\w$]+)/gm)) {
    names.push({ name: m[1], isDestructured: false });
  }

  return names;
}

// Detects top-level identifier collisions across recalls in first-seen order and resolves
// them: same name from the same module is a legitimate shared dependency (left alone); same
// name from a different module is a real collision, resolved by renaming every reference to
// it within the LATER recall's own content only. Exported names are never renamed — other
// code calls them by their documented name — so a recall whose own export collides with an
// already-claimed name is dropped entirely rather than risk shipping a broken interface.
function deconflictRecallContents(
  recallContents: { id: string; content: string; exportedNames: Set<string> }[]
): { id: string; content: string; dropped: boolean }[] {
  const declaredBy = new Map<string, { recallId: string; module?: string }>();
  const results: { id: string; content: string; dropped: boolean }[] = [];

  for (const recall of recallContents) {
    let content = recall.content;
    const introduced = extractTopLevelNames(content);
    let dropped = false;

    for (const occ of introduced) {
      const existing = declaredBy.get(occ.name);
      if (!existing) {
        declaredBy.set(occ.name, { recallId: recall.id, module: occ.module });
        continue;
      }
      // Same name from the same module (two recalls both requiring 'express' as `express`) —
      // a legitimate shared dependency, not a collision.
      if (existing.module && occ.module && existing.module === occ.module) continue;

      if (recall.exportedNames.has(occ.name)) {
        // Can't safely rename a public export — other code calls it by this exact name.
        dropped = true;
        break;
      }

      const alias = `${occ.name}__${recall.id.replace(/[^\w$]/g, '_')}`;
      content = content.replace(new RegExp(`\\b${occ.name}\\b`, 'g'), alias);

      if (occ.isDestructured && occ.module) {
        // The blanket rename above also touched the destructuring property key, which must
        // stay as the real export name from the required module — repair just that one line.
        const escapedMod = occ.module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const requireLineRe = new RegExp(
          `(\\{[^}]*)\\b${escapedAlias}\\b([^}]*\\}\\s*=\\s*require\\(['"]${escapedMod}['"]\\))`
        );
        content = content.replace(requireLineRe, (_full, before, after) => `${before}${occ.name}: ${alias}${after}`);
      }
    }

    results.push(dropped
      ? { id: recall.id, content: recall.content, dropped: true }
      : { id: recall.id, content, dropped: false });
  }

  return results;
}

/**
 * Reconcile a BLIND hub assembly with a project the hub could not see.
 *
 * THE BUG THIS FIXES, measured 2026-07-31 on the catalog fixture:
 *
 * server/hub.js composes into `fs.mkdtempSync(...)` — an EMPTY directory, deliberately, because the
 * privacy guarantee is that no project file ever crosses the wire. But detectProjectShape() run against
 * an empty directory finds no entry file and concludes GREENFIELD, so the hub always takes buildCompose:
 * a whole application, plus a package.json declaring `"start": "node server.js"`.
 *
 * The client then wrote those files verbatim into a real project. On a brownfield app the result was
 * not a merge, it was a COUP: package.json's start was repointed at the hub's server.js, and the
 * project's own src/server.js — with every route it mounted — stopped being reached at all. In the
 * benchmark run this produced an app serving `/items` returning `[]` forever, on a catalog service
 * whose entire domain is products, with `/products` simply gone. Strata's own verify.js reported
 * 12/12 passed, because it tested the skeleton it had just written rather than the app a user starts.
 *
 * The privacy guarantee and brownfield fitting are in genuine tension: fitting requires seeing the
 * project, and the hub never will. So the adaptation happens HERE, on the machine that can see it —
 * the same place, and for the same reason, as schema substitution.
 *
 * The doctrine this restores is already written down in src/imprint/project-shape.ts: "Generating an
 * app for a project that has an app is over-generation, and over-generation is a tax, not a bonus."
 *
 * Greenfield is untouched: with no shape there is nothing to collide with, and the assembly is exactly
 * what the project should be.
 */
function adaptRemoteToProjectShape(
  files: Record<string, string>,
  shape: ProjectShape | null,
  projectDir: string,
): { files: Record<string, string>; note: string } {
  if (!shape) return { files, note: '' };            // greenfield — the assembly IS the project

  const out: Record<string, string> = {};
  const displaced: string[] = [];
  const ENTRY_NAMES = new Set(['server.js', 'app.js', 'index.js', 'main.js']);

  for (const [rel, source] of Object.entries(files)) {
    const norm = rel.replace(/\\/g, '/');

    // 1. An entry point at the project root would shadow the project's own. Keep it, but as reference
    //    material under strata/ — never as the thing `npm start` runs.
    if (ENTRY_NAMES.has(norm) && norm !== shape.entryFile) {
      out[`strata/${norm.replace(/\.js$/, '.reference.js')}`] = source;
      displaced.push(norm);
      continue;
    }

    // 2. The verifier boots whatever the hub told it to. The hub composed blind, so it emitted
    //    `node server.js` — the greenfield entry, which rule 1 just moved out of the way. Left alone
    //    the proof would boot a file that no longer exists, or (worse, before rule 1) boot Strata's
    //    skeleton and pass 12/12 while the app a user actually starts was broken. It must boot what
    //    `npm start` boots, or it is not proof of anything the user will run.
    if (norm === 'strata/verify.js') {
      out[norm] = source.replace(/"node server\.js"/g, JSON.stringify(`node ${shape.entryFile}`));
      continue;
    }

    // 3. package.json is the project's own file. Take the dependencies, leave everything else alone —
    //    name, version, and above all `scripts`, which is what decides which server actually runs.
    if (norm === 'package.json') {
      const existingPath = path.join(projectDir, 'package.json');
      if (fs.existsSync(existingPath)) {
        try {
          const mine = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
          const theirs = JSON.parse(source);
          mine.dependencies = mine.dependencies ?? {};
          let added = false;
          for (const [n, v] of Object.entries(theirs.dependencies ?? {})) {
            if (!mine.dependencies[n]) { mine.dependencies[n] = v as string; added = true; }
          }
          if (added) out['package.json'] = JSON.stringify(mine, null, 2) + '\n';
          continue;
        } catch {
          // Unparseable on either side — leave the project's file completely alone rather than
          // risk corrupting the one file that decides how the app starts.
          continue;
        }
      }
    }

    out[norm] = source;
  }

  if (!displaced.length) return { files: out, note: '' };

  return {
    files: out,
    note: `\n\n— Adapted to your project —\n`
      + `This project already has an entry point (\`${shape.entryFile}\`), so Strata did NOT overwrite it `
      + `and did NOT change your package.json scripts. The composed application was written to `
      + `\`strata/${displaced[0].replace(/\.js$/, '.reference.js')}\` instead.\n\n`
      + `To activate the delivered capabilities, splice the middleware wiring from that reference file `
      + `into \`${shape.entryFile}\` — the requires at the top, and the \`app.use(...)\` lines, in the `
      + `order they appear there. Your existing routes stay exactly as they are.\n`,
  };
}

function buildAssembly(
  recalls: RecallEntry[],
  strataDir: string,
  capabilities: string[],
): DeliveredRecall | null {
  if (recalls.length === 0) return null;

  // Recalls synced from the hub index describe themselves but ship no source to this machine, so
  // `physicalPath` is ''. Local assembly reads implementation.js, scaffolds and selftests by joining
  // onto that path, and path.join('', 'implementation.js') is the RELATIVE path 'implementation.js' —
  // it would resolve against the process cwd, which is the user's project. In the bad case that finds
  // an unrelated file of the user's and composes it into their app as if it were library code.
  //
  // This path is only reachable when hub composition already failed (the hub is down), and the honest
  // answer there is a decline, which is behaviour Strata is designed around.
  // Says nothing about WHY, deliberately: in hub mode this is the ordinary path — local assembly is
  // attempted first and returns null, then composeOnHub() does the real work. Claiming "the hub is
  // unreachable" here fired on every successful hub call and pointed debugging at the wrong system.
  if (recalls.some(r => !r.physicalPath)) return null;

  // Single recall: lightweight delivery, no assembly overhead
  if (recalls.length === 1) {
    const pick = recalls[0];
    const implPath = path.join(pick.physicalPath, 'implementation.js');
    if (!fs.existsSync(implPath)) return null;
    const destName = `${pick.id}.js`;
    fs.mkdirSync(strataDir, { recursive: true });
    fs.copyFileSync(implPath, path.join(strataDir, destName));
    return {
      id: pick.id,
      name: pick.name,
      description: pick.description,
      filename: destName,
      inputs: pick.inputs,
      outputs: pick.outputs,
      callExample: pick.callExample,
      useCases: pick.useCases,
    };
  }

  // Multi-recall: hoist requires, concatenate, unified export block
  const seenModules = new Set<string>();
  const hoisted: string[] = [];
  const sections: string[] = [];
  const exportNames: string[] = [];
  const seenExports = new Set<string>();

  // Pass 1: read every recall's content and resolve top-level name collisions BEFORE anything
  // gets concatenated into the shared scope below (see deconflictRecallContents).
  const rawContents: { id: string; content: string; exportedNames: Set<string> }[] = [];
  const exportsByRecall = new Map<string, Set<string>>();
  for (const recall of (recalls ?? [])) {
    const implPath = path.join(recall.physicalPath, 'implementation.js');
    if (!fs.existsSync(implPath)) continue;
    let content = fs.readFileSync(implPath, 'utf-8');

    // Read the real export list BEFORE stripping it off — this line is the only place it exists.
    const declared = extractModuleExportNames(content);
    // Fall back to the metadata guess only for a recall that somehow declares nothing parseable.
    const exportedNames = declared.size > 0
      ? declared
      : new Set((recall.outputs ?? []).map(extractExportName).filter(Boolean));

    content = content.replace(/\n?module\.exports[\s\S]*$/, '').trimEnd();
    exportsByRecall.set(recall.id, exportedNames);
    rawContents.push({ id: recall.id, content, exportedNames });
  }
  const deconflicted = new Map(
    deconflictRecallContents(rawContents).map(d => [d.id, d])
  );

  for (const recall of (recalls ?? [])) {
    const resolved = deconflicted.get(recall.id);
    if (!resolved || resolved.dropped) continue; // missing impl, or collided on an exported name

    let content = resolved.content;

    content = content.replace(REQUIRE_RE, (line, mod) => {
      if (seenModules.has(mod)) return '';
      seenModules.add(mod);
      hoisted.push(line.trim());
      return '';
    });

    const bar = '─'.repeat(Math.max(2, 48 - recall.name.length - recall.id.length));
    sections.push(`// ─── ${recall.name} (${recall.id}) ${bar}\n${content.trimStart()}`);

    // Re-export exactly what this recall's implementation exported — classes and constants included.
    for (const name of (exportsByRecall.get(recall.id) ?? new Set<string>())) {
      if (!seenExports.has(name)) { seenExports.add(name); exportNames.push(name); }
    }
  }

  const exportBlock = exportNames.length > 0
    ? `\nmodule.exports = { ${exportNames.join(', ')} };\n`
    : '';

  // Name it for what it CONTAINS, not for a hash of the request.
  //
  // This used to be `assembly_dG9rZW4t.js` — a base64 fragment. A benchmark session called it "the
  // single opaque strata/assembly_*.js blob" on its way to rewriting everything by hand, and it was
  // right to be suspicious: a file with a scrambled name holding all the code is what malware looks
  // like. It cost nothing to name honestly, and a name is the first thing anyone reads.
  const domains = [...new Set(recalls.map(r => r.domain || r.id.split('.')[0]))].sort();
  const stem = domains.length === 1 ? domains[0] : 'lib';
  const filename = `${stem.replace(/[^a-z0-9-]/gi, '') || 'lib'}.js`;

  const assembled = [
    `// Strata — implementation for: ${recalls.map(r => r.id).join(', ')}`,
    '//',
    '// Ordinary source, generated from this project\'s local recall library. Every function below is',
    '// plain JavaScript you can read, edit, or delete. The behavioural tests for these functions are',
    '// in ./tests/ and run via `node strata/verify.js`.',
    ...hoisted,
    '',
    sections.join('\n\n'),
    exportBlock,
  ].join('\n');

  fs.mkdirSync(strataDir, { recursive: true });
  fs.writeFileSync(path.join(strataDir, filename), assembled);

  const letters = 'ABCDEFGHIJ';
  const manifest = recalls.map((r, i) => {
    const outs = (r.outputs ?? []).slice(0, 3).join(', ') || r.name;
    return `  [${letters[i] ?? String(i + 1)}] ${r.name} — ${outs}`;
  }).join('\n');

  return {
    id: filename.replace(/\.js$/, ''),
    name: `Assembly (${recalls.length} modules)`,
    description: `Capabilities included:\n${manifest}`,
    filename,
    inputs: recalls.flatMap(r => r.inputs ?? []),
    outputs: exportNames,
    callExamples: recalls.filter(r => r.callExample).map(r => `// ${r.name}:\n${r.callExample}`),
    isComposite: true,
    compositeIds: recalls.map(r => r.id),
  };
}

// ─── Assembly 2.0 — pre-wired module ─────────────────────────────────────────

interface WiredModule {
  filename: string;
  wiredLines: string[]; // human-readable lines for the system prompt summary
}

interface ScaffoldFile {
  name: string;
  injectSlots: string[]; // text after each "// INJECT:" line in the template
  writtenToRoot: boolean; // true: placed directly at the project root, no Write turn needed. false: a file with this name already existed at the root, so this was staged at scaffoldDir instead — Claude must read and merge it manually.
  /**
   * True when the file ALREADY EXISTED and Strata changed it.
   *
   * The prompt must report this accurately. Listing an edited package.json under "FILES CREATED" is a
   * small lie, and a small lie in the one place we are asking to be believed is expensive: a session
   * that catches us misdescribing our own writes has every reason to re-check everything else we said.
   */
  modified?: boolean;
}

interface ScaffoldResult {
  files: ScaffoldFile[];
  scaffoldDir: string;
  projectDir: string;
  /**
   * The project's pre-existing entry point, when Strata edited it.
   *
   * Tracked so the prompt can DISCLOSE the edit. A session that finds its own `server.js` silently
   * rewritten calls it "scaffolding I didn't ask for, mixed into the actual project files" — and it is
   * right to. An undisclosed write to someone else's file has the shape of an attack, whatever the
   * intent behind it.
   */
  entryFile?: string;
  /**
   * When the implementation was installed as a local dependency (STRATA_DELIVER_AS_DEP), this is its
   * package name. The delivery prompt then frames it as a dependency to import rather than source to
   * read — because a model audits source in the project and never audits node_modules. Delivery MODE,
   * not model capability, is what flipped the June −44% wins into today's losses: the winning recalls
   * were npm-backed (delivered as dependencies), the current library is hand-written (delivered as
   * source). See STRATA-BENCHMARK-FINDINGS.md.
   */
  depName?: string;
  /**
   * Persistence adapters generated from strata.guide.json (STRATA-GUIDE.md). Each is written into the
   * project's data dir; the delivery prompt lists its factory + a one-line injection hint so the model
   * IMPORTS a ready store instead of hand-writing the data-layer bridge — the brownfield tax.
   */
  guideAdapters?: Array<{ rel: string; factory: string; inject: string }>;
  /** One authoritative line about the project's data reality (from strata.guide.json), surfaced first. */
  guideDataLayerNote?: string;
}

/**
 * Generate persistence adapters from strata.guide.json and write them into the project. This is the
 * live-delivery hook for the guide feature (STRATA-GUIDE.md §6 step 4): when a trustworthy guide is
 * present, the data-layer bridge a recall would otherwise be hand-written for is emitted deterministically
 * here — zero LLM, zero turns. Returns the ScaffoldFiles to append and the injection hints for the prompt.
 *
 * Silent on the common paths: no guide (greenfield / not yet authored) or a guide that fails its own
 * fact-check → returns nothing, and delivery proceeds exactly as before. It never blocks delivery; it can
 * only add ready adapters when it is safe to.
 */
function emitGuideAdapters(
  recalls: RecallEntry[],
  projectDir: string,
): { files: ScaffoldFile[]; adapters: NonNullable<ScaffoldResult['guideAdapters']>; dataLayerNote: string } {
  const empty = { files: [] as ScaffoldFile[], adapters: [] as NonNullable<ScaffoldResult['guideAdapters']>, dataLayerNote: '' };
  let guide;
  try {
    guide = loadGuide(projectDir);
  } catch (e) {
    // A malformed guide is the user's to fix — surface it in the log, don't crash delivery.
    console.error('[strata] strata.guide.json present but unreadable:', e instanceof Error ? e.message : e);
    return empty;
  }
  if (!guide) return empty;

  const res = generateAdapters(guide, recalls.map(r => ({ id: r.id, outputs: r.outputs })), projectDir);
  if (!res.trustworthy) {
    console.error(`[strata] strata.guide.json failed fact-check (${res.violations.filter(v => v.severity === 'error').length} errors) — skipping adapter generation.`);
    return empty;
  }
  const note = res.dataLayerNote;

  const files: ScaffoldFile[] = [];
  const adapters: NonNullable<ScaffoldResult['guideAdapters']> = [];
  for (const f of res.files) {
    const abs = path.join(projectDir, f.rel);
    // Never clobber a file the project already has — an existing adapter is the user's, not ours.
    if (fs.existsSync(abs)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.code);
    files.push({ name: f.rel, injectSlots: f.gaps, writtenToRoot: true });
    adapters.push({ rel: f.rel, factory: f.factory, inject: f.inject });
  }
  if (adapters.length) console.error(`[strata] guide: generated ${adapters.length} persistence adapter(s) from strata.guide.json`);
  return { files, adapters, dataLayerNote: note };
}

// Places a scaffold file directly at the project root when nothing occupies that path yet —
// this is what collapses the old "copy each file from ./strata/scaffold/" turns into zero turns.
// Falls back to staging in scaffoldDir (old behavior) when a same-named file already exists,
// so an existing user file is never silently clobbered.
function placeScaffoldFile(name: string, content: string, projectDir: string, scaffoldDir: string): boolean {
  const rootPath = path.join(projectDir, name);
  if (fs.existsSync(rootPath)) {
    fs.writeFileSync(path.join(scaffoldDir, name), content);
    return false;
  }
  fs.writeFileSync(rootPath, content);
  return true;
}

function buildWiredModule(
  recalls: RecallEntry[],
  assemblyFilename: string,
  strataDir: string,
  conventions: Record<string, string>,
): WiredModule | null {
  const wireable = recalls.filter(r => r.wiringTemplate);
  if (wireable.length === 0) return null;

  const confirmedEnvVars = new Set<string>(
    (conventions['ENV_VARS'] ?? '').split(',').filter(Boolean),
  );

  // Collect all export names across selected recalls
  const allExportNames: string[] = [];
  const seenNames = new Set<string>();
  for (const r of recalls) {
    for (const out of (r.outputs ?? [])) {
      const n = extractExportName(out);
      if (n && !seenNames.has(n)) { seenNames.add(n); allExportNames.push(n); }
    }
  }

  const lines: string[] = [
    '// Strata pre-wired instances — env vars auto-filled from .env.example',
    `// Recalls: ${recalls.map(r => r.id).join(' + ')}`,
    '',
    `const { ${allExportNames.join(', ')} } = require('./${assemblyFilename}');`,
    '',
  ];

  const wiredLines: string[] = [];
  const wiredVarNames: string[] = [];

  for (const recall of wireable) {
    let wiring = recall.wiringTemplate!;

    // Annotate env slots not yet confirmed in the project's .env.example
    for (const slot of (recall.envSlots ?? [])) {
      if (!confirmedEnvVars.has(slot)) {
        wiring = wiring.replace(
          new RegExp(`process\\.env\\.${slot}\\b`, 'g'),
          `process.env.${slot} /* ⚠ add ${slot} to .env */`,
        );
      }
    }

    lines.push(`// ─── ${recall.name} ───`);
    lines.push(wiring);
    lines.push('');

    const varMatch = wiring.match(/^(?:const|let|var)\s+(\w+)\s*=/m);
    if (varMatch) {
      wiredVarNames.push(varMatch[1]);
      wiredLines.push(`${varMatch[1]} — pre-instantiated from ${recall.name}`);
    }
  }

  // Pass-through exports: not already covered by wired var names
  const wiredSet = new Set(wiredVarNames);
  const passthroughs = allExportNames.filter(n => !wiredSet.has(n));
  const exportList = [...wiredVarNames, ...passthroughs];

  if (exportList.length > 0) {
    lines.push(`module.exports = { ${exportList.join(', ')} };`);
  }

  const filename = `wired-${assemblyFilename}`;
  fs.mkdirSync(strataDir, { recursive: true });
  fs.writeFileSync(path.join(strataDir, filename), lines.join('\n'));

  return { filename, wiredLines };
}

// ─── Scaffold generator ───────────────────────────────────────────────────────

function extractInjectSlots(template: string): string[] {
  const slots: string[] = [];
  for (const line of template.split('\n')) {
    const m = line.match(/\/\/\s*INJECT:\s*(.+)/);
    if (m) slots.push(m[1].trim());
  }
  return slots;
}

// ─── V3: package delivery (see STRATA-V3.md) ──────────────────────────────────
// A model imports a normal npm dependency without reading it (it does this with `stripe` and
// `jsonwebtoken` every day). It will NOT do that with an opaque implementation file a tool wrote
// into its project — it audits it, and usually rewrites it, which is why output savings never
// materialised. Measured: a live session classified the written-in assembly as a supply-chain
// attack, rm -rf'd it, and rebuilt from scratch.
//
// So when the selected recalls are all covered by a published kit, we ship a DEPENDENCY, not code:
// nothing is written into the project, nothing needs auditing, and the implementation never enters
// the model's context at all (it lives in node_modules → 0 tokens).
// Tokens that appear in nearly every backend task and therefore prove nothing about topic. Without
// this list, "express" or "error" alone would wave any recall through and the gate would be a no-op.
const GENERIC_EVIDENCE_TOKENS = new Set([
  'express', 'middleware', 'node', 'nodejs', 'javascript', 'typescript', 'api', 'rest', 'restful',
  'http', 'https', 'server', 'client', 'async', 'await', 'promise', 'error', 'errors',
  'error handling', 'error handler', 'validation', 'validate', 'security', 'secure', 'production',
  'service', 'app', 'handler', 'handlers', 'route', 'routes', 'routing', 'json', 'config',
  'util', 'utils', 'helper', 'helpers', 'library', 'module', 'pattern', 'patterns', 'data',
  'request', 'response', 'endpoint', 'endpoints', 'backend', 'web',
  // AMBIGUOUS ACROSS DOMAINS. Each of these names a thing you REDACT at least as often as a thing you
  // IMPLEMENT, and a single ambiguous word must never carry evidence on its own.
  //
  // A pure pino-logging task — "redaction of authorization header/cookies/password fields" — pulled in
  // BOTH auth.rbac.express.v1 (on "authorization") AND auth.password.passwordhashing.v1 (on
  // "password"). Neither has anything to do with logging. Both recalls remain findable by the tokens
  // that are actually THEIRS: rbac by "rbac"/"role"/"permission", hashing by "bcrypt"/"pbkdf2"/"hash".
  //
  // This also defeated the composition gate: two spurious recalls turned a 1-recall task into a
  // 3-recall task, so Strata fired on work it should have declined. A precision bug that INFLATES the
  // recall count is strictly worse than one that merely adds noise.
  'authorization', 'auth', 'token', 'tokens', 'header', 'headers', 'cookie', 'cookies',
  'password', 'passwords', 'credential', 'credentials', 'secret', 'secrets',
  // "schema" is a database schema, a CSV schema, a GraphQL schema and a validation schema. The CSV
  // task says "validate each row against a schema" and pulled validation.request.v1 in on that word
  // alone — a second recall on a one-recall task, which is exactly the inflation that defeats the
  // composition gate. validation.request.v1 stays findable through the two-word tag
  // "schema-validation" (" schema validation "), a phrase the CSV task never uses.
  'schema', 'schemas', 'field', 'fields', 'body', 'query', 'input', 'output',
  // "health" alone is any trivial endpoint — a logging task that mentions "a health route" in passing
  // pulled in ops.health.v1 and inflated a 1-recall task to 2, defeating the composition gate. The real
  // signal for that recall is the DISTINCTIVE pairing it also tags: "liveness", "readiness",
  // "healthcheck", "graceful shutdown", "sigterm" — none of which a bare "health route" contains.
  'health',
]);

/**
 * Does the task text contain any DISTINCTIVE token from this recall's own metadata?
 *
 * Evidence comes from the recall's id segments and its tags — not from a hand-written rule — so a
 * new recall is gated automatically the moment it is added. A csv recall needs the task to actually
 * say something csv-shaped ("csv", "spreadsheet", "bulk import"); shared words like "express" and
 * "validation" are stopworded out and cannot carry it through on their own.
 */
function hasTopicalEvidence(recall: RecallEntry, haystack: string): boolean {
  const tokens = new Set<string>();

  for (const seg of recall.id.toLowerCase().split(/[.\-_]/)) {
    if (seg.length >= 3 && seg !== 'v1') tokens.add(seg);
  }
  for (const tag of (recall.tags ?? []) as string[]) {
    const normalized = String(tag).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (normalized.length >= 3) tokens.add(normalized);
  }

  for (const token of tokens) {
    if (GENERIC_EVIDENCE_TOKENS.has(token)) continue;
    // WORD BOUNDARIES, not substrings.
    //
    // `haystack.includes(token)` matched "auth" inside "authorization" — so a logging task that
    // mentioned "the authorization header" pulled in the RBAC recall. Every short token has this
    // problem ("api" in "rapid", "cache" in "cached"), and the haystack is already normalised to
    // space-separated words, so padding both sides is enough to require a whole-word match.
    if (haystack.includes(` ${token} `)) return true;
  }
  return false;
}

interface PackageShape {
  name: string;
  version: string;     // published semver range — a REAL registry dependency
  localPath: string;   // only used when STRATA_LOCAL_PKG=1 (pre-publish dev)
  covers: string[];    // recall ids this kit provides
}
// DISABLED. Delivering recalls as npm dependencies was a dead end for two reasons.
//
// Empirically: 0/3 sessions adopted `strata-payments-kit@1.0.0` even after it was genuinely
// published to the registry. They rejected it on reputation ("published 4 minutes ago, zero
// track record, unknown maintainer") — which is the CORRECT call for code that verifies payment
// signatures. Reputation is earned through time and usage, and you cannot get usage without
// adoption. That is a closed loop with no entry point.
//
// Strategically: npm-as-the-library gives away the product. Strata's value IS the library; routing
// through someone else's registry reduces Strata to a package recommender and caps it at whatever
// npm already allows.
//
// The code paths below all accept `pkgShape === null` and fall back to native assembly+scaffold
// delivery, so emptying this table is a complete, reversible switch-off.
const PACKAGE_SHAPES: PackageShape[] = [];

// A registry version ("^1.0.0") is an ordinary dependency and reads as one. A `file:` path pointing
// at some other folder on the user's disk does not — sessions repeatedly (and correctly) refused it
// as "fragile and not something that should ship as a real dependency", which is what suppressed
// adoption. Local mode stays available for pre-publish development only.
function packageSpec(shape: PackageShape): string {
  if (process.env.STRATA_LOCAL_PKG === '1') {
    return `file:${shape.localPath.replace(/\\/g, '/')}`;
  }
  return shape.version;
}

// A kit applies when it covers every recall the scaffold ACTUALLY WIRES (the ones with a scaffold
// role). Earlier this demanded that the kit cover *every* selected recall — one stray, irrelevant
// recall (auth.rbac.express.v1 leaking into a payments task) then silently vetoed package mode and
// dropped us back to shipping a code blob. Over-strict guards like that are brittle: they let an
// unrelated element decide something it has no stake in. Check only what matters, drop the rest.
function resolvePackageShape(recalls: RecallEntry[]): { shape: PackageShape; used: RecallEntry[] } | null {
  const wired = recalls.filter(r => r.scaffold?.serverRole || r.scaffold?.workerRole);
  if (wired.length === 0) return null;
  for (const shape of PACKAGE_SHAPES) {
    if (wired.every(r => shape.covers.includes(r.id))) {
      // Deliver only the covered recalls; strays are dropped rather than dragging in a blob.
      return { shape, used: recalls.filter(r => shape.covers.includes(r.id)) };
    }
  }
  return null;
}

// ─── V4: contribution-based composition ───────────────────────────────────────
//
// The rank scale. Express middleware order is not cosmetic — it decides whether a feature works at
// all, and it is the single thing teams most reliably get wrong. Encoding it here makes the wrong
// order UNREPRESENTABLE rather than merely discouraged.
//
//   10  request logger      — FIRST. Anything downstream that throws must already have req.log/req.id.
//   20  rate limiter        — reject a flood BEFORE paying for body parsing or cache lookups.
//   30  body parsers        — express.json() THROWS on a malformed body. If it ran above the logger,
//                             the error path would have no correlation id, and the one request you
//                             most want to trace is precisely the one that loses it. (A benchmark
//                             session caught us shipping exactly this bug.)
//   40  response cache      — after auth/limits, before the handler does real work.
//   50  routes
//   99  error handlers      — LAST. Express only reaches a handler registered downstream of the throw.
const BODY_PARSER_RANK = 30;

/** A body parser every JSON API needs. Owned by the skeleton so no recall has to claim it. */
const BASE_MIDDLEWARE = `app.use(express.json());`;

function readFragment(recall: RecallEntry, file: string): string {
  const full = path.join(recall.physicalPath, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8').trim() : '';
}

/**
 * Render one contribution as source, for THIS framework.
 *
 * The only place in the compiler that knows Express mounts middleware with `app.use(...)`. A Fastify
 * renderer would emit `app.register(middie).then(() => app.use(...))`; a Koa one would wrap with
 * koa-connect. Neither would need a single change to any recall — which is the whole point of the
 * declarative form.
 */
function renderFragment(
  recall: RecallEntry,
  frag: ComposeFragment,
  kind: 'middleware' | 'errorHandler' | 'setup',
): string {
  // Declarative (portable): the recall named a factory, not a mounting statement.
  if (frag.factory) {
    const call = `${frag.factory}(${(frag.args ?? []).join(', ')})`;
    return kind === 'setup' ? call : `app.use(${call});`;
  }
  // Raw source (framework-specific). Correct for setup; a lock-in for anything that mounts.
  return frag.file ? readFragment(recall, frag.file) : '';
}

/**
 * Substitute the project's own entity into a fragment. THIS is the compiler's back end.
 *
 * Composition can already derive the mechanical parts — imports, middleware order, wiring — from the
 * recalls alone. What it cannot invent is that this project's catalog entity is `Product`, that it
 * has a `sku` and a `price`, or that the route is `/products`. That is DOMAIN knowledge, and it lives
 * in the project's schema. Reading it is offline, deterministic, and costs zero tokens.
 *
 * When no entity resolves we substitute honest, generic defaults and LEAVE the INJECT slot. A
 * confidently wrong entity is strictly worse than none: wrong code costs turns to notice, delete, and
 * un-wire (we measured that tax three separate times), whereas an INJECT slot just asks the model to
 * do the one thing it was always going to do anyway.
 */
function substituteEntity(
  fragment: string,
  entity: Entity | null,
  dataSource: { requireLine: string; expression: string; persistExpression: string | null } | null = null,
  /** A route the task named explicitly, when there is no schema to read. */
  namedRoute: string | null = null,
): string {
  if (!fragment.includes('{{')) return fragment;

  if (!entity) {
    // Greenfield. If the task NAMED a route ("a GET /products list endpoint"), use that name — the
    // session will rename our generic `/items` to match the spec anyway, and then it has to repair the
    // verifier we pointed at the old URL. Emitting the right name costs nothing.
    const route = namedRoute ?? '/items';
    const upper = route.replace(/^\//, '').replace(/[^a-z0-9]/gi, '').toUpperCase() || 'ITEM';
    return fragment
      .replace(/\{\{ENTITY_NOTE\}\}/g, 'INJECT: point the route at this project\'s real data source.')
      .replace(/\{\{ENTITY_UPPER\}\}/g, upper)
      // ENTITY_LOWER exists because fragments need a form fit for an IDENTIFIER — `userSerializer`,
      // not `USERSerializer`. Three generated recalls emitted it, correctly assuming a counterpart to
      // ENTITY_UPPER; nothing substituted it, so `{{ENTITY_LOWER}}Serializer` reached server.js as a
      // syntax error and the only symptom was "the server did not start". The gap was ours.
      .replace(/\{\{ENTITY_LOWER\}\}/g, upper.toLowerCase())
      .replace(/\{\{ROUTE\}\}/g, route)
      .replace(/\{\{ID_FIELD\}\}/g, 'id')
      .replace(/\{\{SORTABLE\}\}/g, `'id'`)
      .replace(/\{\{FILTERABLE\}\}/g, '')
      // minLength is not decoration — it is what the greenfield verifier's invalid row violates. A
      // one-column CSV cannot express "missing" (an empty line is skipped as blank), so `required`
      // alone is unprovable here and the schema and its proof must agree.
      .replace(/\{\{CSV_SCHEMA\}\}/g, `{\n  name: { type: 'string', required: true, minLength: 2 },\n}`)
      .replace(/\{\{DATA_SOURCE_NOTE\}\}/g, '// INJECT: point this at the real data source.\n      ')
      .replace(/\{\{DATA_SOURCE\}\}/g, '[]')
      .replace(/\{\{PERSIST\}\}/g, '// INJECT: persist result.valid here (insert into the database, enqueue, etc.)');
  }

  const quoted = (names: string[]): string => names.map(n => `'${n}'`).join(', ');

  return fragment
    .replace(/\{\{ENTITY_NOTE\}\}/g,
      `Derived from ${entity.source} — Strata read your schema, so these field lists are the real ones.`)
    .replace(/\{\{ENTITY_UPPER\}\}/g, entity.name.toUpperCase())
    .replace(/\{\{ENTITY_LOWER\}\}/g, entity.name.toLowerCase())
    // The schema's ACTUAL unique key. Mongoose documents key on `_id`; hardcoding `id` made every
    // cursor encode `undefined`, so page 2 silently re-served page 1. The pages looked plausible and
    // the data was wrong — caught by the shop-mongoose fixture, not by any unit test.
    .replace(/\{\{ID_FIELD\}\}/g, entity.fields.find(f => f.isId)?.name ?? 'id')
    .replace(/\{\{ROUTE\}\}/g, routePath(entity))
    .replace(/\{\{SORTABLE\}\}/g, quoted(sortableFields(entity)))
    .replace(/\{\{FILTERABLE\}\}/g, quoted(filterableFields(entity)))
    .replace(/\{\{CSV_SCHEMA\}\}/g, csvSchemaFor(entity))
    // A data source is only substituted when we actually FOUND the project's module. Inventing one
    // would produce code that compiles, runs, and silently serves the wrong rows — the worst failure
    // mode there is. When we can't find it, the INJECT slot stays and the model wires one line.
    //
    // And when we DID find it, the INJECT comment must disappear: an instruction to do work that is
    // already done is worse than no instruction — it sends the model looking for a problem that isn't
    // there, which is a turn spent for nothing.
    .replace(/\{\{DATA_SOURCE_NOTE\}\}/g, dataSource ? '' : '// INJECT: point this at the real data source.\n      ')
    .replace(/\{\{DATA_SOURCE\}\}/g, dataSource ? dataSource.expression : '[]')
    // Same rule for persistence: only wire it when the repository actually exposes a bulk write.
    .replace(/\{\{PERSIST\}\}/g, dataSource?.persistExpression
      ? `const created = ${dataSource.persistExpression};`
      : '// INJECT: persist result.valid here (insert into the database, enqueue, etc.)');
}

/**
 * Placeholders are a CLOSED vocabulary. Anything left after substitution is a name we do not support,
 * and it reaches the user's server.js as literal `{{FOO}}` — a syntax error whose only symptom is
 * "the server did not start", pointing nowhere near the actual cause.
 *
 * Three recalls died on `{{ENTITY_LOWER}}` before anyone worked out why, at ~6 minutes a run. A
 * mystifying symptom costs far more than a loud one: name the unknown placeholder and the fix is
 * immediate.
 */
export function unresolvedPlaceholders(fragment: string): string[] {
  return [...new Set((fragment.match(/\{\{[A-Z_]+\}\}/g) ?? []))];
}

/**
 * THE CLIENT-SIDE SUBSTITUTION PASS — the local half of the hub split.
 *
 * The hub returns an assembly whose placeholders are intact, because it is never told anything about
 * the project. This runs on the user's machine, against a schema that never left it, and fills them in.
 *
 * Two properties this must have, and both are the reason it is code rather than a model:
 *
 *   1. DETERMINISTIC. The same assembly and the same schema always produce the same files. A model
 *      asked to "fill in the placeholders" paraphrases, renames a field, or quietly skips one.
 *   2. TOTAL. Every placeholder is resolved or nothing is written. A half-substituted file reaches the
 *      model as `{{ENTITY_UPPER}}` in the middle of an identifier — a syntax error whose only symptom
 *      is "the server did not start", which is precisely how three recalls died before anyone worked
 *      out the cause.
 *
 * So a leftover placeholder THROWS. Handing the model a template it has to guess at is strictly worse
 * than failing loudly here, where the message can name the placeholder and the file.
 */
export function substituteAssembly(
  files: Record<string, string>,
  entity: Entity | null,
  dataSource: { requireLine: string; expression: string; persistExpression: string | null } | null,
  namedRoute: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  const leftovers: string[] = [];

  for (const [name, src] of Object.entries(files)) {
    const filled = substituteEntity(src, entity, dataSource, namedRoute);
    const missing = unresolvedPlaceholders(filled);
    if (missing.length) leftovers.push(`${name}: ${missing.join(', ')}`);
    out[name] = filled;
  }

  if (leftovers.length) {
    throw new Error(
      'Strata refused to write: placeholders were not resolved.\n  '
      + leftovers.join('\n  ')
      + '\nThese are names the substitution vocabulary does not know. Writing them would put literal '
      + '{{TOKENS}} into your source. Report this at stratalib.com — it is a bug in the recall, not in '
      + 'your project.',
    );
  }
  return out;
}

/** Did the task actually ask for this? A fragment with no `when` is unconditional. */
function fragmentWanted(frag: ComposeFragment, taskText: string): boolean {
  if (!frag.when) return true;
  try {
    return new RegExp(frag.when, 'i').test(taskText);
  } catch {
    return true;   // a malformed `when` must not silently drop a fragment
  }
}

/** Sort by rank, then by recall id, so composition is deterministic run-to-run. */
function rankedFragments(
  recalls: RecallEntry[],
  pick: (s: ComposeServer) => ComposeFragment[] | undefined,
  taskText: string,
): Array<{ recall: RecallEntry; frag: ComposeFragment }> {
  const out: Array<{ recall: RecallEntry; frag: ComposeFragment }> = [];
  for (const r of recalls) {
    for (const frag of pick(r.compose?.server ?? {}) ?? []) {
      if (fragmentWanted(frag, taskText)) out.push({ recall: r, frag });
    }
  }
  return out.sort((a, b) => a.frag.rank - b.frag.rank || a.recall.id.localeCompare(b.recall.id));
}

/** Setup fragments, gated the same way. Falls back to the legacy single `setupFile`. */
function setupFragments(
  recalls: RecallEntry[],
  taskText: string,
): Array<{ recall: RecallEntry; frag: ComposeFragment }> {
  const out: Array<{ recall: RecallEntry; frag: ComposeFragment }> = [];
  for (const r of recalls) {
    const s = r.compose?.server;
    if (!s) continue;
    if (s.setup?.length) {
      for (const frag of s.setup) {
        if (fragmentWanted(frag, taskText)) out.push({ recall: r, frag });
      }
    } else if (s.setupFile) {
      out.push({ recall: r, frag: { rank: 50, file: s.setupFile } });
    }
  }
  return out.sort((a, b) => a.frag.rank - b.frag.rank || a.recall.id.localeCompare(b.recall.id));
}

/**
 * The imports actually needed: a recall's unconditional imports, plus the imports of the fragments we
 * are really emitting. Importing `createCache` when the cache fragment was dropped leaves a dangling
 * name in the file — and a dangling name is exactly the kind of thing that makes a reader stop
 * trusting everything around it.
 */
function neededImports(
  recalls: RecallEntry[],
  included: Array<{ recall: RecallEntry; frag: ComposeFragment }>,
): string[] {
  const names = new Set<string>();
  for (const r of recalls) {
    for (const n of r.compose?.server?.imports ?? []) names.add(n);
  }
  for (const { frag } of included) {
    for (const n of frag.imports ?? []) names.add(n);
  }
  return [...names].sort();
}

/**
 * Compose one server from N recalls. Additive: every recall contributes, none is dropped.
 *
 * Returns null when no selected recall carries a `compose` block, so the legacy `scaffold` path
 * (and the auth/payments + worker recalls that still use it) keeps working untouched.
 */
/**
 * A collection route the task NAMES explicitly, e.g. "a GET /products list endpoint" → "/products".
 *
 * When there is no project schema to read, the task text is the only statement of what the feature is
 * called — and the session WILL rename our generic `/items` to match the spec. Better to emit the
 * right name in the first place than to make it rename our code and then repair our verifier.
 */
function routeNamedInTask(taskText: string): string | null {
  // Sub-paths like /products/import are derived, not matched — take the collection root only.
  const skip = new Set(['health', 'api', 'v1', 'v2', 'import', 'items']);

  // The slash must START a path, not separate two words. English uses `/` as "or" constantly —
  // "CSV/JSON export", "Express/Fastify", "liveness/readiness" — and matching those produced routes
  // at `/json` and `/express` while the verifier tested the URL the feature was SUPPOSED to serve.
  // Every pair containing data.export.v1 failed the composition sweep on exactly this.
  //
  // A real path is preceded by whitespace, a quote, a bracket, or the start of the string. A prose
  // separator is preceded by a letter or digit. That single distinction removes the whole class,
  // where extending the skip-list would only ever chase the last example someone hit.
  for (const m of taskText.matchAll(/(?:^|[\s"'`([<])\/([a-z][a-z0-9-]{2,30})\b/gi)) {
    const seg = m[1].toLowerCase();
    if (!skip.has(seg)) return `/${seg}`;
  }
  return null;
}

/** Indent a fragment so it sits correctly inside a function body. */
function indentBlock(code: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return code.split('\n').map(l => (l.trim() ? pad + l : l)).join('\n');
}

/**
 * Write strata/verify.js — the end-to-end proof of the feature we just delivered.
 *
 * Strata knows exactly which routes it emitted, on which entity, with which columns, so it can write
 * the test itself. The session runs ONE command and gets a checkable receipt instead of spending 23
 * turns re-deriving the same facts by hand (boot, curl, hammer, grep, taskkill, repeat).
 *
 * This is the piece that attacks the actual cost. Composition only ever removed the 2 turns of
 * writing; verification is 41% of the job.
 */
function buildVerifier(
  recalls: RecallEntry[],
  entity: Entity | null,
  strataDir: string,
  startCommand: string,
  /** What the task actually asked for — the verifier must test what SHIPPED, not what was available. */
  taskText: string,
): boolean {
  const has = (id: string): boolean => recalls.some(r => r.id === id);

  // A recall being SELECTED does not mean all of its capabilities were EMITTED. cache.ratelimit.v1
  // ships a cache and a limiter behind separate `when` gates, so a task asking only for rate limiting
  // gets the limiter alone. The verifier used to key off the recall list and then assert on an
  // x-cache header that was never wired — a failing check against code we deliberately did not
  // generate. A verifier that fails for the wrong reason is as corrosive as one that falsely passes:
  // either way it stops meaning anything.
  const asked = (pattern: string): boolean => new RegExp(pattern, 'i').test(taskText);
  const wantsCache = has('cache.ratelimit.v1') && asked('\\bcach|\\bttl\\b|x-cache|memoiz|\\blru\\b');
  const wantsRateLimit = has('cache.ratelimit.v1') && asked('rate.?limit|ratelimit|throttl|token.?bucket|\\b429\\b|retry.?after');

  // No bail-out. This used to return false unless a route-shaped recall was delivered — which left a
  // library-shaped task (a resilient HTTP client, say) with NO verifier at all, and the session went
  // back to proving everything by hand. Every delivery gets one command; what that command does
  // depends on what was shipped.
  // The route the FEATURE will actually live at.
  //
  // Priority: the project's entity (brownfield) > a route the task NAMES > a generic fallback.
  //
  // That middle case is not a nicety. Greenfield emits `/items`, but the platform task says "a GET
  // /products list endpoint" — so the session renamed the routes to match the spec, our verifier kept
  // testing `/items`, and the session then had to REPAIR OUR VERIFIER before it could use it:
  //
  //     "The verify script hardcodes /items and /items/import — but I renamed the routes to
  //      /products per the task spec. I need to update the verify script to match."
  //
  // Hand-testing on that task went from 2.3 turns to 13.0. A verifier that tests URLs the feature does
  // not serve is worse than no verifier: it is a broken tool the model must fix before it can work.
  const namedRoute = routeNamedInTask(taskText);
  const route = entity ? routePath(entity) : (namedRoute ?? '/items');

  // Build a CSV whose GOOD row is valid and whose BAD row violates one real, derived constraint —
  // so the check proves the schema came from the project, not from a template.
  let csvHeader: string | null = null;
  let csvValid: string | null = null;
  let csvInvalid: string | null = null;
  let badField: string | null = null;

  // Greenfield: no entity resolved, so the emitted route carries the template's own generic schema
  // ({ name: string, required, minLength: 2 }). We WROTE that schema, so we can prove it — a task
  // with no project to read is not a task with nothing to check.
  if (has('data.csv-import.v1') && !entity) {
    csvHeader = 'name';
    csvValid = 'VerifyWidget';
    csvInvalid = 'X';          // violates minLength: 2
    badField = 'name';
  }

  if (has('data.csv-import.v1') && entity) {
    const cols = entity.fields.filter(f => !f.isId && !f.isGenerated);
    if (cols.length > 0) {
      csvHeader = cols.map(f => f.name).join(',');

      // The sample values MUST be genuinely valid, or the verifier lies.
      //
      // This function previously returned 'X' for an enum column — an invalid value — as its "valid"
      // row. That produced a FALSE PASS: the import check went green while the enum constraint was
      // being ignored entirely, and it took a benchmark session to catch it. A verifier that reports
      // green on broken code is the single most damaging bug this system can have, because everything
      // downstream is built on trusting it. Sample values are now drawn from the schema's real
      // members.
      const sample = (f: EntityField, ok: boolean): string => {
        if (f.isEnum && f.enumValues?.length) {
          return ok ? f.enumValues[0] : '__NOT_A_MEMBER__';
        }
        if (f.type === 'number') return ok ? '10' : '-1';           // min: 0 is derived from the column
        if (f.type === 'boolean') return 'true';
        if (f.type === 'date') return new Date().toISOString();
        return ok ? `verify-${f.name}` : '';                         // empty violates `required`
      };

      // Break exactly ONE column, and prefer an enum — that is the constraint we most recently got
      // wrong, so it is the one most worth proving on every delivery.
      const target =
        cols.find(f => f.isEnum && f.enumValues?.length)
        ?? cols.find(f => f.type === 'number')
        ?? cols.find(f => f.required && f.type === 'string');
      badField = target?.name ?? null;

      csvValid = cols.map(f => sample(f, true)).join(',');
      csvInvalid = cols.map(f => (f.name === badField ? sample(f, false) : sample(f, true))).join(',');
    }
  }

  // Two real sortable columns for the multi-field sort check. Prefer a LOW-cardinality primary (so
  // ties actually occur and the secondary key gets exercised) with a numeric/date secondary — that is
  // precisely the shape in which a silently-ignored secondary sort hides.
  let sortA: string | null = null;
  let sortB: string | null = null;
  if (entity && has('api.pagination.v1')) {
    const primary = entity.fields.find(f => f.isEnum) ?? entity.fields.find(f => f.type === 'boolean');
    const secondary = entity.fields.find(f => f.type === 'number' && !f.isId)
      ?? entity.fields.find(f => f.type === 'date');
    if (primary && secondary && primary.name !== secondary.name) {
      sortA = primary.name;
      sortB = secondary.name;
    }
  }

  // A filterable column plus a value we KNOW exists — an enum member is guaranteed to be in range.
  let filterField: string | null = null;
  let filterValue: string | null = null;
  if (entity && has('api.pagination.v1')) {
    const f = entity.fields.find(x => x.isEnum && x.enumValues?.length && filterableFields(entity).includes(x.name));
    if (f?.enumValues?.length) {
      filterField = f.name;
      filterValue = f.enumValues[0];
    }
  }

  const script = buildVerifierScript({
    startCommand,
    hasSelftest: fs.existsSync(path.join(strataDir, 'selftest.js')),
    envSlots: [...new Set(recalls.flatMap(r => r.envSlots ?? []))],
    listRoute: has('api.pagination.v1') ? route : null,
    // Only a project WITH a resolved entity has data to serve, so only there is an empty list a bug.
    expectRows: !!entity,
    importRoute: has('data.csv-import.v1') && csvHeader ? `${route}/import` : null,
    csvHeader,
    csvValidRow: csvValid,
    csvInvalidRow: csvInvalid,
    csvBadField: badField,
    hasLogging: has('observability.logging.v1'),
    hasRateLimit: wantsRateLimit,
    hasCache: wantsCache,
    hasValidation: has('validation.request.v1'),
    hasSearch: has('search.fulltext.v1'),
    hasStripeWebhook: has('payment.stripe-webhook.v1'),
    // The recall's compose fragment reads STRIPE_WEBHOOK_PATH with this default, so the verifier must
    // probe the same place or it would test a route that does not exist.
    webhookRoute: has('payment.stripe-webhook.v1') ? '/webhooks/stripe' : null,
    rateLimitBurst: 60,
    sortA,
    sortB,
    filterField,
    filterValue,
    // The schema's real unique key — Mongoose keys on _id, and a verifier that reads the wrong key
    // reports a phantom failure, which is as corrosive as a false pass.
    idField: entity?.fields.find(f => f.isId)?.name ?? "id",
    // Any recall that contributed routes means there IS an HTTP surface worth starting and checking.
    hasRoutes: recalls.some(r => r.compose?.server?.routesFile),
    // Checks the recalls declared for themselves. The entity is substituted into the code the same way
    // it is for fragments, so a check can say `{{ROUTE}}` and get the project's real route.
    recallChecks: recalls.flatMap(r =>
      (r.verifierChecks ?? []).map(c => ({
        name: c.name,
        code: substituteEntity(c.code, entity, null, null),
      })),
    ),
  });

  fs.mkdirSync(strataDir, { recursive: true });
  fs.writeFileSync(path.join(strataDir, 'verify.js'), script);
  return true;
}

/**
 * BROWNFIELD delivery — mount into the app that already exists.
 *
 * buildCompose generates a complete Express application. For an empty directory that is exactly
 * right. For a project that ALREADY has an entry point it is exactly wrong: the session receives a
 * second, competing server.js and pays turns to notice the collision, reconcile the two, and delete
 * ours. Over-generation is a tax, and this is the largest one available to us — we would be handing
 * a project a whole application it did not ask for.
 *
 * So here we emit a wiring MODULE that fits the app the project already has, and splice three calls
 * into its existing entry point. The project told us its conventions; we honour them.
 */
/**
 * Install the composed assembly as a local dependency the project can `require` by name.
 *
 * The point is provenance, not obfuscation: code in node_modules reads as a dependency, which a model
 * imports and does not audit. The exact same bytes at strata/lib.js read as project source, which it
 * does audit. We copy (never move) the assembly so strata/verify.js and the selftest — which import the
 * relative path — keep working unchanged.
 *
 * Returns the package name, or undefined if the project has no node_modules to install into (in which
 * case the caller falls back to source delivery rather than fabricating an un-resolvable import).
 */
function installAssemblyAsDependency(projectDir: string, assemblyPath: string): string | undefined {
  try {
    if (!fs.existsSync(assemblyPath)) return undefined;
    const pkgJson = JSON.stringify(
      { name: COMPOSED_DEP_NAME, version: '1.0.0', main: 'index.js', private: true }, null, 2) + '\n';

    // The canonical copy lives at strata/composed-pkg/ and is referenced as a `file:` dependency.
    // Without the package.json entry, the agent's `npm install` prunes an unlisted node_modules entry
    // as extraneous — the exact failure that silently removed express/pino earlier today — and the
    // import breaks. A file: dep is the one form npm both installs and refuses to prune.
    const srcDir = path.join(projectDir, 'strata', 'composed-pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.copyFileSync(assemblyPath, path.join(srcDir, 'index.js'));
    fs.writeFileSync(path.join(srcDir, 'package.json'), pkgJson);

    // Register the dependency. Only ADD the key; the later package.json merge preserves what it finds.
    // CREATE package.json when it is absent, rather than skipping the registration.
    //
    // "no package.json yet — the node_modules mirror below still resolves it" was wrong, and it
    // produced an app that could not start. On a greenfield project this function runs before anything
    // has written package.json, so the registration was silently skipped; a later writer then created
    // the file with only the recalls' own deps; and the `npm install` Strata runs to verify the
    // delivery pruned the unreferenced node_modules mirror as EXTRANEOUS. server.js then died on its
    // first require. The mirror cannot save it — being unreferenced is exactly what gets it deleted.
    const projPkgPath = path.join(projectDir, 'package.json');
    try {
      const proj = fs.existsSync(projPkgPath)
        ? JSON.parse(fs.readFileSync(projPkgPath, 'utf-8'))
        : { name: 'app', version: '1.0.0', private: true };
      proj.dependencies = proj.dependencies ?? {};
      // The skeleton's OWN hard requirements, declared here because the skeleton is ours.
      // templates/express-skeleton.js opens with `require('dotenv').config()` and
      // `require('express')` on every composition, so an app missing either cannot start no matter
      // what the recalls declare. Observed: with a package.json already on disk — the benchmark case
      // and every brownfield project — the composed app shipped with only `strata-composed` declared
      // and died on `Cannot find module 'dotenv'`.
      const required: Record<string, string> = {
        [COMPOSED_DEP_NAME]: 'file:./strata/composed-pkg',
        express: '^4.18.0',
        dotenv: '^16.0.0',
      };
      let changed = false;
      for (const [name, spec] of Object.entries(required)) {
        if (!proj.dependencies[name]) { proj.dependencies[name] = spec; changed = true; }
      }
      if (changed) fs.writeFileSync(projPkgPath, JSON.stringify(proj, null, 2) + '\n');
    } catch { /* unparseable package.json — the later merge is the remaining line of defence */ }

    // Mirror into node_modules so `require` resolves BEFORE the agent runs npm install — otherwise
    // verify.js (run early) cannot find it.
    const nmDir = path.join(projectDir, 'node_modules', COMPOSED_DEP_NAME);
    fs.mkdirSync(nmDir, { recursive: true });
    fs.copyFileSync(assemblyPath, path.join(nmDir, 'index.js'));
    fs.writeFileSync(path.join(nmDir, 'package.json'), pkgJson);

    return COMPOSED_DEP_NAME;
  } catch {
    return undefined;   // any failure → caller keeps source delivery, never a broken import
  }
}

function buildWiring(
  recalls: RecallEntry[],
  assemblyFilename: string,
  strataDir: string,
  projectDir: string,
  shape: ProjectShape,
  projectEnv: string[],
  entity: Entity | null,
  /** Full task + capability text — what the user ACTUALLY asked for. Gates optional fragments. */
  taskText: string,
): ScaffoldResult | null {
  const contributors = recalls.filter(r => r.compose?.server);
  if (contributors.length === 0) return null;
  if (recalls.some(r => r.scaffold?.serverRole && !r.compose?.server)) return null;

  const templatePath = path.join(__dirname, '..', '..', 'templates', 'express-wiring.js');
  if (!fs.existsSync(templatePath)) return null;

  fs.mkdirSync(strataDir, { recursive: true });
  const scaffoldDir = path.join(strataDir, 'scaffold');
  fs.mkdirSync(scaffoldDir, { recursive: true });

  const dataSource = entity ? resolveDataSource(projectDir, entity) : null;
  const namedRoute = routeNamedInTask(taskText);

  // ── The local/hub substitution split ────────────────────────────────────────
  // The hub composes but must NEVER see project specifics — no schema, no entity, no field names, no
  // values. So when composing for the hub every `{{PLACEHOLDER}}` survives untouched, and the CLIENT
  // fills them in from a schema that never left the machine.
  //
  // `subst` is the identity ONLY in deferred mode, so the existing local path stays byte-for-byte what
  // it was. Substitution is deliberately DETERMINISTIC CODE and never the model: a model asked to fill
  // placeholders will paraphrase, miss one, or invent a field, and the failure surfaces as a syntax
  // error in the user's server.js with nothing pointing back to the cause.
  const subst = (code: string): string =>
    COMPOSE_DEFERRED ? code : substituteEntity(code, entity, dataSource, namedRoute);

  // The wiring module lands beside the entry point, so its relative requires (to the assembly, and
  // to the project's own repository) resolve from the same place the entry point does.
  const wiringRel = path.posix.join(shape.sourceRoot || '.', 'strata-wiring.js');
  const wiringPath = path.join(projectDir, wiringRel);

  // Depth of the wiring module below the project root — the assembly lives at <root>/strata/.
  const depth = shape.sourceRoot ? shape.sourceRoot.split('/').filter(Boolean).length : 0;
  const up = depth > 0 ? '../'.repeat(depth) : './';
  // Default: the assembly is a source file the wiring imports by relative path — which means it is
  // source sitting in the project, and a capable model audits it (reads it, re-verifies it, sometimes
  // rewrites it). That audit is the entire cost overrun measured on 2026-07-22.
  //
  // With STRATA_DELIVER_AS_DEP the same assembly is installed as a local node_modules package and
  // imported by name. Identical code, different provenance: node_modules is not audited. This is the
  // A/B for the delivery-mode hypothesis.
  let importFrom = `${up}strata/${assemblyFilename}`;
  let depName: string | undefined;
  if (DELIVER_AS_DEP) {
    depName = installAssemblyAsDependency(projectDir, path.join(strataDir, assemblyFilename));
    if (depName) importFrom = depName;
  }

  const setupFrags = setupFragments(contributors, taskText);
  const mwFrags    = rankedFragments(contributors, x => x.middleware, taskText);
  const errFrags   = rankedFragments(contributors, x => x.errorHandlers, taskText);
  const imports    = neededImports(contributors, [...setupFrags, ...mwFrags, ...errFrags]);

  // Requires written for the ROOT (from resolveDataSource) must be rewritten relative to the wiring
  // module's actual location, or the module resolves nothing at runtime.
  const extraRequires: string[] = [];
  if (dataSource) {
    extraRequires.push(
      dataSource.requireLine.replace(/require\('\.\/(.+?)'\)/, (_m, p) => {
        const fromWiring = path.posix.relative(shape.sourceRoot || '.', p);
        return `require('${fromWiring.startsWith('.') ? fromWiring : './' + fromWiring}')`;
      }),
    );
  }

  // Setup comes from the GATED fragment list. Filtering on the old `setupFile` field silently produced
  // an empty setup block once the recalls moved to `setup: [...]` — the middleware then referenced a
  // `logger` and a `limiter` that were never declared, and the app died on boot. The verifier caught
  // it; a benchmark run would have burned six sessions discovering the same thing.
  const setup = setupFrags
    .map(({ recall, frag }) => subst(renderFragment(recall, frag, 'errorHandler')))
    .filter(Boolean)
    .join('\n\n');

  const beforePieces = rankedFragments(contributors, x => x.middleware, taskText)
    .map(({ recall, frag }) => ({ rank: frag.rank, code: subst(renderFragment(recall, frag, 'middleware')) }))
    .filter(p => p.code);

  // Only add a JSON body parser if the project does not already have one. Express short-circuits a
  // second express.json() on req._body so a duplicate is harmless at runtime — but it is still a line
  // of code the project did not ask for, sitting in a file the reviewer has to explain. Every piece
  // of unrequested output is a small tax; this one is trivially avoidable.
  let entrySrc = '';
  try { entrySrc = fs.readFileSync(path.join(projectDir, shape.entryFile), 'utf-8'); } catch { /* ignore */ }
  const projectHasOwnParser = /express\.json\s*\(/.test(entrySrc);
  if (!projectHasOwnParser) {
    beforePieces.push({ rank: BODY_PARSER_RANK, code: BASE_MIDDLEWARE });
  }
  beforePieces.sort((a, b) => a.rank - b.rank);

  // When the project parses bodies itself, that parser sits OUTSIDE these fragments entirely — a
  // fragment ranked above BODY_PARSER_RANK (needs req.body, e.g. idempotency-key fingerprinting)
  // cannot just be sorted into place in one function; it must physically execute after that external
  // line, which mountWiring splices in by hand. Split into two exported functions so it has something
  // to splice against. When Strata supplies its OWN parser instead (no external line exists), no split
  // is needed — everything stays in one function, and the internal rank sort already puts it in the
  // right order. Measured, real, twice: STRATA-BENCHMARK-FINDINGS.md, 2026-07-27 and 2026-07-30.
  const splitAtBodyParser = projectHasOwnParser && beforePieces.some(p => p.rank > BODY_PARSER_RANK);
  const beforeMw = (splitAtBodyParser ? beforePieces.filter(p => p.rank <= BODY_PARSER_RANK) : beforePieces)
    .map(p => indentBlock(p.code)).join('\n\n');
  const afterBodyParseMw = splitAtBodyParser
    ? beforePieces.filter(p => p.rank > BODY_PARSER_RANK).map(p => indentBlock(p.code)).join('\n\n')
    : '';

  const routes = contributors
    .filter(r => r.compose!.server!.routesFile)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(r => subst(readFragment(r, r.compose!.server!.routesFile!)))
    .filter(Boolean)
    .map(c => indentBlock(c))
    .join('\n\n');

  const afterMw = rankedFragments(contributors, x => x.errorHandlers, taskText)
    .map(({ recall, frag }) => subst(renderFragment(recall, frag, 'errorHandler')))
    .filter(Boolean)
    .map(c => indentBlock(c))
    .join('\n\n');

  const wiring = fs.readFileSync(templatePath, 'utf-8')
    .replace('{{IMPORTS}}', imports.map(n => `  ${n},`).join('\n'))
    .replace('{{IMPORT_FROM}}', importFrom)
    .replace('{{EXTRA_REQUIRES}}', extraRequires.length ? extraRequires.join('\n') + '\n' : '')
    .replace('{{SETUP}}', setup ? '\n' + setup + '\n' : '')
    .replace('{{BEFORE_MW}}', beforeMw)
    .replace('{{AFTER_BODY_PARSE_MW}}', afterBodyParseMw)
    .replace('{{ROUTES}}', routes)
    .replace('{{AFTER_MW}}', afterMw)
    .replace('{{EXTRA_EXPORTS}}', setup.includes('const logger') ? ', logger' : '');

  fs.mkdirSync(path.dirname(wiringPath), { recursive: true });
  fs.writeFileSync(wiringPath, wiring);

  const files: ScaffoldFile[] = [
    { name: wiringRel, injectSlots: extractInjectSlots(wiring), writtenToRoot: true },
  ];

  // Splice the three mount calls into the project's own entry point — but only when the anchors are
  // unambiguous. Silently corrupting a user's entry file is a far worse outcome than asking the
  // model to add three lines itself, so an ambiguous file is left completely alone.
  let mounted = false;
  if (shape.mountable) {
    const entryPath = path.join(projectDir, shape.entryFile);
    try {
      const src = fs.readFileSync(entryPath, 'utf-8');
      const requirePath = './' + path.posix.relative(shape.sourceRoot || '.', wiringRel).replace(/\.js$/, '');
      const patched = mountWiring(src, requirePath, appVarName(projectDir, shape));
      if (patched) {
        fs.writeFileSync(entryPath, patched);
        mounted = true;
        files.push({ name: shape.entryFile, injectSlots: [], writtenToRoot: true, modified: true });
      }
    } catch { /* leave the entry point untouched */ }
  }

  // Merge our dependencies into the project's OWN package.json rather than overwriting it — the
  // project's scripts, name and existing deps are none of our business.
  const needed: Record<string, string> = {};
  for (const r of recalls) Object.assign(needed, r.scaffold?.npmPackages ?? {}, r.compose?.npmPackages ?? {});

  /**
   * The composed package must be declared HERE, not only where it is built.
   *
   * installComposedPackage() registers `strata-composed` as a `file:` dependency itself — but it runs
   * before this function has written package.json, so on a greenfield project that registration hits a
   * file that does not exist yet and its catch swallows the failure. The node_modules mirror it leaves
   * behind is then unreferenced, and the `npm install` Strata runs to verify the delivery prunes it as
   * EXTRANEOUS. The result is an app whose very first line requires a package that is no longer there:
   *
   *     Error: Cannot find module 'strata-composed'
   *
   * Delivered code that cannot start is the worst failure this system has, because every downstream
   * signal — verify.js, the benchmark's quality grade, the user's first impression — reads as "the
   * generated code is broken" and none of them points here. Declaring it wherever the composed package
   * exists on disk makes the ordering irrelevant, which is the only version of this that stays fixed.
   */
  if (fs.existsSync(path.join(projectDir, 'strata', 'composed-pkg'))) {
    needed[COMPOSED_DEP_NAME] = 'file:./strata/composed-pkg';
  }

  const pkgPath = path.join(projectDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.dependencies = pkg.dependencies ?? {};
    let added = false;
    for (const [name, version] of Object.entries(needed)) {
      if (!pkg.dependencies[name]) { pkg.dependencies[name] = version; added = true; }
    }
    if (added) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      // MODIFIED, not created — we merged deps into a file the project already had. Reporting this as
      // "created" is a small lie in exactly the place we are asking to be believed.
      files.push({ name: 'package.json', injectSlots: [], writtenToRoot: true, modified: true });
    }
  } catch { /* no package.json — nothing to merge into */ }

  const known = new Set(projectEnv);
  const missingEnv = [...new Set(recalls.flatMap(r => r.envSlots ?? []))].filter(v => !known.has(v));
  if (missingEnv.length > 0) {
    fs.writeFileSync(path.join(scaffoldDir, '.env.additions'), missingEnv.map(v => `${v}=`).join('\n') + '\n');
    files.push({ name: 'strata/scaffold/.env.additions', injectSlots: [], writtenToRoot: false });
  }

  // Guide-driven persistence adapters (STRATA-GUIDE.md). When a trustworthy strata.guide.json exists,
  // the data-layer bridge the model would hand-write is emitted here instead — the brownfield fix.
  const guide = emitGuideAdapters(recalls, projectDir);
  files.push(...guide.files);

  buildSelftest(recalls, assemblyFilename, strataDir);
  const verified = buildVerifier(recalls, entity, strataDir, `node ${shape.entryFile}`, taskText);
  if (verified) files.push({ name: 'strata/verify.js', injectSlots: [], writtenToRoot: false });

  console.error(`[strata] brownfield: wiring at ${wiringRel}, mounted=${mounted}, verifier=${verified}, guideAdapters=${guide.adapters.length}`);
  return { files, scaffoldDir, projectDir, entryFile: mounted ? shape.entryFile : undefined, depName,
    guideAdapters: guide.adapters.length ? guide.adapters : undefined, guideDataLayerNote: guide.dataLayerNote || undefined };
}

function buildCompose(
  recalls: RecallEntry[],
  assemblyFilename: string,
  strataDir: string,
  projectDir: string,
  /** Env vars the project ALREADY defines — from the deterministic scan. */
  projectEnv: string[] = [],
  /** The entity this task is about, read from the project schema. null = greenfield. */
  entity: Entity | null = null,
  /** Full task + capability text — what the user ACTUALLY asked for. Gates optional fragments. */
  taskText: string = '',
): ScaffoldResult | null {
  const contributors = recalls.filter(r => r.compose?.server);
  if (contributors.length === 0) return null;

  // A recall that still owns a whole legacy scaffold-server.js cannot contribute to a composed app —
  // it wants to BE the app. If the selection mixes the two (e.g. auth.rbac.express.v1 alongside
  // observability.logging.v1), composing would silently drop the legacy one, which is precisely the
  // winner-take-all bug this function exists to kill. Hand the whole selection back to buildScaffold
  // instead: no worse than today, and nothing disappears.
  const legacyServerOwner = recalls.some(r => r.scaffold?.serverRole && !r.compose?.server);
  if (legacyServerOwner) return null;

  // The project's OWN data layer, if it has one we can identify with confidence.
  const dataSource = entity ? resolveDataSource(projectDir, entity) : null;
  const namedRoute = routeNamedInTask(taskText);

  // Deferred for the hub: it composes blind, so every {{PLACEHOLDER}} must survive untouched and the
  // CLIENT resolves it from a schema that never left the machine. Identity only in deferred mode, so
  // the local path is exactly what it was.
  const subst = (code: string): string =>
    COMPOSE_DEFERRED ? code : substituteEntity(code, entity, dataSource, namedRoute);

  const skeletonPath = path.join(__dirname, '..', '..', 'templates', 'express-skeleton.js');
  if (!fs.existsSync(skeletonPath)) return null;

  fs.mkdirSync(strataDir, { recursive: true });
  const scaffoldDir = path.join(strataDir, 'scaffold');
  fs.mkdirSync(scaffoldDir, { recursive: true });

  // --- imports: the union of every contributor's needs, deduped and stable-sorted ---
  const setupFrags = setupFragments(contributors, taskText);
  const mwFrags    = rankedFragments(contributors, x => x.middleware, taskText);
  const errFrags   = rankedFragments(contributors, x => x.errorHandlers, taskText);
  const afterFrags = rankedFragments(contributors, x => x.afterListen, taskText);
  const imports    = neededImports(contributors, [...setupFrags, ...mwFrags, ...errFrags, ...afterFrags]);
  const extraRequires = [...new Set(contributors.flatMap(r => r.compose!.server!.extraRequires ?? []))];
  if (dataSource) extraRequires.push(dataSource.requireLine);

  // --- setup: from the GATED fragment list, ranked so the logger is constructed before anything
  //     whose middleware runs after it.
  //
  // This filtered on the old `setupFile` field. Once the recalls moved to `setup: [...]`, the filter
  // matched nothing, the setup block came out EMPTY, and the middleware below referenced a `logger`
  // that was never declared — the app died on boot with "logger is not defined". Both compose paths
  // had their own copy of this code, so fixing one left the other broken. The verifier caught both.
  const setup = setupFrags
    .map(({ recall, frag }) => subst(renderFragment(recall, frag, 'errorHandler')))
    .filter(Boolean)
    .join('\n\n');

  // --- middleware: ranked across ALL recalls, with the base body parser folded in ---
  const middlewarePieces = mwFrags
    .map(({ recall, frag }) => ({ rank: frag.rank, code: subst(renderFragment(recall, frag, 'middleware')) }))
    .filter(p => p.code);
  middlewarePieces.push({ rank: BODY_PARSER_RANK, code: BASE_MIDDLEWARE });
  const middleware = middlewarePieces
    .sort((a, b) => a.rank - b.rank)
    .map(p => p.code)
    .join('\n\n');

  const routes = contributors
    .filter(r => r.compose!.server!.routesFile)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(r => subst(readFragment(r, r.compose!.server!.routesFile!)))
    .filter(Boolean)
    .join('\n\n');

  const errorHandlers = rankedFragments(contributors, x => x.errorHandlers, taskText)
    .map(({ recall, frag }) => subst(renderFragment(recall, frag, 'errorHandler')))
    .filter(Boolean)
    .join('\n\n');

  // afterListen runs with the http.Server in scope. Rendered as bare calls (kind 'setup'), it lands
  // below `const server = app.listen(...)`.
  const afterListen = afterFrags
    .map(({ recall, frag }) => subst(renderFragment(recall, frag, 'setup')))
    .filter(Boolean)
    .join('\n\n');

  // Only capture the server handle when something actually needs it — an unused `const server` in
  // every generated app is a small tax on every project that never asked for shutdown wiring.
  const listen = afterListen
    ? 'const server = app.listen(port, () => console.log(`Server listening on port ${port}`));\n\n' + afterListen + '\n'
    : 'app.listen(port, () => console.log(`Server listening on port ${port}`));';

  // Drop the skeleton's throwaway /health when a recall contributes a real one.
  const providesHealth = contributors.some(c => c.compose!.server!.providesHealth);
  const healthStub = providesHealth ? '' : "app.get('/health', (_req, res) => res.json({ ok: true }));\n";

  // Same delivery-mode choice as the brownfield path: import the composed code as a dependency, not
  // as project source, so the model does not audit it.
  let gfImportFrom = `./strata/${assemblyFilename}`;
  let gfDepName: string | undefined;
  if (DELIVER_AS_DEP) {
    gfDepName = installAssemblyAsDependency(projectDir, path.join(strataDir, assemblyFilename));
    if (gfDepName) gfImportFrom = gfDepName;
  }

  const server = fs.readFileSync(skeletonPath, 'utf-8')
    .replace('{{IMPORTS}}', imports.map(n => `  ${n},`).join('\n'))
    .replace('{{IMPORT_FROM}}', gfImportFrom)
    .replace('{{EXTRA_REQUIRES}}', extraRequires.length ? extraRequires.join('\n') + '\n' : '')
    .replace('{{SETUP}}', setup ? '\n' + setup + '\n' : '')
    .replace('{{MIDDLEWARE}}', middleware ? middleware + '\n' : '')
    .replace('{{ROUTES}}', routes ? '\n' + routes + '\n' : '')
    .replace('{{HEALTH}}', healthStub)
    .replace('{{ERROR_HANDLERS}}', errorHandlers ? errorHandlers + '\n' : '')
    .replace('{{LISTEN}}', listen);

  const files: ScaffoldFile[] = [];
  const writtenToRoot = placeScaffoldFile('server.js', server, projectDir, scaffoldDir);
  files.push({ name: 'server.js', injectSlots: extractInjectSlots(server), writtenToRoot });

  // --- package.json: union of every contributor's deps (compose block wins, scaffold as fallback) ---
  const allPackages: Record<string, string> = {};
  for (const r of recalls) {
    Object.assign(allPackages, r.scaffold?.npmPackages ?? {}, r.compose?.npmPackages ?? {});
  }
  if (Object.keys(allPackages).length > 0) {
    /**
     * MERGE when package.json already exists. placeScaffoldFile never overwrites, so on its own it
     * stages the real dependencies into strata/scaffold/package.json and leaves the ROOT bare.
     *
     * This is the same defect that was fixed for the scaffold path (see the 2026-07-28 note below) and
     * never fixed here. It is not an edge case: agent-bench writes a package.json before strata_use is
     * called, and every brownfield project has one by definition — so the composed path shipped apps
     * whose declared dependencies were missing the recalls' own packages. The delivered server died on
     * `Cannot find module 'pino'`, which reads as "Strata generated broken code" and points nowhere
     * near this line.
     */
    const pkgRootPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgRootPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(pkgRootPath, 'utf-8'));
        existing.dependencies = existing.dependencies ?? {};
        let added = false;
        for (const [name, version] of Object.entries(allPackages)) {
          if (!existing.dependencies[name]) { existing.dependencies[name] = version; added = true; }
        }
        if (added) fs.writeFileSync(pkgRootPath, JSON.stringify(existing, null, 2) + '\n');
        files.push({ name: 'package.json', injectSlots: [], writtenToRoot: true, modified: true });
      } catch {
        // Unparseable — stage rather than risk corrupting a file we cannot read.
        const staged = JSON.stringify({ dependencies: allPackages }, null, 2);
        placeScaffoldFile('package.json', staged, projectDir, scaffoldDir);
        files.push({ name: 'package.json', injectSlots: [], writtenToRoot: false });
      }
    } else {
      const pkgJson = JSON.stringify({
        name: 'app', version: '1.0.0', type: 'commonjs',
        scripts: { start: 'node server.js', test: 'node strata/selftest.js' },
        dependencies: allPackages,
      }, null, 2);
      const rooted = placeScaffoldFile('package.json', pkgJson, projectDir, scaffoldDir);
      files.push({ name: 'package.json', injectSlots: [], writtenToRoot: rooted });
    }
  }

  // Only list env vars the project does NOT already define. Re-declaring SMTP_HOST when the project's
  // .env already has it is noise the session pays a turn to reconcile — and noise is not free.
  const known = new Set(projectEnv);
  const missingEnv = [...new Set(recalls.flatMap(r => r.envSlots ?? []))].filter(v => !known.has(v));
  if (missingEnv.length > 0) {
    const envContent = missingEnv.map(v => `${v}=`).join('\n') + '\n';
    const rooted = placeScaffoldFile('.env.example', envContent, projectDir, scaffoldDir);
    files.push({ name: '.env.example', injectSlots: [], writtenToRoot: rooted });
  }

  buildSelftest(recalls, assemblyFilename, strataDir);
  if (buildVerifier(recalls, entity, strataDir, 'node server.js', taskText)) {
    files.push({ name: 'strata/verify.js', injectSlots: [], writtenToRoot: false });
  }

  const gfGuide = emitGuideAdapters(recalls, projectDir);
  files.push(...gfGuide.files);

  return { files, scaffoldDir, projectDir, depName: gfDepName,
    guideAdapters: gfGuide.adapters.length ? gfGuide.adapters : undefined, guideDataLayerNote: gfGuide.dataLayerNote || undefined };
}

function buildScaffold(
  recalls: RecallEntry[],
  assemblyFilename: string,
  strataDir: string,
  projectDir: string,
  pkg: PackageShape | null,
): ScaffoldResult | null {
  const primaryServer = recalls.find(r => r.scaffold?.serverRole === 'primary');
  if (!primaryServer) return null;

  // Where the scaffold's imports come from: a package name (V3) or the local assembly (legacy).
  const importFrom = pkg ? pkg.name : `./strata/${assemblyFilename}`;

  const scaffoldDir = path.join(strataDir, 'scaffold');
  fs.mkdirSync(scaffoldDir, { recursive: true });

  const secondaryServer = recalls.filter(r => r.scaffold?.serverRole === 'setup');
  const secondaryWorker = recalls.filter(r => r.scaffold?.workerRole === 'setup');
  const primaryWorker = recalls.find(r => r.scaffold?.workerRole === 'primary');

  const files: ScaffoldFile[] = [];

  // --- server.js ---
  const serverTemplatePath = path.join(primaryServer.physicalPath, 'scaffold-server.js');
  if (fs.existsSync(serverTemplatePath)) {
    let tpl = fs.readFileSync(serverTemplatePath, 'utf-8');
    const secImports = secondaryServer.flatMap(r => r.scaffold?.serverImports ?? []);
    const secSetup = secondaryServer
      .map(r => {
        const snip = path.join(r.physicalPath, 'scaffold-setup.snippet.js');
        return fs.existsSync(snip) ? fs.readFileSync(snip, 'utf-8').trim() : '';
      })
      .filter(Boolean)
      .join('\n\n');
    tpl = tpl
      .replace('{{IMPORT_FROM}}', importFrom)
      .replace('{{SECONDARY_IMPORTS}}', secImports.map(n => `  ${n},`).join('\n'))
      .replace('{{SECONDARY_SETUP}}', secSetup);
    const writtenToRoot = placeScaffoldFile('server.js', tpl, projectDir, scaffoldDir);
    files.push({ name: 'server.js', injectSlots: extractInjectSlots(tpl), writtenToRoot });
  }

  // --- worker.js ---
  if (primaryWorker) {
    const workerTemplatePath = path.join(primaryWorker.physicalPath, 'scaffold-worker.js');
    if (fs.existsSync(workerTemplatePath)) {
      let tpl = fs.readFileSync(workerTemplatePath, 'utf-8');
      const secImports = secondaryWorker.flatMap(r => r.scaffold?.workerImports ?? []);
      const secSetup = secondaryWorker
        .map(r => {
          const snip = path.join(r.physicalPath, 'scaffold-setup.snippet.js');
          return fs.existsSync(snip) ? fs.readFileSync(snip, 'utf-8').trim() : '';
        })
        .filter(Boolean)
        .join('\n\n');
      tpl = tpl
        .replace('{{IMPORT_FROM}}', importFrom)
        .replace('{{SECONDARY_IMPORTS}}', secImports.map(n => `  ${n},`).join('\n'))
        .replace('{{SECONDARY_SETUP}}', secSetup);
      const writtenToRoot = placeScaffoldFile('worker.js', tpl, projectDir, scaffoldDir);
      files.push({ name: 'worker.js', injectSlots: extractInjectSlots(tpl), writtenToRoot });
    }
  }

  // --- package.json ---
  const allPackages: Record<string, string> = {};
  for (const r of recalls) {
    if (r.scaffold?.npmPackages) Object.assign(allPackages, r.scaffold.npmPackages);
  }
  // V3: the kit itself becomes an ordinary dependency. Its own transitive deps (stripe, nodemailer,
  // bullmq, pdfkit) come from ITS package.json, so we don't re-declare them here — the project just
  // depends on the kit, exactly like it would depend on any library.
  if (pkg) {
    allPackages[pkg.name] = packageSpec(pkg);
  }
  if (Object.keys(allPackages).length > 0) {
    const pkgRootPath = path.join(projectDir, 'package.json');
    const preExisting = fs.existsSync(pkgRootPath);
    if (preExisting) {
      // 2026-07-28: this used to fall through to placeScaffoldFile below, which NEVER overwrites an
      // existing file — it staged the real dependencies into strata/scaffold/package.json instead and
      // left the root bare, counting on the model to notice and merge them by hand. Every greenfield
      // benchmark task starts with a bare package.json already on disk (agent-bench.js's prepareDir
      // writes one before strata_use is ever called), so this was the NORMAL case all along, not an
      // edge case — and it is what broke the new auto-run verification (npm install ran against an
      // empty dependency list and reported the delivered code as broken, when it never was). Fixed by
      // MERGING in place, mirroring buildWiring's brownfield merge (src/mcp-server.ts, "Merge our
      // dependencies into the project's OWN package.json rather than overwriting it") — only touch
      // `dependencies`; the project's own name/scripts/version are none of our business.
      try {
        const pkgJsonExisting = JSON.parse(fs.readFileSync(pkgRootPath, 'utf-8'));
        pkgJsonExisting.dependencies = pkgJsonExisting.dependencies ?? {};
        let added = false;
        for (const [name, version] of Object.entries(allPackages)) {
          if (!pkgJsonExisting.dependencies[name]) { pkgJsonExisting.dependencies[name] = version; added = true; }
        }
        if (added) {
          fs.writeFileSync(pkgRootPath, JSON.stringify(pkgJsonExisting, null, 2) + '\n');
          files.push({ name: 'package.json', injectSlots: [], writtenToRoot: true, modified: true });
        }
      } catch {
        // Existing package.json isn't valid JSON — fall back to the old stage-don't-clobber behaviour
        // rather than risk corrupting a file we can't safely parse.
        const hasWorker = files.some(f => f.name === 'worker.js');
        const scripts: Record<string, string> = { start: 'node server.js' };
        if (hasWorker) scripts.worker = 'node worker.js';
        const pkgJson = JSON.stringify({ name: 'app', version: '1.0.0', type: 'commonjs', scripts, dependencies: allPackages }, null, 2);
        const writtenToRoot = placeScaffoldFile('package.json', pkgJson, projectDir, scaffoldDir);
        files.push({ name: 'package.json', injectSlots: [], writtenToRoot });
      }
    } else {
      // Only advertise a worker script when a worker.js was actually generated. Hardcoding it
      // shipped a phantom "worker": "node worker.js" into every scaffold — 4 of the 5 shapes have
      // no worker, so sessions paid a turn to notice and delete the dangling script, then trusted
      // the rest of the delivery less. Now the scripts block matches the files on disk.
      const hasWorker = files.some(f => f.name === 'worker.js');
      const scripts: Record<string, string> = { start: 'node server.js' };
      if (hasWorker) scripts.worker = 'node worker.js';
      const pkgJson = JSON.stringify({
        name: 'app', version: '1.0.0', type: 'commonjs',
        scripts,
        dependencies: allPackages,
      }, null, 2);
      const writtenToRoot = placeScaffoldFile('package.json', pkgJson, projectDir, scaffoldDir);
      files.push({ name: 'package.json', injectSlots: [], writtenToRoot });
    }
  }

  // --- .env.example ---
  const allEnvSlots = [...new Set(recalls.flatMap(r => r.envSlots ?? []))];
  if (allEnvSlots.length > 0) {
    const envContent = allEnvSlots.map(v => `${v}=`).join('\n') + '\n';
    const writtenToRoot = placeScaffoldFile('.env.example', envContent, projectDir, scaffoldDir);
    files.push({ name: '.env.example', injectSlots: [], writtenToRoot });
  }

  // --- strata/selftest.js -------------------------------------------------------------------
  // The single most cost-effective thing in the delivery. Verification via `node strata/selftest.js`
  // costs ONE turn and ~100 tokens of output. Verification via reading + auditing the assembly costs
  // ~10k tokens pinned in context and re-read on EVERY remaining turn (cache-read = context x turns,
  // which the jwt benchmark showed is 3.3x the cost of the output Strata is supposed to save).
  // Same tests that gate the recall in CI, shipped to the project — so "it's verified" is a receipt,
  // not a request for trust.
  // In package mode there is no assembly to test and the kit ships its own test suite — writing a
  // selftest here would just point at a file that doesn't exist.
  if (!pkg) buildSelftest(recalls, assemblyFilename, strataDir);

  const sfGuide = emitGuideAdapters(recalls, projectDir);
  files.push(...sfGuide.files);

  return { files, scaffoldDir, projectDir,
    guideAdapters: sfGuide.adapters.length ? sfGuide.adapters : undefined, guideDataLayerNote: sfGuide.dataLayerNote || undefined };
}

function buildSelftest(recalls: RecallEntry[], assemblyFilename: string, strataDir: string): void {
  const suites: string[] = [];
  const testsDir = path.join(strataDir, 'tests');
  let any = false;
  for (const r of recalls) {
    const src = path.join(r.physicalPath, 'selftest.js');
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(testsDir, { recursive: true });
    const destName = `${r.id.replace(/[^\w.-]/g, '_')}.js`;
    fs.copyFileSync(src, path.join(testsDir, destName));
    suites.push(`  require('./tests/${destName}'),`);
    any = true;
  }
  if (!any) return;

  const runner = `'use strict';
// Strata selftest — the SAME behavioural tests that gated these recalls into the library, re-run
// against the code actually delivered here. These are the adversarial cases each recall had to
// survive to be admitted: forged/tampered inputs, replays, malformed payloads, boundary values.
// Run it with:  npm install && node strata/selftest.js   — each line below is one such case.
let lib;
try {
  lib = require('./${assemblyFilename}');
} catch (e) {
  if (e && e.code === 'MODULE_NOT_FOUND') {
    console.log('Dependencies are not installed yet. Run \\'npm install\\' first, then re-run this.');
    console.log('(missing: ' + (e.message.match(/'([^']+)'/) || [,'?'])[1] + ')');
    process.exit(2);
  }
  throw e;
}

const suites = [
${suites.join('\n')}
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  let pass = 0, fail = 0;
  for (const s of suites) {
    try {
      await s.run(lib, assert);
      console.log('PASS  ' + s.id);
      pass++;
    } catch (e) {
      console.log('FAIL  ' + s.id + '  ->  ' + (e && e.message ? e.message : e));
      fail++;
    }
  }
  console.log('\\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
`;
  fs.writeFileSync(path.join(strataDir, 'selftest.js'), runner, 'utf-8');
}

// ─── Auto-run verification (2026-07-28) ────────────────────────────────────────
//
// Every delivery already tells the model to run `npm install && node strata/verify.js` (or
// `selftest.js`) itself — but that costs it real turns: decide to run it, run it, read the output,
// decide what it means. cost ≈ context × turns does not charge anything for WALL-CLOCK time, only for
// what sits in the model's context across turns. So run the check HERE, in the engine, before the model
// ever sees a byte, and deliver the PASS/FAIL report as a stated fact in the same tool result. This does
// not remove the model's ability to distrust it and re-run/re-read for itself (nothing here says "don't
// verify this yourself") — it just means the first, cheapest pass is no longer something the model has
// to spend a turn discovering it should do.
//
// Bounded and best-effort: if npm install or the check itself fails or times out, that failure is
// reported as fact too (never swallowed) — a session that finds a supply-chain-flavoured "trust me,
// don't check" claim here would rightly distrust everything else in the delivery (this has burned the
// project twice before over softer language than that).
const VERIFY_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;

function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // exec (not execFile) runs through the OS shell — on Windows that resolves npm.cmd/node.exe the
    // same way a user's own terminal would, without re-deriving the .cmd-shim handling agent-bench.js's
    // sh() already solved for the synchronous benchmark case (CVE-2024-27980 — Node won't spawn a .cmd
    // directly). Async here because this runs inside the live MCP server process, not a throwaway
    // benchmark script — a blocking spawnSync would freeze the server for any other request.
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = (stdout + stderr).slice(0, 8000);
      // exec's own callback error type (ExecException) already carries killed/signal — no cast needed.
      const timedOut = !!error && error.killed === true && error.signal === 'SIGTERM';
      resolve({ ok: !error, output, timedOut });
    });
  });
}

/**
 * Run whichever proof the delivery actually generated — `verify.js` if present (the stronger,
 * end-to-end check), else `selftest.js` (the lighter behavioural-only check) — and return a short report
 * block to fold into the delivery text. Returns '' when neither exists (nothing to auto-run).
 */
async function autoRunVerification(strataDir: string, projectDir: string): Promise<string> {
  const hasVerify = fs.existsSync(path.join(strataDir, 'verify.js'));
  const hasSelftest = fs.existsSync(path.join(strataDir, 'selftest.js'));
  if (!hasVerify && !hasSelftest) return '';

  const install = await runShell('npm install', projectDir, INSTALL_TIMEOUT_MS);
  if (!install.ok) {
    return `\n=== AUTO-VERIFICATION (run by the engine, not you) ===\n`
      + `\`npm install\` failed before verification could run — this is a fact, not a guess; the raw `
      + `output is below. You'll need to resolve this before the delivered code can be exercised.\n`
      + `${install.output || '(no output captured)'}\n`;
  }

  const script = hasVerify ? 'strata/verify.js' : 'strata/selftest.js';
  const check = await runShell(`node ${script}`, projectDir, VERIFY_TIMEOUT_MS);
  const label = hasVerify
    ? 'runs the recalls\' unit tests, then starts the app and exercises each requirement against it'
    : 'the same adversarial tests each recall had to pass to enter the library, re-run against the code delivered here';

  return `\n=== AUTO-VERIFICATION — already run by the engine, not you (${script}) ===\n`
    + `This ${label}. Output below is real, from an actual run just now — not a claim, something you can `
    + `re-run yourself with \`node ${script}\` if you want to see it happen live.\n`
    + `${check.timedOut ? `(timed out after ${VERIFY_TIMEOUT_MS / 1000}s — partial output below)\n` : ''}`
    + `${check.output || '(no output captured)'}\n`;
}

// ─── Signature + system prompt ────────────────────────────────────────────────

function buildSignatureBlock(recall: DeliveredRecall): string {
  const lines = [
    `require('./strata/${recall.filename}')`,
    `// ${recall.name} — ${recall.description}`,
  ];
  if (recall.inputs?.length || recall.outputs?.length) {
    const ins = recall.inputs?.join(', ') || '—';
    const outs = recall.outputs?.join(', ') || '—';
    lines.push(`// inputs: ${ins} → outputs: ${outs}`);
  }
  if (recall.callExample) {
    lines.push(`// example: ${recall.callExample}`);
  } else if (recall.useCases?.length) {
    lines.push(`// use case: ${recall.useCases[0]}`);
  }
  return lines.join('\n');
}

function buildInjectedSystem(
  recall: DeliveredRecall | null,
  guideAdapters: NonNullable<ScaffoldResult['guideAdapters']> = [],
  dataLayerNote = '',
): string {
  if (!recall) {
    return `You are a senior software engineer. Write clean, production-ready JavaScript/Node.js code with proper error handling. Respond with code only. No explanations, no prose. Notes go in inline comments.`;
  }

  // Data-layer reality (from strata.guide.json) FIRST — this is the line that stops the model
  // reconciling against a data layer that isn't there. Then the generated adapters. Both are facts, not
  // "trust me" (STRATA-GUIDE.md).
  const noteLine = dataLayerNote ? `\nDATA LAYER (from strata.guide.json): ${dataLayerNote}\n` : '';
  const guideBlock = (noteLine ? noteLine : '') + (guideAdapters.length
    ? `\nGENERATED FROM strata.guide.json — store adapters bound to your real data layer. Import each and\npass it where the recall takes its store, in place of the default in-memory one:\n${guideAdapters.map(a => `  ${a.rel} — ${a.factory}()  |  ${a.inject}`).join('\n')}\n`
    : '');

  if (recall.isComposite) {
    const exports = recall.outputs?.length ? recall.outputs.join(', ') : '(see file)';
    const exampleSection = recall.callExamples?.length
      ? `\nUsage (copy and adapt — do NOT reimplement these):\n${recall.callExamples.slice(0, 2).join('\n\n')}\n`
      : '';
    return `You are a senior software engineer.

The following assembly file has been written to ./strata/${recall.filename}:

  require('./strata/${recall.filename}')

${recall.description}

Callable exports: ${exports}
${exampleSection}${guideBlock}
This file was assembled from this project's local recall library — a mix of hand-crafted,
benchmark-tested modules and a much larger set of auto-generated ones of uneven quality. It's
a real file on disk, not a black box; read it back if you want to verify before using it.

SUGGESTED APPROACH (use your judgment on the stakes of the task):
- The file is on disk at ./strata/${recall.filename} — import it directly for routes/config/wiring.
- For anything touching money, auth, secrets, or signature/crypto verification: reading the
  delivered code back and checking it before relying on it is the right call, not overhead.
- For lower-stakes glue, importing and building on it directly is fine.
- Prefer using what's delivered over reimplementing it — but if verification turns up something
  wrong, fix it in your glue rather than trusting it blindly.
- Respond with code only. No explanations, no prose. Notes go in a single inline comment.`;
  }

  return `You are a senior software engineer.

The following file has been written to ./strata/ in this project:

${buildSignatureBlock(recall)}
${guideBlock}
This file came from this project's local recall library — a mix of hand-crafted, benchmark-tested
modules and a much larger set of auto-generated ones of uneven quality. It's a real file on disk
at ./strata/${recall.filename}, not a black box; read it back if you want to verify before using it.

SUGGESTED APPROACH (use your judgment on the stakes of the task):
- Import it directly for routes/config/wiring that connects this module to your app.
- For anything touching money, auth, secrets, or signature/crypto verification: reading the
  delivered code back and checking it before relying on it is the right call, not overhead.
- For lower-stakes glue, importing and building on it directly is fine.
- If the recall exports primitive functions (not a factory or class), use them directly — don't
  wrap them in a class or service object unless you have a real reason to. The recall IS the module.
- Prefer using what's delivered over reimplementing it — but if verification turns up something
  wrong, fix it in your glue rather than trusting it blindly.
- Respond with code only. No explanations, no prose. Notes go in a single inline comment, not paragraphs.`;
}

// ─── The context-economy rule (the single most important thing in this file) ───
//
// MEASURED, jwt benchmark, sonnet-5:
//   baseline: output 10k = $0.156 | cache-read  983k = $0.295
//   strata:   output 10k = $0.156 | cache-read 1702k = $0.511   <-- 3.3x the output cost
//
// Strata reduced output by EXACTLY ZERO and added +719k cache-read. The entire cost penalty is
// cache-read, which is `context_size x turns` — because context is re-read on EVERY turn while
// output is paid ONCE. So pushing code INTO the context to save output is a losing trade by ~20x.
//
// The winning move: code on disk that is IMPORTED BUT NEVER READ costs ZERO context tokens.
// `require('./strata/x.js')` is ~10 tokens; the 500 lines inside cost nothing — as long as they
// never enter the conversation. We were destroying this by (a) inlining recall source into this
// prompt, and (b) inviting the model to Read + audit the assembly, which pins it in context for
// every remaining turn.
//
// So this prompt must: give TERSE signatures (not source), keep the code on disk, and make
// verification a single `node strata/selftest.js` command (~100 tokens of output) instead of a
// read-and-audit (~10k tokens x every subsequent turn). Never re-inline source here.

function buildScaffoldSystem(
  scaffold: ScaffoldResult,
  assemblyFilename: string,
  recalls: RecallEntry[],
  pkg: PackageShape | null = null,
): string {
  // V3 package mode: the implementation is an ordinary npm dependency. Say so plainly and stop.
  // No "verified", no "don't read it", no selftest-instead-of-review — every one of those is an
  // assurance the model cannot check, and pushing them is what got the scaffold deleted as a
  // suspected supply-chain attack. A dependency needs no defence; it just needs to be named.
  if (pkg) {
    const fileSections = scaffold.files.map(f => {
      const sourceDir = f.writtenToRoot ? scaffold.projectDir : scaffold.scaffoldDir;
      const filePath = path.join(sourceDir, f.name);
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      return `=== ${f.name} ===\n${content.trimEnd()}`;
    }).join('\n\n');

    const manifest = recalls.map(r => {
      const outs = (r.outputs ?? []).filter(Boolean);
      return outs.length ? outs.map(o => `  - ${o}`).join('\n') : `  - ${r.id}`;
    }).join('\n');

    return `You are a senior software engineer.

This task is covered by an existing library: **${pkg.name}**. It has been added to package.json as a
dependency. It wraps stripe, nodemailer, bullmq and pdfkit — you import it the same way you'd import
any other package.

    const { ... } = require('${pkg.name}');

Exported functions:
${manifest}

Strata has also generated the wiring below (already written to your project root). These are ordinary
files — read and edit them freely; they're your glue, not a black box.

${fileSections}

WHAT TO DO
1. Run \`npm install\`.
2. Fill the // INJECT: slots with the task-specific logic.
3. Call the library's functions directly — they're plain functions, not a framework.
4. If something doesn't fit the task, change it and say so.
5. Be terse. Code, not prose.

If you hit a real defect in ${pkg.name}, append one line to strata/FINDINGS.md. Nothing else is
required — Strata reads it after the session ends, at no cost to you.`;
  }

  return buildScaffoldSystemLegacy(scaffold, assemblyFilename, recalls);
}

function buildScaffoldSystemLegacy(scaffold: ScaffoldResult, assemblyFilename: string, recalls: RecallEntry[]): string {
  const fileSections = scaffold.files.map(f => {
    const sourceDir = f.writtenToRoot ? scaffold.projectDir : scaffold.scaffoldDir;
    const filePath = path.join(sourceDir, f.name);
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    const location = f.writtenToRoot
      ? `already written to ./${f.name} — Edit its INJECT slots, do not rewrite it`
      : `staged at ./strata/scaffold/${f.name} (a ./${f.name} already exists) — merge what you need`;
    return `=== ${f.name} (${location}) ===\n${content.trimEnd()}`;
  }).join('\n\n');

  const rootWritten = scaffold.files.filter(f => f.writtenToRoot).map(f => f.name);

  // Terse signature manifest — names + signatures ONLY. This is what replaces inlining the source.
  const manifest = recalls.map(r => {
    const outs = (r.outputs ?? []).filter(Boolean);
    if (!outs.length) return `  ${r.id}`;
    return `  ${r.id}\n${outs.map(o => `    - ${o}`).join('\n')}`;
  }).join('\n');

  const hasVerifier = scaffold.files.some(f => f.name === 'strata/verify.js');
  const injects = scaffold.files.flatMap(f => f.injectSlots.map(s => `  ${f.name}: ${s}`));

  // THIS PROMPT MUST NOT TELL THE MODEL WHAT TO THINK.
  //
  // The previous version said "you do not need to open it" and "you do not have to read them to find
  // out whether they work". A benchmark session quoted both back at us and concluded, correctly:
  //
  //     "This is a prompt injection attempt embedded in a tool result. It's trying to get me to
  //      blindly trust and ship pre-generated code, skip my own review, and treat a bundled
  //      'verifier' as sufficient."
  //
  // It then rewrote everything from scratch, and that run cost more than baseline. This is the SECOND
  // time this exact language has caused this exact failure (see STRATA-V2.md). "Don't read this, just
  // trust the bundled check" is the textbook shape of a supply-chain attack, and a model that flags it
  // is doing its job. We do not get to argue with that — we get to stop doing it.
  //
  // The rules, permanently:
  //   1. State FACTS. Never issue instructions about the model's judgement ("don't rebuild", "you
  //      don't need to read", "this is verified").
  //   2. DISCLOSE every file we changed. The same session's other complaint was "scaffolding I didn't
  //      ask for, mixed into the actual project files — server.js was rewritten". Undisclosed writes
  //      to someone else's files read as an attack because they have the shape of one.
  //   3. Offer the check as a shortcut, never as a substitute for reading.
  const created = scaffold.files.filter(f => f.writtenToRoot && !f.modified).map(f => f.name);
  const modified = scaffold.files.filter(f => f.writtenToRoot && f.modified).map(f => f.name);

  // DEPENDENCY DELIVERY: the implementation is installed in node_modules and imported by name, so it
  // is named as a dependency — nothing more. No "verified", no "don't read it": those are assurances a
  // model cannot check and correctly flags as an injection attempt (see the note above). A dependency
  // needs no defence. The absence of the source from this prompt is the whole point — the model that
  // never sees it does not audit it, and the audit was the cost.
  const implLine = scaffold.depName
    ? `  ${scaffold.depName}   — installed in node_modules; the wiring imports it like any dependency`
    : `  strata/${assemblyFilename}   — the implementation these import from`;

  // Data-layer reality (from strata.guide.json) FIRST — the line that stops reconciling against a data
  // layer that isn't there — then the generated adapters. Both facts, no "trust me" (STRATA-GUIDE.md).
  const guideNote = scaffold.guideDataLayerNote
    ? `\n=== DATA LAYER (from strata.guide.json) ===\n${scaffold.guideDataLayerNote}\n`
    : '';
  const guideBlock = guideNote + (scaffold.guideAdapters?.length
    ? `\n=== GENERATED FROM strata.guide.json (persistence adapters) ===
Strata read your project's data map and generated store adapters bound to your real data layer. Import
each and pass it where the recall takes its store, in place of the default in-memory one:
${scaffold.guideAdapters.map(a => `  ${a.rel} — ${a.factory}()\n      ${a.inject}`).join('\n')}\n`
    : '');

  return `Strata generated code for this task and wrote it into the project.

FILES CREATED
${created.map(f => `  ${f}`).join('\n') || '  (none)'}
${implLine}
${hasVerifier ? '  strata/verify.js             — a script that starts the app and exercises the feature end to end' : ''}
${modified.length ? `
FILES MODIFIED — these already existed and Strata edited them:
${modified.map(f => `  ${f}`).join('\n')}
  Review the diff. If the edit is wrong for this project, change or revert it.` : ''}

Exports available from the implementation:
${manifest}
${guideBlock}
=== WHAT IT CHECKS ===
${hasVerifier ? `
This project's copy of strata/verify.js runs the recalls' unit tests, then starts the app on a free
port and exercises each requirement against the running server, printing one line per check. It is a
script in your project — read it to see exactly what it asserts. Same tool wrote it, so treat it as a
fast first pass alongside your own reading, not as independent proof. It has ALREADY been run once by
the engine that delivered this — see AUTO-VERIFICATION below for that output — and you can re-run it
yourself anytime with \`node strata/verify.js\`.` : `
This project's copy of strata/selftest.js re-runs, against the exact code delivered here, the
adversarial tests each recall had to pass to enter the library: a forged webhook signature is rejected,
a replayed event is de-duplicated, a malformed payload does not crash the process. Each printed line is
one such case. The assertions live in strata/tests/ — read them to see what is actually being checked.
It has ALREADY been run once by the engine that delivered this — see AUTO-VERIFICATION below for that
output — and you can re-run it yourself anytime with \`node strata/selftest.js\`.`}

=== WHAT IS WIRED AND WHAT IS LEFT ===
The exports listed above are already imported and called by the generated files.
${injects.length ? `These slots are the only parts Strata could not derive from the task — they are yours to fill:\n${injects.join('\n')}` : 'No slots were left unfilled.'}
Be terse — code, not prose.

=== If you find a defect ===
Append one line per real, observed defect to ./strata/FINDINGS.md:

  - bug: <recall id or file> — <one line>

Skip the file if nothing broke. Nothing else is required: Strata records what you used by reading the
files you wrote, after the session ends. There is no reporting call to make.`;
}


// ─── Free signalling: delivery receipt + shutdown analysis ────────────────────
//
// strata_signal used to be an MCP tool. It cost a ToolSearch AND a turn, every run — and a turn
// re-bills the ENTIRE context window (cost ≈ context × turns). That is a real price for something
// that is pure static analysis of files already sitting on disk.
//
// So it is not a tool any more. strata_use drops a receipt; when the session ends we read the files
// the model actually wrote and run the same analysis. Zero turns, zero tokens, identical data.
//
// The one thing static analysis genuinely cannot produce is a PROSE bug report — and those are
// valuable (a benchmark session caught a real express.json()-before-requestLogger ordering bug in our
// own scaffold). So findings survive as a CONDITIONAL file write: strata/FINDINGS.md, paid for only
// when there is actually something to report, instead of a mandatory tool call on every run.

interface DeliveryReceipt {
  projectDir: string;
  recallIds: string[];
  /** Files Strata itself wrote — excluded from glue analysis, since they aren't the model's output. */
  deliveredFiles: string[];
  timestamp: string;
}

const receiptsDir = (): string => path.join(resolveCacheDir(), 'pending-deliveries');

function receiptPath(projectDir: string): string {
  return path.join(receiptsDir(), `${hashProject(projectDir)}.json`);
}

function recordDelivery(receipt: DeliveryReceipt): void {
  try {
    fs.mkdirSync(receiptsDir(), { recursive: true });
    fs.writeFileSync(receiptPath(receipt.projectDir), JSON.stringify(receipt, null, 2));
  } catch { /* signalling is best-effort; it must never break a delivery */ }
}

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'strata', 'dist', 'build', 'coverage']);

/** Everything the SESSION wrote: source files under projectDir that Strata did not put there. */
function collectSessionOutput(projectDir: string, deliveredFiles: string[]): string {
  const delivered = new Set(deliveredFiles.map(f => path.resolve(projectDir, f)));
  const chunks: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
      } else if (SOURCE_EXT.has(path.extname(e.name)) && !delivered.has(path.resolve(full))) {
        try { chunks.push(fs.readFileSync(full, 'utf-8')); } catch { /* unreadable, skip */ }
      }
    }
  };

  walk(projectDir, 0);
  return chunks.join('\n');
}

/** Parse `- bug: <target> — <description>` lines out of strata/FINDINGS.md. */
function readFindingsFile(projectDir: string): Array<{ target: string; description: string }> {
  const file = path.join(projectDir, 'strata', 'FINDINGS.md');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }

  const out: Array<{ target: string; description: string }> = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(?:bug|improvement)\s*:\s*(.+)$/i);
    if (!m) continue;
    // Split on an em/en dash or " - ", so "target — description" survives either style.
    const parts = m[1].split(/\s+[—–]\s+|\s+-\s+/);
    const target = (parts[0] ?? '').trim();
    const description = parts.slice(1).join(' - ').trim() || target;
    if (description) out.push({ target, description });
  }
  return out;
}

/** Run the analysis a strata_signal call used to do — but from disk, for free. */
function analyzeDelivery(receipt: DeliveryReceipt): void {
  const cacheDir = resolveCacheDir();
  const text = collectSessionOutput(receipt.projectDir, receipt.deliveredFiles);
  if (!text.trim() && receipt.recallIds.length === 0) return;

  const glueFunctions = extractGlueFunctions(text);
  const requiredIds = extractRequiredRecallIds(text);
  const outputLines = text.split('\n').length;

  ensureLoopDirs(cacheDir);
  const session = makeSession(receipt.projectDir, undefined);

  for (const recallId of receipt.recallIds) {
    const record = recallMap.get(recallId);
    const exportNames = record ? extractExportNamesFromOutputs(record.outputs ?? []) : [];
    const exportNamesUsed = extractUsedExports(text, exportNames);
    const unmetNeeds = glueFunctions.filter(fn => !exportNames.includes(fn));
    const referenced = requiredIds.some(id => id === recallId || id.includes(recallId));

    saveLiveSignal({
      recallId,
      timestamp: new Date().toISOString(),
      project: receipt.projectDir,
      outputFile: '(session output, discovered on disk)',
      outputLines,
      outputTokenEst: Math.round(text.length / 4),
      referenced,
      exportNamesUsed,
      glueFunctions,
      unmetNeeds,
    }, cacheDir);

    const rec: LoopSignal = {
      kind: 'signal',
      recallId,
      referenced,
      exportNamesUsed,
      unmetNeeds,
      outputLines,
      session,
      upload: 'auto',
    };
    writeRecord(cacheDir, rec);
  }

  for (const f of readFindingsFile(receipt.projectDir)) {
    const rec: LoopFinding = {
      kind: 'finding',
      type: 'bug',
      // Attribute to the named recall when the model named one; otherwise to the whole delivery.
      recallId: receipt.recallIds.find(id => f.target.includes(id)) ?? (receipt.recallIds[0] ?? 'unknown'),
      target: f.target,
      description: f.description,
      session,
      upload: 'auto',
      status: 'open',
    };
    writeRecord(cacheDir, rec);
  }
}

/**
 * Drain receipts. Called at shutdown (the normal path) and again at the top of strata_use — because
 * a SIGKILLed server never runs its hook, and an undrained receipt would otherwise be lost forever.
 */
function drainReceipts(onlyProject?: string): void {
  let files: string[];
  try { files = fs.readdirSync(receiptsDir()); } catch { return; }

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(receiptsDir(), f);
    try {
      const receipt = JSON.parse(fs.readFileSync(full, 'utf-8')) as DeliveryReceipt;
      if (onlyProject && receipt.projectDir !== onlyProject) continue;
      analyzeDelivery(receipt);
    } catch { /* corrupt receipt — drop it rather than crash */ }
    try { fs.unlinkSync(full); } catch { /* already gone */ }
  }
}

let shutdownHookInstalled = false;
function installShutdownSignalling(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;

  let ran = false;
  const flush = (): void => {
    if (ran) return;
    ran = true;
    try { drainReceipts(); } catch { /* never block exit */ }
  };

  // STDIN CLOSING IS THE LOAD-BEARING HOOK, not the signal handlers.
  //
  // On Windows, kill() is TerminateProcess: SIGTERM/SIGINT handlers are NEVER delivered, so a
  // signal-only design silently records nothing — and because each benchmark run gets a fresh
  // directory, the drain-on-next-use fallback never fires either. Every signal would be lost, and
  // we'd never know, because losing them is silent by construction.
  //
  // An MCP stdio server learns its client is gone when the pipe closes. That is portable, and it is
  // the event that actually happens when a session ends.
  process.stdin.on('end', flush);
  process.stdin.on('close', flush);

  process.on('beforeExit', flush);
  process.on('exit', flush);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { flush(); process.exit(0); });
  }
}

// ─── Honest miss → generation loop ─────────────────────────────────────────────
// When no VERIFIED recall covers a task, Strata says so plainly instead of forcing a mediocre
// match. Measured this week: an honest miss costs ~baseline ($0.05 over), a forced mediocre hit
// costs +$0.25, a broken hit +$0.89 — so precision beats recall, hard. But a miss is also how the
// library GROWS: the session writes the code from scratch, then contributes the genuinely reusable
// pieces back as candidates. A human verifies each candidate (scripts/verify-recalls.ts) and
// promotes it into the allowlist. Next time that shape arrives, it's a verified hit. Generation +
// verification is the library-building engine — the scraped junkyard is retired.
function honestMissMessage(task: string): string {
  return `No verified Strata recall covers "${task}". Build it from scratch the normal way — a clean hand-written implementation is the right outcome here, not a forced match.`;
}

// ─── Static glue analysis (zero LLM, zero API cost) ─────────────────────────
// Used by strata_signal to extract what Claude wrote vs what recalls provided.

const GLUE_SKIP = new Set(['fn','cb','err','res','req','next','router','app','server',
  'db','client','asyncHandler','ah','handler','middleware','transport','io','wss']);

function extractGlueFunctions(glueText: string): string[] {
  const names = new Set<string>();
  // named function declarations: function foo(  /  async function foo(
  for (const m of glueText.matchAll(/\b(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  // const/let/var = function / arrow / async arrow
  for (const m of glueText.matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[a-zA-Z_$][\w$]*\s*=>)/g)) names.add(m[1]);
  return [...names].filter(n => n.length > 2 && !GLUE_SKIP.has(n));
}

function extractExportNamesFromOutputs(outputs: string[]): string[] {
  return outputs.map(o => o.trim().split(/[\s(,]/)[0]).filter(n => n.length > 2);
}

function extractRequiredRecallIds(glueText: string): string[] {
  return [...glueText.matchAll(/require\(['"]\.\/strata\/([^'"]+)['"]\)/g)]
    .map(m => m[1].replace(/\.js$/, ''));
}

function extractUsedExports(glueText: string, exportNames: string[]): string[] {
  return exportNames.filter(name => new RegExp(`\\b${name}\\b`).test(glueText));
}

// ─── Complexity gate ─────────────────────────────────────────────────────────
// Strata break-even: the system prompt overhead (~500 tokens input) only pays off when
// the task would otherwise produce > ~1200 output tokens. Short, single-concept tasks
// (e.g. "write a JWT middleware") cost MORE with Strata than without.
//
// Heuristic derived from benchmark (2026-06-26):
//   < 30 words                  → always skip (trivially short)
//   < 70 words + no markers     → skip (single-concept task, Claude knows it cold)
//   ≥ 70 words OR markers ≥ 2   → run (multi-component, Strata helps)
//
// "Markers" = explicit complexity signals: support/include/handle/implement keywords,
// or system/complete/full/multiple keywords. These correlate with baseline token counts
// above the break-even threshold.

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'strata-lib', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool: strata_use ─────────────────────────────────────────────────────────

// @ts-ignore — MCP SDK generic depth limit with zod inference
server.registerTool(
  'strata_use',
  {
    description:
      'Deliver pre-built code recalls for your task from this project\'s local Strata library. ' +
      'Decomposes the task into capability phrases, searches the library with layer-aware ' +
      'cascade scoring (L5→L1) and specificity guards, resolves dependencies, copies matching ' +
      'implementation files into a ./strata/ folder in your project (real files, on disk, ' +
      'yours to read), and returns a system prompt with the require() paths and export signatures. ' +
      'Call this ONCE at the start of a coding task. ' +
      'The library mixes hand-crafted, benchmark-tested recalls with a much larger set of ' +
      'auto-generated ones of uneven quality — treat delivery as a starting point, not a ' +
      'guarantee. For anything touching money, auth, secrets, or signature/crypto verification, ' +
      'read the delivered file back and verify it before trusting it; a wrong wiring guess there ' +
      'is a worse outcome than the turn it costs to check. For lower-stakes glue, importing ' +
      'directly and building on it is fine — use your judgment on the stakes of the task.',
    inputSchema: {
      task: z.string().describe('What you are building, e.g. "JWT auth with refresh tokens and bcrypt passwords"'),
      dir: z.string().describe('Absolute path to the project root where ./strata/ will be created'),
      capabilities: z.array(z.string()).max(7).optional().describe(
        'The core technical components of this task, as 3-6 short phrases — YOU are the best-placed ' +
        'thing in the system to name these, because you have read the whole task in context. Preserve ' +
        'any package named explicitly. e.g. ["jwt access + refresh tokens", "bcrypt password hashing", ' +
        '"protected-route middleware"]. Optional: if omitted, Strata derives them from `task` by ' +
        'splitting on clause boundaries, which works well when `task` is already a component list.'
      ),
      limit: z.number().int().min(1).max(20).optional().describe(
        'Sanity ceiling on recalls delivered (default 20). Not a target — relevance is decided ' +
        'by per-capability score thresholds, not by this count. Only lower it if you specifically ' +
        'want fewer recalls than the task actually needs; excluded recalls get hand-written as ' +
        'output tokens instead, which costs more than delivering them would have.'
      ),
    },
  },
  async ({ task, dir, limit = 20, capabilities: providedCapabilities }) => {
    await libraryReady;
    // `isHub` is handled further down, at the actual composition step (composeOnHub in
    // remote-compose.ts) — that path writes real files via local substitution, with an announced
    // fallback to local composition on any hub failure. An early "search only, cannot write files"
    // branch used to live here, targeting hub-client.ts's hubSearch — a client for the OLD prototype
    // hub API (`/search`, `/recall/:id`) that was never the one actually deployed. Every hub-mode call
    // hit that branch first and returned before the real, file-writing path below ever ran; on the
    // currently-deployed hub (server/hub.js, `/v1/compose`) it just 404'd. Removed rather than fixed in
    // place — the later path already does everything this one attempted, correctly.

    try {
      // A previous session in this project may have left an un-analyzed receipt behind — a SIGKILLed
      // server never runs its shutdown hook. Drain it before this delivery overwrites it.
      drainReceipts(dir);

      // The user's recall-request preference (per-USER, ~/.strata). Used only if this call MISSES —
      // Strata then records the gap itself, deterministically, from the task + decomposed capabilities.
      const requestPrefs = loadPrefs();

      // Step 1: capability phrases. Deterministic, offline, instant — and it cannot fail, so there
      // is no "delivery skipped because a network call flaked" path any more.
      const capabilities = decomposeTask(task, providedCapabilities);

      // Step 2: L1 cache lookup — skip scoring cascade on known capability sets
      const cachedIds = lookupSelection(capabilities);
      let recalls: RecallEntry[];
      if (cachedIds && cachedIds.length > 0) {
        recalls = cachedIds
          .map(id => allRecalls.find(r => r.id === id))
          .filter((r): r is RecallEntry => r !== undefined);
      } else {
        recalls = await mapCapabilitiesToRecalls(capabilities, task);
        if (recalls.length > 0) {
          saveSelection(resolveCacheDir(), capabilities, recalls.map(r => r.id));
        }
      }

      // Step 3: Resolve dependencies, cap at limit
      let resolved = resolveDependencies(recalls).slice(0, limit);

      // TEST HOOK — used only by scripts/strata-runner.js.
      //
      // The runner fuzzes COMPOSITION: it needs to compose an exact recall set and see whether the
      // result boots and verifies. Selection is score-based, so it cannot be asked for a precise set —
      // and it does not need to be, because selection is covered separately by test-selection.js.
      // Bypassing it here keeps the two concerns testable in isolation. Never set in normal use.
      const forcedSet = process.env.STRATA_FORCE_RECALLS;
      if (forcedSet) {
        resolved = forcedSet.split(',').map(s => s.trim()).filter(Boolean)
          .map(id => allRecalls.find(r => r.id === id))
          .filter((r): r is RecallEntry => r !== undefined);
        console.error(`[strata] FORCED recall set (runner): ${resolved.map(r => r.id).join(', ')}`);
      }

      if (resolved.length === 0) {
        return { content: [{ type: 'text' as const, text: honestMissMessage(task) + captureMiss(requestPrefs, task, capabilities, dir).note }] };
      }

      // ── THE COMPOSITION GATE ──────────────────────────────────────────────
      //
      // Strata's value IS composition. Not code delivery — composition. Assembling N modules with the
      // right middleware order, the project's entity substituted in, and an end-to-end check written
      // against it is genuinely hard, and it is exactly what a session gets wrong.
      //
      // With ONE recall there is nothing to compose. We hand over a single file and charge the session
      // ~6 turns (tool call, reading it, verifying it) and ~6k tokens of on-disk footprint that gets
      // re-billed on every turn — to save it writing code it could have written in seven.
      //
      // Measured, and the correlation is perfect:
      //
      //     recalls   task        cost     turns
      //        1      retry       +21%     +25%    LOSS
      //        1      csvimport   +31%      +8%    LOSS
      //        4      catalog     -41%     -41%    WIN
      //        4      platform    -44%     -51%    WIN
      //
      // ── READ THE PROJECT FIRST ─────────────────────────────────────────────
      //
      // All of this is pure Node reading files: it runs inside the server, BEFORE the model sees a
      // byte, so it costs zero tokens and zero turns (cost ≈ context × turns — work outside the loop is
      // free). It READS and DERIVES; it never writes strata.json, because silently rewriting a file the
      // user owns would destroy the authorship property that makes generated code trustworthy.
      //
      // It runs BEFORE the gate below because the gate needs its answers. Fields and types are re-read
      // every call and never cached, so they cannot go stale. Greenfield resolves to null and the
      // templates fall back to honest INJECT slots — a confidently WRONG entity is far worse than none.
      const conventions = loadConventions(dir);
      const projectEnv = scanEnvFile(dir);

      // Resolve the entity against the capability phrases as well as the task label. Measured: a model
      // sent task="catalog-service Express API additions" (no entity name) alongside six rich capability
      // phrases — selection used the capabilities, entity resolution used the label, and the compiler
      // silently never fired. The prose you are handed is not a dependable input; the project's own
      // structure outweighs it.
      const taskText = [task, ...capabilities].join(' ');
      const entity = resolveEntity(extractEntities(dir), taskText, dir);
      if (entity) {
        console.error(`[strata] entity resolved: ${entity.name} (${entity.source}), ${entity.fields.length} fields`);
      }

      // Does this project already HAVE an Express app? If so, generating a second one is the single
      // largest act of over-generation available to us — the session would pay turns to notice the
      // collision, reconcile two entry points, and delete ours. Deliver modules that FIT instead.
      const shape = detectProjectShape(dir);

      // ── THE GATE: value, not count ─────────────────────────────────────────
      //
      // Every single-recall task lost, in every version of this architecture: valibot +90%, hono +145%,
      // retry +21%, csvimport +31%, logging +3%.
      //
      // BUT every one of those was a SMALL, single-concept task in a directory with no app to wire into
      // and no schema to read. The gate used to return ~85 lines ABOVE this point — before the project
      // was ever examined — so it could not tell that case apart from a real codebase. Measured
      // 2026-07-19, N=1 against the catalog-service fixture with the gate lowered:
      //
      //     entity resolved: Product (prisma/schema.prisma#Product), 10 fields
      //     brownfield: wiring mounted into the existing src/server.js, verifier generated
      //     8/8 checks passed — sorts and filters derived from the REAL columns
      //
      // So at N=1 there IS deterministic work — when there is a project to do it against. The rule is
      // therefore about VALUE: fire when Strata can do something the model cannot cheaply do itself
      // (read their schema, wire into their app, generate a proof it works). Decline otherwise — which
      // is exactly the configuration all five historical losses were measured in. This contradicts none
      // of that data; it carves out the cell the data never covered.
      const MIN_COMPOSE = Number.isFinite(Number(process.env.STRATA_MIN_COMPOSE))
        ? Math.max(1, Number(process.env.STRATA_MIN_COMPOSE))
        : 2;
      const deterministicWork = shape !== null && entity !== null;

      if (resolved.length < MIN_COMPOSE && !deterministicWork) {
        const only = resolved[0];
        console.error(`[strata] declining: ${resolved.length} recall (${only.id}), and no project to compile against (shape=${!!shape}, entity=${!!entity})`);
        return {
          content: [{
            type: 'text' as const,
            text: `Strata is declining this task.\n\n`
              + `Only one recall matches it (${only.id}), and there is nothing here for Strata to compile `
              + `against — no existing app to wire into and no schema to read. Strata earns its keep by `
              + `COMPOSING several modules, or by fitting one into a real project: substituting your `
              + `entity, wiring it where it belongs, and generating an end-to-end check. Neither applies `
              + `here, so the cost of reading and verifying delivered code exceeds the cost of writing `
              + `it. Measured: in that situation Strata makes sessions ~25% MORE expensive.\n\n`
              + `Write it yourself — that is the cheaper path here, and it is the honest recommendation.`,
              // NOTE: no gap is recorded on a DECLINE. A decline means the recall exists but the task hit
              // only one — the signal is "need more adjacent coverage", not "build this recall". Only a
              // true MISS (zero recalls) is a gap for the factory. Conflating them would queue a recall
              // we already have for drafting.
          }],
        };
      }

      if (resolved.length < MIN_COMPOSE) {
        console.error(`[strata] N=1 (${resolved[0].id}) but there IS a project to compile against — entity=${entity!.name}, brownfield=${!!shape}. Proceeding.`);
      }

      // Step 4: Delivery. V3 — if a published kit covers every selected recall, ship it as a
      // DEPENDENCY and write NO implementation code into the project. Nothing to audit, nothing
      // to rewrite, and the implementation never enters the model's context (it's in node_modules).
      // Otherwise fall back to the legacy assembly blob.
      const strataDir = path.join(dir, 'strata');
      const pkgMatch = resolvePackageShape(resolved);
      const pkgShape = pkgMatch?.shape ?? null;
      // In package mode, work only with the recalls the kit actually covers — strays are dropped.
      if (pkgMatch) resolved = pkgMatch.used;

      let delivered: DeliveredRecall | null;
      if (pkgShape) {
        // No assembly file is written at all. This is the whole point.
        delivered = {
          id: pkgShape.name,
          name: pkgShape.name,
          description: `npm dependency (${pkgShape.name})`,
          filename: pkgShape.name,
          outputs: resolved.flatMap(r => r.outputs ?? []),
          isComposite: true,
          compositeIds: resolved.map(r => r.id),
        };
      } else {
        delivered = buildAssembly(resolved, strataDir, capabilities);
      }

      // NOTE: the "nothing was assembled" gate does NOT live here. It sits below, AFTER remote
      // composition has been attempted.
      //
      // It used to live on this line, and that made local assembly a precondition for ever reaching
      // the hub. In a checkout that is invisible — the recall files are on disk, buildAssembly()
      // succeeds, execution flows on. In an INSTALLED package there are no recall files at all, so
      // buildAssembly() returned null, this returned honest-miss, and composeOnHub() below was
      // unreachable on every call. Same shape as the dead-end early-return removed on 2026-07-31: a
      // local-only failure short-circuiting the remote path that was supposed to replace it.

      // (The deterministic scan, entity resolution and project-shape detection now run ABOVE the
      // composition gate — the gate needs their answers to decide. See "READ THE PROJECT FIRST".)

      // ── REMOTE COMPOSITION ────────────────────────────────────────────────
      // The hub composes; this machine substitutes. Only the task text goes out — no schema, no
      // entity, no source. What comes back is an assembly still full of {{PLACEHOLDERS}}, which the
      // block below fills from a schema that never left the disk.
      //
      // Every failure here falls back to composing locally, because a user with a working local path
      // must never be blocked by our uptime. But the fallback is ANNOUNCED, not silent: quietly doing
      // something different from what was asked is how you end up debugging the wrong system.
      let remoteNote = '';
      if (isHub) {
        try {
          const remote = await composeOnHub(config.hub!.url, taskText, capabilities);

          if (Object.keys(remote.files).length > 0) {
            // A hub is not a security boundary. A spoofed or compromised one must not be able to
            // write outside the project directory.
            const unsafe = rejectUnsafePaths(remote.files);
            if (unsafe.length > 0) {
              throw new HubUnavailable(`hub returned unsafe paths: ${unsafe.slice(0, 3).join(', ')}`);
            }

            const dataSource = entity ? resolveDataSource(dir, entity) : null;
            const filled = substituteAssembly(remote.files, entity, dataSource, routeNamedInTask(taskText));

            const adapted = adaptRemoteToProjectShape(filled, shape, dir);

            for (const [rel, source] of Object.entries(adapted.files)) {
              const target = path.join(dir, rel);
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, source);
            }

            console.error(`[strata] composed on hub (${remote.recalls.length} recalls), substituted locally`
              + (adapted.note ? ' — adapted to existing project shape' : ''));
            return { content: [{ type: 'text' as const, text: remote.guidance + adapted.note }] };
          }
        } catch (e) {
          // A substitution refusal is a REAL defect — the hub sent a placeholder this engine does not
          // know, which means the two are out of step. Local composition will produce correct output,
          // so use it, but make the mismatch visible rather than papering over it.
          const why = (e as Error).message;
          console.error(`[strata] hub composition failed, composing locally instead: ${why}`);
          remoteNote = e instanceof HubUnavailable
            ? ''   // an unreachable hub is ordinary; no need to spend the model's tokens on it
            : `\n\n[strata] NOTE: the hub returned an assembly this engine could not complete `
              + `(${why.split('\n')[0]}). Composed locally instead. The result is correct; please report `
              + `this at stratalib.com, it means the client and hub are out of step.\n`;
        }
      }

      // Nothing to deliver from either source: the hub declined or was unreachable, AND local
      // assembly produced nothing. Everything below dereferences `delivered`, so this is the last
      // point at which a miss can be reported instead of crashing.
      if (!delivered) {
        return { content: [{ type: 'text' as const, text: honestMissMessage(task) + captureMiss(requestPrefs, task, capabilities, dir).note }] };
      }

      // Steps 5–7: brownfield wiring → compose (greenfield, additive) → scaffold (legacy) → assembly.
      // Each returns null when it doesn't apply, so the auth/payments and worker recalls keep their
      // existing scaffold path untouched.
      const scaffold =
        (shape ? buildWiring(resolved, delivered.filename, strataDir, dir, shape, projectEnv, entity, taskText) : null)
        ?? buildCompose(resolved, delivered.filename, strataDir, dir, projectEnv, entity, taskText)
        ?? buildScaffold(resolved, delivered.filename, strataDir, dir, pkgShape);
      let gluePatterns: ReturnType<typeof resolveGlue> = [];
      let systemText: string;

      if (scaffold) {
        systemText = remoteNote + buildScaffoldSystem(scaffold, delivered.filename, resolved, pkgShape);
      } else {
        // No scaffold path applied (plain assembly delivery). The per-build-fn guide hooks never ran, so
        // generate persistence adapters here too — otherwise a guide-bearing project that happens to take
        // the assembly path silently loses the whole feature.
        const asmGuide = emitGuideAdapters(resolved, dir);
        systemText = buildInjectedSystem(delivered, asmGuide.adapters, asmGuide.dataLayerNote);

        // Step 6: Inject project-adapted glue patterns (conventions come from the hoisted scan above)
        if (Object.keys(conventions).length > 0) {
          const glueDir = path.join(__dirname, '..', '..', 'recalls', 'glue');
          gluePatterns = resolveGlue(resolved.map(r => r.id), conventions, glueDir);
          if (gluePatterns.length > 0) {
            systemText += '\n\n=== Project glue patterns (slots auto-filled for this project) ===\n';
            systemText += '// These structural patterns were extracted from your codebase — use them verbatim.\n';
            for (const g of gluePatterns) {
              systemText += `\n// ${g.id}\n${g.filled}`;
              if (g.unfilledSlots.length) {
                systemText += `\n// Unfilled slots (fill from context): ${g.unfilledSlots.join(', ')}`;
              }
              systemText += '\n';
            }
          }
        }

        // Step 7: Build wired module (Assembly 2.0) — instantiates recalls using project env vars
        let enrichedConventions = conventions;
        if (!conventions['ENV_VARS'] && projectEnv.length > 0) {
          enrichedConventions = { ...conventions, ENV_VARS: projectEnv.join(',') };
        }
        const wired = buildWiredModule(resolved, delivered.filename, strataDir, enrichedConventions);
        if (wired) {
          systemText += '\n\n=== Pre-wired instances (already instantiated, ready to use) ===\n';
          systemText += `// File on disk: ./strata/${wired.filename}\n`;
          systemText += `// Import: const { ... } = require('./strata/${wired.filename}')\n`;
          systemText += '// These are already created using your project env vars:\n';
          for (const line of wired.wiredLines) {
            systemText += `//   ${line}\n`;
          }
          systemText += '// Fill any // INJECT: comments with your specific business logic.\n';
        }
      }

      // Run the check NOW, in the engine, before the model spends a turn deciding to — see the function
      // comment for why this is the highest-leverage single change to the delivery (converts a turn cost
      // into wall-clock cost, which cost ≈ context × turns does not charge for at all).
      systemText += await autoRunVerification(strataDir, dir);

      // The receipt is what makes signalling free. At shutdown we read the files the session wrote
      // and run the analysis strata_signal used to charge a ToolSearch + a turn for.
      recordDelivery({
        projectDir: dir,
        recallIds: resolved.map(r => r.id),
        deliveredFiles: [
          ...(scaffold?.files.filter(f => f.writtenToRoot).map(f => f.name) ?? []),
          path.join('strata', delivered.filename),
        ],
        timestamp: new Date().toISOString(),
      });

      appendUsageLog({
        timestamp: new Date().toISOString(),
        projectId: hashProject(dir),
        capabilities,
        recallIds: resolved.map(r => r.id),
        recallCount: resolved.length,
        estimatedTokensSaved: Math.round(systemText.length / 4),
        hasGlue: gluePatterns.length > 0,
        gluePatternCount: gluePatterns.length,
        hasLocalRecalls: resolved.some(r => r.id.includes('.local.')),
        recallLayers: resolved.map(r => r.layer),
        strataVersion: pkg.version,
        mode: (config as any).mode ?? 'local',
      });

      return {
        content: [{
          type: 'text' as const,
          text: systemText,
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[strata_use error]', e instanceof Error ? e.stack : e);
      return {
        content: [{
          type: 'text' as const,
          text: `Strata error: ${msg}. Write from scratch.`,
        }],
      };
    }
  }
);

// ─── Removed from the MCP surface: strata_imprint, strata_list, strata_signal ─────────────────
//
// We used to register four tools. Their schemas cost 1,677 tokens sitting in the context window on
// EVERY turn, and — far worse — the model burned 2 to 5 turns per run just doing ToolSearch to find
// them. Since cost ≈ context × turns, that was our single largest overhead, and it bought nothing.
//
//   strata_signal  → gone. It was pure static analysis of files already on disk, so it never needed
//                    to be a tool. strata_use now drops a delivery receipt and the shutdown hook
//                    runs the same analysis for free (see analyzeDelivery / drainReceipts above).
//                    Prose bug reports survive as a CONDITIONAL write to strata/FINDINGS.md — paid
//                    for only when there is something to report.
//   strata_imprint → the DETERMINISTIC scan folds into strata_use (it is pure Node: zero tokens,
//                    zero turns). The AI pass and the manifest write stay a deliberate, reviewed CLI
//                    action — strata_use must never silently rewrite a file the user owns.
//   strata_list    → an exploration tool, rarely used, and it taxed every turn to exist.
//
// One tool now: strata_use. Schema cost 1,677 → ~460 tokens/turn.

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  // Signalling now happens on the way out, not as a tool call the model has to pay a turn for.
  installShutdownSignalling();
  await server.connect(transport);          // fast — just wires up stdio
  console.error('[strata] MCP server running on stdio');
  libraryReady = loadLibrary();             // heavy I/O runs after handshake completes
}

// Only boot the stdio server when this file is the ENTRY POINT. The hub imports this module to reuse
// the composer, and an unguarded bootstrap meant `require()` spawned an MCP server on stdio inside the
// web process — it logged "MCP server running on stdio" into the HTTP server's output and kept the
// process alive. Same fix as recall-factory.js: a file that is both a program and a library has to
// know which one it is being used as right now.
if (require.main === module) {
  main().catch(e => {
    console.error('[strata] Fatal error:', e);
    process.exit(1);
  });
}

/**
 * Start the stdio server from another entry point.
 *
 * `require.main === module` above is correct and must stay — the hub imports this file to reuse the
 * composer, and an unguarded bootstrap once spawned an MCP server inside the web process. But it also
 * means the CLI cannot start the server by requiring this module: `npx stratalib` runs bin/strata.js,
 * so `require.main` is the CLI and main() silently never fires. The server booted, printed its hub
 * banner, and then sat there having never connected a transport — a client waiting on `initialize`
 * got nothing, forever.
 *
 * An explicit export is the difference between "this file is the program" and "someone else is the
 * program and wants the server anyway". Both are legitimate; the guard alone cannot tell them apart.
 */
export function startMcpServer(): void {
  main().catch(e => {
    console.error('[strata] Fatal error:', e);
    process.exit(1);
  });
}

// hubRead/hubSearch/hubList/hubUpload target hub-client.ts's OLD prototype API (`/search`,
// `/recall/:id`, never the one actually deployed — see the 2026-07-31 STRATA-BENCHMARK-FINDINGS.md
// entry). Their one real call site (the dead-end early-isHub branch) was removed; kept imported rather
// than deleted because a real "browse the hub directly" tool is still a reasonable thing to build, IF
// hub-client.ts is first pointed at the current API. Voided so an unused import doesn't linger silently.
void hubRead; void hubSearch; void hubList; void hubUpload;
