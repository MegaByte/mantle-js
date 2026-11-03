// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// makeTextSvg — a TEXT-HEAVY SVG for the ray-lane timing A/B: Roboto glyph outlines (quads, as TrueType stores
// them) of a few lines of prose, one <path> per glyph, written to the path given. probes/shaderArmAB.mjs
// times SVGs, and the font path is not an SVG, so this carries the glyphs across. Node only, no GPU.
//
//   node probes/rayLanes/makeTextSvg.mjs /tmp/sr19-text.svg [lines=12]
//
// Needs test/font/fixtures/roboto-regular.ttf (`npm run fetch:fixtures`).
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2];
if (!out) {
  console.error('usage: node probes/rayLanes/makeTextSvg.mjs <out.svg> [lines]');
  process.exit(2);
}
const LINES = +(process.argv[3] || 12);
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { MantleFontAsset } = await import('../../src/index.js');
const { buildTextSections } = await import('../../src/font/textSections.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');

// A fill shape's curve records (svg/textures.js encodeSeg: a header texel, the data texels, a join texel) as
// path data. Glyph outlines are lines and quads; a record the reader does not know ends the shape.
function pathD(cv, begin, end) {
  let d = '',
    pen = null;
  const f = (v) => +v.toFixed(6);
  for (let h = begin; h + 8 <= end;) {
    const type = cv[h] & 3,
      a = h + 4;
    const p1 = [cv[a], cv[a + 1]],
      p2 = [cv[a + 2], cv[a + 3]];
    if (!pen || pen[0] !== p1[0] || pen[1] !== p1[1])
      d += `${d ? 'Z ' : ''}M${f(p1[0])} ${f(p1[1])} `;
    if (type === 0) {
      d += `L${f(p2[0])} ${f(p2[1])} `;
      pen = p2;
      h += 12;
    } else if (type === 1) {
      const p3 = [cv[a + 4], cv[a + 5]];
      d += `Q${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])} `;
      pen = p3;
      h += 16;
    } else if (type === 2) {
      const p3 = [cv[a + 4], cv[a + 5]],
        p4 = [cv[a + 6], cv[a + 7]];
      d += `C${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])} ${f(p4[0])} ${f(p4[1])} `;
      pen = p4;
      h += 16;
    } else break;
  }
  return d ? d + 'Z' : '';
}
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf'))),
);
const PROSE = [
  'Sphinx of black quartz, judge my vow; the five boxing wizards jump quickly.',
  'Pack my box with five dozen liquor jugs -- 0123456789 (#@&%?!) grumbled Zoe.',
];
const text = Array.from({ length: LINES }, (_, i) => PROSE[i % 2]).join('\n');
const { sections: sec, bundleSrc } = await buildTextSections(font, text, {
  fontSize: 32,
  fill: [0, 0, 0, 1],
});
const curve = new Float32Array(sec.curves),
  pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const ranges = sec.curveRangesByShape || [];
let body = '',
  n = 0;
for (let s = 0; s < pm.numShapes; s++) {
  const r = ranges[s];
  if (!r || !(pm.metaFloats[s * pm.floatsPerShape + 7] > 0)) continue;
  const d = pathD(curve, r.begin, r.end);
  if (d) {
    body += `<path d="${d}"/>\n`;
    n++;
  }
}
const [x, y, w, h] = bundleSrc.globalBBox;
writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}">\n${body}</svg>\n`,
);
console.log(
  `wrote ${out}: ${n} glyph paths, ${LINES} lines, viewBox ${[x, y, w, h].map((v) => +v.toFixed(3)).join(' ')}`,
);
