// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// deviceLimitPlanesRenderSmoke -- the device-limit checks for the mask layer array, the stroke prim texture and the CPatch plane, on a SIMULATED small device
// (getParameter answers a smaller MAX_TEXTURE_SIZE / MAX_ARRAY_TEXTURE_LAYERS; texImage2D / texImage3D past the cap are recorded as
// violations and NOT performed, so an oversize plane is blank as on a device).
//   1. mask layer array: a bundle with 40 mask regions on a 16-layer device throws from drawBundle naming the count and the limit
//      (no GL error, no oversize allocation); at exactly 40 layers it draws every mask correctly; at 39 it throws.
//   2. incremental stroke prim texture: the stroke throws a clear error at the texel count its device cannot hold, BEFORE any state
//      changes; geometric growth never overshoots the limit (no oversize texImage2D); on the real device the same stroke draws.
//   3. CPatch plane: a CPatch build whose extended curve plane cannot fit the device declines (no oversize texImage2D, one warning,
//      the bundle still draws on the cover/Slug route) where an ample device builds it.
// The unified coefficient texture is structurally bounded (65535 blocks = 1024 rows) and checked at upload; see tableLayoutSmoke.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL =
  process.env.MANTLE_TEST_GL === 'swiftshader'
    ? ['--enable-unsafe-swiftshader', '--no-sandbox']
    : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><div id="host"></div>
<script type="module">
import * as api from '/src/index.js';
const P = WebGL2RenderingContext.prototype;
const sim = window.__sim = { capT: 0, capL: 0, violations: [] };
const MAXT = 0x0D33, MAXL = 0x88FF;
{
  const gp = P.getParameter;
  P.getParameter = function (p) { return (p === MAXT && sim.capT) ? sim.capT : (p === MAXL && sim.capL) ? sim.capL : gp.call(this, p); };
  const chk = (name, w, h) => { const c = sim.capT; if (c && (w > c || h > c)) { sim.violations.push(name + ' ' + w + 'x' + h); return false; } return true; };
  const ti = P.texImage2D; P.texImage2D = function (t, l, i, w, h, ...r) { return typeof h === 'number' && !chk('texImage2D', w, h) ? undefined : ti.call(this, t, l, i, w, h, ...r); };
  const t3 = P.texImage3D; P.texImage3D = function (t, l, i, w, h, d, ...r) {
    if (sim.capL && d > sim.capL) { sim.violations.push('texImage3D depth ' + d); return undefined; }
    return t3.call(this, t, l, i, w, h, d, ...r);
  };
}
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warns = []; api.setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
const mk = (W, H) => {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.getElementById('host').appendChild(cv);
  const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
  const R = api.createRenderer(gl, shaders, {}); R.setViewport(W, H);
  const px = () => { const p = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p); return (x, y) => { const o = ((H - 1 - y) * W + x) * 4; return [p[o], p[o + 1], p[o + 2]]; }; };
  return { cv, gl, R, px };
};
const errs = (gl) => { const e = []; let c; while ((c = gl.getError()) && e.length < 6) e.push(c); return e; };
const draw = async (s, b, n = 4) => { for (let i = 0; i < n; i++) { s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundle(b, {}); s.R.endFrame(); await sleep(20); } };

// ---- 1. mask regions
const M = 40;
const maskSvg = () => {
  const COLS = 8, W = COLS * 16, H = 5 * 16; let d = '', b = '';
  for (let i = 0; i < M; i++) {
    const x = (i % COLS) * 16, y = Math.floor(i / COLS) * 16;
    d += '<mask id="m' + i + '" maskUnits="userSpaceOnUse" x="' + x + '" y="' + y + '" width="16" height="16"><rect x="' + x + '" y="' + y + '" width="16" height="16" fill="#000"/><rect x="' + x + '" y="' + y + '" width="8" height="16" fill="#fff"/></mask>';
    b += '<rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="12" height="12" fill="#c22" mask="url(#m' + i + ')"/>';
  }
  return { W, H, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '"><defs>' + d + '</defs>' + b + '</svg>' };
};
window.__masks = async (capL) => {
  const { W, H, svg } = maskSvg();
  const s = mk(W, H); s.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const sec = await api.importSvg(svg, { preserveViewport: true });
  const b = api.createBundle(s.gl, sec);
  sim.capL = capL; sim.violations = []; while (s.gl.getError()) { /* drain */ }
  const out = { capL };
  try { await draw(s, b); } catch (e) { out.threw = String(e.message || e).slice(0, 300); }
  if (!out.threw) {
    const at = s.px(), bad = [];
    for (let i = 0; i < M; i++) {
      const x = (i % 8) * 16, y = Math.floor(i / 8) * 16;
      const l = at(x + 5, y + 8), r = at(x + 11, y + 8);
      if (!(Math.abs(l[0] - 204) <= 4 && Math.abs(l[1] - 34) <= 4)) bad.push(i + ':L' + l);
      if (!(r[0] > 250 && r[1] > 250 && r[2] > 250)) bad.push(i + ':R' + r);
    }
    out.bad = bad.slice(0, 6); out.badCount = bad.length;
  }
  out.glErrors = errs(s.gl); out.violations = sim.violations.slice(0, 4);
  sim.capL = 0; b.dispose(); s.cv.remove();
  return out;
};

// ---- 2. incremental stroke prim texture
window.__stroke = async (capT) => {
  const W = 96, H = 96, s = mk(W, H);
  sim.capT = capT; sim.violations = [];
  const st = s.R.createIncrementalStroke({ color: [0.8, 0.1, 0.1, 1], width: 3, bbox: [0, 0, W, H] });
  const out = { capT, appended: 0 };
  let k = 0;
  try {
    for (let c = 0; c < 1200; c++) {
      const pts = []; for (let i = 0; i < 100; i++, k++) pts.push([4 + (k % 88), 4 + ((k * 7) % 88)]);
      st.appendPoints(pts); out.appended = k;
      if (c % 5 === 0) { s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundle(st.bundle, {}); s.R.endFrame(); }
    }
  } catch (e) { out.threw = String(e.message || e).slice(0, 300); }
  // the stroke is still usable up to the failed append
  if (capT) sim.capT = capT;
  s.R.beginFrame([1, 1, 1, 1]); try { s.R.drawBundle(st.bundle, {}); } catch (e) { out.drawThrew = String(e.message).slice(0, 200); } s.R.endFrame();
  const at = s.px(); let ink = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y)[1] < 200) ink++;
  out.ink = ink; out.glErrors = errs(s.gl); out.violations = sim.violations.filter((v) => / 512x/.test(v)).slice(0, 4);   // the prim texture only
  sim.capT = 0; s.cv.remove();
  return out;
};

// ---- 3. CPatch plane
window.__cpatch = async (capAfter) => {
  const W = 96, H = 96, s = mk(W, H);
  s.R.setFillEngine({ route: 'cpatch' });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><path d="M48 8 C80 8 88 40 72 64 C60 84 36 88 24 68 C8 44 20 8 48 8 Z" fill="#2a6"/></svg>';
  const b = api.createBundle(s.gl, await api.importSvg(svg, { preserveViewport: true }));
  sim.capT = capAfter; sim.violations = []; warns.length = 0; while (s.gl.getError()) { /* drain */ }
  const out = { capAfter };
  try {
    s.R.prepareBundle(b);
    const dr = () => { s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundle(b, {}); s.R.endFrame(); };
    const rep = await s.R.warmScene([{ name: 'draw', draw: dr }], { maxPasses: 12, fenceTimeoutMs: 20000 });
    if (!rep.complete) throw new Error('incomplete warm');
    for (let i = 0; i < 60 && !(b._cpatchBuilt | 0) && !warns.some((w) => /CPatch/.test(w)); i++) { dr(); await sleep(50); }
    for (let i = 0; i < 3; i++) { dr(); await sleep(20); }
  } catch (e) { out.threw = String(e.message || e).slice(0, 300); }
  const at = s.px();
  out.center = at(48, 44); out.outside = at(2, 2);
  out.built = b._cpatchBuilt | 0; out.warns = warns.filter((w) => /CPatch/.test(w)).map((w) => w.slice(0, 160));
  out.glErrors = errs(s.gl); out.violations = sim.violations.slice(0, 4);
  sim.capT = 0; b.dispose(); s.cv.remove();
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
const browser = await launchBrowser({ headless: 'new', args: REAL });
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
try {
  const page = await browser.newPage();
  let pageErr = 0;
  page.on('pageerror', (e) => {
    pageErr++;
    console.log('  [pageerror]', e.message);
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const run = (fn, a) => page.evaluate((f, x) => window[f](x), fn, a);

  // 1. mask layers
  let r = await run('__masks', 16);
  console.log(JSON.stringify(r).slice(0, 300));
  ok(
    r.threw && /MAX_ARRAY_TEXTURE_LAYERS 16/.test(r.threw) && /\b40\b/.test(r.threw),
    `40 mask regions on a 16-layer device throw naming count and limit (${r.threw})`,
  );
  ok(
    !r.glErrors.length && !r.violations.length,
    `the 16-layer device saw no GL error and no oversize allocation (${r.glErrors} ${r.violations})`,
  );
  r = await run('__masks', 39);
  ok(
    r.threw && /MAX_ARRAY_TEXTURE_LAYERS 39/.test(r.threw),
    `a 39-layer device still throws for 40 regions (${r.threw})`,
  );
  r = await run('__masks', 40);
  console.log(JSON.stringify(r).slice(0, 300));
  ok(
    !r.threw && r.badCount === 0 && !r.glErrors.length && !r.violations.length,
    `a 40-layer device draws all 40 masks (bad ${r.badCount} ${(r.bad || []).join(';')} ${r.threw || ''})`,
  );
  r = await run('__masks', 0);
  ok(
    !r.threw && r.badCount === 0 && !r.glErrors.length,
    `the real device draws all 40 masks (bad ${r.badCount})`,
  );

  // 2. stroke prim texture
  r = await run('__stroke', 520);
  console.log(JSON.stringify(r).slice(0, 400));
  ok(
    r.threw && /prim texture needs/.test(r.threw) && /MAX_TEXTURE_SIZE 520/.test(r.threw),
    `a stroke past a 520-row device throws naming the texture and limit (${r.threw})`,
  );
  ok(
    !r.violations.length && !r.glErrors.length && !r.drawThrew,
    `growth up to the limit never allocates past it (520 rows is not a power of two, so doubling would overshoot), and the stroke still draws (${r.violations} ${r.glErrors} ${r.drawThrew || ''})`,
  );
  ok(r.ink > 500, `the 520-row device drew the stroke so far (${r.ink} ink px)`);
  r = await run('__stroke', 0);
  ok(
    !r.threw && r.appended === 120000 && !r.glErrors.length && r.ink > 500,
    `the real device takes all 120000 points (${r.appended}, ${r.threw || ''})`,
  );

  // 3. CPatch plane
  const base = await run('__cpatch', 0);
  console.log(JSON.stringify(base).slice(0, 300));
  ok(
    !base.threw && base.built > 0 && base.center[1] > 120 && base.outside[0] > 250,
    `ample device: CPatch builds (${base.built}) and the shape draws`,
  );
  r = await run('__cpatch', 2048);
  console.log(JSON.stringify(r).slice(0, 400));
  ok(
    !r.threw && r.built === 0 && r.warns.length === 1,
    `a plane that cannot fit declines CPatch with one warning (built ${r.built}, warns ${JSON.stringify(r.warns)})`,
  );
  ok(
    !r.violations.length && !r.glErrors.length,
    `the decline allocates nothing oversize and raises no GL error (${r.violations} ${r.glErrors})`,
  );
  ok(
    r.center[1] > 120 && r.outside[0] > 250,
    `the declined bundle still draws the shape on the cover/Slug route (${r.center})`,
  );
  ok(pageErr === 0, 'no page errors');
} finally {
  await browser.close();
  server.close();
}
if (fail) {
  console.log('\nDEVICE-LIMIT-PLANES FAIL');
  process.exit(1);
}
console.log('\nDEVICE-LIMIT-PLANES PASS');
