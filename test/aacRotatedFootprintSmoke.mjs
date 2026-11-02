// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacRotatedFootprintSmoke — AAC's exact area under a rotated, skewed or mirrored draw.
//
// Integrating the fragment's fwidth box, |dFdx| + |dFdy| per em axis -- the upright box around the pixel, 1.37x it on a
// side at 30 degrees -- reads 15/255 mean edge error there against 0.01 at identity. So renderFillAACM integrates the
// REAL pixel, the unit box of the em -> pixel map (_coverage.glsl, THE ROTATED FOOTPRINT): the in-box part of every
// segment in the pixel's own frame, and the far field as the winding number along the pixel's right edge, counted
// along em x through the one band list that holds the pixel's em box. Through the shipped shader text in float32
// (test/_glslEmu.mjs), against the exact coverage of the device pixel pulled back through the map
// (probes/fillperf/cellCoverage.mjs cellCoverageMap), under both AAC define sets:
//   (a) the axis-aligned map is renderFillAAC exactly: renderFillAACM with (px.x, 0), (0, px.y) equals renderFillAAC
//       bit for bit at every boundary pixel, at identity and under an anisotropic scale;
//   (b) under rotations of 7, 30 and 45 degrees, a 30-degree skew and a mirrored rotation, AAC's mean edge error is
//       under 0.1/255 and its worst pixel under 1/255 -- identity's own float32 floor -- where the fwidth box reads
//       5-17/255;
//   (c) the same at 2^-20 and 2^20 (the fill data scaled exactly by scaleFillData), for the 30-degree rotation;
//   (d) both of mantle.frag's main AAC calls take the map in a MANTLE_ROTATED_MAP program, and renderFillAAC with invPx in
//       every other (the rotated footprint is a variant, since its presence cost axis-aligned draws 2x).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  K_AAC,
  K_AAC_M,
  AAC_HARD,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP aacRotatedFootprintSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
// the rotated footprint is compiled into the variant for a draw whose map is not axis-aligned (MANTLE_ROTATED_MAP)
const SETS = [
  ['pair', AAC_HARD],
  ['stripe', ['MANTLE_AAC', 'MANTLE_HARD']],
].map(([n, d]) => [n, buildGlslEmu(ROOT, { defines: [...d, 'MANTLE_ROTATED_MAP'] })]);

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
  wrap('M 200 200 Q 800 100 800 500 Q 800 900 200 800 Q 500 500 200 200 Z'),
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

/// The fragment's view of a draw: fwidth, and mantle.frag's map from the signed derivatives.
function frame(L, s) {
  const M = [
    [L[0][0] * s, L[0][1] * s],
    [L[1][0] * s, L[1][1] * s],
  ];
  const det0 = M[0][0] * M[1][1] - M[0][1] * M[1][0],
    J = [
      [M[1][1] / det0, -M[0][1] / det0],
      [-M[1][0] / det0, M[0][0] / det0],
    ];
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
  return { M, J, fw, mx, my };
}
function measure(L, S = 1) {
  const r = {};
  for (const [name] of SETS) r[name] = { n: 0, fw: 0, map: 0, max: 0, same: 0 };
  for (const { shapes, band, curve, ext } of loaded) {
    const { M, J, fw, mx, my } = frame(L, PX / ext);
    const sd = S === 1 ? { band, curve } : scaleFillData(band, curve, shapes, S);
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
            bb: sh.bb.map((v) => Math.fround(v * S)),
            eo: sh.eo,
            c: [Math.fround(c[0] * S), Math.fround(c[1] * S)],
            ePx: [fw[0] * S, fw[1] * S],
          });
          ex.push(e);
        }
      if (!qs.length) continue;
      for (const [name, emu] of SETS) {
        const vf = emu.run(
          sd.band,
          sd.curve,
          qs.map((q) => ({ ...q, k: K_AAC })),
        );
        const vm = emu.run(
          sd.band,
          sd.curve,
          qs.map((q) => ({ ...q, k: K_AAC_M, ex: [mx[0] / S, mx[1] / S, my[0] / S, my[1] / S] })),
        );
        const R = r[name];
        for (let m = 0; m < qs.length; m++) {
          const d = Math.abs(vm[m] - ex[m]);
          R.n++;
          R.fw += Math.abs(vf[m] - ex[m]);
          R.map += d;
          R.max = Math.max(R.max, d);
          if (vf[m] === vm[m]) R.same++;
        }
      }
    }
  }
  for (const R of Object.values(r)) {
    R.fw *= 255 / R.n;
    R.map *= 255 / R.n;
    R.max *= 255;
  }
  return r;
}

for (const [mapName, L] of Object.entries(MAPS)) {
  const r = measure(L);
  for (const [name] of SETS) {
    const R = r[name];
    if (mapName === 'identity' || mapName.startsWith('scale'))
      ok(
        R.n > 500 && R.same === R.n,
        `(a) ${name}, ${mapName}: renderFillAACM is renderFillAAC bit for bit at all ${R.n} boundary pixels (${R.n - R.same} differ)`,
      );
    else
      ok(
        R.n > 500 && R.map < 0.1 && R.max < 1,
        `(b) ${name}, ${mapName}: mean edge error ${R.map.toFixed(3)}/255 (worst ${R.max.toFixed(2)}) with the map, ${R.fw.toFixed(2)}/255 with the fwidth box (${R.n} px)`,
      );
  }
}
for (const S of [2 ** -20, 2 ** 20]) {
  const r = measure(MAPS['rotate 30'], S);
  for (const [name] of SETS)
    ok(
      r[name].n > 500 && r[name].map < 0.1 && r[name].max < 1,
      `(c) ${name}, rotate 30 at 2^${Math.log2(S)}: mean edge error ${r[name].map.toFixed(3)}/255 (worst ${r[name].max.toFixed(2)})`,
    );
}
{
  const F = readFileSync(path.join(ROOT, 'src/shaders/mantle.frag.glsl'), 'utf8');
  const calls =
    F.match(/renderFillAACM\(emCoord, slMx, slMy, GD, evenOddFill, vShapeBBox\)/g) || [];
  const plain = F.match(/renderFillAAC\(emCoord, invPx, GD, evenOddFill, vShapeBBox\)/g) || [];
  const gates =
    F.match(
      /#if defined\(MANTLE_AAC\) && defined\(MANTLE_ROTATED_MAP\)|#elif defined\(MANTLE_AAC\) && defined\(MANTLE_ROTATED_MAP\)/g,
    ) || [];
  ok(
    calls.length === 2 && plain.length === 2 && gates.length === 2,
    `(d) both of the main fill's AAC calls take the map under MANTLE_ROTATED_MAP (${calls.length}, ${gates.length} gates), and invPx without it (${plain.length})`,
  );
  const C = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  // the #ifdef MANTLE_ROTATED_MAP block still open (by #if / #endif depth) at renderFillAACM and at the first wall count
  const inGate = (name) => {
    const at = C.indexOf(name),
      open = C.lastIndexOf('#ifdef MANTLE_ROTATED_MAP', at);
    if (open < 0 || at < 0) return false;
    let depth = 0;
    for (const l of C.slice(open, at).split('\n')) {
      if (/^\s*#\s*if/.test(l)) depth++;
      else if (/^\s*#\s*endif/.test(l)) {
        depth--;
        if (depth === 0) return false;
      }
    }
    return depth >= 1;
  };
  ok(
    inGate('float renderFillAACM(') && inGate('float aacWallLine(') && inGate('vec2 aacPLM('),
    '(d) renderFillAACM and its wall counts compile only in a MANTLE_ROTATED_MAP program',
  );
}

console.log(fail ? `AAC-ROTATED-FOOTPRINT FAIL (${fail})` : 'AAC-ROTATED-FOOTPRINT PASS');
process.exit(fail ? 1 : 0);
