// <tspan> recursion + per-span fills + dx/dy.
//
// Builds SVG <text> with nested <tspan> children, runs through
// importSvg, and verifies:
//   - per-span fills land on the right glyphs (color check)
//   - dx/dy shifts the pen as expected (position check)
//   - per-span font-size scales advance independently
//   - inherited style still works when tspan doesn't override

import { readFileSync } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import importSvg from '../../src/svg/importer.js';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

const arial = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const importOpts = { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs };

// importSvg bundles expose `meta` as a raw ArrayBuffer:
//   [32-byte header: count(u32), minX/minY/gw/gh(f32×4), pad(8 bytes)]
//   [body: shapes * (48 × float32 = 192 bytes per shape)]
// Body layout per shape (v3): floats 0..3 = bbox(xmin,ymin,xmax,ymax),
// floats 4..7 = fillColor(r,g,b,a). Use a Float32Array starting at
// the post-header offset.
const META_HEADER_BYTES = 32;
const asMetaF32 = (bundle) =>
  new Float32Array(bundle.meta, META_HEADER_BYTES,
    bundle.numShapes * bundle.metaFloatsPerShape);
const readFill = (bundle, mf, i) => {
  const stride = bundle.metaFloatsPerShape;
  return [mf[i*stride+4], mf[i*stride+5], mf[i*stride+6], mf[i*stride+7]];
};
const readXmin = (bundle, mf, i) => mf[i*bundle.metaFloatsPerShape];
const readBboxH = (bundle, mf, i) => {
  const s = bundle.metaFloatsPerShape;
  return mf[i*s+3] - mf[i*s+1];
};

// ---- T1: simple <tspan> with override fill ----
{
  // "ABC" — middle char (B) red.
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">A<tspan fill="red">B</tspan>C</text>
</svg>`;
  const bundle = await importSvg(svg, importOpts);
  if (bundle.numShapes !== 3) fail(`T1 expected 3 shapes, got ${bundle.numShapes}`);
  else {
    const mf = asMetaF32(bundle);
    let blacks = 0, reds = 0;
    for (let i = 0; i < bundle.numShapes; i++) {
      const [r, g, b] = readFill(bundle, mf, i);
      if (r > 0.9 && g < 0.1 && b < 0.1) reds++;
      else if (r < 0.1 && g < 0.1 && b < 0.1) blacks++;
    }
    if (reds !== 1 || blacks !== 2) fail(`T1 reds=${reds} blacks=${blacks} (expected 1 red, 2 black)`);
    else ok(`T1 <tspan fill=red> per-span: 1 red (B), 2 black (A, C)`);
  }
}

// ---- T2: dx shifts the pen ----
{
  // "A<tspan dx=20>B" — 'A' at x≈10, 'B' at x≈10+adv(A)+20.
  const svgNoDx = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">A<tspan>B</tspan></text>
</svg>`;
  const svgWithDx = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">A<tspan dx="20">B</tspan></text>
</svg>`;
  const b1 = await importSvg(svgNoDx, importOpts);
  const b2 = await importSvg(svgWithDx, importOpts);
  if (b1.numShapes !== 2 || b2.numShapes !== 2) fail(`T2 numShapes ${b1.numShapes}/${b2.numShapes}`);
  else {
    const mf1 = asMetaF32(b1), mf2 = asMetaF32(b2);
    const xB1 = readXmin(b1, mf1, 1);
    const xB2 = readXmin(b2, mf2, 1);
    const dxApplied = xB2 - xB1;
    if (Math.abs(dxApplied - 20) > 1) fail(`T2 dx not applied; B xmin shifted ${dxApplied.toFixed(2)} (expected ~20)`);
    else ok(`T2 dx=20 shifts pen: B xmin ${xB1.toFixed(2)} → ${xB2.toFixed(2)} (Δ=${dxApplied.toFixed(2)})`);
  }
}

// ---- T3: per-span font-size ----
{
  // "A<tspan font-size=48>B"C — bigger B should be substantially taller.
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <text x="10" y="50" font-family="Arial" font-size="12" fill="black">A<tspan font-size="48">B</tspan>C</text>
</svg>`;
  const bundle = await importSvg(svg, importOpts);
  if (bundle.numShapes !== 3) fail(`T3 expected 3 shapes, got ${bundle.numShapes}`);
  else {
    const mf = asMetaF32(bundle);
    const hA = readBboxH(bundle, mf, 0);
    const hB = readBboxH(bundle, mf, 1);
    const hC = readBboxH(bundle, mf, 2);
    if (hB < hA * 3) fail(`T3 big B height ${hB.toFixed(2)} not 3× small A height ${hA.toFixed(2)}`);
    else ok(`T3 per-span font-size: A=${hA.toFixed(2)}px tall, B=${hB.toFixed(2)}px tall, C=${hC.toFixed(2)}px tall`);
  }
}

// ---- T4: nested <tspan> inherits then overrides ----
{
  // <tspan fill=red><tspan font-size=32>X</tspan></tspan>
  // Inner tspan inherits red but overrides size.
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <text x="10" y="50" font-family="Arial" font-size="16" fill="black"><tspan fill="red"><tspan font-size="32">X</tspan></tspan></text>
</svg>`;
  const bundle = await importSvg(svg, importOpts);
  if (bundle.numShapes !== 1) fail(`T4 expected 1 shape, got ${bundle.numShapes}`);
  else {
    const mf = asMetaF32(bundle);
    const [r, g, b] = readFill(bundle, mf, 0);
    const h = readBboxH(bundle, mf, 0);
    if (r < 0.9 || g > 0.1) fail(`T4 nested tspan didn't inherit red: rgba=[${r},${g},${b}]`);
    else if (h < 20) fail(`T4 nested tspan didn't override size: height=${h}`);
    else ok(`T4 nested <tspan>: inherited red + overridden size (h=${h.toFixed(2)}px)`);
  }
}

// ---- T5: pen continues across tspans ----
{
  // "A<tspan>BC</tspan>D" — D should land right after BC (no gap).
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">A<tspan>BC</tspan>D</text>
</svg>`;
  // Reference: same string with no tspan should look identical.
  const ref = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <text x="10" y="50" font-family="Arial" font-size="24" fill="black">ABCD</text>
</svg>`;
  const b1 = await importSvg(svg, importOpts);
  const b2 = await importSvg(ref, importOpts);
  if (b1.numShapes !== 4 || b2.numShapes !== 4) fail(`T5 numShapes ${b1.numShapes}/${b2.numShapes}`);
  else {
    const mf1 = asMetaF32(b1), mf2 = asMetaF32(b2);
    let maxDiff = 0;
    for (let i = 0; i < 4; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(readXmin(b1, mf1, i) - readXmin(b2, mf2, i)));
    }
    if (maxDiff > 0.05) fail(`T5 tspan vs plain xmin differ by ${maxDiff.toFixed(3)}`);
    else ok(`T5 pen continuity: tspan-wrapped 'BC' matches plain ABCD (max xmin Δ=${maxDiff.toFixed(3)})`);
  }
}

console.log();
console.log(failures === 0 ? 'SVG-TSPAN PASS' : `SVG-TSPAN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
