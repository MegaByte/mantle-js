// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// inheritedChannelOpacityRenderSmoke — inherited fill-opacity and stroke-opacity render as Chrome
// renders them, on both routes.
//
// Both properties inherit; read on the painted element alone, every case below would draw OPAQUE:
// a group's attribute, its style="", a stylesheet class, a nested <g> that
// replaces the outer value (0.8, not 0.4), a <use> and an ancestor of a <use>, a <symbol> through a
// <use>, a marker's own value (and NOT the referencing path's group), and text under a group or a
// <tspan> that names its own fill. The node smoke is test/inheritedChannelOpacitySmoke.mjs.
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read through a 2D canvas over the same opaque
// ground. Shapes are sampled at flat points; the text cases take, in each image separately, the
// pixel of a box that is furthest from the ground -- a fully covered stem pixel, whose color is the
// ground composited under the glyph's alpha -- so a sub-pixel difference in glyph placement is not
// the question. The font is embedded in the SVG Chrome draws and handed to the importer as bytes.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { fontFixture, requireAsset } from './_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 120;
const fontB64 = readFileSync(requireAsset(fontFixture('roboto-regular.ttf'))).toString('base64');
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${defs}</defs><rect width="${N}" height="${N}" fill="#4060c0"/>${body}</svg>`;
const FONT_FACE = `<style>@font-face { font-family: Roboto; src: url(data:font/ttf;base64,${fontB64}); }</style>`;
const RECT = (x, y, attrs) => `<rect x="${x}" y="${y}" width="40" height="40" ${attrs}/>`;
const CASES = [
  {
    name: '<g fill-opacity stroke-opacity>',
    svg: svg(
      `<g fill-opacity="0.6" stroke-opacity="0.3">${RECT(30, 30, 'fill="#e00" stroke="#ff0" stroke-width="10"')}</g>`,
    ),
    pts: [
      [50, 50, 'the fill'],
      [28, 50, 'the stroke, outside the fill'],
    ],
  },
  {
    name: '<g style="fill-opacity">',
    svg: svg(`<g style="fill-opacity:0.5">${RECT(30, 30, 'fill="#e00"')}</g>`),
    pts: [[50, 50, 'the fill']],
  },
  {
    name: 'a stylesheet class on the group',
    svg: svg(
      `<style>.half { fill-opacity: 0.4 }</style><g class="half">${RECT(30, 30, 'fill="#e00"')}</g>`,
    ),
    pts: [[50, 50, 'the fill']],
  },
  {
    name: 'a nested <g fill-opacity> replaces the outer one',
    svg: svg(`<g fill-opacity="0.3"><g fill-opacity="0.8">${RECT(30, 30, 'fill="#e00"')}</g></g>`),
    pts: [[50, 50, 'the fill']],
  },
  {
    name: '<use fill-opacity>',
    svg: svg(
      '<use href="#t" x="30" y="30" fill-opacity="0.5"/>',
      '<rect id="t" width="40" height="40" fill="#0c0"/>',
    ),
    pts: [[50, 50, 'the target']],
  },
  {
    name: 'an ancestor of a <use>',
    svg: svg(
      '<g fill-opacity="0.45"><use xlink:href="#t" x="30" y="30"/></g>',
      '<rect id="t" width="40" height="40" fill="#0c0"/>',
    ),
    pts: [[50, 50, 'the target']],
  },
  {
    name: '<use> of a <symbol>',
    svg: svg(
      '<use href="#s" x="30" y="30" width="40" height="40" fill-opacity="0.35"/>',
      '<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0c0"/></symbol>',
    ),
    pts: [[50, 50, 'the symbol']],
  },
  {
    name: "a marker: its own fill-opacity, not the referencing path's group",
    svg: svg(
      '<g fill-opacity="0.3"><path d="M10 30 L60 30" fill="none" stroke="#000" stroke-width="2" marker-end="url(#m)"/>' +
        '<path d="M10 80 L60 80" fill="none" stroke="#000" stroke-width="2" marker-end="url(#n)"/></g>',
      '<marker id="m" viewBox="0 0 20 20" markerWidth="20" markerHeight="20" refX="10" refY="10" markerUnits="userSpaceOnUse" fill-opacity="0.5"><rect width="20" height="20" fill="#e00"/></marker>' +
        '<marker id="n" viewBox="0 0 20 20" markerWidth="20" markerHeight="20" refX="10" refY="10" markerUnits="userSpaceOnUse"><rect width="20" height="20" fill="#e00"/></marker>',
    ),
    pts: [
      [66, 30, 'marker with fill-opacity 0.5'],
      [66, 80, 'marker under a group of the path (opaque)'],
    ],
  },
  {
    name: 'text under <g fill-opacity>, and a <tspan> with its own fill',
    svg: svg(
      `${FONT_FACE}<g fill-opacity="0.6"><text x="10" y="55" font-family="Roboto" font-size="50" fill="#e00">I</text></g>` +
        '<text x="60" y="55" font-family="Roboto" font-size="50" fill-opacity="0.5"><tspan fill="#0c0">I</tspan></text>' +
        '<text x="10" y="110" font-family="Roboto" font-size="50" fill="#e00" fill-opacity="0.5"><tspan fill-opacity="0.8">I</tspan></text>',
    ),
    boxes: [
      [5, 10, 40, 58, 'glyph under the group (0.6)'],
      [55, 10, 90, 58, 'tspan with its own fill (0.5)'],
      [5, 65, 40, 113, 'tspan with its own fill-opacity (0.8)'],
    ],
  },
];
// ...and a GRADIENT paint at its channel opacity: the importer wrote its paint as
// (1,1,1,1), so a gradient drew opaque whatever its opacity, fill-opacity or stroke-opacity.
CASES.push({
  name: 'a gradient fill / stroke at its opacity, fill-opacity and stroke-opacity',
  svg: svg(
    `<g opacity="50%">${RECT(10, 10, 'fill="url(#lg)"')}</g>${RECT(60, 10, 'fill="url(#lg)" opacity="calc(25% + 25%)"')}` +
      RECT(20, 65, 'fill="#0c0" stroke="url(#lg)" stroke-width="10" stroke-opacity="0.3"'),
    '<linearGradient id="lg"><stop offset="0" stop-color="#e00" stop-opacity="50%"/><stop offset="1" stop-color="#00e" stop-opacity="50%"/></linearGradient>',
  ),
  pts: [
    [30, 30, 'group opacity 50%, mid ramp'],
    [80, 30, 'opacity calc(25% + 25%), mid ramp'],
    [17, 85, 'stroke-opacity 0.3, outside the fill'],
  ],
});
const ROUTES = ['none', 'lb'];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { MantleFontAsset } from '/src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '/src/font/textRun.js';
const FONT = new MantleFontAsset(Uint8Array.from(atob('${fontB64}'), (c) => c.charCodeAt(0)));
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true, fonts: { Roboto: FONT }, svgTextLayout: buildSvgTextGlyphs }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  let before = null;
  for (let i = 0; i < 4; i++) { if (i === 3) before = Object.assign({}, R.debugStats); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const uni = (R.debugStats.unifiedFillDraws | 0) - (before.unifiedFillDraws | 0);
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${N}, ${N}); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // Rows: WebGL reads bottom-up, the 2D canvas top-down.
  const mantleAt = (x, y) => Array.from(px.slice(((${N} - 1 - y) * ${N} + x) * 4, ((${N} - 1 - y) * ${N} + x) * 4 + 4));
  const chromeAt = (x, y) => Array.from(ref.slice((y * ${N} + x) * 4, (y * ${N} + x) * 4 + 4));
  window.__at = { mantleAt, chromeAt };
  return { uni };
};
window.__pts = (pts) => pts.map(([x, y, what]) => ({ x, y, what, mantle: window.__at.mantleAt(x, y), chrome: window.__at.chromeAt(x, y) }));
// The pixel of a box furthest from the ground (#4060c0), in each image on its own.
window.__boxes = (boxes) => boxes.map(([x0, y0, x1, y1, what]) => {
  const G = [0x40, 0x60, 0xc0];
  const far = (at) => { let best = null, bd = -1;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const c = at(x, y), d = Math.max(...G.map((g, i) => Math.abs(c[i] - g))); if (d > bd) { bd = d; best = c; } }
    return best; };
  return { what, mantle: far(window.__at.mantleAt), chrome: far(window.__at.chromeAt) };
});
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
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
// The ground is opaque, so the WebGL canvas's premultiplied bytes are its color.
const TOL = 6;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const c of CASES)
    for (const route of ROUTES) {
      const r = await page.evaluate((s, rt) => window.__case(s, rt), c.svg, route);
      const tag = `${c.name}, route ${route}`;
      if (route === 'none' && r.uni !== 0)
        fail(`${tag}: the classic arm drew ${r.uni} unified draws`);
      const got = c.pts
        ? await page.evaluate((p) => window.__pts(p), c.pts)
        : await page.evaluate((b) => window.__boxes(b), c.boxes);
      for (const p of got) {
        const d = Math.max(...p.mantle.slice(0, 3).map((v, i) => Math.abs(v - p.chrome[i])));
        const at = p.x != null ? ` (${p.x},${p.y})` : '';
        const msg = `${tag}, ${p.what}${at}: mantle rgba(${p.mantle.join(',')}) chrome rgba(${p.chrome.join(',')})`;
        if (d <= TOL) ok(msg);
        else fail(msg + ` -- off by ${d}/255`);
      }
    }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ninheritedChannelOpacityRenderSmoke: inherited fill-opacity and stroke-opacity render at Chrome',
);
