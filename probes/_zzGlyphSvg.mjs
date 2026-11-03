// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzGlyphSvg — a font's glyphs as an SVG, so the engine comparison can be pointed at TEXT.
//
// The fill engines are compared on tiger because tiger is what the metrics were built around, and
// text is a different problem: stems that must stay even, counters a pixel or two across, and
// diagonals that stair-step visibly at reading sizes. buildSvgTextGlyphs already hands back the
// same segment form the SVG importer produces, so the whole comparison -- exact box-coverage
// reference included -- works on glyphs without a second harness.
import { readFileSync, writeFileSync } from 'fs';
import { MantleFontAsset } from '../src/font/index.js';
import { buildSvgTextGlyphs } from '../src/font/textRun.js';

const FONT = process.env.FONT;
if (!FONT) {
  console.error('FONT=<font file> is required');
  process.exit(2);
}
const TEXT = process.env.TEXT || 'NAWMgo8';
const SIZE = +(process.env.SIZE || 64);
const OUT = process.env.OUT || '/tmp/glyphs.svg';
const PAD = +(process.env.PAD || 8);

const font = new MantleFontAsset(new Uint8Array(readFileSync(FONT)));
const run = buildSvgTextGlyphs(TEXT, font, 0, 0, SIZE);

const num = (v) => (Math.round(v * 1000) / 1000).toString();
/// segs -> one path `d`. A contour starts wherever a segment does not continue the previous one,
/// which is how this form encodes them -- there is no explicit close flag to read.
function toPath(segs, dx, dy) {
  let d = '',
    cx = NaN,
    cy = NaN;
  const P = (p) => `${num(p[0] + dx)} ${num(p[1] + dy)}`;
  for (const s of segs) {
    const a = s.p1;
    if (!(Math.abs(a[0] - cx) < 1e-9 && Math.abs(a[1] - cy) < 1e-9)) {
      if (d) d += 'Z ';
      d += `M ${P(a)} `;
    }
    if (s.p4) {
      d += `C ${P(s.p2)} ${P(s.p3)} ${P(s.p4)} `;
      cx = s.p4[0];
      cy = s.p4[1];
    } else if (s.p3) {
      d += `Q ${P(s.p2)} ${P(s.p3)} `;
      cx = s.p3[0];
      cy = s.p3[1];
    } else {
      d += `L ${P(s.p2)} `;
      cx = s.p2[0];
      cy = s.p2[1];
    }
  }
  return d ? d + 'Z' : '';
}

let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
const paths = [];
for (const g of run.glyphs) {
  if (!g.segs || !g.segs.length) continue;
  const dx = g.penX || 0;
  for (const s of g.segs)
    for (const p of [s.p1, s.p2, s.p3, s.p4]) {
      if (!p) continue;
      x0 = Math.min(x0, p[0] + dx);
      x1 = Math.max(x1, p[0] + dx);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  paths.push(toPath(g.segs, dx, 0));
}
const w = x1 - x0 + 2 * PAD,
  h = y1 - y0 + 2 * PAD;
const sx = PAD - x0,
  sy = PAD - y0;
const body = paths
  .map((d, i) => {
    // Shifted into the viewBox by translating the path data itself, so the importer sees plain
    // coordinates and no transform stack -- the reference reads the same numbers the engines do.
    const shifted = d.replace(
      /(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g,
      (_, a, b) => `${num(+a + sx)} ${num(+b + sy)}`,
    );
    return `  <path d="${shifted}" fill="#000"/>`;
  })
  .join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}">
  <rect x="0" y="0" width="${num(w)}" height="${num(h)}" fill="#fff"/>
${body}
</svg>
`;
writeFileSync(OUT, svg);
console.log(
  `${run.glyphs.length} glyphs, ${paths.length} paths, viewBox ${num(w)}x${num(h)} -> ${OUT}`,
);
