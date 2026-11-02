// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedLeanFirstSmoke -- `variantFirst: true` draws an INSTANCED bundle with its own specialized (lean) program from the first frame.
//
// The general instanced program is the whole fill shader, and its first draw builds a pipeline whose cold cost runs to seconds on a cold
// Metal cache. With variantFirst (the default) the first instanced draw already uses the bundle's lean program, as a fill draw does;
// variantFirst: false takes the general program first and swaps the lean program in later, in frame slack.
// Holds, on a bundle with only a flat fill (so a lean program omits strokes, gradients, patterns...):
//   (a) variantFirst: false (the opt-out): the first instanced draw runs a program WITHOUT the omission defines (the general one);
//   (b) variantFirst unset (the DEFAULT) and true: the first instanced draw runs a program that compiles those features out (#define MANTLE_NO_STROKE ...);
//   (c) both draw the same picture within rounding (the lean program is a strict subset of the general one for this content).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT =
  process.env.MANTLE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 10 C80 10 90 40 90 55 C90 80 65 92 50 92 C35 92 10 80 10 55 C10 40 20 10 50 10Z" fill="#3060c0"/></svg>';
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="240" height="240"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});
const ST = (s, tx, ty) => new Float32Array([s, 0, 0, 0, s, 0, tx, ty, 1]);
window.__one = async (opts) => {
  const r = createRenderer(gl, shaders, { aacPoints: false, ...opts }); const b = createBundle(gl, sec);
  let first = null;
  const od = gl.drawArraysInstanced.bind(gl);
  gl.drawArraysInstanced = (...a) => {
    if (first === null) { const p = gl.getParameter(gl.CURRENT_PROGRAM); first = gl.getAttachedShaders(p).map((s) => gl.getShaderSource(s)).join('\\n').includes('#define MANTLE_NO_STROKE') ? 'lean' : 'general'; }
    return od(...a);
  };
  r.setViewport(240, 240);
  const inst = [{ worldMatrix: ST(0.45, -0.5, 0.5) }, { worldMatrix: ST(0.45, 0.5, 0.5) }, { worldMatrix: ST(0.45, -0.5, -0.5) }, { worldMatrix: ST(0.45, 0.5, -0.5) }];
  let n = 0;
  // With KHR_parallel_shader_compile a draw never waits for the program's link: the per-instance loop draws until the driver
  // reports the instanced program complete, and the first INSTANCED draw is the first to use it.
  for (let i = 0; i < 600; i++) {
    r.beginFrame([0, 0, 0, 1]); n = r.drawBundleInstanced(b, inst, {}); r.endFrame();
    if (first !== null) break;
    await new Promise((q) => setTimeout(q, 25));
  }
  const px = new Uint8Array(240 * 240 * 4); gl.readPixels(0, 0, 240, 240, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.drawArraysInstanced = od;
  r.dispose && r.dispose();
  return { first, n, px: Array.from(px) };
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
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
const br = await launchBrowser({
  headless: 'new',
  protocolTimeout: 600000,
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const pg = await br.newPage();
let fail = 0;
pg.on('pageerror', (e) => {
  console.error('FAIL page', e.message);
  fail++;
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 20000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
const a = await pg.evaluate(() => window.__one({ variantFirst: false }));
const b = await pg.evaluate(() => window.__one({ variantFirst: true }));
const d = await pg.evaluate(() => window.__one({}));
await br.close();
server.close();
console.log(JSON.stringify({ a: a.first, b: b.first, n: [a.n, b.n] }));
if (a.first !== 'general') {
  console.error(
    `FAIL (a): variantFirst false drew its first instanced draw with the ${a.first} program`,
  );
  fail++;
}
if (b.first !== 'lean') {
  console.error(
    `FAIL (b): variantFirst: true drew its first instanced draw with the ${b.first} program`,
  );
  fail++;
}
if (d.first !== 'lean') {
  console.error(`FAIL (b'): the DEFAULT drew its first instanced draw with the ${d.first} program`);
  fail++;
}
let mx = 0;
for (let i = 0; i < a.px.length; i++) mx = Math.max(mx, Math.abs(a.px[i] - b.px[i]));
if (mx > 3) {
  console.error(`FAIL (c): lean and general instanced pictures differ by ${mx}/255`);
  fail++;
}
if (fail) process.exit(1);
console.log('INSTANCED-LEAN-FIRST PASS');
