/**
 * Seed a DRAFT strata.guide.json from what the project already contains.
 *
 * THE INVERSION THIS PERFORMS. `extractEntities()` parses seven schema dialects and finds every entity
 * in the project. Until now its output fed a scoring contest: candidates were ranked against the words
 * in the task string, and when the top two were close, selection REFUSED ("Order (14) vs Invoice (12)
 * — refusing to guess"). Abstaining was correct — a wrong entity ships code that compiles, boots,
 * passes a smoke test and serves the wrong rows — but it is a capability ceiling, re-hit on every run,
 * because nothing ever recorded the answer.
 *
 * So the crawl stops being the guesser and becomes the BOOTSTRAPPER. It writes down what it found, once,
 * and a human or model settles the ambiguity by editing a file instead of by rephrasing a task string.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never invents an `operation`, a `route`, or a `guarantee`.
 * Everything it writes is a fact read off disk, so every line it produces is fact-checkable against the
 * repo (guide-factcheck.ts). The half of the guide that describes INTENT — what the project should do
 * next, for domains that do not exist yet — is authored by the model, because only the model has read
 * the request. Seeding intent here would mean inventing requirements and then generating code from
 * them, which is the failure mode this whole design exists to avoid.
 */
import fs from 'fs';
import path from 'path';
import { GUIDE_SCHEMA, GUIDE_FILENAME, StrataGuide, Domain, DomainField, Datastore, Relation } from './guide.js';
import { extractEntities, Entity, EntityField, routePath } from './imprint/entities.js';
import { detectProjectShape } from './imprint/project-shape.js';

/** Where an entity's truth lives maps to a datastore alias + how to reach it. */
const STORE_FOR_ORIGIN: Record<string, { alias: string; kind: string; via: string; package?: string }> = {
  prisma:     { alias: 'primaryDb',  kind: 'sql',        via: 'prisma',    package: '@prisma/client' },
  mongoose:   { alias: 'primaryDb',  kind: 'mongodb',    via: 'mongoose',  package: 'mongoose' },
  drizzle:    { alias: 'primaryDb',  kind: 'sql',        via: 'drizzle',   package: 'drizzle-orm' },
  sequelize:  { alias: 'primaryDb',  kind: 'sql',        via: 'sequelize', package: 'sequelize' },
  typeorm:    { alias: 'primaryDb',  kind: 'sql',        via: 'typeorm',   package: 'typeorm' },
  typescript: { alias: 'inMemory',   kind: 'in-memory',  via: 'module-array' },
  'plain-js': { alias: 'inMemory',   kind: 'in-memory',  via: 'module-array' },
};

function toDomainField(f: EntityField): DomainField {
  const out: DomainField = { name: f.name, type: f.isEnum ? 'enum' : f.type };
  if (f.isId) out.isId = true;
  if (f.isGenerated) out.generated = true;
  if (f.required) out.required = true;
  if (f.enumValues?.length) out.enumValues = f.enumValues;
  return out;
}

function toRelations(e: Entity): Relation[] | undefined {
  if (!e.relations?.length) return undefined;
  return e.relations.map(r => ({
    field: r.name,
    to: r.target,
    // The extractor records to-many as `list`; anything else is many-to-one for our purposes. This is
    // deliberately coarse — a wrong cardinality here is a documentation defect, not a codegen one,
    // because nothing generates from it yet.
    kind: r.list ? 'one-to-many' : 'many-to-one',
  }));
}

function entityToDomain(e: Entity): Domain {
  const idField = e.fields.find(f => f.isId)?.name;
  const store = STORE_FOR_ORIGIN[e.origin ?? 'plain-js'];
  const d: Domain = {
    name: e.name.charAt(0).toLowerCase() + e.name.slice(1),
    entity: e.name,
    // Seeded domains describe what IS. `exists: false` is reserved for domains a model declares as
    // intent — that distinction is what tells generation whether it may create a route or must not.
    exists: true,
    store: store?.alias,
    collection: e.name,
    fields: e.fields.map(toDomainField),
  };
  if (idField) d.idField = idField;
  const rel = toRelations(e);
  if (rel) d.relations = rel;
  // Route is a FACT about convention (plural noun), not a claim that the route is implemented. An
  // operation is what claims that, and this seeder never writes one.
  d.route = routePath(e);
  return d;
}

function datastoresFor(entities: Entity[], projectDir: string): Record<string, Datastore> {
  const out: Record<string, Datastore> = {};
  for (const e of entities) {
    const s = STORE_FOR_ORIGIN[e.origin ?? 'plain-js'];
    if (!s || out[s.alias]) continue;
    const ds: Datastore = { kind: s.kind, via: s.via, liveAtRuntime: true };
    if (s.package) ds.package = s.package;
    if (e.origin === 'prisma') {
      const schemaRel = e.source.split('#')[0];
      if (fs.existsSync(path.join(projectDir, schemaRel))) ds.schemaFile = schemaRel;
      ds.handle = 'db';
    }
    out[s.alias] = ds;
  }
  return out;
}

function readPkg(projectDir: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8')); } catch { return {}; }
}

export interface SeedResult {
  guide: StrataGuide;
  /**
   * True when no domain declares an operation — i.e. the guide describes the project's SHAPE but says
   * nothing about what it should do. A thin guide is the normal output of seeding and is the signal
   * that the model has something worth adding; it is not an error.
   */
  thin: boolean;
  /** Domains the crawl found, for the prompt block that asks the model to complete them. */
  domainNames: string[];
}

/**
 * Build a draft guide. Returns null when there is nothing to describe (no entities found), so a
 * greenfield project does not get a file full of empty objects.
 */
export function seedGuide(projectDir: string): SeedResult | null {
  const entities = extractEntities(projectDir);
  if (!entities.length) return null;

  const shape = detectProjectShape(projectDir);
  const pkg = readPkg(projectDir);
  const deps = Object.keys((pkg.dependencies as Record<string, string>) ?? {});

  const guide: StrataGuide = {
    schema: GUIDE_SCHEMA,
    meta: {
      authoredBy: 'strata-seed',
      authoredAt: new Date().toISOString(),
      // Seeded content is read off disk, so it is checkable — but nobody has looked at it, and the
      // schema's own field for that must stay honest.
      reviewedByHuman: false,
    },
    stack: {
      language: fs.existsSync(path.join(projectDir, 'tsconfig.json')) ? 'typescript' : 'javascript',
      moduleSystem: pkg.type === 'module' ? 'esm' : 'commonjs',
      framework: deps.includes('express') ? 'express' : undefined,
      runtime: 'node',
    },
    layout: {
      sourceRoot: shape?.sourceRoot || undefined,
      entryPoint: shape?.entryFile || undefined,
      routes: shape?.routesDir || undefined,
      envFile: fs.existsSync(path.join(projectDir, '.env')) ? '.env' : undefined,
    },
    datastores: datastoresFor(entities, projectDir),
    domains: entities.map(entityToDomain),
  };

  return {
    guide,
    thin: true,   // a seeded guide never declares an operation, by construction
    domainNames: guide.domains?.map(d => d.entity) ?? [],
  };
}

// ─── The guide → engine bridge ───────────────────────────────────────────────

/** A guide domain rendered as the Entity the rest of the engine already speaks. */
function domainToEntity(d: Domain): Entity {
  const fields: EntityField[] = (d.fields ?? []).map(f => ({
    name: f.name,
    type: (f.type === 'enum' ? 'string' : f.type) as EntityField['type'],
    required: f.required ?? false,
    isId: f.isId ?? false,
    isEnum: f.type === 'enum' || !!f.enumValues?.length,
    enumValues: f.enumValues,
    isGenerated: f.generated ?? false,
  }));
  return {
    name: d.entity,
    source: `${GUIDE_FILENAME}#${d.name}`,
    fields,
    relations: (d.relations ?? []).map(r => ({ name: r.field, target: r.to, list: /one-to-many|many-to-many/.test(r.kind) })),
    origin: 'plain-js',
  };
}

/**
 * Resolve the task's entity FROM THE GUIDE, before falling back to the crawl.
 *
 * The crawl scores every parsed entity against the words in the task string and REFUSES when the top
 * two are close. That abstain is correct in isolation — a wrong entity ships code that compiles, boots,
 * passes a smoke test and serves the wrong rows — but it is re-decided on every run and can never
 * improve, because nothing records the answer.
 *
 * A guide IS the recorded answer. When a domain names itself in the task, it wins outright: the
 * developer (or the model, once) already made the judgement the scorer was trying to reverse-engineer.
 * Match is on the domain name, entity name, or route — never fuzzy, because a fuzzy match here would
 * reintroduce exactly the guessing this replaces.
 */
export function entityFromGuide(guide: StrataGuide | null, taskText: string): Entity | null {
  if (!guide?.domains?.length) return null;
  const hay = taskText.toLowerCase();

  /**
   * Where in the task each of a domain's names is first mentioned, and how often.
   *
   * THE SUBJECT LEADS. "Order creation … from live Product prices" is a task about orders that mentions
   * products; "paginate products and link to orders" is the reverse. Position separates them and a
   * name-set membership test does not — which is how the first draft of this function lost a benchmark
   * run. It used `find()`, so the FIRST domain in array order that matched anywhere won: Product is
   * declared before Order, the task mentioned Product in a subordinate clause, and Product took the
   * slot. Worse, Product carried no fields in that guide, so the viability guard below returned NULL
   * rather than trying the next candidate — resolution fell back to the crawl, routesFromGuide received
   * the wrong domain, no endpoints were generated, and the session rebuilt the orders API by hand at
   * 3.8x the cost of the runs where this resolved correctly.
   */
  const scored = guide.domains
    // Only a domain that carries FIELDS can drive generation — substitution needs columns. Filtering
    // FIRST is what makes a non-viable match fall through instead of aborting the whole lookup.
    .filter(d => (d.fields ?? []).length > 0)
    .map(d => {
      const names = [d.name, d.entity, d.route?.replace(/^\//, '')].filter(Boolean) as string[];
      let first = Infinity;
      let hits = 0;
      for (const n of names) {
        const t = n.toLowerCase().replace(/s$/, '');
        if (t.length <= 2) continue;
        const re = new RegExp(`\\b${t}s?\\b`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(hay)) !== null) {
          hits++;
          if (m.index < first) first = m.index;
        }
      }
      return { domain: d, first, hits, ops: (d.operations ?? []).length };
    })
    .filter(c => c.hits > 0)
    .sort((a, b) =>
      a.first - b.first            // the subject is named first
      || b.hits - a.hits           // then whichever the task is actually about
      || b.ops - a.ops);           // then the one the guide has plans for

  return scored.length ? domainToEntity(scored[0].domain) : null;
}

/**
 * The block that tells the model the map exists and what it does.
 *
 * Facts only, per the standing rule in mcp-server.ts: what was written, what it contains, and what
 * Strata does with it. No instruction about the model's judgement — the mechanism is stated and the
 * decision to use it is the reader's.
 */
export function guideBlockFor(guide: StrataGuide | null, seededPath: string | null): string {
  if (!guide?.domains?.length) return '';
  const withOps = guide.domains.filter(d => (d.operations ?? []).length);
  const names = guide.domains.map(d => d.entity).join(', ');

  const head = seededPath
    ? `\n=== PROJECT MAP — ${seededPath} (created by Strata just now) ===\n`
      + `Strata read this project and wrote a draft map: ${guide.domains.length} domain(s) — ${names}.\n`
    : `\n=== PROJECT MAP — ${GUIDE_FILENAME} ===\n`
      + `${guide.domains.length} domain(s) — ${names}.\n`;

  if (withOps.length) {
    return head + `Declared operations: `
      + withOps.map(d => (d.operations ?? []).map(o => `${d.entity}.${o.name}`).join(', ')).join(', ')
      + `\nStrata generates endpoints from declared operations.\n`;
  }

  // The thin case — the common one after seeding, and the one worth explaining, because the map's
  // value is entirely in the half a crawl cannot produce.
  return head
    + `It records what EXISTS: fields, relations, and the datastore behind each domain. It declares no\n`
    + `operations, and Strata generates endpoints only from declared operations.\n\n`
    + `An operation names an endpoint and what it must guarantee:\n`
    + `  "operations": [{ "name": "createOrder", "route": "POST /orders",\n`
    + `                   "requires": ["Idempotency-Key header", "at least one line item"],\n`
    + `                   "guarantees": "a retried request with the same key returns the original order" }]\n`
    + `A domain the project does not have yet is declared with "exists": false.\n`;
}

/**
 * Write the seed, but NEVER over an existing guide.
 *
 * An authored guide carries the half this seeder cannot produce — operations, guarantees, domains that
 * do not exist yet. Overwriting it with a crawl would silently delete the only part that is expensive
 * to recreate, and it would do so on an ordinary strata_use call. Returns the path when written, null
 * when a guide already exists or there was nothing to describe.
 */
export function writeSeedIfAbsent(projectDir: string): { path: string; result: SeedResult } | null {
  const target = path.join(projectDir, GUIDE_FILENAME);
  if (fs.existsSync(target)) return null;
  const seeded = seedGuide(projectDir);
  if (!seeded) return null;
  try {
    fs.writeFileSync(target, JSON.stringify(seeded.guide, null, 2) + '\n', 'utf-8');
    return { path: GUIDE_FILENAME, result: seeded };
  } catch {
    return null;   // a read-only project must not fail a delivery over a draft file
  }
}
