/**
 * THE OPERATION-KIND REGISTRY.
 *
 * A declared operation has to become two things: a handler that implements it, and a check that proves
 * the handler does what was declared. Before this file those lived apart — a `switch` in guide-routes.ts
 * emitted handlers, and a separate `COMPILERS` array in guide-checks.ts emitted checks — so nothing
 * structurally guaranteed that a generated behaviour had a generated proof. They could drift, and the
 * one time this project let generation and proof drift it printed `8/8 CHECKS PASSED` for a delivery
 * where nothing tested the delivered feature.
 *
 * So a KIND owns both halves, and adding the next one is a table entry rather than an engine edit. That
 * distinction is the whole point: hardcoded coverage is O(N) engine changes, which is exactly how the
 * verifier stalled at 7 recalls out of 22.
 *
 * WHAT A KIND MAY ASSUME. Only what HTTP or the declaration itself defines. A kind that needs to know
 * what the business means by a word does not belong here — it returns null from `match`, the operation
 * falls through to `custom`, and the author gets a named INJECT slot instead of a guess. Refusing must
 * stay cheap and frequent; a wrong guess that compiles is the worst output this system can produce.
 *
 * THE CHECK IS NOT OPTIONAL-ISH. `check` may return null, but only for a kind whose behaviour the floor
 * check already covers (that the route is served at all). It may never return null because the check was
 * awkward to write — an unproven generated behaviour must surface in the verifier's uncovered list, and
 * `checkGap` is how a kind says so in words rather than by silence.
 */
import { Domain, DomainOperation, DomainField } from './guide.js';
import { RecallCheck } from './verifier.js';

export interface Route { method: string; path: string; }

export interface KindContext {
  domain: Domain;
  op: DomainOperation;
  route: Route;
  /** Identifier of the store the handler calls into, e.g. "orderStore". */
  store: string;
  /** The domain's id field, defaulted. */
  idField: string;
  /** Extra state the matcher resolved — a transition's carrier and target, say. */
  meta?: Record<string, unknown>;
}

export interface OperationKind {
  id: string;
  /**
   * Does this operation belong to this kind? Return the resolved context, or null to decline.
   * Kinds are tried in registry order and the FIRST match wins, so more specific kinds come first.
   */
  match(domain: Domain, op: DomainOperation, route: Route): Record<string, unknown> | null;
  /** The body of the express handler. Receives everything `match` resolved. */
  handler(ctx: KindContext): string;
  /** The behavioural check. Null only when the floor check is genuinely the whole story. */
  check(ctx: KindContext): RecallCheck | null;
  /** When `check` returns null, the reason — surfaced in the verifier's uncovered list. */
  checkGap?: (ctx: KindContext) => string | null;
}

// ─── helpers shared by kinds ─────────────────────────────────────────────────

const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const notFound = (entity: string) => `      if (!row) return res.status(404).json({ error: '${entity} not found' });`;

/** One value satisfying a declared field. */
function sampleValue(f: { type: string; enumValues?: string[]; min?: number; items?: Record<string, { type: string; required?: boolean; min?: number; enumValues?: string[] }> }): unknown {
  if (f.enumValues?.length) return f.enumValues[0];
  switch (f.type) {
    case 'number':  return f.min != null ? f.min : 1;
    case 'boolean': return true;
    case 'date':    return new Date().toISOString();
    case 'array': {
      /**
       * Build the element from its DECLARED shape, never a guess.
       *
       * This was hardcoded to `[{ sku: 'strata-probe' }]`, which worked exactly as long as no domain
       * declared what an element must contain. The moment `items` gained a required `qty` with a
       * minimum, Strata's own probe body became invalid input — so the generated verifier failed on a
       * correct delivery, and the session spent thirty turns debugging code that was fine. A probe
       * that does not satisfy the schema the same generator emitted is not a test, it is a bug with a
       * green light next to it.
       */
      if (!f.items) return [];
      const el: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(f.items)) {
        if (spec.required || spec.min != null) el[k] = sampleValue(spec);
      }
      return [el];
    }
    default: return 'strata-probe';
  }
}

/** A minimal body satisfying the domain's required, non-generated fields. */
export function sampleBody(domain: Domain): string {
  const out: Record<string, unknown> = {};
  for (const f of domain.fields ?? []) {
    if (f.isId || f.generated || !f.required) continue;
    out[f.name] = sampleValue(f as Parameters<typeof sampleValue>[0]);
  }
  return JSON.stringify(out);
}

const hasParam = (p: string) => /:\w+/.test(p);
/** A trailing segment that is not a parameter, e.g. the "cancel" in /orders/:id/cancel. */
function verbSuffix(p: string): string | null {
  const segs = p.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last || /^:\w+$/.test(last)) return null;
  return hasParam(p) ? last : null;
}

// ─── STATE TRANSITION ────────────────────────────────────────────────────────

/**
 * English verb → the form a state value is usually written in.
 *
 * Irregulars only; everything else falls out of the two rules below. This is a table on purpose: a verb
 * is data, not a branch. Chosen across six unrelated domains so the kind cannot quietly become
 * order-specific — a deployment being promoted and a post being published must resolve by the same path.
 */
const IRREGULAR: Record<string, string> = {
  cancel: 'cancelled', cancelled: 'cancelled',
  fulfil: 'fulfilled', fulfill: 'fulfilled',
  ban: 'banned', flag: 'flagged', pause: 'paused', ship: 'shipped',
};

/** cancel → cancelled · publish → published · promote → promoted · deactivate → deactivated */
export function participles(verb: string): string[] {
  const v = verb.toLowerCase().replace(/[^a-z]/g, '');
  const out = new Set<string>();
  if (IRREGULAR[v]) out.add(IRREGULAR[v]);
  out.add(v);
  if (v.endsWith('e')) out.add(v + 'd'); else out.add(v + 'ed');
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(v)) out.add(v + v.slice(-1) + 'ed');   // ban → banned
  return [...out];
}

export type Carrier =
  | { kind: 'enum';      field: string; to: string }
  | { kind: 'boolean';   field: string; to: boolean }
  | { kind: 'timestamp'; field: string; to: 'now' | null };

/**
 * Find the field that carries this operation's state, and the value it moves to.
 *
 * Three encodings, because real backends use all three and picking one would make the kind serve a
 * third of the cases it should:
 *
 *   enum       status: pending -> cancelled          (an order, a deployment, a moderation queue)
 *   boolean    active: true -> false                 (a user, a feature flag)
 *   timestamp  deletedAt: null -> now()              (soft delete, publishing, archiving)
 *
 * The timestamp carrier is not speculative: data.softdelete.v1 already ships this pattern, so one
 * compiler serves an existing recall and every declared transition alike.
 *
 * AMBIGUITY IS A REFUSAL. If two carriers match, this returns null and the operation gets a slot.
 * Choosing between them would be a guess about the author's data model, and a wrong guess here writes a
 * state machine that compiles, boots, and silently corrupts records.
 */
export function findCarrier(domain: Domain, verb: string): Carrier | null {
  const forms = participles(verb);
  const fields = domain.fields ?? [];
  const hits: Carrier[] = [];

  for (const f of fields) {
    // 1. enum member matching the verb's participle
    if (f.enumValues?.length) {
      const v = f.enumValues.find(x => forms.includes(String(x).toLowerCase()));
      if (v) hits.push({ kind: 'enum', field: f.name, to: String(v) });
    }
    // 2. boolean whose NAME is the verb, in either direction:
    //      publish    -> published   (participle)
    //      activate   -> active      (verb/adjective stem — NOT a participle, so the forms above miss it)
    //      deactivate -> active:false
    //
    // The stem comparison is the same device scoreRecall uses for "idempotent" vs "idempotency": two
    // forms of one word share a long prefix even when neither is derivable from the other by suffix
    // rules. Five characters is short enough to catch activate/active and long enough that unrelated
    // fields do not collide.
    if (f.type === 'boolean') {
      const n = f.name.toLowerCase();
      const negated = /^(de|un|dis)/.test(verb.toLowerCase());
      const base = verb.toLowerCase().replace(/^(de|un|dis)/, '');
      const STEM = 5;
      const sameStem = n.length >= STEM && base.length >= STEM && n.slice(0, STEM) === base.slice(0, STEM);
      if (forms.includes(n) || n === base || participles(base).includes(n) || sameStem) {
        hits.push({ kind: 'boolean', field: f.name, to: !negated });
      }
    }
    // 3. nullable timestamp named <participle>At / <verb>At
    if (f.type === 'date') {
      const n = f.name.toLowerCase().replace(/_?at$/, '');
      if (forms.includes(n)) hits.push({ kind: 'timestamp', field: f.name, to: 'now' });
    }
  }

  // Deduplicate identical carriers (an enum and its own name can both match) then refuse on a real tie.
  const uniq = hits.filter((h, i) => hits.findIndex(x => x.kind === h.kind && x.field === h.field) === i);
  return uniq.length === 1 ? uniq[0] : null;
}

/**
 * States the operation may run FROM, read off `requires`.
 *
 * `requires` entries like "order.status === 'pending'" are already code expressions — the author wrote
 * the precondition, we only have to read it. Anything not in that shape is left alone rather than
 * interpreted.
 */
export function fromStates(op: DomainOperation, carrierField: string): string[] {
  const out: string[] = [];
  for (const r of op.requires ?? []) {
    const re = new RegExp(`\\b${carrierField}\\b\\s*(?:===|==|is|:)\\s*['"\`]([\\w-]+)['"\`]`, 'i');
    const m = r.match(re);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Does the declaration say re-applying is a no-op rather than an error? */
export function declaredIdempotent(op: DomainOperation): boolean {
  const t = op.transition as { idempotent?: boolean } | undefined;
  if (t && typeof t.idempotent === 'boolean') return t.idempotent;
  return /idempotent|no-?op|not an error|already .* is (fine|ok|allowed)/i.test(op.guarantees ?? '');
}

const transitionKind: OperationKind = {
  id: 'transition',
  match(domain, op, route) {
    if (route.method === 'GET') return null;
    // LEVEL 1 — declared as data. Zero inference; the author states the transition outright.
    const declared = op.transition as
      { on?: string; from?: string[]; to?: unknown; idempotent?: boolean } | undefined;
    if (declared?.on && declared.to !== undefined) {
      const f = (domain.fields ?? []).find(x => x.name === declared.on);
      const kind: Carrier['kind'] = f?.type === 'boolean' ? 'boolean' : f?.type === 'date' ? 'timestamp' : 'enum';
      return { carrier: { kind, field: declared.on, to: declared.to } as Carrier,
        from: declared.from ?? [], idempotent: declaredIdempotent(op) };
    }
    // LEVEL 2 — compile it. Needs a verb suffix in the path and a carrier that matches it.
    const verb = verbSuffix(route.path) ?? (op.name.match(/^([a-z]+)/i) || [])[1];
    if (!verb) return null;
    const carrier = findCarrier(domain, verb);
    if (!carrier) return null;
    return { carrier, from: fromStates(op, carrier.field), idempotent: declaredIdempotent(op) };
  },
  handler(ctx) {
    const c = ctx.meta!.carrier as Carrier;
    const from = ctx.meta!.from as string[];
    const idem = ctx.meta!.idempotent as boolean;
    const target = c.kind === 'timestamp'
      ? (c.to === 'now' ? 'new Date().toISOString()' : 'null')
      : JSON.stringify(c.to);
    const at = `row.${c.field}`;
    const already = c.kind === 'timestamp' ? `${at} != null` : `${at} === ${target}`;
    const guardFrom = from.length
      ? `      if (!${JSON.stringify(from)}.includes(${at})) {
        return res.status(409).json({ error: '${ctx.domain.entity} cannot be ${String(c.to)} from ' + ${at} });
      }\n`
      : '';
    // Idempotency is checked BEFORE the from-guard: re-applying a completed transition must be a no-op,
    // and the current state is by definition not in the from-set, so the guard would reject it.
    const idemBlock = idem
      ? `      if (${already}) return res.json(row);   // already ${String(c.to)} — declared idempotent\n`
      : `      if (${already}) {
        return res.status(409).json({ error: '${ctx.domain.entity} is already ${String(c.to)}' });
      }\n`;
    return `      const row = ${ctx.store}.get(req.params.${ctx.idField});
${notFound(ctx.domain.entity)}
${idemBlock}${guardFrom}      const updated = ${ctx.store}.update(req.params.${ctx.idField}, { ${c.field}: ${target} });
      res.json(updated);`;
  },
  check(ctx) {
    const c = ctx.meta!.carrier as Carrier;
    const idem = ctx.meta!.idempotent as boolean;
    const body = sampleBody(ctx.domain);
    const create = (ctx.domain.operations ?? []).find(o => /^(POST)\s+\/\w[\w-]*$/i.test(o.route ?? ''));
    if (!create) return null;   // nothing to create a subject with — floor check is all we can honestly do
    const createPath = create.route!.split(/\s+/)[1];
    const applyPath = ctx.route.path.replace(/:(\w+)/, "' + id + '");
    const expect = c.kind === 'timestamp'
      ? `assert(after.body && after.body.${c.field} != null, 'after ${ctx.op.name} the ${c.field} timestamp must be set — the declared transition did not happen');`
      : `assert(after.body && String(after.body.${c.field}) === ${JSON.stringify(String(c.to))}, 'after ${ctx.op.name} the ${c.field} must be ' + ${JSON.stringify(String(c.to))} + ', got ' + JSON.stringify(after.body && after.body.${c.field}));`;
    return {
      name: `${ctx.domain.entity}.${ctx.op.name}: moves ${c.field} to ${String(c.to)}${idem ? ', idempotently' : ''}`,
      code: [
        `const made = await post('${createPath}', ${JSON.stringify(body)}, 'application/json');`,
        `assert(made.status >= 200 && made.status < 300, 'could not create a ${ctx.domain.entity} to transition (' + made.status + '), so the transition is undemonstrable');`,
        `const id = made.body && (made.body.${ctx.idField} ?? made.body.id);`,
        `assert(id !== undefined, 'the created ${ctx.domain.entity} carried no id, so it cannot be transitioned');`,
        `const after = await post('${applyPath}', '{}', 'application/json');`,
        `assert(after.status >= 200 && after.status < 300, '${ctx.op.name} returned ' + after.status);`,
        expect,
        idem
          ? `const again = await post('${applyPath}', '{}', 'application/json');\nassert(again.status >= 200 && again.status < 300, 'the guide declares ${ctx.op.name} idempotent, but repeating it returned ' + again.status);`
          : `const again = await post('${applyPath}', '{}', 'application/json');\nassert(again.status === 409 || again.status === 422, 'the guide does NOT declare ${ctx.op.name} idempotent, so repeating it must be refused, got ' + again.status);`,
      ].join('\n'),
    };
  },
  checkGap: (ctx) => `${ctx.domain.entity}.${ctx.op.name} — the domain declares no create operation, so the transition cannot be exercised`,
};

// ─── the five shapes HTTP itself defines ─────────────────────────────────────
//
// Moved here UNCHANGED from guide-routes.ts. These are transcription, not interpretation: the method
// and path say what they do, and no business knowledge is involved.

const httpKind = (
  id: string,
  matches: (r: Route) => boolean,
  handler: (ctx: KindContext) => string,
  check?: (ctx: KindContext) => RecallCheck | null,
): OperationKind => ({
  id,
  match: (_d, _o, r) => (matches(r) && !verbSuffix(r.path) ? {} : null),
  handler,
  check: check ?? (() => null),
  checkGap: () => null,   // the floor check (route is served) is the whole story for these
});

const createKind = httpKind('create',
  r => r.method === 'POST' && !hasParam(r.path),
  ctx => `      const created = ${ctx.store}.create(req.body || {});
      res.status(201).json(created);`,
  ctx => ({
    name: `${ctx.domain.entity}.${ctx.op.name}: creates a record and returns it with an id`,
    code: [
      `const res1 = await post('${ctx.route.path}', ${JSON.stringify(sampleBody(ctx.domain))}, 'application/json');`,
      `assert(res1.status >= 200 && res1.status < 300, '${ctx.route.method} ${ctx.route.path} returned ' + res1.status + ' for a body built from the declared required fields');`,
      `assert(res1.body && (res1.body.${ctx.idField} ?? res1.body.id) !== undefined, 'a created ${ctx.domain.entity} must come back with an id — without one nothing downstream can reference it');`,
    ].join('\n'),
  }));

const listKind = httpKind('list',
  r => r.method === 'GET' && !hasParam(r.path),
  ctx => `      res.json({ data: ${ctx.store}.list() });`,
  ctx => ({
    name: `${ctx.domain.entity}.${ctx.op.name}: returns a list`,
    code: [
      `const res1 = await get('${ctx.route.path}');`,
      `assert(res1.status === 200, 'GET ${ctx.route.path} returned ' + res1.status);`,
      `const rows = res1.body && (Array.isArray(res1.body) ? res1.body : res1.body.data);`,
      `assert(Array.isArray(rows), 'a list operation must return an array (or { data: [...] }), got ' + JSON.stringify(res1.body).slice(0, 80));`,
    ].join('\n'),
  }));

const readKind = httpKind('read',
  r => r.method === 'GET' && hasParam(r.path),
  ctx => `      const row = ${ctx.store}.get(req.params.${ctx.idField});
${notFound(ctx.domain.entity)}
      res.json(row);`);

const updateKind = httpKind('update',
  r => r.method === 'PUT' || r.method === 'PATCH',
  ctx => `      const row = ${ctx.store}.update(req.params.${ctx.idField}, req.body || {});
${notFound(ctx.domain.entity)}
      res.json(row);`);

const deleteKind = httpKind('delete',
  r => r.method === 'DELETE',
  ctx => `      const row = ${ctx.store}.get(req.params.${ctx.idField});
${notFound(ctx.domain.entity)}
      ${ctx.store}.remove ? ${ctx.store}.remove(req.params.${ctx.idField}) : null;
      res.status(204).end();`);

/**
 * The custom fallback. Loads the record, then STOPS.
 *
 * This is not a failure mode, it is the designed exit. An operation whose meaning lives only in the
 * author's head gets a real endpoint and a named slot; inventing the rule would produce code that
 * compiles, boots, passes a smoke test and is quietly wrong.
 */
const customKind: OperationKind = {
  id: 'custom',
  match: () => ({}),
  handler: ctx => `      const row = ${ctx.store}.get(req.params.${ctx.idField});
${notFound(ctx.domain.entity)}
      // INJECT: apply the rule for "${ctx.op.name}"${ctx.op.guarantees ? ` — the guide declares: ${ctx.op.guarantees.replace(/\s+/g, ' ').slice(0, 120)}` : ''}
      res.json(row);`,
  check: () => null,
  checkGap: ctx => `${ctx.domain.entity}.${ctx.op.name} — left as an INJECT slot; its rule is not derivable from the declaration`,
};

/**
 * ORDER MATTERS: most specific first. `transition` is tried before the HTTP shapes because
 * POST /orders/:id/cancel is a POST, and without this it would be read as a create.
 */
export const KINDS: OperationKind[] = [
  transitionKind,
  createKind, listKind, readKind, updateKind, deleteKind,
  customKind,   // always last; matches everything
];

export function resolveKind(domain: Domain, op: DomainOperation, route: Route): { kind: OperationKind; meta: Record<string, unknown> } {
  for (const k of KINDS) {
    const meta = k.match(domain, op, route);
    if (meta) return { kind: k, meta };
  }
  return { kind: customKind, meta: {} };
}

export { camel };
