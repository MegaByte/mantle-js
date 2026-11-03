// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacZoomSmoke — AAC stays at the float32 floor under a zoom, through the float32 emulation of the shipped
// fill shader (test/_glslEmu.mjs).
//
// A uniform scale leaves AAC's answer unchanged; a zoom does not. The pixel-local transform rounds every control point to
// an ulp of its distance from the pixel, P * 2^-24 px when a segment spans P pixels, so an error that grows as P is the
// data's floor. Zone integrals taken as F(b) - F(a) of an antiderivative grow as P^2 (its terms are O(P^2) at every
// point, for a zone worth O(1)): at a 4096 px span that is 0.61 of a pixel on quads, 0.64 on cubics and 0.125 on arcs
// (2486, 2616 and 511 ulps of the span). So quads and cubics integrate each zone by 3-point Gauss on the zone, and arcs take
// each difference of sines and cosines as a product; every type stays within a few ulps of the span at any P.
//   Pixels on the 8 longest segments of each type, 15 per segment, the pixel's side set so the segment spans P pixels,
//   against the exact cell coverage (probes/fillperf/cellCoverage.mjs, f64): the max error at P = 256, 4096 and 16384
//   is under 4 ulps of the span (the shipped text: at most 2.6), and lines -- no curve math -- are the floor it is
//   measured against.
//   node test/aacZoomSmoke.mjs [--glsl path.frag.glsl]   (another shader text, to see it fail)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_AAC, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP aacZoomSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs, SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } =
  await import('../src/hitTest/curveGeom.js');
const { cellCoverage } = await import('../probes/fillperf/cellCoverage.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const gi = process.argv.indexOf('--glsl');
const glsl = gi > 0 ? readFileSync(process.argv[gi + 1], 'utf8') : null;
const emu = buildGlslEmu(ROOT, { defines: AAC_HARD, glsl });
const FILES = [
  'examples/tiger.svg',
  'examples/smoke/entryPointRoute__GLYPHS.svg',
  'examples/_arcs_circle.svg',
  'examples/smoke/aacClipConfound__AUTHORED.svg',
];

function at(s, u) {
  if (s.t === SEG_LINE) return [s.x0 + u * (s.x1 - s.x0), s.y0 + u * (s.y1 - s.y0)];
  if (s.t === SEG_QUAD) {
    const v = 1 - u;
    return [
      v * v * s.x0 + 2 * v * u * s.cx + u * u * s.x1,
      v * v * s.y0 + 2 * v * u * s.cy + u * u * s.y1,
    ];
  }
  if (s.t === SEG_CUBIC) {
    const v = 1 - u;
    return [
      v * v * v * s.x0 + 3 * v * v * u * s.c1x + 3 * v * u * u * s.c2x + u * u * u * s.x1,
      v * v * v * s.y0 + 3 * v * v * u * s.c1y + 3 * v * u * u * s.c2y + u * u * u * s.y1,
    ];
  }
  const th = s.th0 + u * (s.th1 - s.th0),
    ex = s.rx * Math.cos(th),
    ey = s.ry * Math.sin(th);
  return [s.cx + ex * s.cp - ey * s.sp, s.cy + ex * s.sp + ey * s.cp];
}
const span = (s) =>
  s.t === SEG_ARC
    ? Math.max(s.rx, s.ry) * Math.abs(s.th1 - s.th0)
    : Math.hypot(s.x1 - s.x0, s.y1 - s.y0);

const byType = { [SEG_LINE]: [], [SEG_QUAD]: [], [SEG_CUBIC]: [], [SEG_ARC]: [] };
for (const f of FILES) {
  const b = await importSvg(readFileSync(path.join(ROOT, f), 'utf8'), { preserveViewport: true });
  const data = { band: new Float32Array(b.bands), curve: new Float32Array(b.curves) };
  for (const sh of fillShapes(b, parseMetaBin, M)) {
    const segs = decodeSegs(data.curve, sh.range.begin, sh.range.end);
    for (const s of segs)
      if (byType[s.t] && !s.f && span(s) > 0) byType[s.t].push({ data, sh, segs, s, L: span(s) });
  }
}
const BOUND = 4; // ulps of the span
for (const [t, name] of [
  [SEG_LINE, 'line'],
  [SEG_QUAD, 'quad'],
  [SEG_CUBIC, 'cubic'],
  [SEG_ARC, 'arc'],
]) {
  const segs = byType[t].sort((a, b) => b.L - a.L).slice(0, 8);
  ok(segs.length >= 4, `${name}: ${segs.length} segments to zoom into`);
  for (const P of [256, 4096, 16384]) {
    let worst = 0;
    for (const { data, sh, segs: all, s, L } of segs) {
      const e = L / P,
        qs = [],
        ex = [];
      for (const u of [0.23, 0.37, 0.5, 0.61, 0.77]) {
        const [x, y] = at(s, u);
        for (const [ox, oy] of [
          [0, 0],
          [0.31, -0.17],
          [-0.29, 0.23],
        ]) {
          const c = [Math.fround(x + ox * e), Math.fround(y + oy * e)],
            ee = Math.fround(e);
          qs.push({ k: K_AAC, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [ee, ee] });
          ex.push(cellCoverage(all, c, [ee, ee], sh.eo));
        }
      }
      const got = emu.run(data.band, data.curve, qs);
      for (let i = 0; i < qs.length; i++) worst = Math.max(worst, Math.abs(got[i] - ex[i]));
    }
    const ulps = worst / (P * 2 ** -24);
    ok(
      ulps < BOUND,
      `${name} spanning ${P} px: max |AAC - exact| ${worst.toExponential(2)} = ${ulps.toFixed(1)} ulps of the span (< ${BOUND})`,
    );
  }
}
console.log(fail ? `AAC-ZOOM FAIL (${fail})` : 'AAC-ZOOM PASS');
process.exit(fail ? 1 : 0);
