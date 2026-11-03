// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textureRowLimitsRenderSmoke -- the per-item tables (meta, gradient, dash, filter, override, mask row) do not take one
// texture ROW per item: a bundle with more items than the device's MAX_TEXTURE_SIZE (16384 here, 4096 on a lot of mobile
// hardware) would upload nothing (texImage2D raises GL 1281 and the whole bundle draws blank). They wrap in
// 4096-row bands (renderer/tableLayout.js; metaAt/gradAt/... in _bundleLayout.glsl).
//
// A smaller device is SIMULATED on any machine: getParameter(MAX_TEXTURE_SIZE) answers the cap, and texImage2D / texStorage2D /
// renderbufferStorage past the cap are recorded as violations and NOT performed (so the table is blank, as on the device).
// Every case draws N items each with its own value (a distinct color, a distinct dash length, a distinct gradient, a distinct
// filter) and probes pixels in the first band, on both sides of each band edge and at the last item.
//   caps: 4096, 8192 and the real limit; one run of each, in separate pages.
// Env: TRL_CAPS="4096,8192,0" (0 = the real limit), TRL_BIG=1 adds the 40000-shape cases to every cap.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPS = (process.env.TRL_CAPS || '4096,8192,0').split(',').map((s) => +s.trim());

const HTML = `<!DOCTYPE html><html><body style="margin:0"><div id="host"></div>
<script type="module">
import * as api from '/src/index.js';
const P = WebGL2RenderingContext.prototype;
window.__sim = { cap: 0, violations: [] };
const MAXT = 0x0D33;
{
  const gp = P.getParameter;
  P.getParameter = function (p) { return (p === MAXT && window.__sim.cap) ? window.__sim.cap : gp.call(this, p); };
  const chk = (name, w, h) => { const c = window.__sim.cap; if (c && (w > c || h > c)) { window.__sim.violations.push(name + ' ' + w + 'x' + h); return false; } return true; };
  const ti = P.texImage2D; P.texImage2D = function (t, l, i, w, h, ...r) { return typeof h === 'number' && !chk('texImage2D', w, h) ? undefined : ti.call(this, t, l, i, w, h, ...r); };
  const ts = P.texStorage2D; P.texStorage2D = function (t, l, i, w, h) { return chk('texStorage2D', w, h) ? ts.call(this, t, l, i, w, h) : undefined; };
  const rs = P.renderbufferStorage; P.renderbufferStorage = function (t, i, w, h) { return chk('renderbufferStorage', w, h) ? rs.call(this, t, i, w, h) : undefined; };
}
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const col = (i) => [(i * 53) % 256, (i * 97 + 31) % 256, (i * 193 + 7) % 256];
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const svg = (W, H, defs, body) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + (defs ? '<defs>' + defs + '</defs>' : '') + body + '</svg>';

async function scenario(W, H, svgText, what, setup) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.getElementById('host').appendChild(cv);
  const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const out = { W, H, glErrors: [] };
  const R = api.createRenderer(gl, shaders, {}); R.setViewport(W, H);
  if (setup) { if (R.ready) await R.ready; setup(R); }
  const t0 = performance.now();
  const sec = await api.importSvg(svgText, { preserveViewport: true });
  out.importMs = Math.round(performance.now() - t0);
  while (gl.getError()) { /* drain */ }
  window.__sim.violations = [];
  try { out.bundle = api.createBundle(gl, sec); } catch (e) { out.threw = String(e.message || e).slice(0, 300); }
  const b = out.bundle;
  if (b) {
    out.numShapes = b.numShapes; out.gradientCount = b.gradientCount; out.dashCount = b.dashCount;
    const draw = async (n, f) => { for (let i = 0; i < n; i++) { R.beginFrame([1, 1, 1, 1]); f(); R.endFrame(); await sleep(20); } };
    out.draw = (opts) => draw(6, () => R.drawBundle(b, opts || {}));
    await out.draw();
    out.read = () => { const p = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
    out.px = () => { const p = out.read(); return (x, y) => { const o = ((H - 1 - y) * W + x) * 4; return [p[o], p[o + 1], p[o + 2], p[o + 3]]; }; };
  }
  out.gl = gl; out.R = R;
  return out;
}
function done(s) {
  s.glErrors = []; let e; while ((e = s.gl.getError()) && s.glErrors.length < 8) s.glErrors.push(e);
  const v = window.__sim.violations.slice(0, 6);
  try { s.bundle && s.bundle.dispose(); s.R.dispose(); s.gl.getExtension('WEBGL_lose_context') && s.gl.getExtension('WEBGL_lose_context').loseContext(); } catch {}
  s.gl.canvas.remove();
  return { glErrors: s.glErrors, violations: v };
}
const near = (a, b, t = 3) => Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t && Math.abs(a[2] - b[2]) <= t && a[3] > 250;
const probeSet = (n) => { const s = new Set([0, 1, 2, 4094, 4095, 4096, 4097, 8190, 8191, 8192, 8193, 12288, 16383, 16384, 16385, (n / 2) | 0, n - 3, n - 2, n - 1]); for (let k = 1; k < 24; k++) s.add(Math.floor(n * k / 24)); return [...s].filter((i) => i >= 0 && i < n); };

// ---- rects, one colour each. cell 4 px, rect 3x3 at the cell origin; probe the rect centre.
window.__rects = async (n) => {
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), W = cols * 4, H = rows * 4;
  let b = ''; for (let i = 0; i < n; i++) b += '<rect id="r' + i + '" x="' + (i % cols) * 4 + '" y="' + Math.floor(i / cols) * 4 + '" width="3" height="3" fill="' + hex(col(i)) + '"/>';
  const s = await scenario(W, H, svg(W, H, '', b));
  const res = { n, threw: s.threw, importMs: s.importMs, numShapes: s.numShapes };
  if (s.bundle) {
    const at = s.px(), bad = [];
    for (const i of probeSet(n)) { const g = at((i % cols) * 4 + 1, Math.floor(i / cols) * 4 + 1); if (!near(g, col(i))) bad.push(i + ':' + g + '!=' + col(i)); }
    res.bad = bad.slice(0, 6); res.badCount = bad.length; res.probes = probeSet(n).length;
    // the override table is a per-shape table too: hide + recolour rows past the first band
    const ov = api.createOverrideTable(s.gl, s.bundle);
    res.ovTexture = [ov.textureWidth, ov.textureHeight];
    const hi = n - 1, mid = Math.min(n - 2, 5000);   // two different rows, both past the first band when n > 4097; n = 4097 uses 4095
    ov.set('r' + hi, { visibility: 0 }); ov.set('r' + mid, { fill: [0, 0, 1, 1] });
    await s.draw({ overrides: ov });
    const at2 = s.px();
    const gh = at2((hi % cols) * 4 + 1, Math.floor(hi / cols) * 4 + 1), gm = at2((mid % cols) * 4 + 1, Math.floor(mid / cols) * 4 + 1);
    res.ovHidden = gh; res.ovBlue = gm;
    res.ovHiddenOk = gh[0] > 250 && gh[1] > 250 && gh[2] > 250;
    res.ovBlueOk = near(gm, [0, 0, 255]);
    const keep = at2(1, 1); res.ovKeepOk = near(keep, col(0));
    ov.dispose && ov.dispose();
    // drawBundleInstanced reads the same tables through its own program
    if (s.R.drawBundleInstanced) {
      s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundleInstanced(s.bundle, [{ worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }], {}); s.R.endFrame();
      const at3 = s.px(), bad3 = [];
      for (const i of [0, 4095, 4096, 4097, hi].filter((v) => v < n)) { const g = at3((i % cols) * 4 + 1, Math.floor(i / cols) * 4 + 1); if (!near(g, col(i))) bad3.push(i + ':' + g); }
      res.instancedBad = bad3;
    }
    // hit testing reads the CPU copy: the row past the band edge answers with its own id
    const hit = (i) => api.fillHitId(s.bundle, (i % cols) * 4 + 1.5, Math.floor(i / cols) * 4 + 1.5);
    res.hit = [hit(0), hit(4096), hit(hi)];
    res.hitOk = res.hit[0] === 'r0' && res.hit[1] === 'r' + Math.min(4096, n - 1) && res.hit[2] === 'r' + hi;
  }
  Object.assign(res, done(s));
  return res;
};

// ---- gradients: each shape a fill gradient and a stroke gradient, each its own colours (flat for t < 0.5)
window.__gradients = async (shapes) => {
  const cols = Math.ceil(Math.sqrt(shapes)), rows = Math.ceil(shapes / cols), W = cols * 8, H = rows * 8;
  let d = '', b = '';
  for (let i = 0; i < shapes; i++) {
    const a = col(i), s2 = col(i + 100003);
    d += '<linearGradient id="a' + i + '"><stop offset="0" stop-color="' + hex(a) + '"/><stop offset="0.5" stop-color="' + hex(a) + '"/><stop offset="1" stop-color="#ffffff"/></linearGradient>'
      + '<linearGradient id="b' + i + '"><stop offset="0" stop-color="' + hex(s2) + '"/><stop offset="0.5" stop-color="' + hex(s2) + '"/><stop offset="1" stop-color="#000000"/></linearGradient>';
    b += '<rect x="' + ((i % cols) * 8 + 2) + '" y="' + (Math.floor(i / cols) * 8 + 2) + '" width="4" height="4" fill="url(#a' + i + ')" stroke="url(#b' + i + ')" stroke-width="2"/>';
  }
  const s = await scenario(W, H, svg(W, H, d, b));
  const res = { shapes, gradientRows: s.gradientCount, threw: s.threw, importMs: s.importMs };
  if (s.bundle) {
    const at = s.px(), bad = [];
    for (const i of probeSet(shapes)) {
      const x0 = (i % cols) * 8, y0 = Math.floor(i / cols) * 8;
      const f = at(x0 + 3, y0 + 3), st = at(x0 + 1, y0 + 4);   // fill centre-left (t = 0.25: flat), stroke outside the bbox (t clamps to 0)
      if (!near(f, col(i), 4)) bad.push('fill ' + i + ':' + f + '!=' + col(i));
      if (!near(st, col(i + 100003), 4)) bad.push('stroke ' + i + ':' + st + '!=' + col(i + 100003));
    }
    res.bad = bad.slice(0, 6); res.badCount = bad.length;
  }
  Object.assign(res, done(s));
  return res;
};

// ---- dashes: line i has on-length 3 + (i % 10) + a tiny unique fraction, so every line owns a dash-table row
window.__dashes = async (n) => {
  const cols = 64, rows = Math.ceil(n / cols), W = cols * 16, H = rows * 4;
  const on = (i) => 3 + (i % 10) + (i / 50000) * 0.4;
  let b = ''; for (let i = 0; i < n; i++) {
    const x0 = (i % cols) * 16, y = Math.floor(i / cols) * 4 + 2;
    b += '<line x1="' + x0 + '" y1="' + y + '" x2="' + (x0 + 15) + '" y2="' + y + '" stroke="' + hex(col(i)) + '" stroke-width="2" stroke-dasharray="' + on(i).toFixed(5) + ' 100"/>';
  }
  const s = await scenario(W, H, svg(W, H, '', b));
  const res = { n, dashRows: s.dashCount, threw: s.threw, importMs: s.importMs };
  if (s.bundle) {
    const at = s.px(), bad = [];
    for (const i of probeSet(n)) {
      const x0 = (i % cols) * 16, y = Math.floor(i / cols) * 4 + 1, L = Math.floor(on(i));
      const pOn = at(x0 + L - 1, y), pOff = at(x0 + L + 1, y);
      if (!near(pOn, col(i), 4)) bad.push('on ' + i + ':' + pOn + '!=' + col(i));
      if (!(pOff[0] > 250 && pOff[1] > 250 && pOff[2] > 250)) bad.push('off ' + i + ':' + pOff + ' (dash ' + on(i).toFixed(3) + ')');
    }
    res.bad = bad.slice(0, 6); res.badCount = bad.length;
  }
  Object.assign(res, done(s));
  return res;
};

// ---- filters: filter i is a colour matrix that turns the (white) rect into colour(i); alpha is kept
window.__filters = async (n) => {
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), W = cols * 4, H = rows * 4;
  let d = '', b = '';
  for (let i = 0; i < n; i++) {
    const c = col(i).map((v) => (v / 255).toFixed(5));
    d += '<filter id="f' + i + '" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 ' + c[0] + '  0 0 0 0 ' + c[1] + '  0 0 0 0 ' + c[2] + '  0 0 0 1 0"/></filter>';
    b += '<rect x="' + (i % cols) * 4 + '" y="' + Math.floor(i / cols) * 4 + '" width="3" height="3" fill="#ffffff" filter="url(#f' + i + ')"/>';
  }
  const s = await scenario(W, H, svg(W, H, d, b));
  const res = { n, threw: s.threw, importMs: s.importMs };
  if (s.bundle) {
    const at = s.px(), bad = [];
    for (const i of probeSet(n)) { const g = at((i % cols) * 4 + 1, Math.floor(i / cols) * 4 + 1); if (!near(g, col(i), 4)) bad.push(i + ':' + g + '!=' + col(i)); }
    res.bad = bad.slice(0, 6); res.badCount = bad.length;
  }
  Object.assign(res, done(s));
  return res;
};

// ---- a multi-shape <mask> whose rows sit past the first band: the group mask takes the offscreen bake (R.render() / the unified draw),
// so the mask row-to-layer table (mrlAt) and the inline walk both read rows > 4095. maskBakes > 0 proves the bake ran.
window.__mask = async (filler) => {
  const W = 64, H = 64;
  let b = ''; for (let i = 0; i < filler; i++) b += '<rect x="' + (i % 4) + '" y="' + (i % 3) + '" width="1" height="1" fill="#eeeeee"/>';
  const defs = '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect x="0" y="0" width="64" height="64" fill="#000"/><rect x="0" y="0" width="32" height="64" fill="#fff"/></mask>';
  b += '<rect x="8" y="8" width="48" height="48" fill="#c22" mask="url(#m)"/>';
  const s = await scenario(W, H, svg(W, H, defs, b), 'mask', (R) => { R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' }); });
  const res = { filler, threw: s.threw, numShapes: s.numShapes };
  if (s.bundle) {
    const probe = (at) => ({ l1: at(20, 20), r1: at(48, 20), l2: at(20, 44), r2: at(48, 44) });
    const okOf = (q) => near(q.l1, [204, 34, 34], 4) && near(q.l2, [204, 34, 34], 4)
      && q.r1[0] > 250 && q.r1[1] > 250 && q.r1[2] > 250 && q.r2[0] > 250 && q.r2[1] > 250 && q.r2[2] > 250;
    const q1 = probe(s.px()); res.drawBundle = q1; res.drawOk = okOf(q1);
    res.bakesAfterDraw = s.R.debugStats ? s.R.debugStats.maskBakeCount : -1;
    if (s.R.drawBundleInstanced) {   // the instanced path bakes the mask once (bundleInstancedSmoke)
      s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundleInstanced(s.bundle, [{ worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }], {}); s.R.endFrame();
      const q3 = probe(s.px()); res.instanced = q3; res.instancedOk = okOf(q3);
    }
    if (s.R.setBundle && s.R.render) {
      s.R.beginFrame([1, 1, 1, 1]); s.R.endFrame();
      s.R.setBundle(s.bundle);
      for (let i = 0; i < 4; i++) { s.R.render(); await sleep(20); }
      const q2 = probe(s.px()); res.render = q2; res.renderOk = okOf(q2);
    }
    res.maskBakes = s.R.debugStats ? s.R.debugStats.maskBakeCount : -1;
    res.offscreenRows = s.R._handle ? (s.R._handle.maskRowToLayerTexSize | 0) : -1;
  }
  Object.assign(res, done(s));
  return res;
};

// ---- a morph between two bundles of more than 4096 rects: the merged meta table is lerped on the GPU / CPU
window.__morph = async (n) => {
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), W = cols * 4, H = rows * 4;
  const mk = (c0) => { let b = ''; for (let i = 0; i < n; i++) b += '<rect id="r' + i + '" x="' + (i % cols) * 4 + '" y="' + Math.floor(i / cols) * 4 + '" width="3" height="3" fill="' + hex(c0(i)) + '"/>'; return svg(W, H, '', b); };
  const cA = (i) => col(i), cB = (i) => [255 - col(i)[0], 255 - col(i)[1], 255 - col(i)[2]];
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.getElementById('host').appendChild(cv);
  const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const R = api.createRenderer(gl, shaders, {}); R.setViewport(W, H);
  const a = api.createBundle(gl, await api.importSvg(mk(cA), { preserveViewport: true }));
  const b = api.createBundle(gl, await api.importSvg(mk(cB), { preserveViewport: true }));
  window.__sim.violations = [];
  const res = { n }; const out = {};
  try {
    const m = api.createShapeMorph(gl, a, b, {});
    res.gpuMetaLerp = !!(m.bundle._morphSrc);
    for (const t of [0, 0.5, 1]) {
      m.setT(t);
      for (let k = 0; k < 4; k++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(m, {}); R.endFrame(); await sleep(20); }
      const p = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p);
      const bad = [];
      for (const i of [0, 4095, 4096, 4097, n - 1]) {
        const o = ((H - 1 - (Math.floor(i / cols) * 4 + 1)) * W + (i % cols) * 4 + 1) * 4;
        const A = cA(i), B = cB(i), want = A.map((v, k) => v * (1 - t) + B[k] * t);
        const g = [p[o], p[o + 1], p[o + 2]];
        if (Math.abs(g[0] - want[0]) > 4 || Math.abs(g[1] - want[1]) > 4 || Math.abs(g[2] - want[2]) > 4) bad.push('t' + t + ' i' + i + ':' + g + '!=' + want.map(Math.round));
      }
      out['t' + t] = bad;
    }
    m.dispose();
  } catch (e) { res.threw = String(e.stack || e).slice(0, 400); }
  res.bad = out;
  res.violations = window.__sim.violations.slice(0, 6);
  res.glErrors = []; let e; while ((e = gl.getError()) && res.glErrors.length < 8) res.glErrors.push(e);
  a.dispose(); b.dispose(); R.dispose(); cv.remove();
  return res;
};

// ---- the hard check: a table no device could hold throws, naming table, count and limit
window.__hardCheck = async () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 16; document.getElementById('host').appendChild(cv);
  const gl = cv.getContext('webgl2');
  const sec = await api.importSvg(svg(16, 16, '', '<rect width="8" height="8" fill="#c22"/>'), { preserveViewport: true });
  const lim = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const cap = 4096 * Math.floor(lim / 16);
  const fake = { ...sec, dashes: { byteLength: (cap + 1) * 256 } };
  let msg = null; try { api.createBundle(gl, fake); } catch (e) { msg = String(e.message); }
  const before = window.__sim.cap;
  window.__sim.cap = 2048; let small = null; try { api.createBundle(gl, sec); } catch (e) { small = String(e.message); }
  window.__sim.cap = before;
  const fine = (() => { try { const b = api.createBundle(gl, sec); b.dispose(); return true; } catch { return false; } })();
  cv.remove();
  return { lim, cap, msg, small, fine };
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
const port = server.address().port;
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const clean = (r, what) => {
  ok(!r.threw, `${what}: createBundle did not throw (${r.threw || ''})`);
  ok(r.glErrors.length === 0, `${what}: no GL error (${r.glErrors})`);
  ok(r.violations.length === 0, `${what}: no texture past the device limit (${r.violations})`);
};

for (const cap of CAPS) {
  const browser = await launchBrowser({
    headless: 'new',
    args:
      process.env.MANTLE_TEST_GL === 'swiftshader'
        ? ['--enable-unsafe-swiftshader', '--no-sandbox']
        : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    let pageErr = 0;
    page.on('pageerror', (e) => {
      pageErr++;
      console.error('[page-err]', e.message);
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
    const lim = await page.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      return g.getParameter(0x0d33);
    }); // before the cap is set: the real limit
    await page.evaluate((c) => {
      window.__sim.cap = c;
    }, cap);
    const eff = cap || lim;
    console.log(
      `\n== device MAX_TEXTURE_SIZE ${eff}${cap ? ' (simulated, real ' + lim + ')' : ''}`,
    );
    const run = (fn, ...a) => page.evaluate((f, args) => window[f](...args), fn, a);
    page.setDefaultTimeout(0);

    let r = await run('__rects', eff + 1);
    console.log(JSON.stringify({ ...r, bad: undefined }).slice(0, 400));
    clean(r, `${eff + 1} rects`);
    ok(r.numShapes === eff + 1, `${eff + 1} rects: ${r.numShapes} shapes`);
    ok(
      r.badCount === 0,
      `${eff + 1} rects: every probe (${r.probes}, across the band edges) shows its own color (${(r.bad || []).join('; ')})`,
    );
    ok(
      r.ovHiddenOk && r.ovBlueOk && r.ovKeepOk,
      `${eff + 1} rects: override rows past 4096 apply (hidden ${r.ovHidden}, blue ${r.ovBlue}; table ${r.ovTexture})`,
    );
    ok(
      !r.instancedBad || r.instancedBad.length === 0,
      `${eff + 1} rects: drawBundleInstanced reads the same table (${r.instancedBad})`,
    );
    ok(r.hitOk, `${eff + 1} rects: hit testing answers the right row (${r.hit})`);

    if (cap === 4096 || cap === 0 || process.env.TRL_BIG) {
      r = await run('__rects', 40000);
      console.log(JSON.stringify({ ...r, bad: undefined }).slice(0, 400));
      clean(r, '40000 rects');
      ok(
        r.badCount === 0,
        `40000 rects: every probe shows its own color (${(r.bad || []).join('; ')})`,
      );
    }

    const gs = Math.floor(eff / 2) + 2;
    r = await run('__gradients', gs);
    console.log(JSON.stringify({ ...r, bad: undefined }).slice(0, 400));
    clean(r, `${gs} shapes x 2 gradients`);
    ok(r.gradientRows > eff, `gradient table has ${r.gradientRows} rows (> ${eff})`);
    ok(
      r.badCount === 0,
      `${gs} shapes x 2 gradients: fill and stroke gradients all correct (${(r.bad || []).join('; ')})`,
    );

    r = await run('__dashes', eff + 1);
    console.log(JSON.stringify({ ...r, bad: undefined }).slice(0, 400));
    clean(r, `${eff + 1} dashed lines`);
    ok(r.dashRows > eff, `dash table has ${r.dashRows} rows (> ${eff})`);
    ok(
      r.badCount === 0,
      `${eff + 1} dashed lines: every probe has its own dash length (${(r.bad || []).join('; ')})`,
    );

    r = await run('__filters', eff + 1);
    console.log(JSON.stringify({ ...r, bad: undefined }).slice(0, 400));
    clean(r, `${eff + 1} filtered rects`);
    ok(
      r.badCount === 0,
      `${eff + 1} filtered rects: every probe shows its own filter's color (${(r.bad || []).join('; ')})`,
    );

    r = await run('__mask', 4100);
    console.log(JSON.stringify(r).slice(0, 400));
    clean(r, 'mask after 4100 shapes');
    ok(
      r.drawOk,
      `mask after 4100 shapes: drawBundle shows the masked half (${JSON.stringify(r.drawBundle)})`,
    );
    ok(
      r.instancedOk,
      `mask after 4100 shapes: drawBundleInstanced shows the masked half (${JSON.stringify(r.instanced)})`,
    );
    ok(
      r.renderOk,
      `mask after 4100 shapes: render() shows the masked half (${JSON.stringify(r.render)})`,
    );
    ok(
      r.maskBakes > 0,
      `mask after 4100 shapes: the offscreen bake ran (${r.maskBakes} bakes, mask row table ${r.offscreenRows} rows)`,
    );

    r = await run('__morph', 4200);
    console.log(JSON.stringify({ ...r, bad: undefined }).slice(0, 300));
    ok(!r.threw, `morph of 4200 rects: no throw (${r.threw || ''})`);
    ok(
      !r.violations.length && !r.glErrors.length,
      `morph of 4200 rects: no GL error / oversize texture (${r.glErrors} ${r.violations})`,
    );
    ok(
      r.bad && Object.values(r.bad).every((a) => a.length === 0),
      `morph of 4200 rects: t = 0, 0.5, 1 correct at rows across the band edge (${JSON.stringify(r.bad)})`,
    );

    const hc = await run('__hardCheck');
    ok(
      hc.msg &&
        /dash table/.test(hc.msg) &&
        new RegExp(String(hc.cap + 1)).test(hc.msg) &&
        new RegExp(String(hc.lim)).test(hc.msg),
      `a table beyond the device throws, naming table, count and limit (${hc.msg})`,
    );
    ok(
      hc.small && /MAX_TEXTURE_SIZE is 2048/.test(hc.small),
      `a 2048 device throws a clear error (${hc.small})`,
    );
    ok(hc.fine, 'a small bundle still builds');
    ok(pageErr === 0, 'no page errors');
  } finally {
    await browser.close();
  }
}
server.close();
if (fail) {
  console.log('\nTEXTURE-ROW-LIMITS FAIL');
  process.exit(1);
}
console.log('\nTEXTURE-ROW-LIMITS PASS');
