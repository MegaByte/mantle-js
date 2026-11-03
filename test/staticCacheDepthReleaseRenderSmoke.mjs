// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// staticCacheDepthReleaseRenderSmoke -- a baked static cache does not keep its DEPTH24_STENCIL8 renderbuffer.
//
// The bake needs depth + stencil (the fill sequences z-order and clips with them); the cached picture does not. Kept beside the RGBA8 for the
// cache's whole life the renderbuffer costs +4 B/px per cache (8 MB at 1080p, 16.8 MB at 2048 px), so it is freed after the bake and a fresh
// one is attached at the next bake. opts.cacheKeepDepthStencil keeps it.
// Pinned on real GL: (1) after the bake the default renderer holds exactly one cache-sized renderbuffer LESS than the keep arm;
// (2) a rebake at another scale attaches a new one and frees it again (allocations counted); (3) both arms draw identical pixels, at the
// first scale, at the second, and back at the first.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><path d="M30 150 C30 20 170 20 170 150 Q100 90 30 150 Z" fill="#c33" stroke="#036" stroke-width="6"/><circle cx="100" cy="60" r="22" fill="#fa0" opacity="0.8"/><path d="M20 20 L60 20 L40 60 Z M150 150 h30 v30 h-30 z" fill="#383"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas><script type="module">
const P = WebGL2RenderingContext.prototype; const rbs = new Map(); let allocs = 0, bound = null;
const wrap = (n, f) => { const o = P[n]; P[n] = function (...a) { const r = o.apply(this, a); f(a, r); return r; }; };
wrap('bindRenderbuffer', (a) => { bound = a[1]; });
wrap('renderbufferStorage', (a) => { if (bound && a[1] === 0x88F0) { rbs.set(bound, a[2] * a[3] * 4); allocs++; } });
wrap('deleteRenderbuffer', (a) => { rbs.delete(a[0]); });
const rbBytes = () => { let s = 0; for (const v of rbs.values()) s += v; return s; };
const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const device = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sections = await importSvg(${JSON.stringify(SVG)});
const wait = (ms) => new Promise((x) => setTimeout(x, ms)); const px = new Uint8Array(256 * 256 * 4);
const hash = () => { gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, px); let h = 0x811c9dc5 >>> 0; for (let i = 0; i < px.length; i++) { h ^= px[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
const wm = (s) => new Float32Array([s, 0, 0, 0, s, 0, 0, 0, 1]);
async function arm(keep) {
  const r = createRenderer(gl, shaders, { cacheKeepDepthStencil: keep });
  if (r.ready) await r.ready;
  r.setViewport(256, 256);
  const b = createBundle(gl, sections);
  const h = r.createBundleHandle(b, { staticCache: { strategy: 2 } });   // ForceWholeAsset
  const out = { hashes: [], estimatedRasterBytes: r.estimateRouteBytes(b, {viewport: [256, 256]}).bundles[0].cachedRaster.tex };
  const run = async (s, frames) => {
    const draw = () => { r.beginFrame([1, 1, 1, 1]); h.draw({ worldMatrix: wm(s) }); r.endFrame(); };
    // Compare completed preparation states: Slug and LB differ at AA boundaries.
    const warm = await r.warmScene([{ bundle: b, engine: 'lb', draw }],
      { maxPasses: 256, readyTimeoutMs: 60000, fenceTimeoutMs: 60000 });
    if (!warm.complete) throw Error('Static-cache draw state did not warm');
    for (let f = 0; f < frames; f++) { draw(); await wait(16); }
    out.hashes.push(hash());
  };
  const a0 = allocs; await run(1, 12); out.rbAfterBake = rbBytes(); out.allocsFirst = allocs - a0;
  const a1 = allocs; await run(0.8, 12); out.rbAfterRebake = rbBytes(); out.allocsRebake = allocs - a1;
  await run(1, 12); out.hashes.push(out.hashes[0]);
  out.hashesBack = out.hashes[2];
  h.dispose(); b.dispose(); r.dispose();
  return out;
}
const out = { device, dflt: await arm(false), keep: await arm(true), glError: gl.getError() };
window.__out = out; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--no-sandbox', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-angle=metal', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
console.log(JSON.stringify(o));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const d = o.dflt,
  k = o.keep,
  CACHE = 256 * 256 * 4;
if (process.env.MANTLE_TEST_GL !== 'swiftshader')
  ok(
    /Apple|Metal/.test(o.device) && !/SwiftShader|software/i.test(o.device),
    'physical Metal device: ' + o.device,
  );
ok(o.glError === 0, 'no GL error');
ok(
  d.estimatedRasterBytes === CACHE && k.estimatedRasterBytes === CACHE * 2,
  'route estimates reflect color-only and retained-depth cache storage',
);
ok(
  k.rbAfterBake >= CACHE,
  `the keep arm holds the cache's renderbuffer after the bake (${k.rbAfterBake} bytes)`,
);
ok(
  d.rbAfterBake === k.rbAfterBake - CACHE,
  `the default arm holds exactly one cache-sized renderbuffer less (${d.rbAfterBake} vs ${k.rbAfterBake}, cache ${CACHE})`,
);
ok(
  d.allocsRebake >= 1 && d.rbAfterRebake === d.rbAfterBake,
  `a rebake attaches a fresh renderbuffer and frees it again (${d.allocsRebake} allocation(s); held ${d.rbAfterRebake})`,
);
ok(
  d.hashes[0] === k.hashes[0] && d.hashes[1] === k.hashes[1] && d.hashes[2] === k.hashes[2],
  'both arms draw identical pixels at scale 1, at 0.8 (rebake) and back at 1 (rebake)',
);
ok(
  d.hashes[0] !== d.hashes[1],
  'the rebake really changed the picture (the scale-0.8 hash differs)',
);
process.exit(fail ? 1 : 0);
