// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// linkRetryRenderSmoke -- on the GPU: a program that really fails to link is not linked again in play, is linked by the next loading call, and the bundle then draws what a healthy renderer draws.
//
// The failure is staged at the source, so the driver is the one that refuses: while it is down, a fragment shader with the AAC kernel carries an #error. CPU counterpart, with each policy and window: linkRetryWindowSmoke.
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
const cap = capWallTime('linkRetryRenderSmoke', stop);
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
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>`;
    const sec = await api.importSvg(svg, { preserveViewport: true });
    const size = 512,
      sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const context = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const gl = c.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
      if (!gl) throw Error('WebGL2 required');
      return gl;
    };
    const read = (gl) => {
      const p = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    const cmp = (a, c) => {
      let n = 0,
        max = 0,
        ink = 0;
      for (let i = 0; i < a.length; i += 4) {
        let m = 0;
        for (let j = 0; j < 4; j++) m = Math.max(m, Math.abs(a[i + j] - c[i + j]));
        if (m) n++;
        max = Math.max(max, m);
        if (a[i] !== 255) ink++;
      }
      return { n, max, ink };
    };
    const O = {
      asyncShaderCompile: true,
      nonBlocking: true,
      strictPlay: true,
      standIns: false,
      aacPoints: false,
    };
    const refGl = context();
    const ref = await (async () => {
      const R = api.createRenderer(refGl, shaders, O);
      await R.ready;
      R.setFillEngine({ route: 'none', kernel: 'aac' });
      R.setViewport(size, size);
      const b = api.createBundle(refGl, sec);
      await R.precompileFillsAsync({});
      for (let i = 0; i < 10; i++) {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundle(b);
        R.endFrame();
        await sleep(8);
      }
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      const p = read(refGl);
      R.dispose();
      return p;
    })();
    const gl = context();
    let down = true,
      links = 0;
    const ss = gl.shaderSource.bind(gl);
    gl.shaderSource = (s, t) =>
      ss(
        s,
        down && /#define MANTLE_AAC\b/.test(t) && /gl_FragCoord|out\s+vec4/.test(t)
          ? t + '\n#error staged link failure\n'
          : t,
      );
    const lp = gl.linkProgram.bind(gl);
    gl.linkProgram = (p) => {
      links++;
      lp(p);
    };
    const errs = console.error;
    console.error = () => {};
    const R = api.createRenderer(gl, shaders, O);
    await R.ready;
    R.setFillEngine({ route: 'none', kernel: 'aac' });
    R.setViewport(size, size);
    const b = api.createBundle(gl, sec);
    const out = {};
    await R.precompileFillsAsync({});
    const frames = async (n) => {
      for (let i = 0; i < n; i++) {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundle(b);
        R.endFrame();
        await sleep(8);
      }
    };
    await frames(4);
    out.failedAtLoad = R.debugStats.linkFailedKeys;
    let m = links;
    await frames(30);
    out.linksInPlayDown = links - m;
    m = links;
    await R.precompileFillsAsync({});
    out.linksLoadingDown = links - m;
    out.failedAfterRetry = R.debugStats.linkFailedKeys;
    out.incomplete = !!R.debugStats.coopLoad.incomplete;
    down = false;
    m = links;
    await frames(30);
    out.linksInPlayUp = links - m;
    m = links;
    await R.precompileFillsAsync({});
    out.linksLoadingUp = links - m;
    out.failedAfterUp = R.debugStats.linkFailedKeys;
    m = links;
    const b0 = R.debugStats.needMiss.blocked | 0;
    await frames(20);
    out.linksAfter = links - m;
    out.blockedAfter = (R.debugStats.needMiss.blocked | 0) - b0;
    out.key = (R.debugStats.drawnFillVariantKey || '').includes('MANTLE_AAC');
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    out.diff = cmp(ref, read(gl));
    out.err = gl.getError();
    console.error = errs;
    R.dispose();
    return out;
  });
  console.log(JSON.stringify(rows));
  ok(rows.failedAtLoad > 0, `the premise: the driver refused (${rows.failedAtLoad} keys failed)`);
  ok(
    rows.linksInPlayDown === 0,
    `30 frames link nothing while it refuses (${rows.linksInPlayDown})`,
  );
  ok(
    rows.linksLoadingDown > 0 && rows.failedAfterRetry > 0,
    `a loading call tries again and it stays failed (${rows.linksLoadingDown} links, ${rows.failedAfterRetry} keys)`,
  );
  ok(!rows.incomplete, 'that loading call ended by itself, not at its deadline');
  ok(
    rows.linksInPlayUp === 0,
    `the driver would accept now, and 30 frames still link nothing (${rows.linksInPlayUp})`,
  );
  ok(
    rows.linksLoadingUp > 0 && rows.failedAfterUp === 0,
    `the next loading call links it (${rows.linksLoadingUp} links, ${rows.failedAfterUp} keys left)`,
  );
  ok(
    rows.linksAfter === 0 && rows.blockedAfter === 0,
    `play links and blocks on nothing (${rows.linksAfter} links, ${rows.blockedAfter} blocked)`,
  );
  ok(rows.key, 'the frames draw on the AAC key');
  ok(
    rows.diff.ink > 0 && rows.diff.max <= 1,
    `the picture a healthy renderer draws (${rows.diff.n} px differ, max ${rows.diff.max}/255, ${rows.diff.ink} px of ink)`,
  );
  ok(rows.err === 0, `no GL error (${rows.err})`);
} catch (e) {
  console.error(e);
  fail++;
} finally {
  clearTimeout(cap);
  await stop();
}
console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
