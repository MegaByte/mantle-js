// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacZoom — AAC's error against the exact cell coverage as the pixel shrinks under a curve (a zoom): pixels on the
// longest lines, quads, cubics and arcs of a drawing, each pixel's side set so the segment spans P pixels. Uniform scale
// leaves AAC unchanged (the fill data scaled with the pixel, test/_glslEmu.mjs scaleFillData); a zoom does not, and
// the float32 data itself bounds what any kernel can do there: the pixel-local transform (emPt - c) * px rounds each
// control point to an ulp of its distance from the pixel, P * 2^-24 px at this span. So an error that grows as P is
// the data's floor, and one that grows as P^2 is the kernel's. Each row prints the error in ulps of the span: flat down
// a column is at the floor. Lines, which do no curve math, show it.
//   node probes/fillperf/aacZoom.mjs [--glsl mantle.frag.glsl] [--svg a.svg,b.svg]
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
const M = await import('../../src/bundle/layout.js');
const { buildGlslEmu, fillShapes, K_AAC, AAC_HARD } = await import('../../test/_glslEmu.mjs');
const { decodeSegs, SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } =
  await import('../../src/hitTest/curveGeom.js');
const { cellCoverage } = await import('./cellCoverage.mjs');

const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const glsl = flag('glsl') ? readFileSync(flag('glsl'), 'utf8') : undefined;
const emu = buildGlslEmu(ROOT, { defines: AAC_HARD, ...(glsl ? { glsl } : {}) });
const FILES = flag(
  'svg',
  'examples/tiger.svg,examples/smoke/entryPointRoute__GLYPHS.svg,examples/smoke/aacBandLevels__SVG.svg,examples/_arcs_circle.svg,examples/smoke/aacClipConfound__AUTHORED.svg',
).split(',');

// a point on the segment at parameter u in [0, 1], and its span (the chord for a Bezier, the swept length for an arc)
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
for (const [t, name] of [
  [SEG_LINE, 'line'],
  [SEG_QUAD, 'quad'],
  [SEG_CUBIC, 'cubic'],
  [SEG_ARC, 'arc'],
]) {
  const segs = byType[t].sort((a, b) => b.L - a.L).slice(0, 40);
  if (!segs.length) {
    console.log(`${name}: none in ${FILES.join(', ')}`);
    continue;
  }
  console.log(
    `${name}: pixels on the ${segs.length} longest (${FILES.length} drawings), 15 a segment, |AAC - exact|`,
  );
  for (const P of [16, 64, 256, 1024, 4096, 16384]) {
    let worst = 0,
      sum = 0,
      n = 0;
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
          const c = [Math.fround(x + ox * e), Math.fround(y + oy * e)];
          qs.push({ k: K_AAC, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [e, e] });
          ex.push(cellCoverage(all, c, [e, e], sh.eo));
        }
      }
      const got = emu.run(data.band, data.curve, qs);
      for (let i = 0; i < qs.length; i++) {
        const d = Math.abs(got[i] - ex[i]);
        worst = Math.max(worst, d);
        sum += d;
        n++;
      }
    }
    const ulp = P * 2 ** -24; // one float32 ulp of the span, in pixels
    console.log(
      `  spans ${String(P).padStart(5)} px: mean ${(sum / n).toExponential(2)}, max ${worst.toExponential(2)}` +
        ` -- ${(sum / n / ulp).toFixed(2)} and ${(worst / ulp).toFixed(1)} ulps of the span`,
    );
  }
}
