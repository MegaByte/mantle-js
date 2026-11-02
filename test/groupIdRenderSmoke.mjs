// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupIdRenderSmoke -- group ids on every bundle: table.set('G', ...) on a bundle that has NO hit-only rows moves, scales,
// rotates, hides and tints what is under the element with that id, and the picture equals the same document authored with a literal
// <g transform>. (test/hitOnlyAnimRenderSmoke.mjs proves the same with hit-only siblings; test/groupIdsEveryBundleSmoke.mjs is the CPU proof.)
//
// Each cell renders at 128 px (64-unit viewBox, white ground), on the GPU:
//   svg      the document under test with the override table applied (ops);
//   control  the same picture authored literally (<g transform="matrix(...)">, an opacity): the render must match it to within `tol` (2/255);
//   old      the document with no override (where the shapes sit without the group override): must DIFFER by at least 48/255;
//   chrome   the control drawn by Chrome at 8x and box-averaged (the AA reference), scored on flat pixels.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { compare } from './_chrome8Ref.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const rect = (x, y, w, h, fill, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
const mat = ({ localPosition: p = [0, 0], localRotation: r = 0, localScale: s = [1, 1] }) => {
  const c = Math.cos(r),
    sn = Math.sin(r);
  return `matrix(${c * s[0]} ${sn * s[0]} ${-sn * s[1]} ${c * s[1]} ${p[0]} ${p[1]})`;
};
const OV_A = { localPosition: [16, 22], localScale: [1.5, 1.5] },
  OV_ROT = { localPosition: [20, 4], localRotation: Math.PI / 6 };
const OV_H = { localScale: [1.5, 1.5] },
  OV_GN = { localPosition: [8, 0] };
const CELLS = [
  {
    name: 'G: translate + scale (no hit-only rows)',
    svg: doc(
      `<g id="G">${rect(6, 6, 10, 10, '#e00')}${rect(22, 6, 10, 10, '#00e')}</g>${rect(40, 44, 10, 10, '#0a0')}`,
    ),
    ops: [['G', OV_A]],
    control: doc(
      `<g transform="${mat(OV_A)}">${rect(6, 6, 10, 10, '#e00')}${rect(22, 6, 10, 10, '#00e')}</g>${rect(40, 44, 10, 10, '#0a0')}`,
    ),
  },
  {
    name: 'G: rotate 30 degrees + translate',
    svg: doc(`<g id="G">${rect(4, 4, 12, 12, '#e00')}${rect(4, 24, 12, 12, '#00e')}</g>`),
    ops: [['G', OV_ROT]],
    control: doc(
      `<g transform="${mat(OV_ROT)}">${rect(4, 4, 12, 12, '#e00')}${rect(4, 24, 12, 12, '#00e')}</g>`,
    ),
  },
  {
    name: 'nested G(H(rows)): the order the shaders compose',
    svg: doc(`<g id="G"><g id="H">${rect(4, 4, 8, 8, '#e00')}</g>${rect(4, 30, 8, 8, '#00e')}</g>`),
    ops: [
      ['G', OV_GN],
      ['H', OV_H],
    ],
    control: doc(
      `<g transform="${mat(OV_GN)}"><g transform="${mat(OV_H)}">${rect(4, 4, 8, 8, '#e00')}</g>${rect(4, 30, 8, 8, '#00e')}</g>`,
    ),
  },
  {
    name: 'G hidden: everything under it vanishes',
    svg: doc(
      `<g id="G">${rect(6, 6, 10, 10, '#e00')}${rect(22, 6, 10, 10, '#00e')}</g>${rect(40, 40, 10, 10, '#e00')}`,
    ),
    ops: [['G', { visibility: 0 }]],
    control: doc(rect(40, 40, 10, 10, '#e00')),
  },
  {
    name: '<use id>: one instance moves, the other stays',
    svg: doc(
      `<defs><g id="T">${rect(2, 2, 10, 10, '#e00')}</g></defs><use id="u1" href="#T"/><use id="u2" href="#T" x="30"/>`,
    ),
    ops: [['u2', { localPosition: [-14, 26] }]],
    control: doc(
      `<defs><g id="T">${rect(2, 2, 10, 10, '#e00')}</g></defs><use href="#T"/><g transform="${mat({ localPosition: [-14, 26] })}"><use href="#T" x="30"/></g>`,
    ),
  },
  {
    name: 'a row override under a group override: G(own(row))',
    svg: doc(`<g id="G">${rect(6, 6, 10, 10, '#e00', 'id="d"')}</g>`),
    ops: [
      ['d', { localPosition: [0, 12] }],
      ['G', { localPosition: [4, 2], localScale: [1.25, 0.75] }],
    ],
    control: doc(
      `<g transform="${mat({ localPosition: [4, 2], localScale: [1.25, 0.75] })}"><g transform="${mat({ localPosition: [0, 12] })}">${rect(6, 6, 10, 10, '#e00')}</g></g>`,
    ),
  },
  {
    name: 'G tint alpha .5: the rows under it dim',
    svg: doc(`<g id="G">${rect(8, 8, 24, 24, '#e00')}</g>`),
    ops: [['G', { tint: [1, 1, 1, 0.5] }]],
    control: doc(rect(8, 8, 24, 24, '#e00', 'fill-opacity=".5"')),
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createOverrideTable, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const flip = (px) => { const out = new Uint8Array(px.length); for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { const s = ((127 - y) * 128 + x) * 4, d = (y * 128 + x) * 4, a = px[s + 3]; out[d + 3] = a; if (a) for (let k = 0; k < 3; k++) out[d + k] = Math.min(255, Math.round(px[s + k] * 255 / a)); } return out; };
window.__render = async (svg, ops) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const sections = await importSvg(svg, { preserveViewport: true });
  const b = createBundle(gl, sections);
  let table;
  const info = { hitOnly: !!sections.hitOnly, groups: sections.groupTree ? sections.groupTree.groupNames : null, resolved: [] };
  if (ops && ops.length) { table = createOverrideTable(gl, b); for (const [k, o] of ops) info.resolved.push(table.set(k, o)); }
  const px = Array.from(await paint(gl, R, b, table)); b.dispose();
  return { px: b64(flip(Uint8Array.from(px))), info };
};
window.__chrome = async (svg, S) => {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = 128 * S; c2.height = 128 * S;
  const x2 = c2.getContext('2d', { willReadFrequently: true }); x2.fillStyle = '#fff'; x2.fillRect(0, 0, 128 * S, 128 * S); x2.drawImage(img, 0, 0, 128 * S, 128 * S);
  const d = x2.getImageData(0, 0, 128 * S, 128 * S).data, out = new Uint8Array(128 * 128 * 4);
  for (let yy = 0; yy < 128; yy++) for (let xx = 0; xx < 128; xx++) {
    let r = 0, g = 0, bl = 0, a = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const q = ((yy * S + j) * 128 * S + xx * S + i) * 4, al = d[q + 3]; r += d[q] * al; g += d[q + 1] * al; bl += d[q + 2] * al; a += al; }
    const o = (yy * 128 + xx) * 4; out[o + 3] = Math.round(a / (S * S)); if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(bl / a); }
  }
  return b64(out);
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
const u8 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
for (const c of CELLS) {
  try {
    const r = await page.evaluate((s, o) => window.__render(s, o), c.svg, c.ops);
    const control = u8((await page.evaluate((s) => window.__render(s, null), c.control)).px);
    const old = u8((await page.evaluate((s) => window.__render(s, null), c.svg)).px);
    const chrome = u8(await page.evaluate((s) => window.__chrome(s, 8), c.control));
    const svg = u8(r.px),
      vsControl = maxDiff(svg, control),
      vsOld = maxDiff(svg, old),
      vsChrome = compare(svg, chrome, 128, 128, { tol: 8, edge: chrome });
    const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, Chrome 8x flat max ${vsChrome.max} mean ${vsChrome.mean.toFixed(3)} (n ${vsChrome.n})`;
    if (r.info.hitOnly) fail(line + ' -- the cell must have no hit-only rows');
    else if (!r.info.resolved.every((x) => x === true))
      fail(line + ' -- a key did not resolve: ' + JSON.stringify(r.info));
    else if (vsControl > 2) fail(line + ' -- render differs from its control');
    else if (vsOld < 48) fail(line + ' -- vacuous: the un-overridden picture is the same');
    else if (vsChrome.max > 8) fail(line + ' -- differs from Chrome at ' + vsChrome.at);
    else ok(line);
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
  '\ngroupIdRenderSmoke: group overrides work on bundles with no hit-only rows and equal their literal <g transform> controls',
);
