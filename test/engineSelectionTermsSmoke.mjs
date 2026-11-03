// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Check engine-selection inputs: device-space size, cover-kernel cost, row eligibility
// and the distinction between explicit automatic selection and restoring defaults.
// Equivalent geometry at the same drawn scale must select the same route.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { shapeSegStats } = await import('../src/renderer/shapeStats.js');
// NAMESPACE IMPORTS, not named ones, and deliberately. A named import of a symbol a module does not
// export is a LINK error: the file never runs, every assertion in it is skipped, and "it fails on
// another source tree" then means only that a name is missing. Through a namespace the same case
// comes out as the assertions below failing one at a time, which is the thing worth reading — and
// it doubles as a rename guard.
await import('../src/renderer/features/cpatch.js');
const P = await import('../src/renderer/lbShapePolicy.js');
const CK = await import('../src/renderer/coverKernelPolicy.js').catch(() => ({}));
const {
  lbShapePicks,
  lbShapeMayPick,
  lbBuildSkipMask,
  lbBundleMayPick,
  LB_CONVEX_CROSS,
  LB_CONVEX_MIN_PX2_PER_SEG,
  LB_CONVEX_MIN_SEGS,
  LB_PICK_MIN_INTERVAL_MS,
} = P;
const minPx2PerSegFor = P.minPx2PerSegFor || (() => NaN);
const aacVoteShipped = CK.aacVoteShipped || (() => null);
const aacTypeFloor = CK.aacTypeFloor || (() => NaN);
const AAC_MIN_PX2 = CK.AAC_MIN_PX2 || [];
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
const { isStrokeRow } = await import('../src/renderer/engineLedger.js');
const { SEG_CUBIC, SEG_ARC } = await import('../src/primitives/seg.js');
const LB = await import('../src/renderer/loopBlinn.js');
// These cases pin the per-shape rule without the on-screen size term (small bundles, 24-1024 px): the term is off here.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__LB_MIN_BUNDLE_PX2 = 0;

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const f = (v) => v.toFixed(3);

// ── artwork ────────────────────────────────────────────────────────────────────────────────────
function cubicCircle(cx, cy, r, n) {
  const k = (4 / 3) * Math.tan(Math.PI / (2 * n));
  let d = '';
  for (let i = 0; i < n; i++) {
    const t0 = (2 * Math.PI * i) / n,
      t1 = (2 * Math.PI * (i + 1)) / n;
    const p0 = [cx + r * Math.cos(t0), cy + r * Math.sin(t0)],
      p1 = [cx + r * Math.cos(t1), cy + r * Math.sin(t1)];
    const c1 = [p0[0] - k * r * Math.sin(t0), p0[1] + k * r * Math.cos(t0)];
    const c2 = [p1[0] + k * r * Math.sin(t1), p1[1] - k * r * Math.cos(t1)];
    if (i === 0) d = `M${f(p0[0])} ${f(p0[1])}`;
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p1[0])} ${f(p1[1])}`;
  }
  return d + ' Z';
}
function cubicStar(cx, cy, R, r, k) {
  const pts = [];
  for (let i = 0; i < 2 * k; i++) {
    const rad = i % 2 ? r : R,
      t = (Math.PI * i) / k - Math.PI / 2;
    pts.push([cx + rad * Math.cos(t), cy + rad * Math.sin(t)]);
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < 2 * k; i++) {
    const a = pts[i],
      b = pts[(i + 1) % (2 * k)];
    d += ` C${f(a[0] + (b[0] - a[0]) / 3)} ${f(a[1] + (b[1] - a[1]) / 3)} ${f(a[0] + (2 * (b[0] - a[0])) / 3)} ${f(a[1] + (2 * (b[1] - a[1])) / 3)} ${f(b[0])} ${f(b[1])}`;
  }
  return d + ' Z';
}

async function load(svg) {
  const b = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const input = {
    curveFloats: new Float32Array(b.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: b.curveRangesByShape,
    numShapes: b.numShapes,
  };
  return {
    input,
    bundle: {
      curveFloats: input.curveFloats,
      curveRangesByShape: b.curveRangesByShape,
      numShapes: b.numShapes,
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      segTypeMask: b.segTypeMask,
      globalBBox: b.globalBBox,
      _geomGen: 0,
      noAaFill: !!b.noAaFill,
      noAaMixed: !!b.noAaMixed,
      fillNormByShape: b.fillNormByShape || null,
    },
  };
}
const svgOf = (paths, vb = 1000) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}">${paths.join('')}</svg>`;

/// The renderer's own aspect-preserving fit, so a px² here is a px² the renderer would compute.
const rendererAt = (N, extra) =>
  Object.assign(
    {
      viewportSize: () => [N, N],
      arScale: (bb, vw, vh) => {
        const c = vw / vh,
          s = bb[2] / bb[3];
        return s > c ? [1, c / s] : [s / c, 1];
      },
      draw: {},
      opts: {},
      _lbFillMode: 'auto',
    },
    extra || {},
  );
const fresh = (b) => ({ ...b, _lbPickCache: null, _lbPickKey: 0 });
const count = (p) => (p ? p.reduce((a, v) => a + v, 0) : 0);

console.log('the on-screen size exclusion');

// ── 1a. there is no general term, not even a dormant one ────────────────────────────────────────
// Timed within one run it loses on the reference asset (tiger 1.27x slower at 128, A/A 0.1%), so
// there is no term and no switch for one. A switch nothing sets is a question nobody answered; this
// goes red if either appears.
ok(
  P.lbMinPx2PerSeg === undefined && P.LB_SIZE_PX2_PER_SEG === undefined,
  'the declined general size term is not exported',
);
{
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const pathMod = await import('path');
  const src = readFileSync(
    pathMod.resolve(
      pathMod.dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'renderer',
      'lbShapePolicy.js',
    ),
    'utf8',
  );
  ok(!/__LB_SIZE_TERM/.test(src), '...and no switch reads it');
}

// ── 1b. the exclusion names the sweep's own cell ────────────────────────────────────────────────
const CIRCLE = `<path fill="#264" d="${cubicCircle(500, 500, 400, 64)}"/>`;
const STAR = `<path fill="#246" d="${cubicStar(500, 500, 440, 180, 16)}"/>`;
const SMALLBLOB =
  '<path fill="#822" d="M480 480 C470 470 530 470 520 480 C530 490 470 490 480 480 Z"/>';

const L1 = await load(svgOf([CIRCLE]));
const st1 = shapeSegStats(L1.bundle);
// Synthetic meshes, not buildLbBundle's: a 64-cubic circle is RECOGNIZED as a circle primitive, and
// a primitive is taken at every size before any floor is asked. These rows carry no `prim`, so what
// decides them is the size floor and nothing else.
const M1 = Array.from({ length: L1.bundle.numShapes }, () => ({ vertexCount: 3 }));
const row0 = 0;
ok(
  stats0(st1, row0).segs >= LB_CONVEX_MIN_SEGS && stats0(st1, row0).cross <= LB_CONVEX_CROSS,
  `the 64-cubic circle is the sweep's own cell (segs ${stats0(st1, row0).segs}, cross ${stats0(st1, row0).cross.toFixed(2)})`,
);
function stats0(s, r) {
  return { segs: s.segs[r], cross: s.cross[r], types: s.types[r] };
}
ok(
  minPx2PerSegFor(L1.bundle.metaFloats, L1.bundle.metaFloatsPerShape, row0, st1, false, false) ===
    LB_CONVEX_MIN_PX2_PER_SEG,
  `...and gets the measured floor (${LB_CONVEX_MIN_PX2_PER_SEG} px²/seg)`,
);

// ── 1c. ...and nothing the sweep did not measure ────────────────────────────────────────────────
const L2 = await load(svgOf([SMALLBLOB]));
const st2 = shapeSegStats(L2.bundle);
ok(
  st2.segs[0] < LB_CONVEX_MIN_SEGS &&
    minPx2PerSegFor(L2.bundle.metaFloats, L2.bundle.metaFloatsPerShape, 0, st2, false, false) === 0,
  `a ${st2.segs[0]}-cubic blob is outside the measured cell, so it has no size condition`,
);
const L3 = await load(svgOf([STAR]));
const M3 = buildLbBundle(L3.input).packed;
ok(
  count(lbShapePicks(rendererAt(24), fresh(L3.bundle), M3)) === 1 &&
    count(lbShapePicks(rendererAt(2048), fresh(L3.bundle), M3)) === 1,
  'a star is not compact convex, so it takes its mesh at 24 px and at 2048 px alike',
);

// ── 1d. the same shape decides differently at two on-screen sizes ───────────────────────────────
ok(
  count(lbShapePicks(rendererAt(24), fresh(L1.bundle), M1)) === 0 &&
    count(lbShapePicks(rendererAt(2048), fresh(L1.bundle), M1)) === 1,
  'the SAME circle takes its cover quad at 24 px and its mesh at 2048 px',
);

// ── 1e. DEVICE pixels, not authored units ───────────────────────────────────────────────────────
// A verdict that moves with the size the artwork was authored at is a defect. The same
// outline authored 64x larger, drawn to the same canvas, must decide identically.
const big = await load(
  svgOf([`<path fill="#264" d="${cubicCircle(32000, 32000, 25600, 64)}"/>`], 64000),
);
const Mbig = Array.from({ length: big.bundle.numShapes }, () => ({ vertexCount: 3 }));
let equivariant = true;
const seen = new Set();
for (const N of [24, 64, 256, 2048]) {
  const a = count(lbShapePicks(rendererAt(N), fresh(L1.bundle), M1));
  const b = count(lbShapePicks(rendererAt(N), fresh(big.bundle), Mbig));
  if (a !== b) equivariant = false;
  seen.add(a);
}
// Non-vacuous only if the answer MOVES across these sizes; a shape that decides one way everywhere
// is equivariant for free.
ok(
  equivariant && seen.size === 2,
  'the same circle authored 64x larger decides the same at every canvas size — the floor is on DEVICE pixels',
);

// ── 1f. the size floor must NOT reach the build gate ────────────────────────────────────────────
// lbShapeMayPick is the size-INDEPENDENT half: a row it declines can never pick at ANY scale, and
// the build gate is that predicate turned around. A size floor leaking into it would skip the mesh
// of a row that is small today and large after a zoom, and the shape would draw its cover quad for
// good — correct pixels, silently.
{
  ok(
    lbShapeMayPick(L1.bundle, 0, st1) === true,
    'the circle is buildable even at a size the policy declines it at',
  );
  const skip = lbBuildSkipMask(L1.bundle);
  ok(!skip || !skip[0], '...and the build skip mask does not skip it');
}

console.log('\nthe no-AA question, per shape');

// A bundle that band-hard applies to whole: every fill covered by an opaque stroke, plus a
// recognized primitive. The shipped route asks ONE question of it and answers with the primitive.
const COVERED = svgOf([
  `<path fill="#246" stroke="#000" stroke-width="40" d="${cubicStar(500, 500, 440, 180, 16)}"/>`,
  '<circle cx="500" cy="500" r="120" fill="#c33" stroke="#000" stroke-width="40"/>',
]);
const L4 = await load(COVERED);
const M4 = buildLbBundle(L4.input).packed;
const primRows = M4.map((m, i) => (m && m.prim ? i : -1)).filter((i) => i >= 0);
ok(
  primRows.length > 0,
  `the circle is recognized as a primitive (row${primRows.length > 1 ? 's' : ''} ${primRows.join(', ')})`,
);
{
  const plain = lbShapePicks(rendererAt(1024), fresh(L4.bundle), M4);
  const hard = lbShapePicks(rendererAt(1024, { _preferNoAa: () => true }), fresh(L4.bundle), M4);
  ok(
    count(plain) > primRows.length,
    `with an AA cover kernel ${count(plain)} rows take their mesh, more than the ${primRows.length} primitive row(s)`,
  );
  ok(
    count(hard) === primRows.length && primRows.every((r) => hard[r] === 1),
    'with the fill edges proven stroke-covered ONLY the primitives do — one analytic distance each, with no edge to leave un-antialiased',
  );
  ok(
    plain !== hard,
    '...and the two are different answers, so the no-AA state is part of what the cache is keyed on',
  );
}
{
  // ...and the floors are constants: a sweep switch that raises the admission does not exist, so
  // setting it admits nothing.
  const Rh = rendererAt(1024, { _preferNoAa: () => true });
  globalThis.__LB_NOAA_PX2_PER_SEG = 1e-9;
  const hard = lbShapePicks(Rh, fresh(L4.bundle), M4);
  delete globalThis.__LB_NOAA_PX2_PER_SEG;
  ok(
    count(hard) === primRows.length,
    'the no-AA floor is a constant: an __LB_NOAA_PX2_PER_SEG switch admits nothing',
  );
}
{
  // The route-level veto must not fire where the per-shape policy runs, or the per-row answer
  // above is computed and then thrown away by a gate one level up.
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const pathMod = await import('path');
  const SRC = pathMod.resolve(
    pathMod.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'renderer',
  );
  const src = readFileSync(pathMod.join(SRC, 'renderer.js'), 'utf8');
  ok(
    /perShapePolicy\s*=\s*R\._lbFillMode === 'auto'/.test(src),
    '_staticRouteWanted names the case where a per-shape policy runs',
  );
  ok(
    /!forceUnified\s*&&\s*!perShapePolicy\s*&&\s*R\._preferNoAa/.test(src.replace(/\r/g, '')),
    '...and the whole-bundle no-AA veto is gated on it',
  );
}

console.log('\nthere is no per-row cover vote');

// A per-row vote -- AAC's per-type thresholds asked of the rows that take a cover quad, and an area
// majority taken -- is 1.73-1.81x SLOWER on the GPU wherever it adds AAC: it prices the kernel's speed
// and not its presence. So there is none, and nothing may read a switch for one.
{
  const { readFileSync, readdirSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const pathMod = await import('path');
  const SRC = pathMod.resolve(
    pathMod.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'renderer',
  );
  const readers = readdirSync(SRC).filter(
    (f) => f.endsWith('.js') && /__COVER_VOTE/.test(readFileSync(pathMod.join(SRC, f), 'utf8')),
  );
  ok(
    readers.length === 0,
    `no renderer module reads __COVER_VOTE (${readers.join(', ') || 'none'})`,
  );
  ok(
    CK.aacVote === undefined && CK.coverVoteRows === undefined,
    'coverKernelPolicy exports neither aacVote nor coverVoteRows',
  );
  // One property the vote addresses holds of the shipped rule too: one arc row sets the bundle-wide bar
  // to infinity.
  const ARCMIX = svgOf([
    `<path fill="#264" d="${cubicCircle(500, 400, 380, 64)}"/>`,
    '<path fill="#c33" d="M100 900 A 20 20 0 0 1 140 900 L 140 940 L 100 940 Z"/>',
  ]);
  const L5 = await load(ARCMIX);
  ok(
    !Number.isFinite(aacTypeFloor(L5.bundle.segTypeMask | 0 || 0xf)),
    'the bundle-wide type bar is infinite when one row holds an arc',
  );
  ok(
    aacVoteShipped(L5.bundle, 4) === false,
    '...so the shipped rule gives such a bundle Slug at any size',
  );
  ok(
    AAC_MIN_PX2[SEG_ARC] === Number.POSITIVE_INFINITY,
    '...with the arc constant itself untouched',
  );
}

console.log('\ncommitting to the policy, and saying so');

const glStub = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );
function makeRenderer() {
  const R = {
    gl: glStub(),
    opts: {},
    draw: {},
    _lbFillMode: 'auto',
    _lbAutoExplicit: false,
    _lbSlugOnly: false,
    _lbSlugFallback: true,
  };
  Object.assign(R, {
    buildLoopBlinnMesh: LB.buildLoopBlinnMesh,
    buildLoopBlinnCDT: LB.buildLoopBlinnCDT,
    refreshLoopBlinnMesh: LB.refreshLoopBlinnMesh,
    packLoopBlinnMesh: LB.packLoopBlinnMesh,
    curveRangeToContours: LB.curveRangeToContours,
    lbCanonicalFrame: LB.lbCanonicalFrame,
    lbCanonicalHash: LB.lbCanonicalHash,
    lbCanonicalHashes: LB.lbCanonicalHashes,
    transformLoopBlinnRaw: LB.transformLoopBlinnRaw,
  });
  attachMorphDraw(R);
  return R;
}
// The API surface, through the same source the renderer exposes it from: the setter has to write
// the flag the gate reads, `commit: false` has to clear it, and getFillEngine has to report it.
// Asserted against the SOURCE because createRenderer needs a live GL context; the behavior of the
// flag itself is covered by lbBuildGateSmoke.
{
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const pathMod = await import('path');
  const SRC = pathMod.resolve(
    pathMod.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'renderer',
  );
  const src = readFileSync(pathMod.join(SRC, 'renderer.js'), 'utf8');
  ok(
    /if \(r === 'auto' && sel\.commit === false\) R\._lbAutoExplicit = false;/.test(src),
    "setFillEngine({route:'auto', commit:false}) returns to the DEFAULT 'auto' without the build commitment",
  );
  ok(
    /routeCommitted:\s*R\._lbFillMode === 'auto'\s*&&\s*R\._lbAutoExplicit === true/.test(src),
    'getFillEngine reports which of the two states you are in — they route identically and BUILD differently',
  );
  const api = readFileSync(pathMod.join(SRC, 'rendererApi.js'), 'utf8');
  ok(
    /commit\?: boolean/.test(api) && /routeCommitted: boolean/.test(api),
    '...and the typedef names both, so a caller can find them',
  );
}
// The build admission and the per-shape predicate must agree: a line-only bundle has no row that can ever take its mesh,
// so the per-shape predicate declines every row and the build admission declines the bundle.
{
  const LQ = svgOf([
    '<path fill="#333" d="M100 100 L900 100 L900 200 L200 200 L200 800 L900 800 L900 900 L100 900 Z"/>',
  ]);
  const L6 = await load(LQ);
  ok(
    lbBundleMayPick(L6.bundle) === false,
    'a line-only bundle is declined by the build admission, as it should be',
  );
  const s = shapeSegStats(L6.bundle);
  let anyRow = false;
  for (let r = 0; r < L6.bundle.numShapes; r++) if (lbShapeMayPick(L6.bundle, r, s)) anyRow = true;
  ok(anyRow === false, '...and the per-shape predicate takes no row of it, so the two agree');
}

// Import-time multi-contour fill certification (fillNormByShape) feeds the decision tree with zero extra passes:
//   * a certified 0/1 arc ring records fillNorm = 1;
//   * a well-formed nonzero multi-contour shape needing no boundary reversal keeps fillNorm = 0 (not -1);
//   * an uncertified crossing multi-contour shape records fillNorm = -1 and keeps its CDT-resolved LB mesh across sizes;
//   * droppedContourIndices only marks status = 1 when the remaining kept polygons do not cross;
//   * AAC's arc floor stays Infinity (GPU speed constant) and fillNorm < 0 does not poison aacBundleFloor.
{
  const { normalizedFillSegs, FILL_NORM_DECLINED } = await import('../src/svg/fillNormalize.js');
  const arcCircle = (cx, cy, r) =>
    `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  const CERT_ARC_RING = svgOf([
    `<path fill="#264" fill-rule="evenodd" d="${arcCircle(500, 500, 300)} ${arcCircle(500, 500, 150)}"/>`,
  ]);
  const DISJOINT_QUAD = svgOf([
    '<path fill="#264" d="M100 300 Q 200 100 300 300 Q 200 500 100 300 Z M600 300 Q 700 100 800 300 Q 700 500 600 300 Z"/>',
  ]);
  const DECLINED_CROSS = svgOf([
    `<path fill="#624" d="${cubicCircle(420, 500, 260, 32)} ${cubicCircle(580, 500, 260, 32)}"/>`,
  ]);
  const Lcert = await load(CERT_ARC_RING);
  const Ldisj = await load(DISJOINT_QUAD);
  const Ldecl = await load(DECLINED_CROSS);
  ok(
    Lcert.bundle.fillNormByShape && Lcert.bundle.fillNormByShape[0] === 1,
    'certified 0/1 multi-contour arc ring records fillNormByShape[0] === 1 from import-time normalization',
  );
  ok(
    !Ldisj.bundle.fillNormByShape || Ldisj.bundle.fillNormByShape[0] === 0,
    'well-formed disjoint multi-contour shape needing no boundary reversal keeps fillNorm === 0 (never falsely marked declined)',
  );
  ok(
    Ldecl.bundle.fillNormByShape && Ldecl.bundle.fillNormByShape[0] === -1,
    'crossing multi-contour cubic shape records fillNormByShape[0] === -1 when certification declines',
  );
  ok(
    !Number.isFinite(CK.aacRowFloor(1 << SEG_ARC, 1)) &&
      !Number.isFinite(CK.aacRowFloor(1 << SEG_ARC, 0)),
    'SEG_ARC keeps its infinite AAC floor regardless of fillNorm (aacArcContrib is slower than arc crossing at all sizes)',
  );
  ok(
    CK.aacRowFloor(1 << SEG_CUBIC, -1) === AAC_MIN_PX2[SEG_CUBIC] &&
      aacVoteShipped(Ldecl.bundle, 1) === true,
    'fillNorm < 0 does not poison aacRowFloor or aacBundleFloor with Infinity on the cover route',
  );
  const stDecl = shapeSegStats(Ldecl.bundle);
  const Mdecl = [{ vertexCount: 3 }];
  ok(
    minPx2PerSegFor(
      Ldecl.bundle.metaFloats,
      Ldecl.bundle.metaFloatsPerShape,
      0,
      stDecl,
      false,
      false,
      -1,
    ) === 0 &&
      count(
        lbShapePicks(
          rendererAt(24, { opts: { lbMinExtentPx: 200, lbMinExtentShare: 0 } }),
          fresh(Ldecl.bundle),
          Mdecl,
        ),
      ) === 1,
    'declined multi-contour cubic keeps its CDT-resolved Loop-Blinn mesh rather than dropping to an unnormalized cover quad',
  );
  // 3-contour polygon where contour 2 is inside contour 0 (dropped) while contours 0 and 1 cross each other:
  const polyRect = (x0, y0, x1, y1) => [
    { type: 0, p1: [x0, y0], p2: [x1, y0] },
    { type: 0, p1: [x1, y0], p2: [x1, y1] },
    { type: 0, p1: [x1, y1], p2: [x0, y1] },
    { type: 0, p1: [x0, y1], p2: [x0, y0], is_fill_only: true },
  ];
  const stDropCross = { status: 0 };
  const droppedSegs = normalizedFillSegs(
    [...polyRect(0, 0, 100, 100), ...polyRect(50, 50, 150, 150), ...polyRect(10, 10, 30, 30)],
    false,
    stDropCross,
  );
  ok(
    droppedSegs && droppedSegs.length === 8 && stDropCross.status === FILL_NORM_DECLINED,
    'when droppedContourIndices removes a nested contour but remaining contours still cross, status is FILL_NORM_DECLINED (-1)',
  );
}

console.log('\nCPatch in the auto decision tree where it wins on GPU speed');
{
  const { buildCPatchBundle } = await import('../src/renderer/cpatchBuild.js');
  const { attachAacPointsDraw } = await import('../src/renderer/aacPointsDraw.js');
  const { attachRowEngines, ROW_ENGINE } = await import('../src/renderer/rowEngines.js');
  const { ROW_MESH, ROW_COVER_AA } = await import('../src/renderer/coverKernelPolicy.js');
  // 1) Quadratic shape (3+ spans): default LB auto declines it (only cubics/arcs admitted),
  //    but cpatchAuto admits it and builds a 6-vertex CPK_AREA simple polynomial paint!
  const quadParts = [
    '<path fill="#264" d="M100 500 Q 300 100 500 200 Q 700 100 900 500 Q 500 900 100 500 Z"/>',
    '<circle fill="#c33" cx="500" cy="500" r="120"/>',
    '<path fill="#333" d="M100 100 L300 100 L300 200 L100 200 Z"/>',
  ];
  const QUAD_SVG = svgOf(quadParts);
  const Lquad = await load(QUAD_SVG);
  const stQuad = shapeSegStats(Lquad.bundle);
  ok(
    lbShapeMayPick(Lquad.bundle, 0, stQuad, false) === false,
    'default auto declines a quadratic-only shape (Loop-Blinn only admits cubics and arcs)',
  );
  ok(
    lbShapeMayPick(Lquad.bundle, 0, stQuad, true) === true,
    'cpatchAuto admits a quadratic-only shape into the decision tree',
  );
  ok(
    lbShapeMayPick(Lquad.bundle, 2, stQuad, true) === false,
    'cpatchAuto still declines a line-only shape so it stays on the cover kernel',
  );
  const skipCpatch = lbBuildSkipMask(Lquad.bundle, true);
  ok(
    skipCpatch[0] === 0 && skipCpatch[1] === 1 && skipCpatch[2] === 1,
    'lbBuildSkipMask(bundle, true) admits the quadratic row and skips the primitive and line-only rows',
  );

  // Build CPatch bundle under autoPolicy + skipCpatch:
  const gl = glStub();
  Lquad.bundle.curveTex = { w: 4096 };
  const cpBuilt = buildCPatchBundle(gl, Lquad.bundle, { autoPolicy: true, skip: skipCpatch });
  const cpMeshes = Lquad.bundle._lbMeshes;
  ok(
    cpBuilt === true && cpMeshes && cpMeshes.length === 3,
    'buildCPatchBundle builds the mixed bundle with autoPolicy + skip',
  );
  ok(
    cpMeshes[0].cpatch === true &&
      cpMeshes[0].cpatchAreaOnly === true &&
      cpMeshes[0].vertexCount === 6,
    'quadratic contour packs as a single 6-vertex CPK_AREA simple polynomial paint (cpatchAreaOnly: true)',
  );
  ok(
    cpMeshes[1].prim === true && !cpMeshes[1].cpatch,
    'recognized circle keeps its analytic SDF primitive record (prim: true) instead of being replaced by CPatch',
  );
  ok(
    cpMeshes[2] === null,
    'skipped line-only row builds zero CPatch vertices (null mesh slot) and stays on its cover quad',
  );

  // Verify lbShapePicks & rowEngineCodes under cpatchAuto:
  const Rcp = rendererAt(128, {
    opts: { cpatchAuto: true, lbMinExtentPx: 200, lbMinExtentShare: 0 },
  });
  const Bcp = fresh(Lquad.bundle);
  Bcp._lbMeshes = cpMeshes;
  const picksCp = lbShapePicks(Rcp, Bcp, cpMeshes);
  ok(
    picksCp[0] === 1 && picksCp[1] === 1 && picksCp[2] === 0,
    'lbShapePicks under cpatchAuto picks the CPK_AREA quadratic (bypassing eMin) and SDF circle, leaving line-only on cover',
  );
  const Rrow = {
    gl,
    opts: { cpatchAuto: true, cpatchFill: false },
    draw: { worldM: Rcp.draw.worldM },
    _lbFillMode: 'auto',
    _unifiedRowClasses: () => new Uint8Array([ROW_MESH, ROW_MESH, ROW_COVER_AA]),
  };
  attachRowEngines(Rrow);
  Rrow._noteRowDraw(Bcp, 'unified', null);
  const codes = Rrow.rowEngineCodes(Bcp);
  ok(
    codes[0] === ROW_ENGINE.cpatch && codes[1] === ROW_ENGINE.sdf && codes[2] === ROW_ENGINE.cover,
    'rowEngineCodes attributes the quadratic row to ROW_ENGINE.cpatch, the circle to ROW_ENGINE.sdf, and the line row to cover',
  );

  // 2) Compact convex cubic at small size (24 px):
  //    First verify that a 64-segment cubic circle recognized as an ellipse primitive keeps prim: true!
  const CONV_CUBIC = svgOf([`<path fill="#264" d="${cubicCircle(500, 500, 380, 64)}"/>`]);
  const Lcc = await load(CONV_CUBIC);
  Lcc.bundle.curveTex = { w: 4096 };
  buildCPatchBundle(gl, Lcc.bundle, { autoPolicy: true });
  ok(
    Lcc.bundle._lbMeshes[0].prim === true && !Lcc.bundle._lbMeshes[0].cpatch,
    '64-segment cubic circle recognized as an ellipse primitive keeps its SDF primitive record',
  );
  //    And on a non-ellipse compact convex cubic (or CPatch mesh on the 64-cubic cell),
  //    CPatch bypasses LB's 200 px²/seg triangle-count exclusion at 24 px:
  const cpCubicMesh = [
    { cpatch: true, cpatchAreaOnly: true, vertexCount: 6, dropped: 0, unresolved: 0 },
  ];
  const R24cp = rendererAt(24, { opts: { cpatchAuto: true } });
  ok(
    count(lbShapePicks(R24cp, fresh(Lcc.bundle), cpCubicMesh)) === 1,
    'at 24 px, cpatchAuto picks the 6-vertex CPatch cubic paint where LB dropped to cover due to cubic crescent triangle count',
  );

  // 3) Stroke-covered noAaFill (hardAll) still drops CPatch to the hard cover kernel:
  const R24hard = rendererAt(512, {
    opts: { cpatchAuto: true, noAaFill: 'strokeCovered' },
    _preferNoAa: () => true,
  });
  const hardParts = [
    '<path fill="#264" stroke="#111" stroke-width="20" d="M100 500 C 200 100 800 100 900 500 C 800 900 200 900 100 500 Z"/>',
  ];
  const Lhard = await load(svgOf(hardParts));
  Lhard.bundle.curveTex = { w: 4096 };
  buildCPatchBundle(gl, Lhard.bundle, {
    autoPolicy: true,
    skip: lbBuildSkipMask(Lhard.bundle, true),
  });
  ok(
    Lhard.bundle._lbMeshes[0].cpatch === true &&
      count(lbShapePicks(R24hard, fresh(Lhard.bundle), Lhard.bundle._lbMeshes)) === 0,
    'under stroke-covered noAaFill (hardAll), cpatchAuto still drops a CPatch fill row to the hard cover kernel',
  );

  // 4) Lossy CPatch mesh (dropped > 0 or unresolved > 0) is declined under cpatchAuto:
  const lossyMeshes = [
    { cpatch: true, cpatchAreaOnly: false, vertexCount: 12, dropped: 1, unresolved: 0 },
  ];
  ok(
    count(
      lbShapePicks(rendererAt(512, { opts: { cpatchAuto: true } }), fresh(Lcc.bundle), lossyMeshes),
    ) === 0,
    'cpatchAuto declines a CPatch mesh with dropped or unresolved contours so it falls back cleanly to the cover kernel',
  );

  // 5) setFillPolicyOptions({ cpatchAuto: true }) and getFillPolicyOptions():
  const Rpol = { opts: {} };
  attachAacPointsDraw(Rpol);
  ok(
    Rpol.getFillPolicyOptions().cpatchAuto === false,
    'getFillPolicyOptions().cpatchAuto defaults to false',
  );
  Rpol.setFillPolicyOptions({ cpatchAuto: true });
  ok(
    Rpol.opts.cpatchAuto === true && Rpol.getFillPolicyOptions().cpatchAuto === true,
    'setFillPolicyOptions({ cpatchAuto: true }) enables cpatchAuto',
  );
  Rpol.setFillPolicyOptions({ cpatchAuto: null });
  ok(
    Rpol.opts.cpatchAuto === undefined && Rpol.getFillPolicyOptions().cpatchAuto === false,
    'setFillPolicyOptions({ cpatchAuto: null }) resets cpatchAuto to default',
  );

  // 6) Morph bundles never route to CPatch under cpatchAuto (only when explicitly pinned via route:'cpatch' / cpatchFill:true),
  //    while static bundles still get the cpatchAuto per-shape decision tree:
  const Rmorph = makeRenderer();
  Rmorph.opts.cpatchAuto = true;
  Rmorph.opts.cpatchFill = false;
  let morphFramesCalled = 0,
    staticBuildsCalled = 0;
  Rmorph._cpatchMorphFrame = () => {
    morphFramesCalled++;
    return true;
  };
  Rmorph._buildCPatchBundle = (b, extraOpts) => {
    staticBuildsCalled++;
    return buildCPatchBundle(gl, b, extraOpts || {});
  };
  const morphBundle = {
    ...fresh(Lquad.bundle),
    _lbMeshes: undefined,
    _morphSrc: { matchedAll: true, curveRanges: Lquad.bundle.curveRangesByShape, t: 0.25 },
  };
  ok(
    Rmorph._cpatchMorphWanted(morphBundle) === false,
    'under cpatchAuto, _cpatchMorphWanted(morphBundle) remains false (morphs do not route to CPatch)',
  );
  ok(
    lbShapeMayPick(morphBundle, 0, stQuad, true) === false &&
      lbBundleMayPick(morphBundle, true) === false,
    'under cpatchAuto, lbShapeMayPick / lbBundleMayPick do not admit a quadratic-only morph bundle to CPatch',
  );
  Rmorph.prepareBundle(morphBundle);
  Rmorph._drawBundleMorphRoute(morphBundle);
  ok(
    morphFramesCalled === 0 && staticBuildsCalled === 0,
    'under cpatchAuto, neither prepareBundle nor _drawBundleMorphRoute invokes CPatch on a morph bundle',
  );

  const staticBundle = {
    ...fresh(Lquad.bundle),
    _lbMeshes: undefined,
    _lbGen: -1,
    curveTex: { w: 4096 },
  };
  ok(
    Rmorph.prepareBundle(staticBundle) === true &&
      staticBuildsCalled === 1 &&
      (staticBundle._cpatchBuilt | 0) > 0,
    'under cpatchAuto, static bundles still build and route through the cpatchAuto per-shape decision tree',
  );

  Rmorph.opts.cpatchAuto = false;
  Rmorph.prepareBundle(staticBundle);
  staticBundle._fillMeshOwner = null;
  staticBundle._lbMeshes = null;
  staticBundle._lbGen = staticBundle._geomGen | 0;
  Rmorph.opts.cpatchAuto = true;
  Rmorph.prepareBundle(staticBundle);
  ok(
    staticBundle._fillMeshOwner === 'cpatch' &&
      (staticBundle._cpatchBuilt | 0) > 0 &&
      staticBundle._lbMeshes.some((m) => m && m.cpatch),
    'reenabling cpatchAuto rebuilds a released static CPatch mesh',
  );

  Rmorph.opts.cpatchFill = true;
  Rmorph.prepareBundle(staticBundle);
  ok(
    staticBundle._fillMeshOwner === 'cpatch' && staticBundle._cpatchAutoBuilt === false,
    'an explicit CPatch pin replaces an automatic build and takes precedence when both flags are set',
  );
  Rmorph.opts.cpatchFill = false;
  Rmorph.opts.cpatchAuto = false;
  Rmorph.prepareBundle(staticBundle);
  ok(
    staticBundle._fillMeshOwner !== 'cpatch' && staticBundle._cpatchBuilt === 0,
    'leaving a pinned CPatch build releases its ownership and success metadata',
  );
  staticBundle._fillMeshOwner = 'lb';
  staticBundle._lbMeshes = [{ vertexCount: 3 }];
  staticBundle._lbGen = staticBundle._geomGen | 0;
  const adoptBefore = staticBundle._lbAdoptKey | 0;
  Rmorph.opts.cpatchFill = true;
  Rmorph.prepareBundle(staticBundle);
  ok(
    staticBundle._fillMeshOwner === 'cpatch' &&
      staticBundle._cpatchAutoBuilt === false &&
      (staticBundle._lbAdoptKey | 0) > adoptBefore,
    'pinning CPatch over an existing LB build invalidates the stream and prepares CPatch',
  );
  Rmorph.opts.cpatchFill = false;
  Rmorph.opts.cpatchAuto = true;

  // 7) Under cpatchAuto, crossing multi-contour shapes (fillNorm < 0) are skipped by buildCPatchBundle without
  //    falling into seam decomposition, and prepareBundle settles cleanly on Loop-Blinn without stale-rebuild loops:
  const CROSS_CUBIC = svgOf([
    `<path fill="#624" d="${cubicCircle(420, 500, 260, 32)} ${cubicCircle(580, 500, 260, 32)}"/>`,
  ]);
  const Lcross = await load(CROSS_CUBIC);
  const crossBundle = {
    ...fresh(Lcross.bundle),
    _lbMeshes: undefined,
    _lbGen: -1,
    curveTex: { w: 4096 },
  };
  ok(
    buildCPatchBundle(gl, crossBundle, { autoPolicy: true }) === false &&
      crossBundle._cpatchAutoTriedGen === (crossBundle._geomGen | 0),
    'under autoPolicy, buildCPatchBundle skips uncertified crossing contours (fillNorm < 0) without seam decomposition and stamps _cpatchAutoTriedGen',
  );
  Rmorph.prepareBundle(crossBundle);
  ok(
    crossBundle._fillMeshOwner === 'lb' && Rmorph._lbBuildStale(crossBundle) === false,
    'when cpatchAuto declines all shapes and falls back to Loop-Blinn, _lbBuildStale is false so the bundle does not loop',
  );

  Rmorph.opts.cpatchFill = true;
  Rmorph.opts.cpatchAuto = false;
  ok(
    Rmorph._cpatchMorphWanted(morphBundle) === true &&
      Rmorph._cpatchMorphWanted(staticBundle) === false,
    'when explicitly pinned via route:cpatch (cpatchFill: true), _cpatchMorphWanted is true for morphs and false for static bundles',
  );
}

console.log(fail ? `\nENGINE-SELECTION-TERMS FAIL (${fail})` : '\nENGINE-SELECTION-TERMS PASS');
process.exit(fail ? 1 : 0);
