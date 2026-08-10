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
  // A plain OBJECT body is serialised as JSON automatically.
  //
  // Passing one straight to fetch() stringifies it as "[object Object]" and sends no content-type, so
  // express.json() never parses it, req.body is empty, and the route answers 400 — while any check
  // that merely asserts "this request was rejected" still PASSES. Three auth checks passed that way
  // before one of them happened to assert a success path and exposed it. A helper whose misuse looks
  // like a passing test is a bug in the helper.
  let payload = body;
  let ct = contentType;
  if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Buffer)) {
    payload = JSON.stringify(body);
    if (!ct) ct = 'application/json';
  }

  const res = await fetch(BASE + route, {
    method,
    headers: Object.assign({}, ct ? { 'content-type': ct } : {}, headers || {}),
    body: payload === undefined ? undefined : payload,
    // Do NOT follow redirects. fetch() follows by default, which means a check asserting "this route
    // 302s to the identity provider" instead sees whatever Google returned — and, worse, the verifier
    // makes a live outbound request to a third party from inside a test. The verifier's job is to
    // observe what THE APP returned, not what a browser would do next.
    redirect: 'manual',
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
  const parts = "node server.js".split(' ');

  // NODE_ENV=production so the logger emits JSON (pretty mode is unparseable, and it is what made an
  // earlier session's log grep silently miss the very line it was looking for).
  // No shell:true — it triggers a Node deprecation warning about unescaped args, and a stray warning
  // in the output is a turn someone spends investigating a non-problem. `node` is on PATH anyway.
  // Seed any env var the delivered recalls DECLARED, unless the project already sets it.
  //
  // We boot with NODE_ENV=production (above), and a correctly-written recall refuses to start in
  // production without its secret — so every recall that needs configuration could never pass this
  // gate. web.sessions.v1 failed exactly here: the recall was right, the harness simply ignored the
  // envSlots it had already declared. Seeding is not weakening the check; the point of declaring a
  // slot is to say "this must exist", and the verifier is the one component that knows it is a test.
  const seeded = Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'production' });
  for (const slot of ["UPSTREAM_URL","UPSTREAM_TIMEOUT_MS","UPSTREAM_RETRIES","UPSTREAM_KEY"]) {
    if (!seeded[slot]) seeded[slot] = 'strata-verify-' + slot.toLowerCase().replace(/_/g, '-');
  }

  server = spawn(process.execPath, parts.slice(1), {
    cwd: path.join(__dirname, '..'),
    env: seeded,
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
