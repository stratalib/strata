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
import { resolveKind, sampleBody, Route } from './guide-kinds.js';

/** `POST /orders` → { method, path }. Returns null for a route we cannot parse. */
function parseRoute(route: string | undefined): { method: string; path: string } | null {
  if (!route) return null;
  const m = route.trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i);
  if (!m) return null;
  return { method: m[1].toUpperCase(), path: m[2] };
}

// sampleBody now lives in guide-kinds.ts, beside the kinds that need it. Two copies drifted once
// already — this file's version had no `array` case, so a declared list produced a probe body the
// generated validation rejected, and the check failed for a reason that had nothing to do with the
// behaviour under test.

/** The universal floor: is anything serving this path at all? */
function floorCheck(domain: Domain, op: DomainOperation, r: Route): RecallCheck {
  return {
    name: `${domain.entity}.${op.name}: ${r.method} ${r.path} is served`,
    code: [
      r.method === 'GET'
        ? `const res = await get('${r.path}');`
        : `const res = await post('${r.path}', ${JSON.stringify(sampleBody(domain))}, 'application/json');`,
      // A 404 alone does not mean "unrouted": a parameterised path probed with a literal ":id" is SERVED
      // and correctly answers 404 for a missing record. Express's unmatched-route 404 is HTML; a served
      // handler's is JSON. That is the discriminator.
      `const routed = res.status !== 404 || (res.body !== undefined && res.body !== null);`,
      `assert(routed, '${r.method} ${r.path} returned an unrouted 404 (HTML, not JSON) — the guide declares this operation, and nothing serves it.');`,
    ].join('\n'),
  };
}

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

      // FLOOR: the route is served at all. Cheap, universal, and it makes every later failure
      // readable — a transition that "fails" because nothing answers the path is a different bug from
      // one that answers and does the wrong thing.
      checks.push(floorCheck(domain, op, r));

      // BEHAVIOURAL: whatever this operation's KIND knows how to prove. The kind owns both halves, so
      // a generated behaviour and its proof cannot drift apart.
      const { kind, meta } = resolveKind(domain, op, r);
      const ctx = { domain, op, route: r, store: '', idField: domain.idField ?? 'id', meta };
      const built = kind.check(ctx);
      if (built) checks.push(built);
      else {
        // No proof — say so. A generated behaviour that nothing exercises must never pass in silence.
        const gap = kind.checkGap?.(ctx);
        if (gap) uncovered.push(gap);
        else if (op.guarantees) uncovered.push(`${domain.entity}.${op.name} — "${op.guarantees.slice(0, 80)}${op.guarantees.length > 80 ? '…' : ''}"`);
      }
    }
  }

  return { checks, uncovered };
}
