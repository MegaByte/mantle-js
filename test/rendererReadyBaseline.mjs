// rendererReadyBaseline.mjs — verifies createRenderer's shader-readiness
// behavior under puppeteer + swiftshader:
//   • DEFAULT (sync): renderer fully usable on return, no `await ready`
//     needed (back-compat). Renders correctly.
//   • opts.asyncShaderCompile: defers link/uniform work behind a
//     non-blocking KHR_parallel_shader_compile poll; `ready` resolves;
//     renders correctly after await.
// Reports the createRenderer main-thread block time for each.
//
// Usage: node test/rendererReadyBaseline.mjs

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter></defs>
  <rect id="blurred" x="20" y="20" width="120" height="120" fill="#ff0000" filter="url(#b)"/>
  <rect id="plain"   x="150" y="150" width="40" height="40" fill="#00ff00"/>
</svg>`;

// The page exposes a single async function the driver calls per mode, so
// errors surface as a rejected evaluate() instead of a silent module hang.
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 200-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };

window.__run = async (mode) => {
  const t0 = performance.now();
  const renderer = createRenderer(gl, shaders, mode === 'async' ? { asyncShaderCompile: true } : {});
  const tSyncMs = performance.now() - t0;

  const hasReady = !!(renderer.ready && renderer.ready.then);
  // In sync mode, methods MUST be live immediately (no await). In async
  // mode they're stubbed until ready.
  const methodsLiveImmediately = typeof renderer.drawBundle === 'function';

  let tReadyMs = 0, readyTimedOut = false;
  if (mode === 'async') {
    const tr0 = performance.now();
    const res = await Promise.race([
      renderer.ready.then(() => 'ok'),
      new Promise(r => setTimeout(() => r('timeout'), 12000)),
    ]);
    tReadyMs = performance.now() - tr0;
    if (res === 'timeout') return { mode, tSyncMs, hasReady, methodsLiveImmediately, readyTimedOut: true };
  }

  const sections = await importSvg(${JSON.stringify(SVG)});
  const bundle = createBundle(gl, sections);
  const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
  renderer.setViewport(200, 200);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();

  return {
    mode, tSyncMs, hasReady, methodsLiveImmediately, tReadyMs,
    plainPx: sample(170, 170), blurredPx: sample(80, 80),
  };
};
window.__loaded = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try { res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('window.__loaded === true', { timeout: 30000 });

  const greenOK = (px) => px[1] > px[0] && px[1] > 80;
  const redOK   = (px) => px[0] > px[1] && px[3] > 10;

  // --- sync (default) ---
  const s = await page.evaluate('window.__run("sync")');
  console.log(`\n=== sync (default) ===  createRenderer block: ${s.tSyncMs.toFixed(1)} ms`);
  console.log('plain:', s.plainPx, '| blurred:', s.blurredPx);
  if (s.hasReady) ok('[sync] renderer.ready exists'); else fail('[sync] no renderer.ready');
  if (s.methodsLiveImmediately) ok('[sync] methods live on return (no await needed) — back-compat');
  else fail('[sync] methods NOT live on return — back-compat broken');
  if (greenOK(s.plainPx)) ok('[sync] plain rendered green'); else fail('[sync] plain not green: ' + s.plainPx);
  if (redOK(s.blurredPx)) ok('[sync] blurred rendered red'); else fail('[sync] blurred not red: ' + s.blurredPx);

  // --- async (opt-in) ---
  const a = await page.evaluate('window.__run("async")');
  console.log(`\n=== async (asyncShaderCompile) ===  createRenderer block: ${a.tSyncMs.toFixed(1)} ms` +
    (a.readyTimedOut ? '  [ready TIMED OUT]' : `  (ready awaited ${a.tReadyMs.toFixed(1)} ms)`));
  if (a.readyTimedOut) { fail('[async] renderer.ready never resolved'); }
  else {
    console.log('plain:', a.plainPx, '| blurred:', a.blurredPx);
    if (!a.methodsLiveImmediately) ok('[async] methods stubbed until ready (deferred)');
    else ok('[async] methods live (KHR absent → ran sync-equivalent)');
    if (greenOK(a.plainPx)) ok('[async] plain rendered green'); else fail('[async] plain not green: ' + a.plainPx);
    if (redOK(a.blurredPx)) ok('[async] blurred rendered red'); else fail('[async] blurred not red: ' + a.blurredPx);
    if (a.tSyncMs < s.tSyncMs) ok(`[async] createRenderer block lower than sync (${a.tSyncMs.toFixed(1)} < ${s.tSyncMs.toFixed(1)} ms) — stall deferred`);
    else console.log(`note: async block not lower (${a.tSyncMs.toFixed(1)} vs ${s.tSyncMs.toFixed(1)} ms) — driver may compile eagerly`);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
