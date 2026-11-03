// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// auxWarmSamplerGpuSmoke -- the loading call's filter-helper warm draws are VALID GL draws, so every helper pipeline is built at load.
//
// strictPlay's loading call draws each filter helper (cacheBlit, the fused blurs, the effect mask, ...) once on the canvas and on a texture
// target, blend on and off. It must set the helper's sampler uniforms before it draws: a program with two sampler types (the effect mask:
// sampler2D uCacheTex + sampler2DArray uMasks) left with both on unit 0, where a 2D texture is bound, has every draw rejected with
// INVALID_OPERATION ("Two textures of different types use the same sampler location"). A rejected draw never reaches the GPU, so the pipeline
// would not be built at load and the first real effect-mask draw would build it in play.
//
// HOW: the real renderer on the physical GPU (ANGLE/Metal). Every drawArrays / drawArraysInstanced is wrapped: the error queue is read BEFORE
// the draw (anything older is recorded as 'other', never attributed to the draw) and AFTER it. The loading call (strictPlay, a filtered bundle
// so the helpers are linked) runs through precompileFillsAsync (the loading call) and a GPU fence. Asserted: (1) no draw ended in INVALID_OPERATION and no other GL error
// appeared; (2) debugStats.auxWarmed names every helper program the renderer owns (cacheBlit, boxBlur and an effect mask among them); (3) the
// effect-mask program (the one with a sampler2DArray) took four valid full-screen strip draws; (4) the warm read no sampler value back with
// getUniform (a round trip to the GPU process: 1.5-1.8 s behind a large scene's loading compiles).
// MANTLE_GL_SAMPLER_ROOT=<package dir> runs the same page against another source tree (the control: a tree that skips the sampler setup must FAIL).
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.MANTLE_GL_SAMPLER_ROOT
  ? path.resolve(process.env.MANTLE_GL_SAMPLER_ROOT)
  : pkg;
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
const cap = capWallTime('auxWarmSamplerGpuSmoke', stop);
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
  const r = await page.evaluate(async () => {
    const api = await import('/src/index.js');
    const shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true });
    if (!gl) throw Error('WebGL2 required');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const device = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    if (/swiftshader|llvmpipe|software/i.test(device))
      throw Error('Physical GPU required: ' + device);
    const draws = [],
      other = [],
      progInfo = new Map();
    const info = (p) => {
      if (progInfo.has(p)) return progInfo.get(p);
      const src = gl
        .getAttachedShaders(p)
        .map((s) => gl.getShaderSource(s))
        .join('\n');
      const v = { array: /sampler2DArray\s+uMasks/.test(src), masks: /uMasks/.test(src) };
      progInfo.set(p, v);
      return v;
    };
    for (const op of ['drawArrays', 'drawArraysInstanced']) {
      const draw = gl[op].bind(gl);
      gl[op] = (...args) => {
        for (let e; (e = gl.getError()) !== gl.NO_ERROR;) other.push(e); // anything older than this draw is not this draw's
        draw(...args);
        const p = gl.getParameter(gl.CURRENT_PROGRAM),
          err = gl.getError();
        draws.push({ op, mode: args[0], count: args[2], err, masks: info(p).masks, program: p });
      };
    }
    // a sampler's value read back (getUniform) waits for the GPU process: behind a game's loading compiles it held the main thread 1.5-1.8 s
    let auxReads = 0;
    {
      const gu = gl.getUniform.bind(gl);
      gl.getUniform = (...a) => {
        if (/bindAuxSamplers/.test(new Error().stack || '')) auxReads++;
        return gu(...a);
      };
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
      '<rect x="10" y="10" width="30" height="30" fill="#f00" filter="url(#b)"/></svg>';
    const data = await api.importSvg(svg, { preserveViewport: true });
    const rr = api.createRenderer(gl, shaders, {
      strictPlay: true,
      aacPoints: false,
      psoWarmIdle: () => false,
      precompileFillsBudgetMs: 100000,
    });
    rr.setViewport(64, 64);
    await rr.ready;
    const b = api.createBundle(gl, data);
    rr.prepareBundle?.(b);
    draws.length = 0;
    other.length = 0;
    auxReads = 0;
    await rr.precompileFillsAsync({ timeoutMs: 120000 });
    if (!(await window.__gpuFence(gl, 60000))) throw Error('warm fence');
    const stats = rr.debugStats;
    const strip = draws.filter((d) => d.mode === gl.TRIANGLE_STRIP && d.count === 4);
    const maskProgs = new Map();
    for (const d of strip)
      if (d.masks) {
        const m = maskProgs.get(d.program) || { total: 0, valid: 0 };
        m.total++;
        if (d.err === gl.NO_ERROR) m.valid++;
        maskProgs.set(d.program, m);
      }
    const out = {
      device,
      nDraws: draws.length,
      invalid: draws.filter((d) => d.err === gl.INVALID_OPERATION).length,
      badOther:
        draws.filter((d) => d.err !== gl.NO_ERROR && d.err !== gl.INVALID_OPERATION).length +
        other.length,
      auxWarmed: stats.auxWarmed || [],
      maskProgs: [...maskProgs.values()],
      auxReads,
    };
    b.dispose();
    rr.dispose();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return out;
  });
  console.log(JSON.stringify(r));
  ok(r.nDraws > 0, 'the loading call drew');
  ok(r.invalid === 0, `no draw ended in INVALID_OPERATION (${r.invalid})`);
  ok(r.badOther === 0, `no other GL error (${r.badOther})`);
  ok(
    ['cacheBlit', 'boxBlur'].every((l) => r.auxWarmed.includes(l)) &&
      r.auxWarmed.some((l) => /effectMask/.test(l)),
    `debugStats.auxWarmed names the helpers (${r.auxWarmed.join(',')})`,
  );
  ok(
    r.maskProgs.length >= 1 && r.maskProgs.every((m) => m.valid >= 4),
    `each effect-mask program took >= 4 valid strip draws (${JSON.stringify(r.maskProgs)})`,
  );
  ok(
    r.auxReads === 0,
    `the helper warm read no sampler value back (getUniform from bindAuxSamplers: ${r.auxReads})`,
  );
  if (fail) throw Error(`auxWarmSamplerGpuSmoke FAIL (${fail})`);
  console.log('auxWarmSamplerGpuSmoke PASS');
} finally {
  cap.clear();
  await stop();
}
