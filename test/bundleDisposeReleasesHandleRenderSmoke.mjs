// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Bundle disposal releases its transient handle and cached filter results.
// Renderer-wide pools remain alive and must reach the same baseline after
// identical bundles, including bundles evicted from the transient handle cache.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><circle cx="50" cy="50" r="30" fill="#c33" filter="url(#f)"/><path d="M10 10 C60 0 90 40 50 90 Z" fill="#36c"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="128" height="128"></canvas>
<script type="module">
const P = WebGL2RenderingContext.prototype; const live = { buf: new Set(), tex: new Set() };
let nativeDraws = 0;
for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const draw = P[name]; P[name] = function (...args) { nativeDraws++; return draw.apply(this, args); };
}
for (const [mk, rm, set] of [['createBuffer', 'deleteBuffer', 'buf'], ['createTexture', 'deleteTexture', 'tex']]) {
  const a = P[mk], d = P[rm]; P[mk] = function () { const o = a.call(this); live[set].add(o); return o; }; P[rm] = function (o) { live[set].delete(o); return d.call(this, o); };
}
const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const r = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
await r.ready;
r.setViewport(128, 128);
const sections = await importSvg(${JSON.stringify(SVG)});
const frames = async (b) => {
  const draw = () => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(b, {}); r.endFrame(); };
  r.prepareBundle(b);
  const warm = await r.warmScene([{ draw }], { maxPasses: 128, readyTimeoutMs: 120000, fenceTimeoutMs: 60000 });
  if (!warm.complete) throw Error('Bundle draw state did not finish warming');
  const before = nativeDraws;
  draw();
  const pixels = new Uint8Array(128 * 128 * 4);
  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  if (nativeDraws === before || !pixels.some((v, i) => i % 4 !== 3 && v < 240) || gl.getError()) {
    throw Error('Expected a nonblank bundle draw without GL errors');
  }
};
const snap = () => ({ buf: live.buf.size, tex: live.tex.size });
const out = {};
const a = createBundle(gl, sections); await frames(a); out.withA = snap();
a.dispose(); out.afterA = snap();
const b = createBundle(gl, sections); await frames(b); out.withB = snap();
b.dispose(); out.afterB = snap();
// Disposing bundles evicted from the eight-handle cache must also purge their filter results.
const many = []; for (let i = 0; i < 14; i++) { const m = createBundle(gl, sections); await frames(m); many.push(m); }
out.withMany = snap();
for (const m of many) m.dispose();
out.afterMany = snap();
window.__out = out; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
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
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
console.log(JSON.stringify(o));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
ok(
  o.afterA.buf < o.withA.buf,
  `dispose frees the handle's buffers (${o.withA.buf} -> ${o.afterA.buf})`,
);
ok(
  o.afterA.tex < o.withA.tex,
  `dispose frees the handle's textures (${o.withA.tex} -> ${o.afterA.tex})`,
);
ok(
  o.afterB.buf === o.afterA.buf && o.afterB.tex === o.afterA.tex,
  `a second identical bundle ends on the same live counts (${JSON.stringify(o.afterA)} vs ${JSON.stringify(o.afterB)})`,
);
ok(
  o.afterMany.tex - o.afterB.tex < 7 && o.afterMany.buf - o.afterB.buf < 7,
  `14 aged-out filtered bundles disposed leave no per-bundle residue (${JSON.stringify(o.withMany)} -> ${JSON.stringify(o.afterMany)}, baseline ${JSON.stringify(o.afterB)})`,
);
if (fail) {
  console.log('\nBUNDLE-DISPOSE-HANDLE FAIL');
  process.exit(1);
}
console.log('\nBUNDLE-DISPOSE-HANDLE PASS');
