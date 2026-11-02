// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rendererDisposeThenDrawRenderSmoke — a disposed renderer is inert.
// Draw, R.dispose(), then drive the late-frame entries a framework unmount leaves behind (beginFrame/drawBundle/endFrame,
// prepareBundle, createImage): nothing may throw, allocate GL buffers, textures or programs, and createBundleHandle must refuse.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><circle cx="50" cy="50" r="30" fill="#c33" filter="url(#f)"/><path d="M10 10 C60 0 90 40 50 90 Z" fill="#36c"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="128" height="128"></canvas>
<script type="module">
const P = WebGL2RenderingContext.prototype; const made = { buf: 0, tex: 0, prog: 0, vao: 0 };
for (const [mk, k] of [['createBuffer', 'buf'], ['createTexture', 'tex'], ['createProgram', 'prog'], ['createVertexArray', 'vao']]) {
  const a = P[mk]; P[mk] = function () { made[k]++; return a.call(this); };
}
const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const r = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
r.setViewport(128, 128);
const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
const frame = () => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(b, {}); r.endFrame(); };
for (let i = 0; i < 6; i++) { frame(); await new Promise((x) => setTimeout(x, 20)); }
const px = new Uint8Array(4); gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
const out = { drawn: Array.from(px) };
r.dispose(); r.dispose();
const before = { ...made }; out.errors = [];
const t = (n, f) => { try { f(); } catch (e) { out.errors.push(n + ': ' + e.message); } };
t('frame', frame); t('frame2', frame); t('prepare', () => r.prepareBundle(b)); t('image', () => { out.image = r.createImage(document.getElementById('c'), {}); });
try { r.createBundleHandle(b); out.handleThrew = false; } catch { out.handleThrew = true; }
out.allocated = { buf: made.buf - before.buf, tex: made.tex - before.tex, prog: made.prog - before.prog, vao: made.vao - before.vao };
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
let pageErr = 0;
page.on('pageerror', (e) => {
  pageErr++;
  console.error('[page-err]', e.message);
});
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
ok(pageErr === 0, 'no page errors');
ok(
  o.drawn[3] > 0 && o.drawn[0] + o.drawn[1] + o.drawn[2] < 765,
  `the renderer drew before dispose (${o.drawn})`,
);
ok(o.errors.length === 0, `late draw entries do not throw (${o.errors.join('; ')})`);
ok(
  o.allocated.buf === 0 && o.allocated.tex === 0 && o.allocated.prog === 0 && o.allocated.vao === 0,
  `a draw after dispose allocates nothing (${JSON.stringify(o.allocated)})`,
);
ok(o.handleThrew === true, 'createBundleHandle on a disposed renderer throws');
ok(o.image == null, 'createImage on a disposed renderer returns null');
if (fail) {
  console.log('\nRENDERER-DISPOSE-THEN-DRAW FAIL');
  process.exit(1);
}
console.log('\nRENDERER-DISPOSE-THEN-DRAW PASS');
