#!/usr/bin/env node
'use strict';
/**
 * Turn a run directory (benchmark/runs/<timestamp>/) into a readable report FOLDER:
 *   REPORT.md           — the summary table, hard-vs-commodity split, and the verdict
 *   <task>.md           — per task: both arms, turns/cost/tokens, delivered recalls, verify result,
 *                         and each arm's final reasoning summary
 *   <task>-<arm>.log    — copied raw transcript (full thinking/tool history)
 *
 * Usage: node benchmark/report.js benchmark/runs/<timestamp> [outDir]
 */
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2];
if (!runDir || !fs.existsSync(runDir)) { console.error('usage: report.js <runDir> [outDir]'); process.exit(1); }
const outDir = process.argv[3] || path.join(runDir, 'REPORT');
fs.mkdirSync(outDir, { recursive: true });

const TIER = { securepw: 'hard', auth: 'hard', oauth: 'hard', rbac: 'hard', idempotency: 'hard',
  catalog: 'commodity', search: 'commodity', publicapi: 'commodity', export: 'commodity',
  validation: 'commodity', retry: 'commodity', megabuild: 'kitchen-sink' };

const runs = fs.readdirSync(runDir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')));

const tasks = [...new Set(runs.map(r => r.task))].sort((a, b) =>
  (TIER[a] || 'z').localeCompare(TIER[b] || 'z') || a.localeCompare(b));

const pct = (b, s) => (b > 0 ? Math.round(((s - b) / b) * 100) : null);
const rows = [];

for (const task of tasks) {
  const b = runs.find(r => r.task === task && r.arm === 'baseline' && r.ok && r.armValid);
  const s = runs.find(r => r.task === task && r.arm === 'strata' && r.ok && r.armValid);
  const tier = TIER[task] || '?';

  // per-task page
  const lines = [`# ${task}  (${tier})`, ''];
  for (const [label, run] of [['BASELINE', b], ['STRATA', s]]) {
    lines.push(`## ${label}`);
    if (!run) { lines.push('_no valid run (rate-limited or non-attempt)_', ''); continue; }
    lines.push(`- turns: **${run.turns}**   cost: **$${(run.costUsd || 0).toFixed(2)}**   files added: ${run.work && run.work.filesAdded}`);
    lines.push(`- tokens: ${(run.cacheReadTokens || 0).toLocaleString()} cache-read · ${run.outputTokens} output`);
    if (label === 'STRATA') {
      lines.push(`- strata_use calls: ${run.strataCalls}`);
      lines.push(`- recalls delivered: ${(run.deliveredRecalls || []).join(', ') || '(none / declined)'}`);
      lines.push(`- verify.js result: ${run.verifyResult || '?'}`);
    }
    lines.push('', '**model’s closing summary:**', '```', (run.finalSummary || '').slice(0, 1200), '```', '');
    // copy the transcript
    const src = path.join(runDir, `${task}-${run.arm}-${run.run}.log`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, `${task}-${run.arm}.log`));
  }
  fs.writeFileSync(path.join(outDir, `${task}.md`), lines.join('\n'));

  rows.push({ task, tier,
    bt: b && b.turns, st: s && s.turns, bc: b && b.costUsd, sc: s && s.costUsd,
    delta: (b && s) ? pct(b.costUsd, s.costUsd) : null,
    delivered: s ? (s.deliveredRecalls || []).length : 0,
    verify: s ? s.verifyResult : '' });
}

// summary
const md = ['# Benchmark report', '', `Run dir: \`${runDir}\``, `Generated: ${new Date().toISOString()}`, '',
  '**Cost is the API-equivalent dollar figure Claude Code reports (turns × context). Lower is better.**',
  '**Δ = strata vs baseline; negative = Strata cheaper (a WIN).**', '',
  '| task | tier | turns b→s | cost b→s | Δ | recalls | verify |',
  '|---|---|---|---|---|---|---|'];
for (const r of rows) {
  const d = r.delta === null ? '—' : (r.delta > 0 ? `+${r.delta}%` : `${r.delta}%`);
  md.push(`| ${r.task} | ${r.tier} | ${r.bt ?? '—'}→${r.st ?? '—'} | `
    + `$${r.bc != null ? r.bc.toFixed(2) : '—'}→$${r.sc != null ? r.sc.toFixed(2) : '—'} | **${d}** | ${r.delivered} | ${r.verify || '—'} |`);
}
// tier rollup
const roll = (tier) => {
  const rs = rows.filter(r => r.tier === tier && r.delta !== null);
  if (!rs.length) return `${tier}: no complete pairs`;
  const wins = rs.filter(r => r.delta < 0).length;
  const med = rs.map(r => r.delta).sort((a, b) => a - b)[Math.floor(rs.length / 2)];
  return `**${tier}**: ${wins}/${rs.length} wins, median Δ ${med > 0 ? '+' : ''}${med}%`;
};
md.push('', '## By tier', '', roll('hard'), '', roll('commodity'), '', roll('kitchen-sink'), '',
  '_The thesis: Strata wins on HARD capabilities (secure auth, oauth, rbac, idempotency) and loses on',
  'COMMODITY plumbing the model already writes correctly. Compare the two tier rows above._');
fs.writeFileSync(path.join(outDir, 'REPORT.md'), md.join('\n'));

console.log('report written to', outDir);
console.log(md.slice(6).join('\n'));
