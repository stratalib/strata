#!/usr/bin/env node
'use strict';
/**
 * GEMINI AGENT-SESSION BENCHMARK — the Claude harness, re-pointed at Gemini on Vertex.
 *
 * Why: a cost claim that only holds on one vendor's model is weak. agent-bench.js drives the `claude`
 * CLI; this drives Gemini through an agentic loop we run ourselves, in the SAME sterile temp dir, with
 * the SAME task prompts (imported from agent-bench, never re-typed — a drifted prompt is an invisible
 * confound), and writes the SAME artifact JSON so report.js reads both without knowing which model ran.
 *
 * What is genuinely different, and cannot be pretended away:
 *   - Absolute $/token differs by vendor, so absolute cost is NOT comparable to Claude. The transferable
 *     result is the RATIO within Gemini: does strata beat baseline the way it does on Claude? We run
 *     BOTH arms here for exactly that reason.
 *   - Claude Code has an internal system prompt we cannot see. We give Gemini a neutral coding-agent
 *     system instruction and the identical task + AUTONOMY suffix. Same task, best-effort same framing.
 *   - "turns" here = model round-trips in our loop, not Claude's num_turns. Close, not identical. Cost
 *     and adoption behaviour are the honest comparands; turn count is context, not headline.
 *
 * The strata arm calls the REAL Strata MCP server (dist/src/mcp-server.js) over stdio JSON-RPC — the
 * same protocol and the same engine Claude Code uses. Gemini decides to call it, we proxy it, it gets
 * back the identical delivery payload. Nothing about the delivery is Gemini-specific.
 *
 * Usage:
 *   node benchmark/gemini-bench.js stripejune baseline
 *   node benchmark/gemini-bench.js stripejune strata --run 2
 *   node benchmark/gemini-bench.js stripejune strata --model gemini-2.5-pro --out exp-gemini
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'dist', 'src', 'mcp-server.js');

// Standardized: the tasks are the Claude harness's tasks. Import, do not fork.
const { TASKS } = require('./agent-bench.js');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };

const OUT = path.join(__dirname, 'runs', arg('--out', 'exp-gemini'));

const PROJECT = process.env.GCP_PROJECT || 'project-ab6b93ae-62d5-47d9-940';
const MODEL = arg('--model', process.env.VERTEX_MODEL || 'gemini-2.5-pro');
const LOCATION = 'global';
const MAX_TURNS = Number(arg('--max-turns', 120));

// Gemini 2.5 Pro on Vertex, USD per 1M tokens, prompts <=200k. Cached = implicit-cache discount (~75%).
// Kept as named constants because they WILL change and a wrong number here silently poisons the compare.
const PRICE = { input: 1.25, cachedInput: 0.31, output: 10.00 };

// ── Vertex auth: a fresh access token per run (they expire ~1h). Lifted from scripts/vertex-author.js;
//    the Windows .cmd-shim + shell:true dance is load-bearing (CVE-2024-27980 blocks direct .cmd spawn).
function accessToken() {
  const bin = path.join(process.env.HOME || process.env.USERPROFILE, 'google-cloud-sdk', 'bin');
  const gcloud = process.env.GCLOUD_BIN
    || (process.platform === 'win32' ? path.join(bin, 'gcloud.cmd') : path.join(bin, 'gcloud'));
  const env = { ...process.env };
  if (!env.CLOUDSDK_PYTHON) {
    const bundled = path.join(bin, '..', 'platform', 'bundledpython', 'python.exe');
    if (fs.existsSync(bundled)) env.CLOUDSDK_PYTHON = bundled;
  }
  const r = process.platform === 'win32'
    ? spawnSync(`"${gcloud}" auth print-access-token`, { encoding: 'utf-8', env, shell: true })
    : spawnSync(gcloud, ['auth', 'print-access-token'], { encoding: 'utf-8', env });
  const token = (r.stdout || '').trim();
  if (!token) throw new Error('gcloud gave no token: ' + ((r.stderr || r.error?.message || '').slice(0, 200)));
  return token;
}

// ── One Gemini generateContent call. Returns the model's parts, token usage, and finish reason.
async function geminiGenerate(contents, tools, systemInstruction, token) {
  const url = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}`
    + `/publishers/google/models/${MODEL}:generateContent`;
  const body = {
    contents,
    tools,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    // 429/503 bubble up so the caller can back off, same shape the Claude harness watches for.
    const e = new Error(`vertex ${res.status}: ${txt.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const cand = j.candidates?.[0] || {};
  return {
    parts: cand.content?.parts || [],
    finishReason: cand.finishReason,
    usage: j.usageMetadata || {},
  };
}

// ── Minimal MCP stdio client. Spawns the Strata server, does the initialize handshake, calls one tool,
//    returns its text, and shuts the server down. MCP stdio framing is newline-delimited JSON-RPC — no
//    Content-Length headers — so a line reader is enough. This is the exact path Claude Code drives.
function callStrataUse(dir, toolArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      cwd: dir,
      env: { ...process.env, STRATA_DELIVER_AS_DEP: process.env.STRATA_DELIVER_AS_DEP || '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const pending = new Map();
    let done = false;
    const finish = (fn, val) => { if (done) return; done = true; try { child.kill(); } catch {} fn(val); };
    const timer = setTimeout(() => finish(reject, new Error('strata_use MCP timeout')), 120000);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
    child.stderr.on('data', () => { /* server logs [strata_use ...] here; not protocol */ });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    const request = (id, method, params) => new Promise((res) => { pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });

    (async () => {
      try {
        await request(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'gemini-bench', version: '1.0' },
        });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const resp = await request(2, 'tools/call', { name: 'strata_use', arguments: toolArgs });
        clearTimeout(timer);
        const content = resp.result?.content || [];
        const text = content.map((c) => c.text || '').join('\n');
        finish(resolve, text || JSON.stringify(resp.result || resp.error || {}));
      } catch (e) { clearTimeout(timer); finish(reject, e); }
    })();
  });
}

// ── The tools Gemini can call. Function-calling declarations (Gemini's schema dialect).
function toolDeclarations(arm) {
  const fns = [
    { name: 'run_bash', description: 'Run a shell command in the project directory. Returns stdout, stderr, exit code.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'The shell command to run' } }, required: ['command'] } },
    { name: 'read_file', description: 'Read a file from the project directory.',
      parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path relative to the project root' } }, required: ['file_path'] } },
    { name: 'write_file', description: 'Write (create or overwrite) a file in the project directory.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
    { name: 'finish', description: 'Call when the task is complete. Provide a short summary of what you built and any decisions you made.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
  ];
  if (arm === 'strata') {
    fns.push({
      name: 'strata_use',
      description: 'Deliver pre-built, verified code recalls for your task from this project\'s local Strata '
        + 'library. Copies matching implementation files into ./strata/ and returns require() paths and export '
        + 'signatures. Call ONCE at the start. For money/auth/crypto, read the delivered file back before trusting it.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What you are building' },
          capabilities: { type: 'array', items: { type: 'string' }, description: '3-6 short phrases naming the core technical components' },
        },
        required: ['task'],
      },
    });
  }
  return [{ functionDeclarations: fns }];
}

// Resolve a model-supplied path inside the sandbox dir. An escape (../etc) is refused, not honoured.
function safePath(dir, p) {
  const resolved = path.resolve(dir, p);
  if (!resolved.startsWith(path.resolve(dir))) throw new Error('path escapes project dir: ' + p);
  return resolved;
}

// Execute one function call. `stats` accumulates the adoption metrics we own precisely here.
async function execTool(name, args, dir, stats) {
  try {
    if (name === 'run_bash') {
      const r = spawnSync(args.command, { cwd: dir, shell: true, encoding: 'utf-8', timeout: 3 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
      if (/selftest\.js/.test(args.command)) stats.selftestRuns++;
      if (/verify\.js/.test(args.command)) stats.verifyRuns++;
      if (r.error && r.error.code === 'ETIMEDOUT') {
        return { output: ((r.stdout || '') + (r.stderr || '')).slice(0, 4000)
          + '\n[timed out after 3m — this command did not exit. If you started a server in the foreground, '
          + 'run it in the background instead (append " &"), then curl and kill it, OR verify with a script that exits.]',
          exit_code: -1, timed_out: true };
      }
      const out = ((r.stdout || '') + (r.stderr || '')).slice(0, 8000);
      return { output: out || '(no output)', exit_code: r.status ?? -1 };
    }
    if (name === 'read_file') {
      const fp = safePath(dir, args.file_path);
      stats.reads.push(args.file_path);
      if (/strata.(lib|composed|verify|selftest)|composed-pkg|strata.tests/i.test(args.file_path)) stats.readOfDelivered++;
      return { content: fs.readFileSync(fp, 'utf-8').slice(0, 20000) };
    }
    if (name === 'write_file') {
      const fp = safePath(dir, args.file_path);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, args.content);
      stats.writes.push(args.file_path);
      return { ok: true, bytes: args.content.length };
    }
    if (name === 'strata_use') {
      stats.strataCalls++;
      const text = await callStrataUse(dir, { task: args.task, dir, capabilities: args.capabilities });
      for (const m of text.matchAll(/^\s{2}([a-z][a-z0-9]*\.[a-z0-9-]+\.v\d+)/gm)) stats.deliveredRecalls.push(m[1]);
      return { result: text };
    }
    return { error: 'unknown tool ' + name };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ── Sterile working dir (copied from agent-bench: identical tree per run or the arms are incomparable).
function prepareDir(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbench-'));
  if (task.fixture) {
    const src = path.join(ROOT, 'benchmark', 'fixtures', task.fixture);
    if (!fs.existsSync(src)) throw new Error('fixture not found: ' + src);
    fs.cpSync(src, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  } else {
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'bench-greenfield', version: '1.0.0', private: true }, null, 2));
  }
  return dir;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
    }
  };
  walk(dir);
  return n;
}

function measureWork(dir, task) {
  const baseline = task.fixture ? 7 : 1;
  let entryBytes = 0;
  for (const rel of ['src/server.js', 'server.js', 'index.js']) {
    try { entryBytes = Math.max(entryBytes, fs.statSync(path.join(dir, rel)).size); } catch { /* absent */ }
  }
  const added = countFiles(dir) - baseline;
  return { filesAdded: added, entryBytes, attempted: added >= 2 };
}

const AUTONOMY = ' Work autonomously and make sensible choices without checking in - I am not '
  + 'available to answer questions. If something is ambiguous, pick the option you would defend and '
  + 'note it at the end.';

// ── One Gemini agent session.
async function runOnce(taskName, task, arm, runIndex) {
  const dir = prepareDir(task);
  const tools = toolDeclarations(arm);
  // Rigor demand is SYMMETRIC across arms (only the strata_use note differs) — otherwise a light
  // baseline that writes files and quits flatters itself against a strata arm that actually verifies.
  const sys = `You are an autonomous software engineer working in a real Node.js project directory. Build `
    + `exactly what the user asks, then PROVE it works before finishing:\n`
    + `1. Install dependencies with run_bash (npm install).\n`
    + `2. VERIFY by running code that EXITS on its own — a test script, or a short script that boots the `
    + `app, exercises each requirement (e.g. calls each handler / triggers the job), prints results, and `
    + `returns. Do NOT leave a server running in the foreground: a blocking command will time out. If you `
    + `must start a server, background it (append ' &'), curl it, then kill it.\n`
    + `3. If anything errors, read the output, fix it, and re-run until every requirement is verified.\n`
    + `4. Only call finish AFTER you have run the system and confirmed each requirement behaves correctly. `
    + `In the summary, state exactly what you ran and what you observed.\n`
    + `Use run_bash to install/run/verify, read_file/write_file to edit.`
    + (arm === 'strata' ? ` A tool called strata_use can deliver pre-built verified code for parts of this task; use your judgment on whether to call it.` : '');

  const contents = [{ role: 'user', parts: [{ text: task.prompt + AUTONOMY }] }];
  const stats = { strataCalls: 0, deliveredRecalls: [], reads: [], writes: [], readOfDelivered: 0, selftestRuns: 0, verifyRuns: 0 };
  const transcript = [];
  let inTok = 0, outTok = 0, cachedTok = 0, cost = 0, finalSummary = '', synthetic = false;

  const token = accessToken();
  const t0 = Date.now();
  let turns = 0;
  let noCallNudges = 0;   // consecutive text-only responses; capped so the loop always terminates

  for (; turns < MAX_TURNS; turns++) {
    let resp;
    try {
      resp = await geminiGenerate(contents, tools, sys, token);
    } catch (e) {
      // Back off once on throttle/5xx, then record the failure rather than a lie.
      if ((e.status === 429 || e.status === 503) && turns < MAX_TURNS - 1) {
        transcript.push({ turn: turns, note: 'backoff ' + e.status });
        await new Promise((r) => setTimeout(r, 30000));
        turns--; continue;
      }
      synthetic = true;
      transcript.push({ turn: turns, error: String(e.message || e) });
      break;
    }

    const u = resp.usage;
    const p = u.promptTokenCount || 0, c = u.cachedContentTokenCount || 0;
    const o = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);   // Gemini bills thinking as output
    inTok += p; outTok += o; cachedTok += c;
    cost += ((p - c) / 1e6) * PRICE.input + (c / 1e6) * PRICE.cachedInput + (o / 1e6) * PRICE.output;

    const calls = resp.parts.filter((x) => x.functionCall).map((x) => x.functionCall);
    const texts = resp.parts.filter((x) => x.text).map((x) => x.text).join('');
    contents.push({ role: 'model', parts: resp.parts });
    const entry = { turn: turns, text: texts, calls: [] };
    transcript.push(entry);

    // A text-only response is NOT completion — the model narrating its plan (common right after
    // strata_use) must not be misread as "done", or a non-attempt scores as a cheap run. The only clean
    // exit is an explicit finish() call (or MAX_TURNS). Nudge it back to work; cap the nudges so a model
    // that simply refuses to act still terminates instead of looping to MAX_TURNS.
    if (!calls.length) {
      finalSummary = texts || finalSummary;
      if (noCallNudges >= 3) break;
      noCallNudges++;
      contents.push({ role: 'user', parts: [{ text: 'You have not called finish. If every requirement is '
        + 'implemented AND you have run code to verify it works, call the finish function now. Otherwise keep '
        + 'working: install deps, write the remaining files, and run a verification that exits.' }] });
      continue;
    }
    noCallNudges = 0;   // it acted; reset the patience counter

    const responseParts = [];
    let finished = false;
    for (const call of calls) {
      if (call.name === 'finish') { finalSummary = (call.args && call.args.summary) || texts; finished = true;
        entry.calls.push({ name: 'finish', args: call.args });
        responseParts.push({ functionResponse: { name: 'finish', response: { ok: true } } }); continue; }
      const result = await execTool(call.name, call.args || {}, dir, stats);
      // Record the result too (truncated) — a transcript without tool output can't be audited later.
      entry.calls.push({ name: call.name, args: call.args, result: JSON.stringify(result).slice(0, 1500) });
      responseParts.push({ functionResponse: { name: call.name, response: result } });
    }
    // Gemini expects the function results back in a role:"user" content block.
    contents.push({ role: 'user', parts: responseParts });
    if (finished) break;
  }

  const wallMs = Date.now() - t0;
  stats.deliveredRecalls = [...new Set(stats.deliveredRecalls)];
  const verifyResult = stats.selftestRuns ? `selftest ran ${stats.selftestRuns}x`
    : (fs.existsSync(path.join(dir, 'strata', 'verify.js')) ? 'verify.js present, not run' : 'no verify.js');

  const run = {
    task: taskName, mode: task.mode, arm, run: runIndex, model: MODEL, vendor: 'gemini',
    ok: !synthetic && (turns < MAX_TURNS),
    turns,
    inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cachedTok,
    costUsd: Number(cost.toFixed(4)),
    wallMs, dir,
    strataCalls: stats.strataCalls,
    armValid: arm === 'baseline' ? stats.strataCalls === 0 : stats.strataCalls > 0,
    synthetic,
    deliveredRecalls: stats.deliveredRecalls,
    verifyResult,
    finalSummary: String(finalSummary || '').slice(0, 2000),
    verifyPresent: fs.existsSync(path.join(dir, 'strata', 'verify.js')),
    work: measureWork(dir, task),
    fileCount: countFiles(dir),
    // Owned precisely because we ran the loop — no reverse-engineering from a transcript.
    adoption: { readOfDelivered: stats.readOfDelivered, filesWritten: stats.writes.length,
      selftestRuns: stats.selftestRuns, reads: stats.reads, writes: stats.writes },
  };

  fs.mkdirSync(OUT, { recursive: true });
  const stem = `${taskName}-${arm}-${runIndex}`;
  fs.writeFileSync(path.join(OUT, stem + '.json'), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(OUT, stem + '.log'), JSON.stringify(transcript, null, 2));
  return run;
}

module.exports = { runOnce, TASKS, OUT, accessToken, callStrataUse, geminiGenerate, toolDeclarations };

if (require.main === module) {
  const task = process.argv[2], arm = process.argv[3];
  const runFlag = process.argv.indexOf('--run');
  const runIdx = runFlag > -1 ? parseInt(process.argv[runFlag + 1], 10) : 1;
  if (!TASKS[task] || !['baseline', 'strata'].includes(arm)) {
    console.error('usage: gemini-bench.js <task> <baseline|strata> [--run N] [--model gemini-2.5-pro] [--out folder]');
    process.exit(1);
  }
  runOnce(task, TASKS[task], arm, runIdx).then((r) => {
    console.log(`${task} ${arm} [gemini]: ${r.turns} turns · $${r.costUsd.toFixed(2)} · synthetic=${r.synthetic}`
      + ` · files+${r.work.filesAdded} · delivered=[${r.deliveredRecalls.join(',')}]`
      + ` · adoption(readDelivered=${r.adoption.readOfDelivered}, wrote=${r.adoption.filesWritten}, selftest=${r.adoption.selftestRuns})`);
  }).catch((e) => { console.error('CRASH:', e.stack || e.message); process.exit(1); });
}
