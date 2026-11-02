// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// keepHiddenRenderSmoke -- content the document hides, drawn on the GPU.
//   * Chrome cells (the AA reference: Chrome's SVG engine at 8x, box-averaged): display:none, visibility:hidden / collapse, a child that turns
//     visibility back on, a display:none parent over a child with display:inline draw as the browser draws them, in the default import AND with
//     keepHidden, on the cover-quad route and the Loop-Blinn route;
//   * an override that reveals a kept row draws it as the browser draws the same element displayed (the control Chrome SVG has no display:none);
//     a hidden group is revealed by its id (cover-quad route; the Loop-Blinn route does not draw a revealed row beside visible ones);
//   * a morph from / to a pose that hides a shape fades it in / out at the interpolated geometry (the control is the same picture authored directly
//     with the interpolated position and opacity), on three kernels;
//
//   KH_ONLY=prefix,...   run only the cells whose id starts with one of the prefixes
//   KH_ROUTES=none,lb    routes for the Chrome cells (default both)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 128;
const doc = (body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" ${extra}>${body}</svg>`;
const only = process.env.KH_ONLY ? process.env.KH_ONLY.split(',') : null;
const ROUTES = process.env.KH_ROUTES ? process.env.KH_ROUTES.split(',') : ['none', 'lb'];
const want = (id) => !only || only.some((p) => id.startsWith(p));
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

// ---- Chrome cells ------------------------------------------------------------------------------------------------------------------------------
const R = (id, x, attrs, extra = '') =>
  `<rect id="${id}" x="${x}" y="20" width="30" height="40" ${attrs} ${extra}/>`;
// [id, svg for Mantle, svg Chrome draws (default: the same), importOpts, overrideSets]
const CELLS = [
  [
    'display-none',
    doc(
      R('a', 10, 'fill="#c22"') +
        `<g display="none">${R('h', 50, 'fill="#22c"')}</g>` +
        R('b', 90, 'fill="#2a2"'),
    ),
  ],
  [
    'display-none-child-inline',
    doc(
      `<g display="none">${R('h', 10, 'fill="#22c"', 'display="inline"')}</g>` +
        R('b', 70, 'fill="#2a2"'),
    ),
  ],
  ['display-none-self', doc(R('h', 10, 'fill="#22c" display="none"') + R('b', 70, 'fill="#2a2"'))],
  [
    'visibility-hidden',
    doc(
      R('a', 10, 'fill="#c22"') +
        R('h', 50, 'fill="#22c" visibility="hidden"') +
        R('b', 90, 'fill="#2a2"'),
    ),
  ],
  [
    'visibility-collapse',
    doc(R('h', 10, 'fill="#22c" visibility="collapse"') + R('b', 70, 'fill="#2a2"')),
  ],
  [
    'visibility-child-visible',
    doc(
      `<g visibility="hidden">${R('a', 5, 'fill="#c22"')}${R('b', 45, 'fill="#2a2" visibility="visible"')}${R('c', 85, 'fill="#22c"')}</g>`,
    ),
  ],
  [
    'visibility-nested',
    doc(
      `<g visibility="hidden"><g visibility="visible">${R('a', 5, 'fill="#c22"')}${R('d', 45, 'fill="#e80" visibility="hidden"')}</g>${R('c', 85, 'fill="#22c"')}</g>`,
    ),
  ],
  [
    'visibility-stroke',
    doc(
      `<g visibility="hidden"><rect x="20" y="20" width="40" height="40" fill="#c22" stroke="#222" stroke-width="8" visibility="visible"/><rect x="70" y="20" width="40" height="40" fill="#22c" stroke="#222" stroke-width="8"/></g>`,
    ),
  ],
  [
    'display-none-opacity-group',
    doc(
      `<g display="none" opacity=".5">${R('h', 10, 'fill="#22c"')}</g>` +
        R('b', 70, 'fill="#2a2" opacity=".5"'),
    ),
  ],
];
// reveal / width cells: the Mantle side reveals or sets a width, the Chrome side is the document authored with the property removed
const REVEAL = [
  [
    'reveal-numeric-duplicate-owner',
    doc(
      R('a', 5, 'fill="#c22"') +
        R('same', 45, 'fill="#22c" visibility="hidden" pointer-events="painted"') +
        R('same', 85, 'fill="#e80" visibility="hidden" pointer-events="painted"'),
    ),
    doc(
      R('a', 5, 'fill="#c22"') +
        R('same', 45, 'fill="#22c" visibility="hidden" pointer-events="painted"') +
        R('same', 85, 'fill="#2a2"', 'transform="translate(-20 25)"'),
    ),
    [[2, { reveal: true, localPosition: [-20, 25], fill: [2 / 15, 2 / 3, 2 / 15, 1] }]],
  ],
  [
    'reveal-display-none',
    doc(R('a', 10, 'fill="#c22"') + `<g display="none">${R('h', 50, 'fill="#22c"')}</g>`),
    doc(R('a', 10, 'fill="#c22"') + `<g>${R('h', 50, 'fill="#22c"')}</g>`),
    [['h', { reveal: true }]],
  ],
  [
    'reveal-visibility',
    doc(R('a', 10, 'fill="#c22"') + R('h', 50, 'fill="#22c" visibility="hidden"')),
    doc(R('a', 10, 'fill="#c22"') + R('h', 50, 'fill="#22c"')),
    [['h', { reveal: true }]],
  ],
  [
    'reveal-group',
    doc(`<g id="grp" display="none">${R('h', 10, 'fill="#22c"')}${R('i', 60, 'fill="#e80"')}</g>`),
    doc(`<g id="grp">${R('h', 10, 'fill="#22c"')}${R('i', 60, 'fill="#e80"')}</g>`),
    [['grp', { reveal: true }]],
  ],
  [
    'reveal-stroked',
    doc(`<g display="none">${R('h', 20, 'fill="#22c" stroke="#222" stroke-width="8"')}</g>`),
    doc(`<g>${R('h', 20, 'fill="#22c" stroke="#222" stroke-width="8"')}</g>`),
    [
      ['h', { reveal: true }],
      ['h_stroke', { reveal: true }],
    ],
  ],
];
const HID = { keepHidden: true };
const ref = await openChrome8Ref(launchBrowser);
const tol = 8;
try {
  for (const route of ROUTES) {
    for (const [cid, svg] of CELLS)
      for (const [mode, o] of [
        ['default', null],
        ['keepHidden', HID],
      ]) {
        const id = `${cid}@${route}/${mode}`;
        if (!want(cid)) continue;
        const r = await ref.render(svg, { w: W, h: W, route, importOpts: o });
        const s = compare(r.mantle, r.chrome, W, W, { tol, edge: r.chrome }),
          all = compare(r.mantle, r.chrome, W, W, { tol });
        const line = `${id}: mean ${s.mean.toFixed(2)} max ${s.max} over ${s.over}/${s.n}; all-pixel mean ${all.mean.toFixed(2)}`;
        const blank = compare(r.chrome, new Uint8Array(r.chrome.length).fill(255), W, W, {
          tol: 0,
        }).over;
        if (!(s.mean <= 1.5 && s.over <= 30 && all.mean <= 2.5)) fail(line);
        else if (blank < 400) fail(line + ' -- vacuous: the Chrome picture is nearly blank');
        else ok(line);
      }
    if (route !== 'none') continue; // reveal on the Loop-Blinn route is not correct yet (see the header)
    for (const [cid, svg, chromeSvg, sets] of REVEAL) {
      const id = `${cid}@${route}`;
      if (!want(cid)) continue;
      const r = await ref.render(svg, {
        w: W,
        h: W,
        route,
        importOpts: HID,
        chromeSvg,
        overrideSets: sets,
      });
      const s = compare(r.mantle, r.chrome, W, W, { tol, edge: r.chrome }),
        all = compare(r.mantle, r.chrome, W, W, { tol });
      // the same document with no override draws what the browser draws of the original (the hidden thing is not there)
      const bare = await ref.render(svg, { w: W, h: W, route, importOpts: HID });
      const sb = compare(bare.mantle, bare.chrome, W, W, { tol, edge: bare.chrome });
      const blank = compare(r.chrome, new Uint8Array(r.chrome.length).fill(255), W, W, {
        tol: 0,
      }).over;
      const line = `${id}: revealed vs Chrome mean ${s.mean.toFixed(2)} max ${s.max} over ${s.over}/${s.n} all ${all.mean.toFixed(2)}; without the override vs Chrome(original) mean ${sb.mean.toFixed(2)}`;
      // the picture without the override must differ from the revealed one (the cell proves something)
      const differs = compare(r.mantle, bare.mantle, W, W, { tol: 20 }).over;
      if (!(s.mean <= 1.5 && s.over <= 40 && all.mean <= 2.5 && sb.mean <= 1.5)) fail(line);
      else if (blank < 300 || differs < 300)
        fail(line + ` -- vacuous (chrome ink ${blank}, reveal changed ${differs} px)`);
      else ok(line);
    }
  }
} catch (e) {
  fail('chrome cells: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();

// ---- Morph cells ---------------------------------------------------------------------------------------------------------------------------------
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${W}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createShapeMorph, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setViewport(${W}, ${W});
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const read = () => {
  const px = new Uint8Array(${W} * ${W} * 4); gl.readPixels(0, 0, ${W}, ${W}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(px.length);
  for (let y = 0; y < ${W}; y++) for (let x = 0; x < ${W}; x++) {
    const s = ((${W} - 1 - y) * ${W} + x) * 4, d = (y * ${W} + x) * 4, a = px[s + 3]; out[d + 3] = a;
    if (a) for (let k = 0; k < 3; k++) out[d + k] = Math.min(255, Math.round(px[s + k] * 255 / a));
  }
  return b64(out);
};
window.__still = async (svg, opts) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true, ...(opts || {}) })); R.prepareBundle && R.prepareBundle(b);
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const r = read(); b.dispose(); return r;
};
window.__morph = async (from, to, t, kernel, opts) => {
  if (kernel) R.setFillEngine({ route: 'none', kernel, primitives: 'off' }); else R.setFillEngine({ route: 'auto', kernel: 'auto' });
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true, ...(opts || {}) })), B = createBundle(gl, await importSvg(to, { preserveViewport: true, ...(opts || {}) }));
  const m = createShapeMorph(gl, A, B); m.setT(t);
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(m.bundle); R.endFrame(); }
  const r = read(); m.dispose(); A.dispose(); B.dispose(); return r;
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
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const still = async (svg, opts) =>
  u8(await page.evaluate((s, o) => window.__still(s, o), svg, opts || null));
const morph = async (from, to, t, kernel, opts) =>
  u8(
    await page.evaluate(
      (f, g, q, k, o) => window.__morph(f, g, q, k, o),
      from,
      to,
      t,
      kernel || null,
      opts || null,
    ),
  );
const WHITE = await still(doc(''));
try {
  const box = (x, attrs) => `<rect id="s" x="${x}" y="30" width="50" height="50" ${attrs}/>`;
  for (const kernel of [null, 'aac', 'slug'])
    for (const dir of ['from', 'to'])
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        if (kernel && dir === 'to') continue;
        const id = `morph-${dir}-display-none t=${t}${kernel ? ' [' + kernel + ']' : ''}`;
        if (!want('morph')) continue;
        const xa = 10,
          xb = 60,
          x = xa + (xb - xa) * t,
          a = dir === 'from' ? t : 1 - t;
        const hid = (xx, h) => doc(box(xx, `fill="#c22" ${h ? 'display="none"' : ''}`));
        const from = hid(xa, dir === 'from'),
          to = hid(xb, dir !== 'from');
        const got = await morph(from, to, t, kernel, HID);
        const ctl = await still(doc(box(x, `fill="#c22" fill-opacity="${a}"`)));
        const d = maxDiff(got, ctl);
        if (d > 3) fail(`${id}: differs from the authored pose by ${d}`);
        else if (t > 0.2 && t < 0.8 && maxDiff(ctl, WHITE) < 20) fail(`${id}: vacuous`);
        else ok(`${id}: vs authored ${d}`);
      }
} catch (e) {
  fail('morph cells: ' + ((e && e.stack) || e));
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nkeepHiddenRenderSmoke: hidden content draws as the browser draws it, is revealed by overrides and fades in by morphs',
);
