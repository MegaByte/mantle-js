// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedRaisedStrokeRenderSmoke -- a fill-only bundle drawn instanced under a shared override table that gives a row a stroke paints that stroke, as a drawBundle of each copy does.
// The instanced program compiles out what the bundle's own rows do not use, stroke included, so it must count what the table raises: otherwise
// the stroke the table raises is silently lost.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const f = path.resolve(root, '.' + decodeURIComponent(u.pathname));
  if (!f.startsWith(root + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
};
const cap = capWallTime('instancedRaisedStrokeRenderSmoke', stop);
console.log(gpuThrottleBanner());
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await installGpuThrottle(page);
  const rows = await page.evaluate(async () => {
    const api = await import('/src/index.js');
    const shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="a" d="M20 20 C60 10 90 40 80 80 L25 70Z" fill="#c33"/></svg>`;
    const sec = await api.importSvg(svg, { preserveViewport: true });
    const size = 384,
      canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw Error('WebGL2 required');
    const read = () => {
      const p = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    for (const opts of [
      { aacPoints: false },
      { aacPoints: false, standIns: false, asyncShaderCompile: true, nonBlocking: true },
    ]) {
      const R = api.createRenderer(gl, shaders, opts);
      await R.ready;
      R.setViewport(size, size);
      const b = api.createBundle(gl, sec);
      await R.precompileFillsAsync({});
      const t = api.createOverrideTable(gl, b);
      t.set(0, { stroke: [0, 0, 1, 1], strokeWidth: 6 });
      const L = [
        new Float32Array([0.5, 0, 0, 0, 0.5, 0, -0.5, 0, 1]),
        new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0.5, 0, 1]),
      ];
      const drawA = () => {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundle(b, { overrides: t, worldMatrix: L[0] });
        R.drawBundle(b, { overrides: t, worldMatrix: L[1] });
        R.endFrame();
      };
      const drawB = () => {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundleInstanced(
          b,
          L.map((worldMatrix) => ({ worldMatrix })),
          { overrides: t },
        );
        R.endFrame();
      };
      let pa, pb;
      for (let i = 0; i < 40; i++) {
        drawA();
        await sleep(10);
        drawB();
        await sleep(10);
      }
      gl.finish();
      drawA();
      pa = read();
      drawB();
      pb = read();
      let diff = 0,
        max = 0,
        blueA = 0,
        blueB = 0;
      for (let i = 0; i < pa.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(pa[i + k] - pb[i + k]));
        if (m > 8) diff++;
        max = Math.max(max, m);
        if (pa[i + 2] > 200 && pa[i] < 60) blueA++;
        if (pb[i + 2] > 200 && pb[i] < 60) blueB++;
      }
      out.push({ opts: JSON.stringify(opts), diff, max, blueA, blueB, err: gl.getError() });
      R.dispose();
    }
    return out;
  });
  for (const r of rows) {
    console.log(JSON.stringify(r));
    ok(r.blueA > 200, `drawBundle paints the raised stroke (${r.blueA} stroke px)`);
    ok(
      r.blueB >= r.blueA * 0.95 && r.blueB <= r.blueA * 1.05,
      `the instanced draw paints it too (${r.blueB} stroke px)`,
    );
    ok(
      r.diff < r.blueA * 0.02,
      `the two pictures agree (${r.diff} px differ by more than 8/255, max ${r.max})`,
    );
    ok(r.err === 0, `no GL error (${r.err})`);
  }
} catch (e) {
  console.error(e);
  fail++;
} finally {
  clearTimeout(cap);
  await stop();
}
console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
