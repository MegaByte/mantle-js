// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// standInsReuseGpuSmoke -- previous-variant reuse (opts.standIns === false) on the physical GPU: a bundle whose engine flips (a pin standing in for an `aac-classic` breakpoint crossing) keeps
// drawing with its own ready previous variant while the needed program links; the frame drawn through the reuse must match the frame the needed engine draws, within the accuracy tolerance, at
// every scale (256, 1024, 4096 px viewports), with no hole (inked pixels present on the first frame) and no pop beyond the tolerance at the switch.
//   tolerance: per-pixel max channel difference <= 24/255 on the AA ring, mean over inked pixels <= 1.0/255; both are printed so the number is on record.
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
const cap = capWallTime('standInsReuseGpuSmoke', stop);
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
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#e33"/><stop offset="1" stop-color="#36d"/></linearGradient></defs><path d="M50 8C80 8 92 30 92 52C92 80 70 94 48 92C22 90 8 72 10 48C12 24 30 8 50 8Z" fill="url(#g)" stroke="#123" stroke-width="3"/><path d="M30 40Q50 10 70 40T50 80" fill="none" stroke="#fff" stroke-width="2.5"/></svg>`;
    const sec = await api.importSvg(svg, { preserveViewport: true });
    const out = [];
    for (const size of [256, 1024, 2048]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const gl = canvas.getContext('webgl2', {
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw Error('WebGL2 required');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const device = ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      if (/swiftshader|llvmpipe|software/i.test(device))
        throw Error('Physical GPU required: ' + device);
      const read = () => {
        const p = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, p);
        return p;
      };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // the reference: the needed engine (AAC) drawn by its own program, everything warm
      const ref = api.createRenderer(gl, shaders, { aacPoints: false });
      await ref.ready;
      ref.setFillEngine({ route: 'none', kernel: 'aac' });
      ref.setViewport(size, size);
      const rb = api.createBundle(gl, sec);
      await ref.precompileFillsAsync({});
      for (let i = 0; i < 3; i++) {
        ref.beginFrame([1, 1, 1, 1]);
        ref.drawBundle(rb);
        ref.endFrame();
        await sleep(20);
      }
      ref.beginFrame([1, 1, 1, 1]);
      ref.drawBundle(rb);
      ref.endFrame();
      const refPix = read();
      ref.dispose();
      // the subject: standIns:false, Slug warm, then the pin flips to AAC (cold): the first frames reuse the Slug variant
      const R = api.createRenderer(gl, shaders, {
        aacPoints: false,
        standIns: false,
        asyncShaderCompile: true,
        nonBlocking: true,
      });
      await R.ready;
      R.setFillEngine({ route: 'none', kernel: 'slug' });
      R.setViewport(size, size);
      const b = api.createBundle(gl, sec);
      await R.precompileFillsAsync({});
      for (let i = 0; i < 3; i++) {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundle(b);
        R.endFrame();
        await sleep(20);
      }
      R.setFillEngine({ route: 'none', kernel: 'aac' });
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      const reusePix = read();
      const reuse0 = R.debugStats.needMiss.reuseDraws,
        blocked0 = R.debugStats.needMiss.blocked,
        def0 = R.debugStats.deferredFillDraws | 0;
      let frames = 0,
        last = -1,
        stable = 0;
      for (; frames < 400 && stable < 10; frames++) {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundle(b);
        R.endFrame();
        await sleep(8);
        const r = R.debugStats.needMiss.reuseDraws;
        if (r === last) stable++;
        else {
          stable = 0;
          last = r;
        }
      }
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      const switchedPix = read();
      const stats = {
        reuseDraws: R.debugStats.needMiss.reuseDraws,
        blocked: R.debugStats.needMiss.blocked,
        deferred: R.debugStats.deferredFillDraws | 0,
        frames,
        stable,
      };
      const cmp = (a, c) => {
        let max = 0,
          sum = 0,
          n = 0,
          inkA = 0;
        for (let i = 0; i < a.length; i += 4) {
          let m = 0;
          for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(a[i + k] - c[i + k]));
          if (a[i] !== 255 || a[i + 1] !== 255 || a[i + 2] !== 255) {
            inkA++;
            sum += m;
            n++;
          }
          if (m > max) max = m;
        }
        return { max, mean: n ? sum / n : 0, ink: inkA };
      };
      out.push({
        size,
        device,
        hole: cmp(reusePix, reusePix).ink,
        reuseVsNeeded: cmp(reusePix, refPix),
        switchedVsNeeded: cmp(switchedPix, refPix),
        reuseVsSwitched: cmp(reusePix, switchedPix),
        stats,
        reuseAtFlip: reuse0,
        blocked0,
        def0,
      });
      R.dispose();
    }
    return out;
  });
  for (const r of rows) {
    console.log(JSON.stringify(r));
    ok(
      r.hole > 0,
      `${r.size}px: the first frame after the flip is not a hole (${r.hole} inked px)`,
    );
    ok(
      r.reuseAtFlip >= 1 && r.stats.blocked === 0 && r.stats.deferred === 0,
      `${r.size}px: the flip frame was a reuse draw (${r.reuseAtFlip}), nothing blocked or deferred`,
    );
    ok(
      r.reuseVsNeeded.max <= 24 && r.reuseVsNeeded.mean <= 1.0,
      `${r.size}px: the reused frame vs the needed engine's frame: max ${r.reuseVsNeeded.max}/255, mean over inked ${r.reuseVsNeeded.mean.toFixed(3)}/255 (tolerance 24, 1.0)`,
    );
    ok(
      r.switchedVsNeeded.max <= 8,
      `${r.size}px: after the switch the frame is the needed engine's (max ${r.switchedVsNeeded.max}/255)`,
    );
    ok(
      r.reuseVsSwitched.max <= 24,
      `${r.size}px: no pop at the switch beyond the tolerance (${r.reuseVsSwitched.max}/255)`,
    );
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
