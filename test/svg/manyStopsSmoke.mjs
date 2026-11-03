// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// manyStopsSmoke.mjs — verifies gradients with many stops parse and
// pack through the bundle without being clipped. Stop count is capped
// at 65536 (sentinels included); gradientManyStopsSmoke covers the cap.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';
import { packGradientStops } from '../../src/svg/gradient.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

// ----- T1: packGradientStops keeps a 40-stop gradient intact -------
{
  const stops = [];
  for (let i = 0; i < 40; i++) {
    stops.push({ offset: i / 39, color: [i / 39, 1 - i / 39, 0.5, 1] });
  }
  const packed = packGradientStops({ stops });
  // Two RGBA8 texels per stop (straight RGBA + offset) = 8 bytes each.
  if (packed.length !== 40 * 8) fail(`T1 expected 40 stops × 8 = 320 bytes, got ${packed.length}`);
  else ok(`T1 40-stop gradient packs to ${packed.length} bytes (no 32-cap clip)`);
}

// ----- T2: 200-stop gradient packs
{
  const stops = [];
  for (let i = 0; i < 200; i++) {
    stops.push({ offset: i / 199, color: [0, 0, 0, 1] });
  }
  const packed = packGradientStops({ stops });
  if (packed.length < 200 * 8) fail(`T2 200 stops should not be clipped, got ${packed.length}`);
  else ok(`T2 200-stop gradient packs intact`);
}

// ----- T3: a 300-stop gradient packs intact (the 256 cap is gone) --
{
  const stops = [];
  for (let i = 0; i < 300; i++) {
    stops.push({ offset: i / 299, color: [0, 0, 0, 1] });
  }
  const packed = packGradientStops({ stops });
  if (packed.length !== 300 * 8)
    fail(`T3 expected 300 stops × 8 = 2400 bytes, got ${packed.length}`);
  else ok('T3 300-stop gradient packs intact (no 256 cap)');
}

// ----- T4: end-to-end through importSvg ----------------------------
{
  const stopsXml = [];
  for (let i = 0; i < 50; i++) {
    const t = i / 49;
    const r = Math.round(t * 255);
    const g = Math.round((1 - t) * 255);
    stopsXml.push(`<stop offset="${t}" stop-color="rgb(${r},${g},0)"/>`);
  }
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g50">${stopsXml.join('')}</linearGradient>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="url(#g50)"/>
</svg>`;
  const b = await importSvg(svg, {});
  if (!b.gradientStops) fail('T4 no gradient stops in bundle');
  else if (b.gradientStopsCount < 50)
    fail(`T4 50-stop gradient: expected ≥50, got ${b.gradientStopsCount}`);
  else ok(`T4 importSvg end-to-end: ${b.gradientStopsCount} total stops shipped (50 expected)`);
}

if (failures > 0) {
  console.error(`\nMANY-STOPS FAIL (${failures})`);
  process.exit(1);
}
console.log('\nMANY-STOPS PASS');
