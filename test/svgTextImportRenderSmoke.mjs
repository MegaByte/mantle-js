// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgTextImportRenderSmoke -- the SVG <text> import behaviors that show in PIXELS, on the GPU. The record-level
// proofs are test/svg/svgTextImportSmoke.mjs; this is the rendered check of them.
//
// Each cell renders three documents (128 px, 64-unit viewBox, white ground, Roboto from the test fixtures):
//   svg      the text written with the feature under test;
//   control  the same picture authored with simpler features (the plain family, per-character dx, a
//            rect at the font's table metrics, the text without its trailing space): it must match to 1/255;
//   old      the WRONG reading, authored literally (nothing for a font-family list, no spacing, an
//            underline above the baseline, the anchor shifted by the space): it must DIFFER from svg by 48/255.
// An svg picture with no ink fails: a blank pair would otherwise pass against any inked "old".
//
// Cells: font-family list; letter-spacing vs per-character dx; underline vs a rect at post.underlinePosition and
// thickness; text-anchor=end with a trailing space.
//
// `--cpu` imports the three documents GL-free and reports whether the records agree.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { MantleFontAsset, buildSvgTextGlyphs } from '../src/font/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_URL = '/test/font/fixtures/roboto-regular.ttf';
const roboto = new MantleFontAsset(new Uint8Array(readFileSync(path.join(ROOT, FONT_URL))));
roboto.getMetrics(0x20);
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const T = (attrs, inner, x = 6, y = 40, fs = 24) =>
  `<text x="${x}" y="${y}" font-size="${fs}" fill="black" ${attrs}>${inner}</text>`;
const advance = (text, fs) => buildSvgTextGlyphs(text, roboto, 0, 0, fs).advance;

// underline: post.underlinePosition is the band's TOP (negative = below the baseline), not above it.
const FS = 24,
  BASE = 40,
  X0 = 6,
  W = advance('Hag', FS);
const rectAt = (top, th) => `<rect x="${X0}" y="${top}" width="${W}" height="${th}" fill="black"/>`;
const ulTop = BASE - roboto.underlinePosition * FS,
  ulTh = roboto.underlineThickness * FS;
const oldTop = BASE + roboto.underlinePosition * FS - ulTh * 0.5;
const spW = advance(' ', 24);

const CELLS = [
  {
    name: 'T14 font-family list resolves to the held family',
    svg: doc(T('font-family="Roboto, sans-serif"', 'Hag')),
    control: doc(T('font-family="Roboto"', 'Hag')),
    old: doc(''),
  },
  {
    name: 'T10 letter-spacing equals per-character dx',
    svg: doc(T('font-family="Roboto" letter-spacing="9"', 'HHH', 4, 40, 20)),
    control: doc(T('font-family="Roboto" dx="0 9 9"', 'HHH', 4, 40, 20)),
    old: doc(T('font-family="Roboto"', 'HHH', 4, 40, 20)),
  },
  {
    name: "T12 underline sits at the font's post metrics below the baseline",
    svg: doc(T('font-family="Roboto" text-decoration="underline"', 'Hag')),
    control: doc(T('font-family="Roboto"', 'Hag') + rectAt(ulTop, ulTh)),
    old: doc(T('font-family="Roboto"', 'Hag') + rectAt(oldTop, ulTh)),
  },
  {
    name: 'T13 a trailing space does not move text-anchor=end',
    svg: doc(T('font-family="Roboto" text-anchor="end"', 'Hag ', 58)),
    control: doc(T('font-family="Roboto" text-anchor="end"', 'Hag', 58)),
    old: doc(T('font-family="Roboto" text-anchor="end"', 'Hag', 58 - spW)),
  },
];

// fontTools fixtures contain rectangles from x=50 to width-50, y=0..600.
// Expected glyph pens below are table arithmetic, independent of production layout.
const JSTF_WIDTHS = { 0: 0.5, 1: 0.3, 2: 0.5, 3: 0.5, 6: 0.4, 7: 0.3, 8: 0.5, 9: 0.6, 11: 0.7 };
const JSTF_TRAILING = [
  [2, 0, 0],
  [3, 0.4, 0],
  [1, 0.9, 0],
  [6, 1.2, 0],
  [7, 1.6, 0],
];
const JSTF_MULTI = [
  [11, 0, 0],
  [3, 0.7, 0],
  [6, 0, 1],
  [7, 0.4, 1],
  [1, 0.7, 1],
  [2, 1, 1],
  [3, 1.4, 1],
  [1, 1.9, 1],
  [9, 2.2, 1],
  [2, 2.8, 1],
];
const JSTF_CELLS = [
  {
    name: 'JSTF terminal ligature and explicit final-line alignment',
    text: 'fi',
    width: 0.7,
    final: true,
    rows: [
      [6, 0, 0],
      [7, 0.4, 0],
    ],
    old: [[8, 0, 0]],
  },
  {
    name: 'JSTF terminal word and target advance',
    text: 'ab fi',
    width: 1.9,
    rows: JSTF_TRAILING,
    old: [
      [2, 0, 0],
      [3, 0.4, 0],
      [1, 0.9, 0],
      [6, 1.4, 0],
    ],
  },
  {
    name: 'JSTF rich-span terminal word',
    text: '<color=#ffffff>ab </color>fi',
    markup: true,
    width: 1.9,
    rows: JSTF_TRAILING,
    old: [
      [2, 0, 0],
      [3, 0.4, 0],
      [1, 0.9, 0],
      [6, 1.4, 0],
    ],
  },
  { name: 'JSTF later LF line', text: 'ab\nfi ab xa', width: 3.3, rows: JSTF_MULTI },
  { name: 'JSTF later CRLF line', text: 'ab\r\nfi ab xa', width: 3.3, rows: JSTF_MULTI },
  {
    name: 'JSTF marked source line',
    text: 'ab\nfi\u0301 ab xa',
    width: 3.3,
    rows: [
      [11, 0, 0],
      [3, 0.7, 0],
      [8, 0, 1],
      [0, 0.5, 1],
      [1, 1, 1],
      [2, 2.4, 1],
      [3, 2.8, 1],
      [9, 0, 2],
      [11, 0.6, 2],
    ],
  },
  {
    name: 'JSTF priority expansion',
    text: 'fi ab xa',
    width: 3.3,
    rows: [
      [6, 0, 0],
      [7, 0.4, 0],
      [1, 0.7, 0],
      [2, 1, 0],
      [3, 1.4, 0],
      [1, 1.9, 0],
      [9, 2.2, 0],
      [2, 2.8, 0],
    ],
  },
].map((c) => {
  const rows = c.rows.map((row) => row.slice());
  const old = c.old?.map((row) => row.slice());
  let height = Math.max(...rows.map((row) => row[2])) + 1;
  if (!c.final) {
    c.text += '\nb';
    rows.push([3, 0, height]);
    old?.push([3, 0, height]);
    height++;
  }
  const picture = (rs) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    c.width +
    ' ' +
    height +
    '">' +
    rs
      .map(
        ([g, x, y]) =>
          '<rect x="' +
          (x + 0.05) +
          '" y="' +
          (y + 0.2) +
          '" width="' +
          (JSTF_WIDTHS[g] - 0.1) +
          '" height=".6" fill="white"/>',
      )
      .join('') +
    '</svg>';
  return { ...c, control: picture(rows), old: old ? picture(old) : null };
});

if (process.argv.includes('--cpu')) {
  const { imp } = await import('./svg/_importSemantics.mjs');
  const opts = {
    preserveViewport: true,
    fonts: { Roboto: roboto },
    svgTextLayout: buildSvgTextGlyphs,
  };
  const key = (x) =>
    JSON.stringify(
      Object.keys(x)
        .sort()
        .map((k) => [
          k,
          ArrayBuffer.isView(x[k]) || x[k] instanceof ArrayBuffer
            ? Buffer.from(x[k].buffer || x[k]).toString('base64')
            : x[k],
        ]),
      (k, v) => (typeof v === 'number' && !isFinite(v) ? String(v) : v),
    );
  const same = (a, b) => key(a) === key(b);
  for (const c of CELLS) {
    const [s, k, o] = await Promise.all([imp(c.svg, opts), imp(c.control, opts), imp(c.old, opts)]);
    console.log(
      `${same(s, k) ? 'record==control' : 'record!=control'} ${same(s, o) ? 'record==OLD(vacuous?)' : 'record!=old'}  ${c.name}`,
    );
  }
  process.exit(0);
}

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createTextBundle } from '/src/index.js';
import { registerJustificationReader } from '/src/font/typography/justification.js';
import { MantleFontAsset, buildSvgTextGlyphs } from '/src/font/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const roboto = new MantleFontAsset(new Uint8Array(await (await fetch('${FONT_URL}')).arrayBuffer()));
window.__render = async (sources) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const s of sources) {
    const b = createBundle(gl, await importSvg(s, { preserveViewport: true, fonts: { Roboto: roboto }, svgTextLayout: buildSvgTextGlyphs }));
    out.push(Array.from(await paint(gl, R, b))); b.dispose();
  }
  return out;
};
registerJustificationReader();
const jstfFont = new MantleFontAsset(new Uint8Array(await (await fetch('/test/fixtures/fonts/jstfPriorities.ttf')).arrayBuffer()));
window.__jstf = async (c) => {
  gl.canvas.width = gl.canvas.height = 256; R.setViewport(256, 256); gl.viewport(0, 0, 256, 256);
  R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const text = await createTextBundle(gl, { font: jstfFont, text: c.text, markup: !!c.markup,
    style: { fill: [1, 1, 1, 1], maxWidthEm: c.width, layoutWidthEm: c.width, align: 'justify', lastLineAlign: 'justify' } });
  const bundles = [text];
  try {
    for (const source of [c.control, c.old].filter(Boolean)) bundles.push(createBundle(gl, await importSvg(source, { preserveViewport: true })));
    const images = [];
    for (const b of bundles) {
      const draw = () => { R.beginFrame([0, 0, 0, 1]); R.drawBundle(b); R.endFrame(); };
      const warm = await R.warmScene([{ draw }], { maxPasses: 64, fenceTimeoutMs: 60000 });
      if (!warm.complete) throw Error('JSTF draw did not warm');
      draw();
      const pixels = new Uint8Array(256 * 256 * 4);
      gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() !== gl.NO_ERROR) throw Error('JSTF draw GL error');
      images.push(Array.from(pixels));
    }
    return images;
  } finally { for (const b of bundles) b.dispose(); }
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
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = ((127 - Math.floor(y * 2)) * 128 + Math.floor(x * 2)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const inkOf = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) n++;
  return n;
};
for (const c of CELLS) {
  let px;
  try {
    px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const [a, b, o] = px;
  const vsControl = maxDiff(a, b),
    vsOld = maxDiff(a, o);
  const bad = inkOf(a) < 20 ? ['no ink'] : [];
  const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
  if (vsControl > 1) fail(line + ' -- render differs from its control');
  else if (vsOld < 48) fail(line + " -- vacuous: the wrong reading's picture is the same");
  else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
  else ok(line);
}
for (const c of JSTF_CELLS) {
  try {
    const [actual, control, old] = await page.evaluate((c) => window.__jstf(c), c);
    const difference = maxDiff(actual, control);
    const ink = actual.filter((v, i) => i % 4 === 0 && v > 5).length;
    const oldDifference = old ? maxDiff(actual, old) : null;
    const result =
      c.name +
      ': control maxByte ' +
      difference +
      ', old maxByte ' +
      oldDifference +
      ', ink ' +
      ink;
    if (difference > 2 || ink < 20 || (old && oldDifference < 48)) fail(result);
    else ok(result);
  } catch (e) {
    fail(c.name + ': ' + e.message);
  }
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nsvgTextImportRenderSmoke: the SVG text import fixes render as their controls on the GPU',
);
