#!/usr/bin/env node
'use strict';
/**
 * Gate 5+6 of the admission bar: does this recall actually WORK IN A COMPOSITION?
 *
 * Everything else in admit-recall.ts tests a recall in isolation. A recall can pass all of that and
 * still take the composed app down on boot — which is exactly what happened when a `setupFile` ->
 * `setup[]` migration silently produced an EMPTY setup block, leaving `logger` undefined in the
 * middleware that referenced it. Isolated tests were green. The app died at require time.
 *
 * So: compose the recall alongside two others, boot the app for real, and run the generated verify.js
 * against it. If that passes, the recall composes. Nothing short of running it proves that.
 *
 *   node scripts/compose-and-verify.js <recall-id>
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'src', 'mcp-server.js');

const recallId = process.argv[2];
if (!recallId) {
  console.error('usage: compose-and-verify.js <recall-id>');
  process.exit(1);
}

// Capability phrases that RELIABLY select each recall. The composition gate needs N>=2, so we pair the
// recall under test with companions it does not collide with. These are the anchors of the library.
const COMPANION_CAPS = [
  'pino structured logging with a per-request correlation id and credential redaction',
  'token-bucket rate limiter returning 429 with Retry-After',
];

/** Capability text that selects the recall under test — derived from its own metadata, not guessed. */
function capsFor(id) {
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'verified-recalls.json'), 'utf-8'));
  const rel = (allow.paths || {})[id];
  if (!rel) throw new Error(`recall ${id} is not in the verified allowlist`);

  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, rel, 'metadata.json'), 'utf-8'));

  // The description is what the recall says it is. If that does not select it, the recall's own
  // metadata is not discoverable — which is itself a defect worth failing on.
  const own = String(meta.description || meta.name || id).slice(0, 160);

  const caps = [own, ...COMPANION_CAPS];
  // Don't ask for a companion the recall under test already IS.
  return caps.filter((c, i) => !(i === 1 && id === 'observability.logging.v1')
                            && !(i === 2 && id === 'cache.ratelimit.v1'));
}

function strataUse(dir, caps) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [DIST], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('strata_use timed out')); }, 60_000);

    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        clearTimeout(timer);
        p.kill();
        resolve(msg.result?.content?.[0]?.text ?? '');
        return;
      }
    });
    p.on('error', reject);

    p.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'admit', version: '1' } },
    }) + '\n');

    // The server needs a moment to finish loading the recall index before it can answer a tool call.
    setTimeout(() => {
      p.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'strata_use', arguments: { task: 'admission check', capabilities: caps, dir } },
      }) + '\n');
    }, 2000);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-admit-'));

  let text;
  try {
    text = await strataUse(dir, capsFor(recallId));
  } catch (e) {
    console.error(`composition failed: ${e.message}`);
    process.exit(1);
  }

  if (text.startsWith('Strata is declining')) {
    console.error('DECLINED — the recall did not compose with 2+ others. Either its metadata is not '
      + 'discoverable from its own description, or it collides with the companions.');
    process.exit(1);
  }

  const testsDir = path.join(dir, 'strata', 'tests');
  const composed = fs.existsSync(testsDir) ? fs.readdirSync(testsDir).map(f => f.replace(/\.js$/, '')) : [];
  if (!composed.includes(recallId)) {
    console.error(`the recall was NOT in the composition (got: ${composed.join(', ') || 'nothing'}) — `
      + 'its own description does not select it');
    process.exit(1);
  }
  if (composed.length < 2) {
    console.error(`composed with only ${composed.length} recall(s) — cannot prove composition`);
    process.exit(1);
  }

  // Dependencies. Reuse a warm scratch install rather than resolving from the project (CLAUDE.md
  // forbids npm install here, and a cold install per recall would make the gate unusably slow).
  const deps = process.env.STRATA_TEST_NODE_PATH;
  if (deps && fs.existsSync(deps)) {
    try { fs.cpSync(deps, path.join(dir, 'node_modules'), { recursive: true }); } catch { /* best effort */ }
  }

  const verify = path.join(dir, 'strata', 'verify.js');
  if (!fs.existsSync(verify)) {
    console.error('no verify.js was generated — nothing can prove this composition works');
    process.exit(1);
  }

  const res = spawnSync(process.execPath, [verify], { cwd: dir, encoding: 'utf-8', timeout: 120_000 });
  const out = ((res.stdout ?? '') + (res.stderr ?? '')).trim();

  if (res.status !== 0) {
    const fails = out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 3);
    console.error(`composed app FAILED verification (with ${composed.join(' + ')})`);
    for (const f of fails) console.error(`  ${f.trim()}`);
    process.exit(1);
  }

  const summary = out.split('\n').filter(Boolean).pop() ?? '';
  console.log(`composed with ${composed.length} (${composed.join(' + ')}) — ${summary.trim()}`);
  process.exit(0);
})();
