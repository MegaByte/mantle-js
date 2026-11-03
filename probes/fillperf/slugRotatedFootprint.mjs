// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugRotatedFootprint — Slug's edge coverage under a rotated, skewed, mirrored or anisotropic draw,
// against the exact coverage of the REAL pixel: the unit box in device space, pulled back through the draw's linear
// map (cellCoverage.mjs cellCoverageMap). Node only: the package fill shader through test/_glslEmu.mjs.
//
//   before  renderFill with the fragment's fwidth box, |dFdx| + |dFdy| per em axis
//   after   renderFillM with the em -> pixel map's columns, as mantle.frag derives them from the same derivatives
//   aac     renderFillAAC with the fwidth box
//   aacM    renderFillAACM with the map (a base text without it reads -1)
//
// Every pixel whose exact coverage is strictly between 0 and 1, mean and max |err| in 8-bit levels.
//   node probes/fillperf/slugRotatedFootprint.mjs [--px 64] [--base file.glsl] [--tiger]
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
const M_ = await import('../../src/bundle/layout.js');
const { buildGlslEmu, fillShapes, K_SLUG, K_SLUG_M, K_AAC, K_AAC_M } =
  await import('../../test/_glslEmu.mjs');
const { decodeSegs } = await import('../../src/hitTest/curveGeom.js');
const { cellCoverageMap } = await import('./cellCoverage.mjs');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const PX = +flag('px', 64);
const baseText = flag('base') ? readFileSync(flag('base'), 'utf8') : null;
const slugBefore = buildGlslEmu(ROOT, { defines: [], glsl: baseText });
const slugAfter = buildGlslEmu(ROOT, { defines: ['MANTLE_ROTATED_MAP'] }); // the map's program (SR13cv)
const aac = buildGlslEmu(ROOT, {
  defines: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_ROTATED_MAP'],
});

const wrap = (d, eo) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path ${eo ? 'fill-rule="evenodd" ' : ''}d="${d}" fill="#000"/></svg>`;
const ART = {
  disc: wrap('M 500 180 a 320 320 0 1 0 0.1 0 Z'),
  bowl: wrap('M 500 180 a 260 320 0 1 0 0.1 0 Z M 500 330 a 140 170 0 1 1 -0.1 0 Z', true),
  ess: wrap(
    'M 700 300 C 700 150 300 150 300 330 C 300 470 700 470 700 640 C 700 830 300 830 300 680 L 380 660 C 400 740 620 740 620 640 C 620 540 240 540 240 340 C 240 110 760 110 760 300 Z',
  ),
  star: wrap(
    'M 500 120 L 590 390 L 870 390 L 645 560 L 730 840 L 500 670 L 270 840 L 355 560 L 130 390 L 410 390 Z',
  ),
  diamond: wrap('M 500 150 L 850 500 L 500 850 L 150 500 Z'),
};
if (argv.includes('--tiger'))
  ART.tiger = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');

// the draw's linear part, em -> device pixels, before the P-px fit: rows [[a, b], [c, d]]
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
  'rotate 30': rot(30),
  'rotate 45': rot(45),
  'rotate 7': rot(7),
  'skewX 30': [
    [1, Math.tan(Math.PI / 6)],
    [0, 1],
  ],
  'scale 0.9 x 0.45': [
    [0.9, 0],
    [0, 0.45],
  ],
  'rotate 30, mirrored': [
    [-Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)],
    [-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)],
  ],
};
const inv = (m) => {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  return [
    [m[1][1] / det, -m[0][1] / det],
    [-m[1][0] / det, m[0][0] / det],
  ];
};

const bundles = new Map();
async function load(name) {
  if (bundles.has(name)) return bundles.get(name);
  const b = await importSvg(ART[name], { preserveViewport: true });
  const shapes = fillShapes(b, parseMetaBin, M_),
    curve = new Float32Array(b.curves);
  for (const sh of shapes) sh.segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of shapes) {
    x0 = Math.min(x0, s.bb[0]);
    y0 = Math.min(y0, s.bb[1]);
    x1 = Math.max(x1, s.bb[2]);
    y1 = Math.max(y1, s.bb[3]);
  }
  const r = { shapes, band: new Float32Array(b.bands), curve, ext: Math.max(x1 - x0, y1 - y0) };
  bundles.set(name, r);
  return r;
}

const results = {};
for (const [mapName, L] of Object.entries(MAPS)) {
  const acc = { before: [0, 0], after: [0, 0], aac: [0, 0], aacM: [0, 0], n: 0 };
  for (const name of Object.keys(ART)) {
    const { shapes, band, curve, ext } = await load(name);
    const s = PX / ext; // the drawing PX px across (before the linear part)
    const M = [
        [L[0][0] * s, L[0][1] * s],
        [L[1][0] * s, L[1][1] * s],
      ],
      J = inv(M); // em -> px, px -> em
    // the fragment's signed derivatives: emDx = J e_x, emDy = J e_y
    const emDx = [J[0][0], J[1][0]],
      emDy = [J[0][1], J[1][1]];
    const fw = [Math.abs(emDx[0]) + Math.abs(emDy[0]), Math.abs(emDx[1]) + Math.abs(emDy[1])]; // fwidth(emCoord)
    // mantle.frag's map: M's columns, the y row negated under a mirror
    const det = emDx[0] * emDy[1] - emDy[0] * emDx[1];
    const mx = [emDy[1] / det, -emDx[1] / det],
      my = [-emDy[0] / det, emDx[0] / det];
    if (det < 0) {
      mx[1] = -mx[1];
      my[1] = -my[1];
    }
    for (const sh of shapes) {
      // the pixel grid: centers at J (i + 0.5, j + 0.5), over the shape's box in device space
      const cs = [
        [sh.bb[0], sh.bb[1]],
        [sh.bb[2], sh.bb[1]],
        [sh.bb[0], sh.bb[3]],
        [sh.bb[2], sh.bb[3]],
      ].map((p) => [M[0][0] * p[0] + M[0][1] * p[1], M[1][0] * p[0] + M[1][1] * p[1]]);
      const i0 = Math.floor(Math.min(...cs.map((p) => p[0]))) - 2,
        i1 = Math.ceil(Math.max(...cs.map((p) => p[0]))) + 2;
      const j0 = Math.floor(Math.min(...cs.map((p) => p[1]))) - 2,
        j1 = Math.ceil(Math.max(...cs.map((p) => p[1]))) + 2;
      const qs = [],
        ex = [];
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const c = [
            J[0][0] * (i + 0.5) + J[0][1] * (j + 0.5),
            J[1][0] * (i + 0.5) + J[1][1] * (j + 0.5),
          ];
          if (
            c[0] < sh.bb[0] - 2 * fw[0] ||
            c[0] > sh.bb[2] + 2 * fw[0] ||
            c[1] < sh.bb[1] - 2 * fw[1] ||
            c[1] > sh.bb[3] + 2 * fw[1]
          )
            continue;
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
      const vb = slugBefore.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_SLUG })),
      );
      const va = slugAfter.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_SLUG_M, ex: [mx[0], mx[1], my[0], my[1]] })),
      );
      const vc = aac.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_AAC })),
      );
      const vd = aac.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: K_AAC_M, ex: [mx[0], mx[1], my[0], my[1]] })),
      );
      for (let m = 0; m < qs.length; m++) {
        acc.n++;
        for (const [k, v] of [
          ['before', vb],
          ['after', va],
          ['aac', vc],
          ['aacM', vd],
        ]) {
          const d = Math.abs(v[m] - ex[m]);
          acc[k][0] += d;
          acc[k][1] = Math.max(acc[k][1], d);
        }
      }
    }
  }
  results[mapName] = acc;
  const f = (k) =>
    `${((255 * acc[k][0]) / acc.n).toFixed(2)} (max ${(255 * acc[k][1]).toFixed(1)})`;
  console.log(
    `${mapName.padEnd(20)} ${String(acc.n).padStart(6)} px   Slug ${f('before')} -> ${f('after')}   AAC ${f('aac')} -> ${f('aacM')}   /255`,
  );
}
