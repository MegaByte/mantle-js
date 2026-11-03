// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsRowGateSmoke -- the per-row point gate (option aacPointsRowGate; default off) and the E_MIN pick rule (option lbMinExtentPx).
//   (a) rowPlan: rows under aacPointsExtMax take points, the rest keep the mesh routes, cut into runs in draw order;
//   (b) an all-small drawing is one points run; no small row is no plan; a fallback caller (no mesh draw) takes only an all-points plan;
//   (c) the byte budget demotes the largest rows first; the run cap keeps one draw; masks, patterns and non-ascending rows keep one draw;
//   (d) scale-free: the same art at 2^-20 and 2^20 of the pixel scale plans the same classes at the same pixel extents;
//   (e) E_MIN: lbShapePicks keeps a row under the extent on its cover quad, and the pick key moves with the option;
//   (f) estimateRouteBytes: cover bytes sum from the rows, the points list is 8 B per point of the closed form, a built mesh is exact bytes.
import { attachAacPointsDraw } from '../src/renderer/aacPointsDraw.js';
import { attachRouteBytes } from '../src/renderer/routeBytes.js';
import { lbShapePicks } from '../src/renderer/lbShapePolicy.js';
import { SEG_CUBIC } from '../src/primitives/seg.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const R = { gl: null, opts: {}, _pendingShaders: [], _pendingPrograms: [] };
attachAacPointsDraw(R);
const G = R._aacPointsGate;

/// A drawing of rows with the given em widths (square rows), one fill paint each, rows 0..n-1 ascending.
const mk = (ws, extra = {}) => {
  const n = ws.length,
    box = new Float64Array(6 * n),
    ext = new Float32Array(2 * n);
  ws.forEach((w, i) => {
    box.set([0, 0, w, w, w, w], 6 * i);
    ext[2 * i] = w;
    ext[2 * i + 1] = w;
  });
  return {
    rows: new Uint16Array(ws.map((_, i) => i)),
    paint: new Uint8Array(n).fill(1),
    ext,
    box,
    masks: false,
    pats: false,
    ...extra,
  };
};
R.opts.aacPointsRowsMin = 0;
R.opts.aacCoverExtMax = 0; // the tiny-shape class (a2) off: (a)-(d) pin the points / mesh cut
const J = [1, 0, 0, 1];
const plan = (s, mesh = true) => {
  s.plan = null;
  s.rowGeom = null;
  return G.rowPlan(s, J, 1, 1, 1, 0, 0, 1, mesh);
};

// (a) a run of small rows, then a big one, then small ones
let p = plan(mk([4, 4, 4, 100, 4, 4]));
ok(p && p.runs.length === 3, `small, big, small cut into 3 runs (${p && p.runs.length})`);
ok(
  p && p.runs[0].pts && !p.runs[1].pts && p.runs[2].pts,
  'runs are points, mesh, points in draw order',
);
ok(
  p && p.runs[1].lo === 3 && p.runs[1].hi === 3,
  'the mesh run names its shape rows (the sprite-range pair)',
);
ok(p && p.rowsPts === 5, 'five rows take points');

// (b)
p = plan(mk([4, 6, 20, 29]));
ok(p && p.runs.length === 1 && p.runs[0].pts, 'all rows under 30 px: one points run');
ok(plan(mk([40, 50])) === null, 'no row under the extent: no plan');
ok(plan(mk([4, 100]), false) === null, 'a fallback caller (no mesh draw) takes no mixed plan');
ok(plan(mk([4, 6]), false) !== null, '... but takes an all-points plan');

// (a2) the TINY-SHAPE class: every row under aacCoverExtMax -> ONE class for the drawing, by its median row
R.opts.aacCoverExtMax = 32;
R.opts.aacCoverExtMin = 9;
const kind = (pl) => pl && pl.runs.map((r) => (r.pts ? 'p' : r.cover ? 'c' : 'm')).join('');
p = plan(mk([4, 6, 7, 20, 8]));
ok(kind(p) === 'p' && p.rowsPts === 5, `median 7 px: the whole drawing on points (${kind(p)})`);
p = plan(mk([4, 12, 12, 30, 10]));
ok(
  kind(p) === 'c' && p.rowsCover === 5 && !p.runs[0].pts,
  `median 12 px: the whole drawing on the cover pass, one run (${kind(p)})`,
);
p = plan(mk([40, 50, 12]));
ok(kind(p) !== 'c', `a row over aacCoverExtMax: not a tiny-shape bundle (${kind(p)})`);
p = plan(mk([20, 20, 20, 20]), false);
ok(kind(p) === 'c', 'a fallback caller (no mesh draw) takes the all-cover plan');
R.opts.aacPointsBytesBudget = 100;
p = plan(mk([8, 8, 8, 8]));
ok(kind(p) === 'c', `a points list over the byte budget takes the cover pass (${kind(p)})`);
delete R.opts.aacPointsBytesBudget;
R.opts.aacPointsRowsMin = 8;
ok(kind(plan(mk([20, 20, 20]))) !== 'c', 'under aacPointsRowsMin rows: not a tiny-shape bundle');
R.opts.aacPointsRowsMin = 0;
R.opts.aacCoverExtMax = 0;
ok(kind(plan(mk([20, 20]))) === 'p', 'aacCoverExtMax:0: the points cut as before');
delete R.opts.aacCoverExtMin; // aacCoverExtMax stays 0 for the rest

// (c) budget: ten 29 px rows cost ~10 * 33^2 * 8 B = 87 KB; a 40 KB budget leaves the largest out
R.opts.aacPointsBytesBudget = 40000;
p = plan(mk([29, 29, 29, 29, 29, 5, 5, 5, 5, 5]), true);
ok(p && p.bytes <= 40000, `the list fits the byte budget (${p && p.bytes})`);
ok(
  p && p.rowsPts < 10 && p.rowsPts >= 5,
  `the largest rows left first (${p && p.rowsPts} rows stay)`,
);
delete R.opts.aacPointsBytesBudget;
R.opts.aacPointsRunsMax = 2;
ok(plan(mk([4, 100, 4, 100, 4])) === null, 'more runs than aacPointsRunsMax keeps one draw');
delete R.opts.aacPointsRunsMax;
ok(plan(mk([4, 100], { masks: true })) === null, 'a mask keeps one draw');
const desc = mk([4, 4]);
desc.rows = new Uint16Array([1, 0]);
ok(plan(desc) === null, 'rows not in ascending draw order keep one draw');

// (d) scale-free: 2^20 em units at 2^-20 px per em plan like 1 em at 1 px per em
const big = mk([4, 4, 100]);
const k = 2 ** 20,
  bigS = mk([4 * k, 4 * k, 100 * k]);
bigS.plan = null;
bigS.rowGeom = null;
const pb = G.rowPlan(bigS, [1 / k, 0, 0, 1 / k], 1, 1, 1 / k, 0, 0, 1 / k, true);
const pa = plan(big);
ok(
  pa && pb && pa.runs.map((r) => r.pts).join() === pb.runs.map((r) => r.pts).join(),
  'the classes are the same at 2^20 of the em scale',
);

// (e) E_MIN on the pick: one cubic row 10 em wide
const meta = new Float32Array(48);
meta[0] = 0;
meta[1] = 0;
meta[2] = 10;
meta[3] = 10;
meta[7] = 1;
const bundle = {
  numShapes: 1,
  metaFloats: meta,
  metaFloatsPerShape: 48,
  _geomGen: 0,
  segTypeMask: 4,
  globalBBox: [0, 0, 10, 10],
  curveFloats: Float32Array.from({ length: 16 }, (_, k) =>
    k === 0 ? SEG_CUBIC : k < 4 ? 0 : k * 0.5,
  ),
  curveRangesByShape: [{ begin: 0, end: 16 }],
};
const R2 = {
  opts: { lbMinBundlePx2: 0 },
  viewportSize: () => [100, 100],
  arScale: () => [1, 1],
  draw: {},
  _preferNoAa: () => false,
  _preferNoAaMixed: () => false,
};
const meshes = [{ vertexCount: 3, verts: new Float32Array(3) }];
const noMin = lbShapePicks(R2, bundle, meshes);
R2.opts.lbMinExtentPx = 8; // 10 em at 10 px/em = 100 px: over
const over = lbShapePicks(R2, bundle, meshes);
R2.opts.lbMinExtentPx = 200;
R2.opts.lbMinExtentShare = 0; // under
const under = lbShapePicks(R2, bundle, meshes);
ok(
  noMin && noMin[0] === 1 && over && over[0] === 1,
  'E over E_MIN: the row keeps its mesh pick (non-vacuous: the policy picks it with E_MIN off)',
);
ok(!under || under[0] !== 1, 'E under E_MIN: the row keeps its cover quad');

// (e2) the share rule: 1 of 20 rows under E_MIN (5%) leaves the picks alone; 5 of 20 (25%) applies it
{
  const mkB = (nSmall) => {
    const n = 20,
      m = new Float32Array(48 * n);
    for (let i = 0; i < n; i++) {
      const w = i < nSmall ? 0.2 : 10;
      m[48 * i + 2] = w;
      m[48 * i + 3] = w;
      m[48 * i + 7] = 1;
    }
    return {
      numShapes: n,
      metaFloats: m,
      metaFloatsPerShape: 48,
      _geomGen: 0,
      segTypeMask: 4,
      globalBBox: [0, 0, 10, 10],
      curveFloats: Float32Array.from({ length: 16 * n }, (_, k) =>
        k % 16 === 0 ? SEG_CUBIC : k % 16 < 4 ? 0 : (k % 16) * 0.5,
      ),
      curveRangesByShape: Array.from({ length: n }, (_, i) => ({
        begin: 16 * i,
        end: 16 * i + 16,
      })),
    };
  };
  const ms = Array.from({ length: 20 }, () => ({ vertexCount: 3, verts: new Float32Array(3) }));
  const R3 = {
    opts: { lbMinExtentPx: 8, lbMinBundlePx2: 0 },
    viewportSize: () => [100, 100],
    arScale: () => [1, 1],
    draw: {},
    _preferNoAa: () => false,
    _preferNoAaMixed: () => false,
  };
  const few = lbShapePicks(R3, mkB(1), ms),
    many = lbShapePicks(R3, mkB(5), ms);
  ok(
    few && few[0] === 1,
    'one small row of 20 (5%): E_MIN does not apply, the small row keeps its mesh pick',
  );
  ok(
    many && many[0] !== 1 && many[19] === 1,
    'five of 20 (25%): E_MIN applies, the small rows go to cover, the large ones keep their mesh',
  );
}

// (f) costing
bundle._lbMeshes = meshes;
attachRouteBytes(R2);
const e = R2.estimateRouteBytes(bundle, { perRow: true, viewport: [100, 100] });
const b = e.bundles[0];
ok(
  b.cover.tex > 0 && Math.abs(b.perRow.cover[0] - (16 * 4 + 48 * 4)) < 1e-6,
  `row cover bytes = its curve floats + its meta row (${b.perRow.cover[0]})`,
);
ok(
  Math.abs(b.perRow.aacPoints[0] - 8 * (10 * 10 + 3) * (10 * 10 + 3)) < 1e-6,
  `points bytes = 8 B x (k w + 3)(k h + 3) (${b.perRow.aacPoints[0]})`,
);
ok(
  b.perRow.loopBlinn[0] === 3 * 96,
  `a built mesh costs its vertex bytes (${b.perRow.loopBlinn[0]})`,
);
ok(b.cachedRaster.tex === 100 * 100 * 4, 'default cache estimate retains only RGBA8 color');
R2.opts.cacheKeepDepthStencil = true;
ok(
  R2.estimateRouteBytes(bundle, { viewport: [100, 100] }).bundles[0].cachedRaster.tex ===
    100 * 100 * 8,
  'retained depth/stencil adds four bytes per pixel',
);
R2.opts.cacheKeepDepthStencil = false;
// (g) defaults are ON and overridable: an empty option set reads the shipped numbers; setFillPolicyOptions changes and resets them
{
  const Rd = { gl: null, opts: {}, _pendingShaders: [], _pendingPrograms: [], mantleWarn() {} };
  attachAacPointsDraw(Rd);
  const d = Rd.getFillPolicyOptions();
  ok(
    d.aacPointsRowGate === true &&
      d.lbMinExtentPx === 8 &&
      d.lbMinExtentShare === 0.1 &&
      d.aacPointsRowsMin === 128 &&
      d.aacPointsExtMax === 30,
    `default options are the shipped rule (${JSON.stringify(d)})`,
  );
  const e = Rd.setFillPolicyOptions({ aacPointsRowGate: false, lbMinExtentPx: 4, nonsense: 1 });
  ok(
    e.aacPointsRowGate === false && e.lbMinExtentPx === 4 && !('nonsense' in e),
    'setFillPolicyOptions overrides and ignores unknown keys',
  );
  const f = Rd.setFillPolicyOptions({ aacPointsRowGate: null, lbMinExtentPx: null });
  ok(f.aacPointsRowGate === true && f.lbMinExtentPx === 8, 'null restores the default');
}
console.log(fail ? `aacPointsRowGateSmoke FAIL (${fail})` : 'aacPointsRowGateSmoke ok');
process.exit(fail ? 1 : 0);
