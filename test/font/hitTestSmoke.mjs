// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitTestSmoke.mjs — Bbox hit test against a hand-crafted bundle, including the opts-object form
// and `worldMatrix` (the query point is inverse-transformed into em space before testing).
// No font / sfnt needed; we build the meta array directly and
// inject it into a bundle-shaped dict.

import { fillHitShape, fillHits, fillHitId, HitMode } from '../../src/hitTest/hitTest.js';
import { DOMParser } from '@xmldom/xmldom';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// Build a bundle dict with N shapes. Each shape:
//   bbox = (xmin, ymin, xmax, ymax) at slot 0..3
//   fill = (r, g, b, a) at slot 4..7
//   rest = 0.
function makeBundle(shapes) {
  const stride = 48;
  const meta = new Float32Array(shapes.length * stride);
  const ids = [];
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    const o = i * stride;
    meta[o + 0] = s.bbox[0];
    meta[o + 1] = s.bbox[1];
    meta[o + 2] = s.bbox[2];
    meta[o + 3] = s.bbox[3];
    meta[o + 4] = (s.fill && s.fill[0]) ?? 1;
    meta[o + 5] = (s.fill && s.fill[1]) ?? 1;
    meta[o + 6] = (s.fill && s.fill[2]) ?? 1;
    meta[o + 7] = (s.fill && s.fill[3]) ?? 1;
    ids.push(s.id || `shape_${i}`);
  }
  return {
    numShapes: shapes.length,
    metaFloatsPerShape: stride,
    metaFloats: meta,
    shapeIds: ids,
  };
}

// T1: single rect 10..20 × 10..20. Inside hits; outside misses.
{
  const b = makeBundle([{ bbox: [10, 10, 20, 20] }]);
  if (fillHitShape(b, 15, 15) !== 0) fail('T1 inside should hit shape 0');
  else if (fillHitShape(b, 5, 15) !== -1) fail('T1 outside-left should miss');
  else if (fillHitShape(b, 15, 25) !== -1) fail('T1 outside-below should miss');
  else if (fillHitShape(b, 10, 10) !== 0) fail('T1 corner should hit');
  else ok('T1 single rect: hits inside, misses outside, hits on edge');
}

// T2: two stacked rects — topmost wins.
// Shape 0 (back) = wide red bar 0..30 × 10..20
// Shape 1 (front) = small blue rect 12..18 × 12..18 (entirely inside 0)
{
  const b = makeBundle([
    { bbox: [0, 10, 30, 20], fill: [1, 0, 0, 1], id: 'red' },
    { bbox: [12, 12, 18, 18], fill: [0, 0, 1, 1], id: 'blue' },
  ]);
  if (fillHitShape(b, 15, 15) !== 1) fail('T2 overlap hits front (blue) shape 1');
  else if (fillHitShape(b, 5, 15) !== 0) fail('T2 outside-blue-inside-red hits 0');
  else if (fillHitId(b, 15, 15) !== 'blue') fail('T2 hit id should be blue');
  else if (fillHitId(b, 5, 15) !== 'red') fail('T2 hit id should be red');
  else ok('T2 stacked rects: topmost wins, IDs resolve');
}

// T3: fillHits returns all shapes in front-to-back order.
{
  const b = makeBundle([
    { bbox: [0, 0, 100, 100] }, // big background
    { bbox: [40, 40, 60, 60] }, // mid layer
    { bbox: [45, 45, 55, 55] }, // tiny top
  ]);
  const hits = fillHits(b, 50, 50);
  if (hits.length !== 3) fail(`T3 expected 3 hits, got ${hits.length}`);
  else if (hits[0] !== 2 || hits[1] !== 1 || hits[2] !== 0)
    fail(`T3 paint order wrong: ${hits.join(',')}`);
  else ok(`T3 fillHits front-to-back: [${hits.join(', ')}]`);

  const hitsTop = fillHits(b, 5, 5);
  if (hitsTop.length !== 1 || hitsTop[0] !== 0)
    fail(`T3b only background should hit at (5,5): ${hitsTop.join(',')}`);
  else ok(`T3b far corner hits only background: [${hitsTop.join(', ')}]`);
}

// T4: minAlpha skips low-α shapes.
{
  const b = makeBundle([
    { bbox: [0, 0, 100, 100], fill: [1, 0, 0, 0.2] }, // 20% red
    { bbox: [50, 50, 60, 60], fill: [0, 1, 0, 1.0] }, // opaque green
  ]);
  // At (10, 10) only the 20% red covers it.
  if (fillHitShape(b, 10, 10, HitMode.Auto, 0.5) !== -1)
    fail('T4 minAlpha=0.5 should reject 20% red');
  // At (55, 55) the green covers it through the red.
  if (fillHitShape(b, 55, 55, HitMode.Auto, 0.5) !== 1)
    fail('T4 minAlpha=0.5 should still hit opaque green at (55,55)');
  if (fillHitShape(b, 10, 10, HitMode.Auto, 0.0) !== 0) fail('T4 minAlpha=0 should hit 20% red');
  ok('T4 minAlpha gates low-α shapes');
}

// T5: empty bundle.
{
  const b = makeBundle([]);
  if (fillHitShape(b, 0, 0) !== -1) fail('T5 empty bundle should miss');
  else if (fillHits(b, 0, 0).length !== 0) fail('T5 fillHits should be []');
  else ok('T5 empty bundle: -1 + []');
}

// T6: null / undefined safe.
{
  if (fillHitShape(null, 0, 0) !== -1) fail('T6 null bundle should miss');
  else if (fillHitShape(undefined, 0, 0) !== -1) fail('T6 undefined bundle should miss');
  else if (fillHitId(null, 0, 0) !== null) fail('T6 fillHitId(null) should be null');
  else ok('T6 null-safe');
}

// T7: HitMode values are accepted (all behave identically for Bbox-only).
{
  const b = makeBundle([{ bbox: [0, 0, 10, 10] }]);
  for (const mode of Object.values(HitMode)) {
    if (fillHitShape(b, 5, 5, mode) !== 0) {
      fail(`T7 mode=${mode} should hit`);
      break;
    }
  }
  ok(`T7 all HitMode values accepted (bbox fallback)`);
}

// T8: end-to-end through a real importSvg bundle. Two non-overlapping
// rects in an SVG; click each, expect the right hit.
{
  const { default: importSvg } = await import('../../src/svg/importer.js');
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <rect id="left"  x="0"  y="0" width="40" height="100" fill="red"/>
  <rect id="right" x="60" y="0" width="40" height="100" fill="blue"/>
</svg>`;
  const sections = await importSvg(svg);
  // importSvg returns `sections` ArrayBuffers — pass directly;
  // hitTest's metaView() handles the 32-byte meta header. The sections
  // output carries no shapeIds (a createBundle/runtime concern), so
  // hits are tested by INDEX here.
  const leftIdx = fillHitShape(sections, 10, 50);
  const rightIdx = fillHitShape(sections, 80, 50);
  const midIdx = fillHitShape(sections, 50, 50); // in the gap
  if (leftIdx !== 0) fail(`T8 left click → idx ${leftIdx}`);
  else if (rightIdx !== 1) fail(`T8 right click → idx ${rightIdx}`);
  else if (midIdx !== -1) fail(`T8 gap click → idx ${midIdx} (expected -1)`);
  else ok(`T8 importSvg round-trip: left→0, right→1, gap→miss`);
}

// T9-T15: the opts-object form and `worldMatrix`, which inverse-transforms the query point back into
// the bundle's em space before testing. One shape with em-space bbox (10, 20, 30, 40).
// === T9: no worldMatrix — point in em-space hits ===================
{
  const b = makeBundle([{ bbox: [10, 20, 30, 40], id: 'target' }]);
  if (fillHitShape(b, 20, 30) === 0) ok('T9 (20,30) inside em bbox hits');
  else fail('T9 inside expected hit');
  if (fillHitShape(b, 0, 0) === -1) ok('T9 (0,0) outside misses');
  else fail('T9 outside expected miss');
}

// === T10: opts-object form ==========================================
{
  const b = makeBundle([{ bbox: [10, 20, 30, 40], id: 'target' }]);
  const idx = fillHitShape(b, 20, 30, { mode: 'auto', minAlpha: 0 });
  if (idx === 0) ok('T10 opts-object form hits');
  else fail(`T10 expected 0, got ${idx}`);
  const id = fillHitId(b, 20, 30, { worldMatrix: null });
  if (id === 'target') ok('T10 fillHitId returns "target"');
  else fail(`T10 fillHitId = ${id}`);
}

// === T11: worldMatrix translates the bundle ==========================
// World matrix = translate(100, 200) — column-major mat3:
//   [1, 0, 0,  0, 1, 0,  100, 200, 1]
// Em-space bbox (10..30, 20..40) maps to world (110..130, 220..240).
{
  const b = makeBundle([{ bbox: [10, 20, 30, 40], id: 'target' }]);
  const T = new Float32Array([1, 0, 0, 0, 1, 0, 100, 200, 1]);
  if (fillHitShape(b, 120, 230, { worldMatrix: T }) === 0)
    ok('T11 world (120,230) hits translated bundle');
  else fail('T11 translated hit expected');
  if (fillHitShape(b, 20, 30, { worldMatrix: T }) === -1)
    ok('T11 world (20,30) misses translated bundle (was hit in em-space)');
  else fail('T11 translated miss expected');
}

// === T12: worldMatrix scales the bundle ==============================
// 2x scale around origin: [2, 0, 0,  0, 2, 0,  0, 0, 1]
// Em bbox (10..30, 20..40) maps to world (20..60, 40..80).
{
  const b = makeBundle([{ bbox: [10, 20, 30, 40], id: 'target' }]);
  const S = new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 1]);
  if (fillHitShape(b, 40, 60, { worldMatrix: S }) === 0)
    ok('T12 world (40,60) hits 2x-scaled bundle');
  else fail('T12 scaled hit expected');
  if (fillHitShape(b, 15, 25, { worldMatrix: S }) === -1)
    ok('T12 world (15,25) misses 2x-scaled bundle (was hit in em-space)');
  else fail('T12 scaled miss expected');
}

// === T13: worldMatrix rotation 90° CCW ==============================
// R(90°) = [cos, -sin; sin, cos] = [0, -1; 1, 0].
// Column-major mat3: [0, 1, 0,  -1, 0, 0,  0, 0, 1]
// Em (10..30, 20..40) under R(90°): a point (x, y) maps to (-y, x).
// So em corners map to world: (-20, 10), (-40, 30) → bbox (-40..-20, 10..30).
// World (-30, 20) should hit. World (20, 30) should miss (it is the em-space hit).
{
  const b = makeBundle([{ bbox: [10, 20, 30, 40], id: 'target' }]);
  const R = new Float32Array([0, 1, 0, -1, 0, 0, 0, 0, 1]);
  const got = fillHitShape(b, -30, 20, { worldMatrix: R });
  if (got === 0) ok('T13 rotated world (-30,20) hits');
  else fail(`T13 rotated hit expected, got ${got}`);
}

// === T14: fillHits with worldMatrix ==================================
{
  const b = makeBundle([{ bbox: [10, 20, 30, 40], id: 'target' }]);
  const T = new Float32Array([1, 0, 0, 0, 1, 0, 100, 200, 1]);
  const hits = fillHits(b, 120, 230, { worldMatrix: T });
  if (hits.length === 1 && hits[0] === 0) ok('T14 fillHits returns [0] under translation');
  else fail(`T14 hits = ${JSON.stringify(hits)}`);
}

// === T15: backwards compat — legacy (mode, minAlpha) positional args =
{
  const b = makeBundle([{ bbox: [10, 20, 30, 40], id: 'target' }]);
  if (fillHitShape(b, 20, 30, 'auto', 0) === 0) ok('T15 legacy positional mode arg still works');
  else fail('T15 legacy positional');
  // Bundle's fill α is 1.0, so minAlpha=0.5 should still hit. Drop
  // fill α to 0.2 (below 0.5) → miss.
  const lowAlpha = new Float32Array(b.metaFloats);
  lowAlpha[7] = 0.2;
  const dim = { ...b, metaFloats: lowAlpha };
  if (fillHitShape(dim, 20, 30, 'bbox', 0.5) === -1) ok('T15 minAlpha gates low-α via positional');
  else fail('T15 minAlpha positional');
}

console.log();
console.log(failures === 0 ? 'HIT-TEST PASS' : `HIT-TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
