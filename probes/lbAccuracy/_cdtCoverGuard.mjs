// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cdtCoverGuard — what the mesh-coverage guard DECLINES once the CDT / partition-carve route asks
// it, and what each decline buys.
//
// `meshUnderCovers` refuses a mesh whose deliberate OVER-estimate of paintable area is under half
// the shape's true area, so a passing mesh can never have been wrongly rejected. The build asks it
// on the fast-mesh branch only; `cdtMeshAccepted` (src/renderer/lbBuildCore.js) does not ask it on
// the partition. This prices what asking there WOULD decline (every row it flags draws no fill, so
// asking there buys nothing), from the built mesh and the bound directly.
//
// ASKING IS A ROUTING CHANGE — a declined shape draws its cover quad through the Slug kernel,
// which is reference-exact but leaves the analytic route — so this prices both sides per shape:
//
//   miss    px^2 the path covers FULLY that the LB mesh does not paint. This is what the guard
//           RECOVERS: Slug paints it. Fill, not antialiasing.
//   aaErr   px^2 of |model - exact| over partially covered pixels. This is what the guard GIVES UP,
//           since Slug's own AA is not exact either -- but the twin cannot score Slug, so it is
//           reported as the LB error that stops being LB's, not as a net.
//   ratio   meshAreaUpperBound / contourAreaExact -- how far under the bound the mesh is. The guard
//           fires below 0.5, and a value near 0 is a mesh that paints essentially nothing.
//
// The reference is the PATH's own exact coverage (_lbAaRef.mjs), per shape SOLO on the raster the
// whole drawing is rendered at (a composited frame hides an over-covering shape under the next one's ink).
//
//   node probes/lbAccuracy/_cdtCoverGuard.mjs [file.svg ...]   CANVAS=512 SLICES=64
// With no files it takes examples/*.svg, examples/_bench/*.svg, examples/smoke/*.svg and the tiger.
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { loadSvg, shapesOf, viewOf, buildMesh, rasterMesh, ROOT } from './_lbRaster.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';

console.warn = () => {};
const { meshUnderCovers, meshAreaUpperBound, contourAreaExact } =
  await import('../../src/renderer/lbBuildCore.js');
const CANVAS = +(process.env.CANVAS || 512);
const SLICES = +(process.env.SLICES || 64);
const PAD = 2;

let files = process.argv.slice(2);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
  const tiger = '../MantleSamples/Assets/Mantle/tiger.svg';
  if (existsSync(path.resolve(ROOT, tiger))) files.push(tiger);
}

/// The solo miss / aaErr of one shape's mesh against the path's exact coverage.
async function score(sh, built, view, kit) {
  const { rowSpans, contoursToConverter, closed } = kit;
  const cv = contoursToConverter(sh.contours, null);
  if (!cv) return null;
  const curves = closed(cv);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of curves)
    for (const p of sg.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  const i0 = Math.max(0, Math.floor((x0 - view.ox) / view.basePx) - PAD);
  const i1 = Math.min(CANVAS - 1, Math.ceil((x1 - view.ox) / view.basePx) + PAD);
  const j0 = Math.max(0, Math.floor((y0 - view.oy) / view.basePx) - PAD);
  const j1 = Math.min(CANVAS - 1, Math.ceil((y1 - view.oy) / view.basePx) + PAD);
  if (i1 < i0 || j1 < j0) return null;
  const acc = new Float64Array(CANVAS * CANVAS).fill(1);
  rasterMesh(built.pk, view, acc, {}, null, null, null);
  let miss = 0,
    missN = 0,
    aaErr = 0,
    aaN = 0,
    stray = 0;
  const rc = new Map();
  for (let j = j0; j <= j1; j++) {
    rc.clear();
    for (let i = i0; i <= i1; i++) {
      const ex = exactCov(rowSpans, curves, i, j, view, SLICES, sh.evenOdd, rc);
      const mo = 1 - acc[j * CANVAS + i];
      if (ex > 1e-6 && ex < 1 - 1e-6) {
        aaN++;
        aaErr += Math.abs(mo - ex);
      } else if (ex >= 1 - 1e-6) {
        if (mo < 1) {
          miss += 1 - mo;
          if (1 - mo > 0.5) missN++;
        }
      } else if (mo > 0) stray += mo;
    }
  }
  return { miss, missN, aaErr, aaN, stray };
}

const rows = [];
let nShapes = 0,
  nBuilt = 0,
  nDeclined = 0,
  nAssets = 0;
for (const f of files) {
  let bundle = null;
  try {
    bundle = await loadSvg(f);
  } catch {
    continue;
  }
  let shapes = [],
    bbox = null;
  try {
    ({ shapes, bbox } = await shapesOf(bundle));
  } catch {
    continue;
  }
  if (!shapes.length) continue;
  nAssets++;
  const view = viewOf(bbox, CANVAS);
  let kit = null;
  for (const sh of shapes) {
    nShapes++;
    let off = null;
    try {
      off = await buildMesh(sh);
    } catch {
      off = null;
    }
    if (!off) continue;
    nBuilt++;
    // A fast-route mesh already passed the bound, so a flagged mesh is a partition.
    if (!meshUnderCovers(off.raw, sh.contours)) continue;
    nDeclined++;
    kit = kit || (await refKit());
    const sc = await score(sh, off, view, kit);
    const bound = meshAreaUpperBound(off.raw),
      want = contourAreaExact(sh.contours);
    rows.push({
      file: f,
      s: sh.s,
      verts: off.pk.vertexCount,
      route: off.raw._route || '?',
      ratio: want > 0 ? bound / want : NaN,
      ...(sc || { miss: NaN, missN: NaN, aaErr: NaN, aaN: NaN, stray: NaN }),
    });
  }
}

// A row with no reference is a shape whose contours the converter declines -- an open subpath a
// stroke row carries, with no fill to score. Say so instead of printing NaN: declining such a mesh
// costs nothing and recovers nothing, and burying it in a total would hide both.
const num = (v, w, d) => (Number.isFinite(v) ? v.toFixed(d) : 'no fill').padStart(w);
rows.sort((a, b) => (b.miss || 0) - (a.miss || 0));
console.log(
  `CANVAS=${CANVAS} SLICES=${SLICES} — every shape the bound would decline on the partition route:\n`,
);
console.log('     miss px2  whole px    aaErr px2   ratio  verts  route            shape');
for (const r of rows)
  console.log(
    `  ${num(r.miss, 10, 2)}  ${(Number.isFinite(r.missN) ? String(r.missN) : '-').padStart(8)}  ${num(r.aaErr, 10, 3)}` +
      `  ${r.ratio.toFixed(3).padStart(6)}  ${String(r.verts).padStart(5)}  ${r.route.padEnd(15)}  ${r.file.split('/').pop()} #${r.s}`,
  );
const T = (k) => rows.reduce((t, r) => t + (Number.isFinite(r[k]) ? r[k] : 0), 0);
const nNoRef = rows.filter((r) => !Number.isFinite(r.miss)).length;
console.log(
  `\n  ${nAssets} assets, ${nShapes} shapes, ${nBuilt} built, ${nDeclined} flagged by the bound` +
    ` (${((100 * nDeclined) / Math.max(1, nBuilt)).toFixed(2)}% of built meshes)`,
);
console.log(
  `  those meshes leave ${T('miss').toFixed(2)} px^2 of paint MISSING over ${T('missN')} whole pixels,` +
    ` and carry ${T('aaErr').toFixed(2)} px^2 of antialiasing error over ${T('aaN')} edge pixels` +
    (nNoRef ? ` (${nNoRef} of them have no fill to score at all)` : ''),
);
const byAsset = new Map();
for (const r of rows)
  byAsset.set(r.file, (byAsset.get(r.file) || 0) + (Number.isFinite(r.miss) ? r.miss : 0));
for (const [f, m] of [...byAsset].sort((a, b) => b[1] - a[1]))
  console.log(
    `    ${f}: ${m.toFixed(2)} px^2 over ${rows.filter((r) => r.file === f).length} shapes`,
  );

// ── THE GUARD'S RECALL, on tiger ─────────────────────────────────────────────────────────────────
// A guard that fires on some missing paint and not the rest is worth knowing about:
// `meshUnderCovers` opts out whenever its area bound cannot be
// trusted, so a shape can be missing a great deal of paint and still pass.
const TIGER = files.find((f) => /tiger\.svg$/.test(f));
if (TIGER && process.env.RECALL !== '0') {
  const bundle = await loadSvg(TIGER);
  const { shapes, bbox } = await shapesOf(bundle);
  const view = viewOf(bbox, CANVAS);
  const kit = await refKit();
  let flagged = 0,
    flaggedMiss = 0,
    passed = 0,
    passedMiss = 0,
    worstPassed = null;
  for (const sh of shapes) {
    let built = null;
    try {
      built = await buildMesh(sh);
    } catch {
      built = null;
    }
    if (!built) continue;
    const sc = await score(sh, built, view, kit);
    if (!sc) continue;
    if (meshUnderCovers(built.raw, sh.contours)) {
      flagged++;
      flaggedMiss += sc.miss;
    } else {
      passed++;
      passedMiss += sc.miss;
      if (!worstPassed || sc.miss > worstPassed.miss) worstPassed = { s: sh.s, ...sc };
    }
  }
  console.log(
    `\n  RECALL on ${TIGER.split('/').pop()} at ${CANVAS} px: the guard flags ${flagged} shapes holding` +
      ` ${flaggedMiss.toFixed(2)} px^2 of the missing paint; ${passed} shapes pass holding ${passedMiss.toFixed(2)} px^2`,
  );
  console.log(
    `  so it recovers ${((100 * flaggedMiss) / Math.max(1e-9, flaggedMiss + passedMiss)).toFixed(1)}% of tiger's missing fill.` +
      (worstPassed
        ? `  Worst shape it lets through: #${worstPassed.s} at ${worstPassed.miss.toFixed(2)} px^2.`
        : ''),
  );
}

// ── THE ANSWER ────────────────────────────────────────────────────────────────────────────────
// Answered on the CPU and needing no render: every row the bound flags on the partition route
// draws NO FILL (tiger #142/#143 and their copies in the tiger variants, fill alpha 0), so asking
// would decline meshes of a fill nobody paints -- no ink recovered, a Slug cover quad per row
// spent. test/lbCdtCoverGuardSmoke fails if a flagged row ever draws a fill.
