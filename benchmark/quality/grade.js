#!/usr/bin/env node
'use strict';
/**
 * Boot one run's output tree and grade it against the pre-registered suite.
 *
 * Independent of the session that produced it: it reads only the files on disk, never the transcript,
 * and never strata/verify.js. It cannot tell which arm it is grading, which is the point.
 *
 *   node benchmark/quality/grade.js <runDir|runJson> [--suite catalog]
 *   node benchmark/quality/grade.js --all                 # grade every run in runs/exp-quality
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { SUITES } = require('./suites.js');

/**
 * Fingerprint of the WHOLE instrument — the checks AND the code that executes them.
 *
 * It hashed suites.js alone at first, which is only half a freeze: suites.js is prose describing what
 * each check hunts, while every decision about pass or fail is made in this file. An amendment here
 * (say, tightening a check or adding schema discovery) changed grading without moving the hash, so
 * results graded before and after were indistinguishable while no longer being comparable.
 *
 * Both files now feed the hash, so any change to how a run is graded forces a re-grade of everything
 * and is visible on every result as a different fingerprint.
 */
const SUITE_HASH = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, 'suites.js')))
  .update(fs.readFileSync(__filename))
  .digest('hex').slice(0, 16);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/** Minimal HTTP client. Never throws on status; a connection error resolves as status 0 so a check can
 *  distinguish "server said no" from "server is gone", which are very different quality signals. */
function req(port, method, urlPath, { body, headers = {}, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: urlPath, timeout,
      headers: {
        ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json — fine, `text` still carries it */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, text: '', json: null, timedOut: true }); });
    r.on('error', (e) => resolve({ status: 0, headers: {}, text: '', json: null, error: e.message }));
    if (payload !== null) r.write(payload);
    r.end();
  });
}

/** Entry points in the order a human would try them. */
function findEntry(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const start = pkg.scripts && pkg.scripts.start;
      if (start) {
        const m = /node\s+([^\s&|]+)/.exec(start);
        if (m && fs.existsSync(path.join(dir, m[1]))) return m[1];
      }
    } catch { /* fall through to the candidates */ }
  }
  for (const c of ['server.js', 'src/server.js', 'index.js', 'src/index.js', 'app.js', 'src/app.js']) {
    if (fs.existsSync(path.join(dir, c))) return c;
  }
  return null;
}

async function boot(dir, extraEnv = {}) {
  const entry = findEntry(dir);
  if (!entry) return { ok: false, reason: 'no entry point found' };

  // Dependencies are normally installed by the session itself (that install is part of what was
  // measured). If they are missing the tree cannot be graded at all, so install once, offline-friendly.
  //
  // "node_modules exists" is NOT the same as "the declared dependencies are installed", and treating
  // them as equivalent cost a real grade: a run whose session installed some packages and then failed
  // partway left a populated node_modules with no `express` in it, so this check skipped the install
  // and the app died on `Cannot find package 'express'` — recorded as 0/8, a boot failure that belonged
  // to the harness. Check what package.json actually asks for.
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let missing = !fs.existsSync(path.join(dir, 'node_modules'));
    if (!missing) {
      try {
        const deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).dependencies || {});
        missing = deps.some(d => !fs.existsSync(path.join(dir, 'node_modules', d)));
      } catch { /* unreadable package.json — leave the tree as the session left it */ }
    }
    if (missing) {
      spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'],
        { cwd: dir, shell: true, timeout: 180_000, encoding: 'utf-8' });
    }
  }

  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    // extraEnv is the DEPLOYER'S half of the contract, not a hint. A payments app cannot start without
    // a Stripe key, an SMTP host and a Redis URL, and withholding them would score "the grader did not
    // configure it" as a quality defect — failing the arms that correctly read config from the
    // environment while passing any arm that hardcoded its secrets. Same inversion as CATALOG_REFS.
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });

  let exited = false, exitCode = null;
  child.on('exit', (c) => { exited = true; exitCode = c; });

  // Poll until something answers. Any HTTP status counts as listening — a 404 on / still proves the
  // server is up, and requiring a specific route here would bias against arms that name things
  // differently.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) return { ok: false, reason: `process exited (code ${exitCode})`, log: out, child: null };
    const r = await req(port, 'GET', '/', { timeout: 1500 });
    if (r.status !== 0) return { ok: true, port, child, log: () => out, entry };
    await sleep(400);
  }
  try { child.kill(); } catch { /* already gone */ }
  return { ok: false, reason: 'never started listening within 30s', log: out };
}

/** First candidate path that is not a 404 — route discovery, so naming is not graded as quality. */
async function discover(port, candidates, method = 'GET', body) {
  for (const p of candidates) {
    const r = await req(port, method, p, body ? { body } : {});
    if (r.status !== 0 && r.status !== 404) return { path: p, first: r };
  }
  return { path: null, first: null };
}

/**
 * Candidate order shapes, tried in order until one is ACCEPTED.
 *
 * Arms invent their own request schema — one graded here required `{ items: [{sku, quantity}],
 * idempotencyKey }` with the key in the BODY, while the grader sent a flat `{sku, quantity}` with the
 * key in a header. Everything returned 400, and the damage was not merely a failed I1: the checks
 * that assert a REFUSAL (I3 different-body, I5 invalid-body, I6 concurrent) all passed vacuously,
 * because an app that rejects every request refuses those too. A server that does nothing at all
 * scored 4/7.
 *
 * That is the mirror image of the unfalsifiable-check problem the negative control was built for: a
 * check that cannot fail is worthless, and so is a check that passes for the wrong reason. Route
 * discovery already existed so that naming was not graded as quality; schema discovery is the same
 * argument, and its absence was silently scoring schema-guessing instead of correctness.
 *
 * `key` is threaded into every shape that carries it in-body, so replay tests exercise the arm's own
 * mechanism rather than assuming the header.
 */
/**
 * WHICH CATALOG ROW THE GRADER MAY CITE. This list is not cosmetic — getting it wrong inverted the
 * entire instrument, and the inversion ran undetected across a full 15-run task.
 *
 * The fixture seeds 40 products (`src/data/productRepository.js`):
 *
 *     sku: `SKU-${String(i + 1).padStart(5, '0')}`,
 *     active: i % 7 !== 0,
 *     quantity: Math.floor(Math.random() * 200),
 *
 * so row `i = 0` — `SKU-00001`, `productId: 1` — is the ONE product in the catalog that is guaranteed
 * INACTIVE. Every one of the five hard-coded shapes below used to cite exactly that row.
 *
 * The result was an instrument that graded the ABSENCE of validation. An app that resolves the SKU and
 * honours `active` — the correct behaviour — rejected every probe, failed I1-create-works, and
 * cascaded to 2/7 because I2/I3/I5/I6 can only be demonstrated once an order exists. An app that never
 * checked the catalog at all was accepted immediately and scored 7/7. Across the 15 idempotency runs
 * the correlation is exact: all four 2/7 runs enforce `active`, none of the passing runs do. Worse, it
 * was not noise-shaped — the strong models are the ones that write the `active` check, so the penalty
 * fell hardest on sonnet and opus, which is precisely where the thesis is being measured.
 *
 * Random `quantity` added a second, sneakier failure: stock is re-rolled on every boot, so asking for
 * 2 units made the grade partly a coin flip. The same archived tree scored 6/7 and then 5/7 under an
 * unchanged instrument hash. A grade that moves when nothing moved is not a measurement.
 *
 * Fix: cite only rows the seed rule marks ACTIVE, ask for ONE unit (the quantity least likely to
 * exhaust stock), and sweep several rows so one unlucky roll cannot zero a run. The sweep is ordered,
 * so which reference wins is reproducible.
 */
const CATALOG_REFS = [];
for (let i = 1; i < 40 && CATALOG_REFS.length < 6; i++) {
  if (i % 7 === 0) continue;                               // inactive by the fixture's own seed rule
  CATALOG_REFS.push({ sku: `SKU-${String(i + 1).padStart(5, '0')}`, productId: i + 1 });
}

/** The reference the current sweep is citing. Read by valueFor/synthesizeBody so the adaptive path
 *  and the fixed-candidate path can never disagree about which row exists. */
let CURRENT_REF = CATALOG_REFS[0];
const currentRef = () => CURRENT_REF;

const ORDER_SHAPES = [
  (key, r) => ({ items: [{ sku: r.sku, quantity: 1 }], customerEmail: 'a@b.com', idempotencyKey: key }),
  (key, r) => ({ sku: r.sku, quantity: 1, customerEmail: 'a@b.com', idempotencyKey: key }),
  (key, r) => ({ items: [{ productId: r.productId, quantity: 1 }], customerEmail: 'a@b.com', idempotencyKey: key }),
  (key, r) => ({ productId: r.productId, quantity: 1, customerEmail: 'a@b.com', idempotencyKey: key }),
  (key, r) => ({ items: [{ sku: r.sku, qty: 1 }], email: 'a@b.com', idempotencyKey: key }),
];

/**
 * Build a body the arm will ACCEPT, by reading its own validation errors.
 *
 * A fixed candidate list is not enough and cannot be made enough. Arms invent arbitrary schemas: one
 * wanted `{items:[{sku,quantity}]}`, another `{customerId:number, items:[string], total:number}`. The
 * first happened to match a hardcoded candidate and scored normally; the second matched nothing and
 * scored 2/7 for what was actually a working implementation. That is the grader failing, and it fails
 * ASYMMETRICALLY — whichever arm happens to match the list gets graded, the other gets zeroed.
 *
 * Extending the list with a schema read off one arm's source would fit the instrument to that arm's
 * output after seeing it, which is precisely what freezing the suite is meant to prevent.
 *
 * So discovery is adaptive and black-box instead: POST an empty body, read the field names and types
 * out of the 4xx response, fill them in, and repeat until accepted or until no further progress. This
 * is what a human integrating against an undocumented API does, it uses only what the server
 * volunteers, and it is neutral between arms — an arm with unreadable validation errors is penalised
 * regardless of which arm it is.
 */
const TYPE_WORDS = /\b(integer|number|string|array|boolean|object|email|uuid)\b/i;

function valueFor(field, typeWord, wantsStringArray) {
  const f = String(field).toLowerCase();
  const t = (typeWord || '').toLowerCase();
  if (t === 'array' || /items|lines|products|skus/.test(f)) {
    return wantsStringArray ? [currentRef().sku] : [{ sku: currentRef().sku, quantity: 1, price: 9.99 }];
  }
  if (/email/.test(f) || t === 'email') return 'user@example.com';
  // Never a literal catalog reference — see CATALOG_REFS for what citing the dead row cost.
  if (/sku/.test(f)) return currentRef().sku;
  if (/id$/.test(f) && t !== 'string') return currentRef().productId;
  if (/quantity|qty|count/.test(f)) return 1;              // one unit; stock is randomised per boot
  if (t === 'integer' || t === 'number' || /total|amount|price/.test(f)) return 2;
  if (t === 'boolean') return true;
  if (t === 'object') return {};
  if (t === 'string') return 'test';
  return 'test';
}

const NOISE = /^(error|errors|details|message|validation|failed|the|a|an|and|must|is|be|required)$/i;

/**
 * Pull the schema out of whatever shape the arm returns its errors in.
 *
 * Returns flat fields AND nested ones. Nesting is not an edge case here: order APIs validate line
 * items, so the messages that matter look like `items[0].unitPrice is required and must be a positive
 * number`. An earlier version captured only `items` from that and discarded `.unitPrice`, so it
 * rebuilt the same rejected array every round, made no progress, and gave up — scoring a working
 * implementation 2/7. Any arm validating line items would have been zeroed the same way.
 */
function parseErrors(text) {
  const flat = new Map();                    // field -> typeWord
  const nested = new Map();                  // parent -> Map(child -> typeWord)
  const elemObject = new Set();              // parent whose elements must be objects
  if (!text) return { flat, nested, elemObject };

  const noteNested = (parent, child, type) => {
    if (!nested.has(parent)) nested.set(parent, new Map());
    const m = nested.get(parent);
    if (!m.has(child) || !m.get(child)) m.set(child, type);
    elemObject.add(parent);
  };

  // Structured: [{path:["items",0,"unitPrice"],message:"Required"}] / [{field:"total"}]
  try {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const raw = node.field || node.param || node.property || node.path;
      const msg = `${node.message || ''} ${node.type || ''} ${node.expected || ''}`;
      const type = (msg.match(TYPE_WORDS) || [])[0] || null;
      if (Array.isArray(raw)) {
        const parts = raw.filter(p => typeof p === 'string');
        if (parts.length >= 2) noteNested(parts[0], parts[parts.length - 1], type);
        else if (parts.length === 1) flat.set(parts[0], type);
      } else if (typeof raw === 'string' && /^[A-Za-z_][\w.[\]]*$/.test(raw)) {
        const mm = /^([A-Za-z_]\w*)(?:\[\d+\])?\.(\w+)$/.exec(raw);
        if (mm) noteNested(mm[1], mm[2], type);
        else flat.set(raw.replace(/\[\d+\]$/, ''), type);
      }
      Object.values(node).forEach(walk);
    };
    walk(JSON.parse(text));
  } catch { /* not JSON — the prose scan below still applies */ }

  // Prose, nested first: "items[0].unitPrice is required and must be a positive number"
  for (const m of text.matchAll(/([A-Za-z_]\w*)\[\d+\]\.(\w+)\s+(?:is\s+)?(?:required|must be|should be|expected)/gi)) {
    const tail = text.slice(m.index, m.index + 160);
    noteNested(m[1], m[2], (tail.match(TYPE_WORDS) || [])[0] || null);
  }
  // "items[0] must be an object"
  for (const m of text.matchAll(/([A-Za-z_]\w*)\[\d+\]\s+(?:is\s+)?(?:must be|should be)\s+an?\s+object/gi)) {
    elemObject.add(m[1]);
  }
  // Flat: "customerId is required and must be a non-empty string"
  for (const m of text.matchAll(/["`']?([A-Za-z_]\w*)["`']?\s+(?:is\s+)?(?:required|must be|should be|expected)/gi)) {
    const name = m[1];
    if (NOISE.test(name)) continue;
    const tail = text.slice(m.index, m.index + 160);
    if (!flat.has(name) || !flat.get(name)) flat.set(name, (tail.match(TYPE_WORDS) || [])[0] || null);
  }
  return { flat, nested, elemObject };
}

async function synthesizeBody(port, createPath, headersFor) {
  // EVERY probe gets a FRESH idempotency key.
  //
  // Reusing one key across the loop made the grader lose to the very feature it exists to measure: a
  // correct implementation records the first (empty) body against that key, then answers every later
  // probe with 422 "idempotency-key was already used for a different request". Synthesis could never
  // progress past round 1, so the arm was scored 2/7 for having working idempotency — and the arm
  // whose idempotency did NOT enforce the body fingerprint sailed through discovery and scored 5/7.
  // The instrument was penalising correctness.
  for (const startAsStringArray of [false, true]) {
    const flatTypes = new Map();                 // field -> typeWord
    const itemFields = new Map();                // parent -> Map(child -> typeWord)
    const objectArrays = new Set();
    let body = {};

    for (let round = 0; round < 8; round++) {
      const r = await req(port, 'POST', createPath, { body, headers: headersFor() });
      if (r.status >= 200 && r.status < 300) return { body: { ...body }, res: r };
      if (!(r.status >= 400 && r.status < 500)) break;      // 5xx / dead — not a schema problem

      const { flat, nested, elemObject } = parseErrors(r.text);
      if (!flat.size && !nested.size && !elemObject.size) break;

      for (const [k, v] of flat) if (!flatTypes.has(k) || !flatTypes.get(k)) flatTypes.set(k, v);
      for (const [parent, children] of nested) {
        if (!itemFields.has(parent)) itemFields.set(parent, new Map());
        for (const [c, t] of children) itemFields.get(parent).set(c, t);
      }
      for (const p of elemObject) objectArrays.add(p);

      const before = JSON.stringify(body);
      const next = {};
      for (const [name, type] of flatTypes) {
        const isArray = type === 'array' || itemFields.has(name) || /items|lines|products/.test(name.toLowerCase());
        if (!isArray) { next[name] = valueFor(name, type, false); continue; }
        const children = itemFields.get(name);
        if (children && children.size) {
          const el = {};
          for (const [c, t] of children) el[c] = valueFor(c, t, false);
          next[name] = [el];
        } else if (objectArrays.has(name) || !startAsStringArray) {
          next[name] = [{ sku: currentRef().sku, quantity: 1, price: 9.99 }];
        } else {
          next[name] = [currentRef().sku];
        }
      }
      // A nested complaint can name a parent the flat scan never saw.
      for (const parent of itemFields.keys()) {
        if (next[parent] !== undefined) continue;
        const el = {};
        for (const [c, t] of itemFields.get(parent)) el[c] = valueFor(c, t, false);
        next[parent] = [el];
      }
      body = next;
      if (JSON.stringify(body) === before) break;           // errors stopped telling us anything new
    }
  }
  return null;
}

/** Break a valid body in a way every plausible schema should reject. */
function invalidVariants(shape, key) {
  const base = shape(key);
  const out = [{}];                                        // empty
  if (Array.isArray(base.items)) {
    out.push({ ...base, items: [] });                      // no line items
    out.push({ ...base, items: [{ ...base.items[0], quantity: -5 }] });
  } else {
    out.push({ ...base, sku: undefined, productId: undefined });
    out.push({ ...base, quantity: -5 });
  }
  return out;
}

/**
 * Does this response hand the caller a stack trace?
 *
 * The malformed-JSON checks originally asked only "did it answer 4xx and stay alive", and the negative
 * control proved that unfalsifiable: removing the app's own error handler STILL produced a 400, because
 * Express's built-in handler already does that for entity.parse.failed. The check was measuring
 * Express, not the arm.
 *
 * What the built-in handler also does, outside production, is put `err.stack` in the response body.
 * That is the actual quality difference between "handled the parse failure" and "let it fall through":
 * internal file paths and framework internals shipped to whoever sent the bad byte.
 */
function leaksStack(res) {
  const t = res.text || '';
  return /\n\s+at\s+[\w.$<>[\]]+\s*\(/.test(t) || /node_modules[\\/]/.test(t) || /\.js:\d+:\d+/.test(t);
}

async function gradeCatalog(port, logOf) {
  const S = SUITES.catalog;
  const results = [];
  const add = (id, pass, detail) => results.push({ id, pass, detail });

  const { path: listPath, first } = await discover(port, S.listCandidates);
  if (!listPath) {
    for (const c of S.checks) add(c.id, false, 'no products list endpoint found');
    return { results, listPath: null };
  }

  const itemsOf = (r) => {
    if (!r || !r.json) return null;
    if (Array.isArray(r.json)) return r.json;
    for (const k of ['data', 'items', 'results', 'products', 'rows', 'records']) {
      if (Array.isArray(r.json[k])) return r.json[k];
    }
    return null;
  };
  const idOf = (o) => (o && (o.sku ?? o.id ?? o._id ?? JSON.stringify(o)));

  add('C1-list-works', first.status === 200 && Array.isArray(itemsOf(first)),
    `GET ${listPath} → ${first.status}, items=${(itemsOf(first) || []).length}`);

  const p1 = await req(port, 'GET', `${listPath}?limit=5`);
  const p1items = itemsOf(p1) || [];
  add('C2-limit-respected', p1.status === 200 && p1items.length > 0 && p1items.length <= 5,
    `limit=5 → ${p1.status}, ${p1items.length} items`);

  // Page 2 via whichever paging dialect the arm implemented. Try the cursor it handed back first, then
  // the common offset/page spellings — an arm is not penalised for choosing a different dialect.
  const cursor = p1.json && (p1.json.nextCursor || p1.json.next_cursor || p1.json.cursor
    || (p1.json.meta && p1.json.meta.nextCursor) || (p1.json.page && p1.json.page.next));
  const page2Tries = [
    ...(cursor ? [`${listPath}?limit=5&cursor=${encodeURIComponent(cursor)}`] : []),
    `${listPath}?limit=5&offset=5`,
    `${listPath}?limit=5&page=2`,
    `${listPath}?limit=5&skip=5`,
  ];
  let disjoint = false, p2detail = 'no page-2 dialect produced different items';
  const p1ids = new Set(p1items.map(idOf));
  for (const url of page2Tries) {
    const p2 = await req(port, 'GET', url);
    const p2items = itemsOf(p2) || [];
    if (p2.status === 200 && p2items.length > 0) {
      const overlap = p2items.filter(o => p1ids.has(idOf(o))).length;
      if (overlap === 0) { disjoint = true; p2detail = `${url} → ${p2items.length} items, 0 overlap`; break; }
      p2detail = `${url} → ${p2items.length} items, ${overlap} REPEATED from page 1`;
    }
  }
  add('C3-page2-disjoint', disjoint, p2detail);

  let hostileOk = true; const hostileDetail = [];
  for (const bad of ['limit=abc', 'limit=-1', 'limit=999999']) {
    const r = await req(port, 'GET', `${listPath}?${bad}`);
    const items = itemsOf(r) || [];
    // 999999 must not dump the whole table; the fixture seeds 40, so >100 means unbounded.
    const dumped = bad === 'limit=999999' && items.length > 100;
    const ok = r.status !== 0 && r.status < 500 && !dumped;
    if (!ok) hostileOk = false;
    hostileDetail.push(`${bad}→${r.status}${dumped ? ' (UNBOUNDED)' : ''}`);
  }
  add('C4-hostile-paging-input', hostileOk, hostileDetail.join(' '));

  // Burst hard enough that any sane limit trips. Sequential: parallel floods can be dropped by the
  // socket layer and look like a limiter that fired.
  let saw429 = false, firstBlockAt = null;
  for (let i = 0; i < 120 && !saw429; i++) {
    const r = await req(port, 'GET', listPath, { timeout: 4000 });
    if (r.status === 429) { saw429 = true; firstBlockAt = i + 1; }
    if (r.status === 0) break;
  }
  add('C5-ratelimit-triggers', saw429, saw429 ? `429 after ${firstBlockAt} requests` : 'no 429 in 120 requests');

  let refilled = null;
  if (saw429) {
    await sleep(6000);                       // generous: any sane refill returns some budget in 6s
    const r = await req(port, 'GET', listPath);
    refilled = r.status === 200;
    add('C6-ratelimit-refills', refilled, `after 6s wait → ${r.status}`);
  } else {
    add('C6-ratelimit-refills', false, 'not reached — limiter never triggered');
  }

  // Traceability: a distinct id per request, in a header or in the log.
  const logBefore = logOf().length;
  const a = await req(port, 'GET', `${listPath}?limit=1`);
  const b = await req(port, 'GET', `${listPath}?limit=1`);
  const hdr = (r) => r.headers['x-request-id'] || r.headers['x-correlation-id']
    || r.headers['request-id'] || r.headers['x-trace-id'] || r.headers['traceparent'];
  let traceable = false, traceDetail = '';
  if (hdr(a) && hdr(b)) {
    traceable = hdr(a) !== hdr(b);
    traceDetail = `header ids ${hdr(a)} / ${hdr(b)}${traceable ? '' : ' (IDENTICAL — not per-request)'}`;
  } else {
    const fresh = logOf().slice(logBefore);
    const ids = fresh.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\breq[-_]?[0-9a-z]{6,}\b/gi) || [];
    traceable = new Set(ids).size >= 2;
    traceDetail = `no id header; ${new Set(ids).size} distinct id-like tokens in log`;
  }
  add('C7-request-id-traceable', traceable, traceDetail);

  const bad = await req(port, 'POST', listPath, { body: '{"broken":', headers: { 'Content-Type': 'application/json' } });
  await sleep(300);
  const alive = await req(port, 'GET', listPath.split('?')[0], { timeout: 3000 });
  const survived = alive.status !== 0;
  add('C8-malformed-json', survived && bad.status !== 0 && bad.status < 500 && !leaksStack(bad),
    `malformed→${bad.status}, server ${survived ? 'alive' : 'DEAD'}${leaksStack(bad) ? ', LEAKS STACK TRACE' : ''}`);

  return { results, listPath };
}

async function gradeIdempotency(port, logOf) {
  const S = SUITES.idempotency;
  const results = [];
  const add = (id, pass, detail) => results.push({ id, pass, detail });

  const key = () => 'k-' + crypto.randomBytes(6).toString('hex');
  const withKey = (k) => ({ 'Idempotency-Key': k, 'X-Idempotency-Key': k });
  const orderIdOf = (r) => {
    if (!r || !r.json) return null;
    const j = r.json;
    return j.id ?? j.orderId ?? j.order_id ?? (j.order && (j.order.id ?? j.order.orderId))
      ?? (j.data && (j.data.id ?? j.data.orderId)) ?? null;
  };

  // Find a route AND a body shape it accepts. Both are the arm's free choice and neither is quality.
  // Fast path: the fixed candidates. Fallback: synthesise a body from the arm's own error messages.
  let createPath = null, shape = null, c1 = null;
  outer:
  for (const p of S.createCandidates) {
    let routeExists = false;
    // Sweep CATALOG REFERENCES as well as shapes. A rejection can mean "wrong schema" OR "that product
    // is inactive / out of stock", and those are indistinguishable from out here — the app just says
    // 400. Trying one reference and concluding the schema was wrong is what zeroed every arm that
    // validates against the catalog. Refs are the outer loop so a shape that works is found with the
    // first live product rather than after exhausting all five shapes on a dead one.
    for (const ref of CATALOG_REFS) {
      CURRENT_REF = ref;
      for (const s of ORDER_SHAPES) {
        const k = key();
        const r = await req(port, 'POST', p, { body: s(k, ref), headers: withKey(k) });
        if (r.status === 0 || r.status === 404) break;        // route absent — next route
        routeExists = true;
        if (r.status >= 200 && r.status < 300) {
          createPath = p;
          // Bind the winning reference into the shape, so every later probe cites the SAME live
          // product. Re-resolving per call would let a mid-run stock change alter the outcome.
          shape = (kk) => s(kk, ref);
          c1 = r; break outer;
        }
      }
      if (!routeExists) break;                                // no route here at all — next candidate
    }
    if (routeExists) {
      if (createPath === null) createPath = p;
      // Synthesis also cites CURRENT_REF, so give it each live reference in turn before giving up.
      for (const ref of CATALOG_REFS) {
        CURRENT_REF = ref;
        const syn = await synthesizeBody(port, p, () => withKey(key()));
        if (!syn) continue;
        // Freeze the synthesised body, re-keying it wherever the arm carries the key in-body.
        const template = syn.body;
        shape = (kk) => ({ ...template, ...(('idempotencyKey' in template) ? { idempotencyKey: kk } : {}) });
        createPath = p; c1 = syn.res;
        break outer;
      }
    }
  }

  if (!shape) {
    // No shape was ever accepted. I1 fails — and so must every check that can only be demonstrated
    // by first creating an order. Leaving those as "pass" would score a server that refuses
    // everything as if it had implemented idempotency and validation correctly.
    const undemonstrable = 'no valid order could be created, so this property is undemonstrable';
    add('I1-create-works', false, createPath
      ? `POST ${createPath} rejected all ${ORDER_SHAPES.length} shapes × ${CATALOG_REFS.length} live catalog refs, and synthesis from its own errors also failed`
      : 'no order endpoint found');
    add('I2-replay-deduplicates', false, undemonstrable);
    add('I3-same-key-different-body', false, undemonstrable);
    const badJson0 = await req(port, 'POST', createPath || '/orders',
      { body: '{"sku":', headers: { 'Content-Type': 'application/json', ...withKey(key()) } });
    add('I4-malformed-json', badJson0.status !== 0 && badJson0.status < 500 && !leaksStack(badJson0),
      `malformed→${badJson0.status}${leaksStack(badJson0) ? ', LEAKS STACK TRACE' : ''}`);
    add('I5-validation-rejects-bad-body', false, undemonstrable + ' (it rejects valid ones too)');
    add('I6-concurrent-duplicate', false, undemonstrable);
    add('I7-attempt-logged', logOf().trim().length > 0, `${logOf().split('\n').filter(Boolean).length} log lines`);
    return { results, createPath };
  }

  add('I1-create-works', true, `POST ${createPath} → ${c1.status} (shape #${ORDER_SHAPES.indexOf(shape) + 1})`);

  // Replay: same route, same shape, same key.
  const k1 = key();
  const first = await req(port, 'POST', createPath, { body: shape(k1), headers: withKey(k1) });
  const c2 = await req(port, 'POST', createPath, { body: shape(k1), headers: withKey(k1) });
  const id1 = orderIdOf(first), id2 = orderIdOf(c2);
  const deduped = (id1 !== null && id2 !== null) ? String(id1) === String(id2)
    : (c2.status >= 200 && c2.status < 300 && first.text === c2.text) || c2.status === 409;
  add('I2-replay-deduplicates', deduped,
    `replay → ${c2.status}; ids ${JSON.stringify(id1)} vs ${JSON.stringify(id2)}`);

  const mutated = shape(k1);
  if (Array.isArray(mutated.items) && mutated.items[0]) mutated.items[0].quantity = 99;
  else mutated.quantity = 99;
  const c3 = await req(port, 'POST', createPath, { body: mutated, headers: withKey(k1) });
  add('I3-same-key-different-body', c3.status >= 400 && c3.status < 500,
    `same key + different body → ${c3.status} (want 4xx)`);

  const badJson = await req(port, 'POST', createPath,
    { body: '{"sku":', headers: { 'Content-Type': 'application/json', ...withKey(key()) } });
  await sleep(300);
  const aliveKey = key();
  const alive = await req(port, 'POST', createPath, { body: shape(aliveKey), headers: withKey(aliveKey), timeout: 3000 });
  add('I4-malformed-json', alive.status !== 0 && badJson.status !== 0 && badJson.status < 500 && !leaksStack(badJson),
    `malformed→${badJson.status}, server ${alive.status !== 0 ? 'alive' : 'DEAD'}${leaksStack(badJson) ? ', LEAKS STACK TRACE' : ''}`);

  let allRejected = true; const vDetail = [];
  for (const body of invalidVariants(shape, key())) {
    const r = await req(port, 'POST', createPath, { body, headers: withKey(key()) });
    const ok = r.status >= 400 && r.status < 500;
    if (!ok) allRejected = false;
    vDetail.push(`${JSON.stringify(body).slice(0, 30)}→${r.status}`);
  }
  add('I5-validation-rejects-bad-body', allRejected, vDetail.join(' '));

  const k2 = key();
  const [r1, r2] = await Promise.all([
    req(port, 'POST', createPath, { body: shape(k2), headers: withKey(k2) }),
    req(port, 'POST', createPath, { body: shape(k2), headers: withKey(k2) }),
  ]);
  const ids = [orderIdOf(r1), orderIdOf(r2)].filter(v => v !== null).map(String);
  const created = [r1, r2].filter(r => r.status >= 200 && r.status < 300).length;
  // At most one NEW order: either identical ids, or one of the pair was refused (409).
  const oneOrder = (ids.length === 2 ? ids[0] === ids[1] : true) && created <= 2
    && !(ids.length === 2 && ids[0] !== ids[1]);
  add('I6-concurrent-duplicate', oneOrder,
    `statuses ${r1.status}/${r2.status}, ids ${JSON.stringify(ids)}`);

  const logNow = logOf();
  add('I7-attempt-logged', /order|POST|request|attempt/i.test(logNow) && logNow.trim().length > 0,
    `${logNow.split('\n').filter(Boolean).length} log lines`);

  return { results, createPath };
}

/**
 * The environment a deployer would supply. WEBHOOK_SECRET is chosen by the grader, not guessed, so
 * every signature below is a real one computed against a secret the app was actually given.
 */
const SJ_SECRET = 'whsec_stratabench0000000000000000';
const SJ_ENV = {
  STRIPE_WEBHOOK_SECRET: SJ_SECRET,
  STRIPE_WEBHOOK_SECRET_KEY: SJ_SECRET,
  WEBHOOK_SECRET: SJ_SECRET,
  STRIPE_SECRET_KEY: 'sk_test_stratabench0000000000000000',
  STRIPE_API_KEY: 'sk_test_stratabench0000000000000000',
  SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_USER: 'bench', SMTP_PASS: 'bench',
  EMAIL_FROM: 'receipts@bench.local', MAIL_FROM: 'receipts@bench.local',
  REDIS_URL: 'redis://127.0.0.1:6379', REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379',
};

/**
 * A real SMTP server, because SJ_ENV promises one.
 *
 * Handing an app `SMTP_HOST=127.0.0.1 SMTP_PORT=1025` and then running nothing there is not a neutral
 * omission — it is a trap that springs on exactly the apps that do what the prompt asked. The task says
 * "email confirmation on purchase", the grader's event carries `receipt_email`, so a correct app calls
 * Nodemailer, the TCP connect to a dead port hangs, the webhook request never returns, and this
 * grader's client times out. A timeout surfaces as `status 0`, which the discovery loop reads as
 * "no such route" — so the app was scored `0/8 no webhook endpoint found` for having implemented the
 * feature. Two runs (baseline-opus-1, strata-sonnet-3) were zeroed exactly this way, and both serve
 * `/webhooks/stripe` correctly when probed by hand.
 *
 * That is the fourth time this instrument has failed asymmetrically against the more complete
 * implementation (see CATALOG_REFS, the P6 dupe-line filter, and the express.raw discovery bug). The
 * pattern is always the same: the grader's environment is less capable than the code it is judging,
 * and the shortfall is scored as the code's defect.
 *
 * So: speak enough SMTP to accept and discard a message. Nothing is asserted about the mail — delivery
 * is not graded, it just must not hang.
 */
let SMTP_SINGLETON = null;

/**
 * ONE server for the whole process, started lazily and never stopped.
 *
 * Starting and stopping it per run made grades ORDER-DEPENDENT: the listening socket lingers in
 * TIME_WAIT after close(), the next run's listen() hits EADDRINUSE, the error handler swallows it, and
 * that run silently grades against a dead SMTP port — the exact hang this server exists to prevent.
 * Observed live: baseline-opus-2 scored 7/8 and then 0/8 across two passes with nothing else changed.
 * A grade that depends on what was graded before it is not a measurement.
 */
function startFakeSmtp(port = 1025) {
  if (SMTP_SINGLETON) return SMTP_SINGLETON;
  let accepted = 0;
  const server = net.createServer((sock) => {
    let inData = false;
    sock.setEncoding('utf-8');
    sock.write('220 bench.local ESMTP ready\r\n');
    sock.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (inData) {
          if (line === '.') { inData = false; accepted++; sock.write('250 2.0.0 Ok: queued\r\n'); }
          continue;                                   // message body — discarded
        }
        if (!line) continue;
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') sock.write('250-bench.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'HELO') sock.write('250 bench.local\r\n');
        else if (verb === 'AUTH') sock.write('235 2.7.0 Authentication successful\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 2.1.0 Ok\r\n');
        else if (verb === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
        else if (verb === 'RSET' || verb === 'NOOP') sock.write('250 2.0.0 Ok\r\n');
        else sock.write('250 2.0.0 Ok\r\n');           // permissive: never make the client wait
      }
    });
    sock.on('error', () => { /* client vanished mid-session — not our problem */ });
  });
  server.on('error', (e) => {
    // Nothing here may be swallowed silently — a dead SMTP port is the failure mode this whole
    // function exists to prevent, and it manifests as an unrelated 0/8.
    console.error(`\n  !! fake SMTP could not listen on ${port}: ${e.code}. `
      + 'stripejune grades from this pass are NOT trustworthy.');
  });
  server.listen(port, '127.0.0.1');
  server.unref();                                    // never hold the process open
  SMTP_SINGLETON = { close: () => {}, count: () => accepted };
  return SMTP_SINGLETON;
}

let REDIS_SINGLETON = null;

/**
 * Enough Redis to CONNECT. Same argument as startFakeSmtp, one layer down.
 *
 * SJ_ENV promises REDIS_URL=redis://127.0.0.1:6379 and this machine has no Redis, so an app that wires
 * BullMQ — which the task explicitly asks for — gets ECONNREFUSED on its client and dies before it
 * ever listens. An app that ignored the queue requirement boots perfectly. Scoring that difference as
 * code quality is backwards: it fails the implementation that did MORE of the task.
 *
 * This is deliberately NOT a working Redis. It answers the handshake ioredis performs on connect
 * (PING/INFO/CLIENT/COMMAND) so the connection establishes and the process survives startup. Real
 * queue operations (EVALSHA, BZPOPMIN) return errors, and that is fine and honest: queue BEHAVIOUR is
 * explicitly out of scope for this suite — only the HTTP surface is graded. What this buys is that
 * "did the app start" stops being a question about the grader's dependencies.
 */
function startFakeRedis(port = 6379) {
  if (REDIS_SINGLETON) return REDIS_SINGLETON;
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      // RESP arrays: *N\r\n$len\r\nARG\r\n... Parse loosely — we only need the command word.
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        if (line[0] !== '*') { buf = buf.slice(idx + 2); continue; }
        const argc = Number(line.slice(1));
        if (!Number.isFinite(argc) || argc < 1) { buf = buf.slice(idx + 2); continue; }
        // Need the whole command present before consuming it.
        let cursor = idx + 2;
        const args = [];
        let complete = true;
        for (let i = 0; i < argc; i++) {
          const lenEnd = buf.indexOf('\r\n', cursor);
          if (lenEnd === -1) { complete = false; break; }
          const len = Number(buf.slice(cursor + 1, lenEnd));
          const valStart = lenEnd + 2;
          if (buf.length < valStart + len + 2) { complete = false; break; }
          args.push(buf.slice(valStart, valStart + len));
          cursor = valStart + len + 2;
        }
        if (!complete) return;                       // wait for the rest of the packet
        buf = buf.slice(cursor);

        const cmd = String(args[0] || '').toUpperCase();
        // HELLO must be an ERROR, not +OK. node-redis opens with a RESP3 `HELLO 3` handshake and
        // expects a map back; a bare +OK is a protocol violation and the client destroys the
        // connection — which looked exactly like Redis being down. Real Redis before 6.0 answers
        // "unknown command", and every client treats that as "speak RESP2" and carries on. Answering
        // like an old Redis is both honest and the version that works.
        if (cmd === 'HELLO') sock.write("-ERR unknown command 'HELLO'\r\n");
        else if (cmd === 'PING') sock.write('+PONG\r\n');
        else if (cmd === 'INFO') {
          // ioredis reads this to decide the connection is usable.
          const info = 'redis_version:7.0.0\r\nredis_mode:standalone\r\nrole:master\r\nconnected_clients:1\r\n';
          sock.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
        } else if (cmd === 'COMMAND') sock.write('*0\r\n');
        else if (cmd === 'QUIT') { sock.write('+OK\r\n'); sock.end(); }
        else if (cmd === 'SUBSCRIBE' || cmd === 'PSUBSCRIBE') {
          sock.write(`*3\r\n$9\r\nsubscribe\r\n$${Buffer.byteLength(String(args[1] || ''))}\r\n${args[1] || ''}\r\n:1\r\n`);
        } else if (cmd === 'EVALSHA' || cmd === 'EVAL' || cmd === 'SCRIPT') {
          // Honest: we cannot run Lua. Returning an error keeps the client alive rather than hanging.
          sock.write('-ERR fake redis does not execute scripts\r\n');
        } else sock.write('+OK\r\n');
      }
    });
    sock.on('error', () => { /* client gone mid-command */ });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') return;             // a REAL redis is running — even better
    console.error(`\n  !! fake redis could not listen on ${port}: ${e.code}`);
  });
  server.listen(port, '127.0.0.1');
  server.unref();
  REDIS_SINGLETON = { close: () => {} };
  return REDIS_SINGLETON;
}

/** A real Stripe-format signature header over the EXACT bytes given. */
function stripeSig(raw, timestamp = Math.floor(Date.now() / 1000), secret = SJ_SECRET) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return { 'Stripe-Signature': `t=${timestamp},v1=${v1}` };
}

/** Stripe events an arm might plausibly handle. Trying several is DISCOVERY — an arm that handles
 *  checkout.session.completed and not charge.succeeded chose a scope, which is not a quality defect. */
const SJ_EVENT_TYPES = [
  'checkout.session.completed', 'payment_intent.succeeded',
  'charge.succeeded', 'invoice.payment_succeeded',
];

function sjEvent(id, type, extra = '') {
  return `{"id":"${id}","object":"event","type":"${type}","created":${Math.floor(Date.now() / 1000)},`
    + `"data":{"object":{"id":"pi_${id}","object":"payment_intent","amount":2000,"currency":"usd",`
    + `"status":"succeeded","receipt_email":"buyer@example.com","customer_email":"buyer@example.com"${extra}}}}`;
}

async function gradeStripejune(port, logOf) {
  const results = [];
  const add = (id, pass, detail) => results.push({ id, pass, detail });
  const leaks = (r) => /at\s+\w+[\s\S]*\(.*:\d+:\d+\)|\bError:\s.*\n\s+at\s/.test(r.text || '');
  const leaksSecret = (r) => (r.text || '').includes(SJ_SECRET) || /whsec_/.test(r.text || '');

  // ---- discovery: which path is the webhook, and which event type does it acknowledge? ----
  //
  // A TIMEOUT IS NOT A MISSING ROUTE. This distinction is the whole reason the block below is not two
  // lines. `req` reports both a dead port and a request that never came back as `status 0`, and the
  // first version of this loop treated both as "no such route" — so an app whose webhook does the PDF
  // and the SMTP send inline, and therefore answers slowly, was reported as having NO WEBHOOK AT ALL
  // and scored 0/8. That is a serious real defect (Stripe gives up around 10s and retries), but it is
  // ONE defect, and it must cost the checks it actually implicates, not all eight.
  //
  // Observed live: baseline-opus-2 scored 7/8 while SMTP was dead — the connection refused instantly,
  // so the handler errored and answered fast — and 0/8 once a working SMTP server made it do the real
  // work. Fixing one hole in the environment opened another; the grade moved for a reason that had
  // nothing to do with the code.
  let hook = null, evType = null, okStatus = null, validMs = null, hookTimedOut = false;
  outer:
  for (const p of SUITES.stripejune.webhookCandidates) {
    for (const t of SJ_EVENT_TYPES) {
      const raw = sjEvent('evt_discovery', t);
      const t0 = Date.now();
      const r = await req(port, 'POST', p, { body: raw, headers: stripeSig(raw), timeout: 30_000 });
      if (r.timedOut) { hook = p; hookTimedOut = true; break outer; }   // route EXISTS, and is too slow
      if (r.status === 0) break;                                        // connection refused — no route here
      if (r.status === 404) break;                                      // not this path
      if (r.status >= 200 && r.status < 300) {
        hook = p; evType = t; okStatus = r.status; validMs = Date.now() - t0; break outer;
      }
      hook = p;                                                         // route exists but said no
    }
  }

  // P1 is critical and first BECAUSE every rejection check below is trivially satisfied by a route
  // that refuses everything — including one that never finished starting.
  add('P1-webhook-accepts-valid-signature', !!evType,
    evType ? `POST ${hook} (${evType}) → ${okStatus} in ${validMs}ms`
      : hookTimedOut ? `POST ${hook} never answered a correctly signed event within 30s — Stripe gives up at ~10s and retries`
        : hook ? `POST ${hook} refused a correctly signed event of all ${SJ_EVENT_TYPES.length} types`
          : 'no webhook endpoint found');

  // If no route was found at ALL, nothing below is observable and every check is genuinely
  // undemonstrable. But that is the ONLY case that cascades.
  if (!hook) {
    const un = 'no webhook endpoint exists, so this property is undemonstrable';
    for (const id of ['P2-unsigned-rejected', 'P3-forged-signature-rejected', 'P4-raw-body-verification',
      'P5-replay-window-enforced', 'P6-duplicate-event-once', 'P7-webhook-answers-promptly',
      'P8-no-secret-or-stack-leak']) add(id, false, un);
    return { results, createPath: hook };
  }

  /**
   * The REJECTION checks do not need a working happy path, and pretending they do was costing five
   * checks for one defect.
   *
   * P2/P3/P5/P8 assert that a bad request is turned away. A correct implementation rejects on the
   * signature BEFORE it ever touches Stripe, the queue, the database or SMTP — so these are observable
   * even when the accepted path hangs or errors, and they are exactly the security properties this
   * suite exists to measure. Only P4 (needs an accepted baseline to compare against), P6 (needs work to
   * happen once) and P7 (needs a completed timing) genuinely depend on P1.
   *
   * They are also fast by construction, so they get a short timeout: an implementation that takes ten
   * seconds to say "bad signature" is doing the work first and checking afterwards, which is its own
   * defect and shows up as a failure here rather than as a hang.
   */
  const gradedByRejection = !evType;
  if (gradedByRejection) {
    for (const id of ['P4-raw-body-verification', 'P6-duplicate-event-once']) {
      add(id, false, 'requires an accepted webhook, and none was accepted');
    }
    add('P7-webhook-answers-promptly', false,
      hookTimedOut ? 'did not answer within 30s' : 'no accepted webhook to time');
  }

  const post = (raw, headers, timeout = 15_000) => req(port, 'POST', hook, { body: raw, headers, timeout });
  // When nothing was accepted, evType is null — the rejection probes still need a plausible event
  // shape, and which type it is cannot matter, because a correct implementation rejects on the
  // signature long before it looks at `type`.
  const probeType = evType || SJ_EVENT_TYPES[0];

  // ---- P2: no signature at all ----
  const rawU = sjEvent('evt_unsigned', probeType);
  const unsigned = await post(rawU, {});
  add('P2-unsigned-rejected', unsigned.status >= 400 && unsigned.status < 500,
    `unsigned → ${unsigned.status}${unsigned.status >= 200 && unsigned.status < 300
      ? '  ANYONE CAN FORGE A PAID ORDER' : ''}`);

  // ---- P3: well-formed header, wrong HMAC ----
  const rawF = sjEvent('evt_forged', probeType);
  const forged = await post(rawF, { 'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
  add('P3-forged-signature-rejected', forged.status >= 400 && forged.status < 500,
    `forged v1 → ${forged.status}`);

  // ---- P4: signature computed over the RAW bytes, not a re-serialization ----
  // The payload's byte form differs from JSON.stringify(JSON.parse(payload)) by whitespace only, and
  // is signed over the bytes. Correct (express.raw) code accepts; code that verifies against a
  // re-serialized body computes a different HMAC and rejects. Nothing else about the request changes.
  // Skipped when nothing was ever accepted — without a passing baseline a rejection here proves
  // nothing about raw-body handling, so it was already recorded above.
  if (!gradedByRejection) {
    const rawR = sjEvent('evt_rawbody', probeType).replace('"amount":2000', '"amount":  2000');
    const reserialized = JSON.stringify(JSON.parse(rawR));
    const rawProbe = await post(rawR, stripeSig(rawR));
    add('P4-raw-body-verification', rawProbe.status >= 200 && rawProbe.status < 300,
      reserialized === rawR ? 'INCONCLUSIVE — payload survived re-serialization unchanged'
        : `whitespace-bearing raw payload → ${rawProbe.status}`);
  }

  // ---- P5: genuinely valid signature, but an hour old ----
  const rawOld = sjEvent('evt_replay', probeType);
  const old = await post(rawOld, stripeSig(rawOld, Math.floor(Date.now() / 1000) - 3600));
  add('P5-replay-window-enforced', old.status >= 400 && old.status < 500,
    `1-hour-old timestamp, valid HMAC → ${old.status}`);

  // ---- P6: the same event.id delivered twice ----
  // Stripe re-delivers on any non-2xx and on timeout, so this is not hypothetical. Both deliveries
  // SHOULD be acknowledged (2xx) — what must not happen twice is the work. Measured by what the app
  // itself reports doing: the log lines it emits about queueing/mailing/receipting.
  const workLine = /queue|queued|enqueue|job|receipt|pdf|mail|email|sent|process(ing|ed)/i;
  // A line announcing the dedupe is NOT work. "duplicate evt_x, already processed" matches `processed`
  // and would otherwise be counted as a second unit of work — failing P6 for the apps that dedupe AND
  // say so, which are the best ones. Same asymmetry as everything else in this file.
  const dupeLine = /duplicate|already|idempot|skip|ignor|seen|cached/i;
  const countWork = (s) => (s || '').split('\n')
    .filter(l => workLine.test(l) && !dupeLine.test(l)).length;
  if (!gradedByRejection) {
    const rawD = sjEvent('evt_duplicate_stable', probeType);
    const before = countWork(logOf());
    await post(rawD, stripeSig(rawD));
    await sleep(600);
    const mid = countWork(logOf());
    const d2 = await post(rawD, stripeSig(rawD));
    await sleep(600);
    const after = countWork(logOf());
    const firstDid = mid - before, secondDid = after - mid;
    const bodySignalsDupe = /duplicate|already|idempot|skip|seen/i.test(`${d2.text || ''}`);
    add('P6-duplicate-event-once',
      (firstDid > 0 && secondDid === 0) || (bodySignalsDupe && d2.status < 300),
      firstDid > 0 || secondDid > 0
        ? `work lines: 1st delivery +${firstDid}, 2nd delivery +${secondDid}`
        : `no work logged either time; 2nd response ${bodySignalsDupe ? 'signals duplicate' : 'gives no dedupe signal'} (${d2.status})`);

    // ---- P7: answered promptly, i.e. the heavy work was deferred ----
    // Generous threshold: PDF generation plus an SMTP round trip inline is seconds, not milliseconds.
    add('P7-webhook-answers-promptly', validMs < 3000,
      `valid webhook answered in ${validMs}ms (limit 3000)`);
  }

  // ---- P8: rejections must not hand the attacker the answer ----
  const dirty = [unsigned, forged, old].filter(r => leaks(r) || leaksSecret(r));
  add('P8-no-secret-or-stack-leak', dirty.length === 0,
    dirty.length ? `${dirty.length} of 3 rejections leaked a stack trace or the signing secret`
      : 'no stack trace, no whsec_ in any rejection body');

  return { results, createPath: hook };
}

/**
 * Grade the retry helper by asking an ISOLATED probe what it did.
 *
 * The probe runs in its own process (retry-probe.js) because discovery must require() files from the
 * delivered tree, and those files start servers, print banners and throw. Doing it in-process bound
 * ports for the rest of the batch and let one tree's uncaught exception kill the whole grading pass.
 *
 * Every number below comes from the upstream server's arrival log inside that probe — never from what
 * the helper says about itself. A helper reporting "3 attempts" while making 30 is the exact defect R2
 * hunts, so asking it would be asking the defendant for the verdict.
 */
async function gradeRetry(dir) {
  const results = [];
  const add = (id, pass, detail) => results.push({ id, pass, detail });

  const r = spawnSync(process.execPath, [path.join(__dirname, 'retry-probe.js'), dir],
    { encoding: 'utf-8', timeout: 180_000 });
  let probe = null;
  try {
    const line = (r.stdout || '').trim().split(/\r?\n/).filter(l => l.trim().startsWith('{')).pop();
    probe = JSON.parse(line);
  } catch { /* probe crashed or printed nothing parseable */ }

  // A tree the probe cannot DRIVE is an absent measurement, not a score of zero — same rule as a run
  // that produced no report. Counting a harness limitation as the arm's failure is how a benchmark
  // ends up publishing its own blind spots as findings.
  if (probe && probe.unmeasurable) {
    return { results: [], createPath: null, unmeasurable: probe.unmeasurable };
  }

  if (!probe || !probe.ok) {
    const un = probe && probe.error
      ? `the probe could not drive any export: ${probe.error}`
      : 'no exported function reached the upstream when called — nothing here performs the request';
    for (const c of SUITES.retry.checks) add(c.id, false, un);
    return { results, createPath: null };
  }

  const p = probe.probes;

  add('R1-retries-then-succeeds', !!(p.recover && p.recover.recovered && p.recover.attempts >= 3),
    p.recover ? `${p.recover.attempts} attempt(s), ${p.recover.recovered ? 'recovered' : 'gave up'}`
      + (p.recover.err ? ' — ' + p.recover.err : '') : 'not probed');

  add('R7-succeeds-first-time-without-waiting',
    !!(p.healthy && !p.healthy.threw && p.healthy.attempts === 1 && p.healthy.ms < 1000),
    p.healthy ? `${p.healthy.attempts} attempt(s) in ${p.healthy.ms}ms${p.healthy.threw ? ' — threw on a 200' : ''}` : 'not probed');

  const ex = p.exhaust || {};
  add('R2-gives-up-eventually', !ex.hung && ex.attempts > 0 && ex.attempts <= 10,
    ex.hung ? `still retrying after 25s (${ex.attempts} attempts) — unbounded` : `stopped after ${ex.attempts} attempt(s)`);

  const gaps = ex.gaps || [];
  if ((ex.attempts || 0) >= 2 && gaps.length >= 1) {
    const maxGap = Math.max(...gaps);
    add('R3-actually-waits', maxGap >= 40,
      `gaps: ${gaps.join('ms, ')}ms${maxGap < 40 ? ' — a tight loop, not backoff' : ''}`);
    if (gaps.length >= 2) {
      add('R4-backoff-grows', gaps[1] > gaps[0] * 1.4,
        `${gaps[0]}ms → ${gaps[1]}ms${gaps[1] > gaps[0] * 1.4 ? '' : ' — constant delay, not growing'}`);
    } else {
      add('R4-backoff-grows', false, `only ${ex.attempts} attempts — one wait cannot show growth`);
    }
  } else {
    add('R3-actually-waits', false, `only ${ex.attempts || 0} attempt(s) — nothing was spaced`);
    add('R4-backoff-grows', false, `only ${ex.attempts || 0} attempt(s) — nothing to compare`);
  }

  add('R6-surfaces-the-failure', !ex.hung && !!ex.threw && ex.returnedUndefined !== false,
    ex.hung ? 'never returned' : ex.threw ? `threw: ${ex.threw}` : 'exhausted its attempts and returned normally instead of reporting the failure');

  const ce = p.clientError || {};
  add('R5-no-retry-on-4xx', ce.attempts === 1,
    `a 400 was requested ${ce.attempts} time(s)${ce.attempts > 1 ? ' — a 4xx can never succeed on retry' : ''}`);

  return { results, createPath: probe.helper };
}

async function gradeDir(dir, suiteName) {
  const started = Date.now();
  /**
   * retry has no HTTP surface — it is a helper module, and booting it would prove nothing.
   *
   * Handled before boot() rather than inside it, because "the server never started" is the correct
   * and expected outcome for a library, and grading it as a boot failure would score every arm 0/7
   * for having done exactly what the prompt asked.
   */
  if (suiteName === 'retry') {
    const out = await gradeRetry(dir);
    const passed = out.results.filter(r => r.pass).length;
    return {
      suite: suiteName, suiteHash: SUITE_HASH, dir, booted: true, entry: '(module, not a server)',
      discovered: out.createPath, results: out.results,
      unmeasurable: out.unmeasurable,
      passed, total: out.results.length, ms: Date.now() - started,
    };
  }

  // Stand the SMTP and Redis servers up BEFORE the app boots — clients are constructed at startup and
  // a refused connection is what kills the process before it ever listens.
  const smtp = suiteName === 'stripejune' ? startFakeSmtp() : null;
  if (suiteName === 'stripejune') startFakeRedis();
  try {
  const b = await boot(dir, suiteName === 'stripejune' ? SJ_ENV : {});
  if (!b.ok) {
    const S = SUITES[suiteName];
    return {
      suite: suiteName, suiteHash: SUITE_HASH, dir, booted: false, bootReason: b.reason,
      results: S.checks.map(c => ({ id: c.id, pass: false, detail: 'server never booted' })),
      passed: 0, total: S.checks.length, ms: Date.now() - started,
    };
  }
  let out;
  try {
    out = suiteName === 'catalog' ? await gradeCatalog(b.port, b.log)
      : suiteName === 'stripejune' ? await gradeStripejune(b.port, b.log)
        : await gradeIdempotency(b.port, b.log);
  } finally {
    try { b.child.kill(); } catch { /* already gone */ }
  }
  const passed = out.results.filter(r => r.pass).length;
  return {
    suite: suiteName, suiteHash: SUITE_HASH, dir, booted: true, entry: b.entry,
    discovered: out.listPath || out.createPath || null,
    mailAccepted: smtp ? smtp.count() : undefined,
    results: out.results, passed, total: out.results.length, ms: Date.now() - started,
  };
  } finally {
    if (smtp) smtp.close();
  }
}

/**
 * Where a run's code actually lives NOW.
 *
 * Grading used to read `run.dir` only — `os.tmpdir()/bench-XXXXXX` — and SKIP the run when that
 * directory was gone. That made every grade quietly perishable: Windows Storage Sense clears Temp on
 * its own schedule, and the moment it did, thirty runs would become permanently ungradeable while
 * `benchmark/runs/exp-quality/trees/` sat right there holding a verbatim copy of every one of them.
 *
 * The archive was built precisely so the evidence would outlive Temp, and then nothing read it. An
 * unused backup is not a backup.
 *
 * Temp is still preferred when present, because it carries node_modules and boots immediately; the
 * archive excludes node_modules (reinstallable, not evidence) so boot() reinstalls on the way in. The
 * source is recorded on the grade so a number can always be traced to the bytes it came from.
 */
function resolveTree(runsDir, stem, run) {
  if (run.dir && fs.existsSync(run.dir)) return { dir: run.dir, source: 'temp' };
  const archived = path.join(runsDir, 'trees', stem);
  if (fs.existsSync(archived)) return { dir: archived, source: 'archive' };
  return null;
}

module.exports = { gradeDir, resolveTree, SUITE_HASH };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const runsDir = path.join(__dirname, '..', 'runs', 'exp-quality');

    if (args.includes('--all')) {
      const gradesPath = path.join(runsDir, 'GRADES.json');
      // Run artifacts are lowercase; report files are SHOUTED (GRADES/QUALITY-SUMMARY/STATIC-ANALYSIS).
      // Naming them individually meant each new report had to be remembered here — STATIC-ANALYSIS.json
      // was not, and got announced as a run with a missing output tree.
      const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json') && !/[A-Z]/.test(f));

      // RESUMABLE, and written after every run. This machine reaps long-lived node processes without
      // warning (exit 127, empty log), and a grading pass that only persists at the end loses
      // everything each time it is killed — the same reason the battery runner is resumable.
      //
      // Entries graded by a DIFFERENT instrument are discarded, not kept: the suite hash covers both
      // the checks and the code that runs them, so mixing fingerprints in one file would silently
      // compare runs that were not measured the same way.
      let grades = [];
      if (fs.existsSync(gradesPath)) {
        try {
          const prior = JSON.parse(fs.readFileSync(gradesPath, 'utf-8'));
          if (prior.suiteHash === SUITE_HASH && Array.isArray(prior.grades)) grades = prior.grades;
          else console.log(`(discarding grades from instrument ${prior.suiteHash} — current is ${SUITE_HASH})`);
        } catch { /* corrupt file — regrade from scratch */ }
      }
      // Keyed by STEM, not by directory, because the directory a run is graded from is allowed to
      // change — see resolveTree. Keying on dir meant a run graded from Temp and then re-graded from
      // its archive counted as two different runs.
      const doneStems = new Set(grades.map(g => g.stem).filter(Boolean));

      for (const f of files) {
        const stem = f.replace(/\.json$/, '');
        const run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf-8'));

        /**
         * A run that never produced a report is not a zero — it is an ABSENT measurement, and the two
         * must never be recorded the same way.
         *
         * When a session limit killed thirteen stripejune spawns mid-batch, each left a run artifact
         * with ok=false, one turn, no cost and a three-file stub tree. Grading them would have entered
         * thirteen 0/8 rows into GRADES.json that look exactly like "the model wrote code that fails
         * every check" — and they would have been averaged into the arms, mostly into sonnet and opus,
         * because that is where the batch happened to be when the limit hit. The board would have shown
         * Strata beating the frontier tiers by a landslide, on evidence that the API refused to serve.
         *
         * The battery already treats these as not-done and re-runs them; grading now agrees.
         */
        if (run.ok !== true) {
          console.log(`SKIP ${f} — run produced no report (ok=false); absent, not zero`);
          continue;
        }

        const tree = resolveTree(runsDir, stem, run);
        if (!tree) {
          console.log(`SKIP ${f} — no tree in Temp OR archive; this run can no longer be graded`);
          continue;
        }
        if (doneStems.has(stem)) { console.log(`skip ${f} — already graded by this instrument`); continue; }
        process.stdout.write(`grading ${f}${tree.source === 'archive' ? ' [from archive]' : ''} ... `);
        const g = await gradeDir(tree.dir, run.task);
        g.stem = stem;
        g.treeSource = tree.source;
        g.run = { task: run.task, arm: run.arm, model: run.model, run: run.run, turns: run.turns, costUsd: run.costUsd };
        grades.push(g);
        fs.writeFileSync(gradesPath, JSON.stringify({ suiteHash: SUITE_HASH, grades }, null, 2));
        console.log(`${g.passed}/${g.total}${g.booted ? '' : ' (NO BOOT: ' + g.bootReason + ')'}`);
      }
      console.log(`\nGRADES.json holds ${grades.length} runs (instrument ${SUITE_HASH})`);
      return;
    }

    const target = args[0];
    if (!target) { console.error('usage: grade.js <runDir> --suite <catalog|idempotency>  |  --all'); process.exit(1); }
    const i = args.indexOf('--suite');
    const suite = i !== -1 ? args[i + 1] : 'catalog';
    const g = await gradeDir(target, suite);
    console.log(JSON.stringify(g, null, 2));
  })();
}
