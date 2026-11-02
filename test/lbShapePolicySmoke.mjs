// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbShapePolicySmoke.mjs — under 'auto' the analytic route picks Loop-Blinn PER SHAPE.
//
// The unified draw carries mesh entries and cover quads in one stream, so each shape can take the
// engine that wins for it. This pins the rule (lbShapePolicy) and the per-shape facts it reads
// (shapeStats), without a GPU:
//   - a cubic star and the fill row of a stroked cubic star take their mesh at every size;
//   - a quadratic circle never does, and neither does a stroke row;
//   - a compact convex 64-cubic circle takes its cover quad when its segments are small on screen
//     and its mesh when they are large;
//   - the answer is cached: a bundle with no size-dependent shape never recomputes for a zoom, and
//     one with some recomputes when the scale bucket changes (never on a clock), bumping
//     _lbPickKey (the stream cache key) only when the answer changes.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { shapeSegStats } = await import('../src/renderer/shapeStats.js');
const { lbShapePicks, lbBundleMayPick, LB_PICK_MIN_INTERVAL_MS } =
  await import('../src/renderer/lbShapePolicy.js');
const { isStrokeRow } = await import('../src/renderer/engineLedger.js');
const { SEG_QUAD, SEG_CUBIC } = await import('../src/primitives/seg.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
// Everything below but the last section pins the per-shape rule without the on-screen size term, on bundles far
// smaller than its bar at 128 px: the term is off here (the test hook), and the last section turns it on.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__LB_MIN_BUNDLE_PX2 = 0;

const f = (v) => v.toFixed(3);
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
function quadCircle(cx, cy, r, n) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const t0 = (2 * Math.PI * i) / n,
      t1 = (2 * Math.PI * (i + 1)) / n,
      tm = (t0 + t1) / 2,
      rc = r / Math.cos(Math.PI / n);
    if (i === 0) d = `M${f(cx + r * Math.cos(t0))} ${f(cy + r * Math.sin(t0))}`;
    d += ` Q${f(cx + rc * Math.cos(tm))} ${f(cy + rc * Math.sin(tm))} ${f(cx + r * Math.cos(t1))} ${f(cy + r * Math.sin(t1))}`;
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

async function bundleOf(paths) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${paths.join('')}</svg>`;
  const b = await importSvg(svg);
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  return {
    curveFloats: new Float32Array(b.curves),
    curveRangesByShape: b.curveRangesByShape,
    numShapes: b.numShapes,
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    segTypeMask: b.segTypeMask,
    globalBBox: b.globalBBox,
  };
}
const rendererAt = (N) => ({ viewportSize: () => [N, N], arScale: () => [1, 1], draw: {} });
const meshesFor = (b) => Array.from({ length: b.numShapes }, () => ({ vertexCount: 3 }));

const CIRCLE = `<path fill="#264" d="${cubicCircle(250, 250, 200, 64)}"/>`;
const STAR = `<path fill="#246" d="${cubicStar(750, 250, 220, 90, 16)}"/>`;
const QUADS = `<path fill="#642" d="${quadCircle(250, 750, 200, 16)}"/>`;
const STROKED = `<path fill="#466" stroke="#111" stroke-width="6" d="${cubicStar(750, 750, 200, 100, 8)}"/>`;

const b = await bundleOf([CIRCLE, STAR, QUADS, STROKED]);
const stats = shapeSegStats(b);
const meta = b.metaFloats,
  st = b.metaFloatsPerShape;
const rows = { circle: -1, star: -1, quads: -1, strokedFill: -1, strokedStroke: -1 };
for (let s = 0; s < b.numShapes; s++) {
  if (isStrokeRow(meta, st, s)) {
    rows.strokedStroke = s;
    continue;
  }
  if (!(meta[s * st + 7] > 0)) continue;
  if (stats.types[s] & (1 << SEG_QUAD)) rows.quads = s;
  else if (stats.segs[s] >= 64 && stats.cross[s] < 3) rows.circle = s;
  else if (stats.segs[s] >= 32) rows.star = s;
  else rows.strokedFill = s;
}
ok(
  Object.values(rows).every((r) => r >= 0),
  `found every row ${JSON.stringify(rows)}`,
);
ok(
  stats.cross[rows.circle] >= 1.9 && stats.cross[rows.circle] <= 2.2,
  `a convex outline is crossed twice a scanline (${stats.cross[rows.circle].toFixed(2)})`,
);
ok(
  stats.cross[rows.star] > 5,
  `a 16-point star is crossed far more (${stats.cross[rows.star].toFixed(2)})`,
);
ok(
  stats.types[rows.circle] & (1 << SEG_CUBIC) && !(stats.types[rows.quads] & (1 << SEG_CUBIC)),
  'segment types are per shape',
);
ok(lbBundleMayPick(b), 'a bundle with cubic fills is worth building meshes for');
ok(!lbBundleMayPick(await bundleOf([QUADS])), 'a quadratic-only bundle is not');

const meshes = meshesFor(b);
const small = lbShapePicks(rendererAt(128), b, meshes);
ok(
  small && small[rows.star] === 1 && small[rows.strokedFill] === 1,
  'cubic stars take their mesh (the stroked one on its fill row)',
);
ok(
  small[rows.quads] === 0 && small[rows.strokedStroke] === 0,
  'the quadratic circle and the stroke row keep their cover quads',
);
ok(
  small[rows.circle] === 0,
  'the compact convex circle keeps its cover quad when its segments are small on screen',
);
const key0 = b._lbPickKey | 0;
const again = lbShapePicks(rendererAt(2048), b, meshes);
ok(again !== small && again[rows.circle] === 1, 'a zoom to a new scale bucket recomputes at once');
const large = lbShapePicks(rendererAt(2048), b, meshes);
ok(large && large[rows.circle] === 1, 'the circle, now large on screen, takes its mesh');
ok((b._lbPickKey | 0) === key0 + 1, 'and the stream key moved exactly once');
lbShapePicks(rendererAt(2048 * 1.1), b, meshes);
ok((b._lbPickKey | 0) === key0 + 1, 'a recompute with the same answer leaves the stream key alone');

// the size exclusion names only compact convex cubics, so a bundle without one is SCALE-FREE:
// it answers the same at 128 px and at 4096 and never recomputes for a zoom. (There is no general
// size term: it would make every pickable row scale-dependent.)
const free = await bundleOf([STAR, QUADS]);
const fm = meshesFor(free);
const o0 = lbShapePicks(rendererAt(128), free, fm);
const o1 = lbShapePicks(rendererAt(4096), free, fm);
ok(
  free._lbPickCache.scaleFree === true && o1 === o0,
  'the exclusion names no shape here, so the bundle is scale-free',
);

// ── THE ON-SCREEN SIZE TERM: the shipped bar, 512 x 512 device px2 of fill bbox ──────────────────────
delete globalThis.__LB_MIN_BUNDLE_PX2;
{
  const scaledBundle = async (S) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${1000 * S} ${1000 * S}"><g transform="scale(${S})">${[CIRCLE, STAR, QUADS, STROKED].join('')}</g></svg>`;
    const bb = await importSvg(svg),
      pm = parseMetaBin(bb.meta, bb.metaFloatsPerShape);
    return {
      curveFloats: new Float32Array(bb.curves),
      curveRangesByShape: bb.curveRangesByShape,
      numShapes: bb.numShapes,
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      segTypeMask: bb.segTypeMask,
      globalBBox: bb.globalBBox,
    };
  };
  // (a zoom inside the rate limit is served from the cache: age it, as the cache cases above do)
  const picksAt = (bu, N) => {
    const r = lbShapePicks(rendererAt(N), bu, meshesFor(bu));
    return r ? Array.from(r).join('') : null;
  };
  const tb = await bundleOf([CIRCLE, STAR, QUADS, STROKED]);
  const held = picksAt(tb, 512),
    taken = picksAt(tb, 768);
  ok(
    held === null,
    'a bundle whose fill bboxes cover under 512 x 512 device px2 (here at 512 px) stays on the cover kernel entirely',
  );
  ok(
    taken !== null && taken[rows.star] === '1',
    'the same bundle drawn larger (768 px, past the bar) takes its meshes',
  );
  for (const S of [2 ** -12, 2 ** 12]) {
    const sb = await scaledBundle(S);
    ok(
      picksAt(sb, 512) === held && picksAt(sb, 768) === taken,
      `authored at 2^${Math.round(Math.log2(S))} times the size it answers the same at 512 and 768 px: the term is a render-time size`,
    );
  }
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__LB_MIN_BUNDLE_PX2 = 1e12;
  ok(
    picksAt(await bundleOf([CIRCLE, STAR, QUADS, STROKED]), 4096) === null,
    'the test hook replaces the bar (a huge bar holds even a large draw)',
  );
  globalThis.__LB_MIN_BUNDLE_PX2 = 0;
  ok(
    picksAt(await bundleOf([CIRCLE, STAR, QUADS, STROKED]), 512) !== null,
    '...and 0 turns the term off',
  );
  delete globalThis.__LB_MIN_BUNDLE_PX2;
  delete globalThis.__MANTLE_DEBUG__;
}

if (fail) {
  console.log(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log('\nlbShapePolicySmoke: per-shape LB picks, their facts and their cache');
