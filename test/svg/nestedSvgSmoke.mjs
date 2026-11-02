// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nestedSvgSmoke.mjs — verify nested <svg> elements get viewport + viewBox
// + preserveAspectRatio handling (SVG 1.1 §7.2, §7.8).
//
// Each test embeds a child <svg> inside the root and checks the post-transform
// bbox of a rect inside the child, read out of meta texel 0 (xmin,ymin,xmax,ymax).

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const META_STRIDE = 48;
async function bbox(svg) {
  const sections = await importSvg(svg, {});
  const meta = new Float32Array(sections.meta, 32);
  return [meta[0], meta[1], meta[2], meta[3]];
}

// === T1: nested <svg> x/y offset (no viewBox) ========================
// Inner rect (0,0,10,10) inside <svg x=50 y=20> → bbox (50,20,60,30).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <svg x="50" y="20">
    <rect x="0" y="0" width="10" height="10" fill="red"/>
  </svg>
</svg>`;
  const [x0, y0, x1, y1] = await bbox(svg);
  if (approx(x0, 50) && approx(y0, 20) && approx(x1, 60) && approx(y1, 30))
    ok(`T1 nested x/y offset → bbox (${x0},${y0},${x1},${y1})`);
  else fail(`T1 expected (50,20,60,30); got (${x0},${y0},${x1},${y1})`);
}

// === T2: nested viewBox scales coords =================================
// width=100, height=100; viewBox 0 0 50 50 → uniform 2× scale. Rect
// (10,10,20,20) in viewBox space → (20,20,40,40) in parent space.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <svg x="0" y="0" width="100" height="100" viewBox="0 0 50 50">
    <rect x="10" y="10" width="10" height="10" fill="red"/>
  </svg>
</svg>`;
  const [x0, y0, x1, y1] = await bbox(svg);
  if (approx(x0, 20) && approx(y0, 20) && approx(x1, 40) && approx(y1, 40))
    ok(`T2 nested viewBox 2× scale → bbox (${x0},${y0},${x1},${y1})`);
  else fail(`T2 expected (20,20,40,40); got (${x0},${y0},${x1},${y1})`);
}

// === T3: preserveAspectRatio=none stretches independently =============
// width=200 height=100, viewBox 0 0 50 50 → 4× horiz, 2× vert.
// Rect (10,10,20,20) → (40,20,80,40).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <svg x="0" y="0" width="200" height="100" viewBox="0 0 50 50"
       preserveAspectRatio="none">
    <rect x="10" y="10" width="10" height="10" fill="red"/>
  </svg>
</svg>`;
  const [x0, y0, x1, y1] = await bbox(svg);
  if (approx(x0, 40) && approx(y0, 20) && approx(x1, 80) && approx(y1, 40))
    ok(`T3 PAR=none anisotropic scale → bbox (${x0},${y0},${x1},${y1})`);
  else fail(`T3 expected (40,20,80,40); got (${x0},${y0},${x1},${y1})`);
}

// === T4: PAR=xMidYMid meet centers within larger box ==================
// width=200 height=100, viewBox 0 0 50 50. Aspect=2:1 vs 1:1 → meet
// scale = min(4, 2) = 2. Drawn region 100×100, centered → x-padding
// (200-100)/2 = 50. Rect (10,10,20,20) → (50+20, 20, 50+40, 40)
//                                       = (70, 20, 90, 40).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <svg x="0" y="0" width="200" height="100" viewBox="0 0 50 50">
    <rect x="10" y="10" width="10" height="10" fill="red"/>
  </svg>
</svg>`;
  const [x0, y0, x1, y1] = await bbox(svg);
  if (approx(x0, 70) && approx(y0, 20) && approx(x1, 90) && approx(y1, 40))
    ok(`T4 PAR=xMidYMid meet centers → bbox (${x0},${y0},${x1},${y1})`);
  else fail(`T4 expected (70,20,90,40); got (${x0},${y0},${x1},${y1})`);
}

// === T5: PAR=xMinYMin slice scales-to-cover, anchors min/min ==========
// width=200 height=100, viewBox 0 0 50 50. slice scale = max(4, 2) = 4.
// Rect (10,10,20,20) → (40, 40, 80, 80) (anchored at min/min).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <svg x="0" y="0" width="200" height="100" viewBox="0 0 50 50"
       preserveAspectRatio="xMinYMin slice">
    <rect x="10" y="10" width="10" height="10" fill="red"/>
  </svg>
</svg>`;
  const [x0, y0, x1, y1] = await bbox(svg);
  if (approx(x0, 40) && approx(y0, 40) && approx(x1, 80) && approx(y1, 80))
    ok(`T5 PAR=xMinYMin slice → bbox (${x0},${y0},${x1},${y1})`);
  else fail(`T5 expected (40,40,80,80); got (${x0},${y0},${x1},${y1})`);
}

// === T6: doubly-nested SVG composes correctly =========================
// Outer nested: x=10 (no viewBox, identity scale).
// Inner nested: x=0 y=0 width=40 height=40 viewBox=0 0 20 20 → 2× scale.
// Inner rect (1,1,5,5) → 2×→(2,2,10,10) → +outer translate (12,2,20,10).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <svg x="10" y="0">
    <svg x="0" y="0" width="40" height="40" viewBox="0 0 20 20">
      <rect x="1" y="1" width="4" height="4" fill="red"/>
    </svg>
  </svg>
</svg>`;
  const [x0, y0, x1, y1] = await bbox(svg);
  if (approx(x0, 12) && approx(y0, 2) && approx(x1, 20) && approx(y1, 10))
    ok(`T6 doubly-nested compose → bbox (${x0},${y0},${x1},${y1})`);
  else fail(`T6 expected (12,2,20,10); got (${x0},${y0},${x1},${y1})`);
}

// === T7: nested viewBox with non-zero min anchors at origin ==========
// width=100 height=100 viewBox="10 10 50 50" → vbX=10 offsets origin so
// rect at (10,10,20,20) in viewBox space lands at (0,0,20,20) parent.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <svg x="0" y="0" width="100" height="100" viewBox="10 10 50 50">
    <rect x="10" y="10" width="10" height="10" fill="red"/>
  </svg>
</svg>`;
  const [x0, y0, x1, y1] = await bbox(svg);
  if (approx(x0, 0) && approx(y0, 0) && approx(x1, 20) && approx(y1, 20))
    ok(`T7 non-zero viewBox min anchors at origin → bbox (${x0},${y0},${x1},${y1})`);
  else fail(`T7 expected (0,0,20,20); got (${x0},${y0},${x1},${y1})`);
}

console.log();
console.log(failures === 0 ? 'NESTED-SVG PASS' : `NESTED-SVG FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
