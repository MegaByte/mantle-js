// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerClipMaskSmoke — a marker takes the referencing path's clip-path and mask.
//
// A marker renders as part of the path that references it (SVG 2 §13.7.2), so whatever clips or masks the path clips
// or masks its markers. Marker rows given clipId 0 (or only their own viewport clip) and maskId 0 would draw a
// clipped path's markers in full outside the clip and through a black mask.
//
// So marker rows carry the path's CLAIMED clip and mask entries -- the same entries, so an objectBoundingBox clip or
// mask stays bound to the PATH's box (not the marker's) and a group's clip to the group's -- and a marker whose content
// overflows its viewport is clipped by the viewport AND the path's clip (nestClipDef).
//
// Markers here are 10 x 10 squares centered on each vertex (refX/refY 5, userSpaceOnUse, orient 0) on a path that
// paints nothing itself, so what answers the hit test is the markers alone; each case is checked on a grid against
// (union of the squares) cut by the clip or mask SVG defines, skipping points within 0.2 of a boundary, and again
// under scale(2^-20) and scale(2^20) through the hit test's worldMatrix. The meta rows are checked to carry the
// path's entries.
import { fillHits, HitMode } from '../src/hitTest/index.js';
// Rendered marker geometry is probed through HitMode.Coverage: SVG 2 §13.7.4 "Markers cannot be interacted with", so the default (SVG) model never targets marker content.

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const box = (x0, y0, x1, y1) => ({
  in: (q) => q[0] > x0 && q[0] < x1 && q[1] > y0 && q[1] < y1,
  d: (q) =>
    Math.min(Math.abs(q[0] - x0), Math.abs(q[0] - x1), Math.abs(q[1] - y0), Math.abs(q[1] - y1)),
});
const and = (...R) => ({
  in: (q) => R.every((r) => r.in(q)),
  d: (q) => Math.min(...R.map((r) => r.d(q))),
});
const or = (...R) => ({
  in: (q) => R.some((r) => r.in(q)),
  d: (q) => Math.min(...R.map((r) => r.d(q))),
});
const sq = ([x, y], h = 5) => box(x - h, y - h, x + h, y + h);

const V = [
  [20, 30],
  [50, 60],
  [80, 70],
]; // the path's vertices
const SQUARES = or(...V.map((v) => sq(v)));
const MARKER =
  '<marker id="m" refX="5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="0">' +
  '<path d="M0 0 H10 V10 H0 Z" fill="#000"/></marker>';
// content 20 x 20 around the 10 x 10 viewport: the viewport clip keeps the same 10 x 10 square
const BIG =
  '<marker id="m" refX="5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="0">' +
  '<path d="M-5 -5 H15 V15 H-5 Z" fill="#000"/></marker>';
const PATH = (attrs) =>
  `<path d="M${V.map((v) => v.join(' ')).join(' L')}" fill="none" stroke="none" marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)" ${attrs}/>`;
const svgOf = (defs, body, s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 * s} ${100 * s}"><defs>${defs}</defs>` +
  (s === 1 ? body : `<g transform="scale(${s})">${body}</g>`) +
  '</svg>';

async function check(name, defs, body, want) {
  for (const s of [1, 2 ** -20, 2 ** 20]) {
    const b = await importSvg(svgOf(defs, body, s));
    const o = { mode: HitMode.Coverage, worldMatrix: [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1] };
    let n = 0,
      nIn = 0,
      bad = 0,
      first = '';
    for (let y = 0.37; y < 100; y += 0.71)
      for (let x = 0.29; x < 100; x += 0.71) {
        const q = [x, y];
        if (want.d(q) < 0.2) continue;
        const w = want.in(q),
          got = fillHits(b, x, y, o).length > 0;
        n++;
        if (w) nIn++;
        if (got !== w) {
          bad++;
          if (!first) first = ` -- first (${x.toFixed(2)}, ${y.toFixed(2)}): ${w ? 'miss' : 'hit'}`;
        }
      }
    ok(
      nIn > 20 && bad === 0,
      `${name}${s === 1 ? '' : s < 1 ? ' at 2^-20' : ' at 2^20'}: ${bad} of ${n} points wrong (${nIn} painted)${first}`,
    );
  }
}

console.log("(a) the path's clip-path");
await check(
  'a userSpaceOnUse clip (x < 55) clips the markers',
  MARKER + '<clipPath id="c"><rect x="0" y="0" width="55" height="100"/></clipPath>',
  PATH('clip-path="url(#c)"'),
  and(SQUARES, box(0, 0, 55, 100)),
);
await check(
  '...and a viewport-clipped marker is cut by both',
  BIG + '<clipPath id="c"><rect x="0" y="0" width="55" height="100"/></clipPath>',
  PATH('clip-path="url(#c)"'),
  and(SQUARES, box(0, 0, 55, 100)),
);
// objectBoundingBox: the PATH's box (20..80 x 30..70), so the left half is x < 50 -- the markers' own boxes would put
// it elsewhere for each one.
await check(
  "an objectBoundingBox clip binds to the path's box",
  MARKER +
    '<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>',
  PATH('clip-path="url(#c)"'),
  and(SQUARES, box(20, 30, 50, 70)),
);
await check(
  '...also with a viewport clip',
  BIG +
    '<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>',
  PATH('clip-path="url(#c)"'),
  and(SQUARES, box(20, 30, 50, 70)),
);
await check(
  "a group's clip clips its path's markers",
  MARKER + '<clipPath id="c"><rect x="40" y="0" width="60" height="100"/></clipPath>',
  `<g clip-path="url(#c)">${PATH('')}</g>`,
  and(SQUARES, box(40, 0, 100, 100)),
);

console.log("(b) the path's mask");
// THE MASK REGION: the default -10%/-10%/120%/120% of the PATH's box (20..80 x 30..70), so 14..86 x 26..74 -- a
// marker is part of what the path paints, not of its box, and its ink outside the region does not show (CSS Masking 1
// §7.1; the corners of the first and last squares).
const REGION = box(14, 26, 86, 74);
await check(
  'a luminance mask (white where y < 62) hides the markers under its black',
  MARKER + '<mask id="k"><rect x="0" y="0" width="100" height="62" fill="white"/></mask>',
  PATH('mask="url(#k)"'),
  and(SQUARES, box(0, 0, 100, 62), REGION),
);
await check(
  "an objectBoundingBox mask binds to the path's box",
  MARKER +
    '<mask id="k" maskContentUnits="objectBoundingBox"><rect x="0.5" y="0" width="0.5" height="1" fill="white"/></mask>',
  PATH('mask="url(#k)"'),
  and(SQUARES, box(50, 30, 80, 70), REGION),
);
await check(
  'a stated userSpaceOnUse mask region cuts the markers',
  MARKER +
    '<mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="60" height="100"><rect x="0" y="0" width="100" height="100" fill="white"/></mask>',
  PATH('mask="url(#k)"'),
  and(SQUARES, box(0, 0, 60, 100)),
);
await check(
  "a stated objectBoundingBox region is a fraction of the path's box",
  MARKER +
    '<mask id="k" x="0" y="0" width="0.25" height="1"><rect x="0" y="0" width="100" height="100" fill="white"/></mask>',
  PATH('mask="url(#k)"'),
  and(SQUARES, box(20, 30, 35, 70)),
);
await check(
  "a group's mask region is a fraction of the group's box",
  MARKER +
    '<mask id="k" x="0.5" y="0" width="0.5" height="1"><rect x="0" y="0" width="100" height="100" fill="white"/></mask>',
  `<g mask="url(#k)">${PATH('')}<rect x="10" y="10" width="2" height="2" fill="none"/></g>`,
  and(SQUARES, box(45, 10, 80, 70)),
); // the box is 10..80 x 10..70: the rect counts though it paints nothing

console.log("(c) the rows carry the path's entries");
{
  const b = await importSvg(
    svgOf(
      BIG +
        '<clipPath id="c"><rect x="0" y="0" width="55" height="100"/></clipPath>' +
        '<mask id="k"><rect x="0" y="0" width="100" height="62" fill="white"/></mask>',
      '<path d="M20 30 L50 60" fill="none" stroke="#000" clip-path="url(#c)" mask="url(#k)" marker-end="url(#m)"/>',
      1,
    ),
  );
  const meta = new Float32Array(b.meta, 32),
    rows = [...Array(b.numShapes).keys()];
  const paint = rows.filter((i) => (Math.round(meta[i * 48 + 27]) & 0x100) === 0);
  const clip = (i) => Math.round(meta[i * 48 + 30]),
    mask = (i) => Math.round(meta[i * 48 + 31]);
  const [path, ...markers] = paint;
  // a marker whose nested clip leaves the mask region gets a copy of the path's mask entry cut to that region, so its
  // row is a mask row of its own
  ok(
    markers.length > 0 && markers.every((i) => mask(i) > 0),
    `marker rows take a mask row (the path's, or its region copy) (${mask(path)}): ${markers.map(mask).join(',')}`,
  );
  // the viewport clip's row carries the path's clip as its nested clip
  const vRow = clip(markers[0]) - 1;
  ok(
    markers.every((i) => clip(i) === vRow + 1) && vRow >= 0 && clip(vRow) === clip(path),
    `marker rows take a viewport clip (row ${vRow}) whose row is cut by the path's clip (row ${clip(path) - 1}): nested ${vRow >= 0 ? clip(vRow) - 1 : '-'}`,
  );
}

console.log(fail ? `\nMARKER-CLIP-MASK FAIL (${fail})` : '\nMARKER-CLIP-MASK PASS');
process.exit(fail ? 1 : 0);
