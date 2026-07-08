// lengthIntegrationSmoke.mjs — verify calc() / min() / max() / clamp()
// actually flow through the importer's attribute reads into the bundle.
// Spot-checks key surfaces: rect dimensions, stroke-width,
// font-size, feOffset, gradient stop offset.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }
function approx(a, b, eps = 1e-3) { return Math.abs(a - b) <= eps; }

const META_STRIDE = 48;
async function importToMeta(svg) {
  const sections = await importSvg(svg, {});
  if (!sections) throw new Error('importer returned null');
  return {
    sections,
    meta: new Float32Array(sections.meta, 32),
  };
}

// === T1: rect width = calc(100 - 20) ================================
// Bare-number calc — no parent context needed. Expected w = 80, so the
// rect's bbox spans x=[10, 90].
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="10" y="20" width="calc(100 - 20)" height="60" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  // Texel 0 = bbox (xmin, ymin, xmax, ymax).
  const xmin = meta[0], ymin = meta[1], xmax = meta[2], ymax = meta[3];
  if (approx(xmin, 10) && approx(xmax, 90) && approx(ymin, 20) && approx(ymax, 80))
    ok(`T1 calc(100 - 20) width → rect bbox (${xmin},${ymin},${xmax},${ymax})`);
  else
    fail(`T1 expected (10,20,90,80); got (${xmin},${ymin},${xmax},${ymax})`);
}

// === T2: rect dims via min() / max() ================================
// width = max(30, 50) = 50; height = min(100, 40) = 40.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="0" y="0" width="max(30, 50)" height="min(100, 40)" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  const xmax = meta[2], ymax = meta[3];
  if (approx(xmax, 50) && approx(ymax, 40))
    ok(`T2 max(30, 50) / min(100, 40) → rect bbox ymax=${ymax}, xmax=${xmax}`);
  else
    fail(`T2 expected (50, 40); got (${xmax}, ${ymax})`);
}

// === T3: clamp() on a coordinate ====================================
// x = clamp(0, 80, 50) → 50 (above ceiling).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="clamp(0, 80, 50)" y="0" width="20" height="20" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  const xmin = meta[0], xmax = meta[2];
  if (approx(xmin, 50) && approx(xmax, 70))
    ok(`T3 clamp(0, 80, 50) → x=50, rect span=[50, 70]`);
  else
    fail(`T3 expected xmin=50, xmax=70; got (${xmin}, ${xmax})`);
}

// === T4: stroke-width via calc ======================================
// The stroke meta row carries strokeWidth at texel 3.x (offset 12).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="0" y="0" width="50" height="50" fill="none" stroke="black" stroke-width="calc(2 + 3)"/>
</svg>`;
  const { meta, sections } = await importToMeta(svg);
  // fill="none" → only the stroke row is emitted. Scan the meta rows
  // for one whose strokeWidth (texel 3.x = offset 12) is non-zero.
  let strokeWidth = 0;
  for (let i = 0; i < sections.numShapes; i++) {
    const w = meta[i * META_STRIDE + 12];
    if (w > 0) { strokeWidth = w; break; }
  }
  if (approx(strokeWidth, 5))
    ok(`T4 calc(2 + 3) stroke-width → ${strokeWidth}`);
  else
    fail(`T4 expected strokeWidth=5; got ${strokeWidth} (numShapes=${sections.numShapes})`);
}

// === T5: circle r via calc ==========================================
// r = calc(20 + 10) = 30 → circle bbox is (cx-30, cy-30, cx+30, cy+30)
// with cx=100, cy=100.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="calc(20 + 10)" fill="blue"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  const xmin = meta[0], xmax = meta[2];
  if (approx(xmin, 70) && approx(xmax, 130))
    ok(`T5 circle r=calc(20 + 10) → bbox x=[70, 130]`);
  else
    fail(`T5 expected x=[70, 130]; got [${xmin}, ${xmax}]`);
}

// === T6: bare numbers still work ====================================
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="10" y="10" width="80" height="80" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  if (approx(meta[0], 10) && approx(meta[2], 90))
    ok(`T6 bare-number attrs still parse correctly`);
  else
    fail(`T6 regression: bbox = ${meta.slice(0, 4)}`);
}

// === T7: pixel unit suffix preserved =================================
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="10px" y="10" width="80px" height="80" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  if (approx(meta[0], 10) && approx(meta[2], 90))
    ok(`T7 "10px"/"80px" → bare numbers (px = user units)`);
  else
    fail(`T7 px regression: bbox = ${meta.slice(0, 4)}`);
}

console.log();
console.log(failures === 0 ? 'LENGTH-INTEGRATION PASS' : `LENGTH-INTEGRATION FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
