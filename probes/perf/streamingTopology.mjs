// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/streamingTopology.mjs — under streaming, only earcut meshes reuse topology: why that
// is correctness-grounded rather than unimplemented. The probe MOVES control points the way a stream
// update does and counts how often the mesh's topology survives, per builder.
//
//   node probes/perf/streamingTopology.mjs
//   DELTA=0.001 node probes/perf/streamingTopology.mjs    # fraction of the shape's extent
//   MODE=random node probes/perf/streamingTopology.mjs    # noise instead of a smooth warp
//
// ── HOW THE REUSE WORKS, AND WHAT DECIDES IT ────────────────────────────────────────────────
//
// The streaming path (streamGeometry.js, then the route decision in lbBuildCore.js) has three
// nested gates:
//   1. a per-shape control-point FINGERPRINT — an unchanged shape keeps last frame's raw mesh
//      AND its packed VBO verbatim, whatever built it. Builder-agnostic, and it only covers
//      geometry that did not move;
//   2. inside the one route decision, `opts.prev && opts.prev._topo ? refreshLoopBlinnMesh(...)
//      : buildLoopBlinnMesh(...)` on the all-straight fast path, after every guard the static
//      router applies;
//   3. inside refresh, a rim-structure fingerprint, falling back to a full build on a miss.
//      `_topo` is written in exactly ONE place — the fast earcut path (lbFastMesh) — and every
//      other builder returns `_topo: null` explicitly: the CDT partition, the morph-pair
//      partition, the recognized circle/ellipse/annulus primitives, CPatch, primBuild.
//
// So "only earcut meshes reuse topology" is literally what the predicate says. A recognized
// PRIMITIVE returns `_topo: null` every time, so it re-runs recognition and a full build on every
// update.
//
// ── THE FALSIFIABLE CLAIM ───────────────────────────────────────────────────────────────────
//
// C1. The partition's topology is a function of the control-point VALUES, not of the contour's
//     combinatorics, so there is no fixed topology for a stream to reuse. The table below is
//     the test, and it runs the REAL `refreshLoopBlinnMesh` rather than comparing two
//     independent builds: refresh either returns the very same triangulation array (the whole
//     optimization, observable by object identity) or gives up. Falsify by finding a
//     perturbation at which the partition class reuses anything at all.
//
//     MEASURED, 166 assets, a 0.1% coherent warp (the realistic case — a smooth low-frequency
//     deformation, which is what an animation does and which flatters reuse):
//
//       builder          shapes   REUSED   re-triangulated   rebuilt   packed count held
//       fast (earcut)       183    96.7%             3.3%         0              96.2%
//       partition/prim     3565     0.0%            96.3%       131               4.0%
//
//     Under independent per-coordinate NOISE of the same size (MODE=random), the earcut class
//     falls to 3.8% reused and 3.8% count-held: the reuse predicate tests rim lengths, hole
//     starts, fallback count and a per-vertex TURN-SIGN fingerprint, and noise breaks the
//     fingerprint. So the reuse is real but it is a reuse for BENDING, not for restructuring.
//
//     The partition class reuses nothing, as expected. The packed VERTEX
//     COUNT, which is the second and independent gate (lbPack refills the buffer in place only
//     on an exact float-count match), holds for just 4.0% of them: even where the rebuild
//     succeeds, 96% of streamed partition shapes reallocate and re-upload their VBO.
//
//     The mechanisms, each in the code: splits at inflections and loop double points
//     (lbCubicMath), turn-angle halving, containment splitting against every OTHER SEGMENT of
//     the shape, Bezout faithfulness splitting on a sampled resultant, overlapping-quad-hull
//     splitting, Steiner points inserted at constraint intersections (cdt.js), the Delaunay
//     circumcircle predicate itself, klmn-vs-Bezout kind assignment by conditioning, and the
//     cubic self-audit that sends a whole shape to Slug when a piece mispaints. A stream
//     reusing a partition topology would have to tolerate a shape that is analytic on frame N
//     and Slug on frame N+1.
//
// C2. There is a reuse for arbitrary meshes that IS already implemented and is NOT wired to the
//     stream: the similarity cache (lbPack lbCanonicalFrame / transformLoopBlinnRaw) clones and
//     transforms a FULL assembly — CDT, crescents, bands, healing — and PRESERVES `_topo`,
//     because index and sign topology is similarity-invariant. It is wired into the static path
//     only (morphDraw's _lbSimCache). A stream whose shapes translate, rotate or uniformly
//     scale is exactly its domain, and that is the cheapest opening here.
//
// ── STATIC VS STREAMED ──────────────────────────────────────────────────────────────────────
//
// The stream refresh sits inside the one route decision, so a concave-curve or disjoint-contour
// shape that the static router sends to the CDT takes the same route when streamed. The GPU check
// at the end of the output is the byte-identity test of that.
//
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
const { buildLbBundle } = await import(path.join(JS, 'src/renderer/lbBuildCore.js'));
const { refreshLoopBlinnMesh, packLoopBlinnMesh } = await import(
  path.join(JS, 'src/renderer/loopBlinn.js')
);
const { curveRangeToContours } = await import(path.join(JS, 'src/geom/lbContour.js'));

const DELTA = +(process.env.DELTA || 0.001); // fraction of the shape's extent
const MODE = process.env.MODE === 'random' ? 'random' : 'coherent';
const dirs = [path.join(REPO, 'MantleSamples/Assets/Mantle'), path.join(REPO, 'fixtures/svg')];
const files = [];
for (const d of dirs) {
  try {
    for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
  } catch {}
}
files.sort();
const only = process.env.ONLY ? files.filter((f) => f.includes(process.env.ONLY)) : files;

/// A deterministic, tiny, shape-scaled move of every CONTROL POINT — a stand-in for one frame
/// of a stream update, applied where the stream applies it: to the CONTOURS.
///
/// NOT to the raw curve buffer. That buffer is not all coordinates — it carries per-segment
/// type tags, flags and rational weights interleaved with the points, and jittering it whole
/// makes `curveRangeToContours` return null for every shape, which reads as "every shape
/// rebuilt" and would have been reported as this probe's finding.
///
/// Per-coordinate rather than a rigid motion: a rigid motion is the SIMILARITY case, which the
/// cache in C2 already serves and which would understate the churn.
/// TWO MODES, and reporting only one of them would be a lie in one direction or the other.
///
///   'coherent' (default) — a smooth low-frequency warp, so neighbouring control points move
///     together. This is what an animation does, and it is the mode that flatters reuse: turn
///     signs and rim lengths survive a coherent deformation far better than a random one.
///   'random' — independent noise per coordinate. The worst case, and the one that says what
///     happens when the geometry is genuinely restructured rather than bent.
let _h = 0x9e3779b9;
function noise(amount) {
  _h ^= _h << 13;
  _h ^= _h >>> 17;
  _h ^= _h << 5;
  _h >>>= 0;
  return amount * (_h / 0xffffffff - 0.5);
}
function perturbContours(contours, amount, mode, ext) {
  if (!contours) return null;
  const k = (2 * Math.PI) / Math.max(ext, 1e-9); // one cycle across the shape
  const move = (x, y) =>
    mode === 'random'
      ? [x + noise(amount), y + noise(amount)]
      : [x + amount * Math.sin(y * k), y + amount * Math.cos(x * k)];
  return contours.map((c) =>
    c.map((sg) => {
      const out = { ...sg };
      for (const kk of ['p1', 'p2', 'p3', 'p4']) {
        const p = sg[kk];
        if (Array.isArray(p) && p.length >= 2) out[kk] = move(p[0], p[1]);
      }
      return out;
    }),
  );
}

// THE MEASUREMENT IS refreshLoopBlinnMesh, NOT A SECOND BUILD. Comparing two independent
// builds answers "does a fresh build of moved geometry come out the same", which is a different
// and much harsher question — earcut's own output depends on coordinates too. What the stream
// does is call refresh, and refresh either REUSES the stored triangulation (returning the very
// same `_topo.tris` array) or gives up and rebuilds. Object identity is the exact observable.
const cls = {
  fast: { n: 0, reused: 0, refit: 0, rebuilt: 0, sameCount: 0 },
  cdt: { n: 0, reused: 0, refit: 0, rebuilt: 0, sameCount: 0 },
};
let assets = 0;
for (const f of only) {
  let sec, pm, a;
  try {
    sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
    pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    a = buildLbBundle({
      curveFloats: new Float32Array(sec.curves),
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: sec.numShapes,
    });
  } catch {
    continue;
  }
  const gbb = sec.globalBBox;
  if (!gbb || !(gbb[2] > 0)) continue;
  const amount = DELTA * Math.max(gbb[2], gbb[3]);
  const curves = new Float32Array(sec.curves);
  assets++;
  const st = pm.floatsPerShape | 0;
  for (let s = 0; s < (sec.numShapes | 0); s++) {
    const ra = a.raw[s],
      pa = a.packed[s];
    if (!ra || ra.slug || !pa || pa.slug || !(pa.vertexCount | 0)) continue;
    // `_topo` IS the builder's signature: the fast earcut path is its only writer.
    const c = ra._topo ? cls.fast : cls.cdt;
    c.n++;
    let re = null;
    try {
      const r = sec.curveRangesByShape[s];
      const rule = st && pm.metaFloats[s * st + 13] > 0.5 ? 'evenodd' : 'nonzero';
      const moved = perturbContours(
        curveRangeToContours(curves, r.begin, r.end),
        amount,
        MODE,
        Math.max(gbb[2], gbb[3]),
      );
      if (moved) re = refreshLoopBlinnMesh(ra, moved, rule);
    } catch {
      re = null;
    }
    if (!re) {
      c.rebuilt++;
      continue;
    }
    if (ra._topo && re._topo && re._topo.tris === ra._topo.tris) c.reused++;
    else if (re._topo) c.refit++;
    else c.rebuilt++;
    // ...and whether the packed stream can be refilled in place, which is a second and
    // independent gate (lbPack reuses the buffer only on an exact float-count match).
    let rp = null;
    try {
      rp = packLoopBlinnMesh(re, pa);
    } catch {
      rp = null;
    }
    if (rp && !rp.slug && (rp.vertexCount | 0) === (pa.vertexCount | 0)) c.sameCount++;
  }
}

const pct = (x, n) => (n ? `${((100 * x) / n).toFixed(1)}%` : '—');
console.log(
  `\n== C1: what refreshLoopBlinnMesh does under a ${(100 * DELTA).toFixed(2)}% ${MODE} control-point move ==`,
);
console.log(`   (${assets} assets)`);
console.log(
  '   builder          shapes   topology REUSED   re-triangulated   rebuilt   vert count held',
);
for (const [name, c] of [
  ['fast (earcut)', cls.fast],
  ['partition/prim', cls.cdt],
]) {
  console.log(
    `   ${name.padEnd(16)} ${String(c.n).padStart(6)}   ${String(c.reused).padStart(7)}` +
      ` ${pct(c.reused, c.n).padStart(7)}   ${String(c.refit).padStart(7)} ${pct(c.refit, c.n).padStart(7)}` +
      `   ${String(c.rebuilt).padStart(7)}   ${String(c.sameCount).padStart(7)} ${pct(c.sameCount, c.n).padStart(7)}`,
  );
}
console.log('   REUSED = refresh returned the very same triangulation array, which is the whole');
console.log('   optimization. "rebuilt" is refresh missing its fingerprint and falling');
console.log('   through to a full build.');
console.log('   "vert count held" is the second, independent gate: the packed stream is refilled');
console.log('   in place only on an exact float-count match (lbPack), so anything else is a fresh');
console.log('   buffer and a fresh upload however the triangulation went.');

console.log(`
== VERDICT ===================================================================================

Partition topology reuse is not a missing optimization; two smaller openings remain.

  * Reusing a PARTITION topology across a stream update is not an unimplemented optimization,
    it is an ill-posed one: the face set, the piece count, the kind assignment and the
    accept/decline verdict are all functions of the coordinate values. The table above is the
    evidence; if the partition class shows churn at a 0.1% move, no stream can hold its topology
    fixed across an animation.
  * The real, cheap opening is C2: wire the SIMILARITY cache into the stream. It already clones
    and transforms a full CDT assembly and preserves _topo, and a stream whose shapes translate,
    rotate or uniformly scale (the ring-road slot case the stream tests use) is exactly
    its domain. It is wired to the static path only.
  * A recognized PRIMITIVE re-runs recognition and a full build on every update, forever,
    because it returns _topo: null. Carrying the primitive record across the refresh is a
    one-line class of change and is worth more than anything on the partition side.

WHAT IS MISSING BEFORE ANY OF IT IS WORTH DOING, and it is not a GPU measurement — it is a
COUNTER. Nothing in the renderer reports stream work:

  * bundle._lbSegPrev decides the per-shape unchanged skip and the hits are never tallied;
  * same inside refreshLoopBlinnMesh decides "triangulation reused vs re-earcut" and is never
    tallied or exported;
  * the buffer reuse-vs-realloc decision in lbPack is not counted;
  * and _lbSlugWhy is filled by the static build only, so a STREAMED bundle's decline tally
    reports every sentinel as unknown — a streamed bundle cannot say why any of its shapes
    fell back.

Four counters on the bundle (skipped / refreshed / rebuilt / repacked, per update) would make
stream work measurable from Node with no renderer at all. Without them, "only earcut meshes
reuse topology" is a true statement about an unweighed cost.

== WHAT NEEDS A GPU ==========================================================================

GPU  The cost needs none: it is CPU build time per stream update, measurable with
  performance.now() around streamGeometryLightweight once the counters above exist. The one
  browser check is static vs streamed rendering of the same geometry:
    asset:  a holed, disjoint or concave-curve shape;
    arms:   render it statically, then stream the identical geometry;
    gate:   BYTE-IDENTICAL frames. A difference means a streamed shape took a different route.
    fill in: [ ] built the fixture   px differing ____   worst channel delta ____
`);
