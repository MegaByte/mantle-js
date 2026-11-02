// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// inheritanceRenderSmoke — the visible inheritance cases against Chrome, on
// both routes.
//
//   an inherited property reaches a <use>'s target from the <use>, not from the target's <defs>
//         ancestors: fill-rule (a hole), a square cap, visibility, currentColor, a <symbol>'s own fill;
//   a <marker fill> reaches the marker's content;
//   a <pattern fill> reaches the tile's content, and a <mask fill="white"> its content;
//   a gradient in a pattern tile and in mask content keeps its fill-opacity;
//   ...and so does an <image> keep its opacity;
//   a shape in a <clipPath> winds by clip-rule, not fill-rule;
//   text-anchor inherits, and a <tspan>'s own style= font-size applies.
// Each has a node smoke that pins the import: useInheritanceSmoke, markerInheritanceSmoke,
// defContentInheritanceSmoke, childGradientOpacitySmoke, childImageOpacitySmoke, clipRuleSmoke,
// textInheritanceSmoke.
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read through a 2D canvas over the same opaque
// ground, at flat points away from every edge.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { fontFixture, requireAsset } from './_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 120;
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${defs}</defs><rect width="${N}" height="${N}" fill="#4060c0"/>${body}</svg>`;
const RING = 'M10 10 L110 10 L110 110 L10 110 Z M40 40 L80 40 L80 80 L40 80 Z'; // same winding: a hole only under evenodd
const CASES = [
  {
    name: '<use fill-rule="evenodd">',
    svg: svg('<use href="#r" fill-rule="evenodd"/>', `<path id="r" d="${RING}" fill="#e00"/>`),
    pts: [
      [60, 60, 'the hole'],
      [20, 20, 'the ring'],
    ],
  },
  {
    name: "the target's <defs> group does not count",
    svg: svg(
      '<use href="#r"/>',
      `<g fill-rule="evenodd"><path id="r" d="${RING}" fill="#e00"/></g>`,
    ),
    pts: [[60, 60, 'the would-be hole (filled)']],
  },
  {
    name: '<use stroke-linecap="square">',
    svg: svg(
      '<use href="#l" stroke-linecap="square"/>',
      '<path id="l" d="M20 60 L80 60" fill="none" stroke="#e00" stroke-width="20"/>',
    ),
    pts: [
      [86, 60, 'inside the square cap'],
      [50, 60, 'the stroke'],
    ],
  },
  {
    name: '<use visibility="hidden">',
    svg: svg(
      '<use href="#v" visibility="hidden"/>',
      '<rect id="v" x="20" y="20" width="80" height="80" fill="#e00"/>',
    ),
    pts: [[60, 60, 'where the target would be']],
  },
  {
    name: 'currentColor from the <use>',
    svg: svg(
      '<use href="#c" color="#0c0"/>',
      '<rect id="c" x="20" y="20" width="80" height="80" fill="currentColor"/>',
    ),
    pts: [[60, 60, 'the target']],
  },
  {
    name: "a <symbol>'s own fill",
    svg: svg(
      '<use href="#s" x="20" y="20" width="80" height="80"/>',
      '<symbol id="s" viewBox="0 0 10 10" fill="#0c0"><rect width="10" height="10"/></symbol>',
    ),
    pts: [[60, 60, 'the symbol']],
  },
  {
    name: '<marker fill>',
    svg: svg(
      '<path d="M10 60 L60 60" fill="none" stroke="#000" stroke-width="2" marker-end="url(#m)"/>',
      '<marker id="m" viewBox="0 0 30 30" refX="15" refY="15" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" fill="#e00"><rect width="30" height="30"/></marker>',
    ),
    pts: [[70, 60, 'the marker, past the path']],
  },
  {
    name: '<pattern fill>',
    svg: svg(
      '<rect x="20" y="20" width="80" height="80" fill="url(#p)"/>',
      '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse" fill="#e00"><rect width="10" height="10"/></pattern>',
    ),
    pts: [[55, 55, 'the tiled rect']],
  },
  {
    name: '<mask fill="white">',
    svg: svg(
      '<rect x="20" y="20" width="80" height="80" fill="#e00" mask="url(#m)"/>',
      '<mask id="m" fill="white"><rect width="120" height="120"/></mask>',
    ),
    pts: [[60, 60, 'the masked rect']],
  },
  {
    name: 'a gradient in a pattern tile at fill-opacity 0.5',
    svg: svg(
      '<rect x="20" y="20" width="80" height="80" fill="url(#p)"/>',
      '<linearGradient id="g"><stop offset="0" stop-color="#e00"/><stop offset="1" stop-color="#e00"/></linearGradient>' +
        '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/></pattern>',
    ),
    pts: [[55, 55, 'the tiled rect']],
  },
  {
    name: 'a gradient in mask content at fill-opacity 0.5',
    svg: svg(
      '<rect x="20" y="20" width="80" height="80" fill="#e00" mask="url(#m)"/>',
      '<linearGradient id="w"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff"/></linearGradient>' +
        '<mask id="m"><rect width="120" height="120" fill="url(#w)" fill-opacity="0.5"/></mask>',
    ),
    pts: [[60, 60, 'the masked rect']],
  },
];
// an <image> in a pattern tile and in mask content keeps its opacity. A solid 4 x 4 PNG, built
// here so the fixture carries no binary.
function png(w, h, rgba) {
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
    for (let x = 0; x < w; x++) raw.set(rgba, y * (w * 4 + 1) + 1 + x * 4);
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
const ORANGE = png(4, 4, [255, 140, 0, 255]),
  WHITE = png(4, 4, [255, 255, 255, 255]);
CASES.push(
  {
    name: 'an <image> in a pattern tile at opacity 0.5',
    svg: svg(
      '<rect x="20" y="20" width="80" height="80" fill="url(#p)"/>',
      `<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><image width="10" height="10" href="${ORANGE}" opacity="0.5" preserveAspectRatio="none"/></pattern>`,
    ),
    pts: [[55, 55, 'the tiled rect']],
  },
  {
    name: 'an <image> in mask content at opacity 0.5',
    svg: svg(
      '<rect x="20" y="20" width="80" height="80" fill="#e00" mask="url(#m)"/>',
      `<mask id="m"><image width="120" height="120" href="${WHITE}" opacity="0.5" preserveAspectRatio="none"/></mask>`,
    ),
    pts: [[60, 60, 'the masked rect']],
  },
);
// a shape inside a <clipPath> winds by clip-rule (inherited), and its fill-rule means nothing there.
CASES.push(
  {
    name: 'clip-rule="evenodd" inherited from the <clipPath>',
    svg: svg(
      '<rect width="120" height="120" fill="#e00" clip-path="url(#c)"/>',
      `<clipPath id="c" clip-rule="evenodd"><path d="${RING}"/></clipPath>`,
    ),
    pts: [
      [60, 60, "the clip's hole"],
      [20, 20, "the clip's ring"],
    ],
  },
  {
    name: 'a clip child\'s fill-rule="evenodd" is ignored',
    svg: svg(
      '<rect width="120" height="120" fill="#e00" clip-path="url(#c)"/>',
      `<clipPath id="c"><path d="${RING}" fill-rule="evenodd"/></clipPath>`,
    ),
    pts: [[60, 60, 'no hole (clip-rule nonzero)']],
  },
);
// the text-layout reads follow the cascade and the inheritance parents. Roboto is embedded in the
// SVG Chrome draws and handed to the importer as bytes. A 60 px "I" is a stem about 5.6 px wide.
const fontB64 = readFileSync(requireAsset(fontFixture('roboto-regular.ttf'))).toString('base64');
const FONT_FACE = `<style>@font-face { font-family: Roboto; src: url(data:font/ttf;base64,${fontB64}); }</style>`;
CASES.push(
  {
    name: 'a <g text-anchor="middle"> centers its text',
    svg: svg(
      `${FONT_FACE}<g text-anchor="middle"><text x="60" y="80" font-family="Roboto" font-size="60" fill="#e00">I</text></g>`,
    ),
    pts: [
      [60, 60, 'the stem, centered on x = 60'],
      [68, 60, 'where a start-anchored stem would be'],
    ],
  },
  {
    name: 'a <tspan style="font-size:60px">',
    svg: svg(
      `${FONT_FACE}<text x="10" y="110" font-family="Roboto" font-size="10" fill="#e00"><tspan style="font-size:60px">I</tspan></text>`,
    ),
    pts: [[17, 90, 'the 60 px stem']],
  },
);
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
window.__case = async (svg, pts, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true, fonts: { Roboto: FONT }, svgTextLayout: buildSvgTextGlyphs }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.prewarmBundle(b); R.precompileFills();   // the loading call: the first frames draw the programs a game has after loading
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
  return { uni, pts: pts.map(([x, y, what]) => ({ x, y, what,
    mantle: Array.from(px.slice(((${N} - 1 - y) * ${N} + x) * 4, ((${N} - 1 - y) * ${N} + x) * 4 + 4)),
    chrome: Array.from(ref.slice((y * ${N} + x) * 4, (y * ${N} + x) * 4 + 4)) })) };
};
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
      const r = await page.evaluate((s, p, rt) => window.__case(s, p, rt), c.svg, c.pts, route);
      const tag = `${c.name}, route ${route}`;
      if (route === 'none' && r.uni !== 0)
        fail(`${tag}: the classic arm drew ${r.uni} unified draws`);
      for (const p of r.pts) {
        const d = Math.max(...p.mantle.slice(0, 3).map((v, i) => Math.abs(v - p.chrome[i])));
        const msg = `${tag}, ${p.what} (${p.x},${p.y}): mantle rgba(${p.mantle.join(',')}) chrome rgba(${p.chrome.join(',')})`;
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
  '\ninheritanceRenderSmoke: <use>, marker, pattern and mask inheritance and child gradients render at Chrome',
);
