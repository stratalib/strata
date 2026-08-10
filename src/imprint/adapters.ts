/**
 * Entity adapters — one parser per schema source.
 *
 * The compiler assumed Prisma. Every other project silently fell back to generic INJECT slots, which
 * is the degraded path we know costs turns: the session renames our `/items` to `/products`, then has
 * to go and repair the verifier we pointed at the old URL.
 *
 * Each adapter returns the same `Entity` shape, so the substitution layer never learns which ORM the
 * project uses. Adding a stack is ~100 lines here — nothing downstream changes.
 *
 * THE RULE, and it is not negotiable: AN ADAPTER THAT IS NOT CONFIDENT RETURNS NOTHING.
 *
 * A wrong entity is the worst failure mode available to us. It generates code that compiles, boots,
 * passes a smoke test, and silently serves the wrong rows — a bug nobody finds until production. No
 * entity is merely a missed optimisation: the template leaves an honest INJECT slot and the model
 * wires one line. Given the choice between guessing and abstaining, always abstain.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Entity, EntityField, EntityRelation, FieldType } from './entities.js';

/** Does this look like a generated/managed column the DB supplies rather than the caller? */
const GENERATED_NAME = /^(id|_id|createdAt|created_at|updatedAt|updated_at|deletedAt|deleted_at)$/i;

function field(
  name: string,
  type: FieldType,
  opts: Partial<EntityField> = {},
): EntityField {
  return {
    name,
    type,
    required: opts.required ?? true,
    isId: opts.isId ?? /^(id|_id)$/i.test(name),
    isEnum: opts.isEnum ?? false,
    enumValues: opts.enumValues,
    isGenerated: opts.isGenerated ?? GENERATED_NAME.test(name),
  };
}

/** Balanced-brace slice starting at the first `{` after `from`. Regex cannot match nested braces. */
function braceBlock(src: string, from: number): { body: string; end: number } | null {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/**
 * Split an object body into top-level `key: value` pairs.
 *
 * Naive splitting on commas breaks the moment a field is itself an object —
 * `price: { type: Number, min: 0 }` becomes three garbage fields. Depth tracking is the whole point.
 */
function topLevelPairs(body: string): Array<{ key: string; value: string }> {
  const chunks: string[] = [];
  let depth = 0;
  let buf = '';

  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { chunks.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) chunks.push(buf);

  const pairs: Array<{ key: string; value: string }> = [];
  for (const chunk of chunks) {
    const i = chunk.indexOf(':');
    if (i < 0) continue;
    const key = chunk.slice(0, i).trim().replace(/['"]/g, '');
    if (!/^\w+$/.test(key)) continue;
    pairs.push({ key, value: chunk.slice(i + 1).trim() });
  }
  return pairs;
}

/** Pull `['A','B']` / `["A","B"]` out of an enum declaration. */
function literals(value: string): string[] | undefined {
  const m = value.match(/\[([^\]]*)\]/);
  if (!m) return undefined;
  const vals = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  return vals.length ? vals : undefined;
}

// ─── Mongoose ────────────────────────────────────────────────────────────────
//   new Schema({ sku: { type: String, required: true }, price: { type: Number, min: 0 },
//                category: { type: String, enum: ['A','B'] }, supplier: { type: ObjectId, ref: 'Supplier' } })

const MONGOOSE_TYPES: Record<string, FieldType> = {
  String: 'string', Number: 'number', Boolean: 'boolean', Date: 'date', Decimal128: 'number',
};

export function parseMongoose(file: string, relTo: string): Entity[] {
  let src: string;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  if (!/mongoose|new Schema\s*\(/.test(src)) return [];

  const rel = path.relative(relTo, file).replace(/\\/g, '/');
  const out: Entity[] = [];

  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)Schema\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(/g)) {
    const block = braceBlock(src, m.index! + m[0].length - 1);
    if (!block) continue;

    const name = m[1][0].toUpperCase() + m[1].slice(1);
    const fields: EntityField[] = [];
    const relations: EntityRelation[] = [];

    for (const { key, value } of topLevelPairs(block.body)) {
      // A ref is a RELATION, not a column. Sorting on it would sort by "[object Object]".
      const ref = value.match(/ref\s*:\s*['"](\w+)['"]/);
      if (ref) {
        relations.push({ name: key, target: ref[1], list: value.trim().startsWith('[') });
        continue;
      }

      // `price: Number` (shorthand) or `price: { type: Number, ... }`
      const typeName = (value.match(/type\s*:\s*(\w+)/) ?? value.match(/^(\w+)/))?.[1];
      if (!typeName || !MONGOOSE_TYPES[typeName]) continue;

      const enumValues = /enum\s*:/.test(value) ? literals(value) : undefined;
      fields.push(field(key, MONGOOSE_TYPES[typeName], {
        // In Mongoose, absent `required` means optional — the opposite of Prisma's default.
        required: /required\s*:\s*true/.test(value),
        isEnum: !!enumValues,
        enumValues,
        isGenerated: GENERATED_NAME.test(key) || /default\s*:/.test(value),
      }));
    }

    // Mongoose always adds _id. Record it so pagination has a stable tiebreak key.
    if (!fields.some((f) => f.isId)) {
      fields.unshift(field('_id', 'string', { isId: true, isGenerated: true }));
    }

    if (fields.length >= 2) {
      out.push({ name, source: `${rel}#${name}`, fields, relations, origin: 'mongoose' });
    }
  }

  return out;
}

// ─── Sequelize ───────────────────────────────────────────────────────────────
//   sequelize.define('Product', { sku: { type: DataTypes.STRING, allowNull: false }, ... })

const SEQUELIZE_TYPES: Record<string, FieldType> = {
  STRING: 'string', TEXT: 'string', UUID: 'string', CHAR: 'string',
  INTEGER: 'number', BIGINT: 'number', FLOAT: 'number', DOUBLE: 'number', DECIMAL: 'number', REAL: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date', DATEONLY: 'date',
  ENUM: 'string',
};

export function parseSequelize(file: string, relTo: string): Entity[] {
  let src: string;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  if (!/sequelize|DataTypes/.test(src)) return [];

  const rel = path.relative(relTo, file).replace(/\\/g, '/');
  const out: Entity[] = [];

  for (const m of src.matchAll(/\.define\s*\(\s*['"](\w+)['"]\s*,/g)) {
    const block = braceBlock(src, m.index! + m[0].length);
    if (!block) continue;

    const name = m[1][0].toUpperCase() + m[1].slice(1);
    const fields: EntityField[] = [];

    for (const { key, value } of topLevelPairs(block.body)) {
      const typeName = value.match(/DataTypes\.(\w+)/)?.[1];
      if (!typeName || !SEQUELIZE_TYPES[typeName]) continue;

      const enumValues = typeName === 'ENUM' ? literals(value) : undefined;
      fields.push(field(key, SEQUELIZE_TYPES[typeName], {
        // Sequelize defaults allowNull to TRUE — a column is optional unless it says otherwise.
        required: /allowNull\s*:\s*false/.test(value) || /primaryKey\s*:\s*true/.test(value),
        isId: /primaryKey\s*:\s*true/.test(value) || /^id$/i.test(key),
        isEnum: !!enumValues,
        enumValues,
        isGenerated: GENERATED_NAME.test(key) || /autoIncrement|defaultValue/.test(value),
      }));
    }

    if (!fields.some((f) => f.isId)) {
      fields.unshift(field('id', 'number', { isId: true, isGenerated: true }));
    }
    if (fields.length >= 2) out.push({ name, source: `${rel}#${name}`, fields, origin: 'sequelize' });
  }

  return out;
}

// ─── Drizzle ─────────────────────────────────────────────────────────────────
//   export const products = pgTable('products', {
//     id: serial('id').primaryKey(),
//     sku: varchar('sku', { length: 64 }).notNull(),
//     category: pgEnum('category', ['A','B'])('category'),
//   })

const DRIZZLE_TYPES: Record<string, FieldType> = {
  serial: 'number', integer: 'number', bigint: 'number', smallint: 'number',
  numeric: 'number', decimal: 'number', real: 'number', doublePrecision: 'number',
  varchar: 'string', text: 'string', char: 'string', uuid: 'string',
  boolean: 'boolean',
  timestamp: 'date', date: 'date', time: 'date',
};

export function parseDrizzle(file: string, relTo: string): Entity[] {
  let src: string;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  if (!/pgTable|mysqlTable|sqliteTable/.test(src)) return [];

  const rel = path.relative(relTo, file).replace(/\\/g, '/');
  const out: Entity[] = [];

  // Enums are declared separately: export const categoryEnum = pgEnum('category', ['A','B'])
  const enums = new Map<string, string[]>();
  for (const e of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*pgEnum\s*\(\s*['"][^'"]+['"]\s*,\s*\[([^\]]*)\]/g)) {
    const vals = [...e[2].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (vals.length) enums.set(e[1], vals);
  }

  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:pg|mysql|sqlite)Table\s*\(\s*['"](\w+)['"]\s*,/g)) {
    const block = braceBlock(src, m.index! + m[0].length);
    if (!block) continue;

    // Singularise the table name: `products` -> `Product`.
    const raw = m[2].replace(/s$/, '');
    const name = raw[0].toUpperCase() + raw.slice(1);

    const fields: EntityField[] = [];
    for (const { key, value } of topLevelPairs(block.body)) {
      const enumRef = value.match(/(\w+Enum)\s*\(/)?.[1];
      const enumValues = enumRef ? enums.get(enumRef) : undefined;

      const typeName = value.match(/^(\w+)\s*\(/)?.[1];
      const type: FieldType | undefined = enumValues ? 'string' : (typeName ? DRIZZLE_TYPES[typeName] : undefined);
      if (!type) continue;

      fields.push(field(key, type, {
        // Drizzle columns are nullable unless .notNull(); a primary key is implicitly required.
        required: /\.notNull\(\)/.test(value) || /\.primaryKey\(\)/.test(value),
        isId: /\.primaryKey\(\)/.test(value),
        isEnum: !!enumValues,
        enumValues,
        isGenerated: /serial\s*\(|\.defaultNow\(\)|\.default\(/.test(value) || GENERATED_NAME.test(key),
      }));
    }

    if (fields.length >= 2) out.push({ name, source: `${rel}#${name}`, fields, origin: 'drizzle' });
  }

  return out;
}

// ─── TypeORM ─────────────────────────────────────────────────────────────────
//   @Entity() export class Product {
//     @PrimaryGeneratedColumn() id: number;
//     @Column({ type: 'varchar', nullable: false }) sku: string;
//     @ManyToOne(() => Supplier) supplier: Supplier;
//   }

export function parseTypeOrm(file: string, relTo: string): Entity[] {
  let src: string;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  if (!/@Entity\s*\(/.test(src)) return [];

  const rel = path.relative(relTo, file).replace(/\\/g, '/');
  const out: Entity[] = [];

  for (const m of src.matchAll(/@Entity\s*\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g)) {
    const block = braceBlock(src, m.index! + m[0].length);
    if (!block) continue;

    const name = m[1];
    const fields: EntityField[] = [];
    const relations: EntityRelation[] = [];

    // Decorators sit on their own line above the property they annotate.
    const lines = block.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const deco = lines[i].trim();
      if (!deco.startsWith('@')) continue;

      // A relation decorator: capture the target and move on. It is not a column.
      const relDeco = deco.match(/@(ManyToOne|OneToMany|ManyToMany|OneToOne)\s*\(\s*\(\)\s*=>\s*(\w+)/);
      const propLine = (lines[i + 1] ?? '') + (lines[i] ?? '');
      const prop = propLine.match(/(\w+)\s*[?!]?\s*:\s*([\w[\]<>]+)/);

      if (relDeco && prop) {
        relations.push({
          name: prop[1],
          target: relDeco[2],
          list: /OneToMany|ManyToMany/.test(relDeco[1]) || /\[\]/.test(prop[2]),
        });
        continue;
      }

      const isCol = /@(Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn)\b/.test(deco);
      if (!isCol || !prop) continue;

      const tsType = prop[2].replace(/\[\]$/, '');
      const type: FieldType | undefined =
        tsType === 'string' ? 'string'
        : tsType === 'number' ? 'number'
        : tsType === 'boolean' ? 'boolean'
        : tsType === 'Date' ? 'date'
        : undefined;
      if (!type) continue;

      const enumValues = /enum\s*:/.test(deco) ? literals(deco) : undefined;
      fields.push(field(prop[1], type, {
        required: !/nullable\s*:\s*true/.test(deco) && !/\?\s*:/.test(propLine),
        isId: /PrimaryColumn|PrimaryGeneratedColumn/.test(deco),
        isEnum: !!enumValues,
        enumValues,
        isGenerated: /PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|default\s*:/.test(deco),
      }));
    }

    if (fields.length >= 2) {
      out.push({ name, source: `${rel}#${name}`, fields, relations, origin: 'typeorm' });
    }
  }

  return out;
}

// ─── Plain JS models — the lowest-confidence adapter ──────────────────────────
//   models/product.js:  module.exports = { name: 'Product', fields: { sku: 'string', price: 'number' } }
//
// There is no schema here, only a convention. This adapter therefore demands an EXPLICIT, declarative
// shape and refuses to infer one from, say, an object literal that happens to look like a record.
// Inferring a schema from sample data is exactly how you get a confidently wrong entity — the field is
// a string in every row you looked at and a number in the one you didn't.
export function parsePlainJs(file: string, relTo: string): Entity[] {
  let src: string;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return []; }

  // The declaration must be deliberate. No `fields:` block, no entity — we do not guess.
  if (!/fields\s*:\s*\{/.test(src)) return [];

  const nameMatch = src.match(/name\s*:\s*['"](\w+)['"]/);
  if (!nameMatch) return [];

  const at = src.search(/fields\s*:\s*\{/);
  const block = braceBlock(src, at);
  if (!block) return [];

  const rel = path.relative(relTo, file).replace(/\\/g, '/');
  const fields: EntityField[] = [];

  for (const { key, value } of topLevelPairs(block.body)) {
    const t = value.replace(/['"]/g, '').trim().toLowerCase();
    const type: FieldType | undefined =
      t.startsWith('string') ? 'string'
      : t.startsWith('number') ? 'number'
      : t.startsWith('bool') ? 'boolean'
      : t.startsWith('date') ? 'date'
      : undefined;
    if (!type) continue;

    fields.push(field(key, type, {
      required: !t.includes('?') && !t.includes('optional'),
      isGenerated: GENERATED_NAME.test(key),
    }));
  }

  if (fields.length < 2) return [];
  if (!fields.some((f) => f.isId)) fields.unshift(field('id', 'number', { isId: true, isGenerated: true }));

  return [{ name: nameMatch[1], source: `${rel}#${nameMatch[1]}`, fields, origin: 'plain-js' }];
}
