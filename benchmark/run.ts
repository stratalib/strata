/**
 * Strata Benchmark Runner
 *
 * Runs only the "with Strata" side for each task.
 * Baselines are stored averages from previous runs — no money wasted re-running them.
 *
 * Usage: ts-node benchmark/run.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RecallSignal, recordSignal, saveSignals, loadSignals, computeRecallFitness } from '../src/fitness-tracker';

// Load .env from project root
;(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1 || line.startsWith('#')) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
})();

const MODEL = 'claude-haiku-4-5-20251001';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
const aiAnthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

// ─── Types (mirrored from mcp-server.ts) ─────────────────────────────────────

interface RecallEntry {
  id: string; name: string; description: string; domain: string;
  tags: string[]; complexity?: number; dependencies?: string[];
  useCases?: string[]; inputs?: string[]; outputs?: string[];
  callExample?: string; fullContextRequired: boolean;
  physicalPath: string; layer: number;
}
interface ScoredRecall extends RecallEntry { score: number; }
interface DeliveredRecall {
  id: string; name: string; description: string; filename: string;
  inputs?: string[]; outputs?: string[]; callExample?: string;
  useCases?: string[]; isComposite?: boolean; compositeIds?: string[];
}

// ─── Stored baseline token counts (RESULTS.md 2026-06-23, 12 tasks) ─────────

const TASKS = [
  {
    id: 1, name: 'User Authentication System', baselineTokens: 3694,
    prompt: `Build a complete Node.js user authentication system with: signup (email + bcrypt password hash), login (returns JWT access token + refresh token), logout (invalidate refresh token), and password reset (send reset email with time-limited token). Use Express. Include the route handlers, middleware, and token management logic.`,
  },
  {
    id: 2, name: 'Email Sending Service', baselineTokens: 3364,
    prompt: `Build a Node.js email service module that sends: welcome emails on signup, password reset emails with a secure token link, and generic notification emails. Use nodemailer with SMTP config. Support HTML and plain-text bodies, retry on failure (3 attempts), and a queue so sending does not block the request. Return the full implementation.`,
  },
  {
    id: 3, name: 'File Upload Service', baselineTokens: 2005,
    prompt: `Build a Node.js Express file upload service using multer. Support: single and multiple file uploads, file type validation (images: jpg/png/gif, documents: pdf/docx), size limits (10MB per file), storing files to a local ./uploads directory with hashed filenames, and returning a public URL. Include the multer config, route handlers, and error handling for invalid types or oversized files.`,
  },
  {
    id: 4, name: 'Push Notification Service', baselineTokens: 3459,
    prompt: `Build a Node.js notification service that supports: sending push notifications via Firebase Cloud Messaging (FCM), storing user device tokens in a map/store, sending to a single user by userId, broadcasting to all users, and handling FCM errors (invalid token, quota exceeded). Include the FCM client setup, token storage, and the send/broadcast methods.`,
  },
  {
    id: 5, name: 'Full-Text Product Search', baselineTokens: 3316,
    prompt: `Build a Node.js product search module. Support: keyword search across name, description, and category fields, filtering by price range and category, sorting by relevance or price, and pagination (page + limit). Use an in-memory product array for storage. Return the search function, filter logic, and an Express GET /products/search endpoint with query parameter parsing.`,
  },
  {
    id: 6, name: 'Threaded Comment System', baselineTokens: 2371,
    prompt: `Build a Node.js Express REST API for a threaded comment system. Support: POST /comments (create top-level comment), POST /comments/:id/reply (reply to a comment), GET /comments?postId=X (list comments with replies nested), PUT /comments/:id (edit own comment), DELETE /comments/:id (soft delete). Comments have: id, postId, parentId, authorId, body, createdAt, deletedAt. Return all route handlers and data logic.`,
  },
  {
    id: 7, name: 'Cursor-Paginated REST API', baselineTokens: 1731,
    prompt: `Build a Node.js Express endpoint for cursor-based pagination of a large dataset. GET /items?cursor=<encoded>&limit=20 should: decode the cursor (base64 encoded timestamp+id), query from that position, return items + nextCursor + hasMore. Implement the cursor encode/decode helpers and the route handler. Handle edge cases: first page (no cursor), last page (no nextCursor), invalid cursor.`,
  },
  {
    id: 8, name: 'Shopping Cart with Sessions', baselineTokens: 1895,
    prompt: `Build a Node.js Express shopping cart system using express-session. Support: GET /cart (view cart), POST /cart/items (add item with productId, quantity, price), PUT /cart/items/:productId (update quantity), DELETE /cart/items/:productId (remove item), POST /cart/clear (empty cart), GET /cart/total (sum of price*quantity). Store cart in session. Return full route handlers and session middleware config.`,
  },
  {
    id: 9, name: 'Role-Based Access Control', baselineTokens: 4119,
    prompt: `Build a Node.js RBAC (role-based access control) system for Express. Define roles: admin, editor, viewer. Each role has a set of permissions (e.g., admin: [read, write, delete], editor: [read, write], viewer: [read]). Implement: a requirePermission(permission) middleware that checks the req.user.role, a checkRole(role) middleware, and an assignRole(userId, role) function. Return the full middleware and permission definitions.`,
  },
  {
    id: 10, name: 'Real-Time Chat with WebSockets', baselineTokens: 2305,
    prompt: `Build a Node.js real-time chat server using the ws package (WebSocket). Support: user join (send {type:"join", username}), broadcast message to all connected users ({type:"message", from, text}), private message to a specific user ({type:"dm", to, text}), user leave notification. Track connected users by username. Return the WebSocket server setup, message routing logic, and connection/disconnection handlers.`,
  },
  {
    id: 11, name: 'JWT Auth Middleware', baselineTokens: 842,
    prompt: `Build a JWT authentication middleware for Express. Extract Bearer tokens from the Authorization header, verify them against a secret, and attach the decoded payload to req.user. Return 401 for missing, expired, or invalid tokens with a clear error code. Also expose a standalone verifyJWT(token, secret) helper and an authenticateRequest(req, secret) function for non-middleware contexts.`,
  },
  {
    id: 12, name: 'Password Reset Flow', baselineTokens: 3602,
    prompt: `Build a Node.js password reset flow. Generate a secure random token, hash it for storage, persist it with an expiry timestamp and user email. Send a reset email containing a link with the raw token. On confirmation: look up the token hash, validate expiry, ensure it has not been used, update the password, mark the token as used, and clean up expired tokens for that user. Enforce a rate limit of 5 reset attempts per hour per email.`,
  },
];

// ─── Recall library loader ────────────────────────────────────────────────────

const recallsDir = path.join(__dirname, '..', 'recalls');
const recallMap  = new Map<string, RecallEntry>();
const allRecalls: RecallEntry[] = [];

function inferLayer(physicalPath: string): number {
  const implPath = path.join(physicalPath, 'implementation.js');
  if (!fs.existsSync(implPath)) return 1;
  const lines = fs.readFileSync(implPath, 'utf-8').split('\n').length;
  if (lines <= 20)  return 1;
  if (lines <= 60)  return 2;
  if (lines <= 120) return 3;
  if (lines <= 250) return 4;
  return 5;
}

function walkRecalls(dir: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    const metaPath = path.join(fullPath, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const implPath = path.join(fullPath, 'implementation.js');
        if (fs.existsSync(implPath) && fs.readFileSync(implPath, 'utf-8').includes('TODO: Implement')) continue;
        const id = meta.id || entry.name;
        if (!recallMap.has(id)) {
          const record: RecallEntry = {
            id, name: meta.name || id, description: meta.description || '',
            domain: meta.domain || meta.category || 'general',
            tags: meta.tags || [], complexity: meta.complexity,
            dependencies: meta.dependencies, useCases: meta.useCases,
            inputs: meta.inputs, outputs: meta.outputs,
            callExample: meta.callExample,
            fullContextRequired: meta.fullContextRequired ?? false,
            physicalPath: fullPath,
            layer: meta.layer ?? inferLayer(fullPath),
          };
          recallMap.set(id, record);
          allRecalls.push(record);
        }
      } catch { /* skip corrupt */ }
    } else {
      walkRecalls(fullPath);
    }
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const SCORE_STOPWORDS = new Set([
  'mapping','service','system','module','manager','handler',
  'provider','helper','checker','builder','processor','generator',
  'validator','hook','wrapper','adapter','plugin','layer',
]);
const LAYER_THRESHOLDS: Record<number, number> = { 5:45, 4:35, 3:25, 2:15, 1:8 };
const PER_LAYER_CAP = 2;

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s,.\-_/]+/).filter(t => t.length > 1 && !SCORE_STOPWORDS.has(t));
}

function scoreRecall(r: RecallEntry, tokens: string[], primaryTokens: Set<string>): number {
  const id = r.id.toLowerCase(), name = r.name.toLowerCase();
  const desc = r.description.toLowerCase(), tags = r.tags.map(t => t.toLowerCase()).join(' ');
  return tokens.reduce((s, t) => {
    const boost = primaryTokens.size > 0 && primaryTokens.has(t) ? 2 : 1;
    return s + boost * ((id.includes(t)?12:0)+(name.includes(t)?8:0)+(desc.includes(t)?5:0)+(tags.includes(t)?4:0));
  }, 0);
}

function searchRecalls(query: string, limit=5, primaryQuery?: string, minLayer=1, maxLayer=5): ScoredRecall[] {
  const tokens = tokenize(query);
  const primaryTokens = primaryQuery ? new Set(tokenize(primaryQuery)) : new Set<string>();
  const pool: ScoredRecall[] = [];
  const seenIds = new Set<string>();
  for (let layer = maxLayer; layer >= minLayer && pool.length < limit; layer--) {
    const threshold = LAYER_THRESHOLDS[layer] ?? 25;
    const layerResults = allRecalls
      .filter(r => r.layer === layer)
      .map(r => ({ ...r, score: scoreRecall(r, tokens, primaryTokens) }))
      .filter(x => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, PER_LAYER_CAP);
    for (const r of layerResults) {
      if (!seenIds.has(r.id) && pool.length < limit) { seenIds.add(r.id); pool.push(r); }
    }
  }
  return pool;
}

// ─── Capability mapper (with specificity guards) ──────────────────────────────

function mapCapabilitiesToRecalls(capabilities: string[], taskPrompt: string): RecallEntry[] {
  const seenIds    = new Set<string>();
  const candidates: RecallEntry[] = [];
  const capsText   = capabilities.join(' ').toLowerCase();
  const taskLower  = taskPrompt.toLowerCase().slice(0, 300);

  const jwtAllowed         = /\bjwt\b|token.sign|bearer|jsonwebtoken/.test(capsText) || /\bjwt\b|jsonwebtoken|bearer token/.test(taskLower);
  const searchInMemAllowed = /\bsearch\b|keyword|filter.sort/.test(capsText) || /\bsearch\b|keyword search/.test(taskLower);
  const cartAllowed        = /\bcart\b|\bshopping/.test(capsText) || /\bcart\b|\bshopping cart/.test(taskLower);
  const apiFormatAllowed   = /response.format|format.response|api.response|error.format/.test(capsText);
  const queueAllowed       = /\bqueue\b.*(?:worker|job|pool)|job.queue/.test(capsText) || /\bqueue\b.*(?:worker|job|pool)|job.queue/.test(taskLower);
  const emailVerifAllowed  = /\bverif|\bactivat/.test(capsText) || /\bverif|\bactivat/.test(taskLower);
  const multitenantAllowed = /\btenant|\bmultitenant/.test(capsText) || /\btenant|\bmulti.tenant/.test(taskLower);
  const authSessionAllowed = /express.session|session.store|cookie.session/.test(capsText) || /express-session|cookie-session/.test(taskLower);

  const GUARDS: Record<string, boolean> = {
    'auth.jwt.tokenhandling.v1':      jwtAllowed,
    'search.in-memory.v1':            searchInMemAllowed,
    'cart.session.express.v1':        cartAllowed,
    'api.format.response.v1':         apiFormatAllowed,
    'queue-worker-pool':              queueAllowed,
    'auth-email-verification-flow':   emailVerifAllowed,
    'auth-multitenant-context':       multitenantAllowed,
    'auth.session.sessionmanagement.v1': authSessionAllowed,
  };

  for (const cap of capabilities) {
    if (candidates.length >= 3) break;
    const results = searchRecalls(cap, 1, cap);
    for (const recall of results) {
      if (seenIds.has(recall.id)) continue;
      if (recall.id in GUARDS && !GUARDS[recall.id]) continue;
      seenIds.add(recall.id);
      candidates.push(recall);
      break;
    }
  }

  // Fat consolidation
  const combined = capabilities.join(' ');
  const fatResults = searchRecalls(combined, 3, taskPrompt, 4, 5);
  for (const fat of fatResults) {
    if (fat.score < 60) continue;
    const kept = candidates.filter(c => !(c.layer < 4 && c.domain === fat.domain));
    const dropped = candidates.filter(c => c.layer < 4 && c.domain === fat.domain);
    if (dropped.length > 0) {
      candidates.length = 0;
      candidates.push(...kept);
      if (!seenIds.has(fat.id)) { candidates.unshift(fat); seenIds.add(fat.id); }
      break;
    }
  }

  return candidates;
}

// ─── Dependency resolver ──────────────────────────────────────────────────────

function resolveDependencies(recalls: RecallEntry[]): RecallEntry[] {
  const resolved = new Map<string, RecallEntry>();
  const queue = [...recalls];
  while (queue.length > 0) {
    const r = queue.shift()!;
    if (resolved.has(r.id)) continue;
    resolved.set(r.id, r);
    for (const depId of (r.dependencies ?? [])) {
      if (!resolved.has(depId) && recallMap.has(depId)) queue.push(recallMap.get(depId)!);
    }
  }
  return [...resolved.values()];
}

// ─── Assembly + system prompt (no file writing needed for token measurement) ──

const REQUIRE_RE = /^\s*(const|let|var)\s+\S+\s*=\s*require\(['"]([^'"]+)['"]\);?\s*$/gm;

function extractExportName(out: string): string | null {
  const m = out.match(/^([a-zA-Z_$][\w$]*)/);
  return m ? m[1] : null;
}

function buildAssemblyData(recalls: RecallEntry[], capabilities: string[]): DeliveredRecall | null {
  if (recalls.length === 0) return null;

  if (recalls.length === 1) {
    const pick = recalls[0];
    const implPath = path.join(pick.physicalPath, 'implementation.js');
    if (!fs.existsSync(implPath)) return null;
    return {
      id: pick.id, name: pick.name, description: pick.description,
      filename: `${pick.id}.js`, inputs: pick.inputs, outputs: pick.outputs,
      callExample: pick.callExample, useCases: pick.useCases,
    };
  }

  const seenModules = new Set<string>(), exportNames: string[] = [], seenExports = new Set<string>();
  for (const recall of recalls) {
    const implPath = path.join(recall.physicalPath, 'implementation.js');
    if (!fs.existsSync(implPath)) continue;
    let content = fs.readFileSync(implPath, 'utf-8');
    content.replace(REQUIRE_RE, (_l, _kw, mod) => { seenModules.add(mod); return ''; });
    for (const out of (recall.outputs ?? [])) {
      const name = extractExportName(out);
      if (name && !seenExports.has(name)) { seenExports.add(name); exportNames.push(name); }
    }
  }

  const taskHash = Buffer.from(capabilities.join('|')).toString('base64').slice(0, 8).replace(/[+/=]/g, 'x');
  const manifest = recalls.map((r, i) => {
    const letters = 'ABCDEFGHIJ';
    const outs = (r.outputs ?? []).slice(0, 3).join(', ') || r.name;
    return `  [${letters[i] ?? String(i+1)}] ${r.name} — ${outs}`;
  }).join('\n');

  return {
    id: `assembly_${taskHash}`,
    name: `Assembly (${recalls.length} modules)`,
    description: `Capabilities included:\n${manifest}`,
    filename: `assembly_${taskHash}.js`,
    inputs: recalls.flatMap(r => r.inputs ?? []),
    outputs: exportNames, isComposite: true,
    compositeIds: recalls.map(r => r.id),
  };
}

function buildInjectedSystem(recall: DeliveredRecall | null): string {
  if (!recall) {
    return `You are a senior software engineer. Write clean, production-ready JavaScript/Node.js code with proper error handling. Respond with code only. No explanations, no prose.`;
  }
  if (recall.isComposite) {
    const exports = recall.outputs?.join(', ') || '(see file)';
    return `You are a senior software engineer.

The following assembly file has been written to ./strata/${recall.filename}:

  require('./strata/${recall.filename}')

${recall.description}

Exports: ${exports}

CRITICAL INSTRUCTIONS:
- This file is already on disk. Import it with require('./strata/${recall.filename}').
- Write ONLY glue code: routes, config, and wiring that connects these capabilities to your app.
- Do NOT reimplement anything the assembly provides.
- Respond with code only. No explanations, no prose.`;
  }

  const lines = [
    `require('./strata/${recall.filename}')`,
    `// ${recall.name} — ${recall.description}`,
  ];
  if (recall.inputs?.length || recall.outputs?.length) {
    lines.push(`// inputs: ${recall.inputs?.join(', ')||'—'} → outputs: ${recall.outputs?.join(', ')||'—'}`);
  }
  if (recall.callExample) lines.push(`// example: ${recall.callExample}`);

  return `You are a senior software engineer.

The following file has been written to ./strata/ in this project:

${lines.join('\n')}

CRITICAL INSTRUCTIONS:
- This file is already on disk. Import it with require('./strata/${recall.filename}').
- Write ONLY the glue code: routes, config, wiring that connects this module to your app.
- Do NOT reimplement anything the strata file provides.
- Respond with code only. No explanations, no prose.`;
}

// ─── Decompose task (LLM call) ────────────────────────────────────────────────

async function decomposeTask(taskPrompt: string): Promise<string[]> {
  try {
    const { text } = await generateText({
      model: aiAnthropic('claude-haiku-4-5-20251001'),
      system: 'Extract the DOMAIN-SPECIFIC modules or packages needed to implement a coding task. Focus only on what is unique to this task — NOT generic concerns like error handling, response formatting, or input validation. Reply ONLY with a JSON array of 2–4 short phrases naming the core technical components. No prose, no markdown.',
      prompt: `Task: ${taskPrompt.slice(0, 500)}\n\nCore domain modules needed:`,
      maxTokens: 100,
      temperature: 0,
    });
    const clean = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(clean);
    const caps: string[] = Array.isArray(parsed) ? parsed.filter((c: unknown) => typeof c === 'string').slice(0, 7) : [];
    return caps.length > 0 ? caps : [taskPrompt.slice(0, 100)];
  } catch {
    return [taskPrompt.slice(0, 100)];
  }
}

// ─── Complexity gate (mirrors src/mcp-server.ts isOverkillForStrata) ─────────
// Must stay in sync with the MCP server version — the benchmark should reflect
// real MCP behaviour, not an unconstrained run.

function isOverkillForStrata(task: string): boolean {
  const words = task.trim().split(/\s+/).length;
  if (words < 30) return true;
  if (words >= 70) return false;
  const hasComplexityKeywords =
    /\bsystem\b|\bcomplete\b|\bfull\b|\bmultiple\b|\bpipeline\b|\bservice\b|support[s]?\s*:|include[s]?\s*:/i.test(task);
  if (hasComplexityKeywords) return false;
  const reqMarkers = (task.match(/\bsupport[s]?\b|\bhandle[s]?\b|\bimplement[s]?\b/gi) || []).length;
  return reqMarkers < 2;
}

// ─── Main benchmark ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Loading recall library...');
  walkRecalls(recallsDir);
  console.log(`  Loaded ${allRecalls.length} recalls\n`);

  const totalBaseline = TASKS.reduce((s, t) => s + t.baselineTokens, 0);
  const cacheDir = path.join(__dirname, '..', 'cache');
  const allSignals: RecallSignal[] = [];
  const results: Array<{
    id: number; name: string; baselineTokens: number; strataTokens: number;
    inTokens: number; outTokens: number; recalls: string[]; capabilities: string[];
    saved: number; pct: number;
  }> = [];

  for (const task of TASKS) {
    process.stdout.write(`  [${task.id.toString().padStart(2)}/12] ${task.name.padEnd(35)}`);

    // Gate: skip Strata for tasks below break-even threshold (mirrors MCP server behaviour)
    if (isOverkillForStrata(task.prompt)) {
      results.push({
        id: task.id, name: task.name,
        baselineTokens: task.baselineTokens, strataTokens: task.baselineTokens,
        inTokens: 0, outTokens: 0, recalls: [], capabilities: [],
        saved: 0, pct: 0,
      });
      process.stdout.write(`baseline:${task.baselineTokens}  strata:SKIPPED (too simple for Strata)\n`);
      continue;
    }

    const capabilities = await decomposeTask(task.prompt);
    const rawRecalls   = mapCapabilitiesToRecalls(capabilities, task.prompt);
    const resolved     = resolveDependencies(rawRecalls).slice(0, 3);
    const delivered    = buildAssemblyData(resolved, capabilities);
    const systemText   = buildInjectedSystem(delivered);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemText,
      messages: [{ role: 'user', content: `Task: ${task.prompt}\n\nWrite only the glue code that imports and wires the strata file into an Express app.` }],
    });

    const inTokens  = response.usage.input_tokens;
    const outTokens = response.usage.output_tokens;
    const strataTokens = inTokens + outTokens;
    const saved = task.baselineTokens - strataTokens;
    const pct   = (saved / task.baselineTokens) * 100;

    // Extract output text for fitness signal recording
    const outputText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('\n');

    // Record a signal per delivered recall
    for (const recall of resolved) {
      allSignals.push(recordSignal(
        task.id, task.name, recall.id,
        outputText, outTokens, task.baselineTokens,
        recall.outputs ?? [],
      ));
    }

    const recallIds = resolved.map(r => r.id);
    results.push({ id: task.id, name: task.name, baselineTokens: task.baselineTokens, strataTokens, inTokens, outTokens, recalls: recallIds, capabilities, saved, pct });

    const sign = saved >= 0 ? `saved ${saved} (${pct.toFixed(1)}%)` : `overhead ${Math.abs(saved)} (${Math.abs(pct).toFixed(1)}%)`;
    process.stdout.write(`baseline:${task.baselineTokens}  strata:${strataTokens}  ${sign}\n`);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  const totalStrata  = results.reduce((s, r) => s + r.strataTokens, 0);
  const totalSaved   = totalBaseline - totalStrata;
  const totalPct     = (totalSaved / totalBaseline) * 100;
  const totalIn      = results.reduce((s, r) => s + r.inTokens, 0);
  const totalOut     = results.reduce((s, r) => s + r.outTokens, 0);
  const costBaseline = (totalIn * 0.25 + totalOut * 4.0) / 1e6; // rough Haiku pricing estimate (baseline as if same ratio)
  const costStrata   = (totalIn * 0.25 + totalOut * 4.0) / 1e6;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const date = new Date().toISOString().slice(0, 10);

  console.log(`\n  ────────────────────────────────────────────────────`);
  console.log(`  Total baseline : ${totalBaseline.toLocaleString()} tokens`);
  console.log(`  Total strata   : ${totalStrata.toLocaleString()} tokens`);
  console.log(`  Saved          : ${totalSaved.toLocaleString()} (${totalPct.toFixed(1)}%)`);
  console.log(`  ────────────────────────────────────────────────────\n`);

  // ─── Save + print fitness signals ─────────────────────────────────────────

  saveSignals(allSignals, cacheDir);
  console.log(`  Signals saved to cache/signals.json (${allSignals.length} entries)\n`);

  const allSignalsOnDisk = loadSignals(cacheDir);
  const seenIds = [...new Set(allSignals.map(s => s.recallId))];
  const fitnessRows = seenIds
    .map(id => computeRecallFitness(id, allSignalsOnDisk))
    .sort((a, b) => a.fitness - b.fitness);

  console.log(`  Per-recall fitness (this run):\n`);
  console.log(`  ${'Recall ID'.padEnd(45)} tasks  glueRatio  refRate  retryRate  fitness`);
  console.log(`  ${'─'.repeat(95)}`);
  for (const f of fitnessRows) {
    const badge = f.fitness >= 80 ? '✓' : f.fitness < 40 ? '✗' : '~';
    console.log(
      `  ${badge} ${f.recallId.padEnd(43)} ${String(f.taskCount).padStart(5)}  ` +
      `${f.avgGlueRatio.toFixed(2).padStart(9)}  ` +
      `${(f.referenceRate * 100).toFixed(0).padStart(6)}%  ` +
      `${(f.retryRate * 100).toFixed(0).padStart(8)}%  ` +
      `${String(f.fitness).padStart(7)}`,
    );
  }
  console.log('');

  // ─── Write RESULTS-{date}.md ──────────────────────────────────────────────

  const lines: string[] = [
    `# Strata Benchmark — Results`,
    ``,
    `**Date:** ${now}`,
    `**Model:** \`${MODEL}\``,
    `**Recall Library Size:** ${allRecalls.length} recalls`,
    `**Tasks Run:** ${TASKS.length}`,
    `**Baseline source:** RESULTS.md 2026-06-23 (stored averages — not re-run)`,
    ``,
    `---`,
    ``,
    `## Executive Summary`,
    ``,
    `| Metric | With Strata | Baseline (stored) |`,
    `|--------|-------------|-------------------|`,
    `| Total tokens | ${totalStrata.toLocaleString()} | ${totalBaseline.toLocaleString()} |`,
    `| Saved | ${totalSaved.toLocaleString()} (${totalPct.toFixed(1)}%) | — |`,
    `| Input tokens | ${totalIn.toLocaleString()} | — |`,
    `| Output tokens | ${totalOut.toLocaleString()} | — |`,
    ``,
    `---`,
    ``,
    `## Per-Task Results`,
    ``,
    `| # | Task | Baseline | Strata | Saved | % |`,
    `|---|------|----------|--------|-------|---|`,
    ...results.map(r => {
      if (r.recalls.length === 0 && r.saved === 0) {
        return `| ${r.id} | ${r.name} | ${r.baselineTokens} | SKIPPED | — | — |`;
      }
      const sign = r.saved >= 0 ? `${r.saved}` : `−${Math.abs(r.saved)}`;
      const pctFmt = r.saved >= 0 ? `${r.pct.toFixed(1)}%` : `−${Math.abs(r.pct).toFixed(1)}%`;
      return `| ${r.id} | ${r.name} | ${r.baselineTokens} | ${r.strataTokens} | ${sign} | ${pctFmt} |`;
    }),
    ``,
    `---`,
    ``,
    `## Recall Selections`,
    ``,
    ...results.map(r => [
      `### Task ${r.id}: ${r.name}`,
      ``,
      `**Capabilities:** ${r.capabilities.join(', ')}`,
      ``,
      `**Recalls:** ${r.recalls.join(', ') || '(none)'}`,
      ``,
    ].join('\n')),
    `---`,
    ``,
    `## Recall Fitness (this run)`,
    ``,
    `| Recall ID | Tasks | Glue Ratio | Ref Rate | Retry Rate | Fitness |`,
    `|-----------|-------|-----------|----------|-----------|---------|`,
    ...fitnessRows.map(f => {
      const badge = f.fitness >= 80 ? '✓' : f.fitness < 40 ? '✗' : '~';
      return `| ${badge} \`${f.recallId}\` | ${f.taskCount} | ${f.avgGlueRatio.toFixed(2)} | ${(f.referenceRate * 100).toFixed(0)}% | ${(f.retryRate * 100).toFixed(0)}% | ${f.fitness} |`;
    }),
    ``,
    `> ✓ fitness ≥ 80 (L1 cache candidate) · ~ 40–79 · ✗ < 40 (improvement loop target)`,
  ];

  const outPath = path.join(__dirname, `RESULTS-${date}.md`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`  Results written to ${outPath}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
