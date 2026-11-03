// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textStrokeTransformSmoke — a <text> stroke takes its element's transform as a shape's does.
//
// THE HAZARD. The glyphs of a <text> are baked into document space by the CTM, so an unscaled stroke-width would draw
// a 3-wide stroke 3 wide under scale(2), and under scale(2 1.5) too, where SVG draws the transformed stroke -- 6 wide,
// and 6 across a vertical stem and 4.5 across a horizontal bar.
//
// The glyph stroke takes the conformal rule: a conformal CTM scales the width by its one scale, any other draws the row in
// stroke space through the frame N (bundle/strokeFrame.js).
//
// A stroked Arial "A" (two closed contours of lines and quads, miter joins at limit 4) under identity, scale(2),
// rotate(30) scale(2), scale(2 1.5), skewX(30) and rotate(30) scale(3 1). The reference is exact: SVG 2's stroke of the
// glyph's LOCAL contours (read off the identity import) at the authored half-width, the query point mapped back. The
// renderer side is the shipped walk in float32 (test/_glslEmu.mjs), read as membership, and the hit test; points within
// 1% of a half-width of the outline are skipped.
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { svgInsideGeneric, cubicSegs } from './_strokeCubicArcRef.mjs';
import { fillHitShape, HitMode } from '../src/hitTest/index.js';
import { curveView, curveRangesOf, decodeSegs } from '../src/hitTest/curveGeom.js';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { buildSvgTextGlyphs } = await import('../src/font/textRun.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (!existsSync(FONT)) {
  console.log(`  SKIPPED: ${FONT} is absent`);
  process.exit(77);
}
const arial = new MantleFontAsset(new Uint8Array(readFileSync(FONT)));
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const D2R = Math.PI / 180;
const mm = (P, Q) => [
  P[0] * Q[0] + P[2] * Q[1],
  P[1] * Q[0] + P[3] * Q[1],
  P[0] * Q[2] + P[2] * Q[3],
  P[1] * Q[2] + P[3] * Q[3],
];
const rot = (d) => [Math.cos(d * D2R), Math.sin(d * D2R), -Math.sin(d * D2R), Math.cos(d * D2R)];
const CARRIERS = [
  ['identity', [1, 0, 0, 1]],
  ['scale(2)', [2, 0, 0, 2]],
  ['rotate(30) scale(2)', mm(rot(30), [2, 0, 0, 2])],
  ['scale(2 1.5)', [2, 0, 0, 1.5]],
  ['skewX(30)', [1, 0, Math.tan(30 * D2R), 1]],
  ['rotate(30) scale(3 1)', mm(rot(30), [3, 0, 0, 1])],
];
const W = 3,
  T = [150, 150];
const svgOf = (t) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">` +
  `<g transform="translate(${T[0]} ${T[1]})${t === 'identity' ? '' : ' ' + t}"><text x="-16" y="16" font-family="Arial" font-size="44" fill="none" stroke="#000" stroke-width="${W}">A</text></g></svg>`;
const opts = { preserveViewport: true, fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs };

/// The stroke row of a one-glyph bundle, and its decoded segments.
function strokeRowOf(b) {
  const meta = new Float32Array(b.meta, 32);
  for (let i = 0; i * 48 < meta.length; i++)
    if (meta[i * 48 + 12] > 0) return { i, o: i * 48, meta };
  throw new Error('no stroke row');
}
// the glyph's LOCAL contours, from the identity import (document space is the text's own space there)
const b0 = await importSvg(svgOf('identity'), opts);
const r0 = strokeRowOf(b0);
const segs0 = decodeSegs(
  curveView(b0),
  ...(() => {
    const rg = curveRangesOf(b0, r0.meta, b0.numShapes, 48, curveView(b0).length)[r0.i];
    return [rg.begin, rg.end];
  })(),
);
// each contour as a chain of CUBICS (a line and a quad elevated exactly), the reference's closed-chain form
const contours = [];
for (const s of segs0) {
  if (s.f) continue;
  const a = [s.x0 - T[0], s.y0 - T[1]],
    e = [s.x1 - T[0], s.y1 - T[1]];
  const lerp = (u, v, t) => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t];
  const cub =
    s.t === 1
      ? (() => {
          const c = [s.cx - T[0], s.cy - T[1]];
          return [a, lerp(a, c, 2 / 3), lerp(e, c, 2 / 3), e];
        })()
      : [a, lerp(a, e, 1 / 3), lerp(a, e, 2 / 3), e];
  const cur = contours[contours.length - 1],
    last = cur && cur[cur.length - 1][3];
  if (cur && Math.hypot(last[0] - a[0], last[1] - a[1]) < 1e-4) cur.push(cub);
  else contours.push([cub]);
}
ok(
  contours.length === 2 && segs0.every((s) => s.t <= 1),
  `the glyph is ${contours.length} closed contours of lines and quads (want 2 -- the test's premise)`,
);
const chains = contours.map((C) => cubicSegs(C, true));
const inside = (p, h) => chains.some((S) => svgInsideGeneric(p, S, true, h, 0, 0, 4));

const emu = EMU.hasCxx() ? EMU.buildGlslEmu(ROOT, { stroke: true }) : null;
for (const [t, M] of CARRIERS) {
  const b = await importSvg(svgOf(t), opts);
  const { o, meta } = strokeRowOf(b),
    m = (k) => meta[o + k];
  const framed = (Math.round(m(27)) & 4) !== 0;
  const pts = [],
    want = [];
  for (let y = -22; y <= 22; y += 0.37)
    for (let x = -20; x <= 20; x += 0.37) {
      const a = inside([x, y], (W / 2) * 0.99),
        c = inside([x, y], (W / 2) * 1.01);
      if (a !== c) continue;
      pts.push([T[0] + M[0] * x + M[2] * y, T[1] + M[1] * x + M[3] * y]);
      want.push(a);
    }
  let hitBad = 0,
    rendBad = 0;
  pts.forEach((p, k) => {
    if (fillHitShape(b, p[0], p[1], { mode: HitMode.Outline }) >= 0 !== want[k]) hitBad++;
  });
  if (emu) {
    const cap = m(24) | 0,
      endEnc = Math.round(m(46)) | 0;
    const GD = [m(16) | 0, m(17) | 0, m(18) | 0, m(19) | 0],
      bb = [m(0), m(1), m(2), m(3)],
      hw = m(12) * 0.5;
    const qs = [];
    for (const p of pts)
      for (const which of [0, 3]) {
        const ex = [hw, m(26), cap, endEnc === 0 ? cap : endEnc - 1, m(25) | 0, 0, 1, which];
        if (framed)
          qs.push({
            k: EMU.K_STROKE_LOCAL,
            GD,
            bb,
            c: p,
            ePx: [0.1, 0.1],
            ex: [...ex, m(20), m(21), m(22), m(23)],
          });
        else
          qs.push({
            k: EMU.K_STROKE_WALK,
            GD,
            bb,
            c: p,
            ePx: [0.1, 0.1],
            ex: [...ex.slice(0, 7), 0, -1e20],
          });
      }
    const out = emu.run(new Float32Array(b.bands), new Float32Array(b.curves), qs);
    pts.forEach((_, k) => {
      const d = out[2 * k],
        h = framed ? out[2 * k + 1] : hw;
      if (d <= h !== want[k]) rendBad++;
    });
  }
  ok(
    hitBad === 0 && rendBad === 0,
    `${t}: width ${((2 * m(12)) / 2).toFixed(3)}${framed ? ' in stroke space' : ''}; of ${pts.length} points clear of the local outline, the renderer's walk puts ${emu ? rendBad : '(skipped)'} and the hit test ${hitBad} on the wrong side`,
  );
}
console.log(fail ? `TEXT-STROKE-TRANSFORM FAIL (${fail})` : 'TEXT-STROKE-TRANSFORM PASS');
process.exit(fail ? 1 : 0);
