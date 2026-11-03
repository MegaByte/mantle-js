// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupIdRenderSmoke -- group ids on every bundle: table.set('G', ...) on a bundle that has NO hit-only rows moves, scales,
// rotates, hides and tints what is under the element with that id, and the picture equals the same document authored with a literal
// <g transform>. The second half proves the same with hit-only siblings; test/groupIdsEveryBundleSmoke.mjs is the CPU proof.
//
// Each cell renders at 128 px (64-unit viewBox, white ground), on the GPU:
//   svg      the document under test with the override table applied (ops);
//   control  the same picture authored literally (<g transform="matrix(...)">, an opacity): the render must match it to within `tol` (2/255);
//   old      the document with no override (where the shapes sit without the group override): must DIFFER by at least 48/255;
//   chrome   the control drawn by Chrome at 8x and box-averaged (the AA reference), scored on flat pixels.
//
// HIT-ONLY SIBLINGS (second page): a drawn child and a hit-only sibling move together under a group override, and the hit result
// tracks the drawn pixel (the CPU proofs are test/hitOnlyAnimSmoke.mjs). A hit-only shape (a transparent hit rectangle) draws
// nothing, so the picture cannot show where it is. Each cell therefore builds the scene four ways, on the GPU at 128 px (64-unit
// viewBox, white ground):
//   svg         the document with the shapes under a group id (or a <use> id, or a row id), drawn with an override table that moves it;
//   control     the same picture authored literally: <g transform="matrix(...)"> around the red drawn child, the override's matrix;
//   hitControl  the control with the hit-only sibling drawn too (blue): where the sibling WOULD be if it were drawn, at the same matrix;
//   old         the svg document drawn with no override (where the shapes sit without the group override).
// Held: svg == control to within `tol` (the drawn child follows the group override); old differs by at least 48/255 (not vacuous);
// and at the center of every pixel (16384 points) every point whose hitControl pixel is pure red hits the drawn row,
// pure blue the hit-only row, pure white nothing, through fillHitShape with the same table. Edge pixels (neither pure nor white) are
// skipped and counted.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { compare } from './_chrome8Ref.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

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

// The white ground is drawn row 0 and no target (pointer-events none), so every row index below is one more than the cell lists it.
const hitDoc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white" pointer-events="none"/>${body}</svg>`;
const RED = '#e00',
  BLUE = '#00e';

// OV_ROT, OV_H and OV_GN are shared with the cells above.
const OV_G = { localPosition: [16, 22], localScale: [1.5, 1.5] };
const OV_OWN = { localPosition: [0, 12] };
const OV_GS = { localPosition: [4, 2], localScale: [1.25, 0.75] };
const OV_U2 = { localPosition: [-14, 26] };

const HIT_CELLS = [
  {
    name: 'group id: translate + scale moves the drawn child and the hit-only sibling',
    svg: hitDoc(
      `<g id="G">${rect(6, 6, 10, 10, RED, 'id="d"')}${rect(22, 6, 10, 10, 'transparent', 'id="h"')}</g>`,
    ),
    ops: [['G', OV_G]],
    control: hitDoc(`<g transform="${mat(OV_G)}">${rect(6, 6, 10, 10, RED)}</g>`),
    hitControl: hitDoc(
      `<g transform="${mat(OV_G)}">${rect(6, 6, 10, 10, RED)}${rect(22, 6, 10, 10, BLUE)}</g>`,
    ),
    red: [0],
    blue: [1],
  },
  {
    name: 'group id: rotate 30 degrees + translate',
    svg: hitDoc(`<g id="G">${rect(4, 4, 12, 12, RED)}${rect(4, 24, 12, 12, 'transparent')}</g>`),
    ops: [['G', OV_ROT]],
    control: hitDoc(`<g transform="${mat(OV_ROT)}">${rect(4, 4, 12, 12, RED)}</g>`),
    hitControl: hitDoc(
      `<g transform="${mat(OV_ROT)}">${rect(4, 4, 12, 12, RED)}${rect(4, 24, 12, 12, BLUE)}</g>`,
    ),
    red: [0],
    blue: [1],
  },
  {
    name: 'nested groups: G(H(row)), the order the shaders compose',
    svg: hitDoc(
      `<g id="G"><g id="H">${rect(4, 4, 8, 8, RED)}${rect(20, 4, 8, 8, 'transparent')}</g>${rect(4, 30, 8, 8, RED)}${rect(24, 30, 8, 8, 'transparent')}</g>`,
    ),
    ops: [
      ['G', OV_GN],
      ['H', OV_H],
    ],
    control: hitDoc(
      `<g transform="${mat(OV_GN)}"><g transform="${mat(OV_H)}">${rect(4, 4, 8, 8, RED)}</g>${rect(4, 30, 8, 8, RED)}</g>`,
    ),
    hitControl: hitDoc(
      `<g transform="${mat(OV_GN)}"><g transform="${mat(OV_H)}">${rect(4, 4, 8, 8, RED)}${rect(20, 4, 8, 8, BLUE)}</g>${rect(4, 30, 8, 8, RED)}${rect(24, 30, 8, 8, BLUE)}</g>`,
    ),
    red: [0, 1],
    blue: [2, 3],
    rowOf: (kind, x, y, cell) => (kind === 'red' ? (y < 25 ? 0 : 1) : y < 25 ? 2 : 3),
  },
  {
    name: 'a row override under a group override: G(own(row))',
    svg: hitDoc(
      `<g id="G">${rect(6, 6, 10, 10, RED, 'id="d"')}${rect(24, 6, 10, 10, 'transparent', 'id="h"')}</g>`,
    ),
    ops: [
      ['d', OV_OWN],
      ['h', OV_OWN],
      ['G', OV_GS],
    ],
    control: hitDoc(
      `<g transform="${mat(OV_GS)}"><g transform="${mat(OV_OWN)}">${rect(6, 6, 10, 10, RED)}</g></g>`,
    ),
    hitControl: hitDoc(
      `<g transform="${mat(OV_GS)}"><g transform="${mat(OV_OWN)}">${rect(6, 6, 10, 10, RED)}${rect(24, 6, 10, 10, BLUE)}</g></g>`,
    ),
    red: [0],
    blue: [1],
  },
  {
    name: 'group id hidden: the drawn child vanishes and the hit-only sibling stops answering',
    svg: hitDoc(
      `<g id="G">${rect(6, 6, 10, 10, RED)}${rect(22, 6, 10, 10, 'transparent')}</g>${rect(40, 40, 10, 10, RED)}`,
    ),
    ops: [['G', { visibility: 0 }]],
    control: hitDoc(rect(40, 40, 10, 10, RED)),
    hitControl: hitDoc(rect(40, 40, 10, 10, RED)),
    red: [1],
    blue: [],
  },
  {
    name: '<use id>: one instance moves, the other stays',
    svg: hitDoc(
      `<defs><g id="T">${rect(2, 2, 10, 10, RED)}${rect(16, 2, 10, 10, 'transparent')}</g></defs><use id="u1" href="#T"/><use id="u2" href="#T" x="30"/>`,
    ),
    ops: [['u2', OV_U2]],
    control: hitDoc(
      `<defs><g id="T">${rect(2, 2, 10, 10, RED)}</g></defs><use href="#T"/><g transform="${mat(OV_U2)}"><use href="#T" x="30"/></g>`,
    ),
    hitControl: hitDoc(
      `<defs><g id="T">${rect(2, 2, 10, 10, RED)}${rect(16, 2, 10, 10, BLUE)}</g></defs><use href="#T"/><g transform="${mat(OV_U2)}"><use href="#T" x="30"/></g>`,
    ),
    red: [0, 1],
    blue: [2, 3],
    // instance 1 stays at the top left; instance 2 moved by (-14, 26) from x 30..: it sits left, lower
    rowOf: (kind, x, y) => (kind === 'red' ? (y < 20 ? 0 : 1) : y < 20 ? 2 : 3),
  },
];

const HIT_HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
window.addEventListener('error', (e) => { window.__err = String(e.message || e); window.__ready = true; });
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable, fillHitShape } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__cell = async (c) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = {};
  const load = async (s) => { const b = createBundle(gl, await importSvg(s, { preserveViewport: true, keepInvisibleShapes: false })); return b; };
  const b = await load(c.svg);
  const T = createOverrideTable(gl, b);
  for (const [k, o] of c.ops) if (!T.set(k, o)) throw new Error('override key ' + k + ' did not resolve');
  out.svg = Array.from(await paint(gl, R, b, T));
  out.old = Array.from(await paint(gl, R, b));
  // one hit query at the center of every pixel of the 128 x 128 canvas (2 pixels per unit)
  const hits = new Int32Array(128 * 128);
  for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) hits[j * 128 + i] = fillHitShape(b, (i + 0.5) / 2, (j + 0.5) / 2, { overrides: T });
  out.hits = Array.from(hits);
  out.numShapes = b.numShapes; out.numHitOnly = T.numHitOnly;
  for (const key of ['control', 'hitControl']) { const cb = await load(c[key]); out[key] = Array.from(await paint(gl, R, cb)); cb.dispose(); }
  b.dispose();
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/hit') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(u === '/' ? HTML : HIT_HTML);
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
// Hit-only siblings, on their own page (fillHitShape and invisible-shape stripping).
{
  await page.close();
  const page2 = await browser.newPage();
  page2.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page2.goto('http://127.0.0.1:' + server.address().port + '/hit', { waitUntil: 'load' });
  await page2.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
  const pxAt = (a, i, j) => {
    const o = ((127 - j) * 128 + i) * 4;
    return [a[o], a[o + 1], a[o + 2]];
  };
  const near = (c, t, tol = 28) =>
    Math.abs(c[0] - t[0]) <= tol && Math.abs(c[1] - t[1]) <= tol && Math.abs(c[2] - t[2]) <= tol;
  for (const c of HIT_CELLS) {
    let o;
    try {
      o = await page2.evaluate((x) => window.__cell(x), {
        svg: c.svg,
        ops: c.ops,
        control: c.control,
        hitControl: c.hitControl,
      });
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const vsControl = maxDiff(o.svg, o.control),
      vsOld = maxDiff(o.svg, o.old);
    let wrong = 0,
      checked = 0,
      skipped = 0,
      firstBad = '';
    for (let j = 0; j < 128; j++)
      for (let i = 0; i < 128; i++) {
        const x = (i + 0.5) / 2,
          y = (j + 0.5) / 2,
          p = pxAt(o.hitControl, i, j),
          got = o.hits[j * 128 + i];
        let want;
        if (near(p, [238, 0, 0], 6)) want = 1 + (c.rowOf ? c.rowOf('red', x, y, c) : c.red[0]);
        else if (near(p, [0, 0, 238], 6))
          want = 1 + (c.rowOf ? c.rowOf('blue', x, y, c) : c.blue[0]);
        else if (near(p, [255, 255, 255], 6)) want = -1;
        else {
          skipped++;
          continue;
        }
        checked++;
        if (got !== want) {
          wrong++;
          if (!firstBad) firstBad = `(${x},${y}) hit ${got}, drawn control says ${want}`;
        }
      }
    const line = `${c.name}: svg vs control maxByte ${vsControl}, old differs by ${vsOld}, ${checked} pixel centers checked (${skipped} edge pixels skipped), ${wrong} hit/draw disagreements; rows ${o.numShapes} drawn + ${o.numHitOnly} hit-only`;
    if (vsControl > (c.tol ?? 3))
      fail(line + ' -- the drawn child is not where the override puts it');
    else if (vsOld < 48) fail(line + ' -- vacuous: the unmoved picture is the same');
    else if (wrong) fail(line + ' -- ' + firstBad);
    else if (checked < 2400) fail(line + ' -- too few checked points');
    else ok(line);
  }
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ngroupIdRenderSmoke: group overrides work on bundles with no hit-only rows and equal their literal <g transform> controls;' +
    ' a drawn child and a hit-only sibling move together under a group override, and the hit tracks the drawn pixel',
);
