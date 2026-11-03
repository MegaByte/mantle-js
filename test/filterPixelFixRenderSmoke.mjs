// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPixelFixRenderSmoke -- filter primitive cases that are easy to draw wrong match Chrome. Each case is a 64-unit
// cell rendered at 128 px by Mantle and by Chrome (an <img> of the same SVG); the mean absolute channel difference over
// the whole cell is held to a bound.
//
// What each case guards: x-ds-group1 and x-ds-chain (feDropShadow on a group/chain must draw its shadow), x-disp-y-G1
// (Y displacement the right way up), dlight-point, x-dl-az90 and x-dl-point-slope (light in the right frame),
// x-conv-shiftTL (kernel taps), x-rot-blur-x (blur axes under a rotation), x-ct-table1-alpha (a one-value alpha table
// fills the region). A point light also needs the surface point's height: Filter Effects 1 puts it at
// Z(x, y) = surfaceScale * A(x, y), not on the canvas plane (dlight-point and x-dl-point-slope read 0.05 and 0.86; on the
// canvas plane, 4.3 and 6.9).
//
// LARGE BLURS (own page): a large feGaussianBlur reaches its full width, on both filter routes, against Chrome.
//
// A fixed 16-pair tap loop has 32 px of reach: 3 sigma only up to sigma ~10.7. A blur of 20 would read 0 at 32 px
// from an edge where Chrome reads ~13 levels, a blur of 40 0 at 40 px where Chrome reads ~40, and a box path capped at
// radius 64 shrinks a blur of 100 to ~64. So blur.frag.glsl's taps are a CPU-built table reaching ceil(3 sigma)
// (test/blurKernelSmoke.mjs pins its math over the whole range) and the widest blurs take box passes whose variances
// sum to sigma^2.
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read back through a 2D canvas. An opaque black square on a
// TRANSPARENT ground, so the blurred ALPHA is the whole measurement; its right and bottom edges are each more than
// 3 sigma from every other edge and from the canvas border, so the falloff sampled across them is the 1-D step
// response of the kernel alone. Sampled from sigma inside the edge to 2.5 sigma past it.
//
// Tolerance, 6 levels: Chrome approximates too. Skia's raster path is the spec's three-box blur (within 2.5 levels
// of the Gaussian at these distances, by a CPU model of it) and its GPU path downsamples; Mantle's box passes sit
// within 2.6. By a CPU model of the capped kernels at these very points, they miss the Gaussian by 13 levels at
// sigma 20 (both routes), 41 at sigma 40 on the single route and 79 / 24 at sigma 100 (single / graph). Sigma 12
// (0.9), sigma 16 (5.4) and sigma 40 on the graph route (2.9, a box path) are inside the tolerance even capped:
// they are controls.
//
// ARITHMETIC COMPOSITE (own page): feComposite operator="arithmetic" works on PREMULTIPLIED channels.
//
// THE TRAP: unpremultiplying both inputs, running k1*i1*i2 + k2*i1 + k3*i2 + k4 on the straight color, and
// premultiplying by the arithmetic alpha. Filter Effects 1 says every primitive works on premultiplied RGBA unless it
// says otherwise, and only feColorMatrix and feComponentTransfer do; Chromium (Skia's arithmetic blender with
// enforcePMColor) and Gecko compute on premultiplied values and clamp the color to the alpha. The two agree only
// when the formula happens to commute with the premultiply -- k1 alone does, which is why it is a control here --
// and, by a CPU model of both, differ by 35 to 128 levels on the other sets below (save where both clamp to
// transparent).
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read back through a 2D canvas. Both inputs are translucent
// (a filled rect with fill-opacity, an feFlood with flood-opacity) at two different alpha pairs, and the ground is
// TRANSPARENT on both sides: a white or black ground would fold the output's alpha into its color and hide half of
// what is compared. The comparison is in premultiplied units (Chrome's straight getImageData re-premultiplied), so a
// low-alpha pixel's color is not amplified by the unpremultiply. color-interpolation-filters="sRGB" keeps the
// color-space conversion (which this renderer does not do) out of the measurement.
//
// CONE-LESS SPOT LIGHTS (own page): an feSpotLight with no limitingConeAngle lights the surface.
//
// The importer and the filter graph write spotCosCone = 2.0 to mean "no cone" (svg/filter.js,
// filterGraph/primitives/lighting.js), so feLighting.frag.glsl must not zero the light whenever
// cosLight < uSpotCosCone -- always true for 2.0 -- or every cone-less spot light renders black
// (diffuse) or nothing (specular). feLightingWorldScaleSmoke only binds the uniforms.
//
// THE REFERENCE IS THE BROWSER'S own RENDERING of the same SVG, read back through a 2D canvas, so the
// assertion is "lit where Chrome is lit, dark where Chrome is dark" at sampled points. A coned spot is
// checked too: the "no cone" value must not open a cone that was asked for.
//
// A BLACK GROUND ON both SIDES. feSpecularLighting's alpha is its brightest channel, so an unlit
// result is transparent -- and transparent over white reads white, exactly like a lit one, so a
// broken specular case would pass at 255 everywhere on a white ground.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC =
  '<rect x="12" y="12" width="28" height="28" fill="#e04020"/><circle cx="40" cy="40" r="13" fill="#2060d0" fill-opacity=".75"/><rect x="26" y="8" width="6" height="48" fill="#20a040" fill-opacity=".5"/>';
const RECT = '<rect x="18" y="18" width="20" height="20" fill="#e04020"/>';
const REGION = 'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"';
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
function png(w, h, pixel) {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      len = Buffer.alloc(4),
      c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
// 8 x 8: left half red, right half blue, flat so smoothing does not matter.
const PNG = png(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
const cell = (prim, { body, region = REGION, defs = '' } = {}) =>
  doc(
    `<defs>${defs}<filter id="f" ${region} color-interpolation-filters="sRGB">${prim}</filter></defs>${body ?? `<g filter="url(#f)">${RECT}</g>`}`,
  );
const dmap = (c) =>
  `<feFlood flood-color="${c}" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="12" xChannelSelector="R" yChannelSelector="G"/>`;
const BL = '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="a"/>';
const BOX = {
  body: '<g filter="url(#f)"><rect x="16" y="16" width="32" height="32" fill="#000"/></g>',
};
const BLURA = '<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="a"/>';

// [id, svg, mean bound]
const CASES = [
  ['x-ds-group1', cell('<feDropShadow dx="5" dy="5" stdDeviation="2"/>'), 2],
  [
    'x-ds-chain',
    cell(
      '<feOffset dx="3" dy="0" result="o"/><feDropShadow in="o" dx="4" dy="4" stdDeviation="1"/>',
    ),
    2,
  ],
  ['ds-default-sd', cell('<feDropShadow dx="5" dy="5"/>'), 2],
  [
    'x-merge-3-srcalpha',
    cell(
      '<feOffset in="SourceAlpha" dx="5" dy="5" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceAlpha"/><feMergeNode in="SourceGraphic"/></feMerge>',
    ),
    2,
  ],
  [
    'merge-3',
    cell(
      '<feGaussianBlur stdDeviation="2" result="b"/><feOffset in="SourceAlpha" dx="5" dy="5" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
      { body: `<g filter="url(#f)">${SRC}</g>` },
    ),
    2,
  ],
  [
    'x-img-image-elem',
    cell('<feImage href="#im"/>', {
      defs: `<image id="im" x="6" y="6" width="40" height="30" href="${PNG}"/>`,
    }),
    3,
  ],
  ['x-disp-y-G1', cell(dmap('rgb(128,255,128)')), 2],
  ['x-disp-x-R1', cell(dmap('rgb(255,128,128)')), 2],
  [
    'dlight-point',
    cell(
      BLURA +
        '<feDiffuseLighting in="a" surfaceScale="4" lighting-color="white"><fePointLight x="14" y="10" z="20"/></feDiffuseLighting>',
      { body: `<g filter="url(#f)">${SRC}</g>` },
    ),
    1,
  ],
  [
    'x-dl-az90',
    cell(
      BL +
        '<feDiffuseLighting in="a" surfaceScale="6" lighting-color="white"><feDistantLight azimuth="90" elevation="30"/></feDiffuseLighting>',
      BOX,
    ),
    4,
  ],
  [
    'x-dl-point-slope',
    cell(
      BL +
        '<feDiffuseLighting in="a" surfaceScale="6" lighting-color="white"><fePointLight x="10" y="10" z="12"/></feDiffuseLighting>',
      BOX,
    ),
    2,
  ],
  [
    'x-conv-shiftTL',
    cell('<feConvolveMatrix order="3" kernelMatrix="1 0 0 0 0 0 0 0 0" divisor="1"/>'),
    1.5,
  ],
  [
    'x-rot-blur-x',
    cell('<feGaussianBlur stdDeviation="5 0"/>', {
      body: '<g transform="rotate(45 32 32)" filter="url(#f)"><rect x="24" y="24" width="16" height="16" fill="#e04020"/></g>',
      region: 'filterUnits="userSpaceOnUse" x="-20" y="-20" width="104" height="104"',
    }),
    1.5,
  ],
  [
    'x-ct-table1-alpha',
    cell('<feComponentTransfer><feFuncA type="table" tableValues="0.5"/></feComponentTransfer>'),
    3,
  ],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__case = async (svg, W, H) => {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(W, H); gl.viewport(0, 0, W, H);
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H);
  const ref = ctx.getImageData(0, 0, W, H).data;
  c.remove();
  let sum = 0, max = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) {
    const d = Math.abs(px[((H - 1 - y) * W + x) * 4 + k] - ref[(y * W + x) * 4 + k]); sum += d; if (d > max) max = d;
  }
  let dump = null;
  if (window.__dump) { const d = document.createElement('canvas'); d.width = W * 2; d.height = H; const dc = d.getContext('2d');
    const a = dc.createImageData(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) a.data[(y * W + x) * 4 + k] = px[((H - 1 - y) * W + x) * 4 + k];
    dc.putImageData(a, 0, 0); dc.putImageData(new ImageData(new Uint8ClampedArray(ref), W, H), W, 0); dump = d.toDataURL(); }
  return { mean: sum / (W * H * 3), max, dump };
};
window.__ready = true;
</script></body></html>`;

// The cells above share the page at '/'; each section below brings its own page, served at its route.
const PAGES = new Map([['/', HTML]]);
const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (PAGES.has(u)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES.get(u));
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  if (process.env.FF_DUMP)
    await page.evaluate(() => {
      window.__dump = true;
    });
  for (const [id, svg, bound] of CASES) {
    if (process.env.FF_ONLY && !process.env.FF_ONLY.split(',').includes(id)) continue;
    const r = await page.evaluate((s) => window.__case(s, 128, 128), svg);
    if (r.dump)
      (await import('fs')).writeFileSync(
        path.join(process.env.FF_DUMP, id + '.png'),
        Buffer.from(r.dump.split(',')[1], 'base64'),
      );
    const msg = `${id}: mean ${r.mean.toFixed(2)} max ${r.max} (bound ${bound})`;
    if (r.mean <= bound) console.log('ok ' + msg);
    else fail(msg);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await page.close();
// A section's page in this browser, ready when its module sets window.__ready.
async function openPage(route, html) {
  PAGES.set(route, html);
  const p = await browser.newPage();
  p.on('pageerror', (e) => fail('page: ' + e.message));
  await p.goto('http://127.0.0.1:' + server.address().port + route, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
  return p;
}
async function blurLargeSigmaSection() {
  const SIGMAS = [12, 16, 20, 40, 100];
  // Square [8, 8 + 2T] with T = ceil(3 sigma); canvas 3T + 16, so T of transparent ground lies past the right and
  // bottom edges, and the sample row / column (through the square's center) is T from the other edges.
  const layout = (s) => {
    const T = Math.ceil(3 * s);
    return { T, S: 3 * T + 16, E: 2 * T + 8, C: T + 8 };
  };
  const svg = (s, route) => {
    const { S, T } = layout(s);
    const prim =
      route === 'graph'
        ? // feMerge makes the kind heuristic give up, so the chain takes the filter GRAPH; a one-input merge is the input.
          `<feGaussianBlur stdDeviation="${s}" result="b"/><feMerge><feMergeNode in="b"/></feMerge>`
        : `<feGaussianBlur stdDeviation="${s}"/>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
      `<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}" color-interpolation-filters="sRGB">${prim}</filter>` +
      `<rect x="8" y="8" width="${2 * T}" height="${2 * T}" fill="#000" filter="url(#f)"/></svg>`
    );
  };
  // Offsets from the edge in pixels: negative is inside the square. d = j + 0.5 is the pixel center's distance.
  const offsets = (s) =>
    [-s, -s / 2, 0, s / 4, s / 2, s, 1.5 * s, 1.6 * s, 2 * s, 2.5 * s].map(Math.round);

  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="64" height="64"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cvs = document.getElementById('c');
const gl = cvs.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
// pts: [x, y] in top-down canvas pixels. Returns the ALPHA at each, from Mantle and from Chrome.
window.__case = async (svg, S, pts) => {
  cvs.width = S; cvs.height = S;
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const graphs = (b.filterGraphs || []).filter(Boolean).length;   // a single-primitive filter leaves a null slot
  R.setViewport(S, S); gl.viewport(0, 0, S, S);
  for (let i = 0; i < 3; i++) { R.beginFrame([0, 0, 0, 0]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, S, S).data;
  // WebGL rows are bottom-up, the 2D canvas's top-down.
  return { graphs, pts: pts.map(([x, y]) => ({ mantle: px[((S - 1 - y) * S + x) * 4 + 3], chrome: ref[(y * S + x) * 4 + 3] })) };
};
window.__ready = true;
</script></body></html>`;

  const TOL = 6;
  let page;
  try {
    page = await openPage('/blur', HTML);
    for (const s of SIGMAS)
      for (const route of ['single', 'graph']) {
        const { S, E, C } = layout(s);
        const js = offsets(s);
        // Across the right edge along row C, then across the bottom edge along column C.
        const pts = [...js.map((j) => [E + j, C]), ...js.map((j) => [C, E + j])];
        const r = await page.evaluate((a, b, c) => window.__case(a, b, c), svg(s, route), S, pts);
        const name = `sigma ${s}, ${route} route`;
        if ((route === 'graph') !== r.graphs > 0) {
          fail(`${name}: the fixture took the ${r.graphs ? 'graph' : 'single-primitive'} route`);
          continue;
        }
        const fmt = (arr) => arr.map((p, i) => `${js[i] + 0.5}:${p.mantle}/${p.chrome}`).join(' ');
        const across = r.pts.slice(0, js.length),
          down = r.pts.slice(js.length);
        console.log(`  ${name}, d: mantle/chrome alpha  x: ${fmt(across)}  y: ${fmt(down)}`);
        // Chrome must itself be blurring this wide, or the case compares nothing: Phi(-1.5) is 17 levels.
        const at15 = js.indexOf(Math.round(1.5 * s));
        if (across[at15].chrome < 10 || down[at15].chrome < 10) {
          fail(
            `${name}: Chrome reads ${across[at15].chrome}/${down[at15].chrome} at 1.5 sigma — the reference is not a blur this wide`,
          );
          continue;
        }
        let worst = 0,
          at = '';
        r.pts.forEach((p, i) => {
          const e = Math.abs(p.mantle - p.chrome);
          if (e > worst) {
            worst = e;
            at = `${i < js.length ? 'x' : 'y'} d=${js[i % js.length] + 0.5}`;
          }
        });
        if (worst <= TOL)
          ok(
            `${name}: the falloff matches Chrome within ${worst}/255 from sigma inside to 2.5 sigma out`,
          );
        else fail(`${name}: off by ${worst}/255 at ${at}`);
      }
  } catch (e) {
    fail('setup: ' + e.message);
  }
  if (page) await page.close();
}
async function compositeArithmeticSection() {
  const N = 48;
  // [in color, in alpha, in2 color, in2 alpha]
  const PAIRS = [
    ['rgb(220,60,20)', 0.7, 'rgb(40,120,230)', 0.4],
    ['rgb(30,200,160)', 0.25, 'rgb(250,210,40)', 0.9],
  ];
  // k1 k2 k3 k4. [1,0,0,0] is the CONTROL: a pure product commutes with the premultiply, so both formulas give it.
  const KS = [
    [0, 0.6, 0.6, 0],
    [1, 0, 0, 0],
    [0.5, 0.5, 0.5, 0.1],
    [-0.5, 1, 1, 0],
    [0, 1, -1, 0.2],
    [0, 0, 0, 0.5],
  ];
  const svg = ([c1, a1, c2, a2], k) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
    `<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">` +
    `<feFlood flood-color="${c2}" flood-opacity="${a2}" result="fl"/>` +
    `<feComposite in="SourceGraphic" in2="fl" operator="arithmetic" k1="${k[0]}" k2="${k[1]}" k3="${k[2]}" k4="${k[3]}"/>` +
    `</filter><rect width="${N}" height="${N}" fill="${c1}" fill-opacity="${a1}" filter="url(#f)"/></svg>`;
  // Inside the rect, away from its edges.
  const PTS = [
    [24, 24],
    [12, 10],
    [36, 34],
  ];

  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, pts) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([0, 0, 0, 0]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // WebGL rows are bottom-up and premultiplied; the 2D canvas's are top-down and straight.
  const pre = (p, i) => [p[i] * p[i + 3] / 255, p[i + 1] * p[i + 3] / 255, p[i + 2] * p[i + 3] / 255, p[i + 3]].map(Math.round);
  return pts.map(([x, y]) => ({ x, y,
    mantle: Array.from(px.slice(((${N} - 1 - y) * ${N} + x) * 4, ((${N} - 1 - y) * ${N} + x) * 4 + 4)),
    chrome: pre(ref, (y * ${N} + x) * 4) }));
};
window.__ready = true;
</script></body></html>`;

  // 3 premultiplied levels: both sides quantize each input to 8 bits and the result again, and Chrome's straight
  // readback costs up to one more on the way back to premultiplied. The unpremultiplied formula misses by 35 or more.
  const TOL = 3;
  let inked = 0;
  let page;
  try {
    page = await openPage('/arith', HTML);
    for (const pair of PAIRS)
      for (const k of KS) {
        const pts = await page.evaluate((s, p) => window.__case(s, p), svg(pair, k), PTS);
        const name = `in ${pair[0]}@${pair[1]}, in2 ${pair[2]}@${pair[3]}, k ${k.join(' ')}`;
        let worst = 0;
        for (const p of pts)
          worst = Math.max(worst, ...p.mantle.map((v, i) => Math.abs(v - p.chrome[i])));
        if (pts.some((p) => p.chrome[3] > 0)) inked++;
        const at = pts[0];
        const msg = `${name}: mantle rgba(${at.mantle.join(',')}) chrome rgba(${at.chrome.join(',')}) premultiplied, worst ${worst}/255 over ${pts.length} points`;
        if (worst <= TOL) ok(msg);
        else fail(msg);
      }
    // A case where Chrome draws nothing proves nothing about the arithmetic; most here must have ink.
    if (inked < PAIRS.length * KS.length - 2)
      fail(
        `only ${inked} cases have any alpha in Chrome's rendering — the fixture is not exercising the operator`,
      );
  } catch (e) {
    fail('setup: ' + e.message);
  }
  if (page) await page.close();
}
async function spotLightConeSection() {
  const N = 128;
  const spot = (cone) =>
    `<feSpotLight x="64" y="64" z="60" pointsAtX="64" pointsAtY="64" pointsAtZ="0" specularExponent="1"${cone ? ` limitingConeAngle="${cone}"` : ''}/>`;
  const svg = (prim) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
    `<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">${prim}</filter>` +
    `<rect width="${N}" height="${N}" fill="#000" filter="url(#f)"/></svg>`;
  const CASES = [
    [
      'diffuse, no cone',
      svg(
        `<feDiffuseLighting in="SourceGraphic" lighting-color="#fff" surfaceScale="0" diffuseConstant="1">${spot(0)}</feDiffuseLighting>`,
      ),
    ],
    [
      'specular, no cone',
      svg(
        `<feSpecularLighting in="SourceGraphic" lighting-color="#fff" surfaceScale="0" specularConstant="1" specularExponent="1">${spot(0)}</feSpecularLighting>`,
      ),
    ],
    [
      'diffuse, 20 degree cone',
      svg(
        `<feDiffuseLighting in="SourceGraphic" lighting-color="#fff" surfaceScale="0" diffuseConstant="1">${spot(20)}</feDiffuseLighting>`,
      ),
    ],
  ];
  // Center, a mid point inside a 20-degree cone's reach (22 px at z 60), one outside it, and a corner.
  const PTS = [
    [64, 64],
    [64, 80],
    [64, 110],
    [8, 8],
  ];

  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
window.__case = async (svg, pts) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([0, 0, 0, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ${N}, ${N}); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // WebGL rows are bottom-up, the 2D canvas's top-down.
  return pts.map(([x, y]) => ({ x, y, mantle: +lum(px, ((${N} - 1 - y) * ${N} + x) * 4).toFixed(1), chrome: +lum(ref, (y * ${N} + x) * 4).toFixed(1) }));
};
window.__ready = true;
</script></body></html>`;

  let page;
  try {
    page = await openPage('/spot', HTML);
    for (const [name, s] of CASES) {
      const pts = await page.evaluate((a, b) => window.__case(a, b), s, PTS);
      console.log(
        `  ${name}: ` +
          pts.map((p) => `(${p.x},${p.y}) mantle ${p.mantle} chrome ${p.chrome}`).join('  '),
      );
      // Lit and dark where Chrome is (40 of 255 is the line), and within 8/255 where lit. The two agree
      // to the unit on this GPU; 8 leaves room for another backend's precision and is still far inside
      // the specular double premultiply this also guards (191 read 143, 139 read 76).
      let bad = 0;
      for (const p of pts) {
        const litM = p.mantle > 40,
          litC = p.chrome > 40;
        if (litM !== litC || (litM && Math.abs(p.mantle - p.chrome) > 8)) bad++;
      }
      if (pts.every((p) => p.chrome <= 40)) {
        fail(`${name}: Chrome itself is dark at every sample — the case proves nothing`);
        continue;
      }
      if (!bad) ok(`${name}: lit and dark where Chrome is, within 8/255`);
      else fail(`${name}: ${bad} of ${pts.length} samples disagree with Chrome`);
    }
  } catch (e) {
    fail('setup: ' + e.message);
  }
  if (page) await page.close();
}
await blurLargeSigmaSection();
await compositeArithmeticSection();
await spotLightConeSection();
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterPixelFixRenderSmoke: the audited filter primitives match Chrome; large blurs reach their full width on both' +
    ' routes; arithmetic composites premultiplied channels; spot lights light, with and without a cone',
);
