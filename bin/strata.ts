#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { consentAlreadyShown, markConsentShown, setTelemetry } from '../src/logger.js';

const command = process.argv[2];
const subcommand = process.argv[3];

const strataDir = path.join(os.homedir(), '.strata');
const configPath = path.join(strataDir, 'config.json');

function loadConfig(): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return { mode: 'local' };
  try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return { mode: 'local' }; }
}

// ─── Telemetry consent (shown once at install time) ───────────────────────────

function promptTelemetryConsent(): void {
  if (consentAlreadyShown()) return;

  const D = '\x1b[2m';  // dim
  const B = '\x1b[1m';  // bold
  const R = '\x1b[0m';  // reset
  const Y = '\x1b[33m'; // yellow

  process.stdout.write('\n');
  process.stdout.write(`${B}Strata collects anonymized usage data to improve its recall library.${R}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  What is logged:\n`);
  process.stdout.write(`  ${D}• Decomposed capability phrases (what you asked Claude to build)${R}\n`);
  process.stdout.write(`  ${D}• Which recalls were delivered${R}\n`);
  process.stdout.write(`  ${D}• Whether conventions were injected${R}\n`);
  process.stdout.write(`  ${D}• Estimated tokens saved${R}\n`);
  process.stdout.write(`  ${D}• Project identifier (hashed, not the path)${R}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  What is ${B}never${R} logged:\n`);
  process.stdout.write(`  ${D}• Your code${R}\n`);
  process.stdout.write(`  ${D}• Your raw task descriptions${R}\n`);
  process.stdout.write(`  ${D}• Your API keys${R}\n`);
  process.stdout.write(`  ${D}• Your file paths or project names${R}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  This data feeds the evolutionary loop that improves the library for everyone.\n`);
  process.stdout.write(`  ${D}To opt out at any time: ${Y}strata config --no-telemetry${R}\n`);
  process.stdout.write('\n');

  // Read one line from stdin synchronously
  process.stdout.write(`Continue? [Y/n] `);
  const buf = Buffer.alloc(64);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, 64, null); } catch { /* non-interactive stdin — default yes */ }
  const answer = buf.slice(0, n).toString().trim().toLowerCase();
  const optedIn = answer !== 'n' && answer !== 'no';

  markConsentShown(optedIn);

  if (!optedIn) {
    process.stdout.write(`\n  Telemetry disabled. You can re-enable with: strata config --telemetry\n`);
  }
  process.stdout.write('\n');
}

function saveConfig(data: Record<string, unknown>): void {
  if (!fs.existsSync(strataDir)) fs.mkdirSync(strataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
}

// ─── Global CLAUDE.md writer ──────────────────────────────────────────────────
// Writes Strata usage instructions to ~/.claude/CLAUDE.md so Claude Code
// knows to call strata_use in EVERY project, not just this one.

const STRATA_CLAUDE_MD_MARKER = '<!-- strata-instructions -->';
const STRATA_CLAUDE_MD_BLOCK = `${STRATA_CLAUDE_MD_MARKER}
## Strata — Recall-Augmented Coding

Strata gives you ONE tool: \`strata_use\`. That is the entire surface — there is nothing else to look
for, and searching for other Strata tools costs turns and finds nothing.

Call it ONCE, at the start of a task where you are writing meaningful new code — a feature, a module,
a new file, a bug fix needing substantial new logic.

- **Skip it for:** typos, renames, reformatting, a 1–3 line edit, a comment, a find-and-replace.
- **Arguments:**
  - \`dir\` — absolute path to the project root.
  - \`task\` — a short label for the work.
  - \`capabilities\` — 3–6 short phrases naming the core technical components. YOU are the best-placed
    thing in the system to write these, because you have read the whole task in context. Preserve any
    package named explicitly.
    e.g. \`["cursor pagination with sorting", "request body validation", "structured request logging"]\`

Strata writes real files into the project and states which it CREATED and which it MODIFIED. It also
writes \`strata/verify.js\` — one command that runs the unit tests, boots the app, and exercises each
requirement end to end. Running it is the fastest way to find out whether any of it is wrong.

It is ordinary code, not a black box. Read as much of it as the stakes of the task warrant, change what
does not fit, and delete what you did not ask for. If Strata declines the task, believe it — that is a
measured judgement that writing it yourself is cheaper here.
<!-- /strata-instructions -->`;

function writeGlobalClaudeMd(G: string, Dim: string, Re: string): void {
  const claudeDir  = path.join(os.homedir(), '.claude');
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');

  try {
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

    let existing = '';
    if (fs.existsSync(claudeMdPath)) {
      existing = fs.readFileSync(claudeMdPath, 'utf-8');
    }

    if (existing.includes(STRATA_CLAUDE_MD_MARKER)) {
      // Already written — update the block in place
      const updated = existing.replace(
        /<!-- strata-instructions -->[\s\S]*?<!-- \/strata-instructions -->/,
        STRATA_CLAUDE_MD_BLOCK
      );
      fs.writeFileSync(claudeMdPath, updated, 'utf-8');
      process.stdout.write(`  ${G}✓ Updated${Re}   ~/.claude/CLAUDE.md  ${Dim}(Strata instructions refreshed)${Re}\n`);
    } else {
      // Append to existing file (or create new)
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
      fs.writeFileSync(claudeMdPath, existing + separator + STRATA_CLAUDE_MD_BLOCK + '\n', 'utf-8');
      process.stdout.write(`  ${G}✓ Written${Re}    ~/.claude/CLAUDE.md  ${Dim}(Strata instructions added)${Re}\n`);
    }
  } catch (e) {
    process.stdout.write(`  ✗ Could not write ~/.claude/CLAUDE.md: ${(e as Error).message}\n`);
  }
}

function promptGlobalActivation(Dim: string, Re: string, B: string, force?: boolean): boolean {
  const cfg = loadConfig();

  // --global / --no-global flags bypass the prompt entirely
  if (force === true)  { cfg.globalActivation = true;  saveConfig(cfg); return true; }
  if (force === false) { cfg.globalActivation = false; saveConfig(cfg); return false; }

  // Already decided in a previous install — respect the stored choice, don't ask again
  if (typeof cfg.globalActivation === 'boolean') return cfg.globalActivation as boolean;

  process.stdout.write('\n');
  process.stdout.write(`${B}Load Strata automatically in all Claude Code sessions?${Re}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  ${Dim}Yes${Re}  Strata activates whenever Claude Code opens any project.\n`);
  process.stdout.write(`       It will call strata_use before coding tasks without you asking.\n`);
  process.stdout.write(`  ${Dim}No${Re}   Strata only runs when you call its tools manually.\n`);
  process.stdout.write('\n');
  process.stdout.write(`  ${Dim}Change later: strata install --global  or  strata install --no-global${Re}\n`);
  process.stdout.write('\n');

  process.stdout.write('Activate globally? [Y/n] ');
  const buf = Buffer.alloc(64);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, 64, null); } catch { /* non-interactive stdin — default yes */ }
  const answer = buf.slice(0, n).toString().trim().toLowerCase();
  const global = answer !== 'n' && answer !== 'no';

  cfg.globalActivation = global;
  saveConfig(cfg);

  if (!global) {
    process.stdout.write(`\n  Global activation skipped. Run strata install --global to enable later.\n`);
  }
  process.stdout.write('\n');
  return global;
}

function promptRecallRequestConsent(Dim: string, Re: string, B: string): void {
  const cfg = loadConfig();

  // Already decided in a previous install — respect it, don't re-ask.
  if (cfg.recallRequests === 'always' || cfg.recallRequests === 'ask' || cfg.recallRequests === 'never') return;

  process.stdout.write('\n');
  process.stdout.write(`${B}When Strata has no recall for something you build, may it file a request?${Re}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  ${Dim}A recall request is a short note describing the missing module, so the${Re}\n`);
  process.stdout.write(`  ${Dim}library can grow to cover it. It never contains your code — only a${Re}\n`);
  process.stdout.write(`  ${Dim}description, saved under ~/.strata/requests/.${Re}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  ${Dim}Yes${Re}  Strata files requests automatically, without interrupting you.\n`);
  process.stdout.write(`  ${Dim}No${Re}   Strata asks you in the session each time before filing one.\n`);
  process.stdout.write('\n');

  process.stdout.write('File requests automatically? [Y/n] ');
  const buf = Buffer.alloc(64);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, 64, null); } catch { /* non-interactive — default yes */ }
  const answer = buf.slice(0, n).toString().trim().toLowerCase();
  // Yes -> always (file silently). No -> ask (still offer per-session; the session-yes count can later
  // promote this to always). "no" here is NOT "never" — the user can fully opt out separately.
  cfg.recallRequests = (answer === 'n' || answer === 'no') ? 'ask' : 'always';
  saveConfig(cfg);
  process.stdout.write('\n');
}

function printBanner(): void {
  const Y  = '\x1b[38;2;255;215;50m';   // yellow
  const B  = '\x1b[38;2;127;175;196m';  // blue    #7FAFC4
  const R  = '\x1b[0m';
  const WB = '\x1b[1m';
  const D  = '\x1b[2m';

  // Recall count from index if available
  let recallCount = '11';
  try {
    const indexPath = path.resolve(__dirname, '..', '..', 'cache', 'verified-recalls.json');
    if (fs.existsSync(indexPath)) {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const n = (idx.verified ?? []).length;
      if (n > 0) recallCount = n.toLocaleString();
    }
  } catch { /* use default */ }

  // Two-color braille logo (SVG-rasterized) + braille wordmark, side by side
  // Logo: 10h×20w from logo.svg paths, Orange/Blue per strand
  // Wordmark: 10h×52w scaled from brandings/ascii v2 wordmark
  const LOGO_W = 20;
  const LOGO_CHARS = [
    "⠀⠀⠀⢀⠴⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⣰⠃⠀⠈⢿⣄⠀⠀⡀⠀⣠⡶⠛⠛⠑⠢⣀⠀",
    "⠀⠀⢿⡀⠀⠀⠀⠙⢿⣾⣷⣟⠋⠁⠀⠀⠀⢀⣼⠇",
    "⠀⠀⠘⢷⣄⠀⢀⣤⡾⢿⣄⡙⣧⡀⠀⣠⡾⠛⠁⠀",
    "⠀⠀⠀⢈⢻⣼⠋⢰⣷⡾⢿⣯⣙⣻⣦⣿⠀⠀⠀⠀",
    "⠀⠀⠀⠀⣿⡿⣾⣋⣻⣷⣶⢿⡏⣠⡿⢷⡁⠀⠀⠀",
    "⠀⢀⣠⡴⠟⠀⠈⢻⣌⠙⣷⣼⠟⠋⠀⠘⢷⣄⠀⠀",
    "⠠⡿⠉⠀⠀⠀⠀⣀⣽⡷⣿⣧⣄⡀⠀⠀⠈⢷⠀⠀",
    "⠀⠙⠢⣀⣀⡴⡶⠛⠁⠈⠀⠀⠙⢷⡀⠀⢀⡜⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⠶⠋⠀⠀⠀",
  ];
  const LOGO_COLORS = [
    "   OBBB             ",
    "  BB OOO  O OOOBOOO ",
    "  BO   OBBBBOO   OOO",
    "  OOO OOBBBBBB OOOO ",
    "   OBBOOOBBBBBOO    ",
    "    BBBOOOOOBBBBB   ",
    " BBBB BOOOOOBB BBB  ",
    "BBO    BBBOBBB  OB  ",
    " OOOOOBBBB  BOO OO  ",
    "             OOOO   ",
  ];
  const WM_ROWS = [
    "⠀⢀⣸⣿⠿⠿⢿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⣾⡏⠉⠀⠀⠈⠉⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⣤⣿⣧⠀⠀⠀⠀⠀⠘⡟⠀⠀⠀⠀⣤⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠉⢿⣿⣶⣆⣀⣀⠀⠀⠁⠀⠀⣀⣶⣿⣁⣀⣀⡀⢀⣀⣀⡀⣀⣀⣀⠀⠀⠀⣀⣀⣀⣀⡀⠀⠀⣀⣶⣿⣀⣀⣀⣀⠀⠀⣀⣀⣀⣀⣀⠀⠀",
    "⠀⠘⢻⣿⣿⣿⣿⣤⣤⠀⠀⢠⣿⣿⣿⣿⣿⣿⠃⣼⣿⣿⣧⣿⣿⣿⠀⢠⣤⡟⠛⣿⣿⣧⠀⠀⣿⣿⣿⣿⣿⣿⡟⠀⣤⣿⠛⢻⣿⣿⡄⠀",
    "⠀⠀⠀⠀⠸⠿⠿⣿⣿⣇⠀⠀⢸⣿⣿⠀⠀⠀⠀⠀⢸⣿⡿⠀⠸⠇⠀⢸⣿⡇⠀⠀⢿⣿⠀⠀⠀⣿⣿⠀⠀⠀⠀⠀⣿⡇⠀⠀⢸⣿⡇⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠉⣿⣿⡆⠀⢸⣿⣿⠀⠀⠀⠀⠀⢸⣿⡇⠀⠀⠀⠀⠈⠉⠁⠀⣶⣾⣿⠀⠀⠀⣿⣿⠀⠀⠀⠀⠀⠉⠁⠀⢰⣾⣿⡇⠀",
    "⣿⣧⠀⠀⠀⠀⠀⠀⢸⣿⠀⠀⢸⣿⣿⠀⠀⠀⠀⠀⢸⣿⡇⠀⠀⠀⠀⢠⣿⡟⠛⠃⣿⣿⠀⠀⠀⣿⣿⠀⠀⠀⠀⠀⣼⣿⠛⠃⢸⣿⡇⠀",
    "⠿⣿⣶⣀⣀⣀⣀⣀⣾⠏⠀⠀⠸⣿⣿⣀⣀⣀⡀⢀⣸⣿⣇⣀⠀⠀⠀⢸⣿⣇⣀⣀⣿⣿⣀⡀⠀⢿⣿⣀⣀⣀⡀⠰⣿⣏⣀⣀⣸⣿⣇⣀",
    "⠀⠛⣿⣿⣿⣿⣿⣿⠛⠀⠀⠀⠀⠛⢻⣿⣿⣿⠃⢸⣿⣿⣿⣿⡄⠀⠀⠘⣿⣿⣿⡟⠛⣿⣿⡇⠀⠘⢻⣿⣿⣿⠃⠀⢻⣿⣿⣿⠛⢻⣿⣿",
  ];

  process.stdout.write('\n');
  for (let i = 0; i < LOGO_CHARS.length; i++) {
    const line = '  ' + Y + LOGO_CHARS[i] + R + '    ' + B + WM_ROWS[i] + R;
    process.stdout.write(line + '\n');
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${D}verified backend modules, composed and proven  ·  ${recallCount} in the library${R}\n`);
  process.stdout.write('\n');
}

// ─── Banner wave animation (braille logo + wordmark, in-place) ────────────────

function animateBanner(onComplete: () => void): void {
  if (!process.stdout.isTTY) { printBanner(); onComplete(); return; }

  const Y  = '\x1b[38;2;255;215;50m';
  const B  = '\x1b[38;2;127;175;196m';
  const YS = '\x1b[38;2;255;250;210m'; // lighter yellow shine
  const BS = '\x1b[38;2;210;238;252m'; // lighter blue shine
  const R  = '\x1b[0m';
  const D  = '\x1b[2m';

  let recallCount = '11';
  try {
    const indexPath = path.resolve(__dirname, '..', '..', 'cache', 'verified-recalls.json');
    if (fs.existsSync(indexPath)) {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const n = (idx.verified ?? []).length;
      if (n > 0) recallCount = n.toLocaleString();
    }
  } catch { /* use default */ }

  const LOGO_CHARS = [
    "⠀⠀⠀⢀⠴⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⣰⠃⠀⠈⢿⣄⠀⠀⡀⠀⣠⡶⠛⠛⠑⠢⣀⠀",
    "⠀⠀⢿⡀⠀⠀⠀⠙⢿⣾⣷⣟⠋⠁⠀⠀⠀⢀⣼⠇",
    "⠀⠀⠘⢷⣄⠀⢀⣤⡾⢿⣄⡙⣧⡀⠀⣠⡾⠛⠁⠀",
    "⠀⠀⠀⢈⢻⣼⠋⢰⣷⡾⢿⣯⣙⣻⣦⣿⠀⠀⠀⠀",
    "⠀⠀⠀⠀⣿⡿⣾⣋⣻⣷⣶⢿⡏⣠⡿⢷⡁⠀⠀⠀",
    "⠀⢀⣠⡴⠟⠀⠈⢻⣌⠙⣷⣼⠟⠋⠀⠘⢷⣄⠀⠀",
    "⠠⡿⠉⠀⠀⠀⠀⣀⣽⡷⣿⣧⣄⡀⠀⠀⠈⢷⠀⠀",
    "⠀⠙⠢⣀⣀⡴⡶⠛⠁⠈⠀⠀⠙⢷⡀⠀⢀⡜⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⠶⠋⠀⠀⠀",
  ];
  const WM_ROWS = [
    "⠀⢀⣸⣿⠿⠿⢿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⣾⡏⠉⠀⠀⠈⠉⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⣤⣿⣧⠀⠀⠀⠀⠀⠘⡟⠀⠀⠀⠀⣤⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠉⢿⣿⣶⣆⣀⣀⠀⠀⠁⠀⠀⣀⣶⣿⣁⣀⣀⡀⢀⣀⣀⡀⣀⣀⣀⠀⠀⠀⣀⣀⣀⣀⡀⠀⠀⣀⣶⣿⣀⣀⣀⣀⠀⠀⣀⣀⣀⣀⣀⠀⠀",
    "⠀⠘⢻⣿⣿⣿⣿⣤⣤⠀⠀⢠⣿⣿⣿⣿⣿⣿⠃⣼⣿⣿⣧⣿⣿⣿⠀⢠⣤⡟⠛⣿⣿⣧⠀⠀⣿⣿⣿⣿⣿⣿⡟⠀⣤⣿⠛⢻⣿⣿⡄⠀",
    "⠀⠀⠀⠀⠸⠿⠿⣿⣿⣇⠀⠀⢸⣿⣿⠀⠀⠀⠀⠀⢸⣿⡿⠀⠸⠇⠀⢸⣿⡇⠀⠀⢿⣿⠀⠀⠀⣿⣿⠀⠀⠀⠀⠀⣿⡇⠀⠀⢸⣿⡇⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠉⣿⣿⡆⠀⢸⣿⣿⠀⠀⠀⠀⠀⢸⣿⡇⠀⠀⠀⠀⠈⠉⠁⠀⣶⣾⣿⠀⠀⠀⣿⣿⠀⠀⠀⠀⠀⠉⠁⠀⢰⣾⣿⡇⠀",
    "⣿⣧⠀⠀⠀⠀⠀⠀⢸⣿⠀⠀⢸⣿⣿⠀⠀⠀⠀⠀⢸⣿⡇⠀⠀⠀⠀⢠⣿⡟⠛⠃⣿⣿⠀⠀⠀⣿⣿⠀⠀⠀⠀⠀⣼⣿⠛⠃⢸⣿⡇⠀",
    "⠿⣿⣶⣀⣀⣀⣀⣀⣾⠏⠀⠀⠸⣿⣿⣀⣀⣀⡀⢀⣸⣿⣇⣀⠀⠀⠀⢸⣿⣇⣀⣀⣿⣿⣀⡀⠀⢿⣿⣀⣀⣀⡀⠰⣿⣏⣀⣀⣸⣿⣇⣀",
    "⠀⠛⣿⣿⣿⣿⣿⣿⠛⠀⠀⠀⠀⠛⢻⣿⣿⣿⠃⢸⣿⣿⣿⣿⡄⠀⠀⠘⣿⣿⣿⡟⠛⣿⣿⡇⠀⠘⢻⣿⣿⣿⠃⠀⢻⣿⣿⣿⠛⢻⣿⣿",
  ];

  const numRows = LOGO_CHARS.length;
  // Each row: 2 + 20(logo) + 4(gap) + 52(wordmark) = 78 display cols — fits without wrapping
  const LOGO_W = 20, GAP_W = 4, WM_W = 52;
  const totalCols = LOGO_W + GAP_W + WM_W;
  const totalDiag = numRows + totalCols;
  const WAVE_W = 10;
  const FRAMES = 42;

  const renderLines = (wavePos: number): string[] => LOGO_CHARS.map((logoRow, r) => {
    const wmRow = WM_ROWS[r];
    let line = '  ';
    for (let c = 0; c < logoRow.length; c++) {
      const dist = Math.abs(r + c - wavePos);
      const t = dist <= WAVE_W ? 1 - dist / WAVE_W : 0;
      line += (t > 0.5 ? YS : Y) + logoRow[c] + R;
    }
    line += '    ';
    for (let c = 0; c < wmRow.length; c++) {
      const dist = Math.abs(r + (LOGO_W + GAP_W + c) - wavePos);
      const t = dist <= WAVE_W ? 1 - dist / WAVE_W : 0;
      line += (t > 0.5 ? BS : B) + wmRow[c] + R;
    }
    return line;
  });

  // Layout written:  \n + 10 logo lines + \n + tagline\n + \n  = 14 cursor-down steps
  // Logo line 0 is 1 step down from start → move up 13 to reach it from the bottom
  const UP_LINES   = 13;
  const DOWN_LINES = 3; // skip blank + tagline + blank after redrawing logo

  let frame = 0;
  process.stdout.write('\n');
  process.stdout.write('\x1b[?25l');
  process.stdout.write(renderLines(-WAVE_W).join('\n') + '\n');
  process.stdout.write('\n');
  process.stdout.write(`  ${D}verified backend modules, composed and proven  ·  ${recallCount} in the library${R}\n`);
  process.stdout.write('\n');

  const cleanup = () => { process.stdout.write('\x1b[?25h'); process.exit(0); };
  process.on('SIGINT', cleanup);

  const timer = setInterval(() => {
    frame++;
    const wavePos = (frame / FRAMES) * (totalDiag + WAVE_W * 2) - WAVE_W;
    process.stdout.write(`\x1b[${UP_LINES}A`);
    for (const line of renderLines(wavePos)) {
      process.stdout.write(`\r\x1b[2K${line}\n`);
    }
    process.stdout.write(`\x1b[${DOWN_LINES}B`);

    if (frame >= FRAMES) {
      clearInterval(timer);
      process.stdout.write('\x1b[?25h');
      process.removeListener('SIGINT', cleanup);
      onComplete();
    }
  }, 40);
}

// ─── IDE install helpers ──────────────────────────────────────────────────────

type IdeTarget = 'claude' | 'cursor' | 'windsurf' | 'vscode' | 'zed' | 'continue' | 'cline' | 'roo';
type ConfigFormat = 'mcpServers' | 'servers' | 'zed' | 'continue-array';

interface IdeProfile {
  name: string;
  configPath: string;
  configFormat: ConfigFormat;
  instructionsFile: string | null;
  detect: () => boolean;
}

function vscodeExtDir(extId: string): string {
  const home    = os.homedir();
  const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  if (process.platform === 'win32')       return path.join(appdata, 'Code', 'User', 'globalStorage', extId);
  if (process.platform === 'darwin')      return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extId);
  return path.join(home, '.config', 'Code', 'User', 'globalStorage', extId);
}

function ideProfiles(): Record<IdeTarget, IdeProfile> {
  const home    = os.homedir();
  const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');

  // VS Code user-level MCP config (different format from others)
  let vscodeCfg: string;
  if (process.platform === 'win32')       vscodeCfg = path.join(appdata, 'Code', 'User', 'mcp.json');
  else if (process.platform === 'darwin') vscodeCfg = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  else                                    vscodeCfg = path.join(home, '.config', 'Code', 'User', 'mcp.json');

  // Zed settings
  let zedCfg: string;
  if (process.platform === 'win32')       zedCfg = path.join(appdata, 'Zed', 'settings.json');
  else if (process.platform === 'darwin') zedCfg = path.join(home, 'Library', 'Application Support', 'Zed', 'settings.json');
  else                                    zedCfg = path.join(home, '.config', 'zed', 'settings.json');

  // Cline & Roo: MCP config lives inside VS Code extension's globalStorage
  const clineMcp = path.join(vscodeExtDir('saoudrizwan.claude-dev'),       'settings', 'cline_mcp_settings.json');
  const rooMcp   = path.join(vscodeExtDir('rooveterinaryinc.roo-cline'),   'settings', 'cline_mcp_settings.json');

  return {
    claude:   {
      name: 'Claude Code',
      configPath: path.join(home, '.claude', 'settings.json'),
      configFormat: 'mcpServers',
      instructionsFile: 'CLAUDE.md',
      detect: () => fs.existsSync(path.join(home, '.claude')),
    },
    cursor:   {
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      configFormat: 'mcpServers',
      instructionsFile: '.cursorrules',
      detect: () => fs.existsSync(path.join(home, '.cursor')),
    },
    windsurf: {
      name: 'Windsurf',
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      configFormat: 'mcpServers',
      instructionsFile: '.windsurfrules',
      detect: () => fs.existsSync(path.join(home, '.codeium', 'windsurf')),
    },
    vscode:   {
      name: 'VS Code',
      configPath: vscodeCfg,
      configFormat: 'servers',
      instructionsFile: '.github/copilot-instructions.md',
      detect: () => fs.existsSync(path.dirname(vscodeCfg)),
    },
    zed:      {
      name: 'Zed',
      configPath: zedCfg,
      configFormat: 'zed',
      instructionsFile: null,
      detect: () => fs.existsSync(path.dirname(zedCfg)),
    },
    continue: {
      name: 'Continue.dev',
      configPath: path.join(home, '.continue', 'config.json'),
      configFormat: 'continue-array',
      instructionsFile: null,
      detect: () => fs.existsSync(path.join(home, '.continue')),
    },
    cline:    {
      name: 'Cline',
      configPath: clineMcp,
      configFormat: 'mcpServers',
      instructionsFile: null,
      detect: () => fs.existsSync(vscodeExtDir('saoudrizwan.claude-dev')),
    },
    roo:      {
      name: 'Roo Code',
      configPath: rooMcp,
      configFormat: 'mcpServers',
      instructionsFile: null,
      detect: () => fs.existsSync(vscodeExtDir('rooveterinaryinc.roo-cline')),
    },
  };
}

function registerMcp(profile: IdeProfile, serverPath: string): void {
  const cfgDir = path.dirname(profile.configPath);
  if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });

  let cfg: Record<string, unknown> = {};
  if (fs.existsSync(profile.configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(profile.configPath, 'utf-8')); } catch { /* start fresh */ }
  }

  switch (profile.configFormat) {
    case 'mcpServers':
      if (!cfg.mcpServers) cfg.mcpServers = {};
      (cfg.mcpServers as Record<string, unknown>)['strata-lib'] = { command: 'node', args: [serverPath] };
      break;
    case 'servers':
      // VS Code format: requires "type": "stdio"
      if (!cfg.servers) cfg.servers = {};
      (cfg.servers as Record<string, unknown>)['strata-lib'] = { type: 'stdio', command: 'node', args: [serverPath] };
      break;
    case 'zed':
      // Zed context_servers format: nested command object
      if (!cfg.context_servers) cfg.context_servers = {};
      (cfg.context_servers as Record<string, unknown>)['strata-lib'] = { command: { path: 'node', args: [serverPath], env: {} } };
      break;
    case 'continue-array':
      // Continue.dev: mcpServers is an array, not an object
      if (!Array.isArray(cfg.mcpServers)) cfg.mcpServers = [];
      const arr = cfg.mcpServers as Array<Record<string, unknown>>;
      const idx = arr.findIndex(s => s.name === 'strata-lib');
      const entry = { name: 'strata-lib', command: 'node', args: [serverPath] };
      if (idx >= 0) arr[idx] = entry; else arr.push(entry);
      break;
  }

  fs.writeFileSync(profile.configPath, JSON.stringify(cfg, null, 2));
}

const STRATA_INSTRUCTIONS_BLOCK = `
## Strata — Recall-Augmented Coding

Strata is an MCP server that delivers pre-built production code patterns (recalls) into your context.

- **strata_use** — YOU decide whether to call this. Call it at the START of any task where you are writing meaningful new code. Before calling, enumerate the core technical components yourself and pass that list as the \`task\` string (not the raw user prompt). Pass the project root path. Call only once per task.
  - Call when: writing a new file, building a feature, implementing auth / API / database / queue / email / payment / notification logic, adding middleware.
  - Skip when: fixing a typo, renaming, reformatting, editing 1–3 existing lines, or simple refactors.
`;

function writeInstructions(profile: IdeProfile, G: string, Dim: string, Re: string): void {
  if (!profile.instructionsFile) return;
  const instrPath = path.join(process.cwd(), profile.instructionsFile);
  const instrDir  = path.dirname(instrPath);

  if (fs.existsSync(instrPath)) {
    const existing = fs.readFileSync(instrPath, 'utf-8');
    if (!existing.includes('strata_use')) {
      fs.appendFileSync(instrPath, STRATA_INSTRUCTIONS_BLOCK, 'utf-8');
      process.stdout.write(`  ${G}✓ Updated${Re}   ${profile.instructionsFile}\n`);
    } else {
      process.stdout.write(`  ${Dim}  Skipped${Re}   ${profile.instructionsFile} already has Strata block\n`);
    }
  } else {
    if (!fs.existsSync(instrDir)) fs.mkdirSync(instrDir, { recursive: true });
    fs.writeFileSync(instrPath, `# Project Instructions\n${STRATA_INSTRUCTIONS_BLOCK}`, 'utf-8');
    process.stdout.write(`  ${G}✓ Created${Re}   ${profile.instructionsFile}\n`);
  }
}

// ─── install ──────────────────────────────────────────────────────────────────

// `init` is the name people reach for after `npx stratalib`; `install` remains an alias so any
// existing docs or scripts keep working.
/**
 * Hand over to the MCP server when an MCP client is on the other end of stdio.
 *
 * The config every client uses, and the one published on stratalib.com, is:
 *
 *     { "mcpServers": { "strata": { "command": "npx", "args": ["-y", "stratalib"] } } }
 *
 * which runs this bin with NO arguments. Before this branch that fell through to the help case at the
 * bottom, which printed an ASCII banner and a command list onto stdout — the exact channel the client
 * was waiting on for a JSON-RPC `initialize` reply. The handshake never completed, so Strata appeared
 * broken while being correctly installed, and nothing in the output said why.
 *
 * Found by running the published tarball through a real MCP handshake rather than trusting that the
 * documented config worked.
 *
 * Two entry points, both needed:
 *   - `strata mcp` — explicit, for a config file that wants to be unambiguous.
 *   - no command AND stdin is not a TTY — the npx form above. A person typing `npx stratalib` in a
 *     terminal has a TTY, so they still get the help screen.
 */
if (command === 'mcp' || (!command && !process.stdin.isTTY)) {
  // Call the exported starter rather than relying on import side effects: mcp-server.js only boots
  // itself when it IS the entry point, and here the CLI is.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../src/mcp-server.js').startMcpServer();

} else if (command === 'install' || command === 'init') {
  const serverPath   = path.resolve(__dirname, '..', '..', 'dist', 'src', 'mcp-server.js');
  const G   = '\x1b[38;2;100;200;100m';
  const Dim = '\x1b[2m';
  const Re  = '\x1b[0m';

  const installArgs  = process.argv.slice(3);
  const flagClaude   = installArgs.includes('--claude');
  const flagCursor   = installArgs.includes('--cursor');
  const flagWindsurf = installArgs.includes('--windsurf');
  const flagVscode   = installArgs.includes('--vscode');
  const flagZed      = installArgs.includes('--zed');
  const flagContinue = installArgs.includes('--continue');
  const flagCline    = installArgs.includes('--cline');
  const flagRoo      = installArgs.includes('--roo');
  const flagAll      = installArgs.includes('--all');
  const flagGlobal   = installArgs.includes('--global');
  const flagNoGlobal = installArgs.includes('--no-global');
  const anyFlag      = flagClaude || flagCursor || flagWindsurf || flagVscode ||
                       flagZed || flagContinue || flagCline || flagRoo || flagAll;

  const profiles = ideProfiles();

  let targets: IdeTarget[];
  if (anyFlag && !flagAll) {
    targets = ([
      flagClaude   ? 'claude'   : null,
      flagCursor   ? 'cursor'   : null,
      flagWindsurf ? 'windsurf' : null,
      flagVscode   ? 'vscode'   : null,
      flagZed      ? 'zed'      : null,
      flagContinue ? 'continue' : null,
      flagCline    ? 'cline'    : null,
      flagRoo      ? 'roo'      : null,
    ] as (IdeTarget | null)[]).filter((x): x is IdeTarget => x !== null);
  } else {
    // Auto-detect installed IDEs
    targets = (Object.keys(profiles) as IdeTarget[]).filter(k => profiles[k].detect());
    if (targets.length === 0) targets = ['claude']; // always register at minimum
  }

  const B = '\x1b[1m';
  promptTelemetryConsent();
  const useGlobal = promptGlobalActivation(Dim, Re, B,
    flagGlobal ? true : flagNoGlobal ? false : undefined
  );
  promptRecallRequestConsent(Dim, Re, B);
  printBanner();

  for (const target of targets) {
    const p = profiles[target];
    try {
      registerMcp(p, serverPath);
      process.stdout.write(`  ${G}✓ Registered${Re}  ${p.name}  ${Dim}(${p.configPath})${Re}\n`);
    } catch (e) {
      process.stdout.write(`  ✗ Failed     ${p.name}: ${(e as Error).message}\n`);
    }
    writeInstructions(p, G, Dim, Re);
  }

  // Write global CLAUDE.md only if user opted into global activation
  if (useGlobal) writeGlobalClaudeMd(G, Dim, Re);

  process.stdout.write('\n');
  process.stdout.write(`  ${Dim}MCP server:${Re}  ${serverPath}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  Restart your IDE to activate Strata.\n`);
  process.stdout.write('\n');
  // "nothing leaves your machine" was true when composition was local. It is not true now: the task
  // text goes to the hub, which composes blind and returns an assembly still full of placeholders that
  // this machine fills in. The claim has to name what actually crosses the wire, or the first person
  // who runs a proxy catches us overstating it — and that is the one thing a tool like this cannot
  // afford to be caught doing.
  // Prove the server starts before claiming the install worked. A config file pointing at a server
  // that cannot boot is worse than no config: the failure surfaces later, inside the editor, with
  // nothing to say which half is wrong.
  {
    const { spawnSync } = require('child_process');
    const probe = spawnSync(process.execPath, ['-e',
      'const {spawn}=require("child_process");'
      + 'const p=spawn(process.execPath,[' + JSON.stringify(serverPath) + '],{stdio:["pipe","ignore","pipe"]});'
      + 'let ok=false;'
      + 'p.stderr.on("data",d=>{if(!ok&&/running on stdio/.test(String(d))){ok=true;try{p.kill()}catch{};process.exit(0)}});'
      + 'setTimeout(()=>{try{p.kill()}catch{};process.exit(1)},12000);',
    ], { encoding: 'utf-8', timeout: 20000 });

    if (probe.status === 0) {
      process.stdout.write(`  ${G}✓ Verified${Re}   the MCP server starts\n`);
    } else {
      process.stdout.write(`  ${Dim}! Could not confirm the server starts — run${Re} node ${serverPath} ${Dim}to see why${Re}\n`);
    }
  }
  process.stdout.write('\n');

  process.stdout.write(`  ${Dim}One tool: strata_use  ·  no API key  ·  your code and schema never leave your machine${Re}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  ${Dim}To set your LLM provider for smarter recall search:${Re}\n`);
  process.stdout.write(`  ${Dim}  strata configure provider --provider <name> --key <api-key>${Re}\n`);
  process.stdout.write(`  ${Dim}  Providers: anthropic · openai · deepseek · grok · kimi · gemini${Re}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  ${Dim}To target a specific IDE: strata install --cursor --zed --cline${Re}\n`);
  process.stdout.write('\n');

// ─── configure ───────────────────────────────────────────────────────────────

} else if (command === 'config') {

  // ─── strata config --no-telemetry / --telemetry ──────────────────────────
  const configArgs = process.argv.slice(3);
  if (configArgs.includes('--no-telemetry')) {
    setTelemetry(false);
    process.stdout.write('\n  Telemetry disabled. Strata will not log usage data.\n');
    process.stdout.write('  Re-enable at any time with: strata config --telemetry\n\n');
  } else if (configArgs.includes('--telemetry')) {
    setTelemetry(true);
    process.stdout.write('\n  Telemetry enabled. Usage data will be logged to improve the recall library.\n');
    process.stdout.write('  Disable at any time with: strata config --no-telemetry\n\n');
  } else {
    const D = '\x1b[2m'; const R = '\x1b[0m';
    process.stdout.write('\n  Usage:\n');
    process.stdout.write(`  ${D}strata config --no-telemetry${R}   Disable usage logging\n`);
    process.stdout.write(`  ${D}strata config --telemetry${R}      Re-enable usage logging\n\n`);
  }

} else if (command === 'configure') {

  if (subcommand === 'local') {
    const cfg = loadConfig();
    cfg.mode = 'local';
    saveConfig(cfg);
    console.log('Switched to local mode. Restart Claude Code to apply.');

  } else if (subcommand === 'hub') {
    const args = process.argv.slice(4);
    const urlFlag = args.indexOf('--url');
    const keyFlag = args.indexOf('--key');

    if (urlFlag === -1 || keyFlag === -1) {
      console.error('Usage: strata configure hub --url <hub-url> --key <api-key>');
      process.exit(1);
    }

    const url = args[urlFlag + 1];
    const apiKey = args[keyFlag + 1];

    if (!url || !apiKey) {
      console.error('Both --url and --key are required.');
      process.exit(1);
    }

    const cfg = loadConfig();
    cfg.mode = 'hub';
    cfg.hub = { url: url.replace(/\/$/, ''), apiKey };
    saveConfig(cfg);

    console.log(`
Switched to hub mode.

  Hub URL: ${url}
  Config:  ${configPath}

Restart Claude Code to apply.
`);

  } else if (subcommand === 'provider') {
    const args    = process.argv.slice(4);
    const pFlag   = args.indexOf('--provider');
    const kFlag   = args.indexOf('--key');
    const mFlag   = args.indexOf('--model');

    if (pFlag === -1) {
      console.error('Usage: strata configure provider --provider <name> --key <api-key> [--model <model-id>]');
      console.error('Providers: anthropic · openai · deepseek · grok · kimi · gemini · none');
      process.exit(1);
    }

    const provider = args[pFlag + 1];
    const apiKey   = kFlag !== -1 ? args[kFlag + 1] : '';
    const model    = mFlag !== -1 ? args[mFlag + 1] : '';

    const PROVIDER_DEFAULTS: Record<string, string> = {
      anthropic: 'claude-haiku-4-5-20251001',
      openai:    'gpt-4o-mini',
      deepseek:  'deepseek-chat',
      grok:      'grok-3-mini',
      kimi:      'moonshot-v1-8k',
      gemini:    'gemini-2.0-flash',
    };

    const known = Object.keys(PROVIDER_DEFAULTS);
    if (provider !== 'none' && !known.includes(provider)) {
      console.error(`Unknown provider "${provider}". Supported: ${known.join(' · ')} · none`);
      process.exit(1);
    }

    const cfg = loadConfig();
    if (provider === 'none') {
      delete cfg.provider; delete cfg.apiKey; delete cfg.model;
      saveConfig(cfg);
      console.log('\n  Provider cleared — strata will use keyword-only recall search.\n');
    } else {
      if (!apiKey) {
        console.error(`--key is required for provider "${provider}"`);
        process.exit(1);
      }
      cfg.provider = provider;
      cfg.apiKey   = apiKey;
      cfg.model    = model || PROVIDER_DEFAULTS[provider];
      saveConfig(cfg);
      console.log(`
  Provider configured.

    Provider : ${provider}
    Model    : ${cfg.model}
    Config   : ${configPath}

  Restart your IDE to apply.
`);
    }

  } else {
    console.log(`
Usage:
  strata configure local
  strata configure hub --url <url> --key <api-key>
  strata configure provider --provider <name> --key <api-key> [--model <id>]
  strata configure provider --provider none   (disable LLM, use keyword search)

Providers for strata configure provider:
  anthropic   default model: claude-haiku-4-5-20251001
  openai      default model: gpt-4o-mini
  deepseek    default model: deepseek-chat
  grok        default model: grok-3-mini
  kimi        default model: moonshot-v1-8k
  gemini      default model: gemini-2.0-flash

Current config: ${configPath}
`);
  }

// ─── status ───────────────────────────────────────────────────────────────────

} else if (command === 'status') {
  const cfg = loadConfig();
  console.log(`\nStrataLib status\n`);
  console.log(`  Mode: ${cfg.mode || 'local'}`);
  if (cfg.mode === 'hub' && cfg.hub) {
    const hub = cfg.hub as { url: string; apiKey: string };
    console.log(`  Hub:  ${hub.url}`);
    console.log(`  Key:  ${hub.apiKey.slice(0, 10)}...`);
  }
  console.log(`  Config: ${configPath}\n`);

// ─── measure ──────────────────────────────────────────────────────────────────
// strata measure "<prompt>" [--dir <project-path>]
// Spawns the MCP server to get the REAL Strata system prompt, then makes two
// direct API calls — one with it, one without — and prints exact token counts.

} else if (command === 'measure') {
  (async () => {
    const { spawn } = require('child_process') as typeof import('child_process');

    const measureArgs = process.argv.slice(3);
    const prompt = measureArgs.find(a => !a.startsWith('--')) ?? '';
    const dirIdx = measureArgs.indexOf('--dir');
    const dir    = dirIdx !== -1 ? measureArgs[dirIdx + 1] : process.cwd();

    if (!prompt) {
      console.error('\n  Usage: strata measure "<prompt>" [--dir <project-path>]\n');
      process.exit(1);
    }

    const envPath = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.+)$/);
        if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('\n  No ANTHROPIC_API_KEY found. Set it in .env or environment.\n');
      process.exit(1);
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });
    const mcpPath = path.join(__dirname, '..', '..', 'dist', 'src', 'mcp-server.js');

    const D = '\x1b[2m'; const R = '\x1b[0m';
    const Y = '\x1b[38;2;255;215;50m'; const G = '\x1b[38;2;100;200;100m';
    const B = '\x1b[38;2;127;175;196m'; const Bl = '\x1b[1m';

    console.log(`\n  ${Y}Strata Measure${R}\n`);
    console.log(`  ${D}Prompt:${R}  ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`);
    console.log(`  ${D}Project:${R} ${dir}\n`);

    // ── Step 1: get real Strata system prompt via MCP stdio ──────────────────
    process.stdout.write(`  ${D}Getting Strata system prompt...${R}`);
    const systemText = await new Promise<string>((resolve) => {
      const srv = spawn('node', [mcpPath], { stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '', resolved = false;
      let toolId = 0;

      function done(text: string) {
        if (resolved) return;
        resolved = true;
        srv.kill();
        resolve(text);
      }

      srv.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 0) {
              // Server initialized — send initialized notification, then call strata_use
              srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
              toolId = 1;
              srv.stdin.write(JSON.stringify({
                jsonrpc: '2.0', id: toolId, method: 'tools/call',
                params: { name: 'strata_use', arguments: { task: prompt, dir } },
              }) + '\n');
            }
            if (msg.id === toolId) {
              const text: string = msg.result?.content?.[0]?.text ?? '';
              done(text);
            }
          } catch { /* partial line */ }
        }
      });

      srv.on('exit', () => done(''));
      // Library load takes ~12s — give it 45s
      setTimeout(() => done(''), 45000);

      // Send MCP initialize
      srv.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'measure', version: '1' } },
      }) + '\n');
    });

    if (!systemText || systemText.startsWith('Task is below') || systemText.startsWith('Strata error')) {
      process.stdout.write(` skipped\n  ${D}${systemText || 'No system prompt returned — task may be below gate threshold.'}${R}\n\n`);
      process.exit(0);
    }
    process.stdout.write(` done  ${D}(${Math.round(systemText.length / 4)} tokens)${R}\n`);

    // ── Step 2: Baseline — no Strata ─────────────────────────────────────────
    process.stdout.write(`  ${D}Baseline (without Strata)...${R}`);
    let baseIn = 0, baseOut = 0;
    try {
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });
      baseIn = res.usage.input_tokens; baseOut = res.usage.output_tokens;
      process.stdout.write(` done\n`);
    } catch (e) { process.stdout.write(` failed: ${(e as Error).message}\n`); process.exit(1); }

    // ── Step 3: With Strata — inject real system prompt ───────────────────────
    process.stdout.write(`  ${D}With Strata...${R}`);
    let strataIn = 0, strataOut = 0;
    try {
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 2048,
        system: systemText,
        messages: [{ role: 'user', content: `Write ONLY the glue code that wires the delivered recalls. Task: ${prompt}` }],
      });
      strataIn = res.usage.input_tokens; strataOut = res.usage.output_tokens;
      process.stdout.write(` done\n`);
    } catch (e) { process.stdout.write(` failed: ${(e as Error).message}\n`); process.exit(1); }

    // ── Results ───────────────────────────────────────────────────────────────
    const savedOut = baseOut - strataOut;
    const savedPct = baseOut > 0 ? Math.round((savedOut / baseOut) * 100) : 0;
    const costBase   = baseIn * 0.00000025 + baseOut * 0.00000125;
    const costStrata = strataIn * 0.00000025 + strataOut * 0.00000125;
    const col = (s: string | number, w: number) => String(s).padStart(w);

    console.log(`\n  ${Bl}Results${R}  ${D}(claude-haiku-4-5, Anthropic pricing)${R}\n`);
    console.log(`  ${D}${''.padEnd(42, '─')}${R}`);
    console.log(`  ${D}                      Without     With${R}`);
    console.log(`  ${D}${''.padEnd(42, '─')}${R}`);
    console.log(`  ${B}Input tokens   ${R}    ${col(baseIn, 7)}  ${col(strataIn, 7)}`);
    console.log(`  ${B}Output tokens  ${R}    ${col(baseOut, 7)}  ${col(strataOut, 7)}`);
    console.log(`  ${B}Total tokens   ${R}    ${col(baseIn+baseOut, 7)}  ${col(strataIn+strataOut, 7)}`);
    console.log(`  ${D}${''.padEnd(42, '─')}${R}`);
    console.log(`  ${B}Output saved   ${R}    ${' '.repeat(7)}  ${G}${col(savedOut, 5)} tok  (${savedPct}%)${R}`);
    console.log(`  ${B}Cost without   ${R}    $${costBase.toFixed(5)}`);
    console.log(`  ${B}Cost with      ${R}    $${costStrata.toFixed(5)}`);
    console.log(`  ${D}${''.padEnd(42, '─')}${R}\n`);

  })().catch(e => { console.error(e); process.exit(1); });

// ─── logs ─────────────────────────────────────────────────────────────────────

} else if (command === 'logs') {
  const { readUsageLogs, usageSummary } = require('../src/logger') as typeof import('../src/logger');
  const entries = readUsageLogs();
  if (entries.length === 0) {
    console.log('\n  No usage logs yet. Use strata_use via Claude Code to start tracking.\n');
    process.exit(0);
  }
  const s = usageSummary(entries);
  const D = '\x1b[2m'; const R = '\x1b[0m'; const Y = '\x1b[38;2;255;215;50m'; const B = '\x1b[38;2;127;175;196m';
  console.log(`\n  ${Y}Strata Usage${R}\n`);
  console.log(`  ${B}strata_use calls${R}      ${s.totalCalls}`);
  console.log(`  ${B}recalls delivered${R}     ${s.totalRecalls}`);
  console.log(`  ${B}tokens saved (est.)${R}   ${s.totalTokens.toLocaleString()}`);
  console.log();
  const recent = entries.slice(-5).reverse();
  console.log(`  ${D}Last ${recent.length} calls:${R}`);
  for (const e of recent) {
    const d = new Date(e.timestamp).toLocaleString();
    const caps = (e.capabilities ?? []).slice(0, 2).join(', ');
    console.log(`  ${D}${d}${R}  ${e.recallCount} recalls  ~${e.estimatedTokensSaved} tokens  ${caps}`);
  }
  console.log();

// ─── imprint ──────────────────────────────────────────────────────────────────

} else if (command === 'imprint') {

  if (subcommand === 'scan') {
    const args = process.argv.slice(4);
    const scanPath = args.find(a => !a.startsWith('--')) || './src';
    const overwrite = args.includes('--overwrite') || args.includes('-f');
    const dryRun   = args.includes('--dry-run');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { imprint } = require('../src/imprint/index') as typeof import('../src/imprint/index');

    const lineWidth = 50;
    const line = '─'.repeat(lineWidth);

    console.log(`\n  Imprint ${line.slice(8)}\n`);

    if (dryRun) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { scan } = require('../src/imprint/scanner') as typeof import('../src/imprint/scanner');
      const result = scan(scanPath);
      console.log(`  Scan path : ${path.resolve(scanPath)}`);
      console.log(`  Files     : ${result.filesScanned}`);
      console.log(`  Patterns  : ${result.patterns.length}`);
      if (result.skipped.length) {
        console.log(`  Skipped   : ${result.skipped.length} files`);
      }
      console.log('\n  Patterns found (dry run — nothing written):\n');
      result.patterns.forEach(p =>
        console.log(`    ${p.domain.padEnd(14)} ${p.name} (${p.kind}${p.isAsync ? ', async' : ''})`)
      );
      console.log();
      process.exit(0);
    }

    const result = imprint(scanPath, {
      projectRoot: process.cwd(),
      overwrite,
      verbose: false,
    });

    const { scan: scanResult, register: reg, conventions } = result;

    console.log(`  Scan path  : ${path.resolve(scanPath)}`);
    console.log(`  Files      : ${scanResult.filesScanned}`);
    console.log(`  Patterns   : ${scanResult.patterns.length}`);
    console.log();
    console.log(`  ✓ Written  : ${reg.written} local recalls`);
    if (reg.skipped)  console.log(`  – Skipped  : ${reg.skipped} (already exist — use --overwrite to force)`);
    if (reg.errors.length) {
      console.log(`  ✗ Errors   : ${reg.errors.length}`);
      reg.errors.forEach(e => console.log(`      ${e.pattern}: ${e.reason}`));
    }

    const conventionEntries = Object.entries(conventions);
    if (conventionEntries.length > 0) {
      console.log();
      console.log(`  Conventions extracted (${conventionEntries.length} slots):`);
      conventionEntries.forEach(([slot, value]) => {
        const display = value.length > 60 ? value.slice(0, 57) + '...' : value;
        console.log(`    ${slot.padEnd(22)} → ${display}`);
      });
      console.log(`  Written to strata/conventions.json`);
    }

    if (reg.written > 0) {
      console.log();
      console.log(`  Local recalls written to recalls/local/`);
      console.log(`  IDs use .local.v1 suffix — composable with the public library.`);
      console.log();
      console.log(`  To include them in retrieval, rebuild the index:`);
      console.log(`    npx ts-node scripts/generate-library-index.ts`);
    }

    console.log(`\n  ${line}\n`);

  } else if (subcommand === 'list') {
    const localDir = path.join(process.cwd(), 'recalls', 'local');
    if (!fs.existsSync(localDir)) {
      console.log('\n  No local recalls yet. Run: strata imprint scan <path>\n');
      process.exit(0);
    }

    const recalls: { id: string; domain: string; name: string }[] = [];
    function walkLocal(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { walkLocal(path.join(dir, entry.name)); continue; }
        if (entry.name !== 'metadata.json') continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
          recalls.push({ id: m.id, domain: m.domain, name: m.name });
        } catch { /* skip corrupt files */ }
      }
    }
    walkLocal(localDir);

    console.log(`\n  Local recalls (${recalls.length})\n`);
    recalls.forEach(r => console.log(`  ${r.id}`));
    console.log();

  } else if (subcommand === 'clean') {
    const localDir = path.join(process.cwd(), 'recalls', 'local');
    if (!fs.existsSync(localDir)) {
      console.log('\n  Nothing to clean.\n');
      process.exit(0);
    }
    fs.rmSync(localDir, { recursive: true, force: true });
    console.log('\n  ✓ recalls/local/ removed.\n');

  } else if (subcommand === 'conventions') {
    const conventionsPath = path.join(process.cwd(), 'strata', 'conventions.json');
    if (!fs.existsSync(conventionsPath)) {
      console.log('\n  No conventions yet. Run: strata imprint scan <path>\n');
      process.exit(0);
    }
    let conventions: Record<string, string>;
    try {
      conventions = JSON.parse(fs.readFileSync(conventionsPath, 'utf-8'));
    } catch {
      console.error('\n  Error reading conventions.json\n');
      process.exit(1);
    }
    const entries = Object.entries(conventions);
    console.log(`\n  Conventions (${entries.length} slots)\n`);
    for (const [slot, value] of entries) {
      const display = value.length > 70 ? value.slice(0, 67) + '...' : value;
      console.log(`  ${slot.padEnd(22)} ${display}`);
    }
    console.log();

  } else {
    console.log(`
Strata Imprint

  Scans your codebase, extracts reusable patterns, and registers them as
  private local recalls — composable alongside the public library.

Commands:
  strata imprint scan [path]            Scan codebase, register local recalls, extract conventions
  strata imprint scan [path] -f         Force overwrite existing recalls
  strata imprint scan [path] --dry-run  Preview patterns without writing
  strata imprint list                   List all registered local recalls
  strata imprint conventions            Show extracted conventions (strata/conventions.json)
  strata imprint clean                  Remove all local recalls

Examples:
  strata imprint scan ./src
  strata imprint scan ./src --overwrite
  strata imprint scan . --dry-run
`);
  }

// ─── help ─────────────────────────────────────────────────────────────────────

} else {
  animateBanner(() => {
    process.stdout.write(`Commands:
  strata install [--claude|--cursor|--windsurf|--vscode|--zed|--continue|--cline|--roo|--all]
                                              Register MCP server (auto-detects installed IDEs)
  strata install --global                     Enable Strata in all sessions (writes ~/.claude/CLAUDE.md)
  strata install --no-global                  Disable global activation
  strata config --no-telemetry                Disable usage data logging
  strata config --telemetry                   Re-enable usage data logging
  strata configure local                      Use your local recall library
  strata configure hub --url <u> --key <k>   Connect to a Strata Hub
  strata configure provider --provider <n> --key <k>
                                              Set LLM provider for recall decomposition
                                              Providers: anthropic · openai · deepseek · grok · kimi · gemini
  strata status                               Show current config
  strata logs                                 Show usage stats (tokens saved, time saved, call history)
  strata imprint scan [path]                  Scan codebase, register local recalls + extract conventions
  strata imprint conventions                  Show extracted project conventions
  strata imprint list                         List local recalls
  strata imprint clean                        Remove all local recalls
`);
  });
}
