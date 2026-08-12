#!/usr/bin/env node
'use strict';
/**
 * Instrument check for the pre-injection arm — run BEFORE spending anything on agent sessions.
 *
 * The arm is only meaningful if the tree it produces is (a) the real delivered bytes, (b) free of any
 * signal that they were generated, and (c) actually resolvable. A control that quietly fails any of
 * those measures nothing, and the failure would be invisible in the results.
 */
const fs = require('fs');
const path = require('path');
const { TASKS, prepareDir, ROOT } = require('../agent-bench.js');

const tasks = ['catalog', 'idempotency', 'retry', 'stripejune'];
let bad = 0;

for (const name of tasks) {
  const task = TASKS[name];
  if (!task) { console.log(`  ${name}: NOT A TASK`); bad++; continue; }

  let dir;
  try { dir = prepareDir(task, 'preinject', name); }
  catch (e) { console.log(`  ${name}: THREW — ${e.message}`); bad++; continue; }

  const lib = path.join(dir, 'src', 'lib', 'toolkit.js');
  const srcLib = path.join(ROOT, 'benchmark', 'runs', 'exp-quality', 'trees',
    `${name}-strata-haiku-1`, 'strata', 'lib.js');

  const checks = [];
  const exists = fs.existsSync(lib);
  checks.push(['toolkit.js written', exists]);

  let body = exists ? fs.readFileSync(lib, 'utf-8') : '';
  checks.push(['no provenance leak', exists && !/strata|recall/i.test(body)]);

  /**
   * Fidelity: the EXECUTABLE code must be untouched.
   *
   * Comments are deliberately edited (banner stripped, provenance vocabulary neutralised), so a raw
   * byte comparison would fail by design. What must hold is that no line of actual code changed —
   * otherwise this arm is running different software from the one it claims to compare against.
   */
  const codeLines = (s) => s.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

  if (exists && fs.existsSync(srcLib)) {
    const a = codeLines(fs.readFileSync(srcLib, 'utf-8'));
    const b = codeLines(body);
    const same = a.length === b.length && a.every((l, k) => l === b[k]);
    checks.push([`code lines identical (${a.length})`, same]);
    checks.push(['banner stripped', !body.startsWith('// Strata')]);
  }

  checks.push(['no strata/ directory', !fs.existsSync(path.join(dir, 'strata'))]);
  checks.push(['no .mcp.json', !fs.existsSync(path.join(dir, '.mcp.json'))]);
  checks.push(['no verify.js anywhere', !fs.existsSync(path.join(dir, 'strata', 'verify.js'))]);

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  const needsPino = /require\('pino'\)/.test(body);
  checks.push([needsPino ? 'pino declared' : 'pino not needed', needsPino ? !!(pkg.dependencies || {}).pino : true]);

  const readme = path.join(dir, 'README.md');
  checks.push(['documented in README', fs.existsSync(readme) && /toolkit\.js/.test(fs.readFileSync(readme, 'utf-8'))]);

  const failed = checks.filter(([, ok]) => !ok);
  const files = fs.readdirSync(dir).filter((f) => f !== 'node_modules');
  console.log(`\n  ${name}  ${failed.length ? 'FAIL' : 'ok'}   (${(body.length / 1024).toFixed(1)} KB injected)`);
  console.log('    tree: ' + files.join('  '));
  for (const [label, ok] of checks) console.log('      ' + (ok ? '✓' : '✗') + ' ' + label);
  if (failed.length) bad++;

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `\n  ${bad} task(s) FAILED — do not run the arm\n` : '\n  all tasks produce a valid pre-injected tree\n');
process.exit(bad ? 1 : 0);
