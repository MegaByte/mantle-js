// Vertical writing-mode through the dynamic-text bundle bridge
// (buildTextSections / createTextBundle).
//
// Contract:
//   - writingMode/textOrientation forward through layoutFromStyle.
//   - vertical-rl/-lr stack glyphs DOWN the column (+Y dominant).
//   - origin normalization still pins the bundle globalBBox to (0,0)
//     in vertical mode (origin shift re-applied in the re-aimed space).
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextSections } from '../../src/textBundle.js';

let failures = 0;
const ok   = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));

function readBundle(sections) {
  const dv = new DataView(sections.meta);
  const numShapes = dv.getUint32(0, true);
  const gbb = [
    dv.getFloat32(4, true), dv.getFloat32(8, true),
    dv.getFloat32(12, true), dv.getFloat32(16, true),
  ];
  const stride = sections.metaFloatsPerShape;
  const f = new Float32Array(sections.meta, 32);
  const boxes = [];
  for (let i = 0; i < numShapes; i++) {
    boxes.push([f[i*stride+0], f[i*stride+1], f[i*stride+2], f[i*stride+3]]);
  }
  return { numShapes, gbb, boxes };
}
// Net stacking axis = displacement of last glyph box from the first.
function stackAxis(boxes) {
  const dx = Math.abs(boxes[boxes.length-1][0] - boxes[0][0]);
  const dy = Math.abs(boxes[boxes.length-1][1] - boxes[0][1]);
  return { dx, dy, axis: dx > dy ? 'x' : 'y' };
}

const base = { fill: [0,0,0,1], fontSizePx: 1, family: 'Arial' };

const h  = readBundle((await buildTextSections(arial, 'ABCD', { ...base }, false)).sections);
const vr = readBundle((await buildTextSections(arial, 'ABCD', { ...base, writingMode: 'vertical-rl' }, false)).sections);
const vl = readBundle((await buildTextSections(arial, 'ABCD', { ...base, writingMode: 'vertical-lr' }, false)).sections);

// ---- T1: all three emit one shape per glyph -----------------------
if (h.numShapes === 4 && vr.numShapes === 4 && vl.numShapes === 4)
  ok('T1 4 glyph-shapes emitted in each writing mode');
else
  fail(`T1 numShapes h=${h.numShapes} vr=${vr.numShapes} vl=${vl.numShapes} (expected 4)`);

// ---- T2: horizontal stacks along X --------------------------------
{
  const a = stackAxis(h.boxes);
  if (a.axis === 'x') ok(`T2 horizontal stacks along X (dx=${a.dx.toFixed(2)} dy=${a.dy.toFixed(2)})`);
  else fail(`T2 horizontal expected X-dominant, got dx=${a.dx.toFixed(2)} dy=${a.dy.toFixed(2)}`);
}

// ---- T3: vertical-rl stacks DOWN the column (Y) -------------------
{
  const a = stackAxis(vr.boxes);
  if (a.axis === 'y' && a.dy > 1) ok(`T3 vertical-rl stacks along Y (dy=${a.dy.toFixed(2)} dx=${a.dx.toFixed(2)})`);
  else fail(`T3 vertical-rl expected Y-dominant stack, got dx=${a.dx.toFixed(2)} dy=${a.dy.toFixed(2)}`);
}

// ---- T4: writingMode is actually honored (not horizontal echo) ----
{
  // Vertical output must not be byte-identical to horizontal; compare
  // the per-glyph box positions.
  const identical = h.boxes.every((b, i) =>
    Math.abs(b[0] - vr.boxes[i][0]) < 1e-4 && Math.abs(b[1] - vr.boxes[i][1]) < 1e-4);
  if (!identical) ok('T4 vertical layout differs from horizontal (writingMode honored, not dropped)');
  else fail('T4 vertical output identical to horizontal — writingMode dropped (regression)');
}

// ---- T5: vertical bundle globalBBox pinned to (0,0) ---------------
for (const [tag, b] of [['vertical-rl', vr], ['vertical-lr', vl]]) {
  const [x, y] = b.gbb;
  if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3)
    ok(`T5 ${tag} globalBBox origin pinned to (0,0) [${b.gbb.map(n=>n.toFixed(3)).join(', ')}]`);
  else
    fail(`T5 ${tag} globalBBox origin not pinned: xmin=${x.toFixed(3)} ymin=${y.toFixed(3)}`);
}

// ---- T6: vertical bundle is taller than wide ---------------------
{
  const [, , w, ht] = vr.gbb;
  if (ht > w) ok(`T6 vertical bundle is taller than wide (h=${ht.toFixed(2)} > w=${w.toFixed(2)})`);
  else fail(`T6 vertical bundle not column-shaped: w=${w.toFixed(2)} h=${ht.toFixed(2)}`);
}

console.log();
console.log(failures === 0 ? 'TEXT-BUNDLE-VERTICAL PASS' : `TEXT-BUNDLE-VERTICAL FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
