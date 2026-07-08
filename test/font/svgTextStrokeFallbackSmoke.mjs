// Stroke on SVG <text> and font fallback in the SVG text path.

import { readFileSync } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import importSvg from '../../src/svg/importer.js';

if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;

const arial = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
const gothic = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/AppleGothic.ttf')));
arial.getMetrics(0x41); gothic.getMetrics(0x41);

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

const META_HEADER_BYTES = 32;
const asMetaF32 = (bundle) =>
  new Float32Array(bundle.meta, META_HEADER_BYTES,
    bundle.numShapes * bundle.metaFloatsPerShape);
const readFill = (b, mf, i) => {
  const s = b.metaFloatsPerShape;
  return [mf[i*s+4], mf[i*s+5], mf[i*s+6], mf[i*s+7]];
};
const readStroke = (b, mf, i) => {
  // Layout: bbox(0-3), fill(4-7), stroke(8-11), strokeWidth(12).
  const s = b.metaFloatsPerShape;
  return [mf[i*s+8], mf[i*s+9], mf[i*s+10], mf[i*s+11]];
};
const readStrokeWidth = (b, mf, i) => mf[i*b.metaFloatsPerShape+12];

// T1: stroke="red" stroke-width=2 on <text>. The encoder splits
// fill + stroke into TWO meta rows per glyph at pack time, so a
// single 'A' yields 2 numShapes (fill row + stroke row).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="40" y="50" font-family="Arial" font-size="48" fill="white" stroke="red" stroke-width="2">A</text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  // 1 glyph × (fill + stroke) = 2 meta rows.
  if (b.numShapes !== 2) fail(`T1 expected 2 metas (fill+stroke), got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    // Find the fill row (alpha=1, non-zero RGB matching white) and
    // the stroke row (where strokeWidth > 0).
    let fillRow = -1, strokeRow = -1;
    for (let i = 0; i < b.numShapes; i++) {
      if (readStrokeWidth(b, mf, i) > 0) strokeRow = i;
      else fillRow = i;
    }
    if (fillRow < 0 || strokeRow < 0) fail(`T1 couldn't find fill+stroke rows`);
    else {
      const [fr, fg, fbl] = readFill(b, mf, fillRow);
      // Stroke row stores stroke color at the f8-11 slot (readStroke).
      const [sr, sg, sbl] = readStroke(b, mf, strokeRow);
      const sw = readStrokeWidth(b, mf, strokeRow);
      if (!(fr > 0.9 && fg > 0.9 && fbl > 0.9)) fail(`T1 fill row not white: [${fr},${fg},${fbl}]`);
      else if (!(sr > 0.9 && sg < 0.1 && sbl < 0.1)) fail(`T1 stroke row not red: [${sr},${sg},${sbl}]`);
      else if (Math.abs(sw - 2) > 0.5) fail(`T1 stroke-width=${sw}`);
      else ok(`T1 <text stroke=red sw=2>: fill row white, stroke row red sw=${sw.toFixed(2)}`);
    }
  }
}

// T2: per-tspan stroke override. 2 glyphs × (fill + stroke) = 4 rows.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="40" y="50" font-family="Arial" font-size="48" fill="white" stroke="red" stroke-width="2">A<tspan stroke="blue" stroke-width="4">B</tspan></text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  if (b.numShapes !== 4) fail(`T2 expected 4 metas, got ${b.numShapes}`);
  else {
    const mf = asMetaF32(b);
    // Look at the two stroke rows — should be one red sw=2, one blue sw=4.
    let redSw = 0, blueSw = 0;
    for (let i = 0; i < b.numShapes; i++) {
      const sw = readStrokeWidth(b, mf, i);
      if (sw <= 0) continue;
      const [r, g, bl] = readStroke(b, mf, i);  // stroke row stores color at f8-11
      if (r > 0.9 && g < 0.1) redSw = sw;
      else if (bl > 0.9 && r < 0.1) blueSw = sw;
    }
    if (Math.abs(redSw - 2) > 0.5) fail(`T2 red sw=${redSw}`);
    else if (Math.abs(blueSw - 4) > 0.5) fail(`T2 blue sw=${blueSw}`);
    else ok(`T2 per-tspan stroke: red sw=${redSw}, blue sw=${blueSw}`);
  }
}

// T3: no stroke on <text> → no stroke emitted
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="40" y="50" font-family="Arial" font-size="48" fill="black">A</text>
</svg>`;
  const b = await importSvg(svg, { fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs });
  const mf = asMetaF32(b);
  const sw = readStrokeWidth(b, mf, 0);
  if (sw > 0.01) fail(`T3 unexpected stroke width=${sw}`);
  else ok(`T3 no stroke on <text>: sw=${sw}`);
}

// T4: SVG <text> with CJK + Arial primary + Gothic fallback
{
  // Arial has Latin but no Hangul. Gothic has Hangul.
  // "Hi가" — should emit 3 shapes (H, i, 가).
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
  <text x="40" y="50" font-family="Arial" font-size="48" fill="black">Hi가</text>
</svg>`;
  // Without fallback: 가 falls back to Arial's .notdef (3 shapes still
  // because .notdef is a hollow rectangle).
  const noFb = await importSvg(svg, {
    fonts: { Arial: arial }, svgTextLayout: buildSvgTextGlyphs,
  });
  // With fallback: 가 resolves through Gothic — bbox should be larger
  // (real CJK glyph is closer to em-square than Arial's .notdef).
  // Wrapper passes fallbacks via the layout adapter.
  const layoutWithFb = (text, font, x, y, fontSize) =>
    buildSvgTextGlyphs(text, font, x, y, fontSize, [gothic]);
  const wFb = await importSvg(svg, {
    fonts: { Arial: arial }, svgTextLayout: layoutWithFb,
  });
  if (noFb.numShapes !== 3 || wFb.numShapes !== 3) {
    fail(`T4 shape counts noFb=${noFb.numShapes} wFb=${wFb.numShapes}`);
  } else {
    const mfNo = asMetaF32(noFb);
    const mfFb = asMetaF32(wFb);
    // Compare the 가 glyph (idx 2) bbox width.
    const sNo = noFb.metaFloatsPerShape;
    const wNo = mfNo[2*sNo + 2] - mfNo[2*sNo + 0];
    const wFb2 = mfFb[2*sNo + 2] - mfFb[2*sNo + 0];
    if (Math.abs(wNo - wFb2) < 1) fail(`T4 fallback didn't change 가 (widths ${wNo.toFixed(2)} vs ${wFb2.toFixed(2)})`);
    else ok(`T4 SVG fallback resolves 가: noFb w=${wNo.toFixed(2)} (.notdef) → fb w=${wFb2.toFixed(2)} (Gothic)`);
  }
}

console.log();
console.log(failures === 0 ? 'SVG-TEXT-STROKE-FALLBACK PASS' : `SVG-TEXT-STROKE-FALLBACK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
