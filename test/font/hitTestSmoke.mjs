// hitTestSmoke.mjs — Bbox hit test against a hand-crafted bundle.
// No font / sfnt needed; we build the meta array directly and
// inject it into a bundle-shaped dict.

import { fillHitShape, fillHits, fillHitId, HitMode } from '../../src/hitTest/hitTest.js';
import { DOMParser } from '@xmldom/xmldom';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

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
    { bbox: [0,  10, 30, 20], fill: [1,0,0,1], id: 'red'  },
    { bbox: [12, 12, 18, 18], fill: [0,0,1,1], id: 'blue' },
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
    { bbox: [0, 0, 100, 100] },  // big background
    { bbox: [40, 40, 60, 60] },  // mid layer
    { bbox: [45, 45, 55, 55] },  // tiny top
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
    { bbox: [0, 0, 100, 100], fill: [1, 0, 0, 0.2] },  // 20% red
    { bbox: [50, 50, 60, 60], fill: [0, 1, 0, 1.0] },  // opaque green
  ]);
  // At (10, 10) only the 20% red covers it.
  if (fillHitShape(b, 10, 10, HitMode.Auto, 0.5) !== -1)
    fail('T4 minAlpha=0.5 should reject 20% red');
  // At (55, 55) the green covers it through the red.
  if (fillHitShape(b, 55, 55, HitMode.Auto, 0.5) !== 1)
    fail('T4 minAlpha=0.5 should still hit opaque green at (55,55)');
  if (fillHitShape(b, 10, 10, HitMode.Auto, 0.0) !== 0)
    fail('T4 minAlpha=0 should hit 20% red');
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
  const leftIdx  = fillHitShape(sections, 10, 50);
  const rightIdx = fillHitShape(sections, 80, 50);
  const midIdx   = fillHitShape(sections, 50, 50);  // in the gap
  if (leftIdx !== 0)  fail(`T8 left click → idx ${leftIdx}`);
  else if (rightIdx !== 1) fail(`T8 right click → idx ${rightIdx}`);
  else if (midIdx !== -1) fail(`T8 gap click → idx ${midIdx} (expected -1)`);
  else ok(`T8 importSvg round-trip: left→0, right→1, gap→miss`);
}

console.log();
console.log(failures === 0 ? 'HIT-TEST PASS' : `HIT-TEST FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
