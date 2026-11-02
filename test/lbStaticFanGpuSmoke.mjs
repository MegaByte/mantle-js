// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A simple convex translucent contour's interior is a fan from the vertex mean, so every face keeps a complete
// boundary edge. A diagonal triangulation leaves faces whose only boundary is an internal chord, and the resolver
// ramps off that chord (15.6 and 36 channel bytes of error against raw AAC on these two fixtures at 128 px).
// Actual GPU draws: LB (pinned, awaited) against raw AAC cover quads, complete images, alpha channel.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(readFileSync(path.join(root, 'test/fixtures/lb-static-fan.json'), 'utf8'));
const server = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const f = path.resolve(root, '.' + decodeURIComponent(u.pathname));
  if (!f.startsWith(root + path.sep) || f.includes('/generated/')) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', /\.m?js$/.test(f) ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  server.close();
};
const cap = capWallTime('lbStaticFan', stop, 120000);
console.log(gpuThrottleBanner());
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  for (const c of fx.cases) {
    const r = await page.evaluate(async (c) => {
      const api = await import('/src/index.js'),
        shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
      (await import('/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
      const N = c.size,
        out = {};
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${c.body}<rect x="0" y="0" width="1" height="1" fill="#fff" fill-opacity="0.01"/><rect x="127" y="127" width="1" height="1" fill="#fff" fill-opacity="0.01"/></svg>`;
      for (const arm of ['lb', 'aac']) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = N;
        const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (/swiftshader|llvmpipe|software/i.test(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)))
          throw Error('Physical GPU required');
        const bundle = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true }));
        const rr = api.createRenderer(gl, shaders, { aacFill: true, aacPoints: false });
        if (arm === 'lb') rr.setFillEngine({ route: 'lb' });
        else rr.setFillEngine({ route: 'none', kernel: 'aac' });
        rr.setViewport(N, N);
        if (arm === 'lb' && !(await rr.awaitEngine(bundle, 'lb', 20000)))
          throw Error('LB not ready');
        let px;
        for (let i = 0; i < 3; i++) {
          rr.beginFrame([0, 0, 0, 0]);
          rr.drawBundle(bundle, {});
          rr.endFrame();
          if (!(await window.__gpuFence(gl, 30000))) throw Error('fence');
          px = new Uint8Array(N * N * 4);
          gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
          await window.__gpuIdle(2);
        }
        assert_(!gl.getError(), 'GL error');
        out[arm] = { px: Array.from(px), draws: rr.debugStats.engines.draws };
        bundle.dispose();
        rr.dispose();
        gl.getExtension('WEBGL_lose_context').loseContext();
      }
      function assert_(ok, m) {
        if (!ok) throw Error(m);
      }
      return out;
    }, c);
    assert(r.lb.draws.lb > 0, c.name + ': drawn by LB, ' + JSON.stringify(r.lb.draws));
    assert(r.aac.draws.aac > 0, c.name + ': AAC reference drawn, ' + JSON.stringify(r.aac.draws));
    let worst = 0;
    for (let i = 0; i < r.lb.px.length; i++)
      worst = Math.max(worst, Math.abs(r.lb.px[i] - r.aac.px[i]));
    console.log(`  ${c.name}: LB vs AAC worst channel byte ${worst}`);
    assert(
      worst <= fx.maxByte,
      `${c.name}: LB differs from raw AAC by ${worst} bytes (> ${fx.maxByte})`,
    );
  }
  console.log('lbStaticFanGpuSmoke PASS');
} finally {
  cap.clear();
  await stop();
}
