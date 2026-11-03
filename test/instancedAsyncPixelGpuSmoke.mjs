// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { installGpuThrottle } from './_gpuThrottle.mjs';
// instancedAsyncPixelGpuSmoke -- the frame drawn while an instanced specialization is still linking is the frame the
// specialized program draws.
//
// With KHR_parallel_shader_compile the instanced path starts the bundle's lean program and draws with a finished stand-in
// (the base instanced program) or the per-instance loop until the driver reports it complete. This renders one bundle at
// five transforms on the physical GPU in fresh contexts and compares:
//   spec    -- frames drawn after the lean program completed and drew (twice, the A/A control: fresh programs differ by
//              at most one byte between contexts, so every other comparison is read against it);
//   first   -- the very first instanced frame after the loading call, while the lean program links (twice);
//   loop    -- the per-instance loop alone (instanced fast path off).
// The first frame must equal the specialized frame to within the A/A spread, and must not have waited for the link.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 10 C80 10 90 40 90 55 C90 80 65 92 50 92 C35 92 10 80 10 55 C10 40 20 10 50 10Z" fill="#3060c0"/><circle cx="50" cy="52" r="18" fill="#e0b030"/></svg>';
const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sections = await importSvg(${JSON.stringify(SVG)});
const W = 240, H = 240;
const ST = (s, tx, ty) => new Float32Array([s, 0, 0, 0, s, 0, tx, ty, 1]);
const INST = [ST(0.45, -0.5, 0.5), ST(0.45, 0.5, 0.5), ST(0.45, -0.5, -0.5), ST(0.45, 0.5, -0.5), ST(0.3, 0, 0)].map((m) => ({ worldMatrix: m }));
async function arm(kind) {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
  const R = createRenderer(gl, shaders, { aacPoints: false }); if (R.ready) await R.ready;
  const b = createBundle(gl, sections);
  R.setViewport(W, H); gl.viewport(0, 0, W, H);
  // The loading call starts the instanced program for the 'spec' arms; the 'first' arms see a program nothing has started, so their first
  // frames are the real fallback while it links.
  if (kind === 'loop' || kind.startsWith('first')) R._setInstancedFast(false);
  R.prewarmBundle(b); R.precompileFills();
  if (kind.startsWith('first')) R._setInstancedFast(true);
  const frame = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundleInstanced(b, INST); R.endFrame(); };
  const read = () => { const p = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p); return Array.from(p); };
  const out = { kind };
  const fast0 = R.debugStats.instancedFastCount | 0;
  const t0 = performance.now(); frame(); out.firstMs = performance.now() - t0;
  out.firstInstanced = (R.debugStats.instancedFastCount | 0) - fast0;
  if (kind === 'first' || kind === 'first2' || kind === 'loop') { out.px = read(); }
  if (kind === 'spec' || kind === 'spec2') {
    // Keep drawing until the lean program has linked in the background and a frame draws with it.
    for (let i = 0; i < 1500 && !(R.debugStats.instancedFastCount > fast0); i++) { await new Promise((q) => setTimeout(q, 40)); frame(); }
    for (let i = 0; i < 20; i++) { await new Promise((q) => setTimeout(q, 40)); frame(); }
    out.px = read(); out.frames = (R.debugStats.instancedFastCount | 0) - fast0;
  }
  R.dispose(); canvas.remove();
  return out;
}
const res = {};
for (const k of ['spec', 'first', 'loop', 'spec2', 'first2']) res[k] = await arm(k);
window.__r = res; window.__ready = true;
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
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await installGpuThrottle(page);
  await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
  const r = await page.evaluate(() => window.__r);
  const diff = (a, b) => {
    let max = 0,
      n = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > 0) n++;
      if (d > max) max = d;
    }
    return { max, n };
  };
  const aa = diff(r.spec.px, r.spec2.px),
    aaFirst = diff(r.first.px, r.first2.px);
  const spread = Math.max(aa.max, aaFirst.max, 1);
  const rows = {
    'first vs spec': diff(r.first.px, r.spec.px),
    'first2 vs spec2': diff(r.first2.px, r.spec2.px),
    'loop vs spec': diff(r.loop.px, r.spec.px),
    'first vs first2': aaFirst,
    'spec vs spec2 (A/A)': aa,
  };
  for (const [k, v] of Object.entries(rows))
    console.log(`  ${k}: max byte diff ${v.max}, ${v.n} bytes differ`);
  console.log(
    `  first frame: ${r.first.firstMs.toFixed(1)} ms (instanced draws ${r.first.firstInstanced}, the fallback loop drew it when 0); specialized frames ${r.spec.frames}`,
  );
  const covered = r.spec.px.some((v, i) => i % 4 === 3 && v > 0);
  if (!covered) fail('the specialized frame is blank: the case proves nothing');
  if (!(r.spec.frames > 0)) fail('the instanced fast path never ran on the specialized arm');
  for (const k of ['first vs spec', 'first2 vs spec2', 'loop vs spec'])
    if (rows[k].max > spread) fail(`${k}: ${rows[k].max} exceeds the A/A spread ${spread}`);
  if (rows['first vs spec'].max <= spread && rows['loop vs spec'].max <= spread)
    console.log(
      `ok the fallback frames equal the specialized frame within the A/A spread (${spread})`,
    );
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ninstancedAsyncPixelGpuSmoke: the fallback frame is the specialized frame');
