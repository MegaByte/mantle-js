// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// childKernelAccuracy — how far a pattern or mask child's coverage is from the exact coverage of the pixel, with the
// fwidth-box child kernel (Slug's renderFill on the fwidth box, whatever the program) against the program's own
// kernel on the program's own pixel (mantle.frag childFill). Node only: the package fill
// shader through test/_glslEmu.mjs, the exact answer from cellCoverage.mjs (cellCoverageMap: the real pixel, pulled
// back through the draw's linear map).
//
// Every layer fill row (FLAG_LAYER: pattern, mask and clip children) of the corpus, drawn N pixels across (N = 3, 8,
// 32: the coarse pixels of a small pattern tile or mask child) at 0 and 30 degrees. Per program:
//   aac      AAC program:        before renderFill(fwidth)   after renderFillAAC(invPx)       / renderFillAACM(map)
//   slug     Slug program:       before renderFill(fwidth)   after renderFill(invPx)          / renderFillM(map)
//   gwnSdf   GWN+SDF program:    before renderFill(fwidth)   after renderFillGWNSDF(invPx)    (rows with a run tree)
//            NOT IN THE PACKAGE: the measurement that keeps a GWN program's children on Slug (zero-area children)
// Edge pixels (exact strictly inside (0, 1)): mean and max |err| in 8-bit levels. Strays: pixels whose exact
// coverage is 0 or 1 and whose answer is off by half a level or more.
//   node probes/fillperf/childKernelAccuracy.mjs [--n 3,8,32] [--angles 0,30]
import { existsSync, readFileSync } from 'fs';
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
const { buildGlslEmu, fillShapes, K_SLUG, K_SLUG_M, K_AAC, K_AAC_M, K_GWN } =
  await import('../../test/_glslEmu.mjs');
const { decodeSegs } = await import('../../src/hitTest/curveGeom.js');
const { cellCoverageMap } = await import('./cellCoverage.mjs');
const { SVG_PATTERN_MASK_STROKES, SVG_NESTED_CLIPS } =
  await import('../../test/_shaderIdentity.mjs');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const NS = flag('n', '3,8,32').split(',').map(Number),
  ANGLES = flag('angles', '0,30').split(',').map(Number);

const slugAxis = buildGlslEmu(ROOT, { defines: [] });
const slugRot = buildGlslEmu(ROOT, { defines: ['MANTLE_ROTATED_MAP'] });
const aacAxis = buildGlslEmu(ROOT, { defines: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'] });
const aacRot = buildGlslEmu(ROOT, {
  defines: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_ROTATED_MAP'],
});
const gwn = buildGlslEmu(ROOT, { defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] });

const MS = path.join(ROOT, '../MantleSamples/Assets/Mantle'),
  SM = path.join(ROOT, 'examples/smoke');
const ART = [
  { name: 'pattern_mask_strokes', svg: SVG_PATTERN_MASK_STROKES },
  { name: 'nested_clips', svg: SVG_NESTED_CLIPS },
  ...[
    [MS, '_mask.svg'],
    [MS, '_mask_multi.svg'],
    [MS, '_mask_nested.svg'],
    [MS, '_mask_features.svg'],
    [MS, '_mask_gradient.svg'],
    [MS, '_pattern.svg'],
    [MS, '_pattern_features.svg'],
    [MS, '_pattern_gradient.svg'],
    [MS, '_pattern_image.svg'],
    [SM, 'patternTransform__ROTATED.svg'],
    [SM, 'lbMaskParity__SVG.svg'],
    [SM, 'maskCache__SVG.svg'],
  ]
    .map(([d, f]) => ({ name: f, file: path.join(d, f) }))
    .filter((a) => existsSync(a.file)),
];

const FLAG_LAYER = 0x100;
async function load(a) {
  const b = await importSvg(a.svg || readFileSync(a.file, 'utf8'), {
    preserveViewport: true,
    gwnTree: true,
  });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats;
  const curve = new Float32Array(b.curves);
  const rows = fillShapes(b, parseMetaBin, M_).filter(
    (sh) =>
      sh.GD[3] >= 0 && ((F[sh.s * pm.floatsPerShape + M_.META_FLAGS_SHAPE] | 0) & FLAG_LAYER) !== 0,
  );
  for (const sh of rows) sh.segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  return { rows: rows.filter((sh) => sh.segs.length), band: new Float32Array(b.bands), curve };
}

const rot = (deg) => {
  const t = (deg * Math.PI) / 180;
  return [
    [Math.cos(t), -Math.sin(t)],
    [Math.sin(t), Math.cos(t)],
  ];
};
const inv = (m) => {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  return [
    [m[1][1] / det, -m[0][1] / det],
    [-m[1][0] / det, m[0][0] / det],
  ];
};
const acc = () => ({ e: [0, 0], m: [0, 0], stray: [0, 0], strayMax: [0, 0] }); // [before, after]
const R = {};
let rowsSeen = 0,
  treeRows = 0;
for (const a of ART) {
  const { rows, band, curve } = await load(a);
  rowsSeen += rows.length;
  for (const sh of rows) {
    if (sh.tree) treeRows++;
    const ext = Math.max(sh.bb[2] - sh.bb[0], sh.bb[3] - sh.bb[1]);
    if (!(ext > 0)) continue;
    for (const N of NS)
      for (const ang of ANGLES) {
        const L = rot(ang),
          s = N / ext;
        const Mx = [
            [L[0][0] * s, L[0][1] * s],
            [L[1][0] * s, L[1][1] * s],
          ],
          J = inv(Mx);
        const emDx = [J[0][0], J[1][0]],
          emDy = [J[0][1], J[1][1]];
        const fw = [Math.abs(emDx[0]) + Math.abs(emDy[0]), Math.abs(emDx[1]) + Math.abs(emDy[1])];
        const det = emDx[0] * emDy[1] - emDy[0] * emDx[1];
        const mx = [emDy[1] / det, -emDx[1] / det],
          my = [-emDy[0] / det, emDx[0] / det];
        if (det < 0) {
          mx[1] = -mx[1];
          my[1] = -my[1];
        }
        // pixel centers on a grid offset by a third of a pixel (no center on a tile edge by construction)
        const cs = [
          [sh.bb[0], sh.bb[1]],
          [sh.bb[2], sh.bb[1]],
          [sh.bb[0], sh.bb[3]],
          [sh.bb[2], sh.bb[3]],
        ].map((p) => [Mx[0][0] * p[0] + Mx[0][1] * p[1], Mx[1][0] * p[0] + Mx[1][1] * p[1]]);
        const i0 = Math.floor(Math.min(...cs.map((p) => p[0]))) - 2,
          i1 = Math.ceil(Math.max(...cs.map((p) => p[0]))) + 2;
        const j0 = Math.floor(Math.min(...cs.map((p) => p[1]))) - 2,
          j1 = Math.ceil(Math.max(...cs.map((p) => p[1]))) + 2;
        const qs = [],
          ex = [];
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const u = i + 0.5 + 1 / 3,
              v = j + 0.5 + 1 / 7;
            const c = [
              Math.fround(J[0][0] * u + J[0][1] * v),
              Math.fround(J[1][0] * u + J[1][1] * v),
            ];
            qs.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: fw });
            ex.push(cellCoverageMap(sh.segs, c, Mx, sh.eo));
          }
        const before = slugAxis.run(
          band,
          curve,
          qs.map((q) => ({ ...q, k: K_SLUG })),
        );
        const arms =
          ang === 0
            ? {
                aac: aacAxis.run(
                  band,
                  curve,
                  qs.map((q) => ({ ...q, k: K_AAC })),
                ),
                slug: before,
              }
            : {
                aac: aacRot.run(
                  band,
                  curve,
                  qs.map((q) => ({ ...q, k: K_AAC_M, ex: [mx[0], mx[1], my[0], my[1]] })),
                ),
                slug: slugRot.run(
                  band,
                  curve,
                  qs.map((q) => ({ ...q, k: K_SLUG_M, ex: [mx[0], mx[1], my[0], my[1]] })),
                ),
              };
        if (sh.tree)
          arms.gwnSdf = gwn.run(
            band,
            curve,
            qs.map((q) => ({ ...q, k: K_GWN })),
          );
        for (const [prog, after] of Object.entries(arms)) {
          const key = `${prog} ${ang}deg N=${N}`,
            r = R[key] || (R[key] = { ...acc(), n: 0, edge: 0 });
          for (let m = 0; m < qs.length; m++) {
            const e = ex[m],
              edge = e > 1e-9 && e < 1 - 1e-9;
            r.n++;
            if (edge) r.edge++;
            [before[m], after[m]].forEach((v, k) => {
              const d = Math.abs(v - e);
              if (edge) {
                r.e[k] += d;
                r.m[k] = Math.max(r.m[k], d);
              } else if (d >= 0.5 / 255) {
                r.stray[k]++;
                r.strayMax[k] = Math.max(r.strayMax[k], d);
              }
            });
          }
        }
      }
  }
}
console.log(
  `childKernelAccuracy: ${rowsSeen} layer fill rows (${treeRows} with a run tree) over ${ART.length} drawings`,
);
console.log(
  'program / angle / pixels across: edge px, mean |err| before -> after (max), strays before -> after (max), /255',
);
const lv = (x) => (255 * x).toFixed(2);
for (const [k, r] of Object.entries(R)) {
  console.log(
    `  ${k.padEnd(20)} ${String(r.edge).padStart(6)} edge px   ${lv(r.e[0] / r.edge)} -> ${lv(r.e[1] / r.edge)}   (max ${lv(r.m[0])} -> ${lv(r.m[1])})` +
      `   strays ${r.stray[0]} -> ${r.stray[1]} (max ${lv(r.strayMax[0])} -> ${lv(r.strayMax[1])})`,
  );
}
