// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgImageDocumentRenderSmoke — an <image href="data:image/svg+xml,…"> draws its document as an image:
// placed in the image's rect, clipped, composited as ONE picture under the image's opacity, inheriting
// nothing from the referencing document, with an image inside it drawn too.
//
// Placement has two modes (importSvg's compat). Chrome departs from SVG 2 §image -- it fits by the
// referenced ROOT's preserveAspectRatio and ignores the <image>'s -- so the comparison against Chrome
// (test/_chromeRef.mjs, on white) runs with compat: 'chrome', over cases A-F and over the probe cases
// of test/_svgImageFitCases.mjs (where Chrome's own pixels are also held to the rows measured from it).
// The default, spec, mode is then checked at every point where the two modes differ, against the SPEC's
// value: each is a documented Chrome divergence, so Chrome's pixel there is only reported.
// svgImageDocumentSmoke pins both modes in node against the meta rows.
import { launchBrowser } from './_launch.mjs';
import { openChromeRef, rgbaAt } from './_chromeRef.mjs';
import {
  CASES,
  PTS as FIT_PTS,
  RGB,
  gridSvg,
  cellOrigin,
  GRID_W,
  GRID_H,
} from './_svgImageFitCases.mjs';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const W = 200,
  H = 140;
const b64 = (s) => 'data:image/svg+xml;base64,' + Buffer.from(s, 'utf8').toString('base64');
const doc = (body, attrs = 'viewBox="0 0 10 10"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

// A: a 10x10 document (red square, blue circle centered on its right edge) met into an 80x40 image
//    at (10, 10): the viewBox is fitted to x 30..70, y 10..50. The circle (center (70, 30), radius 24:
//    x 46..94, y 6..54) runs past the viewBox into the letterbox, where it shows, and past the image's
//    rect (x > 90, y < 10), where it is clipped.
const A = b64(
  doc('<rect width="10" height="10" fill="#f00"/><circle cx="10" cy="5" r="6" fill="#00f"/>'),
);
// B: two overlapping opaque squares under opacity 0.5 — one group, so the overlap is plain 50% blue.
const B = b64(
  doc(
    '<rect width="6" height="6" fill="#f00"/><rect x="4" y="4" width="6" height="6" fill="#00f"/>',
  ),
);
// C: an unstyled rect inside a <g fill="#0f0">: black, the document's initial fill.
const C = b64(doc('<rect width="10" height="10"/>'));
// D: preserveAspectRatio="xMidYMid slice" on an 80x40 image at (10, 75). The spec slices: the viewBox
//    spans x 10..90, y 55..135 and only the image's rect, y 75..115, shows; the blue strip past the
//    viewBox's right edge (x 90..106) is past the rect too. Chrome ignores the image's slice and fits by
//    the root's (default) meet: the viewBox is letterboxed to x 30..70, the strip showing at x 70..78.
const D = b64(
  doc(
    '<rect width="10" height="10" fill="#f00"/><rect width="10" height="3" fill="#0a0"/><rect x="10" width="2" height="10" fill="#00f"/>',
  ),
);
// E: an image inside the image: gray left half, a green document met into the right half (a 5x5
//    square centered in it, x 130..150, y 80..100 on the canvas).
const E = b64(
  doc(
    `<rect width="5" height="10" fill="#888"/><image x="5" width="5" height="10" href="${b64(doc('<rect width="10" height="10" fill="#0a0"/>'))}"/>`,
  ),
);
// F: the image's own transform places the picture.
const F = b64(doc('<rect width="10" height="10" fill="#f80"/>'));

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<image x="10" y="10" width="80" height="40" href="${A}"/>` +
  `<image x="110" y="10" width="40" height="40" opacity="0.5" href="${B}"/>` +
  `<g fill="#0f0"><image x="160" y="10" width="30" height="30" href="${C}"/></g>` +
  `<image x="10" y="75" width="80" height="40" preserveAspectRatio="xMidYMid slice" href="${D}"/>` +
  `<image x="110" y="70" width="40" height="40" href="${E}"/>` +
  `<image transform="translate(155 70) scale(2)" width="20" height="20" href="${F}"/>` +
  `</svg>`;

const PTS = [
  [35, 30, 'A: inside the fitted document (red)'],
  [62, 30, 'A: the circle inside the document (blue)'],
  [78, 30, 'A: the circle past the viewBox, inside the image rect (blue)'],
  [88, 30, 'A: the circle past the viewBox, just inside the image rect (blue)'],
  [92, 30, 'A: the circle past the viewBox and past the image rect, right (clipped: white)'],
  [70, 7, 'A: the circle past the viewBox and past the image rect, top (clipped: white)'],
  [20, 30, 'A: letterbox beside the fitted document (white)'],
  [115, 15, "B: red square at the group's 50%"],
  [130, 30, 'B: the overlap, plain 50% blue (one group)'],
  [145, 45, "B: blue square at the group's 50%"],
  [175, 25, 'C: no fill inherited from the <g> (black)'],
  [50, 65, 'D: above the image rect (white)'],
  [50, 77, 'D: the green band, inside the image'],
  [50, 100, 'D: the red body, inside the image'],
  [50, 125, 'D: below the image rect (white)'],
  [20, 100, "D: Chrome letterboxes, ignoring the image's slice (white)"],
  [74, 100, "D: the strip past the viewBox, in Chrome's letterbox (blue)"],
  [95, 100, 'D: past the viewBox and past the image rect (clipped: white)'],
  [120, 90, 'E: the outer document (gray)'],
  [140, 90, 'E: the image inside the image (green)'],
  [175, 90, "F: placed by the image's transform (orange)"],
];

// Spec mode, cases A-F: where it differs from Chrome (only D, whose image slices).
const SPEC_A_F = [
  [20, 100, 'red', 'white', "D: the spec slices, filling the image's width"],
  [74, 100, 'red', 'blue', 'D: the spec slices, so the strip past the viewBox is past the rect'],
];

const near = (m, c) => Math.max(...m.map((v, i) => Math.abs(v - c[i])));
const ref = await openChromeRef(launchBrowser);
try {
  // ---- 1. compat 'chrome' against Chrome: cases A-F ----
  {
    const { mantle, chrome } = await ref.render(svg, {
      w: W,
      h: H,
      ground: 'white',
      importOpts: { compat: 'chrome' },
    });
    for (const [x, y, what] of PTS) {
      const m = rgbaAt(mantle, W, x, y),
        c = rgbaAt(chrome, W, x, y);
      const d = near(m, c);
      const msg = `chrome mode, ${what} (${x},${y}): mantle rgba(${m.join(',')}) chrome rgba(${c.join(',')})`;
      if (d <= 3) ok(msg);
      else fail(msg + ` — off by ${d}/255`);
    }
  }
  // ---- 2. compat 'chrome' against Chrome: the probe cases ----
  const grid = gridSvg();
  {
    const { mantle, chrome } = await ref.render(grid, {
      w: GRID_W,
      h: GRID_H,
      ground: 'white',
      importOpts: { compat: 'chrome' },
    });
    CASES.forEach((cs, i) => {
      const [ox, oy] = cellOrigin(i);
      const off = [];
      FIT_PTS.forEach(([px, py], k) => {
        const m = rgbaAt(mantle, GRID_W, ox + px, oy + py),
          c = rgbaAt(chrome, GRID_W, ox + px, oy + py);
        const want = RGB[cs.chrome[k]];
        if (near(c.slice(0, 3), want) > 4)
          off.push(
            `(${px},${py}) CHROME rgba(${c.join(',')}) is not the measured ${cs.chrome[k]}; the case table is stale`,
          );
        else if (near(m, c) > 3)
          off.push(`(${px},${py}) mantle rgba(${m.join(',')}) chrome rgba(${c.join(',')})`);
      });
      if (off.length) fail(`chrome mode, case ${cs.id} (${cs.what}): ${off.join('; ')}`);
      else ok(`chrome mode, case ${cs.id} (${cs.what}): ${FIT_PTS.length} points match Chrome`);
    });
  }
  // ---- 3. The default, spec, mode where it departs from Chrome: the spec's values ----
  {
    const { mantle, chrome } = await ref.render(svg, { w: W, h: H, ground: 'white' });
    for (const [x, y, want, chromeName, what] of SPEC_A_F) {
      const m = rgbaAt(mantle, W, x, y),
        c = rgbaAt(chrome, W, x, y);
      const msg = `spec mode, ${what} (${x},${y}): mantle rgba(${m.join(',')}), spec ${want} — a documented Chrome divergence (Chrome ${chromeName}: rgba(${c.join(',')}))`;
      if (near(m.slice(0, 3), RGB[want]) <= 3) ok(msg);
      else fail(msg);
    }
  }
  {
    const { mantle, chrome } = await ref.render(grid, { w: GRID_W, h: GRID_H, ground: 'white' });
    let checked = 0;
    CASES.forEach((cs, i) => {
      const [ox, oy] = cellOrigin(i);
      const off = [],
        at = [];
      FIT_PTS.forEach(([px, py], k) => {
        if (cs.spec[k] === cs.chrome[k]) return;
        checked++;
        const m = rgbaAt(mantle, GRID_W, ox + px, oy + py),
          c = rgbaAt(chrome, GRID_W, ox + px, oy + py);
        at.push(`(${px},${py}) ${cs.spec[k]}, Chrome ${cs.chrome[k]}`);
        if (near(m.slice(0, 3), RGB[cs.spec[k]]) > 3)
          off.push(
            `(${px},${py}) mantle rgba(${m.join(',')}), spec ${cs.spec[k]} (Chrome rgba(${c.join(',')}))`,
          );
      });
      if (!at.length) return;
      if (off.length)
        fail(
          `spec mode, case ${cs.id} (${cs.what}), documented Chrome divergence: ${off.join('; ')}`,
        );
      else
        ok(
          `spec mode, case ${cs.id} (${cs.what}), documented Chrome divergence at ${at.join('; ')}`,
        );
    });
    if (checked < 40) fail(`vacuous: only ${checked} divergent points checked in spec mode`);
  }
  for (const e of ref.pageErrors) fail('page: ' + e);
} catch (e) {
  fail('setup: ' + e.message);
}
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  "\nsvgImageDocumentRenderSmoke: an SVG <image> matches Chrome under compat 'chrome', and the spec where Chrome departs from it",
);
