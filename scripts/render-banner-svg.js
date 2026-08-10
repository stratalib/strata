#!/usr/bin/env node
'use strict';
/**
 * Render the CLI's braille banner to SVG, from the CLI's own output.
 *
 * The banner is 222 columns wide and colour-coded with 24-bit ANSI. Neither survives a README: GitHub
 * strips ANSI inside a code fence, so it would render monochrome, and 222 columns wraps at any sane
 * content width, which turns the artwork into noise.
 *
 * So: capture what `strata --help` actually prints, parse the ANSI, and draw it.
 *
 * DOTS, NOT TEXT. Each braille cell is decoded from its codepoint into individual filled dots rather
 * than emitted as a character. Braille glyph coverage is not guaranteed in whatever font a viewer's
 * browser picks, and a missing glyph renders as a row of tofu boxes — a logo that breaks on someone
 * else's machine is worse than no logo. Circles always draw.
 *
 *   node scripts/render-banner-svg.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Braille cell bit → (col, row) in the 2×4 matrix. U+2800 + bits. */
const DOTS = [
  [0, 0], [0, 1], [0, 2],   // bits 0,1,2  → left column, rows 0-2
  [1, 0], [1, 1], [1, 2],   // bits 3,4,5  → right column, rows 0-2
  [0, 3], [1, 3],           // bits 6,7    → bottom row
];

function capture() {
  // The banner prints on the help path. Run the built CLI directly so this works from a checkout.
  const bin = path.join(ROOT, 'dist', 'bin', 'strata.js');
  const out = execFileSync(process.execPath, [bin, '--help'], {
    encoding: 'utf-8', timeout: 60_000, env: { ...process.env, FORCE_COLOR: '3' },
  });
  return out.split('\n');
}

/** Split a line into runs of { text, color } by walking its ANSI escapes. */
function parseAnsi(line) {
  const runs = [];
  let color = null, i = 0, buf = '';
  const push = () => { if (buf) { runs.push({ text: buf, color }); buf = ''; } };
  while (i < line.length) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end === -1) { buf += line[i++]; continue; }
      const code = line.slice(i + 2, end);
      push();
      const rgb = /^38;2;(\d+);(\d+);(\d+)$/.exec(code);
      if (rgb) color = `rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
      else if (code === '0' || code === '') color = null;
      else if (code === '2') color = 'dim';
      i = end + 1;
      continue;
    }
    buf += line[i++];
  }
  push();
  return runs;
}

const lines = capture();
// Keep only the artwork: lines that actually contain braille.
const art = lines.filter(l => /[⠀-⣿]/.test(l));
if (!art.length) { console.error('no braille found in CLI output'); process.exit(1); }
const tagline = lines.find(l => /in the library/.test(l)) || '';

const CELL_W = 7.0, CELL_H = 14.0;      // one braille cell
const DX = CELL_W / 2, DY = CELL_H / 4; // dot pitch: 2 across, 4 down. Must divide the cell exactly.
const DOT = 2.6;                        // square side — squares read crisper than circles at this scale
const PAD = 26;

const cols = Math.max(...art.map(l => l.replace(/\x1b\[[0-9;]*m/g, '').length));
const W = Math.round(cols * CELL_W + PAD * 2);
const H = Math.round(art.length * CELL_H + PAD * 2);

let dots = '';
art.forEach((line, row) => {
  let col = 0;
  for (const run of parseAnsi(line)) {
    for (const ch of run.text) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x2800 && cp <= 0x28FF) {
        const bits = cp - 0x2800;
        for (let b = 0; b < 8; b++) {
          if (!(bits & (1 << b))) continue;
          const [dc, dr] = DOTS[b];
          const x = PAD + col * CELL_W + dc * DX + (DX - DOT) / 2;
          const y = PAD + row * CELL_H + dr * DY + (DY - DOT) / 2;
          dots += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${DOT}" height="${DOT}" fill="${run.color && run.color !== 'dim' ? run.color : '#6B7681'}"/>`;
        }
      }
      col++;
    }
  }
});

/**
 * Crop to the INK, then pad evenly.
 *
 * The artwork does not begin at column zero — the logo carries leading blank braille cells and every
 * row is space-padded to a common width. Framing on the nominal grid therefore left ~44px of dead
 * space on the left against ~26px on the right, and a lopsided margin reads as a badly cropped image
 * rather than as a logo. Measuring what was actually drawn is the only framing that stays correct if
 * the banner art ever changes.
 */
const ink = [...dots.matchAll(/x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  .map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
const minX = Math.min(...ink.map(r => r.x));
const minY = Math.min(...ink.map(r => r.y));
const maxX = Math.max(...ink.map(r => r.x + r.w));
const maxY = Math.max(...ink.map(r => r.y + r.h));
const vx = +(minX - PAD).toFixed(1), vy = +(minY - PAD).toFixed(1);
const vw = +((maxX - minX) + PAD * 2).toFixed(1), vh = +((maxY - minY) + PAD * 2).toFixed(1);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="Strata">
  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10" fill="#16181C"/>
  ${dots}
</svg>
`;

fs.mkdirSync(path.join(ROOT, 'docs', 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'assets', 'banner.svg'), svg);
console.log(`wrote docs/assets/banner.svg — ${vw}x${vh} (cropped to ink), ${art.length} rows`);
