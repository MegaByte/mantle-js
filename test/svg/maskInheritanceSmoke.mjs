// maskInheritanceSmoke.mjs — a shape must inherit `mask=` / `clip-path=`
// from a `<g mask="url(#m)">` wrapper, not only from the shape leaf.
// (Wrapper-form masks otherwise drop out of `createShapeMorph` because
// the matched-topology layer row for the mask geometry never appears in
// the bundle.)
//
// Verifies: a shape inside `<g mask=>` picks up the mask, the mask child
// geometry is emitted as a FLAG_LAYER row, and the visible shape's
// maskId points at it. Same for clip-path.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../../src/svg/importer.js';

let failures = 0;
const ok   = (msg) => console.log('ok', msg);
const fail = (msg) => { failures++; console.error('FAIL', msg); };

const FLAG_LAYER = 0x100;
const STRIDE = 48;
const META_TEXEL_4 = 16;        // flagsShape lives at +27 (texel 6 .w)
const META_FLAGS_F = 27;
const META_MASKID  = 31;        // texel 7 .w
const META_CLIPID  = 30;        // texel 7 .z

function inspect(sections) {
  const mf = new Float32Array(sections.meta, 32);
  const rows = [];
  for (let i = 0; i < sections.numShapes; i++) {
    const b = i * STRIDE;
    const flags = (mf[b + META_FLAGS_F] + 0.5) | 0;
    rows.push({
      idx: i,
      bboxY: [mf[b + 1], mf[b + 3]],
      isLayer: (flags & FLAG_LAYER) !== 0,
      maskId: (mf[b + META_MASKID] + 0.5) | 0,
      clipId: (mf[b + META_CLIPID] + 0.5) | 0,
    });
  }
  return rows;
}

// ---- T1: <g mask=> wrapper propagates to child shape -------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><mask id="m"><rect x="0" y="0" width="100" height="40" fill="#fff"/></mask></defs>
  <g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#f00"/></g>
</svg>`;
  const s = await importSvg(svg, {});
  const rows = inspect(s);
  // Expect 2 rows: shape 0 = visible rect (maskId > 0), shape 1 =
  // mask layer (FLAG_LAYER, bbox y = 0..40).
  if (s.numShapes !== 2)
    fail(`T1 expected 2 shapes, got ${s.numShapes}`);
  else if (rows[0].maskId === 0)
    fail(`T1 visible shape inherited no mask from <g mask=>; rows=${JSON.stringify(rows)}`);
  else if (!rows[1].isLayer)
    fail(`T1 mask child not emitted as FLAG_LAYER row; rows=${JSON.stringify(rows)}`);
  else if (Math.abs(rows[1].bboxY[1] - 40) > 0.1)
    fail(`T1 mask layer bbox.ymax != 40; rows=${JSON.stringify(rows)}`);
  else
    ok(`T1 <g mask=> propagates: visible.maskId=${rows[0].maskId}, layer.bboxY=[${rows[1].bboxY}]`);
}

// ---- T2: nested <g> inheritance — outer mask wraps inner group ---
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><mask id="m"><rect x="0" y="0" width="100" height="50" fill="#fff"/></mask></defs>
  <g mask="url(#m)"><g><rect x="0" y="0" width="100" height="100" fill="#0f0"/></g></g>
</svg>`;
  const s = await importSvg(svg, {});
  const rows = inspect(s);
  if (rows[0].maskId === 0)
    fail(`T2 mask didn't propagate through nested <g>; rows=${JSON.stringify(rows)}`);
  else
    ok(`T2 mask propagates through nested <g> wrapper`);
}

// ---- T3: shape's own mask wins over ancestor -----------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <mask id="m1"><rect x="0" y="0" width="100" height="10" fill="#fff"/></mask>
    <mask id="m2"><rect x="0" y="0" width="100" height="90" fill="#fff"/></mask>
  </defs>
  <g mask="url(#m1)"><rect x="0" y="0" width="100" height="100" fill="#00f" mask="url(#m2)"/></g>
</svg>`;
  const s = await importSvg(svg, {});
  const rows = inspect(s);
  // Two mask defs claimed (one per use): m1 from <g>, m2 from <rect>.
  // Shape 0 (visible rect) should reference m2 (its OWN attribute
  // overrides the ancestor m1).
  // We can't read the SVG-id directly off the meta; the layer-row
  // bbox tells us which mask the visible shape ended up bound to.
  // m2 has bbox y=0..90 → layer row 1 (or whichever non-self row
  // matches that bbox).
  let visibleRow = rows.find(r => !r.isLayer);
  if (!visibleRow || visibleRow.maskId === 0) {
    fail(`T3 visible shape has no mask; rows=${JSON.stringify(rows)}`);
  } else {
    // Find the layer row whose 1-based idx matches the visible's maskId.
    const targetLayer = rows[visibleRow.maskId - 1];
    if (!targetLayer || !targetLayer.isLayer)
      fail(`T3 visible.maskId=${visibleRow.maskId} doesn't point to a layer row; rows=${JSON.stringify(rows)}`);
    else if (Math.abs(targetLayer.bboxY[1] - 90) > 0.1)
      fail(`T3 visible's mask is the ANCESTOR (height 10) not its OWN (height 90); bound layer bboxY=${targetLayer.bboxY}`);
    else
      ok(`T3 own mask wins over ancestor inheritance`);
  }
}

// ---- T4: parallel <g clip-path=> inheritance -----------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><clipPath id="c"><rect x="0" y="0" width="100" height="30"/></clipPath></defs>
  <g clip-path="url(#c)"><rect x="0" y="0" width="100" height="100" fill="#888"/></g>
</svg>`;
  const s = await importSvg(svg, {});
  const rows = inspect(s);
  if (rows[0].clipId === 0)
    fail(`T4 clip-path didn't propagate from <g>; rows=${JSON.stringify(rows)}`);
  else
    ok(`T4 <g clip-path=> propagates to descendant shapes`);
}

console.log();
console.log(failures === 0 ? 'MASK-INHERITANCE PASS' : `MASK-INHERITANCE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
