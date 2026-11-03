// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU hit testing for clip-path (SVG model: clipped areas receive no pointer events), the RENDERED mask coverage and
// composited alpha of HitMode.Coverage (the opt-in pixel-coverage mode), and resource-row exclusion.
//
// SVG 2 interact.html: "for elements with a mask applied, pointer events must still be captured even in areas where the
// mask goes to zero opacity". So part (b) onward tests masks in HitMode.Coverage, and part (d) pins that the default
// mode ignores them.
import { readFileSync } from 'fs';
import { fillHits, fillHitShape, HitMode } from '../src/hitTest/index.js';

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
const svgOf = (body, s = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 * s} ${100 * s}">` +
  (s === 1 ? body : `<g transform="scale(${s})">${body}</g>`) +
  '</svg>';

// Region helpers: `in` says whether q is inside, `d` its distance to the region's boundary.
const box = (x0, y0, x1, y1) => ({
  in: (q) => q[0] > x0 && q[0] < x1 && q[1] > y0 && q[1] < y1,
  d: (q) =>
    q[0] > x0 && q[0] < x1 && q[1] > y0 && q[1] < y1
      ? Math.min(q[0] - x0, x1 - q[0], q[1] - y0, y1 - q[1])
      : Math.hypot(Math.max(x0 - q[0], 0, q[0] - x1), Math.max(y0 - q[1], 0, q[1] - y1)),
});
const disc = (cx, cy, r) => ({
  in: (q) => Math.hypot(q[0] - cx, q[1] - cy) < r,
  d: (q) => Math.abs(Math.hypot(q[0] - cx, q[1] - cy) - r),
});
const and = (...R) => ({
  in: (q) => R.every((r) => r.in(q)),
  d: (q) => Math.min(...R.map((r) => r.d(q))),
});
const or = (...R) => ({
  in: (q) => R.some((r) => r.in(q)),
  d: (q) => Math.min(...R.map((r) => r.d(q))),
});
const not = (R) => ({ in: (q) => !R.in(q), d: R.d });
const band = (lo, hi, axis) => ({
  in: (q) => q[axis] > lo && q[axis] < hi,
  d: (q) => Math.min(Math.abs(q[axis] - lo), Math.abs(q[axis] - hi)),
});

const FS_LAYER = 1 << 8,
  FS_GROUP = (1 << 6) | (1 << 7);
// Grid-check one bundle: `want(q)` the painted region (in viewBox units), `opts` the hit options. Returns the counts,
// and also that no answer was ever a layer or group row.
// At scale s the drawing is s times the size in em and the query goes through worldMatrix = scale(1/s), so a pixel is
// s em across: the same picture at every size.
let DEFAULT_MODE = HitMode.Auto;
function sweep(b, want, s = 1, opts = { mode: DEFAULT_MODE }) {
  const o = { ...opts, worldMatrix: [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1] };
  const meta = new Float32Array(b.meta, 32),
    stride = b.metaFloatsPerShape || 48;
  let n = 0,
    nIn = 0,
    bad = 0,
    nonPaint = 0,
    first = '';
  for (let y = 0.37; y < 100; y += 1.13)
    for (let x = 0.29; x < 100; x += 1.13) {
      const q = [x, y];
      if (want.d(q) < 0.2) continue;
      const w = want.in(q);
      const got = fillHits(b, x, y, o);
      for (const i of got)
        if ((Math.round(meta[i * stride + 27]) & (FS_LAYER | FS_GROUP)) !== 0) nonPaint++;
      n++;
      if (w) nIn++;
      if (got.length > 0 !== w) {
        bad++;
        if (!first) first = ` -- first (${x.toFixed(2)}, ${y.toFixed(2)}): ${w ? 'miss' : 'hit'}`;
      }
    }
  return { n, nIn, bad, nonPaint, first };
}
async function check(name, body, want, { scales = [1], opts } = {}) {
  for (const s of scales) {
    const b = await importSvg(svgOf(body, s));
    const r = sweep(b, want, s, opts);
    ok(
      r.nIn > 20 && r.n - r.nIn > 20 && r.bad === 0 && r.nonPaint === 0,
      `${name}${s === 1 ? '' : ` at scale ${s === 2 ** -20 ? '2^-20' : '2^20'}`}: ${r.bad} of ${r.n} points wrong (${r.nIn} painted), ` +
        `${r.nonPaint} content/group rows answered${r.first}`,
    );
  }
}
const SCALES = [1, 2 ** -20, 2 ** 20];

console.log('(a) clip-path');
await check(
  'a single-child clip (a circle) on a rect',
  '<defs><clipPath id="c"><circle cx="50" cy="50" r="30"/></clipPath></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#c00" clip-path="url(#c)"/>',
  and(box(10, 10, 90, 90), disc(50, 50, 30)),
  { scales: SCALES },
);
await check(
  'a two-child clip is their union',
  '<defs><clipPath id="c"><rect x="0" y="0" width="40" height="100"/><rect x="60" y="0" width="40" height="100"/></clipPath></defs>' +
    '<rect x="20" y="20" width="60" height="60" fill="#c00" clip-path="url(#c)"/>',
  and(box(20, 20, 80, 80), or(box(0, 0, 40, 100), box(60, 0, 100, 100))),
  { scales: SCALES },
);
await check(
  'clip-rule="evenodd" cuts the hole',
  '<defs><clipPath id="c"><path clip-rule="evenodd" d="M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z"/></clipPath></defs>' +
    '<rect x="0" y="0" width="100" height="100" fill="#c00" clip-path="url(#c)"/>',
  and(box(10, 10, 90, 90), not(box(30, 30, 70, 70))),
);
await check(
  'a clipPath with its own clip-path is their intersection',
  '<defs><clipPath id="o"><rect x="40" y="0" width="60" height="100"/></clipPath>' +
    '<clipPath id="c" clip-path="url(#o)"><rect x="0" y="0" width="60" height="100"/></clipPath></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#c00" clip-path="url(#c)"/>',
  and(box(10, 10, 80 + 10, 90), box(40, 0, 60, 100)),
  { scales: SCALES },
);
await check(
  'a clip child with its own clip-path is cut by it before the union',
  '<defs><clipPath id="i"><rect x="0" y="0" width="100" height="40"/></clipPath>' +
    '<clipPath id="c"><rect x="0" y="0" width="30" height="100" clip-path="url(#i)"/><rect x="70" y="0" width="30" height="100"/></clipPath></defs>' +
    '<rect x="0" y="0" width="100" height="100" fill="#c00" clip-path="url(#c)"/>',
  or(and(box(0, 0, 30, 100), box(0, 0, 100, 40)), box(70, 0, 100, 100)),
);
await check(
  'clipPathUnits="objectBoundingBox"',
  '<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath></defs>' +
    '<rect x="20" y="30" width="60" height="60" fill="#c00" clip-path="url(#c)"/>',
  and(box(20, 30, 80, 90), disc(50, 60, 30)),
);
await check(
  'a clip on a group clips each child',
  '<defs><clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath></defs>' +
    '<g clip-path="url(#c)"><rect x="10" y="10" width="80" height="30" fill="#c00"/><circle cx="50" cy="70" r="20" fill="#0c0"/></g>',
  and(box(0, 0, 50, 100), or(box(10, 10, 90, 40), disc(50, 70, 20))),
);
// An animated clipper: the override that moves the clip row moves the region the shape answers in.
{
  const b = await importSvg(
    svgOf(
      '<defs><clipPath id="c"><rect x="0" y="0" width="40" height="100"/></clipPath></defs>' +
        '<rect x="10" y="10" width="80" height="80" fill="#c00" clip-path="url(#c)"/>',
    ),
  );
  const meta = new Float32Array(b.meta, 32),
    n = b.numShapes;
  const row = [...Array(n).keys()].find((i) => (Math.round(meta[i * 48 + 27]) & FS_LAYER) !== 0);
  const packed = new Float32Array(n * 24);
  for (let i = 0; i < n; i++) packed.set([1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1], i * 24);
  packed[row * 24 + 4] = 30; // the clip slides 30 to the right: x in [30, 70]
  const r = sweep(b, and(box(10, 10, 90, 90), box(30, 0, 70, 100)), 1, {
    mode: HitMode.Auto,
    overrides: packed,
  });
  ok(
    row !== undefined && r.bad === 0 && r.nIn > 20,
    `an animated clipper (override tx 30) moves the clip: ${r.bad} of ${r.n} wrong${r.first}`,
  );
  // SHRUNK TO ALMOST nothing: an override scaling the clip by 2^-24 in both axes has determinant 2^-48,
  // far under an absolute 1e-12 singular bar; it is singular only relative to its own terms, and
  // these are not, so the clip shrinks towards the origin and the shape answers nowhere in the view.
  packed.set([2 ** -24, 0, 0, 2 ** -24, 0, 0], row * 24);
  let hitsAny = false;
  for (let y = 12; y < 90 && !hitsAny; y += 4)
    for (let x = 12; x < 90 && !hitsAny; x += 4)
      if (fillHitShape(b, x, y, { mode: HitMode.Auto, overrides: packed }) >= 0) hitsAny = true;
  ok(
    !hitsAny,
    'an animated clipper scaled by 2^-24 in both axes shrinks the clip away (not "singular, use the identity")',
  );
  // THE SHADER'S TEST, FUNCTION BY FUNCTION. Each inverse it takes of an override calls that override singular with one test: 2^-22 of |ad| + |bc|,
  // which is layerLocal's. transformClipPx is the third, and it has to answer with the same test or a clip child would take a coordinate from one
  // answer and a pixel from the other.
  const ot = readFileSync(
    new URL('../src/shaders/_overrideTransform.glsl', import.meta.url),
    'utf8',
  );
  const fnBody = (name) => {
    const a = ot.indexOf(`vec2 ${name}(`),
      z = ot.indexOf('\n}\n', a);
    return a >= 0 && z > a ? ot.slice(a, z) : '';
  };
  const SINGULAR =
    /if \(!\(abs\(det\) > 2\.384185791015625e-7 \* \(abs\(ovAff\.x \* ovAff\.w\) \+ abs\(ovAff\.y \* ovAff\.z\)\)\)\) return (\w+);/;
  const answers = {
    transformClipCoord: 'emCoord',
    transformClipPx: 'invPx',
    transformClipDir: 'dEm',
  };
  ok(
    2 ** -22 === 2.384185791015625e-7 &&
      !/abs\(det\)\s*<\s*1e-/.test(ot) &&
      (ot.match(/abs\(det\) >/g) || []).length === Object.keys(answers).length &&
      Object.entries(answers).every(
        ([name, arg]) => (SINGULAR.exec(fnBody(name)) || [])[1] === arg,
      ),
    "the shader's transformClipCoord / transformClipPx / transformClipDir call an override singular only relative to |ad| + |bc|, as this does, and hand back their own argument",
  );
  const hit = readFileSync(new URL('../src/hitTest/hitTest.js', import.meta.url), 'utf8');
  ok(
    /Math\.abs\(det\) > 2 \*\* -22 \* \(Math\.abs\(m00 \* m11\) \+ Math\.abs\(m01 \* m10\)\)/.test(
      hit.slice(hit.indexOf('function layerLocal('), hit.indexOf('function clipCovers(')),
    ),
    "layerLocal's singular test has that threshold and those terms",
  );
}
// A CHILD'S PIXEL IS THE PIXEL OF ITS own FRAME, in the render (transformClipPx) and so here. HitMode.Coverage asks whether the pixel box reaches half
// coverage; the box is measured where the child's curves are. A curved strip: 1/4 unit wide scaled up 4, so 1 px on screen, and 1.6 units wide scaled down
// 4, so 0.4 px. Both straddle the midline only if the box has the right size: with the world's box the first would read a miss and the second a
// hit. A clip row, a mask row and a drawn row take the same pixel.
{
  const lens = (y, h) =>
    `M0 ${y} C33 ${y} 66 ${y} 100 ${y} L100 ${y + h} C66 ${y + h} 33 ${y + h} 0 ${y + h} Z`;
  const cases = [
    ['scaled up 4 (a 1 px strip)', 4, 10, 0.25, [40, 40.5], true],
    ['scaled down 4 (a 0.4 px strip)', 0.25, 160, 1.6, [10, 40.2], false],
  ];
  for (const [kind, body] of [
    [
      'clip',
      (d) =>
        `<defs><clipPath id="c"><path d="${d}"/></clipPath></defs><rect x="0" y="0" width="100" height="100" fill="#c00" clip-path="url(#c)"/>`,
    ],
    [
      'mask',
      (d) =>
        `<defs><mask id="c"><path d="${d}" fill="white"/></mask></defs><rect x="0" y="0" width="100" height="100" fill="#c00" mask="url(#c)"/>`,
    ],
    ['drawn', (d) => `<path d="${d}" fill="#c00"/>`],
  ])
    for (const [name, sc, y, h, q, want] of cases) {
      const b = await importSvg(svgOf(body(lens(y, h))));
      const meta = new Float32Array(b.meta, 32),
        n = b.numShapes;
      const row =
        kind === 'drawn'
          ? 0
          : [...Array(n).keys()].find((i) => (Math.round(meta[i * 48 + 27]) & FS_LAYER) !== 0);
      const packed = new Float32Array(n * 24);
      for (let i = 0; i < n; i++) packed.set([1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1], i * 24);
      packed.set([sc, 0, 0, sc, 0, 0], row * 24);
      const got =
        fillHitShape(b, q[0], q[1], {
          mode: HitMode.Coverage,
          overrides: packed,
          worldMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        }) >= 0;
      ok(
        row !== undefined && got === want,
        `a ${kind} ${kind === 'drawn' ? 'row' : 'child'} ${name}: the pixel box of its own frame ${want ? 'covers past' : 'stays under'} the midline (${got ? 'hit' : 'miss'})`,
      );
    }
}

console.log('(b) mask, as rendered (HitMode.Coverage)');
DEFAULT_MODE = HitMode.Coverage;
await check(
  'a luminance mask (a white rect) shows only under it',
  '<defs><mask id="m"><rect x="0" y="0" width="100" height="50" fill="white"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  and(box(10, 10, 90, 90), box(0, 0, 100, 50)),
  { scales: SCALES },
);
await check(
  'a black mask child paints nothing',
  '<defs><mask id="m"><rect x="0" y="0" width="100" height="50" fill="black"/><rect x="0" y="50" width="100" height="50" fill="white"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  and(box(10, 10, 90, 90), box(0, 50, 100, 100)),
);
await check(
  'a stroked mask child masks by its stroke',
  '<defs><mask id="m"><line x1="0" y1="50" x2="100" y2="50" stroke="white" stroke-width="20"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  and(box(10, 10, 90, 90), band(40, 60, 1)),
);
await check(
  'a mask child with its own clip-path is cut by it',
  '<defs><clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath>' +
    '<mask id="m"><rect x="0" y="0" width="100" height="100" fill="white" clip-path="url(#c)"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  and(box(10, 10, 90, 90), box(0, 0, 50, 100)),
);
// A gradient mask: white to black across x, so the mask's value is 1 - x/100 and minAlpha 0.5 answers x < 50; a
// radial one (white center, black at r = 40) answers within 20 of the center.
await check(
  'a linear-gradient luminance mask, minAlpha 0.5',
  '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient>' +
    '<mask id="m"><rect x="0" y="0" width="100" height="100" fill="url(#g)"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  and(box(10, 10, 90, 90), band(-1, 50, 0)),
  { opts: { mode: HitMode.Coverage, minAlpha: 0.5 } },
);
await check(
  '...and with no minAlpha, everywhere its value is above 0',
  '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient>' +
    '<mask id="m"><rect x="0" y="0" width="100" height="100" fill="url(#g)"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  box(10, 10, 90, 90),
);
await check(
  'a radial-gradient luminance mask, minAlpha 0.5',
  '<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient>' +
    '<mask id="m"><rect x="0" y="0" width="100" height="100" fill="url(#g)"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  disc(50, 50, 20),
  { opts: { mode: HitMode.Coverage, minAlpha: 0.5 } },
);
// THE MASK IMAGE IS ITS CHILDREN COMPOSITED SOURCE-OVER, its value that image's luminance: a black child drawn
// OVER a white one hides what it covers. Composited as alphas (lum x a over lum x a), the black one added nothing and
// the white showed through.
await check(
  'a black mask child over a white one hides what it covers',
  '<defs><mask id="m"><rect x="0" y="0" width="100" height="100" fill="white"/><rect x="50" y="0" width="50" height="100" fill="black"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
  and(box(10, 10, 90, 90), box(0, 0, 50, 100)),
);
// ...and a half-transparent black child over white leaves half the white's luminance: 0.5, so minAlpha 0.4 answers
// and 0.6 does not.
for (const [mA, want] of [
  [0.4, true],
  [0.6, false],
]) {
  const b = await importSvg(
    svgOf(
      '<defs><mask id="m"><rect x="0" y="0" width="100" height="100" fill="white"/>' +
        '<rect x="0" y="0" width="100" height="100" fill="black" fill-opacity="0.5"/></mask></defs>' +
        '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
    ),
  );
  const got = fillHitShape(b, 50, 50, { mode: HitMode.Coverage, minAlpha: mA }) >= 0;
  ok(
    got === want,
    `half-transparent black over white is a 0.5 mask, minAlpha ${mA}: ${got ? 'hit' : 'miss'}`,
  );
}
// mask-type="alpha": the child's alpha, not its luminance -- a black child at opacity 0.4 is a 0.4 mask.
for (const [mA, want] of [
  [0.3, true],
  [0.5, false],
]) {
  const b = await importSvg(
    svgOf(
      '<defs><mask id="m" mask-type="alpha"><rect x="0" y="0" width="100" height="100" fill="black" fill-opacity="0.4"/></mask></defs>' +
        '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>',
    ),
  );
  const got = fillHitShape(b, 50, 50, { mode: HitMode.Coverage, minAlpha: mA }) >= 0;
  ok(got === want, `mask-type="alpha" at 0.4, minAlpha ${mA}: ${got ? 'hit' : 'miss'}`);
}

// An IMAGE mask child: a 2 x 1 raster, white then black, stretched over the view. The atlas filters linearly between
// the texel centers at x = 25 and 75, so the mask is 1 left of 25, 0 right of 75 and (75 - x) / 50 between: with no
// minAlpha the shape answers left of 75, with minAlpha 0.5 left of 50. Node has no raster decoder, so the importer's
// Image / canvas are stood in for, handing back those two pixels.
{
  const saved = [globalThis.Image, globalThis.document];
  globalThis.Image = class {
    set src(_v) {
      this.naturalWidth = 2;
      this.naturalHeight = 1;
      queueMicrotask(() => this.onload());
    }
  };
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) }),
      }),
    }),
  };
  try {
    const body =
      '<defs><mask id="m"><image href="data:image/png;base64,AAAA" x="0" y="0" width="100" height="100" preserveAspectRatio="none"/></mask></defs>' +
      '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>';
    await check('an image luminance mask', body, and(box(10, 10, 90, 90), band(-1, 75, 0)));
    await check('...minAlpha 0.5', body, and(box(10, 10, 90, 90), band(-1, 50, 0)), {
      opts: { mode: HitMode.Coverage, minAlpha: 0.5 },
    });
  } finally {
    [globalThis.Image, globalThis.document] = saved;
  }
}

console.log('(d) the default mode ignores masks');
{
  const body =
    '<defs><mask id="m"><rect x="0" y="0" width="100" height="50" fill="white"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>';
  const b = await importSvg(svgOf(body));
  ok(
    fillHitShape(b, 50, 20) === 0 && fillHitShape(b, 50, 80) === 0,
    'a masked rect answers where the mask is 1 and where it is 0 (SVG 2 interact.html)',
  );
  ok(
    fillHitShape(b, 50, 80, 'coverage') === -1,
    '...while HitMode.Coverage answers only where the mask shows',
  );
  const allOpaque =
    '<defs><mask id="m"><rect x="0" y="0" width="100" height="100" fill="black"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)"/>';
  ok(
    fillHitShape(await importSvg(svgOf(allOpaque)), 50, 50) === 0,
    'a mask of luminance 0 everywhere hides the picture but not the target',
  );
  // masking AND clipping may be combined to let events through the transparent part (the spec's own recipe)
  const both =
    '<defs><clipPath id="c"><rect x="0" y="0" width="100" height="50"/></clipPath><mask id="m"><rect width="100" height="50" fill="white"/></mask></defs>' +
    '<rect x="10" y="10" width="80" height="80" fill="#00c" mask="url(#m)" clip-path="url(#c)"/>';
  const bb = await importSvg(svgOf(both));
  ok(
    fillHitShape(bb, 50, 20) === 0 && fillHitShape(bb, 50, 80) === -1,
    'mask + clip-path: the clip cuts the target, the mask does not',
  );
}

console.log('(c) content and group rows never answer');
{
  const b = await importSvg(
    svgOf(
      '<defs><clipPath id="c"><rect x="60" y="60" width="40" height="40"/></clipPath>' +
        '<mask id="m"><rect x="0" y="60" width="40" height="40" fill="white"/></mask>' +
        '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#000"/></pattern></defs>' +
        '<rect x="10" y="10" width="20" height="20" fill="#c00" clip-path="url(#c)"/>' +
        '<rect x="10" y="10" width="20" height="20" fill="#00c" mask="url(#m)"/>' +
        '<g opacity="0.5"><rect x="40" y="0" width="20" height="20" fill="url(#p)"/></g>',
    ),
  );
  const pts = [
    [80, 80],
    [20, 80],
    [0, 0],
    [2, 2],
    [65, 65],
  ];
  const modes = [HitMode.Auto, HitMode.Coverage, HitMode.Outline, HitMode.Bbox];
  const any = pts
    .flatMap((p) => modes.map((m) => fillHits(b, p[0], p[1], { mode: m }).length))
    .reduce((a, c) => a + c, 0);
  ok(
    any === 0,
    `inside clip, mask and pattern-tile content and at the group rows' origin, in all four modes: ${any} answers (want 0)`,
  );
  ok(fillHitShape(b, 50, 10) >= 0, '...while the patterned rect in the group still answers');
}

for (const [width, left, right] of [
  ['0', false, false],
  ['50%', true, false],
]) {
  const b = await importSvg(
    svgOf(
      `<style>path {display:none}</style><defs><mask id="inner" mask-type="alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="100"><rect width="100" height="100" fill="white"/></mask><mask id="outer" mask-type="alpha"><rect width="100" height="100" fill="white" mask="url(#inner)"/></mask></defs><rect width="100" height="100" mask="url(#outer)"/>`,
    ),
  );
  ok(
    fillHitShape(b, 20, 20, 'coverage') >= 0 === left &&
      fillHitShape(b, 80, 20, 'coverage') >= 0 === right,
    `nested mask region ${width} preserves empty/partial coverage under author path styles`,
  );
}

// Resource groups compose before opacity and before mask alpha/luminance extraction.
{
  const white = '<rect width="64" height="64" fill="white"/>';
  const half = white.replace('/>', ' opacity=".5"/>');
  for (const [name, type, content, alpha, threshold] of [
    ['direct half', 'alpha', half, 0.5, 0.75],
    ['single', 'alpha', `<g opacity=".5">${white}</g>`, 0.5, 0.75],
    ['overlap', 'alpha', `<g opacity=".5">${white}${white}</g>`, 0.5, 0.75],
    ['translucent overlap', 'alpha', `<g opacity=".5">${half}${half}</g>`, 0.375, 0.4],
    ['zero', 'alpha', `<g opacity="0">${white}</g>`, 0, 0],
    ['nested', 'alpha', `<g opacity=".5"><g opacity=".5">${white}</g></g>`, 0.25, 0.4],
    ['opaque', 'alpha', `<g opacity="1">${white}</g>`, 1, 0.75],
    ['black alpha', 'alpha', `<g opacity=".5">${white.replace('white', 'black')}</g>`, 0.5, 0.75],
    ['black luma', 'luminance', `<g opacity=".5">${white.replace('white', 'black')}</g>`, 0, 0.2],
  ]) {
    const b = await importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="${type}">${content}</mask></defs><rect width="64" height="64" fill="red" mask="url(#m)"/></svg>`,
      { preserveViewport: true },
    );
    ok(
      fillHitShape(b, 32, 32, { mode: HitMode.Coverage, minAlpha: threshold }) >= 0 ===
        (alpha > 0 && alpha >= threshold),
      `mask group ${name}: composed alpha ${alpha} at threshold ${threshold}`,
    );
  }
}

// CSS additive alpha differs from legacy Flash add at translucent mask overlaps.
for (const placement of ['group', 'leaf'])
  for (const [mode, answer] of [
    ['plus-lighter', true],
    ['add', false],
    ['normal', false],
  ]) {
    const front =
      placement === 'group'
        ? '<g opacity=".35" style="mix-blend-mode:' +
          mode +
          '"><rect width="64" height="64" fill="white"/></g>'
        : '<rect width="64" height="64" fill="white" opacity=".35" style="mix-blend-mode:' +
          mode +
          '"/>';
    const content = '<rect width="64" height="64" fill="white" opacity=".6"/>' + front;
    const b = await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha">' +
        content +
        '</mask></defs><rect width="64" height="64" fill="red" mask="url(#m)"/></svg>',
      { preserveViewport: true },
    );
    ok(
      fillHitShape(b, 32, 32, { mode: HitMode.Coverage, minAlpha: 0.8 }) >= 0 === answer,
      placement + ' ' + mode + ' alpha mask at .8',
    );
    ok(
      fillHitShape(b, 32, 32, { mode: HitMode.Coverage, minAlpha: 0.7 }) >= 0,
      placement + ' ' + mode + ' retains visible alpha below .74',
    );
  }

console.log(fail ? `\nHIT-TEST-CLIP-MASK FAIL (${fail})` : '\nHIT-TEST-CLIP-MASK PASS');
process.exit(fail ? 1 : 0);
