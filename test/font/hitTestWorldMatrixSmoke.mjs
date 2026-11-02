// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitTestWorldMatrixSmoke.mjs — fillHitShape with
// `worldMatrix` opts inverse-transforms the query point back into
// em-space before testing.

import { fillHitShape, fillHits, fillHitId } from '../../src/hitTest/hitTest.js';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}

// Hand-rolled bundle: one shape with em-space bbox (10, 20, 30, 40).
// metaFloats layout is the v3 stride (48 floats per shape):
//   0..3   = bbox (xmin, ymin, xmax, ymax)
//   4..7   = fill (r, g, b, a)
// Everything else stays zero.
function makeBundle(bbox) {
  const stride = 48;
  const meta = new Float32Array(stride);
  meta[0] = bbox[0];
  meta[1] = bbox[1];
  meta[2] = bbox[2];
  meta[3] = bbox[3];
  meta[7] = 1.0; // fill α = 1 so minAlpha gates don't fire
  return {
    numShapes: 1,
    metaFloats: meta,
    metaFloatsPerShape: stride,
    shapeIds: ['target'],
  };
}

// === T1: no worldMatrix — point in em-space hits ===================
{
  const b = makeBundle([10, 20, 30, 40]);
  if (fillHitShape(b, 20, 30) === 0) ok('T1 (20,30) inside em bbox hits');
  else fail('T1 inside expected hit');
  if (fillHitShape(b, 0, 0) === -1) ok('T1 (0,0) outside misses');
  else fail('T1 outside expected miss');
}

// === T2: opts-object form ==========================================
{
  const b = makeBundle([10, 20, 30, 40]);
  const idx = fillHitShape(b, 20, 30, { mode: 'auto', minAlpha: 0 });
  if (idx === 0) ok('T2 opts-object form hits');
  else fail(`T2 expected 0, got ${idx}`);
  const id = fillHitId(b, 20, 30, { worldMatrix: null });
  if (id === 'target') ok('T2 fillHitId returns "target"');
  else fail(`T2 fillHitId = ${id}`);
}

// === T3: worldMatrix translates the bundle ==========================
// World matrix = translate(100, 200) — column-major mat3:
//   [1, 0, 0,  0, 1, 0,  100, 200, 1]
// Em-space bbox (10..30, 20..40) maps to world (110..130, 220..240).
{
  const b = makeBundle([10, 20, 30, 40]);
  const T = new Float32Array([1, 0, 0, 0, 1, 0, 100, 200, 1]);
  if (fillHitShape(b, 120, 230, { worldMatrix: T }) === 0)
    ok('T3 world (120,230) hits translated bundle');
  else fail('T3 translated hit expected');
  if (fillHitShape(b, 20, 30, { worldMatrix: T }) === -1)
    ok('T3 world (20,30) misses translated bundle (was hit in em-space)');
  else fail('T3 translated miss expected');
}

// === T4: worldMatrix scales the bundle ==============================
// 2x scale around origin: [2, 0, 0,  0, 2, 0,  0, 0, 1]
// Em bbox (10..30, 20..40) maps to world (20..60, 40..80).
{
  const b = makeBundle([10, 20, 30, 40]);
  const S = new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 1]);
  if (fillHitShape(b, 40, 60, { worldMatrix: S }) === 0)
    ok('T4 world (40,60) hits 2x-scaled bundle');
  else fail('T4 scaled hit expected');
  if (fillHitShape(b, 15, 25, { worldMatrix: S }) === -1)
    ok('T4 world (15,25) misses 2x-scaled bundle (was hit in em-space)');
  else fail('T4 scaled miss expected');
}

// === T5: worldMatrix rotation 90° CCW ==============================
// R(90°) = [cos, -sin; sin, cos] = [0, -1; 1, 0].
// Column-major mat3: [0, 1, 0,  -1, 0, 0,  0, 0, 1]
// Em (10..30, 20..40) under R(90°): a point (x, y) maps to (-y, x).
// So em corners map to world: (-20, 10), (-40, 30) → bbox (-40..-20, 10..30).
// World (-30, 20) should hit. World (20, 30) should miss (it is the em-space hit).
{
  const b = makeBundle([10, 20, 30, 40]);
  const R = new Float32Array([0, 1, 0, -1, 0, 0, 0, 0, 1]);
  const got = fillHitShape(b, -30, 20, { worldMatrix: R });
  if (got === 0) ok('T5 rotated world (-30,20) hits');
  else fail(`T5 rotated hit expected, got ${got}`);
}

// === T6: fillHits with worldMatrix ==================================
{
  const b = makeBundle([10, 20, 30, 40]);
  const T = new Float32Array([1, 0, 0, 0, 1, 0, 100, 200, 1]);
  const hits = fillHits(b, 120, 230, { worldMatrix: T });
  if (hits.length === 1 && hits[0] === 0) ok('T6 fillHits returns [0] under translation');
  else fail(`T6 hits = ${JSON.stringify(hits)}`);
}

// === T7: backwards compat — legacy (mode, minAlpha) positional args =
{
  const b = makeBundle([10, 20, 30, 40]);
  if (fillHitShape(b, 20, 30, 'auto', 0) === 0) ok('T7 legacy positional mode arg still works');
  else fail('T7 legacy positional');
  // Bundle's fill α is 1.0, so minAlpha=0.5 should still hit. Drop
  // fill α to 0.2 (below 0.5) → miss.
  const lowAlpha = new Float32Array(b.metaFloats);
  lowAlpha[7] = 0.2;
  const dim = { ...b, metaFloats: lowAlpha };
  if (fillHitShape(dim, 20, 30, 'bbox', 0.5) === -1) ok('T7 minAlpha gates low-α via positional');
  else fail('T7 minAlpha positional');
}

console.log('---');
if (failures) console.error(`HIT-TEST-WORLD-MATRIX FAIL (${failures})`);
else console.log('HIT-TEST-WORLD-MATRIX PASS');
process.exit(failures ? 1 : 0);
