// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textMaskInheritanceSmoke.mjs — verifies <text> mask/clip-path
// inheritance: the <text> branch reads its own mask/clip-path
// attribute AND falls back to the ancestor stack, so a <text> inside
// <g mask="url(#m)"> is clipped like its sibling <path> elements.
import { readFileSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../../src/svg/importer.js';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';

let failures = 0;
const ok = (msg) => console.log('ok', msg);
const fail = (msg) => {
  failures++;
  console.error('FAIL', msg);
};

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);

const STRIDE = 48;
const META_MASKID = 31;
const META_CLIPID = 30;
const META_FLAGS = 27;
const FLAG_LAYER = 0x100;

function inspect(sections) {
  const mf = new Float32Array(sections.meta, 32);
  const rows = [];
  for (let i = 0; i < sections.numShapes; i++) {
    const b = i * STRIDE;
    const flags = (mf[b + META_FLAGS] + 0.5) | 0;
    rows.push({
      idx: i,
      maskId: (mf[b + META_MASKID] + 0.5) | 0,
      clipId: (mf[b + META_CLIPID] + 0.5) | 0,
      isLayer: (flags & FLAG_LAYER) !== 0,
      id: sections.shapeIds[i],
    });
  }
  return rows;
}

// ---- T1: <text> inside <g mask=> inherits the mask ------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><mask id="m"><rect x="0" y="50" width="100" height="50" fill="#fff"/></mask></defs>
  <g mask="url(#m)">
    <rect x="0" y="0" width="100" height="100" fill="#ff0000"/>
    <text x="50" y="30" font-family="Arial" font-size="20" text-anchor="middle" fill="#0000ff">hello</text>
  </g>
</svg>`;
  const s = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const rows = inspect(s);
  // Expect: rect (1 row, maskId > 0), 5 glyph rows for "hello" (all
  // maskId > 0, all == rect's maskId), 1 mask-layer row (FLAG_LAYER).
  const visibleRows = rows.filter((r) => !r.isLayer);
  const layerRows = rows.filter((r) => r.isLayer);
  if (visibleRows.length < 6)
    fail(
      `T1 expected ≥ 6 visible rows (rect + 5 glyphs), got ${visibleRows.length}: ${JSON.stringify(rows)}`,
    );
  else if (visibleRows.some((r) => r.maskId === 0))
    fail(
      `T1 one or more visible rows have maskId=0 (mask didn't inherit). Rows: ${JSON.stringify(visibleRows)}`,
    );
  else if (layerRows.length === 0) fail(`T1 no FLAG_LAYER mask geometry row emitted`);
  else {
    const uniqueMasks = new Set(visibleRows.map((r) => r.maskId));
    if (uniqueMasks.size !== 1)
      fail(`T1 visible rows reference DIFFERENT mask ids (rect vs text): ${[...uniqueMasks]}`);
    else
      ok(`T1 <text> inside <g mask=> inherits mask (id=${[...uniqueMasks][0]} shared with rect)`);
  }
}

// ---- T2: <text> with its own mask attribute -------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><mask id="m"><rect x="0" y="0" width="100" height="40" fill="#fff"/></mask></defs>
  <text x="50" y="30" font-family="Arial" font-size="20" text-anchor="middle" fill="#000" mask="url(#m)">hi</text>
</svg>`;
  const s = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const rows = inspect(s);
  const visibleRows = rows.filter((r) => !r.isLayer);
  if (visibleRows.length < 2) fail(`T2 expected ≥ 2 glyphs, got ${visibleRows.length}`);
  else if (visibleRows.some((r) => r.maskId === 0))
    fail(`T2 <text mask=> glyphs have maskId=0: ${JSON.stringify(visibleRows)}`);
  else ok(`T2 <text mask="..."> direct attribute consumed (id=${visibleRows[0].maskId})`);
}

// ---- T3: <text> inside <g clip-path=> inherits the clip -------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><clipPath id="c"><rect x="0" y="0" width="100" height="50"/></clipPath></defs>
  <g clip-path="url(#c)">
    <text x="50" y="30" font-family="Arial" font-size="20" text-anchor="middle" fill="#000">go</text>
  </g>
</svg>`;
  const s = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const rows = inspect(s);
  const visibleRows = rows.filter((r) => !r.isLayer);
  if (visibleRows.some((r) => r.clipId === 0))
    fail(`T3 <text> inside <g clip-path=> has clipId=0: ${JSON.stringify(visibleRows)}`);
  else ok(`T3 <text> inside <g clip-path=> inherits the clip`);
}

// ---- T4: bare <text> (no mask anywhere) — no inheritance ghost ------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <text x="50" y="30" font-family="Arial" font-size="20" fill="#000">plain</text>
</svg>`;
  const s = await importSvg(svg, {
    fonts: { Arial: arial },
    svgTextLayout: buildSvgTextGlyphs,
  });
  const rows = inspect(s);
  if (rows.some((r) => r.maskId !== 0 || r.clipId !== 0))
    fail(`T4 plain <text> picked up a phantom mask/clip: ${JSON.stringify(rows)}`);
  else ok(`T4 bare <text> with no mask/clip in ancestry stays at 0 (no ghost inheritance)`);
}

console.log();
console.log(
  failures === 0 ? 'TEXT-MASK-INHERITANCE PASS' : `TEXT-MASK-INHERITANCE FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
