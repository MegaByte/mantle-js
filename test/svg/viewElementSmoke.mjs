// viewElementSmoke.mjs — verify SVG <view> fragment-id resolution.
//
// The <view> element lets an SVG carry alternate viewBox/PAR pairs
// selectable via a URL fragment (e.g. `pic.svg#view=closeup`).
// importer accepts `viewName` opt; when matched, the bundle's
// viewBox comes from that <view> instead of the root.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

// Test SVG with one <view> that zooms into the top-left quadrant.
const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <view id="closeup" viewBox="0 0 50 50" preserveAspectRatio="xMidYMid meet"/>
  <view id="wide" viewBox="-50 -50 300 300"/>
  <rect x="10" y="10" width="40" height="40" fill="red"/>
</svg>`;

// ----- T1: no viewName → root viewBox 0 0 200 200 ------------------
{
  const bundle = await importSvg(svg, {});
  const [x, y, w, h] = bundle.viewBox || [0, 0, 0, 0];
  if (x !== 0 || y !== 0 || w !== 200 || h !== 200)
    fail(`T1 no-view default: expected [0,0,200,200], got [${x},${y},${w},${h}]`);
  else ok('T1 default uses root viewBox=[0,0,200,200]');
}

// ----- T2: viewName='closeup' → 0 0 50 50 --------------------------
{
  const bundle = await importSvg(svg, { viewName: 'closeup' });
  const [x, y, w, h] = bundle.viewBox || [0, 0, 0, 0];
  if (x !== 0 || y !== 0 || w !== 50 || h !== 50)
    fail(`T2 viewName=closeup: expected [0,0,50,50], got [${x},${y},${w},${h}]`);
  else ok('T2 viewName=closeup selects [0,0,50,50]');
}

// ----- T3: viewName='wide' → -50 -50 300 300 -----------------------
{
  const bundle = await importSvg(svg, { viewName: 'wide' });
  const [x, y, w, h] = bundle.viewBox || [0, 0, 0, 0];
  if (x !== -50 || y !== -50 || w !== 300 || h !== 300)
    fail(`T3 viewName=wide: expected [-50,-50,300,300], got [${x},${y},${w},${h}]`);
  else ok('T3 viewName=wide selects [-50,-50,300,300]');
}

// ----- T4: viewName='nonexistent' → falls back to root -------------
{
  const bundle = await importSvg(svg, { viewName: 'nonexistent' });
  const [x, y, w, h] = bundle.viewBox || [0, 0, 0, 0];
  if (x !== 0 || y !== 0 || w !== 200 || h !== 200)
    fail(`T4 unmatched view: expected fallback [0,0,200,200], got [${x},${y},${w},${h}]`);
  else ok('T4 unmatched viewName falls back to root viewBox');
}

// ----- T5: <view> elements don't render as content -----------------
// The bundle should have only 1 renderable shape (the <rect>);
// the <view> elements themselves emit no shapes.
{
  const bundle = await importSvg(svg, {});
  if (bundle.numShapes !== 1)
    fail(`T5 expected exactly 1 shape (the <rect>), got ${bundle.numShapes}`);
  else ok('T5 <view> elements correctly skipped in render walk');
}

if (failures > 0) {
  console.error(`\nVIEW-ELEMENT FAIL (${failures})`);
  process.exit(1);
}
console.log('\nVIEW-ELEMENT PASS');
