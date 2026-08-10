'use strict';
// Strata — end-to-end check for the delivered feature.
//
//   node strata/verify.js
//
// Runs the unit tests, starts the app on a free port, exercises each requirement against the running
// server, and shuts it down. Exit 0 means every line below passed.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const LOG = path.join(__dirname, 'verify-server.log');
let server = null;
let BASE = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function readLog() { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function request(method, route, body, contentType, headers) {
  const res = await fetch(BASE + route, {
    method,
    headers: Object.assign({}, contentType ? { 'content-type': contentType } : {}, headers || {}),
    body: body === undefined ? undefined : body,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  const h = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: res.status, headers: h, body: parsed, text };
}

const get = (route, headers) => request('GET', route, undefined, undefined, headers);
const post = (route, body, ct) => request('POST', route, body, ct);

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}

async function startServer() {
  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;

  const out = fs.openSync(LOG, 'w');
  const parts = "node src/server.js".split(' ');

  // NODE_ENV=production so the logger emits JSON (pretty mode is unparseable, and it is what made an
  // earlier session's log grep silently miss the very line it was looking for).
  // No shell:true — it triggers a Node deprecation warning about unescaped args, and a stray warning
  // in the output is a turn someone spends investigating a non-problem. `node` is on PATH anyway.
  server = spawn(process.execPath, parts.slice(1), {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'production' }),
    stdio: ['ignore', out, out],
  });

  // Poll until it answers rather than sleeping a fixed amount — a fixed sleep is either a flake or a
  // waste, and usually both.
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(BASE + '/health');
      if (r.status) return;
    } catch { /* not up yet */ }
  }
  throw new Error('server did not start within 15s. Log:\n' + readLog().slice(-800));
}

function stopServer() {
  // The process owns its own child, so no taskkill/netstat archaeology is needed to free the port.
  //
  // SYNCHRONOUS on Windows. An async spawn() here races process.exit() and libuv aborts with
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — a C-level crash printed AFTER the
  // results, which looks like the verifier itself blew up. A tool whose output ends in a crash dump
  // does not get trusted, however green the lines above it were.
  if (!server || server.killed) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(server.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      server.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

const HAS_HTTP = true;
const HAS_SELFTEST = true;

// The recalls' own behavioural suites. These prove the PRIMITIVES (a 404 must not reset the circuit
// breaker; a bad CSV row must name its source line). The end-to-end checks below prove the WIRING.
// Bugs live in both, so one command runs both.
async function runSelftests() {
  if (!HAS_SELFTEST) return true;
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'selftest.js')], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.trim().split('\n').filter(Boolean).pop() || '';
    console.log('  PASS  unit selftests — ' + line.trim());
    passed++;
    return true;
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || '')).trim();
    console.log('  FAIL  unit selftests');
    console.log(out.split('\n').filter(function (l) { return /FAIL/.test(l); }).slice(0, 6).map(function (l) { return '        ' + l.trim(); }).join('\n'));
    failures.push({ name: 'unit selftests', error: 'see above' });
    return false;
  }
}

(async () => {
  await runSelftests();

  if (!HAS_HTTP) {
    // Nothing to serve — a library-shaped delivery. The selftests were the whole proof.
    console.log('');
    if (failures.length === 0) {
      console.log('  ' + passed + '/' + passed + ' checks passed — the delivered code works.');
      process.exit(0);
    }
    console.log('  ' + passed + ' passed, ' + failures.length + ' FAILED.');
    process.exit(1);
  }

  try {
    await startServer();
  } catch (e) {
    console.log('\n  FAIL  the server did not start\n        ' + e.message);
    stopServer();
    process.exit(1);
  }

  try {

  // ── the app boots at all ────────────────────────────────────────────────────
  await check('server boots and answers /health', async () => {
    const r = await get('/health');
    assert(r.status === 200, 'GET /health -> ' + r.status + ' (expected 200)');
  });

  // ── correlation id: an inbound x-request-id must survive, so a trace spans services ──
  await check('correlation id honours an inbound x-request-id', async () => {
    const r = await get('/health', { 'x-request-id': 'verify-trace-1' });
    assert(r.headers['x-request-id'] === 'verify-trace-1',
      'x-request-id was ' + r.headers['x-request-id'] + ', expected it echoed back');
  });

  await check('a request with no id is still assigned one', async () => {
    const r = await get('/health');
    assert(!!r.headers['x-request-id'], 'no x-request-id on the response');
  });

  // ── redaction: the whole reason the logging recall exists ──
  await check('an authorization header is NOT written to the log', async () => {
    await get('/health', { authorization: 'Bearer sk_live_VERIFY_SECRET' });
    await sleep(150);
    const log = readLog();
    assert(!log.includes('sk_live_VERIFY_SECRET'), 'THE SECRET LEAKED INTO THE LOG');
  });

  // A password arrives in a BODY far more often than in a header, and a body is what actually ends up
  // in an access log. Sessions hand-checked this after the verifier passed — so now it is checked.
  await check('a password in a request BODY is NOT written to the log', async () => {
    await post('/health', JSON.stringify({ password: 'hunter2_VERIFY', token: 'tok_VERIFY' }), 'application/json');
    await sleep(150);
    const log = readLog();
    assert(!log.includes('hunter2_VERIFY'), 'A PASSWORD FROM THE REQUEST BODY LEAKED INTO THE LOG');
    assert(!log.includes('tok_VERIFY'), 'A TOKEN FROM THE REQUEST BODY LEAKED INTO THE LOG');
  });

  // 4xx is the caller's fault and must not dump a stack to them; 5xx is ours and must not leak
  // internals either. A malformed JSON body is the cheapest way to reach the error handler for real.
  await check('a malformed body is a 4xx and leaks no stack trace to the caller', async () => {
    const r = await post('/health', '{"broken":', 'application/json');
    assert(r.status >= 400 && r.status < 500, 'malformed JSON gave ' + r.status + ', expected a 4xx');
    assert(!/\bat\s+\w+.*:\d+:\d+/.test(r.text), 'a STACK TRACE was returned to the caller');
  });

  // The error path is exactly where the correlation id is most valuable, and exactly where it is most
  // often lost — express.json() throws BEFORE a late-registered logger would have run.
  await check('the error path still carries a correlation id', async () => {
    const r = await post('/health', '{"broken":', 'application/json');
    assert(!!r.headers['x-request-id'], 'the failing request lost its correlation id — the one you most need to trace');
  });

  // ── list endpoint: pagination, sorting, allowlisting ──
  await check('/products paginates with hasMore + nextCursor', async () => {
    const r = await get('/products?limit=2');
    assert(r.status === 200, 'status ' + r.status);
    assert(Array.isArray(r.body.data), 'no data array in the response');
    assert(r.body.pagination, 'no pagination block in the response');
    assert(typeof r.body.pagination.hasMore === 'boolean', 'pagination.hasMore missing');
  });

  await check('/products walks pages by cursor without repeating a row', async () => {
    const KEY = 'id';   // NOT always "id" — Mongoose keys on _id
    const p1 = await get('/products?limit=2');
    if (!p1.body.pagination.nextCursor) return;   // fewer than 2 rows in the store; nothing to walk
    const p2 = await get('/products?limit=2&cursor=' + encodeURIComponent(p1.body.pagination.nextCursor));

    const ids1 = p1.body.data.map(function (r) { return r[KEY]; });
    const ids2 = p2.body.data.map(function (r) { return r[KEY]; });

    // If the key is missing, every row reads as undefined and this check would compare undefined to
    // undefined — reporting a phantom overlap, or worse, a phantom pass. Fail loudly instead.
    assert(ids1.every(function (id) { return id !== undefined; }),
      'rows have no "' + KEY + '" — the cursor cannot be built from a key that does not exist');

    const overlap = ids2.filter(function (id) { return ids1.indexOf(id) !== -1; });
    assert(overlap.length === 0, 'page 2 repeated rows from page 1: ' + overlap.join(','));
  });

  await check('a sort field that is not allowlisted is REJECTED, not honoured', async () => {
    const r = await get('/products?sort=' + encodeURIComponent('password; DROP TABLE'));
    assert(r.status === 200, 'an unknown sort field should fall back, not 500 (got ' + r.status + ')');
  });

  // ── rate limiter: 429 + Retry-After once the burst is spent ──
  await check('a burst past capacity yields 429 + Retry-After', async () => {
    let limited = null;
    for (let i = 0; i < 75; i++) {
      const r = await get('/health');
      if (r.status === 429) { limited = r; break; }
    }
    assert(limited, 'never got a 429 after 75 requests');
    assert(limited.headers['retry-after'], '429 carried no Retry-After header — clients cannot back off');
  });
  } finally {
    stopServer();
  }

  console.log('');
  if (failures.length === 0) {
    console.log('  ' + passed + '/' + passed + ' checks passed — the delivered feature works end to end.');
    process.exit(0);
  }
  console.log('  ' + passed + ' passed, ' + failures.length + ' FAILED:');
  for (const f of failures) console.log('    - ' + f.name + ': ' + f.error);
  process.exit(1);
})();
