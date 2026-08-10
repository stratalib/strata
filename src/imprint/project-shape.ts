/**
 * Project shape detection — greenfield or brownfield?
 *
 * Composition (V4) produces a complete, correct Express application. That is exactly right for an
 * empty directory and exactly WRONG for a project that already has one: we hand the session a second,
 * competing `server.js`, and it pays turns to notice the collision, reconcile two entry points, and
 * delete our output. Generating an app for a project that has an app is over-generation, and
 * over-generation is a tax, not a bonus — we have now measured that three separate ways.
 *
 * A brownfield project has already told us its conventions: where the entry point is, where routers
 * live, how they are mounted. So we deliver MODULES THAT FIT rather than an app that competes.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectShape {
  /** The existing Express entry point, e.g. "src/server.js". */
  entryFile: string;
  /** Where this project keeps its routers, e.g. "src/routes". Null if it has no such convention. */
  routesDir: string | null;
  /** Source root, e.g. "src" — where the wiring module should land. */
  sourceRoot: string;
  /** True when the entry file has the anchors we need to mount deterministically. */
  mountable: boolean;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'strata']);

/** Anchors we splice against. All three must be unambiguous, or we do not touch the file. */
const APP_ANCHOR = /^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*express\(\)\s*;?\s*$/m;
const LISTEN_ANCHOR = /^\s*\w+\.listen\s*\(/m;
/**
 * The project's OWN pre-existing body parser, if it has one. `afterBodyParse(app)` must run AFTER this
 * line, so fragments that need req.body (idempotency's fingerprinting, most obviously) see it populated.
 * Moving the WHOLE before(app) bundle after this line (the first fix attempt) traded that bug for a
 * worse one: it also pushed the request logger and rate limiter after body parsing, so a malformed-JSON
 * request that throws inside express.json() lost its correlation id — exactly the failure mode
 * before(app) exists to prevent. The real fix splits the two concerns at the source (see
 * BODY_PARSER_RANK in src/mcp-server.ts): before(app) always lands at app-creation, unconditionally;
 * afterBodyParse(app) is a second export that lands after whichever body parser wins. Measured, real,
 * three times: STRATA-BENCHMARK-FINDINGS.md, 2026-07-27, 2026-07-29, and 2026-07-30 entries. When the
 * compose fragments already add their OWN body parser (no pre-existing one detected), this anchor finds
 * nothing and afterBodyParse(app) lands right after before(app) — a harmless no-op call, since in that
 * case afterBodyParse's body is empty by construction (see splitAtBodyParser in mcp-server.ts).
 */
// Trailing whitespace is deliberately [ \t]*, not \s* — \s includes \n, and with the /m flag a greedy
// \s*$ can eat straight through a following blank line, making the match length (and therefore every
// insertion point computed from it) depend on how much blank space happens to follow in the user's
// file. Same-line-only whitespace keeps the match boundary exactly at this line's own end, always.
const BODY_PARSER_ANCHOR = /^[ \t]*\w+\.use\s*\(\s*(?:express\.json|express\.urlencoded|bodyParser\.json|bodyParser\.urlencoded)\s*\([^)]*\)\s*\)[ \t]*;?[ \t]*$/m;

function findEntryFile(projectDir: string): string | null {
  // The project's own package.json is the most reliable statement of its entry point.
  const candidates: string[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    const start: string = pkg.scripts?.start ?? '';
    const m = start.match(/node\s+([\w./-]+\.js)/);
    if (m) candidates.push(m[1]);
    if (typeof pkg.main === 'string') candidates.push(pkg.main);
  } catch { /* no package.json — fall through to the conventional names */ }

  candidates.push('src/server.js', 'src/app.js', 'src/index.js', 'server.js', 'app.js', 'index.js');

  for (const rel of candidates) {
    const full = path.join(projectDir, rel);
    if (!fs.existsSync(full)) continue;
    let src: string;
    try { src = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    // It must actually BE an Express app, not merely a file named server.js.
    if (/require\(['"]express['"]\)|from\s+['"]express['"]/.test(src) && APP_ANCHOR.test(src)) {
      return rel.replace(/\\/g, '/');
    }
  }
  return null;
}

function findRoutesDir(projectDir: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3) return null;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (/^(routes|routers|controllers|api)$/i.test(e.name)) {
        return path.relative(projectDir, full).replace(/\\/g, '/');
      }
      const nested = walk(full, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  return walk(projectDir, 0);
}

export function detectProjectShape(projectDir: string): ProjectShape | null {
  const entryFile = findEntryFile(projectDir);
  if (!entryFile) return null;   // greenfield (or not an Express project) — compose a whole app

  let src = '';
  try { src = fs.readFileSync(path.join(projectDir, entryFile), 'utf-8'); } catch { /* unreadable */ }

  // Mount only when BOTH anchors appear exactly once. An ambiguous file is one we refuse to splice:
  // silently corrupting a user's entry point is a far worse outcome than asking the model to add
  // three lines itself.
  const appMatches = src.match(new RegExp(APP_ANCHOR.source, 'gm')) ?? [];
  const listenMatches = src.match(new RegExp(LISTEN_ANCHOR.source, 'gm')) ?? [];
  const mountable = appMatches.length === 1 && listenMatches.length === 1;

  const sourceRoot = path.dirname(entryFile) === '.' ? '' : path.dirname(entryFile);

  return {
    entryFile,
    routesDir: findRoutesDir(projectDir),
    sourceRoot,
    mountable,
  };
}

/** The variable the project calls its Express app (`const app = express()` → "app"). */
export function appVarName(projectDir: string, shape: ProjectShape): string {
  try {
    const src = fs.readFileSync(path.join(projectDir, shape.entryFile), 'utf-8');
    return src.match(APP_ANCHOR)?.[2] ?? 'app';
  } catch {
    return 'app';
  }
}

/**
 * Splice the wiring calls into the project's existing entry point.
 *
 * Order is the whole game and it is why this is done mechanically rather than left to prose:
 *   before(app)          — immediately after `const app = express()`, unconditionally. This is what
 *                          keeps the request logger and rate limiter ahead of EVERY existing route
 *                          AND ahead of body parsing, so a malformed-JSON request that throws inside
 *                          express.json() still has a correlation id on its way out.
 *   afterBodyParse(app)  — AFTER the project's own body parser if it has one (see BODY_PARSER_ANCHOR),
 *                          so fragments that need req.body (idempotency-key fingerprinting) see it
 *                          populated regardless of which parser wins. A no-op when Strata supplied its
 *                          own parser instead — see splitAtBodyParser in src/mcp-server.ts.
 *   routes(app)          — after the project's own route mounts.
 *   after(app)           — immediately before `.listen()`, because Express only reaches an error
 *                          handler registered downstream of the throw.
 *
 * Returns the patched source, or null if the anchors were not unambiguous.
 */
export function mountWiring(
  entrySource: string,
  wiringRequirePath: string,
  appVar: string,
): string | null {
  if (entrySource.includes(wiringRequirePath)) return null;   // already mounted — never double-apply

  const appMatch = entrySource.match(APP_ANCHOR);
  const listenMatch = entrySource.match(LISTEN_ANCHOR);
  if (!appMatch || !listenMatch) return null;

  let out = entrySource;

  // 1. require, directly above the `const app = express()` line so it is defined before first use.
  const appLine = appMatch[0];
  const indent = appMatch[1] ?? '';
  out = out.replace(appLine, `${indent}const strata = require('${wiringRequirePath}');\n\n${appLine}`);

  // 2. before(app) — ALWAYS immediately after app creation. Never conditional on the project's own
  //    body parser: this call must run ahead of it, every time, for every project shape.
  const beforeCall = `strata.before(${appVar});`;
  const appLineEndIdx = out.indexOf(appLine) + appLine.length;
  out = out.slice(0, appLineEndIdx) + `\n${indent}${beforeCall}` + out.slice(appLineEndIdx);

  // 3. afterBodyParse(app) — AFTER the project's own body parser(s) if it has any. A project commonly
  //    has TWO (express.json() then express.urlencoded()) — anchoring on the first match alone would
  //    land afterBodyParse between them, leaving req.body unpopulated for whichever content-type the
  //    second parser handles. Take the LAST match in a run, not the first. Search only the part of the
  //    file after before(app), so a body-parser-shaped string earlier in the file (a comment, an
  //    unrelated variable) can't misfire.
  const beforeCallIdx = out.indexOf(beforeCall) + beforeCall.length;
  const afterBeforeCall = out.slice(beforeCallIdx);
  const afterBodyParseCall = `strata.afterBodyParse(${appVar});`;
  const bodyParserMatches = [...afterBeforeCall.matchAll(new RegExp(BODY_PARSER_ANCHOR.source, 'gm'))];
  if (bodyParserMatches.length) {
    const last = bodyParserMatches[bodyParserMatches.length - 1];
    const insertAt = last.index! + last[0].length;
    out = out.slice(0, beforeCallIdx)
      + afterBeforeCall.slice(0, insertAt) + `\n${indent}${afterBodyParseCall}` + afterBeforeCall.slice(insertAt);
  } else {
    out = out.slice(0, beforeCallIdx) + `\n${indent}${afterBodyParseCall}` + afterBeforeCall;
  }

  // 4. routes + error handler, immediately above listen(). Leading \n guards against gluing onto
  //    whatever the previous splice left immediately adjacent (e.g. afterBodyParse's no-op case, when
  //    there was no blank line for it to land in) — cosmetic only, but a reviewer reads this file.
  const listenLine = listenMatch[0];
  const listenIdx = out.indexOf(listenLine);
  out =
    out.slice(0, listenIdx) +
    `\nstrata.routes(${appVar});\nstrata.after(${appVar});   // error handler — must be last\n\n` +
    out.slice(listenIdx);

  return out;
}
