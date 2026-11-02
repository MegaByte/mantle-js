// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedFlatTintAlphaRenderSmoke -- one instanced run of the same one-circle bundle, every instance recolored to a flat tint
// (colorMatrix = zero 4x4 but m[15] = 1, colorMatrixOffset = (r, g, b, 0)) and faded by the same alpha, paints every instance alike.
//
// In a ring of 12 such instances no instance may come out at a different opacity from the others (an alpha-1 run is the uniform
// control). Each cell draws the ring through drawBundleInstanced and samples every instance's center; all centers
// must agree within 2/255 per channel and equal the same instance drawn on its own through drawBundle (the per-draw reference).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#ffffff"/></svg>';
const W = 256;
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${W}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const W = ${W};
// 12 instances on a ring (clip space), each a 0.16-wide copy of the bundle
const ring = (n) => Array.from({ length: n }, (_, i) => {
  const a = Math.PI / 2 - i * 2 * Math.PI / n, s = 0.16, cx = 0.7 * Math.cos(a), cy = 0.7 * Math.sin(a);
  return { cx, cy, m: new Float32Array([s, 0, 0, 0, s, 0, cx, cy, 1]) };
});
const flat = (r, g, b) => { const cm = new Float32Array(16); cm[15] = 1; return { colorMatrix: cm, colorMatrixOffset: new Float32Array([r, g, b, 0]) }; };
const px = (cx, cy) => { const b = new Uint8Array(4); const x = Math.round((cx + 1) / 2 * W), y = Math.round((cy + 1) / 2 * W); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return Array.from(b); };
window.__run = async (route, alpha, n, mode) => {
  R.setViewport(W, W);
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(${JSON.stringify(CIRCLE)}, { preserveViewport: true }));
  const pos = ring(n);
  const insts = pos.map((p) => ({ worldMatrix: p.m, alpha, ...flat(0.8, 0.8, 0.8) }));
  const drawInst = () => { R.beginFrame([0.05, 0.33, 0.4, 1]); R.drawBundleInstanced(b, insts, {}); R.endFrame(); };
  const drawSeq = () => { R.beginFrame([0.05, 0.33, 0.4, 1]); for (const it of insts) R.drawBundle(b, it); R.endFrame(); };
  const draw = mode === 'seq' ? drawSeq : drawInst;
  const warm = await R.warmScene([{ draw }], { maxPasses: 16, fenceTimeoutMs: 60000 });
  if (!warm.complete) throw new Error('Scene warming incomplete');
  draw(); draw();
  const out = pos.map((p) => px(p.cx, p.cy));
  b.dispose();
  return out;
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
const actualDevice = await page.evaluate(() => {
  const gl = document.getElementById('c').getContext('webgl2');
  return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
});
if (
  process.env.MANTLE_TEST_GL === 'metal' &&
  (!/Metal/.test(actualDevice) || /SwiftShader/.test(actualDevice))
)
  throw new Error('Physical Metal required: ' + actualDevice);
console.log('ACTUAL_DEVICE ' + actualDevice);
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const d = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
for (const route of ['auto', 'none'])
  for (const alpha of [1, 0.35, 0.6])
    for (const n of [12, 7]) {
      const tag = `ring of ${n}, flat tint, alpha ${alpha} [${route}]`;
      let inst, seq;
      try {
        inst = await page.evaluate((r, a, k) => window.__run(r, a, k, 'inst'), route, alpha, n);
        seq = await page.evaluate((r, a, k) => window.__run(r, a, k, 'seq'), route, alpha, n);
      } catch (e) {
        fail(tag + ': ' + e.message);
        continue;
      }
      const ref = seq[0];
      const bad = inst.map((p, i) => [i, p]).filter(([, p]) => d(p, ref) > 2);
      const seqBad = seq.filter((p) => d(p, ref) > 2).length;
      if (seqBad)
        fail(tag + ': the per-draw reference itself is not uniform: ' + JSON.stringify(seq));
      else if (bad.length)
        fail(
          tag +
            `: instances ${bad.map(([i]) => i).join(',')} differ from the per-draw reference ${ref}: ` +
            bad.map(([i, p]) => `#${i}=[${p}]`).join(' '),
        );
      else ok(tag + `: all ${n} centres = [${ref}]`);
    }
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ninstancedFlatTintAlphaRenderSmoke: flat-tinted faded instances paint alike');
