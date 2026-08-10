#!/usr/bin/env node
'use strict';
/**
 * Drive a delivered retry helper and report what it actually did, as JSON on stdout.
 *
 * RUNS IN ITS OWN PROCESS, and that is the whole point.
 *
 * Discovery has to `require()` candidate files, and a delivered tree is full of files that DO things
 * when required: entry points call app.listen, some print banners, some throw on a missing env var.
 * Doing that inside the grader meant one tree's server bound a port for the rest of the run, another's
 * uncaught exception killed the grading pass outright ("node:events:486"), and the output of a graded
 * app was interleaved with the grader's own. A child process contains all of it: side effects die when
 * it exits, and a crash costs exactly one grade instead of the batch.
 *
 * The parent asks a single question — "what did the helper do?" — and gets a verdict it can trust
 * because the probe never reports what the helper CLAIMS. Attempt counts and backoff gaps come from
 * the upstream server's own arrival log.
 *
 *   node retry-probe.js <treeDir>     →  {"ok":true,"helper":"fetchWithRetry","probes":{...}}
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tree's own unhandled errors must not take the probe down before it reports.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

function startUpstream() {
  const state = { failFirst: 0, status: 500, hits: [] };
  const server = http.createServer((req, res) => {
    state.hits.push(Date.now());
    if (state.hits.length <= state.failFirst) {
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'flaky', attempt: state.hits.length }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/flaky`,
      reset(failFirst, status = 500) { state.failFirst = failFirst; state.status = status; state.hits = []; },
      attempts: () => state.hits.length,
      gaps: () => state.hits.slice(1).map((t, i) => t - state.hits[i]),
      close: () => { try { server.close(); } catch { /* already down */ } },
    }));
  });
}

/**
 * Compile a TypeScript tree so it can be driven, and return the compiled copy's path.
 *
 * NOT a nicety — an arm-correlated exclusion. The retry prompt never asks for JavaScript, so `.ts` is
 * a legitimate answer, and baselines take it: three of nine baseline runs delivered TypeScript and
 * ZERO Strata runs did, because Strata ships CommonJS recalls and the model follows the delivery. So
 * "skip TypeScript" silently deletes baseline runs and only baseline runs — it would have published a
 * Strata win manufactured by which arm happened to pick a language.
 *
 * Compiles into a COPY under os.tmpdir so the archived evidence is never mutated, with node_modules
 * junctioned rather than duplicated.
 */
function compileTypeScript(dir) {
  let ts;
  try { ts = require('typescript'); } catch { return null; }
  const os = require('os');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-ts-'));

  let compiled = 0;
  (function copy(src, out, depth) {
    if (depth > 4) return;
    let entries; try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    fs.mkdirSync(out, { recursive: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      const s = path.join(src, e.name);
      const d = path.join(out, e.name);
      if (e.isDirectory()) { copy(s, d, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (/\.(test|spec)\.ts$/.test(e.name)) continue;
      if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        try {
          const srcText = fs.readFileSync(s, 'utf-8');
          const js = ts.transpileModule(srcText, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
          }).outputText;
          fs.writeFileSync(d.replace(/\.ts$/, '.js'), js);
          compiled++;
        } catch { /* a file that will not transpile is simply not a candidate */ }
      } else {
        try { fs.copyFileSync(s, d); } catch { /* unreadable — skip */ }
      }
    }
  })(dir, dest, 0);

  if (!compiled) return null;
  // Junction the real node_modules so requires resolve without copying thousands of files.
  try {
    fs.symlinkSync(path.join(dir, 'node_modules'), path.join(dest, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch { /* no node_modules, or already linked */ }
  return dest;
}

function candidateFiles(dir) {
  /**
   * `strata/` is NOT skipped wholesale — `strata/composed-pkg/index.js` IS the delivered
   * implementation, and excluding it made this probe blind to every Strata delivery.
   *
   * Measured: retry-strata-haiku-1 and -3 scored 0/7 "no helper found" while their entire delivered
   * retry client sat in strata/composed-pkg. A zero that only ever lands on one arm is the most
   * damaging kind of instrument bug there is — it manufactures exactly the result the experiment is
   * supposed to test. Only the parts of strata/ that are grading apparatus are skipped.
   */
  const skip = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'coverage', 'scaffold']);
  const skipStrataChild = new Set(['tests', 'selftest.js', 'verify.js']);
  const out = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    const inStrata = path.basename(d) === 'strata';
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name) || e.name.startsWith('.')) continue;
      if (inStrata && skipStrataChild.has(e.name)) continue;   // grading apparatus, not delivery
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.js') && !/\.(test|spec)\.js$/.test(e.name)) out.push(p);
    }
  })(dir, 0);

  // The composed package is also installed under node_modules; require it by name so a tree that only
  // re-exports from 'strata-composed' is still driveable.
  const composedNM = path.join(dir, 'node_modules', 'strata-composed', 'index.js');
  if (fs.existsSync(composedNM)) out.push(composedNM);

  // Name is a HINT for ordering only, never a requirement — an arm that called it `client.js` is not
  // worse than one that called it `retry.js`. Entry points go last because requiring them is what
  // starts servers, but they are still tried: some arms genuinely export the helper from index.js.
  const score = (f) => {
    const b = path.basename(f).toLowerCase();
    if (/retry|backoff|resilien/.test(b)) return 0;
    if (/client|http|fetch|api|util|lib/.test(b)) return 1;
    if (/^(server|index|app|main)\.js$/.test(b)) return 3;
    return 2;
  };
  return out.sort((a, b) => score(a) - score(b));
}

/** Every function reachable from a module, including one level inside a factory's return value. */
function reachableFunctions(mod) {
  const found = [];
  if (typeof mod === 'function') found.push({ name: '(default)', fn: mod, viaFactory: null });
  for (const [k, v] of Object.entries(mod || {})) {
    if (typeof v === 'function') found.push({ name: k, fn: v, viaFactory: null });
  }
  return found;
}

async function drive(fn, upstream, mode) {
  // Two calling conventions the prompt admits. Anything else is not a usability judgement we make.
  if (mode === 'url') return fn(upstream.url, {});
  const task = () => new Promise((resolve, reject) => {
    const rq = http.get(upstream.url, (rs) => {
      rs.resume();
      rs.on('end', () => {
        if (rs.statusCode >= 400) { const e = new Error('HTTP ' + rs.statusCode); e.status = rs.statusCode; return reject(e); }
        resolve(rs.statusCode);
      });
    });
    rq.on('error', reject);
  });
  return fn(task, {});
}

/**
 * A candidate counts ONLY if invoking it actually reaches the upstream.
 *
 * The first version accepted any call that returned without throwing, which selected
 * `backoffDelay(attempt)` — a pure arithmetic helper — and `createRetryClient(url)` — a factory that
 * builds an object and calls nothing. Both then scored 0/7, and it looked like the delivered code
 * could not retry. Requiring a real HTTP hit is what distinguishes the function that DOES the work
 * from the ones that merely support it.
 */
async function findHelper(dir, upstream) {
  for (const f of candidateFiles(dir)) {
    let mod;
    try { mod = require(f); } catch { continue; }

    for (const cand of reachableFunctions(mod)) {
      for (const mode of ['url', 'task']) {
        upstream.reset(0);
        let result;
        try {
          result = await Promise.race([drive(cand.fn, upstream, mode), sleep(5000).then(() => Promise.reject(new Error('slow')))]);
        } catch { continue; }
        if (upstream.attempts() >= 1) return { fn: cand.fn, name: cand.name, file: f, mode };

        // A factory: it called nothing, but it may have HANDED us the thing that does.
        if (result && (typeof result === 'object' || typeof result === 'function')) {
          const inner = typeof result === 'function'
            ? [{ name: cand.name + '()', fn: result }]
            : Object.entries(result).filter(([, v]) => typeof v === 'function').map(([k, v]) => ({ name: cand.name + '().' + k, fn: v.bind(result) }));
          for (const i of inner) {
            for (const m2 of ['url', 'task']) {
              upstream.reset(0);
              try { await Promise.race([drive(i.fn, upstream, m2), sleep(5000).then(() => Promise.reject(new Error('slow')))]); } catch { /* keep looking */ }
              if (upstream.attempts() >= 1) return { fn: i.fn, name: i.name, file: f, mode: m2 };
            }
          }
        }
      }
    }
  }
  return null;
}

(async () => {
  const dir = process.argv[2];
  const upstream = await startUpstream();
  const call = (h) => drive(h.fn, upstream, h.mode);
  const out = { ok: false, helper: null, probes: {} };

  try {
    let helper = await findHelper(dir, upstream);

    // Nothing driveable in JavaScript — the arm may have written TypeScript. Compile and retry before
    // concluding anything, so language choice never decides the grade.
    if (!helper) {
      const compiledDir = compileTypeScript(dir);
      if (compiledDir) {
        helper = await findHelper(compiledDir, upstream);
        if (helper) out.compiledFrom = 'typescript';
      }
    }

    if (!helper) {
      /**
       * TYPESCRIPT IS NOT A DEFECT. The retry prompt never asks for JavaScript, so `src/retry.ts` is a
       * legitimate answer this probe simply cannot require without a compiler in the tree.
       *
       * retry-baseline-sonnet-1 delivered exactly that and scored 0/7 "no helper found" — which reads
       * as "the model wrote nothing that works". Recording it as UNMEASURABLE keeps it out of the
       * averages instead of silently counting a limitation of the harness as the arm's failure. Same
       * rule as a dead spawn: absent is not zero.
       */
      const ts = [];
      (function scan(d, depth) {
        if (depth > 3) return;
        let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) scan(p, depth + 1);
          else if (/\.ts$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) ts.push(e.name);
        }
      })(dir, 0);
      if (ts.length) out.unmeasurable = `delivered TypeScript (${ts.slice(0, 3).join(', ')}) — this probe cannot require it without a compiler`;
      console.log(JSON.stringify(out));
      process.exit(0);
    }
    out.ok = true;
    out.helper = helper.name;

    // fails twice then succeeds
    upstream.reset(2);
    let recovered = false, r1err = '';
    try { await Promise.race([call(helper), sleep(20000).then(() => Promise.reject(new Error('hung')))]); recovered = true; }
    catch (e) { r1err = String(e && e.message || e); }
    out.probes.recover = { attempts: upstream.attempts(), recovered, err: r1err.slice(0, 80) };

    // healthy: one call, no wait
    upstream.reset(0);
    const t0 = Date.now();
    let healthyThrew = false;
    try { await Promise.race([call(helper), sleep(10000).then(() => Promise.reject(new Error('hung')))]); }
    catch { healthyThrew = true; }
    out.probes.healthy = { attempts: upstream.attempts(), ms: Date.now() - t0, threw: healthyThrew };

    // always failing
    upstream.reset(999);
    const t1 = Date.now();
    let threw = null, returned;
    try { returned = await Promise.race([call(helper), sleep(25000).then(() => Promise.reject(new Error('__hung__')))]); }
    catch (e) { threw = e; }
    out.probes.exhaust = {
      attempts: upstream.attempts(), gaps: upstream.gaps(), ms: Date.now() - t1,
      hung: !!(threw && threw.message === '__hung__'),
      threw: threw && threw.message !== '__hung__' ? String(threw.message || threw).slice(0, 80) : null,
      returnedUndefined: returned === undefined,
    };

    // a 400 must not be retried
    upstream.reset(999, 400);
    try { await Promise.race([call(helper), sleep(20000).then(() => Promise.reject(new Error('hung')))]); } catch { /* expected */ }
    out.probes.clientError = { attempts: upstream.attempts() };
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 120);
  } finally {
    upstream.close();
    console.log(JSON.stringify(out));
    // Delivered code may have left servers or timers behind; do not wait for them.
    process.exit(0);
  }
})();
