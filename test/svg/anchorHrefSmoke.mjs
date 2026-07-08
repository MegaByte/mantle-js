// anchorHrefSmoke.mjs — verify <a href> URLs propagate to per-shape
// bundle.shapeHrefs so a hit-test consumer can map a hit position to
// a link target.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

// ----- T1: shape inside <a> carries the href -----------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <a href="https://example.com">
    <rect x="0" y="0" width="100" height="100" fill="red"/>
  </a>
</svg>`;
  const b = await importSvg(svg, {});
  if (!b.shapeHrefs || b.shapeHrefs.length !== b.numShapes)
    fail(`T1 shapeHrefs length mismatch: ${b.shapeHrefs?.length} vs numShapes ${b.numShapes}`);
  else if (b.shapeHrefs[0] !== 'https://example.com')
    fail(`T1 expected https://example.com, got '${b.shapeHrefs[0]}'`);
  else ok(`T1 <a href> propagates to bundle.shapeHrefs[0]`);
}

// ----- T2: shapes OUTSIDE <a> get empty href -----------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="40" height="40" fill="red"/>
  <a href="https://link.example">
    <rect x="50" y="50" width="40" height="40" fill="blue"/>
  </a>
  <rect x="80" y="80" width="10" height="10" fill="green"/>
</svg>`;
  const b = await importSvg(svg, {});
  if (b.shapeHrefs.length !== 3) fail(`T2 expected 3 shapes, got ${b.shapeHrefs.length}`);
  // First and third rects: outside <a>, href = ''
  // Middle rect: inside <a>, href = 'https://link.example'
  else if (b.shapeHrefs[0] !== '' || b.shapeHrefs[2] !== '')
    fail(`T2 outside-anchor shapes should have empty href`);
  else if (b.shapeHrefs[1] !== 'https://link.example')
    fail(`T2 inside-anchor shape href wrong: '${b.shapeHrefs[1]}'`);
  else ok(`T2 only inside-anchor shapes carry href: [${b.shapeHrefs.join(', ')}]`);
}

// ----- T3: nested <a> — innermost wins -----------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <a href="outer">
    <rect x="0" y="0" width="40" height="40" fill="red"/>
    <a href="inner">
      <rect x="50" y="50" width="40" height="40" fill="blue"/>
    </a>
  </a>
</svg>`;
  const b = await importSvg(svg, {});
  if (b.shapeHrefs[0] !== 'outer') fail(`T3 first shape: outer`);
  else if (b.shapeHrefs[1] !== 'inner') fail(`T3 second shape: inner (innermost wins)`);
  else ok('T3 nested <a>: innermost href applies');
}

// ----- T4: xlink:href fallback -------------------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
  <a xlink:href="legacy">
    <rect x="0" y="0" width="40" height="40" fill="red"/>
  </a>
</svg>`;
  const b = await importSvg(svg, {});
  if (b.shapeHrefs[0] !== 'legacy') fail(`T4 xlink:href fallback: '${b.shapeHrefs[0]}'`);
  else ok('T4 xlink:href fallback when href missing');
}

// ----- T5: <a> with no href is a transparent group -----------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <a>
    <rect x="0" y="0" width="40" height="40" fill="red"/>
  </a>
</svg>`;
  const b = await importSvg(svg, {});
  if (b.shapeHrefs[0] !== '') fail(`T5 <a> with no href should leave empty: '${b.shapeHrefs[0]}'`);
  else ok('T5 <a> with no href → empty (transparent group)');
}

if (failures > 0) {
  console.error(`\nANCHOR-HREF FAIL (${failures})`);
  process.exit(1);
}
console.log('\nANCHOR-HREF PASS');
