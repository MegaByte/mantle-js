// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbArcCovReachSmoke — arcCov's disc branch IS reachable from an imported asset, and what its chord moment
// is worth depends on the drawn radius.
//
// There is no separate "analytic primitive SDF" shader for a recognized circle, and turning recognition
// off is not the only way to reach `arcCov`. A recognized circle IS a Loop-Blinn kind-7 vertex — shapeRecognize
// (circleFromContours) → buildLoopBlinnMesh's mesh.circles → lbPack's `disc` with aC3.w = -1 →
// _lbCoverage.glsl's DISC branch, which calls `arcCov` for every cHalf >= -1.5 and `curveCov` only
// for the ELLIPSE record (cHalf = -2). The `sdf` the draw tally prints is the engine table's
// (engineLedger.js) name for that same vertex (a mesh whose records are all primitives), not a
// different code path.
//
// THE SIZE DECIDES WHAT AN A/B CAN SEE. `lbCircleSdf__SVG.svg` is one circle of radius 40 in a 160 em
// viewBox, which at 512 px is a radius of 128 DEVICE pixels. arcCov uses the exact moment over the
// chord the pixel cuts in place of kappa/24, a difference that shrinks with radius: on the shipped
// kernel text, 2.80/255 at r = 3 and 0.09/255 at r = 128. One tenth of a quantization step is
// byte-identical on any GPU, so a byte-identical A/B at that size does not mean the branch is
// unreached. `test/curveCovChordSmoke.mjs` owns the arithmetic; this test owns the reachability and
// the scale.
//
//   (a) the assets reach the branch: lbCircleSdf__SVG packs kind-7 vertices at cHalf = -1 (disc,
//       arcCov) and lbAnnulusSdf__SVG at cHalf > 0 (ring, arcCov) — from importSvg's own curve
//       buffer, through the shipped builder and packer;
//   (b) the chord moment's size in EIGHT BITS falls monotonically with the drawn radius, and at
//       lbCircleSdf's 128 px it is under a tenth of a step;
//   (c) `examples/smoke/lbArcCovSmall__SVG.svg` is the asset that decides it: 49 recognized
//       circles, every one disc mode, at 3.10 to 12.39 device px at 512, where the change is worth
//       over 2/255.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CURVE_COV, K_ARC_COV } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP lbArcCovReachSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLoopBlinnMesh } = await import('../src/renderer/lbFastMesh.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS } = await import('../src/renderer/lbPack.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

// ---- the branch, as the shader text states it -------------------------------------------------------------------------
ok(
  /\(cHalf < -1\.5\) \? curveCov\([\s\S]{0,200}?: arcCov\(/.test(GLSL),
  'the DISC branch calls curveCov only for the ELLIPSE record and arcCov for disc and ring',
);
ok(GLSL.includes('  return exactBoxCov(n, d - kPx * mom);'), 'arcCov carries the chord moment');

// ---- (a) which kind-7 records an IMPORTED asset packs -------------------------------------------------------------------
/// Every kind-7 vertex an asset's fill shapes pack, binned by the branch its cHalf selects.
async function discRecords(file) {
  const b = await importSvg(readFileSync(path.join(ROOT, file), 'utf8'), {
    preserveViewport: true,
  });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats;
  const curve = new Float32Array(b.curves);
  const t = { ellipse: 0, disc: 0, ring: 0, prim: 0, shapes: 0, radii: [] };
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (!(F[o + M.META_FILL_A] > 0)) continue;
    const r = b.curveRangesByShape[s];
    if (!r) continue;
    t.shapes++;
    const mesh = buildLoopBlinnMesh(
      curveRangeToContours(curve, r.begin, r.end),
      true,
      (F[o + M.META_FILL_RULE] | 0) === 1 ? 'evenodd' : 'nonzero',
    );
    if (!mesh) continue;
    const p = packLoopBlinnMesh(mesh);
    if (!p || !p.verts) continue;
    if (p.prim) t.prim++;
    for (let i = 0; i + LB_VERT_FLOATS <= p.verts.length; i += LB_VERT_FLOATS) {
      if (Math.abs(p.verts[i + 5] - 7) > 0.25) continue; // aKind slot (blendBit is 0.25)
      const ch = p.verts[i + 22];
      if (ch < -1.5) t.ellipse++;
      else if (ch < 0) {
        t.disc++;
        if (!t.radii.includes(p.verts[i + 21])) t.radii.push(p.verts[i + 21]);
      } else t.ring++;
    }
  }
  return t;
}
{
  const c = await discRecords('examples/smoke/lbCircleSdf__SVG.svg');
  ok(
    c.disc > 0 && c.ellipse === 0,
    `(a) lbCircleSdf__SVG packs ${c.disc} kind-7 DISC vertices (cHalf = -1), which is exactly the branch arcCov guards; ellipse/curveCov vertices: ${c.ellipse}`,
  );
  const a = await discRecords('examples/smoke/lbAnnulusSdf__SVG.svg');
  ok(
    a.ring > 0,
    `(a) lbAnnulusSdf__SVG packs ${a.ring} kind-7 RING vertices (cHalf >= 0) — also arcCov`,
  );
}

// ---- (b) the size of the chord moment against the drawn radius --------------------------------------------------------------------
const emu = buildGlslEmu(ROOT, { curveCov: true });
const EMPTY = new Float32Array(4);
const qq = (kind, a) => ({
  k: kind,
  GD: [0, 0, 0, 0],
  bb: [a[0], a[1], a[2], a[3]],
  eo: false,
  c: [a[4], a[5]],
  ePx: [1, 1],
});
/// The DISC branch's own arguments: f = |p - C| - r, gradient the unit radial, Hessian the rank-1
/// w * W (x) W with w = 1/|p - C| — exactly as _lbCoverage.glsl builds them.
const discArgs = (dx, dy, r) => {
  const L = Math.max(Math.hypot(dx, dy), 1e-9),
    hx = dx / L,
    hy = dy / L,
    w = 1 / L;
  return [L - r, hx, hy, w * hy * hy, w * hx * hx, -w * hx * hy];
};
/// Edge pixels of one disc, scored both ways; `changed` counts 8-bit values that move.
function discSize(cx, cy, R) {
  const A = [],
    C = [];
  const i0 = Math.floor(cx - R - 2),
    i1 = Math.ceil(cx + R + 2),
    j0 = Math.floor(cy - R - 2),
    j1 = Math.ceil(cy + R + 2);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      if (Math.abs(Math.hypot(i + 0.5 - cx, j + 0.5 - cy) - R) > 1.5) continue;
      const a = discArgs(i + 0.5 - cx, j + 0.5 - cy, R);
      A.push(qq(K_ARC_COV, a));
      C.push(qq(K_CURVE_COV, a));
    }
  const ra = emu.run(EMPTY, EMPTY, A),
    rc = emu.run(EMPTY, EMPTY, C);
  let max = 0,
    changed = 0;
  for (let i = 0; i < ra.length; i++) {
    const d = Math.abs(ra[i] - rc[i]);
    if (d > max) max = d;
    if (Math.round(ra[i] * 255) !== Math.round(rc[i] * 255)) changed++;
  }
  return { n: ra.length, max, changed };
}
{
  const rows = [3, 6, 12, 24, 48, 96, 128].map((R) => ({ R, ...discSize(R + 3.37, R + 2.13, R) }));
  const by = Object.fromEntries(rows.map((r) => [r.R, r]));
  ok(
    rows.every((r, i) => i === 0 || r.max <= rows[i - 1].max * 1.001),
    '(b) the chord moment shrinks monotonically with the drawn radius: ' +
      rows.map((r) => `r${r.R} ${(r.max * 255).toFixed(2)}/255`).join(', '),
  );
  ok(
    by[128].max * 255 < 0.25,
    `(b) at lbCircleSdf's radius — 40 em in a 160 em viewBox is 128 device px at 512 — the worst pixel moves ${(by[128].max * 255).toFixed(3)}/255, so a BYTE-IDENTICAL A/B there decides nothing`,
  );
  ok(
    by[3].max * 255 > 2 && by[3].changed / by[3].n > 0.15,
    `(b) at r = 3 px it moves ${(by[3].max * 255).toFixed(2)}/255 and changes ${by[3].changed} of ${by[3].n} edge pixels' bytes (${((100 * by[3].changed) / by[3].n).toFixed(0)}%)`,
  );
}

// ---- (c) the asset that decides it --------------------------------------------------------------------------------------
{
  const t = await discRecords('examples/smoke/lbArcCovSmall__SVG.svg');
  ok(
    t.shapes === 49 && t.prim === 49 && t.ellipse === 0 && t.ring === 0 && t.disc === 49 * 6,
    `(c) lbArcCovSmall__SVG: ${t.shapes} fill shapes, ${t.prim} recognized primitives, ${t.disc} kind-7 DISC vertices and ${t.ellipse} ellipse ones — every shape on the arcCov branch`,
  );
  const rs = [...t.radii].sort((a, b2) => a - b2);
  ok(
    rs.length === 7 && rs[0] === 3 && rs[6] === 12,
    `(c) ...at em radii ${rs.join(', ')} — 512/496 = 1.0323 device px per em at 512, so 3.10 to 12.39 device px`,
  );
  // The asset's own worst circle, at its own device radius.
  const s3 = discSize(11 * 1.0323, 11 * 1.0323, 3 * 1.0323);
  ok(
    s3.max * 255 > 1.5 && s3.changed >= 6,
    `(c) its r = 3 em row at 512: worst pixel ${(s3.max * 255).toFixed(2)}/255 and ${s3.changed} of ${s3.n} edge bytes change — a GPU A/B on THIS asset cannot come back byte-identical`,
  );
}

console.log(fail ? `lbArcCovReachSmoke FAIL (${fail})` : 'lbArcCovReachSmoke PASS');
process.exit(fail ? 1 : 0);
