// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintRowsRenderSmoke -- radial focal radius, singular paint transforms and pattern stroke paints, against Chrome's own rendering of the same SVG (test/_chromeRef.mjs):
//   radialGradient `fr` (the general two-circle gradient; fr > r not clamped; repeat/reflect/pad; userSpaceOnUse; gradientTransform; stop alpha)
//   a singular gradientTransform / patternTransform paints the url() fallback, else nothing
//   a vector pattern as a STROKE paint (the pattern masked by the stroked outline), alone and with fill, paint-order, mask, clip, filter,
//          opacity, blend
// A pixel is compared only where Chrome's 3x3 neighborhood changes by no more than `edge` (a HARD edge -- a shape border, a cone rim, a dash end --
// is the 8x box-averaged convention's business, not this smoke's), and must be within `tol` per channel.
//
// A 600-STOP GRADIENT: a 600-stop linear gradient draws all 600 stops, as Chrome does.
// The reference is Chrome's rendering of the same SVG (test/_chromeRef.mjs).
//
// Cut to its first 256 stops (a binary search of a fixed 9 probes), everything past stop 255 -- 57%
// of this ramp -- would draw as one flat color, the last kept stop's. gradientManyStopsSmoke pins the packing, the fine offsets and the LUT wrap in node; this is
// the pixels. Two ramps, 600 stops each, colors varying smoothly (three hue cycles) so a reference
// that bakes its own gradient into a color table still agrees closely:
//   - top: opaque (every stop alpha 1), read for color;
//   - bottom: translucent (alpha swings 0.15..1), read for alpha and, where alpha allows, color.
// Both on a transparent ground, so alpha is compared as drawn.
//
// AN SVG <image> DOCUMENT: an <image href="data:image/svg+xml,…"> draws its document as an image:
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
//
// <switch> AND systemLanguage: a <switch> skips a child whose systemLanguage no user language
// matches, as Chrome does. The reference is Chrome's rendering of the same SVG (test/_chromeRef.mjs).
//
// Comparing systemLanguage against the HOST PAGE's <html lang> is wrong: with no lang there (this page
// has none) it matches anything, and a <switch> always draws its first child. The user's languages are
// navigator.languages, the same list Chrome's own <switch> consults. The
// listed tag is a private-use one no locale matches, so the outcome is the same for every user:
// the unconditional green child, never the red one.
//
// All of it renders on one _chromeRef page, one bundle per render.
import { launchBrowser } from './_launch.mjs';
import { openChromeRef, rgbaAt, diffStats } from './_chromeRef.mjs';
import {
  CASES as FIT_CASES,
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
const W = 64,
  H = 64;
const doc = (b) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${b}</svg>`;
const RG = (attrs, spread = '') =>
  `<radialGradient id="g" ${attrs} ${spread}><stop offset="0" stop-color="#f00"/><stop offset=".5" stop-color="#ff0"/><stop offset="1" stop-color="#00f"/></radialGradient>`;
const GR = (paint = 'url(#g)') => `<rect x="4" y="4" width="56" height="56" fill="${paint}"/>`;
const LG = (attrs) =>
  `<linearGradient id="g" ${attrs}><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>`;
const PAT = (attrs = '') =>
  `<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse" ${attrs}><rect width="4" height="8" fill="#0a0"/><rect x="4" width="4" height="8" fill="#a0a"/></pattern>`;
const BOX = (paint, extra = '') =>
  `<rect x="8" y="8" width="48" height="48" fill="${paint}" ${extra}/>`;
const SQ = (stroke = 'url(#p)', extra = '', shape = '<rect x="14" y="14" width="36" height="36"') =>
  `${shape} fill="none" stroke="${stroke}" stroke-width="12" ${extra}/>`;

const CELLS = [
  { name: 'fr .2', svg: doc(`<defs>${RG('fr=".2"')}</defs>${GR()}`), edge: 48, tol: 3 },
  { name: 'fr .4', svg: doc(`<defs>${RG('fr=".4"')}</defs>${GR()}`), edge: 48, tol: 3 },
  {
    name: 'fr 20% (same as .2)',
    svg: doc(`<defs>${RG('fr="20%"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  { name: 'fr > r (.7 vs .5)', svg: doc(`<defs>${RG('fr=".7"')}</defs>${GR()}`), edge: 48, tol: 3 },
  {
    name: 'fr == r (hard ring)',
    svg: doc(`<defs>${RG('fr=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr with the focus inside',
    svg: doc(`<defs>${RG('fr=".15" fx=".4" fy=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr with a cone (focus outside)',
    svg: doc(`<defs>${RG('fr=".1" fx=".9" fy=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr, focus on the rim',
    svg: doc(`<defs>${RG('fr=".3" fx=".95" fy=".5"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr reflect',
    svg: doc(`<defs>${RG('fr=".2" r=".3"', 'spreadMethod="reflect"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr repeat (seams below 0)',
    svg: doc(`<defs>${RG('fr=".2" r=".3"', 'spreadMethod="repeat"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr userSpaceOnUse',
    svg: doc(
      `<defs>${RG('gradientUnits="userSpaceOnUse" cx="32" cy="32" r="28" fx="20" fy="32" fr="8"')}</defs>${GR()}`,
    ),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr + gradientTransform',
    svg: doc(
      `<defs>${RG('fr=".2" gradientTransform="rotate(30 .5 .5) scale(1 .6)"')}</defs>${GR()}`,
    ),
    edge: 48,
    tol: 3,
  },
  {
    name: 'fr through href, on a stroke',
    svg: doc(
      `<defs>${RG('fr=".2"')}<radialGradient id="h" href="#g"/></defs><rect x="12" y="12" width="40" height="40" fill="none" stroke="url(#h)" stroke-width="12"/>`,
    ),
    edge: 48,
    tol: 3,
  },
  {
    name: 'negative fr reads as 0',
    svg: doc(`<defs>${RG('fr="-.2"')}</defs>${GR()}`),
    edge: 48,
    tol: 3,
  },
  {
    name: 'gradientTransform scale(0): nothing',
    svg: doc(`<defs>${LG('gradientTransform="scale(0)"')}</defs>${BOX('url(#g)')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'singular matrix + fallback',
    svg: doc(`<defs>${LG('gradientTransform="matrix(1 2 2 4 0 0)"')}</defs>${BOX('url(#g) lime')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'radial singular on a stroke',
    svg: doc(`<defs>${RG('gradientTransform="scale(0)"')}</defs>${SQ('url(#g)')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'patternTransform scale(0): nothing',
    svg: doc(`<defs>${PAT('patternTransform="scale(0)"')}</defs>${BOX('url(#p)')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'patternTransform singular + fallback',
    svg: doc(`<defs>${PAT('patternTransform="matrix(1 2 2 4 0 0)"')}</defs>${BOX('url(#p) lime')}`),
    edge: 2,
    tol: 2,
  },
  {
    name: 'control: gradientTransform scale(1e-6) paints',
    svg: doc(`<defs>${LG('gradientTransform="scale(1e-6)"')}</defs>${BOX('url(#g)')}`),
    edge: 2,
    tol: 2,
  },
  { name: 'rect stroke pattern', svg: doc(`<defs>${PAT()}</defs>${SQ()}`), edge: 2, tol: 3 },
  {
    name: 'circle stroke pattern',
    svg: doc(`<defs>${PAT()}</defs>${SQ('url(#p)', '', '<circle cx="32" cy="32" r="20"')}`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'pattern fill and stroke',
    svg: doc(
      `<defs>${PAT()}</defs><rect x="14" y="14" width="36" height="36" fill="url(#p)" stroke="url(#p)" stroke-width="12"/>`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'solid fill, paint-order stroke',
    svg: doc(
      `<defs>${PAT()}</defs><rect x="14" y="14" width="36" height="36" fill="#ccc" stroke="url(#p)" stroke-width="12" paint-order="stroke"/>`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'stroke-opacity .5',
    svg: doc(`<defs>${PAT()}</defs>${SQ('url(#p)', 'stroke-opacity=".5"')}`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'round join and caps',
    svg: doc(
      `<defs>${PAT()}</defs><polyline points="10,50 32,14 54,50" fill="none" stroke="url(#p)" stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/>`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'patternTransform scale',
    svg: doc(`<defs>${PAT('patternTransform="scale(2)"')}</defs>${SQ()}`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'element transform',
    svg: doc(`<defs>${PAT()}</defs><g transform="translate(6 4) rotate(10 32 32)">${SQ()}</g>`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'clip-path on the element',
    svg: doc(
      `<defs>${PAT()}<clipPath id="c"><rect width="32" height="64"/></clipPath></defs>${SQ('url(#p)', 'clip-path="url(#c)"')}`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'gray mask on the element',
    svg: doc(
      `<defs>${PAT()}<mask id="m"><rect width="64" height="64" fill="#808080"/></mask></defs>${SQ('url(#p)', 'mask="url(#m)"')}`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'multiply blend',
    svg: doc(
      `<defs>${PAT()}</defs><rect width="64" height="64" fill="#ff0"/>${SQ('url(#p)', 'style="mix-blend-mode:multiply"')}`,
    ),
    edge: 2,
    tol: 3,
  },
  {
    name: 'inside a group with opacity',
    svg: doc(`<defs>${PAT()}</defs><g opacity=".5">${SQ()}</g>`),
    edge: 2,
    tol: 3,
  },
  {
    name: 'empty pattern + fallback',
    svg: doc(
      `<defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"/></defs>${SQ('url(#p) lime')}`,
    ),
    edge: 2,
    tol: 3,
  },
];

// The 600-stop ramps, the SVG <image> documents and the <switch> cells, each in its own scope on the shared ref.
async function manyStopsSection(ref) {
  const W = 600,
    H = 40,
    N = 600;
  const hex = (v) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  const stops = (alpha) => {
    const out = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1),
        p = 2 * Math.PI * 3 * t;
      const c =
        '#' +
        hex(0.5 + 0.5 * Math.sin(p)) +
        hex(0.5 + 0.5 * Math.sin(p + 2.1)) +
        hex(0.5 + 0.5 * Math.sin(p + 4.2));
      const a = alpha ? (0.575 + 0.425 * Math.cos(2 * Math.PI * 2 * t)).toFixed(4) : '1';
      out.push(`<stop offset="${t.toFixed(6)}" stop-color="${c}" stop-opacity="${a}"/>`);
    }
    return out.join('');
  };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
    `<linearGradient id="o" x1="0" y1="0" x2="1" y2="0">${stops(false)}</linearGradient>` +
    `<linearGradient id="a" x1="0" y1="0" x2="1" y2="0">${stops(true)}</linearGradient></defs>` +
    `<rect x="0" y="0" width="${W}" height="20" fill="url(#o)"/>` +
    `<rect x="0" y="20" width="${W}" height="20" fill="url(#a)"/></svg>`;

  try {
    const { mantle, chrome } = await ref.render(svg, { w: W, h: H, ground: 'transparent' });
    // Inside each rect, two pixels clear of every edge. Chrome may dither a gradient and bake it into
    // a color table, so allow a few levels; a dropped stop is off by tens to hundreds.
    for (const [name, box, tail] of [
      ['opaque ramp', [2, 2, W - 2, 18], [260, 2, W - 2, 18]],
      ['translucent ramp', [2, 22, W - 2, 38], [260, 22, W - 2, 38]],
    ]) {
      const all = diffStats(mantle, chrome, W, box, 8);
      const past = diffStats(mantle, chrome, W, tail, 8);
      const msg =
        `${name}: mean |d| ${all.mean.toFixed(2)}, max ${all.max}, ${all.over}/${all.n} px over 8/255; ` +
        `past stop 256 (x >= 260): mean ${past.mean.toFixed(2)}, max ${past.max}`;
      if (all.mean <= 2 && all.max <= 16 && all.over <= all.n * 0.01) ok(msg);
      else fail(msg);
    }
  } catch (e) {
    fail('setup: ' + e.message);
  }
}
async function svgImageDocumentSection(ref) {
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
      FIT_CASES.forEach((cs, i) => {
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
      FIT_CASES.forEach((cs, i) => {
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
  } catch (e) {
    fail('setup: ' + e.message);
  }
}
async function switchSystemLanguageSection(ref) {
  const W = 60,
    H = 20;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<switch><rect systemLanguage="x-mantle-none" width="20" height="20" fill="#f00"/><rect width="20" height="20" fill="#0a0"/></switch>` +
    `<switch><g systemLanguage="x-mantle-none, x-mantle-other"><rect x="20" width="20" height="20" fill="#f00"/></g>` +
    `<g><rect x="20" width="20" height="20" fill="#00f"/></g></switch>` +
    `<switch><rect x="40" systemLanguage="x-mantle-none" width="20" height="20" fill="#f00"/></switch>` +
    `</svg>`;

  try {
    const { mantle, chrome } = await ref.render(svg, { w: W, h: H, ground: 'white' });
    for (const [x, what] of [
      [10, 'unconditional rect after an unmatched one'],
      [30, 'unconditional group after an unmatched list'],
      [50, 'a switch with no passing child (white)'],
    ]) {
      const m = rgbaAt(mantle, W, x, 10),
        c = rgbaAt(chrome, W, x, 10);
      const d = Math.max(...m.map((v, i) => Math.abs(v - c[i])));
      const msg = `${what} (${x},10): mantle rgba(${m.join(',')}) chrome rgba(${c.join(',')})`;
      if (d <= 2) ok(msg);
      else fail(msg + ` — off by ${d}/255`);
    }
  } catch (e) {
    fail('setup: ' + e.message);
  }
}
const ref = await openChromeRef(launchBrowser);
try {
  for (const c of CELLS) {
    const { mantle, chrome } = await ref.render(c.svg, { w: W, h: H, ground: 'white' });
    let max = 0,
      n = 0,
      at = '';
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i0 = (y * W + x) * 4;
        let flat = true;
        for (let dy = -1; dy <= 1 && flat; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const j =
              (Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))) * 4;
            for (let k = 0; k < 4; k++)
              if (Math.abs(chrome[j + k] - chrome[i0 + k]) > c.edge) {
                flat = false;
                break;
              }
            if (!flat) break;
          }
        if (!flat) continue;
        n++;
        for (let k = 0; k < 4; k++) {
          const d = Math.abs(mantle[i0 + k] - chrome[i0 + k]);
          if (d > max) {
            max = d;
            at = `(${x},${y}) mantle [${Array.from(mantle.slice(i0, i0 + 4))}] chrome [${Array.from(chrome.slice(i0, i0 + 4))}]`;
          }
        }
      }
    const msg = `${c.name}: ${n} px compared, max ${max}${max > c.tol ? ' at ' + at : ''}`;
    if (n < 200) fail(msg + ' -- too few pixels compared');
    else if (max <= c.tol) ok(msg);
    else fail(msg);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await manyStopsSection(ref);
await svgImageDocumentSection(ref);
await switchSystemLanguageSection(ref);
for (const e of ref.pageErrors) fail('page: ' + e);
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\npaintRowsRenderSmoke: fr, singular paint transforms and pattern strokes match Chrome; a 600-stop gradient draws' +
    " every stop; an SVG <image> matches Chrome under compat 'chrome' and the spec where Chrome departs from it;" +
    ' <switch> skips a child no user language matches',
);
