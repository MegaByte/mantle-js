// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lifecycleRealContextRenderSmoke -- the GL halves of the lifecycle contract,
// on a real context with a real WEBGL_lose_context loss and restore. The CPU half is test/lifecycleContractSmoke.mjs.
//
//   a renderer that survives a real loss + restore throws a message that says to dispose and recreate (it does not draw blank with
//          GL 1282 every frame and no error), leaves the GL error queue clean, and a recreated renderer draws the same pixels as before the loss
//   awaitLbReady / awaitEngine resolve false for a lost / restored renderer
//   createMantleScene falls back to the native backend when the context is lost, and still throws when backend:'webgl' is forced
//   setBundle on a disposed renderer and a draw of a disposed bundle leave no handle behind and no GL error
//   updateBundleGeometry says ok:false while lost and for a stale bundle, and leaves no GL error
//   a frame between loseContext() and the lost event logs no "link failed"
//   prepareBundle + b.dispose() + r.dispose() leaves no GL error in the host's queue
//   setResolutionScale on a canvas with no CSS size does not compound
//   a disposed renderer is inert (second page): draw, R.dispose(), then drive the late-frame entries a framework unmount
//          leaves behind (beginFrame/drawBundle/endFrame, prepareBundle, createImage): nothing may throw, allocate GL buffers,
//          textures or programs, and createBundleHandle must refuse
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="20" y="20" width="60" height="60" fill="#c33"/></svg>`;
const SVG2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#00f"/><stop offset="1" stop-color="#0f0"/></linearGradient></defs><circle cx="50" cy="50" r="30" fill="url(#g)" stroke="#000" stroke-width="3"/></svg>`;
const STARS = (() => {
  const star = (i) => {
    const cx = 20 + (i % 20) * 40,
      cy = 20 + Math.floor(i / 20) * 40;
    let d = '';
    for (let k = 0; k < 10; k++) {
      const a = (k * Math.PI) / 5,
        r = k % 2 ? 7 : 17;
      d +=
        (k ? 'L' : 'M') +
        (cx + r * Math.cos(a)).toFixed(2) +
        ' ' +
        (cy + r * Math.sin(a)).toFixed(2);
    }
    return (
      '<path d="' +
      d +
      'Z" fill="hsl(' +
      ((i * 7) % 360) +
      ',70%,50%)" stroke="#000" stroke-width="1.5"/>'
    );
  };
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800">' +
    Array.from({ length: 400 }, (_, i) => star(i)).join('') +
    '</svg>'
  );
})();
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="128" height="128"></canvas><canvas id="c2" width="64" height="64"></canvas><canvas id="c3" width="64" height="64"></canvas>
<script type="module">
const P = WebGL2RenderingContext.prototype; const made = {};
for (const k of ['Texture', 'Framebuffer', 'Buffer', 'VertexArray', 'Program']) { const mk = P['create' + k]; P['create' + k] = function (...a) { made[k] = (made[k] || 0) + 1; return mk.apply(this, a); }; }
const snap = () => ({ ...made }); const delta = (a) => { const o = {}; for (const k of Object.keys(made)) if ((made[k] || 0) - (a[k] || 0)) o[k] = made[k] - (a[k] || 0); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = (gl) => { const e = []; let c; while ((c = gl.getError()) && e.length < 20) if (c !== 37442) e.push(c); return e; };   // 37442 = CONTEXT_LOST_WEBGL, which a lost context reports once by design
const px = (gl, x, y) => { const p = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return Array.from(p); };
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
const diag = []; api.setDiagnostics({ onError: (...a) => diag.push(a.join(' ').slice(0, 600)), onWarn: () => {} });
const out = {};
// ---- prepareBundle, dispose both, then the host's own getError. FIRST in the page: it needs programs that are still linking, and a
// program the driver has linked before (an earlier renderer) comes back instantly. ----
{
  const c5 = document.createElement('canvas'); c5.width = c5.height = 256; document.body.appendChild(c5);
  const g5 = c5.getContext('webgl2'); const sec5 = await api.importSvg(${JSON.stringify(STARS)}, { preserveViewport: true });
  const res = {};
  for (const name of ['prepare', 'warmScene']) {
    const r5 = api.createRenderer(g5, shaders, {}); r5.setViewport(256, 256); const b5 = api.createBundle(g5, sec5);
    errs(g5);
    if (name === 'prepare') r5.prepareBundle(b5); else r5.warmScene([{ name: 'a', bundle: b5, draw: () => frame(r5, b5) }], { maxPasses: 3 });
    if (name !== 'prepare') await sleep(30);
    errs(g5);   // a host that polls getError (a round trip to the GPU process) while the link is in flight; without it the link and the delete race differently
    b5.dispose(); r5.dispose();
    res[name] = errs(g5);   // right after the dispose...
    await sleep(700);
    res[name] = res[name].concat(errs(g5));   // ...and once the driver has had time to finish what was in flight
  }
  out.stickyErrors = res;
}

const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const lose = gl.getExtension('WEBGL_lose_context');
const sec = await api.importSvg(${JSON.stringify(SVG)});
const frame = (r, b, o) => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(b, o || {}); r.endFrame(); };

// ---- a real loss and restore ----
const ev = [];
let r = api.createRenderer(gl, shaders, { onContextLost: () => ev.push('lost'), onContextRestored: () => ev.push('restored') });
r.setViewport(128, 128);
let b = api.createBundle(gl, sec);
for (let i = 0; i < 5; i++) { frame(r, b); await sleep(20); }
out.before = px(gl, 64, 64); out.beforeErrs = errs(gl);
const handle = r.createBundleHandle(b);
const pendingLb = r.awaitLbReady(b, 5000);
lose.loseContext(); await sleep(60);
out.lost = { isContextLost: r.isContextLost, needsRecreate: r.needsRecreate };
out.pendingLbAfterLoss = await pendingLb;
out.awaitWhileLost = [await r.awaitLbReady(b, 100), await r.awaitEngine(b, 'lb', 100), await r.awaitEngine(b, 'slug', 100)];
try { r.precompileFills(); out.precompileWhileLost = 'returned'; } catch (e) { out.precompileWhileLost = String(e.message).slice(0, 80); }
lose.restoreContext(); await sleep(400);
out.events = ev.slice();
out.restored = { isContextLost: r.isContextLost, needsRecreate: r.needsRecreate };
out.restoredThrows = []; out.restoredErrs = [];
for (let i = 0; i < 4; i++) { try { frame(r, b); out.restoredThrows.push(null); } catch (e) { out.restoredThrows.push(String(e.message).slice(0, 600)); } out.restoredErrs.push(errs(gl)); await sleep(20); }
out.handleAfterRestore = []; for (let i = 0; i < 3; i++) { try { handle.draw({}); out.handleAfterRestore.push('ok'); } catch (e) { out.handleAfterRestore.push(/dispose/.test(e.message) ? 'throws' : e.message); } }
out.handleErrs = errs(gl);
out.awaitAfterRestore = [await r.awaitLbReady(b, 100), await r.awaitEngine(b, 'lb', 100)];
out.errorLogged = diag.filter((m) => /dispose/.test(m)).length;
const upd = (() => { const mk = (x) => [api.mkLine([x, 10], [x + 40, 10]), api.mkLine([x + 40, 10], [x + 40, 50]), api.mkLine([x + 40, 50], [x, 50]), api.mkLine([x, 50], [x, 10])];
  return { mk, sec: api.buildStreamableSections([{ segs: mk(10), fill: [1, 0, 0, 1] }], [0, 0, 128, 128]) }; })();
// a bundle from before the loss, after the restore (made now, on the new context, then compared with a stale one)
out.updateStale = (() => { errs(gl); const res = api.updateBundleGeometry(gl, b, [upd.mk(20)]); return { ok: res.ok, reason: res.reason || null, errs: errs(gl) }; })();
// recreate, as documented
r.dispose(); b.dispose();
r = api.createRenderer(gl, shaders, {}); r.setViewport(128, 128); b = api.createBundle(gl, sec);
errs(gl);
for (let i = 0; i < 5; i++) { frame(r, b); await sleep(20); }
out.after = px(gl, 64, 64); out.afterErrs = errs(gl); out.afterState = { isContextLost: r.isContextLost, needsRecreate: r.needsRecreate };
out.updateFresh = api.updateBundleGeometry(gl, api.createBundle(gl, upd.sec), [upd.mk(20)]).ok;
r.dispose(); b.dispose();

// ---- while lost (a second context) ----
{
  const c2 = document.getElementById('c2'); const g2 = c2.getContext('webgl2'); const l2 = g2.getExtension('WEBGL_lose_context');
  const b2 = api.createBundle(g2, upd.sec);
  errs(g2);
  l2.loseContext();
  const pend = api.updateBundleGeometry(g2, b2, [upd.mk(25)]);
  await sleep(60);
  const lost = api.updateBundleGeometry(g2, b2, [upd.mk(25)]);
  out.updateLost = { pending: { ok: pend.ok, reason: pend.reason || null }, lost: { ok: lost.ok, reason: lost.reason || null }, errs: errs(g2) };
  l2.restoreContext(); await sleep(300);
}

// ---- createMantleScene on a lost context falls back to native ----
{
  const c3 = document.getElementById('c3'); const g3 = c3.getContext('webgl2'); g3.getExtension('WEBGL_lose_context').loseContext();
  await sleep(60);
  const o = {};
  try { const sc = await api.createMantleScene(c3, {}); o.backend = sc.backend; if (sc.dispose) sc.dispose(); } catch (e) { o.threw = String(e.message).slice(0, 100); }
  try { await api.createMantleScene(c3, { backend: 'webgl' }); o.forced = 'returned'; } catch (e) { o.forced = 'threw: ' + String(e.message).slice(0, 80); }
  out.autoScene = o;
}

// ---- disposed renderer / disposed bundle ----
{
  const g = gl; const rr = api.createRenderer(g, shaders, {}); rr.setViewport(128, 128);
  const live = api.createBundle(g, sec); const dead = api.createBundle(g, await api.importSvg(${JSON.stringify(SVG2)}));
  for (let i = 0; i < 4; i++) frame(rr, live);
  frame(rr, dead); dead.dispose(); errs(g);
  const a = snap();
  for (let i = 0; i < 10; i++) frame(rr, dead);
  out.deadBundle = { alloc: delta(a), errs: errs(g), centerKeepsClear: px(g, 64, 64) };
  rr.dispose();
  const s = snap(); const extra = [];
  for (let i = 0; i < 10; i++) { const x = api.createBundle(g, sec); const t = snap(); rr.setBundle(x); extra.push(JSON.stringify(delta(t))); x.dispose(); }
  out.setBundleDisposedRenderer = { distinct: [...new Set(extra)], errs: errs(g) };
  live.dispose();
}

// ---- a frame in the window between loseContext() and the lost event ----
{
  const c4 = document.createElement('canvas'); c4.width = c4.height = 64; document.body.appendChild(c4);
  const g4 = c4.getContext('webgl2'); const l4 = g4.getExtension('WEBGL_lose_context');
  const r4 = api.createRenderer(g4, shaders, {}); r4.setViewport(64, 64);
  const b4 = api.createBundle(g4, await api.importSvg(${JSON.stringify(SVG2)}));
  r4.prewarmBundle(b4);
  diag.length = 0;
  l4.loseContext();
  for (let i = 0; i < 3; i++) { try { frame(r4, b4); r4.precompileFills(); } catch (e) { /* lost renderers may refuse */ } }
  await sleep(100);
  out.windowLinkErrors = diag.filter((m) => /link failed/.test(m)).length;
  r4.dispose(); b4.dispose();
}

// ---- setResolutionScale does not compound on an unstyled canvas ----
{
  const c6 = document.createElement('canvas'); c6.width = c6.height = 100; document.body.appendChild(c6);
  const g6 = c6.getContext('webgl2'); const r6 = api.createRenderer(g6, shaders, {});
  const sizes = [];
  for (const s of [2, 4, 1, 0.5, 1e6, 1]) { r6.setResolutionScale(s); sizes.push([c6.width, c6.clientWidth]); }
  out.resScale = sizes; r6.dispose();
}
window.__out = out; window.__ready = true;
</script></body></html>`;
const DISPOSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><circle cx="50" cy="50" r="30" fill="#c33" filter="url(#f)"/><path d="M10 10 C60 0 90 40 50 90 Z" fill="#36c"/></svg>`;
const DISPOSE_HTML = `<!DOCTYPE html><html><body><canvas id="c" width="128" height="128"></canvas>
<script type="module">
const P = WebGL2RenderingContext.prototype; const made = { buf: 0, tex: 0, prog: 0, vao: 0 };
for (const [mk, k] of [['createBuffer', 'buf'], ['createTexture', 'tex'], ['createProgram', 'prog'], ['createVertexArray', 'vao']]) {
  const a = P[mk]; P[mk] = function () { made[k]++; return a.call(this); };
}
const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const r = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
r.setViewport(128, 128);
const b = createBundle(gl, await importSvg(${JSON.stringify(DISPOSE_SVG)}));
const frame = () => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(b, {}); r.endFrame(); };
for (let i = 0; i < 6; i++) { frame(); await new Promise((x) => setTimeout(x, 20)); }
const px = new Uint8Array(4); gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
const out = { drawn: Array.from(px) };
r.dispose(); r.dispose();
const before = { ...made }; out.errors = [];
const t = (n, f) => { try { f(); } catch (e) { out.errors.push(n + ': ' + e.message); } };
t('frame', frame); t('frame2', frame); t('prepare', () => r.prepareBundle(b)); t('image', () => { out.image = r.createImage(document.getElementById('c'), {}); });
try { r.createBundleHandle(b); out.handleThrew = false; } catch { out.handleThrew = true; }
out.allocated = { buf: made.buf - before.buf, tex: made.tex - before.tex, prog: made.prog - before.prog, vao: made.vao - before.vao };
window.__out = out; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    if (req.url === '/dispose') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DISPOSE_HTML);
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
      : ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
});
const page = await browser.newPage();
let pageErr = 0;
page.on('pageerror', (e) => {
  pageErr++;
  console.error('[page-err]', e.message);
});
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const o = await page.evaluate(() => window.__out);
// The disposed-renderer case, on its own page (it counts allocations from a fresh prototype patch).
const disposePage = await browser.newPage();
let disposePageErr = 0;
disposePage.on('pageerror', (e) => {
  disposePageErr++;
  console.error('[page-err]', e.message);
});
await disposePage.goto(`http://127.0.0.1:${server.address().port}/dispose`, {
  waitUntil: 'load',
  timeout: pageTimeoutFor(),
});
await disposePage.waitForFunction(() => window.__ready === true, {
  timeout: pageTimeoutFor(),
  polling: 100,
});
const disposeOut = await disposePage.evaluate(() => window.__out);
await browser.close();
server.close();
console.log(JSON.stringify(o));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const red = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90;
ok(pageErr === 0, 'no page errors');
ok(
  red(o.before) && o.beforeErrs.length === 0,
  `drew before the loss (${o.before}), no GL errors (${o.beforeErrs})`,
);
ok(
  o.lost.isContextLost === true && o.lost.needsRecreate === false,
  'lost: isContextLost true, needsRecreate false',
);
ok(
  o.pendingLbAfterLoss === false && o.awaitWhileLost.every((v) => v === false),
  `awaitLbReady / awaitEngine resolve false while lost (${o.pendingLbAfterLoss}, ${o.awaitWhileLost})`,
);
ok(
  /lost/.test(o.precompileWhileLost),
  `precompileFills throws while lost (${o.precompileWhileLost})`,
);
ok(o.events.join() === 'lost,restored', `both hooks ran (${o.events})`);
ok(
  o.restored.isContextLost === true && o.restored.needsRecreate === true,
  'restored: still isContextLost, needsRecreate true',
);
ok(
  o.restoredThrows.every((m) => m && /dispose/.test(m) && /new renderer/.test(m)),
  `every frame after the restore throws the recreate message (${o.restoredThrows.map((m) => (m ? 'throw' : 'ok'))})`,
);
ok(
  o.restoredErrs.every((e) => e.length === 0),
  `and no frame leaves a GL error in the queue (${JSON.stringify(o.restoredErrs)})`,
);
ok(
  o.handleAfterRestore.every((v) => v === 'throws') && o.handleErrs.length === 0,
  `a resident handle's draw throws after the restore and leaves no GL error (${o.handleAfterRestore}, errors ${o.handleErrs})`,
);
ok(
  o.awaitAfterRestore.every((v) => v === false),
  `awaits resolve false after the restore (${o.awaitAfterRestore})`,
);
ok(o.errorLogged === 1, `one error is logged for the restore (${o.errorLogged})`);
ok(
  o.updateStale.ok === false &&
    /context loss/.test(o.updateStale.reason) &&
    o.updateStale.errs.length === 0,
  `updateBundleGeometry on a pre-loss bundle: ok:false, no GL error (${JSON.stringify(o.updateStale)})`,
);
ok(
  red(o.after) &&
    o.afterErrs.length === 0 &&
    o.afterState.isContextLost === false &&
    o.afterState.needsRecreate === false,
  `a recreated renderer draws the same picture (${o.after}) with a clean error queue (${o.afterErrs})`,
);
ok(o.updateFresh === true, 'updateBundleGeometry works on a bundle made after the restore');
ok(
  o.updateLost.pending.ok === false &&
    o.updateLost.lost.ok === false &&
    o.updateLost.errs.length === 0,
  `updateBundleGeometry with a loss pending and while lost: ok:false, no GL error (${JSON.stringify(o.updateLost)})`,
);
ok(
  o.autoScene.backend === 'native' && /webgl|WebGL|lost/.test(o.autoScene.forced),
  `createMantleScene on a lost context falls back to native; backend:'webgl' still throws (${JSON.stringify(o.autoScene)})`,
);
ok(
  Object.keys(o.deadBundle.alloc).length === 0 && o.deadBundle.errs.length === 0,
  `drawing a disposed bundle x10 allocates nothing and raises no GL error (${JSON.stringify(o.deadBundle)})`,
);
ok(
  o.setBundleDisposedRenderer.distinct.length === 1 &&
    o.setBundleDisposedRenderer.distinct[0] === '{}' &&
    o.setBundleDisposedRenderer.errs.length === 0,
  `setBundle on a disposed renderer x10 allocates nothing (${JSON.stringify(o.setBundleDisposedRenderer)})`,
);
ok(
  o.windowLinkErrors === 0,
  `a frame in the loss window logs no "link failed" (${o.windowLinkErrors})`,
);
ok(
  o.stickyErrors.prepare.length === 0 && o.stickyErrors.warmScene.length === 0,
  `no sticky GL error after prepareBundle / warmScene + dispose (${JSON.stringify(o.stickyErrors)})`,
);
ok(
  o.resScale.every(([w, c]) => c === 100) &&
    o.resScale[1][0] === 400 &&
    o.resScale[2][0] === 100 &&
    o.resScale[3][0] === 50 &&
    o.resScale[4][0] === 400 &&
    o.resScale[5][0] === 100,
  `setResolutionScale keeps the CSS size and does not compound (${JSON.stringify(o.resScale)})`,
);
const lifecycleFail = fail;
{
  const o = disposeOut,
    pageErr = disposePageErr;
  console.log(JSON.stringify(o));
  ok(pageErr === 0, 'no page errors');
  ok(
    o.drawn[3] > 0 && o.drawn[0] + o.drawn[1] + o.drawn[2] < 765,
    `the renderer drew before dispose (${o.drawn})`,
  );
  ok(o.errors.length === 0, `late draw entries do not throw (${o.errors.join('; ')})`);
  ok(
    o.allocated.buf === 0 &&
      o.allocated.tex === 0 &&
      o.allocated.prog === 0 &&
      o.allocated.vao === 0,
    `a draw after dispose allocates nothing (${JSON.stringify(o.allocated)})`,
  );
  ok(o.handleThrew === true, 'createBundleHandle on a disposed renderer throws');
  ok(o.image == null, 'createImage on a disposed renderer returns null');
  if (fail > lifecycleFail) console.log('\nRENDERER-DISPOSE-THEN-DRAW FAIL');
  else console.log('\nRENDERER-DISPOSE-THEN-DRAW PASS');
}
if (fail) {
  console.log('\nLIFECYCLE-REAL-CONTEXT FAIL');
  process.exit(1);
}
console.log('\nLIFECYCLE-REAL-CONTEXT PASS');
