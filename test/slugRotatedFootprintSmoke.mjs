// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugRotatedFootprintSmoke — Slug's edge AA under a rotated, skewed or mirrored draw.
//
// A ray kernel that takes its pixel as the fragment's fwidth box, |dFdx| + |dFdy| per em axis, is right only when em and
// device axes agree. At 30 degrees that box is 1.37x the pixel on each side and still upright, and the mean edge error
// goes from 0.3/255 at identity to 15/255. mantle.frag hands the main Slug fill the em -> device-pixel map
// itself (renderFillM), the inverse of the same signed derivatives, made orientation-preserving; each ray is scaled
// by its run inside the real pixel and the secant, corner clip and local curve are clipped against the real pixel
// (_coverage.glsl, THE PIXEL AS EM SEES IT). Through the shipped shader text in float32 (test/_glslEmu.mjs), against
// the exact coverage of the device pixel pulled back through the map (probes/fillperf/cellCoverage.mjs):
//   (a) the axis-aligned map is renderFill exactly: renderFillM with (px.x, 0), (0, px.y) equals renderFill bit for
//       bit at every boundary pixel of the test art, at identity and under an anisotropic scale;
//   (b) under rotations of 7, 30 and 45 degrees, a 30-degree skew and a mirrored rotation, Slug's mean edge error is
//       under 3.25/255 (the fwidth box reads 5-17/255, which the same run measures). The reference reads an arc's
//       STORED ends, so the art's near-full circles close on their closing line's vertex; ends rebuilt from the center
//       form would leave the contour open by 7.7e-5 em and add pixels with a coverage a hair inside (0, 1) -- "boundary"
//       pixels with almost no error, diluting the mean;
//   (c) mantle.frag derives the map from the signed derivatives in uniform control flow, takes invPx exactly on the
//       diagonal, reflects a mirrored map, and passes it to both of the main fill's Slug calls -- in a MANTLE_ROTATED_MAP
//       program only (an axis-aligned draw's program calls renderFill with invPx, since the map's presence cost
//       axis-aligned text 1.16-1.19x on the GPU).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  K_SLUG,
  K_SLUG_M,
  emuContractDefault,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP slugRotatedFootprintSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M_ = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { cellCoverageMap } = await import('../probes/fillperf/cellCoverage.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
// the map is taken only in a MANTLE_ROTATED_MAP program; `plain` is the axis-aligned program, whose renderFill
// must be the rotated program's renderFillM with the axis-aligned map, bit for bit
const emu = buildGlslEmu(ROOT, { defines: ['MANTLE_ROTATED_MAP'] }),
  plain = buildGlslEmu(ROOT, { defines: [] });

const wrap = (d, eo) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path ${eo ? 'fill-rule="evenodd" ' : ''}d="${d}" fill="#000"/></svg>`;
const ART = [
  wrap('M 500 180 a 320 320 0 1 0 0.1 0 Z'),
  wrap('M 500 180 a 260 320 0 1 0 0.1 0 Z M 500 330 a 140 170 0 1 1 -0.1 0 Z', true),
  wrap(
    'M 500 120 L 590 390 L 870 390 L 645 560 L 730 840 L 500 670 L 270 840 L 355 560 L 130 390 L 410 390 Z',
  ),
  wrap(
    'M 700 300 C 700 150 300 150 300 330 C 300 470 700 470 700 640 C 700 830 300 830 300 680 L 380 660 C 400 740 620 740 620 640 C 620 540 240 540 240 340 C 240 110 760 110 760 300 Z',
  ),
];
const rot = (deg) => {
  const t = (deg * Math.PI) / 180;
  return [
    [Math.cos(t), -Math.sin(t)],
    [Math.sin(t), Math.cos(t)],
  ];
};
const MAPS = {
  identity: [
    [1, 0],
    [0, 1],
  ],
  'scale 0.9 x 0.45': [
    [0.9, 0],
    [0, 0.45],
  ],
  'rotate 7': rot(7),
  'rotate 30': rot(30),
  'rotate 45': rot(45),
  'skewX 30': [
    [1, Math.tan(Math.PI / 6)],
    [0, 1],
  ],
  'rotate 30 mirrored': [
    [-Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)],
    [-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)],
  ],
};
const PX = 64;

const loaded = [];
for (const svg of ART) {
  const b = await importSvg(svg, { preserveViewport: true });
  const shapes = fillShapes(b, parseMetaBin, M_),
    curve = new Float32Array(b.curves);
  for (const sh of shapes) sh.segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  let ext = 0;
  for (const s of shapes) ext = Math.max(ext, s.bb[2] - s.bb[0], s.bb[3] - s.bb[1]);
  loaded.push({ shapes, band: new Float32Array(b.bands), curve, ext });
}

const res = {};
for (const [name, L] of Object.entries(MAPS)) {
  const r = (res[name] = { n: 0, fw: 0, map: 0, same: 0, plainSame: 0 });
  for (const { shapes, band, curve, ext } of loaded) {
    const s = PX / ext,
      M = [
        [L[0][0] * s, L[0][1] * s],
        [L[1][0] * s, L[1][1] * s],
      ];
    const det0 = M[0][0] * M[1][1] - M[0][1] * M[1][0],
      J = [
        [M[1][1] / det0, -M[0][1] / det0],
        [-M[1][0] / det0, M[0][0] / det0],
      ];
    // the fragment's signed derivatives, fwidth, and mantle.frag's map from them
    const emDx = [J[0][0], J[1][0]],
      emDy = [J[0][1], J[1][1]];
    const fw = [Math.abs(emDx[0]) + Math.abs(emDy[0]), Math.abs(emDx[1]) + Math.abs(emDy[1])];
    const invPx = [Math.fround(1 / Math.fround(fw[0])), Math.fround(1 / Math.fround(fw[1]))]; // the shader's float32 1 / fwidth
    let mx = [invPx[0], 0],
      my = [0, invPx[1]];
    if (emDx[1] !== 0 || emDy[0] !== 0) {
      const det = emDx[0] * emDy[1] - emDy[0] * emDx[1];
      mx = [emDy[1] / det, -emDx[1] / det];
      my = [-emDy[0] / det, emDx[0] / det];
      if (det < 0) {
        mx[1] = -mx[1];
        my[1] = -my[1];
      }
    }
    for (const sh of shapes) {
      const cs = [
        [sh.bb[0], sh.bb[1]],
        [sh.bb[2], sh.bb[1]],
        [sh.bb[0], sh.bb[3]],
        [sh.bb[2], sh.bb[3]],
      ].map((p) => [M[0][0] * p[0] + M[0][1] * p[1], M[1][0] * p[0] + M[1][1] * p[1]]);
      const qs = [],
        ex = [];
      for (
        let j = Math.floor(Math.min(...cs.map((p) => p[1]))) - 2;
        j <= Math.ceil(Math.max(...cs.map((p) => p[1]))) + 2;
        j++
      )
        for (
          let i = Math.floor(Math.min(...cs.map((p) => p[0]))) - 2;
          i <= Math.ceil(Math.max(...cs.map((p) => p[0]))) + 2;
          i++
        ) {
          const c = [
            J[0][0] * (i + 0.5) + J[0][1] * (j + 0.5),
            J[1][0] * (i + 0.5) + J[1][1] * (j + 0.5),
          ];
          const e = cellCoverageMap(sh.segs, c, M, sh.eo);
          if (!(e > 1e-9 && e < 1 - 1e-9)) continue;
          qs.push({
            GD: sh.GD,
            bb: sh.bb,
            eo: sh.eo,
            c: [Math.fround(c[0]), Math.fround(c[1])],
            ePx: fw,
          });
          ex.push(e);
        }
      if (!qs.length) continue;
      const vf = emu.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_SLUG })),
      );
      const vm = emu.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_SLUG_M, ex: [mx[0], mx[1], my[0], my[1]] })),
      );
      const vp = plain.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_SLUG })),
      );
      for (let m = 0; m < qs.length; m++) {
        r.n++;
        r.fw += Math.abs(vf[m] - ex[m]);
        r.map += Math.abs(vm[m] - ex[m]);
        if (vf[m] === vm[m]) r.same++;
        if (Object.is(vp[m], vf[m])) r.plainSame++;
        else r.plainMax = Math.max(r.plainMax || 0, Math.abs(vp[m] - vf[m]));
      }
    }
  }
  r.fw *= 255 / r.n;
  r.map *= 255 / r.n;
}
for (const k of ['identity', 'scale 0.9 x 0.45'])
  ok(
    res[k].n > 500 && res[k].same === res[k].n,
    `(a) ${k}: renderFillM is renderFill bit for bit at all ${res[k].n} boundary pixels (${res[k].n - res[k].same} differ)`,
  );
{
  // the axis-aligned program's renderFill (the fwidth-box arithmetic) against the rotated program's, at every map's pixels
  const n = Object.values(res).reduce((a, r) => a + r.n, 0),
    same = Object.values(res).reduce((a, r) => a + r.plainSame, 0);
  // BIT FOR BIT IS A STATEMENT ABOUT UNFUSED ARITHMETIC. Built with fused multiply-adds (MANTLE_EMU_FMA=1) the
  // two texts are two programs to the compiler, which contracts each its own way: ~5% of the pixels then move, by at
  // most 2e-6. That is held to under a thousandth of a level instead, and named.
  const most = Math.max(...Object.values(res).map((r) => r.plainMax || 0));
  if (emuContractDefault())
    ok(
      n > 3000 && most < 1 / 255 / 1000,
      `(a) fused: the axis-aligned program's renderFill is the rotated program's to ${most.toExponential(2)} at all ${n} pixels (${n - same} differ at all)`,
    );
  else
    ok(
      n > 3000 && same === n,
      `(a) the axis-aligned program's renderFill is the rotated program's renderFill bit for bit at all ${n} pixels (${n - same} differ)`,
    );
}
for (const k of ['rotate 7', 'rotate 30', 'rotate 45', 'skewX 30', 'rotate 30 mirrored'])
  ok(
    res[k].n > 500 && res[k].map < 3.25 && res[k].fw > 2 * res[k].map,
    `(b) ${k}: mean edge error ${res[k].map.toFixed(2)}/255 with the map, ${res[k].fw.toFixed(2)}/255 with the fwidth box (${res[k].n} px)`,
  );

// (c) the shader side
{
  const F = readFileSync(path.join(ROOT, 'src/shaders/mantle.frag.glsl'), 'utf8');
  const a = F.indexOf('vec2 emDx = dFdx(emCoord), emDy = dFdy(emCoord);'),
    b = F.indexOf('vec2 slMx = vec2(invPx.x, 0.0), slMy = vec2(0.0, invPx.y);');
  const derive = F.slice(b, F.indexOf('\n  }\n', b) + 4);
  ok(
    a > 0 &&
      b > a &&
      /slMx = vec2\(emDy\.y, -emDx\.y\) \/ det;/.test(derive) &&
      /slMy = vec2\(-emDy\.x, emDx\.x\) \/ det;/.test(derive) &&
      /if \(det < 0\.0\) \{ slMx\.y = -slMx\.y; slMy\.y = -slMy\.y; \}/.test(derive) &&
      !/dFd|fwidth/.test(derive),
    '(c) mantle.frag takes the map from the signed derivatives (invPx on the diagonal, the inverse otherwise, a mirror reflected), with no derivative inside the branch',
  );
  const calls = F.match(/renderFillM\(emCoord, slMx, slMy, GD, evenOddFill, vShapeBBox\)/g) || [];
  const plain = F.match(/renderFill\(emCoord, invPx, GD, evenOddFill, vShapeBBox\)/g) || [];
  const gates =
    F.match(
      /#elif defined\(MANTLE_ROTATED_MAP\)\n\s*(: |\? \(walkFill \? )renderFillM\(emCoord, slMx/g,
    ) || [];
  ok(
    calls.length === 2 && plain.length === 2 && gates.length === 2,
    `(c) both of the main fill's Slug calls take the map under MANTLE_ROTATED_MAP (${calls.length}, ${gates.length} gated) and invPx without it (${plain.length})`,
  );
  const open = F.lastIndexOf('#ifdef MANTLE_ROTATED_MAP', b),
    close = F.indexOf('#endif', b);
  ok(
    open > a && open < b && !F.slice(open, b).includes('#endif') && close > b,
    '(c) the map is derived only in a MANTLE_ROTATED_MAP program',
  );
}

console.log(fail ? `SLUG-ROTATED-FOOTPRINT FAIL (${fail})` : 'SLUG-ROTATED-FOOTPRINT PASS');
process.exit(fail ? 1 : 0);
