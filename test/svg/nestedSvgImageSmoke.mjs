// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nestedSvgImageSmoke.mjs — verify <image href="data:image/svg+xml,...">
// nesting: the inner SVG's shapes get spliced into the outer bundle
// with a transform mapping inner viewBox → outer (x, y, w, h) rect.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';
import { isSvgHref, decodeSvgDataUrl } from '../../src/svg/image.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

// ----- T1: isSvgHref classification ---------------------------------
{
  const cases = [
    ['data:image/svg+xml,<svg/>', true],
    ['data:image/svg+xml;base64,PHN2Zy8+', true],
    ['data:image/png;base64,foo', false],
    ['icon.svg', true],
    ['/path/to/icon.svg', true],
    ['icon.svg?v=2', true],
    ['icon.svg#foo', true],
    ['icon.svgz', true],
    ['icon.png', false],
    ['', false],
  ];
  let allPass = true;
  for (const [href, want] of cases) {
    const got = isSvgHref(href);
    if (got !== want) {
      fail(`T1 isSvgHref('${href}') want=${want} got=${got}`);
      allPass = false;
    }
  }
  if (allPass) ok('T1 isSvgHref classifies all 10 cases correctly');
}

// ----- T2: decodeSvgDataUrl round-trips ----------------------------
{
  const original = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  // Percent-encoded:
  const pct = 'data:image/svg+xml,' + encodeURIComponent(original);
  if (decodeSvgDataUrl(pct) !== original) fail('T2 percent-encoded round-trip');
  // Base64:
  const b64 = 'data:image/svg+xml;base64,' + Buffer.from(original, 'utf8').toString('base64');
  if (decodeSvgDataUrl(b64) !== original) fail('T2 base64 round-trip');
  ok('T2 decodeSvgDataUrl: percent-encoded + base64 both round-trip');
}

// ----- T3: nested SVG via data URL — shape count + bbox ------------
// Outer SVG places an <image> at (10, 20, 30, 40). Inner SVG has
// one red rect filling its 100×100 viewBox. After import, the bundle
// should have ≥1 shape and globalBBox should include the outer rect.
{
  const inner =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>';
  const href = 'data:image/svg+xml;base64,' + Buffer.from(inner, 'utf8').toString('base64');
  const outer = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <image x="10" y="20" width="30" height="40" href="${href}"/>
</svg>`;
  const bundle = await importSvg(outer, {});
  if (!bundle || bundle.numShapes < 1) fail(`T3 expected ≥1 shape, got ${bundle?.numShapes}`);
  else {
    // globalBBox is [xmin, ymin, w, h]. With xMidYMid meet on a
    // square 100×100 → 30×40 rect, the inner content centers in
    // a 30×30 region offset by Y=5 (40-30=10 slack / 2).
    const [bx, by, bw, bh] = bundle.globalBBox;
    // Allow some tolerance.
    if (bx < 9 || bx > 11) fail(`T3 globalBBox x off: ${bx}`);
    else if (by < 24 || by > 26) fail(`T3 globalBBox y off: ${by}`);
    else if (bw < 29 || bw > 31) fail(`T3 globalBBox w off: ${bw}`);
    else if (bh < 29 || bh > 31) fail(`T3 globalBBox h off: ${bh}`);
    else
      ok(
        `T3 nested SVG via data URL: ${bundle.numShapes} shape(s), bbox=[${bx},${by},${bw},${bh}] (xMidYMid meet centerd)`,
      );
  }
}

// ----- T4: preserveAspectRatio="none" stretches non-uniformly ------
{
  const inner =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>';
  const href = 'data:image/svg+xml,' + encodeURIComponent(inner);
  const outer = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <image x="10" y="20" width="30" height="40" preserveAspectRatio="none" href="${href}"/>
</svg>`;
  const bundle = await importSvg(outer, {});
  if (!bundle || bundle.numShapes < 1) fail('T4 expected shape');
  else {
    // 'none' → fills the whole 30×40 rect.
    const [bx, by, bw, bh] = bundle.globalBBox;
    if (
      Math.abs(bx - 10) > 0.5 ||
      Math.abs(by - 20) > 0.5 ||
      Math.abs(bw - 30) > 0.5 ||
      Math.abs(bh - 40) > 0.5
    )
      fail(`T4 PAR=none expected [10,20,30,40], got [${bx},${by},${bw},${bh}]`);
    else ok(`T4 preserveAspectRatio="none" fills full 30×40 rect`);
  }
}

// ----- T5: external *.svg URL via svgTextLoader callback -----------
{
  const inner =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="green"/></svg>';
  const outer = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <image x="0" y="0" width="100" height="100" href="icon.svg"/>
</svg>`;
  let calls = 0;
  const loader = async (href) => {
    calls++;
    if (href === 'icon.svg') return inner;
    return null;
  };
  const bundle = await importSvg(outer, { svgTextLoader: loader });
  if (calls !== 1) fail(`T5 svgTextLoader call count: expected 1, got ${calls}`);
  else if (!bundle || bundle.numShapes < 1) fail('T5 expected shape from loader');
  else ok(`T5 external *.svg URL resolved via svgTextLoader (${bundle.numShapes} shapes)`);
}

// ----- T6: malformed inner SVG is gracefully skipped ---------------
{
  const inner = 'this is not XML';
  const href = 'data:image/svg+xml,' + encodeURIComponent(inner);
  const outer = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
  <image x="0" y="0" width="50" height="50" href="${href}"/>
</svg>`;
  try {
    const bundle = await importSvg(outer, {});
    // The outer <rect> should still render; the bad inner is skipped.
    if (bundle.numShapes < 1) fail('T6 outer rect should still render despite bad inner');
    else ok(`T6 malformed inner SVG skipped, outer renders (${bundle.numShapes} shapes)`);
  } catch (e) {
    fail(`T6 crashed on malformed inner: ${e.message}`);
  }
}

if (failures > 0) {
  console.error(`\nNESTED-SVG-IMAGE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nNESTED-SVG-IMAGE PASS');
