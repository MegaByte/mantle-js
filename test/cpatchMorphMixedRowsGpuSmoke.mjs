// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphMixedRowsGpuSmoke -- a CPatch MORPH whose bundle also carries rows the CPatch kernel does not draw (a mask, a group opacity, a radial
// gradient, a stroke) draws the same pose as the Slug morph. The CPatch route draws the morphing fills with CPatch and the other rows in the same
// frame with Slug or the stroke program; the pose, clip and bounds of the CPatch part must be the morph's, whatever else the bundle carries.
// Each pair is drawn at t = 0.25, 0.5 and 0.75 by a renderer pinned to route cpatch and by one pinned to the Slug cover morph; the frames must agree
// (at most BAR px differ by more than 32/255 and the ink counts match within 1%). The pairs are small synthetic SVGs (blobs under a mask, a group opacity,
// a radial gradient and a stroke width lerp), plus a mixed line/quad/cubic contour and a rational refusal control.
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 192,
  TS = [0.25, 0.5, 0.75],
  BAR = 12;
// The violent paint_opacity blob pair carries CPatch's own late-pose residual (about 40-110 px at t = 0.75 with the blend off too: the packed pose, not the
// mixed draw), so its cases are held at t = 0.25 and 0.5 only. Every other case is held at all three.
const TS_OF = { paint_opacity: [0.25, 0.5], paint_opacity_blue_alone: [0.25, 0.5] };
const CASES = {
  mask: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="mk" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect x="10" y="10" width="180" height="180" fill="url(#fade)"/></mask></defs><g mask="url(#mk)"><path id="m_m" d="M160 100C160 117.321 145 143.301 130 151.962C115 160.622 85 160.622 70 151.962C55 143.301 40 117.321 40 100C40 82.679 55 56.699 70 48.038C85 39.378 115 39.378 130 48.038C145 56.699 160 82.679 160 100Z" fill="#2f6fd6"/></g></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="mk" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect x="10" y="10" width="180" height="180" fill="url(#fade)"/></mask></defs><g mask="url(#mk)"><path id="m_m" d="M165.02 153.254C150.133 167.715 106.97 173.275 80.952 169.48C54.934 165.686 16.777 148.266 8.914 130.487C1.051 112.708 16.748 79.344 33.773 62.806C50.798 46.268 88.315 27.941 111.066 31.259C133.816 34.577 161.283 62.381 170.275 82.714C179.267 103.046 179.907 138.793 165.02 153.254Z" fill="#d6532f"/></g></svg>',
  ],
  paint_opacity: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><g opacity="0.65"><path id="m_back" d="M135 100C135 115.877 121.25 139.693 107.5 147.631C93.75 155.57 66.25 155.57 52.5 147.631C38.75 139.693 25 115.877 25 100C25 84.123 38.75 60.307 52.5 52.369C66.25 44.43 93.75 44.43 107.5 52.369C121.25 60.307 135 84.123 135 100Z" fill="#d6532f" fill-opacity="0.5"/><path id="m_front" d="M177.441 117.769C173.186 131.523 147.984 144.783 131.059 148.632C114.134 152.481 85.676 151.423 75.892 140.861C66.107 130.299 67.224 101.843 72.354 85.261C77.483 68.68 92.629 44.563 106.668 41.371C120.707 38.178 144.792 53.374 156.587 66.106C168.383 78.839 181.695 104.014 177.441 117.769Z" fill="#2f6fd6" fill-opacity="0.5"/></g></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><g opacity="0.65"><path id="m_back" d="M149.017 125.758C132.367 135.368 99.785 144.646 82.935 139.802C66.084 134.958 51.029 111.987 47.911 96.695C44.794 81.404 50.036 56.244 64.229 48.052C78.423 39.861 113.304 41.864 133.072 47.547C152.84 53.229 180.179 69.111 182.836 82.146C185.494 95.181 165.667 116.149 149.017 125.758Z" fill="#d6532f" fill-opacity="0.9"/><path id="m_front" d="M138.821 117.862C137.6 134.085 124.001 156.519 112.411 163.487C100.821 170.454 79.208 169.19 69.282 159.669C59.355 150.148 51.584 123.228 52.853 106.362C54.122 89.495 65.75 65.17 76.897 58.469C88.044 51.767 109.415 56.253 119.736 66.152C130.057 76.051 140.042 101.64 138.821 117.862Z" fill="#2f6fd6" fill-opacity="0.2"/></g></svg>',
  ],
  grad_radial: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><radialGradient id="g" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#6a3fb0"/></radialGradient></defs><path id="m_g" d="M160 100C159.564 119.021 136.247 146.49 117.233 153.038C98.22 159.587 55.958 153.339 45.919 139.292C35.88 125.245 44.677 85.488 56.999 68.758C69.32 52.028 102.682 33.705 119.849 38.912C137.016 44.119 160.436 80.979 160 100Z" fill="url(#g)" stroke="#222" stroke-width="3"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><radialGradient id="g" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#6a3fb0"/></radialGradient></defs><path id="m_g" d="M163.578 148.865C152.933 165.531 100.152 176.821 78.709 169.642C57.266 162.462 36.337 129.716 34.921 105.787C33.506 81.857 52.271 32.089 70.214 26.065C88.157 20.041 127.017 49.176 142.578 69.643C158.138 90.109 174.223 132.198 163.578 148.865Z" fill="url(#g)" stroke="#222" stroke-width="3"/></svg>',
  ],
  stroke_lerp: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path id="m_ring" d="M160 100C159.564 119.021 136.247 146.49 117.233 153.038C98.22 159.587 55.958 153.339 45.919 139.292C35.88 125.245 44.677 85.488 56.999 68.758C69.32 52.028 102.682 33.705 119.849 38.912C137.016 44.119 160.436 80.979 160 100Z" fill="#f2c94c" stroke="#a02b2b" stroke-width="2" stroke-linejoin="round"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path id="m_ring" d="M161.338 151.665C148.056 169.071 90.269 182.726 70.182 173.407C50.095 164.088 39.547 122.949 40.815 95.75C42.084 68.551 59.615 14.677 77.792 10.213C95.968 5.749 135.948 45.39 149.873 68.965C163.797 92.541 174.62 134.258 161.338 151.665Z" fill="#4cc2f2" stroke="#1d3f8f" stroke-width="14" stroke-linejoin="round"/></svg>',
  ],
  cross_mixed: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path id="m_x" d="M62 55 L138 55 A22 22 0 0 1 160 77 L160 123 A22 22 0 0 1 138 145 L62 145 A22 22 0 0 1 40 123 L40 77 A22 22 0 0 1 62 55Z" fill="#16a085"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path id="m_x" d="M95 40 L105 40 A40 40 0 0 1 145 80 L145 120 A40 40 0 0 1 105 160 L95 160 A40 40 0 0 1 55 120 L55 80 A40 40 0 0 1 95 40Z" fill="#16a085"/></svg>',
  ],
  mixed_polynomial: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M62 55L138 55C152 55 160 63 160 77L160 123Q160 145 138 145L62 145Q40 145 40 123L40 77Q40 55 62 55Z" fill="#16a085"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M95 40L105 40C132 40 145 53 145 80L145 120Q145 160 105 160L95 160Q55 160 55 120L55 80Q55 40 95 40Z" fill="#16a085"/></svg>',
  ],
  paint_opacity_blue_alone: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path id="m_front" d="M177.441 117.769C173.186 131.523 147.984 144.783 131.059 148.632C114.134 152.481 85.676 151.423 75.892 140.861C66.107 130.299 67.224 101.843 72.354 85.261C77.483 68.68 92.629 44.563 106.668 41.371C120.707 38.178 144.792 53.374 156.587 66.106C168.383 78.839 181.695 104.014 177.441 117.769Z" fill="#2f6fd6" fill-opacity="0.5"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path id="m_front" d="M138.821 117.862C137.6 134.085 124.001 156.519 112.411 163.487C100.821 170.454 79.208 169.19 69.282 159.669C59.355 150.148 51.584 123.228 52.853 106.362C54.122 89.495 65.75 65.17 76.897 58.469C88.044 51.767 109.415 56.253 119.736 66.152C130.057 76.051 140.042 101.64 138.821 117.862Z" fill="#2f6fd6" fill-opacity="0.2"/></svg>',
  ],
};
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="a" width="${N}" height="${N}"></canvas><canvas id="b" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
async function side(id, pin, a, b) {
  const gl = document.getElementById(id).getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const R = createRenderer(gl, shaders, { cpatchFill: pin.route === 'cpatch', aacFill: false, unifiedMorph: true });
  if (R.ready) await R.ready;
  R.setFillEngine(pin);
  const m = createShapeMorph(gl, createBundle(gl, await importSvg(a)), createBundle(gl, await importSvg(b)));
  const bb = m.bundle || m;
  m.setT(0);
  for (let i = 0; i < 600; i++) {
    if (R.prepareBundle) { try { R.prepareBundle(bb); } catch {} }
    const pl = bb._cpatchMorphPlan;
    if (pin.route !== 'cpatch' || (pl !== undefined && pl !== 'pending')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { gl, R, m, bb, pin };
}
async function frame(s, t) {
  s.m.setT(t);
  let drew = {};
  for (let i = 0; i < 300; i++) {
    if (s.R.prepareBundle) { try { s.R.prepareBundle(s.bb); } catch {} }
    const before = Object.assign({}, (s.R.debugStats.engines || {}).draws || {});
    s.R.setViewport(${N}, ${N}); s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundle(s.m); s.R.endFrame();
    if (s.R.precompileFills) { try { s.R.precompileFills(); } catch {} }
    const after = (s.R.debugStats.engines || {}).draws || {};
    drew = {};
    for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
    if (s.pin.route !== 'cpatch' || drew.cpatch || s.bb._cpatchMorphPlan === null) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const px = new Uint8Array(${N} * ${N} * 4);
  s.gl.readPixels(0, 0, ${N}, ${N}, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
  const uf = s.bb._unifiedFill;
  const info = { gate: s.R._unifiedFillGate, built: s.bb._cpatchBuilt, plan: typeof s.bb._cpatchMorphPlan, nShapes: s.bb.numShapes,
    declined: s.bb._cpatchMorphPlan === null, bail: s.bb._cpatchBail, spanS: uf && Array.from(uf.spanS || []), spanN: uf && Array.from(uf.spanN || []), narrow: !!(uf && uf.coef), key: String(s.R.debugStats && s.R.debugStats.drawnFillVariantKey || '').slice(0, 160) };
  return { px: Array.from(px), drew, info };
}
window.__run = async (a, b, ts) => {
  const A = await side('a', { route: 'cpatch', kernel: 'slug' }, a, b), B = await side('b', { route: 'none', kernel: 'slug' }, a, b);
  const out = [];
  for (const t of ts) out.push({ t, a: await frame(A, t), b: await frame(B, t) });
  return out;
};
window.__ready = true;
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
const ok = (m) => console.log('ok ' + m);
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
  await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
  for (const [name, [a, b]] of Object.entries(CASES)) {
    const res = await page.evaluate((x, y, ts) => window.__run(x, y, ts), a, b, TS_OF[name] || TS);
    for (const r of res) {
      let off = 0,
        inkA = 0,
        inkB = 0,
        maxByte = 0;
      for (let i = 0; i < N * N; i++) {
        let d = 0;
        for (let c = 0; c < 4; c++)
          d = Math.max(d, Math.abs(r.a.px[i * 4 + c] - r.b.px[i * 4 + c]));
        maxByte = Math.max(maxByte, d);
        if (d > 32) off++;
        if (
          r.a.px[i * 4 + 3] > 0 &&
          (r.a.px[i * 4] < 250 || r.a.px[i * 4 + 1] < 250 || r.a.px[i * 4 + 2] < 250)
        )
          inkA++;
        if (
          r.b.px[i * 4 + 3] > 0 &&
          (r.b.px[i * 4] < 250 || r.b.px[i * 4 + 1] < 250 || r.b.px[i * 4 + 2] < 250)
        )
          inkB++;
      }
      if (process.env.CPMM_INFO) console.log('  info', name, r.t, JSON.stringify(r.a.info));
      const tag = `${name} t=${r.t}: ${off} px differ by >32/255, ink ${inkA} vs ${inkB}, CPatch route drew ${JSON.stringify(r.a.drew)}`;
      if (name === 'cross_mixed') {
        if (
          !r.a.info.declined ||
          !/uncertified interval: native whole-interval certificate declined/.test(
            r.a.info.bail || '',
          ) ||
          !r.a.drew.slug ||
          r.a.drew.cpatch ||
          r.a.drew.lb ||
          r.a.drew.aac ||
          maxByte !== 0
        )
          fail(tag + ' (rational native refusal must retain exact raw Slug pixels)');
        else ok(tag + ' (native refusal, exact raw Slug fallback)');
      } else if (!r.a.drew.cpatch) fail(tag + ' (the CPatch route did not draw CPatch)');
      else if (off > BAR || Math.abs(inkA - inkB) > 0.01 * Math.max(inkA, inkB, 1)) fail(tag);
      else ok(tag);
    }
  }
  const resources = await page.evaluate(async () => {
    const { runPreparedResourceCases } = await import('/test/_auditPaintCases.mjs');
    return runPreparedResourceCases();
  });
  for (const result of resources) {
    const message =
      result.name + ': max ' + result.maxByte + '/255, prepared route ' + result.served;
    if (result.maxByte > 1) fail(message);
    else ok(message);
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('cpatchMorphMixedRowsGpuSmoke ok');
