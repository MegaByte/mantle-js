#!/usr/bin/env node
// morphHitPoseSmoke — hit tests must evaluate a morphing bundle at the
// current t, not the frozen t=0 curve plane createShapeMorph leaves on CPU.
import { fillHitShape, HitMode } from '../src/hitTest/hitTest.js';

function assert(cond, msg) { if (!cond) { console.error('FAIL', msg); process.exit(1); } }
function ok(msg) { console.log('ok', msg); }

// Synthetic 1-shape morph: axis-aligned square that slides from x∈[0,10] to x∈[20,30].
const STRIDE = 48;
const srcCurve = new Float32Array([
  // sentinel
  0, 0, 0, 0,
  // line (0,0)→(10,0)  type=0, floats: hdr(4) + p0(2)+p1(2) + join(4) = 12
  0, 2, 0, 0,  0, 0, 10, 0,  0, 0, 0, 0,
  // line (10,0)→(10,10)
  0, 2, 0, 0,  10, 0, 10, 10,  0, 0, 0, 0,
  // line (10,10)→(0,10)
  0, 2, 0, 0,  10, 10, 0, 10,  0, 0, 0, 0,
  // line (0,10)→(0,0)
  0, 2, 0, 0,  0, 10, 0, 0,  0, 0, 0, 0,
]);
const dstCurve = new Float32Array(srcCurve);
for (let i = 4; i < dstCurve.length; i += 12) {
  // translate every endpoint by +20 in x (p0.x and p1.x at +4,+6 within the 12-float record)
  dstCurve[i + 4] += 20;
  dstCurve[i + 6] += 20;
}

const srcMeta = new Float32Array(STRIDE);
srcMeta[0] = 0; srcMeta[1] = 0; srcMeta[2] = 10; srcMeta[3] = 10;
srcMeta[4] = 1; srcMeta[5] = 0; srcMeta[6] = 0; srcMeta[7] = 1; // fill rgba
const dstMeta = new Float32Array(srcMeta);
dstMeta[0] = 20; dstMeta[2] = 30;

const bundle = {
  numShapes: 1,
  metaFloatsPerShape: STRIDE,
  metaFloats: srcMeta.slice(),
  curveFloats: srcCurve.slice(),
  curveRangesByShape: [{ begin: 4, end: srcCurve.length }],
  _geomGen: 0,
  _morphSrc: {
    mergedCurveF32: srcCurve,
    dstCurveF32: dstCurve,
    curveRanges: [{ begin: 4, end: srcCurve.length }],
    mergedMetaF32: srcMeta,
    dstMetaF32: dstMeta,
    metaStride: STRIDE,
    matchedSrcIdxs: [0],
    t: 0,
  },
};

// t=0: centre of src square hits; centre of dst misses
assert(fillHitShape(bundle, 5, 5, HitMode.Coverage) === 0, 't=0 src centre hits');
assert(fillHitShape(bundle, 25, 5, HitMode.Coverage) < 0, 't=0 dst centre misses');
ok('t=0 pose');

bundle._morphSrc.t = 1;
assert(fillHitShape(bundle, 25, 5, HitMode.Coverage) === 0, 't=1 dst centre hits');
assert(fillHitShape(bundle, 5, 5, HitMode.Coverage) < 0, 't=1 src centre misses');
ok('t=1 pose');

bundle._morphSrc.t = 0.5;
assert(fillHitShape(bundle, 15, 5, HitMode.Coverage) === 0, 't=0.5 mid centre hits');
assert(fillHitShape(bundle, 5, 5, HitMode.Coverage) < 0, 't=0.5 src centre misses');
assert(fillHitShape(bundle, 25, 5, HitMode.Coverage) < 0, 't=0.5 dst centre misses');
ok('t=0.5 pose');

// Nearby poses must not alias in the cache. These two values used to round to
// the same 1/1024 key even though the interpolated bbox crosses x=10.003.
bundle._morphSrc.t = 0.5001;
assert(fillHitShape(bundle, 10.003, 5, HitMode.Bbox) === 0, 'nearby pose A hits');
bundle._morphSrc.t = 0.5002;
assert(fillHitShape(bundle, 10.003, 5, HitMode.Bbox) < 0, 'nearby pose B misses');
ok('exact t cache key');

// Override visibility=0 must miss even when geometry covers the point.
const packed = new Float32Array(24);
packed[6] = 0; packed[8] = packed[9] = packed[10] = packed[11] = 1;
bundle._morphSrc.t = 0;
assert(fillHitShape(bundle, 5, 5, { mode: HitMode.Coverage, overrides: packed }) < 0,
  'visibility 0 hides hit');
packed[6] = 0.8;
packed[11] = 0.8;
assert(fillHitShape(bundle, 5, 5, { mode: HitMode.Coverage, minAlpha: 0.7, overrides: packed }) < 0,
  'visibility and tint alpha affect minAlpha');
assert(fillHitShape(bundle, 5, 5, { mode: HitMode.Coverage, minAlpha: 0.6, overrides: packed }) === 0,
  'effective alpha above minAlpha hits');
ok('override visibility and alpha');

console.log('MORPH-HIT-POSE PASS');
