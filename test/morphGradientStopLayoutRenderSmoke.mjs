// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphGradientStopLayoutRenderSmoke -- on the GPU, a matched shape whose two gradients pack their stops one texel and two texels per stop
// tweens its stop COLORS (morphGradientStopLayoutSmoke is the plan-level proof; this draws it). A stop tween planned only for equal signed
// counts would hold red->blue at t = 0.5 when red->blue morphs to green->yellow (a translucent stop on the destination).
// The expected pixel is the mean of the two poses' stops, composed over transparent black (premultiplied readback).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const svg = (stops) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs><rect id="r" x="0" y="0" width="100" height="100" fill="url(#g)"/></svg>`;
const A = svg('<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>');
const B = svg(
  '<stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ffff00" stop-opacity="0.5"/>',
);
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="100" height="100"></canvas><script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const backend = gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); await renderer.ready; renderer.setViewport(100, 100);
const a = createBundle(gl, await importSvg(${JSON.stringify(A)})), b = createBundle(gl, await importSvg(${JSON.stringify(B)}));
const morph = createShapeMorph(gl, a, b);
window.__px = (t, xs) => {
  morph.setT(t);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.beginFrame([0, 0, 0, 0]); renderer.drawBundle(morph); renderer.endFrame();
  return xs.map((x) => { const u = new Uint8Array(4); gl.readPixels(x, 50, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, u); return Array.from(u); });
};
window.__backend = backend;
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  try {
    const buf = readFileSync(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {
      'content-type': req.url.endsWith('.glsl') ? 'text/plain' : 'text/javascript; charset=utf-8',
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let failures = 0;
const ok = (m) => console.log('ok ' + m),
  fail = (m) => {
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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });
// pose colors as premultiplied bytes at u (the stops are at 0 and 1): rgb straight lerp, alpha lerp
const pose = (c0, c1, a1, u) => {
  const a = 1 + (a1 - 1) * u;
  return [0, 1, 2].map((k) => (c0[k] + (c1[k] - c0[k]) * u) * a).concat(a * 255);
};
const xs = [10, 50, 90],
  us = xs.map((x) => (x + 0.5) / 100);
for (const t of [0, 0.5, 1]) {
  const got = await page.evaluate((tt, pts) => window.__px(tt, pts), t, xs);
  got.forEach((g, i) => {
    const u = us[i];
    // the morph lerps the stops (bytes) and the axis stays 0..1: color(u) = lerp over the lerped stops
    const s0 = [255 * (1 - t) + 0 * t, 0 * (1 - t) + 255 * t, 0],
      s1 = [0 * (1 - t) + 255 * t, 0 * (1 - t) + 255 * t, 255 * (1 - t) + 0 * t],
      a1 = 1 * (1 - t) + 0.5 * t;
    const want = pose(s0, s1, a1, u);
    const worst = Math.max(...g.map((v, k) => Math.abs(v - want[k])));
    if (worst <= 4)
      ok(
        `t=${t} x=${xs[i]}: [${g}] within ${worst.toFixed(1)} of [${want.map((v) => v.toFixed(0))}]`,
      );
    else
      fail(
        `t=${t} x=${xs[i]}: [${g}] expected [${want.map((v) => v.toFixed(0))}] (worst ${worst.toFixed(1)})`,
      );
  });
}
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nmorphGradientStopLayoutRenderSmoke: all ok');
process.exit(failures ? 1 : 0);
