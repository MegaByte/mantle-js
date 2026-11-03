// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// droppedContentRenderSmoke -- invisible-at-import content, drawn on the GPU, against the authored pose (no Chrome needed: the control is the same
// picture authored directly).
//   * a morph from / to a pose whose fill or stroke has alpha 0 draws the interpolated picture at t (a baked draw list that skips the row
//     would draw nothing at all from an alpha-0 pose, since a morph's list is baked from the source pose);
//   * an override that gives an alpha-0 row a color draws it (its row is in the draw list);
//   * with nothing asking for it, an alpha-0 row draws nothing.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 128;
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
const rect = (x, attrs) => `<rect id="a" x="${x}" y="30" width="50" height="50" ${attrs}/>`;
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${W}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createShapeMorph, createOverrideTable, loadShaders } from '/src/index.js';
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
const frames = (bundle) => { for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(bundle); R.endFrame(); } };
window.__still = async (svg, ov, opts) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true, ...(opts || {}) })); R.prepareBundle && R.prepareBundle(b);
  let t = null, resolved = null;
  if (ov) { t = createOverrideTable(gl, b); resolved = ov.map(([k, o]) => t.set(k, o)); }
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, t ? { overrides: t } : undefined); R.endFrame(); }
  const r = read(); b.dispose(); return { px: r, resolved };
};
window.__morph = async (from, to, t, kernel) => {
  if (kernel) R.setFillEngine({ route: 'none', kernel, primitives: 'off' }); else R.setFillEngine({ route: 'auto', kernel: 'auto' });
  const A = createBundle(gl, await importSvg(from, { preserveViewport: true })), B = createBundle(gl, await importSvg(to, { preserveViewport: true }));
  const m = createShapeMorph(gl, A, B); m.setT(t);
  frames(m.bundle); const r = read(); m.dispose(); A.dispose(); B.dispose(); return r;
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
const still = async (svg, ov, opts) => {
  const r = await page.evaluate(
    (s, o, p) => window.__still(s, o, p),
    svg,
    ov || null,
    opts || null,
  );
  return { px: u8(r.px), resolved: r.resolved };
};
const WHITE = u8(
  await page.evaluate(() =>
    window
      .__still('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"/>')
      .then((r) => r.px),
  ),
);
const KERNELS = [null, 'aac', 'slug'];
// 1. morphs: the interpolated picture at t is the authored one (geometry lerped by hand, the invisible paint's opacity lerped 0 -> 1).
const CASES = [
  ['fill-opacity 0 -> 1', (x, a) => rect(x, `fill="#ff0000" fill-opacity="${a}"`)],
  [
    'stroke-opacity 0 -> 1',
    (x, a) => rect(x, `fill="none" stroke="#0000ff" stroke-width="12" stroke-opacity="${a}"`),
  ],
  ['opacity 0 -> 1', (x, a) => rect(x, `fill="#ff0000" opacity="${a}"`)],
];
for (const kernel of KERNELS)
  for (const [name, mk] of CASES)
    for (const t of [0, 0.25, 0.5, 0.75, 1])
      for (const dir of ['from', 'to']) {
        if (kernel && dir === 'to') continue;
        const xa = 10,
          xb = 60,
          x = xa + (xb - xa) * t,
          a = dir === 'from' ? t : 1 - t; // 'to': the invisible pose is the destination
        const label = `${name} ${dir} at t=${t}${kernel ? ' [' + kernel + ']' : ''}`;
        try {
          const from = doc(mk(xa, dir === 'from' ? 0 : 1)),
            to = doc(mk(xb, dir === 'from' ? 1 : 0));
          const got = u8(
            await page.evaluate(
              (f, g, k, q, kk) => window.__morph(f, g, q, kk),
              from,
              to,
              null,
              t,
              kernel,
            ),
          );
          const want = (await still(doc(mk(x, a)))).px;
          const d = maxDiff(got, want);
          if (d > 3) fail(`${label}: the morph differs from the authored pose by ${d}`);
          else if (t > 0.2 && t < 0.8 && maxDiff(want, WHITE) < 20)
            fail(`${label}: vacuous (the control is blank)`);
          else ok(`${label}: vs authored ${d}`);
        } catch (e) {
          fail(label + ': ' + e.message);
        }
      }
// 2. overrides: an alpha-0 row given a color draws it; with nothing given it draws nothing.
for (const [name, svg, ov, want] of [
  [
    'fill-opacity 0, absolute fill',
    rect(10, 'fill="#ff0000" fill-opacity="0"'),
    [['a', { fill: [0, 0.6, 0, 1] }]],
    rect(10, 'fill="#009900"'),
  ],
  [
    'fill transparent, absolute fill',
    rect(10, 'fill="transparent"'),
    [['a', { fill: [0, 0, 1, 1] }]],
    rect(10, 'fill="#0000ff"'),
  ],
  [
    'stroke-opacity 0, absolute stroke',
    rect(10, 'fill="none" stroke="#0000ff" stroke-width="12" stroke-opacity="0"'),
    [['a_stroke', { stroke: [1, 0, 0, 1] }]],
    rect(10, 'fill="none" stroke="#ff0000" stroke-width="12"'),
  ],
]) {
  try {
    const bare = await still(doc(svg)),
      got = await still(doc(svg), ov),
      ctl = await still(doc(want));
    const d = maxDiff(got.px, ctl.px);
    if (!got.resolved.every(Boolean)) fail(`${name}: the key did not resolve`);
    else if (maxDiff(bare.px, WHITE) > 1) fail(`${name}: the row draws something with no override`);
    else if (d > 3) fail(`${name}: the override differs from the authored picture by ${d}`);
    else ok(`${name}: vs authored ${d}; blank without the override`);
  } catch (e) {
    fail(name + ': ' + e.message);
  }
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ndroppedContentRenderSmoke: invisible content morphs and recolors as its authored pose',
);
