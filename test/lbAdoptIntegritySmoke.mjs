// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbAdoptIntegritySmoke.mjs — adopting shapes must never LOSE one, and every cache that depends on
// the mesh set must move when it changes.
//
// A shape lost in per-shape adoption is silent: the picture stays correct, because a shape that
// loses its mesh draws its cover quad and Slug is reference-exact. Only the route counters and a
// memory figure show it, and a memory figure that changes from run to run reads as flakiness
// rather than as a defect. So the invariants are pinned here:
//
//   1. THE STREAM IS COMPLEMENTARY. The worker posts each shape exactly ONCE — a shape that went out
//      in a batch is deliberately absent from the final tail, because its buffer went with the batch.
//      Both halves are therefore required, and a batch dropped on the main thread is a mesh gone for
//      good, folded back as a Slug sentinel.
//
//   2. THE FOLD IS LOSSLESS. Folding batches + tail reproduces the unstreamed build exactly, byte for
//      byte, whatever the flush boundaries were — which is what makes the memory accounting a fixed
//      number instead of a function of timing.
//
//   3. every MESH-SET CACHE MOVES. Adoption changes which engine draws a shape WITHOUT moving the
//      geometry generation, so anything keyed on the generation alone goes stale: the kind mask
//      (the variant would compile out a kind that arrived late) and the filter result cache (a shape
//      filtered on its cover quad would keep that image after its mesh landed).
//
//   4. ...EXCEPT A CACHED RASTER, which follows the single FULL-QUALITY edge instead. Invalidating
//      it per batch would re-bake its way through the whole build, which is the cache defeating
//      itself; never invalidating it would leave a long-lived cached handle on its cover-kernel
//      image while an uncached draw of the same art upgraded. Both halves are pinned below.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, packLbMeshForWire, foldStreamedBuild } =
  await import('../src/renderer/lbBuildCore.js');
const { attachUnifiedFillDraw } = await import('../src/renderer/unifiedFillDraw.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const f = (v) => v.toFixed(3);
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
    d +=
      ` C${f(a[0] + (b[0] - a[0]) / 3)} ${f(a[1] + (b[1] - a[1]) / 3)}` +
      ` ${f(a[0] + (2 * (b[0] - a[0])) / 3)} ${f(a[1] + (2 * (b[1] - a[1])) / 3)} ${f(b[0])} ${f(b[1])}`;
  }
  return d + ' Z';
}
const N = 6,
  paths = [];
for (let i = 0; i < N; i++) {
  const cx = 150 + (i % 3) * 300,
    cy = 150 + Math.floor(i / 3) * 300;
  paths.push(
    `<path fill="#${(i + 3) % 10}${(i + 5) % 10}${(i + 7) % 10}" d="${cubicStar(cx, cy, 120, 52, 5)}"/>`,
  );
}
const sec = await importSvg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600">${paths.join('')}</svg>`,
  { preserveViewport: true },
);
const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const n = sec.numShapes | 0;

const posted = [];
globalThis.self = {
  postMessage: (m) => {
    posted.push(m);
  },
};
await import('../src/renderer/lbBuild.worker.js');
const runWorker = (extra) => {
  posted.length = 0;
  globalThis.self.onmessage({
    data: {
      id: 1,
      curves: new Float32Array(sec.curves),
      meta: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: n,
      ...extra,
    },
  });
  return posted.slice();
};
const bytesOf = (wire) => wire.reduce((b, m) => b + (m && m.verts ? m.verts.byteLength : 0), 0);
const realOf = (wire) => wire.filter((m) => m && (m.vertexCount | 0) > 0).length;

// The reference: one whole-bundle result, no streaming.
const plain = runWorker({})[0].packed;
const plainBytes = bytesOf(plain),
  plainReal = realOf(plain);
ok(plainReal > 0, `reference build: ${plainReal}/${n} real meshes, ${plainBytes} bytes`);

// Streamed, in small batches so there are several.
const streamed = runWorker({ adoptShapes: 2, adoptMs: 0 });
const partials = streamed.filter((m) => m.kind === 'lbPartial');
const final = streamed[streamed.length - 1];
ok(partials.length >= 2, `streamed into ${partials.length} batches plus the tail`);

// --- 1. complementary: every shape once, and the tail alone is NOT the whole bundle
const seen = new Map();
for (const m of partials) for (const s of m.shapes) seen.set(s, (seen.get(s) || 0) + 1);
for (const s of final.tail.shapes) seen.set(s, (seen.get(s) || 0) + 1);
ok(
  seen.size === n && [...seen.values()].every((c) => c === 1),
  'every shape crosses the wire exactly once across batches + tail',
);
ok(
  final.tail.shapes.length < n,
  `the tail carries only ${final.tail.shapes.length}/${n} shapes — the batches are not redundant`,
);

// --- 2. the fold is lossless WITH the batches staged, and lossy without them
const staged = new Array(n);
for (const m of partials)
  for (let i = 0; i < m.shapes.length; i++) staged[m.shapes[i]] = m.meshes[i];
const good = foldStreamedBuild(staged, final.tail, n);
ok(good.missing === 0, 'folding batches + tail loses no shape (missing 0)');
ok(
  realOf(good.wire) === plainReal,
  `folded build has the same ${plainReal} real meshes as the reference`,
);
ok(
  bytesOf(good.wire) === plainBytes,
  `folded build accounts the SAME ${plainBytes} bytes as the reference — the memory figure cannot depend on flush timing`,
);

// The failure itself: drop the batches (what a publish guard that returns early would do).
const lost = foldStreamedBuild(null, final.tail, n);
ok(
  lost.missing > 0,
  `dropping the batches loses ${lost.missing} shape(s) — the fold reports it instead of hiding it`,
);
ok(
  bytesOf(lost.wire) < plainBytes,
  `and accounts only ${bytesOf(lost.wire)} of ${plainBytes} bytes — the run-to-run memory figure`,
);

// --- 3a. the kind mask moves when a shape adopts
const R = {
  gl: {},
  opts: {},
  draw: {},
  _lbFillMode: 'on',
  _coverChunkStart: (c) => c.vboStart | 0,
  filterRecord: () => null,
};
attachUnifiedFillDraw(R);
const kb = { _geomGen: 0, _lbAdoptKey: 0, _lbMeshes: [{ vertexCount: 3, kindMask: 2 }] };
ok(R._lbKindMask(kb) === 2, 'kind mask reads the adopted set');
kb._lbMeshes[0] = { vertexCount: 3, kindMask: 8 };
ok(R._lbKindMask(kb) === 2, '...and caches it while nothing has adopted');
kb._lbAdoptKey = 1;
ok(
  R._lbKindMask(kb) === 8,
  'a shape adopting moves the kind mask — without this the variant compiles out the late kind',
);
kb._lbMeshes = [{ vertexCount: 3, kindMask: 16 }];
ok(R._lbKindMask(kb) === 16, 'replacing the entire mesh set invalidates the kind cache');

// --- 3b. the filter result cache moves when a shape adopts
const fb = { uid: 7, _geomGen: 0, _lbAdoptKey: 0 };
const id0 = R._unifiedFilterCacheId(fb, 3, 1);
fb._lbAdoptKey = 1;
const id1 = R._unifiedFilterCacheId(fb, 3, 1);
ok(
  id0 !== id1,
  'a shape adopting moves the filter cache id — a filtered shape cannot keep its cover-quad image',
);
fb._lbAdoptKey = 0;
ok(
  R._unifiedFilterCacheId(fb, 3, 1) === id0,
  '...and the id is otherwise stable (no per-draw churn)',
);
fb._geomGen = 1;
ok(R._unifiedFilterCacheId(fb, 3, 1) !== id0, 'the geometry generation still moves it too');

// --- 3c. a CACHED RASTER follows full quality exactly once, not every batch
// A bake cannot re-bake per adoption batch (that is the cache defeating itself) and cannot ignore
// adoption for good either (a cached handle would show its cover-kernel raster while an uncached
// draw of the same art upgraded). So it rides through every batch and follows the single completion
// edge. Both halves of that are asserted, because getting either one wrong is silent.
const { attachCacheDraw, cacheMeshTokens } = await import('../src/renderer/cacheDraw.js');
ok(cacheMeshTokens({ vertexCount: 800 }) === 100, 'cache cost reads packed vertexCount');
ok(cacheMeshTokens({ count: 800, numVerts: 800 }) === 0, 'unpacked count fields are not mesh work');
ok(cacheMeshTokens({ slug: true, vertexCount: 800 }) === 0, 'a Slug sentinel adds no mesh tokens');
const RC = { gl: {}, opts: {}, draw: {} };
attachCacheDraw(RC);
const stale = RC._cacheBakeQualityStale;
const cb = { _geomGen: 0, _lbAdoptKey: 0, _lbFullGen: undefined };
let bakedAt = cb._lbFullGen; // baked before the analytic build finished
ok(stale(bakedAt, cb) === false, 'a fresh bake is not stale');
for (let i = 1; i <= 4; i++) cb._lbAdoptKey = i;
ok(stale(bakedAt, cb) === false, 'four adoption batches do NOT invalidate the bake');
cb._lbFullGen = 0; // the last shape lands
ok(stale(bakedAt, cb) === true, 'reaching full quality invalidates it — the one edge');
bakedAt = cb._lbFullGen; // re-baked at full quality
ok(stale(bakedAt, cb) === false, '...and EXACTLY once: the re-bake is stable');
cb._lbAdoptKey = 9;
ok(stale(bakedAt, cb) === false, 'later adopt-key churn still does not invalidate');
cb._geomGen = 1;
cb._lbFullGen = 1; // geometry changed, then rebuilt to full quality
ok(stale(bakedAt, cb) === true, 'a new generation reaching full quality invalidates again');

console.log(fail ? `\nFAIL ${fail}` : '\nall ok');
process.exit(fail ? 1 : 0);
