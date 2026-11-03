// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterOffCanvasRenderSmoke.mjs -- a filter must see the pixels beyond the canvas edge.
//
// A filter that reads only canvas pixels makes a filtered shape that crosses the canvas edge fade there: a blur, drop shadow,
// displacement, convolution, morphology or lighting kernel sees TRANSPARENT where the shape continues. Zoomed in (worldMatrix) every
// filtered shape bigger than the view would be wrong, and past ~32x the center of a solid circle would go white.
//
// The CONTROL is literal: the same art rendered whole, with nothing near the edge, into a canvas z times bigger (the filter has
// all the neighborhood it needs) and cropped to the middle 128 px. The zoomed render is the same art through worldMatrix scale z
// in a 128 px canvas. They must agree. Each case also runs with the frame OFF (renderer option filterFrame:false, canvas pixels
// only) and must DIFFER from the control by more than the tolerance, so the case is known to be able to fail -- except the
// pointwise cases, which read no neighbors and must pass both ways.
//
// Tolerance (per channel, 0..255) is the AA / quantization contract: the zoomed and the control render the same coverage at
// different float rounding and a filter in RGBA8 between passes. On Metal and SwiftShader: at most 2 on every case, both
// routes (usually 0 or 1); the bound is 3 per channel and no pixel may differ by more than 8.

import { readFileSync } from 'fs';
import zlib from 'zlib';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// MANTLE_SMOKE_SRC_ROOT: serve /src from another tree, to run this file against code it must fail on.
const SRC_ROOT = process.env.MANTLE_SMOKE_SRC_ROOT
  ? path.resolve(process.env.MANTLE_SMOKE_SRC_ROOT)
  : ROOT;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
  if (p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!DOCTYPE html><html><body><canvas id="c" width="128" height="128"></canvas></body></html>',
    );
    return;
  }
  const m =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  let body;
  try {
    body = readFileSync(path.join(p.startsWith('/src/') ? SRC_ROOT : ROOT, p));
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': m + '; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

// Concentric rings (even-odd), so the art has structure INSIDE the view as well as an outer edge far outside it.
const ring = (r) => `M${50 - r} 50a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const RINGS = ring(30) + ring(24) + ring(18) + ring(12) + ring(6);
// The same structure in straight edges (concentric octagons): the fill is exact for any engine. A circle's edge is an arc the fill
// engines approximate (the Loop-Blinn route's coverage differs from Slug's by up to ~0.35 on a seam pixel, and that varies with the
// scale the mesh was built at), and a filter that passes the SOURCE through 1:1 (merge, shadow, erode, convolve, lighting,
// displacement) shows that engine difference at those few pixels, not a difference in the filter. Those cases use the octagons.
const oct = (r) =>
  'M' +
  [0, 1, 2, 3, 4, 5, 6, 7]
    .map(
      (k) =>
        `${(50 + r * Math.cos(((k + 0.5) * Math.PI) / 4)).toFixed(3)} ${(50 + r * Math.sin(((k + 0.5) * Math.PI) / 4)).toFixed(3)}`,
    )
    .join('L') +
  'z';
const OCTS = oct(46) + oct(30) + oct(21) + oct(14) + oct(7); // a filled band crosses every canvas edge at z = 3
const art = (defs, d = RINGS, fill = '#d22') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs>${defs}</defs>` +
  `<path d="${d}" fill="${fill}" fill-rule="evenodd" filter="url(#f)"/></svg>`;
const artO = (defs, d = OCTS) => art(defs, d);
// For dilate: an EMPTY band at the canvas edge with the filled one 1.8 u beyond it, inside the dilate radius.
const OCT_GAP = oct(40) + oct(20) + oct(12) + oct(6);
// The same filter on a <g> of two big shapes (the group route: the children paint into an accumulator the graph runs over).
const gart = (defs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs>${defs}</defs>` +
  `<g filter="url(#f)"><path d="${oct(32) + oct(23)}" fill="#d22" fill-rule="evenodd"/><path d="${oct(15) + oct(8)}" fill="#26c" fill-rule="evenodd"/></g></svg>`;
const F = (inner, region = 'x="-50%" y="-50%" width="200%" height="200%"') =>
  `<filter id="f" ${region} color-interpolation-filters="sRGB">${inner}</filter>`;

// tol: the largest per-channel difference allowed (and badMax: pixels allowed above 8). pointwise: reads no neighbors.
const CASES = [
  {
    name: 'blur (single primitive, solid circle)',
    z: 6,
    tol: 3,
    svg: art(F('<feGaussianBlur stdDeviation="3"/>'), ring(30)),
  },
  {
    name: 'blur (single primitive, rings)',
    z: 3,
    tol: 3,
    svg: art(F('<feGaussianBlur stdDeviation="3"/>')),
  },
  { name: 'blur, anisotropic', z: 3, tol: 3, svg: art(F('<feGaussianBlur stdDeviation="6 1"/>')) },
  {
    name: 'dropShadow (blur, offset, flood, composite, merge)',
    edgeGrowth: 40,
    z: 3,
    tol: 3,
    svg: artO(
      F(
        '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/><feOffset in="b" dx="6" dy="5" result="o"/>' +
          '<feFlood flood-color="#123" flood-opacity="0.8" result="c"/><feComposite in="c" in2="o" operator="in" result="s"/>' +
          '<feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>',
      ),
    ),
  },
  {
    name: 'feDropShadow',
    edgeGrowth: 40,
    z: 3,
    tol: 3,
    svg: artO(F('<feDropShadow dx="6" dy="5" stdDeviation="3" flood-color="#123"/>')),
  },
  { name: 'offset', z: 3, tol: 3, svg: artO(F('<feOffset dx="14" dy="-10"/>')) },
  {
    name: 'displacement (map = source)',
    z: 3,
    tol: 3,
    svg: artO(
      F(
        '<feDisplacementMap in="SourceGraphic" in2="SourceGraphic" scale="14" xChannelSelector="R" yChannelSelector="G"/>',
      ),
    ),
  },
  {
    name: 'convolve (sharpen 3x3)',
    z: 3,
    tol: 3,
    svg: artO(
      F('<feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="false"/>'),
    ),
  },
  {
    name: 'morphology dilate',
    z: 3,
    tol: 3,
    svg: artO(F('<feMorphology operator="dilate" radius="3"/>'), OCT_GAP),
  },
  {
    name: 'morphology erode',
    z: 3,
    tol: 3,
    svg: artO(F('<feMorphology operator="erode" radius="2"/>')),
  },
  {
    name: 'lighting (diffuse, distant light)',
    z: 3,
    tol: 3,
    svg: artO(
      F(
        '<feDiffuseLighting in="SourceAlpha" surfaceScale="5" diffuseConstant="1" lighting-color="#fff"><feDistantLight azimuth="45" elevation="50"/></feDiffuseLighting>' +
          '<feComposite in2="SourceAlpha" operator="in"/>',
      ),
    ),
  },
  {
    name: 'merge (blur under source)',
    z: 3,
    tol: 3,
    svg: artO(
      F(
        '<feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
      ),
    ),
  },
  // The SOURCE is far outside the view; only its shadow lands in it. The unified route's view cull must not drop the shape.
  {
    name: 'shadow of a shape wholly outside the canvas',
    edgeGrowth: 40,
    z: 3,
    tol: 3,
    svg: art(
      F(
        '<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b"/><feOffset in="b" dx="32" dy="0" result="o"/>' +
          '<feFlood flood-color="#123" result="c"/><feComposite in="c" in2="o" operator="in"/>',
        'filterUnits="userSpaceOnUse" x="-10" y="-10" width="200" height="200"',
      ),
      'M2 50a6 6 0 1 0 12 0a6 6 0 1 0 -12 0z',
    ),
  },
  // A mask on the filtered element applies AFTER the filter, to the filter's output, by canvas pixel.
  {
    name: 'blur + mask on the element',
    z: 3,
    tol: 3,
    svg: art(
      F('<feGaussianBlur stdDeviation="3"/>') +
        '<mask id="mk" maskContentUnits="userSpaceOnUse"><rect x="-100" y="-100" width="152" height="300" fill="#fff"/></mask>',
    ).replace('filter="url(#f)"', 'filter="url(#f)" mask="url(#mk)"'),
  },
  // A mask inside the SOURCE (a masked child of the filtered group) is baked at the frame's size while the frame is open.
  {
    name: 'group blur, masked child',
    z: 3,
    tol: 3,
    svg: gart(
      F('<feGaussianBlur stdDeviation="3"/>') +
        '<mask id="mk" maskContentUnits="userSpaceOnUse"><circle cx="50" cy="50" r="26" fill="#fff"/></mask>',
    ).replace('fill="#26c" fill-rule="evenodd"', 'fill="#26c" fill-rule="evenodd" mask="url(#mk)"'),
  },
  // The static cache bakes a frame into its own target and blits it: the filter inside the bake sees that target as its canvas. The
  // viewport-window bake is already larger than the view (its own margin), so it passes without the frame (offOk): the frame must not break it.
  {
    name: 'blur through a viewport-window cache',
    z: 3,
    tol: 3,
    cache: 'ForceViewportWindow',
    offOk: true,
    svg: art(F('<feGaussianBlur stdDeviation="3"/>')),
  },
  // noUni (here and on the morph below): their LIVE frames draw through the classic pass -- a whole-asset cache declines to bake art that crosses the canvas edge
  // and then renders live (gate '', last engine slug), and the morph's route declines a filtered pose. Their unified-filter count is 0 (variantFirst, the
  // default, needs no warm-up draw), so it is not read; both arms' pictures are still checked against the control.
  {
    name: 'blur through a whole-asset cache',
    z: 3,
    tol: 3,
    cache: 'ForceWholeAsset',
    noUni: true,
    svg: art(F('<feGaussianBlur stdDeviation="3"/>')),
  },
  {
    name: 'group blur (<g filter>)',
    z: 3,
    tol: 3,
    svg: gart(F('<feGaussianBlur stdDeviation="3"/>')),
  },
  {
    name: 'group dropShadow (<g filter>)',
    z: 3,
    tol: 3,
    svg: gart(
      F(
        '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/><feOffset in="b" dx="6" dy="5" result="o"/>' +
          '<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>',
      ),
    ),
  },
  // A rotated, zoomed draw: the frame's reach is in the canvas's pixels, not the art's axes.
  {
    name: 'blur + dropShadow, rotated 30 degrees',
    edgeGrowth: 40,
    z: 3,
    rot: 30,
    tol: 3,
    svg: artO(
      F(
        '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/><feOffset in="b" dx="6" dy="5" result="o"/>' +
          '<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>',
      ),
    ),
  },
  // A canvas that is not square: the aspect fit differs between the canvas and the frame.
  {
    name: 'dropShadow on a 192 x 96 canvas',
    edgeGrowth: 40,
    z: 3,
    w: 192,
    h: 96,
    tol: 3,
    svg: artO(
      F(
        '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/><feOffset in="b" dx="6" dy="5" result="o"/>' +
          '<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>',
      ),
    ),
  },
  // A filtered child inside a filtered group: the child's frame is measured against the group's.
  {
    name: 'nested: blurred child in a blurred group',
    z: 3,
    tol: 3,
    svg: gart(
      F('<feGaussianBlur stdDeviation="3"/>') +
        '<filter id="g" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="1.5"/></filter>',
    ).replace('<path d="' + oct(15), '<path filter="url(#g)" d="' + oct(15)),
  },
  {
    name: 'flood + composite (pointwise)',
    z: 3,
    tol: 3,
    pointwise: true,
    svg: art(
      F(
        '<feFlood flood-color="#26f" flood-opacity="0.7" result="c"/><feComposite in="c" in2="SourceGraphic" operator="in"/>',
      ),
    ),
  },
  {
    name: 'colorMatrix (pointwise)',
    z: 3,
    tol: 3,
    pointwise: true,
    svg: art(F('<feColorMatrix type="hueRotate" values="90"/>')),
  },
];

// A minimal RGBA PNG encoder (feImage tile cases): 8 x 8 in four 4 x 4 quadrants, so a tile has structure in both axes.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      px(x, y).forEach((v, k) => {
        raw[y * (w * 4 + 1) + 1 + x * 4 + k] = v;
      });
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
const QD = {
  tl: [255, 0, 0, 255],
  tr: [0, 160, 0, 255],
  bl: [0, 0, 255, 255],
  br: [255, 200, 0, 255],
};
const TILE_IMG = png(8, 8, (x, y) => (y < 4 ? (x < 4 ? QD.tl : QD.tr) : x < 4 ? QD.bl : QD.br));
const ellipse = (rx, ry) =>
  `M${50 + rx} 50a${rx} ${ry} 0 1 0 ${-2 * rx} 0a${rx} ${ry} 0 1 0 ${2 * rx} 0z`;
const WIDE = 'filterUnits="userSpaceOnUse" x="-50" y="-50" width="200" height="200"';
// A <g filter> with ONE child, the child filtered itself (the group's box is the child's box; the child's halo is past it).
const gart1 = (defs, child) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs>${defs}</defs>` +
  `<g filter="url(#f)"><path ${child} d="${oct(18)}" fill="#d22"/></g></svg>`;
const GBLUR = (id, sd) =>
  `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
// An external clip: the half plane x >= 45 (its edge inside the canvas at z = 3; it continues past the other three edges).
const CLIP_HALF =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="45" y="0" width="55" height="100" fill="#000"/></svg>';

// residuals. `offOk`: the case is expected to pass with the frame off too (the thing it pins does not depend on the frame).
CASES.push(
  // (a) feTile: the tile is the input's subregion in user space (24 u at (10, 10)), not the rect of the render target that holds it.
  {
    name: 'feTile of an feImage subregion',
    z: 3,
    tol: 3,
    offOk: true,
    svg: art(
      F(
        `<feImage href="${TILE_IMG}" x="10" y="10" width="24" height="24" preserveAspectRatio="none"/><feTile/>`,
        WIDE,
      ),
      OCTS,
    ),
  },
  // The input of feTile is a primitive with no subregion of its own: the subregion is the filter region, so the tile is the whole region.
  {
    name: 'feOffset then feTile (one tile: the region)',
    z: 3,
    tol: 3,
    svg: art(F('<feOffset dx="14" dy="-10"/><feTile/>', WIDE), OCTS),
  },
  // (b) cases that need the frame on paths of their own.
  {
    name: 'blur on a nine-sliced bundle',
    z: 3,
    tol: 3,
    nineSlice: { borderFrac: 0.2, stretch: [1.4, 1] },
    noUni: true,
    svg: art(F('<feGaussianBlur stdDeviation="3"/>')),
  },
  {
    name: 'blur through an external clip',
    z: 3,
    tol: 3,
    noUni: true,
    clip: CLIP_HALF,
    svg: art(F('<feGaussianBlur stdDeviation="3"/>')),
  },
  {
    name: 'group blur with mix-blend-mode',
    z: 3,
    tol: 3,
    svg: gart(F('<feGaussianBlur stdDeviation="3"/>')).replace(
      '<g filter="url(#f)">',
      '<rect x="-100" y="-100" width="300" height="300" fill="#fc6"/><g filter="url(#f)" style="mix-blend-mode:multiply">',
    ),
  },
  // (c) The group's box is its one child's box; the child's own blur pushes the content past it.
  {
    name: 'child blur beyond the group box',
    z: 3,
    tol: 3,
    svg: gart1(GBLUR('f', 4) + GBLUR('g', 3), 'filter="url(#g)"'),
  },
  // The source stops short of the edge; its blur reaches past the edge and a later offset brings that part back onto the canvas.
  {
    name: 'drop shadow of a shape short of the edge',
    z: 3,
    tol: 3,
    svg: artO(
      F(
        '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/><feOffset in="b" dx="6" dy="5" result="o"/>' +
          '<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>',
      ),
      oct(15) + oct(8),
    ),
  },
  // (e) a morph, on both routes (the unified route's isolation step is the morph route's).
  {
    name: 'morph with a blur, t = 0.5',
    z: 3,
    tol: 3,
    noUni: true,
    morph: { t: 0.5, svg: art(F('<feGaussianBlur stdDeviation="3"/>'), ellipse(40, 46)) },
    svg: art(F('<feGaussianBlur stdDeviation="3"/>'), ellipse(46, 40)),
  },
);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900 });
const errs = [];
page.on('pageerror', (e) => {
  errs.push(e.message);
  console.error('  [page-err]', e.message);
});
page.on('console', (m) => {
  if (/error|warn/i.test(m.type())) {
    const t = m.text();
    if (!/GPU stall|ReadPixels|status of 404|a filtered shape reaches/.test(t)) errs.push(t);
  }
});
await page.goto(url, { waitUntil: 'load', timeout: 30000 });

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const ROUTES = ['none', 'lb']; // the classic cover-quad route and the unified (Loop-Blinn) route
const SCALE_SVG = art(F('<feGaussianBlur stdDeviation="3"/>'), ring(30));
const SCALES = [32, 200, 4096, 2 ** 20];

await page.evaluate(async () => {
  const api = await import('/src/index.js');
  const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
  // The zoomed and z = 1 arms draw on a context and renderer per configuration (canvas size, renderer options, route, morph), reused
  // render after render; past 8 the least recently used one is released (a page holds at most 16 live contexts). Every render makes
  // and disposes its own bundle, handle, morph and clip, and reads the renderer's counters as deltas. The controls (the big-canvas
  // truth and the padded canvas) get a fresh context and renderer each: on a renderer that has drawn earlier cases' filters their
  // pictures move by 1/255 on a few pixels.
  const pool = new Map();
  const release = (e) => {
    e.r.dispose();
    const lose = e.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  };
  const rendererFor = async (W, H, opts, route, morph, control) => {
    const key = JSON.stringify([W, H, opts, route, morph]);
    let e = control ? null : pool.get(key);
    if (e) {
      pool.delete(key);
      pool.set(key, e);
      return e;
    }
    if (!control && pool.size >= 8) {
      const [k0, e0] = pool.entries().next().value;
      pool.delete(k0);
      release(e0);
    }
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    const r = api.createRenderer(gl, shaders, opts);
    if (r.ready) await r.ready;
    r.setFillEngine({ route, kernel: 'slug' });
    if (morph && route !== 'lb' && r.setLoopBlinnMorphFill) r.setLoopBlinnMorphFill('off');
    e = { gl, r };
    if (!control) pool.set(key, e);
    return e;
  };
  const render = async (sec, W, H, matrix, opts, route, cache = null, c = {}, control = false) => {
    const own = await rendererFor(W, H, opts, route, !!c.morphSec, control),
      { gl, r } = own;
    for (let k = 0; k < 16 && gl.getError(); k++); // an earlier render's error is not this one's
    const uni0 = r.debugStats.unifiedFilterDraws | 0,
      morph0 = r.debugStats.loopBlinnMorphRouteCount | 0;
    const b = api.createBundle(gl, sec);
    r.setViewport(W, H);
    if (c.nineSlice) {
      const g = b.globalBBox,
        bf = c.nineSlice.borderFrac;
      b.applyNineSlice({
        border: [bf * g[2], bf * g[3], bf * g[2], bf * g[3]],
        worldSize: [g[2] * c.nineSlice.stretch[0], g[3] * c.nineSlice.stretch[1]],
      });
    }
    // A morph: the bundle is the t = 0 pose, c.morphSec the t = 1 pose; the handle drawn is the morph.
    let drawable = b,
      b2 = null;
    if (c.morphSec) {
      b2 = api.createBundle(gl, c.morphSec);
      drawable = api.createShapeMorph(gl, b, b2);
      drawable.setT(c.morphT);
    }
    const h = cache
      ? r.createBundleHandle(b, { staticCache: { strategy: api.CacheStrategy[cache] } })
      : null;
    if (r.prepareBundle) r.prepareBundle(b);
    if (r.awaitLbReady && route === 'lb') {
      try {
        await r.awaitLbReady(b, 20000);
      } catch {}
    }
    r.prewarmBundle(b);
    r.precompileFills(); // the loading call: the first frames draw the programs a game has after loading
    const dopts = matrix ? { worldMatrix: matrix } : {};
    let clipTex = null;
    if (c.clip) {
      const cb = api.createBundle(gl, await api.importSvg(c.clip, { preserveViewport: true }));
      clipTex = r.renderClipCoverage(cb, { worldMatrix: matrix || [1, 0, 0, 0, 1, 0, 0, 0, 1] });
      dopts.extClipTex = clipTex;
      dopts.extClipMode = 1;
    }
    const read = () => {
      const p = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    // The morph's unified route is prepared off-thread: draw until it serves (or give up, and the arm's check below says so).
    if (c.morphSec && route === 'lb') {
      for (let k = 0; k < 80; k++) {
        const r0 = r.debugStats.loopBlinnMorphRouteCount | 0;
        r.beginFrame([1, 1, 1, 1]);
        r.drawBundle(drawable, dopts);
        r.endFrame();
        if ((r.debugStats.loopBlinnMorphRouteCount | 0) > r0) break;
        await new Promise((q) => setTimeout(q, 25));
      }
    }
    // The exact draw state the frames below use (a rotated matrix needs its own variant, which the loading call above cannot know): warm it first, so no measured frame is a stand-in.
    await r.warmScene(
      [
        {
          name: 'case',
          draw: () => {
            r.beginFrame([1, 1, 1, 1]);
            if (h) h.draw(dopts);
            else r.drawBundle(drawable, dopts);
            r.endFrame();
          },
        },
      ],
      { maxPasses: 8, fenceTimeoutMs: 20000 },
    );
    let prev = null,
      last = null,
      stable = true;
    for (let i = 0; i < 4; i++) {
      r.beginFrame([1, 1, 1, 1]);
      if (h) h.draw(dopts);
      else r.drawBundle(drawable, dopts);
      r.endFrame();
      last = read();
      // Frames 2.. are served from the filter-result cache when the key holds: they must not differ from the frame that filled it.
      if (i >= 1 && prev && last.some((v, k) => v !== prev[k])) stable = false;
      prev = last;
      await new Promise((q) => setTimeout(q, 3));
    }
    const glErr = gl.getError();
    const stats = r.debugStats || {};
    if (clipTex) r.deleteClipTexture(clipTex);
    if (h) h.dispose();
    if (drawable !== b && drawable.dispose) drawable.dispose();
    if (b2) b2.dispose();
    b.dispose();
    if (control) release(own);
    return {
      p: last,
      glErr,
      stable,
      uni: (stats.unifiedFilterDraws | 0) - uni0,
      gate: stats.unifiedFillGate || '',
      morphRouted: (stats.loopBlinnMorphRouteCount | 0) - morph0,
    };
  };
  // The middle w x h of the control (NW x NH) against the zoomed render.
  const cmp = (truth, NW, NH, got, w, h) => {
    const ox = (NW - w) / 2,
      oy = (NH - h) / 2;
    let max = 0,
      bad = 0,
      sum = 0;
    const where = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = ((y + oy) * NW + (x + ox)) * 4,
          c = (y * w + x) * 4;
        let d = 0;
        for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(truth[a + k] - got[c + k]));
        if (d > 8) {
          bad++;
          if (where.length < 4) where.push([x, y, d]);
        }
        if (d > max) max = d;
        sum += d;
      }
    return { max, bad, mean: +(sum / (w * h)).toFixed(3), where };
  };
  window.__h = { api, render, cmp };
});

const res = { out: [], scale: [] };
// One page call per case: a single call for all of them outlives the protocol timeout.
for (const c of CASES) {
  res.out.push(
    ...(await page.evaluate(
      async (c, routes) => {
        const { api, render, cmp } = window.__h;
        const out = [];
        const sec = await api.importSvg(c.svg, { preserveViewport: true });
        const cc = {
          ...c,
          morphSec: c.morph ? await api.importSvg(c.morph.svg, { preserveViewport: true }) : null,
          morphT: c.morph ? c.morph.t : 0,
        };
        const w = c.w || 128,
          h = c.h || 128,
          NW = w * c.z,
          NH = h * c.z;
        // The zoomed draw is scale z (and a rotation of c.rot degrees) about the canvas center; the control is the rotation alone in the big canvas.
        const a = ((c.rot || 0) * Math.PI) / 180,
          cs = Math.cos(a),
          sn = Math.sin(a);
        const m = [c.z * cs, c.z * sn, 0, -c.z * sn, c.z * cs, 0, 0, 0, 1];
        const m0 = c.rot ? [cs, sn, 0, -sn, cs, 0, 0, 0, 1] : null;
        for (const route of routes) {
          const truth = await render(sec, NW, NH, m0, {}, route, null, cc, true);
          const on = await render(sec, w, h, m, {}, route, c.cache, cc);
          const off = await render(sec, w, h, m, { filterFrame: false }, route, c.cache, cc);
          // INSIDE the canvas (z = 1: nothing crosses the edge) the frame must not exist: ON == OFF byte for byte.
          const in1 = await render(sec, w, h, null, {}, route, c.cache, cc),
            in0 = await render(sec, w, h, null, { filterFrame: false }, route, c.cache, cc);
          const identical = in1.p.every((v, k) => v === in0.p[k]);
          // A case whose frame engages although the source is inside the canvas (edgeGrowth): the z = 1 render with the frame must match the
          // same art in a canvas three times as large (the viewBox padded 100 u on every side, same scale), cropped; the frame-off render must not.
          let in1c = null,
            in0c = null;
          if (c.edgeGrowth && !identical) {
            const pad = await api.importSvg(
              c.svg.replace(
                'viewBox="0 0 100 100" width="100" height="100"',
                'viewBox="-100 -100 300 300" width="300" height="300"',
              ),
              { preserveViewport: true },
            );
            const t1 = await render(pad, 3 * w, 3 * h, null, {}, route, null, cc, true); // (the z = 1 renders carry no rotation, so neither does the control)
            in1c = cmp(t1.p, 3 * w, 3 * h, in1.p, w, h);
            in0c = cmp(t1.p, 3 * w, 3 * h, in0.p, w, h);
          }
          // Where the frame-on and frame-off z = 1 renders differ: the farthest differing pixel from the nearest canvas edge.
          let inFar = 0,
            inDiffMax = 0;
          if (!identical)
            for (let y = 0; y < h; y++)
              for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                for (let q = 0; q < 4; q++)
                  inDiffMax = Math.max(inDiffMax, Math.abs(in1.p[i + q] - in0.p[i + q]));
                if (
                  in1.p[i] !== in0.p[i] ||
                  in1.p[i + 1] !== in0.p[i + 1] ||
                  in1.p[i + 2] !== in0.p[i + 2] ||
                  in1.p[i + 3] !== in0.p[i + 3]
                )
                  inFar = Math.max(inFar, Math.min(x, y, w - 1 - x, h - 1 - y));
              }
          out.push({
            name: c.name,
            route,
            z: c.z,
            on: cmp(truth.p, NW, NH, on.p, w, h),
            off: cmp(truth.p, NW, NH, off.p, w, h),
            identical,
            inFar,
            inDiffMax,
            in1c,
            in0c,
            stable: on.stable,
            glErr: [truth.glErr, on.glErr, off.glErr],
            uni: on.uni,
            gate: on.gate,
            morphRouted: on.morphRouted,
          });
        }
        return out;
      },
      c,
      ROUTES,
    )),
  );
}
res.scale = await page.evaluate(
  async (scaleSvg, scales, routes) => {
    const { api, render } = window.__h;
    // Scale: a solid circle blurred, zoomed until the canvas is deep inside it. Every pixel is the shape's color at every zoom.
    const scale = [];
    const sec = await api.importSvg(scaleSvg, { preserveViewport: true });
    for (const z of scales) {
      for (const route of routes) {
        const got = await render(sec, 128, 128, [z, 0, 0, 0, z, 0, 0, 0, 1], {}, route);
        let max = 0;
        const want = [0xdd, 0x22, 0x22];
        for (let i = 0; i < 128 * 128; i++)
          for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(got.p[i * 4 + k] - want[k]));
        scale.push({
          z,
          route,
          max,
          glErr: got.glErr,
          center: Array.from(got.p.slice((64 * 128 + 64) * 4, (64 * 128 + 64) * 4 + 4)),
        });
      }
    }
    return scale;
  },
  SCALE_SVG,
  SCALES,
  ROUTES,
);

const tolOf = (name) => CASES.find((c) => c.name === name);
for (const r of res.out) {
  const c = tolOf(r.name);
  const line = `${r.name} @z${r.z} [${r.route}]: frame ON max ${r.on.max} (${r.on.bad} px > 8, mean ${r.on.mean}) | OFF max ${r.off.max} (${r.off.bad} px > 8)`;
  if (r.glErr.some(Boolean)) fail(`${r.name} [${r.route}]: GL error ${r.glErr}`);
  if (!(r.on.max <= c.tol))
    fail(`${line}  -- over the tolerance ${c.tol}; first at ${JSON.stringify(r.on.where)}`);
  else if (r.on.bad) fail(line);
  else ok(line);
  if (!c.pointwise && !c.offOk && !(r.off.bad > 0 || r.off.max > c.tol))
    fail(
      `${r.name} [${r.route}]: the frame-OFF arm matched the control (${r.off.max}); the case cannot fail, so it proves nothing`,
    );
  // A filter whose source stays inside the canvas is byte-identical with the frame on -- unless its primitives GROW the source to the
  // edge and a later one reads the growth back (blur then offset) by more than the kernel tail (2.4 sigma): then the frame is right to
  // engage, and what it changes is judged against a padded-canvas control, not against the unframed render.
  if (!r.identical) {
    if (!c.edgeGrowth)
      fail(
        `${r.name} [${r.route}]: a filter that stays inside the canvas differs with the frame on (it must be byte-identical)`,
      );
    else if (!r.in1c || r.in1c.max > c.tol || r.in1c.bad)
      fail(
        `${r.name} [${r.route}]: z=1 framed render differs from the padded-canvas control (max ${r.in1c && r.in1c.max}): the frame engaged and was not right`,
      );
    // The frame may engage for a tail just over the 2.4 sigma cut (a level or two): then the unframed render is within the tolerance of the
    // control as well, and the framed one must be too (checked above) -- the pixels moved by at most the tolerance, toward the control.
    else if (!(r.in0c.bad > 0 || r.in0c.max > c.tol) && r.inDiffMax > c.tol)
      fail(
        `${r.name} [${r.route}]: z=1 frame-off already matched the control (${r.in0c.max}), yet the frame moved pixels by ${r.inDiffMax} (over ${c.tol})`,
      );
    else
      ok(
        `${r.name} [${r.route}]: z=1 frame engaged by growth read back; framed matches the padded control (max ${r.in1c.max}), unframed max ${r.in0c.max} (${r.in0c.bad} px > 8), frame moved pixels by at most ${r.inDiffMax}`,
      );
  }
  // The lb arm must really be the unified route: its isolation step (morphDraw _morphShapeFilter) served the filter.
  if (r.route === 'lb' && !c.pointwise && !c.noUni && !(r.uni > 0))
    fail(
      `${r.name} [lb]: the unified route did not serve the filter (gate '${r.gate}'), so the arm proves nothing`,
    );
  if (!r.stable)
    fail(`${r.name} [${r.route}]: a cached frame differs from the frame that filled the cache`);
}
for (const r of res.scale) {
  const line = `blurred circle at zoom ${r.z} [${r.route}]: worst pixel off the shape color by ${r.max}, centre ${r.center}`;
  if (r.glErr) fail(`${line}: GL error ${r.glErr}`);
  else if (r.max > 8) fail(line);
  else ok(line);
}
if (errs.length) fail('page errors/warnings: ' + errs.slice(0, 3).join(' | '));

await browser.close();
server.close();
if (failures) {
  console.error(`filterOffCanvasRenderSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('filterOffCanvasRenderSmoke: PASS');
