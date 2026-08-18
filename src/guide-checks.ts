/**
 * Turn a guide's declared `guarantees` into verifier checks — or admit, in writing, that we could not.
 *
 * WHY THIS EXISTS AND WHY IT COMES BEFORE ROUTE GENERATION.
 *
 * The guide's two halves have very different standing. The data half (datastores, layout, fields) is
 * checkable against the repo, and `guide-factcheck.ts` checks it. The domain half — operations,
 * requires, guarantees — describes INTENT, often for a domain that does not exist yet. Nothing can
 * fact-check "a retried request returns the original order" against a project with no orders.
 *
 * That matters because the next step generates real code from those declarations. Generating from an
 * unverifiable claim and then reporting a confident pass is precisely the failure measured on
 * 2026-08-16: `8/8 CHECKS PASSED — the delivered feature works end to end`, where all eight checks
 * belonged to other recalls and nothing exercised the delivered feature at all. The session believed
 * it, and the run cost 2.26x baseline.
 *
 * So a declared guarantee must arrive with the check that proves it, or be NAMED as unproven. There is
 * no third option, and in particular "compile something vaguely related and call it covered" is worse
 * than silence, because it converts an unknown into a false green.
 *
 * WHAT IS COMPILABLE. Free-form English is not mechanically translatable into an assertion, and
 * pretending otherwise would be the same self-deception one layer down. So this recognises a small,
 * explicit set of guarantee SHAPES that recur in backend work, and compiles only those. Everything
 * else — the majority, by design — is returned as `uncovered` and printed by the verifier's coverage
 * block, which v1.1 already emits.
 */
import { StrataGuide, Domain, DomainOperation } from './guide.js';
import { RecallCheck } from './verifier.js';

/** `POST /orders` → { method, path }. Returns null for a route we cannot parse. */
function parseRoute(route: string | undefined): { method: string; path: string } | null {
  if (!route) return null;
  const m = route.trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i);
  if (!m) return null;
  return { method: m[1].toUpperCase(), path: m[2] };
}

/** JS literal for a minimal body that satisfies the domain's required, non-generated fields. */
function sampleBody(domain: Domain): string {
  const out: Record<string, unknown> = {};
  for (const f of domain.fields ?? []) {
    if (f.isId || f.generated) continue;
    if (!f.required) continue;
    if (f.enumValues?.length) { out[f.name] = f.enumValues[0]; continue; }
    switch (f.type) {
      case 'number':  out[f.name] = 1; break;
      case 'boolean': out[f.name] = true; break;
      case 'date':    out[f.name] = new Date().toISOString(); break;
      default:        out[f.name] = `strata-probe`; break;
    }
  }
  return JSON.stringify(out);
}

interface Compiler {
  id: string;
  /** Does this guarantee read like the shape this compiler proves? */
  match: RegExp;
  build: (op: DomainOperation, domain: Domain, r: { method: string; path: string }) => RecallCheck | null;
}

/**
 * The recognised shapes. Each compiler produces an assertion anchored on a POSITIVE outcome, because a
 * check that only asserts "not an error" passes against an app that never implemented the behaviour —
 * proven the hard way this morning, when unwiring a middleware left 3 of 4 new checks still green.
 */
const COMPILERS: Compiler[] = [
  {
    id: 'idempotent-replay',
    match: /retr(y|ied|ies).*(same|identical).*(key|request)|never.*duplicate|exactly.?once|at.?most.?once|returns the (original|stored|first)/i,
    build: (op, domain, r) => {
      if (r.method === 'GET') return null;
      const body = sampleBody(domain);
      return {
        name: `${domain.entity}.${op.name}: a retried request with the same key does not create a second record`,
        code: [
          `const key = 'strata-guarantee-' + Date.now();`,
          `const body = ${JSON.stringify(body)};`,
          `const a = await post('${r.path}', body, 'application/json', { 'idempotency-key': key });`,
          `assert(a.status >= 200 && a.status < 300, '${r.method} ${r.path} first call returned ' + a.status + ' — the declared operation must succeed before its guarantee can hold.');`,
          `const b = await post('${r.path}', body, 'application/json', { 'idempotency-key': key });`,
          `assert(b.status === a.status, 'a replay returned ' + b.status + ' but the original returned ' + a.status + '; the guide declares the retry returns the original response.');`,
          `const idOf = (x) => x && x.body && (x.body.id ?? x.body._id ?? (x.body.data && x.body.data.id));`,
          `if (idOf(a) !== undefined) assert(idOf(b) === idOf(a), 'the replay produced a DIFFERENT record (' + idOf(b) + ' vs ' + idOf(a) + ') — that is the duplicate the guarantee forbids.');`,
        ].join('\n'),
      };
    },
  },
  {
    id: 'endpoint-exists',
    // Not a guarantee compiler — the floor. A declared operation whose route does not answer at all
    // cannot have any of its guarantees hold, and saying so early makes every later failure readable.
    match: /.*/,
    build: (op, domain, r) => ({
      name: `${domain.entity}.${op.name}: ${r.method} ${r.path} is served`,
      code: [
        r.method === 'GET'
          ? `const res = await get('${r.path}');`
          : `const res = await post('${r.path}', ${JSON.stringify(sampleBody(domain))}, 'application/json');`,
        // A 404 alone does not mean "unrouted". A parameterised path probed with a literal ":id" is
        // SERVED and correctly answers 404 for a record that does not exist — the first draft of this
        // check read that as "nothing serves it" and failed a route that was working. The discriminator
        // is the body: Express's unmatched-route 404 is HTML, a served handler's 404 is JSON.
        `const routed = res.status !== 404 || (res.body !== undefined && res.body !== null);`,
        `assert(routed, '${r.method} ${r.path} returned an unrouted 404 (HTML, not JSON) — the guide declares this operation, and nothing serves it.');`,
      ].join('\n'),
    }),
  },
];

export interface GuideCheckResult {
  checks: RecallCheck[];
  /** Declared guarantees no compiler could express, named verbatim for the coverage block. */
  uncovered: string[];
}

/**
 * Compile the checks a guide's declared operations earn.
 *
 * Only domains relevant to THIS task are considered: a guide describing twelve domains must not make
 * every delivery boot-test all twelve, and a check for an operation nobody asked for would fail for
 * reasons that have nothing to do with the work in hand.
 */
export function checksFromGuide(guide: StrataGuide | null, taskText: string): GuideCheckResult {
  const empty: GuideCheckResult = { checks: [], uncovered: [] };
  if (!guide?.domains?.length) return empty;

  const hay = taskText.toLowerCase();
  const checks: RecallCheck[] = [];
  const uncovered: string[] = [];

  for (const domain of guide.domains) {
    const names = [domain.name, domain.entity].filter(Boolean) as string[];
    const relevant = names.some(n => {
      const t = n.toLowerCase().replace(/s$/, '');
      return t.length > 2 && new RegExp(`\\b${t}s?\\b`).test(hay);
    });
    if (!relevant) continue;

    for (const op of domain.operations ?? []) {
      const r = parseRoute(op.route);
      if (!r) {
        // An operation with no parseable route cannot be probed over HTTP at all.
        uncovered.push(`${domain.entity}.${op.name} (no route declared)`);
        continue;
      }

      const floor = COMPILERS.find(c => c.id === 'endpoint-exists')!.build(op, domain, r);
      if (floor) checks.push(floor);

      if (!op.guarantees) continue;
      const compiler = COMPILERS.find(c => c.id !== 'endpoint-exists' && c.match.test(op.guarantees!));
      const built = compiler?.build(op, domain, r) ?? null;
      if (built) checks.push(built);
      else uncovered.push(`${domain.entity}.${op.name} — "${op.guarantees.slice(0, 80)}${op.guarantees.length > 80 ? '…' : ''}"`);
    }
  }

  return { checks, uncovered };
}
