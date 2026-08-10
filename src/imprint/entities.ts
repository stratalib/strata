/**
 * Entity extraction — the type environment.
 *
 * This is the piece that turns Strata from a retrieval system into a compiler. Composition (V4) can
 * already fill the mechanical gaps deterministically: imports, middleware order, setup, wiring. What
 * it CANNOT do is know that this project's catalog entity is called `Product`, that it has a `sku`
 * and a `price`, or that `/products` is the route. That knowledge lives in the project's schema —
 * and reading it is pure, offline, zero-token work.
 *
 * DESIGN RULE, and everything depends on it: we RE-DERIVE fields and types from the real schema on
 * every run. We never cache or copy them into a manifest. The failure mode of every manifest ever
 * built is DRIFT — the guide says Product has 5 fields, the schema grew a 6th, and now you generate
 * confidently wrong code. A manifest may store JUDGEMENT (which entity, which fields are worth
 * filtering on); it must never store DATA.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseMongoose, parseSequelize, parseDrizzle, parseTypeOrm, parsePlainJs } from './adapters.js';

export type FieldType = 'string' | 'number' | 'boolean' | 'date';

export interface EntityField {
  name: string;
  type: FieldType;
  required: boolean;
  isId: boolean;
  /** Enum-ish or a short constrained string — the fields worth FILTERING on. */
  isEnum: boolean;
  /**
   * The enum's ALLOWED VALUES.
   *
   * Carrying these is the difference between reading a schema and actually honouring it. Without
   * them, an enum column degrades to a free string and an importer will happily persist
   * `category=BANANA` into a column that only admits five values — the exact data-corruption bug a
   * benchmark session caught in this code, and had to fix by hand.
   */
  enumValues?: string[];
  /** Auto-generated (@default, @updatedAt): present in the DB, never supplied by an importer. */
  isGenerated: boolean;
}

export interface Entity {
  name: string;
  /** Where the truth lives, e.g. "prisma/schema.prisma#Product". Re-read every run. */
  source: string;
  fields: EntityField[];
  /**
   * Relations to other entities — recorded, never treated as columns.
   *
   * These used to be silently dropped, which is quietly wrong in two directions: a `supplier` relation
   * would either be omitted from the field list with no trace (so nobody knows it exists), or worse, be
   * mistaken for a scalar and end up in a sortable allowlist — where `?sort=supplier` sorts rows by
   * the string "[object Object]".
   *
   * They are excluded from sortable/filterable/CSV by construction (you cannot sort on an object, and
   * you cannot import one from a CSV cell), but they are surfaced so a future `?include=` recall has
   * something to work with, and so the generated code can say what it knows.
   */
  relations?: EntityRelation[];
  /** Which parser produced this — for diagnostics, and so a low-confidence source can be treated as such. */
  origin?: 'prisma' | 'typescript' | 'mongoose' | 'sequelize' | 'drizzle' | 'typeorm' | 'plain-js';
}

export interface EntityRelation {
  /** Field name on this entity, e.g. "supplier". */
  name: string;
  /** The entity it points at, e.g. "Supplier". */
  target: string;
  /** True for a to-many relation (an array). */
  list: boolean;
}

// Prisma scalar → our type lattice. Decimal/BigInt are numbers for validation purposes; anything
// unrecognized is a relation or an enum and is handled separately.
const PRISMA_SCALARS: Record<string, FieldType> = {
  String: 'string',
  Int: 'number',
  Float: 'number',
  Decimal: 'number',
  BigInt: 'number',
  Boolean: 'boolean',
  DateTime: 'date',
  Json: 'string',
};

const TS_SCALARS: Record<string, FieldType> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  Date: 'date',
};

/** Parse `model Foo { ... }` blocks out of a Prisma schema. */
function parsePrisma(schemaPath: string, relTo: string): Entity[] {
  let src: string;
  try { src = fs.readFileSync(schemaPath, 'utf-8'); } catch { return []; }

  // Capture each enum's MEMBERS, not just its name. The name alone tells you a column is constrained;
  // only the members let you actually enforce it.
  const enums = new Map<string, string[]>();
  for (const m of src.matchAll(/^\s*enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const members = m[2].split('\n').map(l => l.trim()).filter(l => /^\w+$/.test(l));
    enums.set(m[1], members);
  }

  const models = new Set<string>();
  for (const m of src.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) models.add(m[1]);

  const entities: Entity[] = [];
  const rel = path.relative(relTo, schemaPath).replace(/\\/g, '/');

  for (const block of src.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const name = block[1];
    const fields: EntityField[] = [];
    const relations: EntityRelation[] = [];

    for (const rawLine of block[2].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;

      const m = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (!m) continue;

      const [, fieldName, rawType, isList, optional, attrs] = m;

      // A list, or a type that is itself a model, is a RELATION — not a column we can sort, filter, or
      // import. Sorting on one would order rows by "[object Object]"; importing one from a CSV cell is
      // meaningless. RECORD it (so a future ?include= recall has something to work with) and move on.
      if (isList || models.has(rawType)) {
        if (models.has(rawType)) relations.push({ name: fieldName, target: rawType, list: !!isList });
        continue;
      }

      const isEnum = enums.has(rawType);
      const type = PRISMA_SCALARS[rawType] ?? (isEnum ? 'string' : null);
      if (!type) continue;   // unknown type — skip rather than guess

      const isId = /@id\b/.test(attrs);
      const isGenerated = /@default\(|@updatedAt\b/.test(attrs);

      fields.push({
        name: fieldName,
        type,
        required: !optional,
        isId,
        isEnum,
        enumValues: isEnum ? enums.get(rawType) : undefined,
        isGenerated,
      });
    }

    if (fields.length > 0) {
      entities.push({ name, source: `${rel}#${name}`, fields, relations, origin: 'prisma' });
    }
  }

  return entities;
}

/** Parse exported TS interfaces / types as a fallback type environment. */
function parseTsInterfaces(file: string, relTo: string): Entity[] {
  let src: string;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return []; }

  const entities: Entity[] = [];
  const rel = path.relative(relTo, file).replace(/\\/g, '/');

  for (const block of src.matchAll(/export\s+interface\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const name = block[1];
    const fields: EntityField[] = [];

    for (const rawLine of block[2].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

      const m = line.match(/^(\w+)(\?)?\s*:\s*([\w[\]|'" ]+);?/);
      if (!m) continue;

      const [, fieldName, optional, rawType] = m;
      const clean = rawType.trim().replace(/\[\]$/, '');
      if (rawType.trim().endsWith('[]')) continue;   // relation/collection

      // A union of string literals ('a' | 'b') is an enum in all but name — exactly the shape you
      // want to filter on, and its literals are exactly what you must validate against.
      const isEnum = /['"][^'"]+['"]\s*\|/.test(clean);
      const literals = isEnum ? [...clean.matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]) : undefined;
      const type = TS_SCALARS[clean] ?? (isEnum ? 'string' : null);
      if (!type) continue;

      fields.push({
        name: fieldName,
        type,
        required: !optional,
        isId: fieldName === 'id',
        isEnum,
        enumValues: literals,
        isGenerated: fieldName === 'id' || /^(createdAt|updatedAt)$/.test(fieldName),
      });
    }

    if (fields.length >= 2) entities.push({ name, source: `${rel}#${name}`, fields, origin: 'typescript' });
  }

  return entities;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'strata', '.next']);

/**
 * Find every entity the project declares. Deterministic, offline, zero tokens — it runs inside the
 * MCP server before the model sees a byte.
 */
export function extractEntities(projectDir: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
        continue;
      }
      const add = (ents: Entity[]): void => {
        for (const ent of ents) {
          if (!seen.has(ent.name)) { seen.add(ent.name); out.push(ent); }
        }
      };

      // Adapters run in confidence order: a declared schema beats an inferred one. The first source to
      // name an entity wins, so a project with both a Prisma schema and a loose JS model gets the
      // Prisma one — the schema is the truth, the model file is a convention.
      if (e.name.endsWith('.prisma')) {
        add(parsePrisma(full, projectDir));
        continue;
      }

      const isTs = /\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name);
      const isJs = /\.(js|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\.js$/.test(e.name);
      if (!isTs && !isJs) continue;

      // Each adapter self-selects on the file's contents and returns [] when it does not apply, so
      // running them all is cheap and order only matters for ties.
      add(parseTypeOrm(full, projectDir));      // decorators — unambiguous
      add(parseDrizzle(full, projectDir));      // pgTable(...) — unambiguous
      add(parseMongoose(full, projectDir));     // new Schema(...) — unambiguous
      add(parseSequelize(full, projectDir));    // .define('X', ...) — unambiguous
      if (isTs) add(parseTsInterfaces(full, projectDir));
      add(parsePlainJs(full, projectDir));      // LAST: convention only, lowest confidence
    }
  };

  walk(projectDir, 0);
  return out;
}

/**
 * Pick the entity this task is about — primarily from THE PROJECT, not from the task prose.
 *
 * This function used to score only against the `task` string the calling model passes. That was the
 * same class of mistake as the Haiku decomposition call it replaced: it put a NON-DETERMINISTIC input
 * at the front of a deterministic pipeline. Measured, and it voided an entire benchmark: the model
 * summarised a four-part brownfield task as `"catalog-service Express API additions"` — no entity
 * name anywhere — so nothing resolved, Strata emitted the GENERIC greenfield templates, and the
 * session then hand-wrote, across two edits, exactly the substitution this compiler exists to do.
 *
 * A project states its own primary entity structurally, and far more reliably than any prose does:
 * `Product` has `productRepository.js`; `Supplier` has nothing. Code beats prose. The task string is
 * now only a tie-breaker.
 */
export function resolveEntity(entities: Entity[], taskText: string, projectDir?: string): Entity | null {
  if (entities.length === 0) return null;

  const hay = ` ${taskText.toLowerCase()} `;

  // What the project ITSELF says about each entity: does it have a data module? a route? a directory?
  const projectFiles: string[] = [];
  if (projectDir) {
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
        } else {
          projectFiles.push(e.name.toLowerCase());
        }
      }
    };
    walk(projectDir, 0);
  }

  const scored: Array<{ entity: Entity; score: number }> = [];

  for (const entity of entities) {
    const lower = entity.name.toLowerCase();
    const plural = lower.endsWith('s') ? lower : `${lower}s`;
    let score = 0;

    // ── Structural evidence: what the project actually BUILT around this entity ──
    // A repository/store/service module named after an entity is the strongest statement a codebase
    // can make about which entity is load-bearing. Weight it above anything the prose says.
    for (const f of projectFiles) {
      if (new RegExp(`^${lower}s?(repository|repo|store|service|model|dao)\\.(js|ts)$`).test(f)) score += 6;
      else if (new RegExp(`^${lower}s?\\.(js|ts)$`).test(f)) score += 3;
    }

    // ── Prose evidence: a tie-breaker, nothing more ──
    if (hay.includes(` ${plural} `) || hay.includes(`/${plural}`)) score += 2;
    if (hay.includes(` ${lower} `) || hay.includes(`/${lower}`)) score += 1;

    if (score > 0) scored.push({ entity, score });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;

  // Require real evidence, not a coincidental substring.
  if (best.score < 2) return null;

  // ── AMBIGUITY: when two entities are comparably plausible, DO NOT GUESS. ─────
  //
  // A 20-entity project cannot be resolved from a four-word task string. If `Order` and `Invoice`
  // both have a repository and the task mentions neither by name, picking the higher score is a coin
  // flip dressed up as a decision.
  //
  // And a wrong entity is the single worst outcome this system can produce: the generated code
  // compiles, boots, passes a smoke test, and silently serves the WRONG ROWS — a bug nobody finds
  // until production. Abstaining is merely a missed optimisation: the template leaves an honest INJECT
  // slot and the model wires one line, which is what it was going to do anyway.
  //
  // Given the choice between guessing and abstaining, always abstain. This is where a committed
  // strata.json manifest (which entity serves which domain) would earn its place — a judgement call
  // the developer makes once, rather than one we re-guess on every run.
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) {
    console.error(
      `[strata] entity is AMBIGUOUS: ${best.entity.name} (${best.score}) vs ${runnerUp.entity.name} `
      + `(${runnerUp.score}) — refusing to guess. Name the entity in the task, or declare it in strata.json.`,
    );
    return null;
  }

  return best.entity;
}

/**
 * How much better the top entity must score before we trust it.
 *
 * 2 = one clear signal's worth of daylight. A repository module is worth 6, a plural mention in the
 * task 2 — so a tie between two entities that both have repositories, with nothing in the task to
 * separate them, correctly abstains.
 */
const AMBIGUITY_MARGIN = 2;

// ─── Derivations: judgement a machine CAN make ────────────────────────────────
//
// These are defaults, not decrees. A manifest may override any of them — that is precisely the split
// between DATA (re-derived) and JUDGEMENT (declared). But the defaults are good enough that a project
// with no manifest still gets working, entity-correct code, which keeps adoption friction at zero.

/** Every scalar is sortable. Sorting on a column is harmless; the allowlist just has to be finite. */
export function sortableFields(entity: Entity): string[] {
  return entity.fields.map(f => f.name);
}

/**
 * Filter on the fields with LOW cardinality — enums, booleans, and identifier-ish strings. Filtering
 * on a free-text `description` or a `price` is close to useless (you want a range, not equality),
 * and offering it just invites full scans.
 */
export function filterableFields(entity: Entity): string[] {
  return entity.fields
    .filter(f => !f.isId && (f.isEnum || f.type === 'boolean' || /^(sku|slug|status|kind|type|code|category|role|state)$/i.test(f.name)))
    .map(f => f.name);
}

/** The route path: pluralized, lower-cased entity name. `Product` → `/products`. */
export function routePath(entity: Entity): string {
  const n = entity.name.toLowerCase();
  if (n.endsWith('y') && !/[aeiou]y$/.test(n)) return `/${n.slice(0, -1)}ies`;
  if (/(s|sh|ch|x|z)$/.test(n)) return `/${n}es`;
  return `/${n}${n.endsWith('s') ? '' : 's'}`;
}

/**
 * Find the module that already loads this entity, so the generated route calls the project's OWN data
 * layer instead of inventing one.
 *
 * Deliberately conservative: the file must be NAMED after the entity (productRepository, products.js,
 * productStore) AND export a recognizable list function. If either test fails we return null and the
 * template leaves an honest INJECT slot. Guessing a data source wrong is the worst possible outcome —
 * the code would compile, run, and silently serve the wrong rows.
 */
export function resolveDataSource(
  projectDir: string,
  entity: Entity,
): { requireLine: string; expression: string; persistExpression: string | null } | null {
  const lower = entity.name.toLowerCase();
  const namePattern = new RegExp(`^${lower}s?(repository|repo|store|service|model|data)?\\.(js|ts)$`, 'i');
  const listFn = /(?:exports\.|export\s+(?:async\s+)?function\s+|export\s+const\s+)(findAll|getAll|list|all|findMany)\b/;
  const writeFn = /\b(insertMany|createMany|bulkCreate|saveAll|insert|create|add)\b/;

  let found: { file: string; fn: string; write: string | null } | null = null;

  const walk = (dir: string, depth: number): void => {
    if (found || depth > 5) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (found) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
        continue;
      }
      if (!namePattern.test(e.name)) continue;

      let src: string;
      try { src = fs.readFileSync(full, 'utf-8'); } catch { continue; }

      const exportBlock = src.match(/module\.exports\s*=\s*\{([^}]*)\}/)?.[1] ?? '';

      const fn = src.match(listFn)?.[1]
        ?? exportBlock.match(/\b(findAll|getAll|list|all|findMany)\b/)?.[1]
        ?? null;
      if (!fn) continue;

      // A bulk-write function, if the module exposes one. Only then can the import route persist
      // without the model wiring it by hand.
      const write = exportBlock.match(writeFn)?.[1]
        ?? src.match(new RegExp(`exports\\.${writeFn.source}`))?.[1]
        ?? null;

      found = { file: full, fn, write };
    }
  };

  walk(projectDir, 0);

  // `found` is only ever assigned inside the closure, which TS's control-flow analysis cannot see:
  // it still believes the value is the `null` it was initialised to, and narrows to `never` below.
  // The cast re-asserts the declared type.
  const hit = found as { file: string; fn: string; write: string | null } | null;
  if (!hit) return null;

  let rel = path.relative(projectDir, hit.file).replace(/\\/g, '/').replace(/\.(js|ts)$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;

  const varName = `${lower}Repository`;
  return {
    requireLine: `const ${varName} = require('${rel}');`,
    expression: `await ${varName}.${hit.fn}()`,
    persistExpression: hit.write ? `await ${varName}.${hit.write}(result.valid)` : null,
  };
}

/**
 * A csv-import schema, straight from the column types.
 *
 * Generated columns (@id, @default, @updatedAt) are EXCLUDED: the database supplies them, and an
 * importer that demands an `id` column in the CSV — or worse, accepts one — is wrong.
 */
export function csvSchemaFor(entity: Entity): string {
  const lines: string[] = [];

  for (const f of entity.fields) {
    if (f.isId || f.isGenerated) continue;

    const rules: string[] = [`type: '${f.type}'`, `required: ${f.required}`];
    if (f.type === 'number') {
      rules.push('min: 0');   // a negative price/quantity is nearly always a data error
    }
    if (f.type === 'string' && /email/i.test(f.name)) {
      rules[0] = `type: 'email'`;
    }
    // The enum's members. Without this the column degrades to a free string and the importer will
    // persist any value at all into a constrained column.
    if (f.isEnum && f.enumValues?.length) {
      rules.push(`oneOf: [${f.enumValues.map(v => "'" + v + "'").join(', ')}]`);
    }
    lines.push(`  ${f.name}: { ${rules.join(', ')} },`);
  }

  return `{\n${lines.join('\n')}\n}`;
}
