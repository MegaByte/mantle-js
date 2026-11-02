// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// recolorFoldPixelGpuSmoke -- the one recolor program of a bundle declared both a color matrix and a channel lerp (fillPass pushRecolorOmits) draws what the lean programs draw.
// Same asset, same draw states, on a physical GPU: one renderer declares one recolor per bundle (the lean keys), one declares both (the folded key). Every program is a fresh compile
// in its page, so a first-compile difference cannot sit on one side only; bytes may differ by at most 1/255 (the fragment math is the same, the program text is not).
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html>');
      return;
    }
    const file = path.resolve(root, decodeURIComponent(url.pathname).slice(1));
    if (!file.startsWith(root + '/')) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  server.close();
};
const cap = capWallTime('recolor fold pixels', stop, 240000);
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  const rows = await page.evaluate(async () => {
    globalThis.__MANTLE_DEBUG__ = true;
    const api = await import('/src/index.js');
    const shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
    const SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 32C8 8 56 8 56 32C56 56 8 56 8 32Z" fill="#f00"/><path d="M20 20L44 20L32 48Z" fill="#00f" fill-opacity="0.7"/><path d="M28 28h8v8h-8z" fill="#fff"/><path d="M10 54Q32 40 54 54" fill="none" stroke="#0f0" stroke-width="3"/></svg>';
    const CL = {
      primary: [0.1, 0.6, 0.2, 1],
      contrast: [0.9, 0.8, 0.1, 1],
      highlight: [1, 1, 1, 1],
    };
    const CM = new Float32Array([0.5, 0.4, 0, 0, 0.1, 0.8, 0.1, 0, 0, 0.3, 0.6, 0, 0, 0, 0, 0.9]),
      OFF = new Float32Array([0.05, 0, 0.02, 0]);
    const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
    const STATES = {
      cl: [{ channelLerp: CL }, ['channelLerp']],
      cm: [{ colorMatrix: CM, colorMatrixOffset: OFF }, ['recolor']],
      clRot: [{ channelLerp: CL, worldMatrix: ROT }, ['channelLerp', 'rotate']],
      cmRot: [{ colorMatrix: CM, colorMatrixOffset: OFF, worldMatrix: ROT }, ['recolor', 'rotate']],
    };
    const shot = async (tags, opts) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
        depth: true,
        stencil: true,
      });
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (/software|swiftshader|llvmpipe/i.test(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)))
        throw Error('Physical GPU required');
      const r = api.createRenderer(gl, shaders, {
        strictPlay: true,
        aacFill: 'auto',
        aacPoints: false,
        standIns: false,
        needMissPolicy: 'block',
      });
      await r.ready;
      r.setViewport(128, 128);
      const b = api.createBundle(gl, await api.importSvg(SVG, { preserveViewport: true }));
      r.declareReach(b, tags);
      await r.precompileFillsAsync({});
      // (what the draw really bound: a fill program holding both blocks is the folded one, and the small-shape points route, which has neither, is off)
      let both = false;
      for (const op of [
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
      ]) {
        const f = gl[op].bind(gl);
        gl[op] = (...a) => {
          const p = gl.getParameter(gl.CURRENT_PROGRAM);
          if (
            gl.getUniformLocation(p, 'uChannelLerpEnabled') &&
            gl.getUniformLocation(p, 'uColorMatrixEnabled')
          )
            both = true;
          return f(...a);
        };
      }
      const t0 = performance.now();
      r.beginFrame([0, 0, 0, 0]);
      r.drawBundle(b, opts);
      r.endFrame();
      await window.__gpuFence(gl, 20000);
      const px = new Uint8Array(128 * 128 * 4);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
      await window.__gpuIdle(performance.now() - t0);
      r.dispose();
      b.dispose();
      gl.getExtension('WEBGL_lose_context').loseContext();
      return { px, both };
    };
    const out = [];
    for (const [name, [opts, tags]] of Object.entries(STATES)) {
      const lean = await shot(tags, opts);
      const folded = await shot(['channelLerp', 'recolor', 'rotate'], opts);
      let maxD = 0,
        inked = 0,
        diff = 0;
      for (let i = 0; i < lean.px.length; i++) {
        const d = Math.abs(lean.px[i] - folded.px[i]);
        if (d > maxD) maxD = d;
        if (d) diff++;
        if (lean.px[i]) inked++;
      }
      out.push({ name, maxD, diff, inked, leanLean: !lean.both, foldedFolded: folded.both });
    }
    return out;
  });
  for (const r of rows) {
    console.log(
      `  ${r.name}: max diff ${r.maxD}/255 on ${r.diff} channels (${r.inked} inked channels), the lean draw bound a lean program ${r.leanLean}, the folded draw the folded one ${r.foldedFolded}`,
    );
    assert.ok(r.inked > 1000, r.name + ': the draw painted');
    assert.ok(
      r.leanLean && r.foldedFolded,
      r.name + ': the two renderers bound the lean and the folded key',
    );
    assert.ok(r.maxD <= 1, r.name + ': the folded program draws the lean pixels');
  }
  console.log('all ok');
} finally {
  cap.clear?.();
  await stop();
}
process.exit(0);
