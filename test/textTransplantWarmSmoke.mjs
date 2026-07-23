// textTransplantWarmSmoke.mjs — a retyped text bundle must not hand its dead textures
// to the pipeline warmer.
//
// setText() rebuilds a text bundle by TRANSPLANTING a fresh bundle's GL objects into the
// existing bundle object (that is what keeps its identity stable). The fresh bundle is
// left behind as an empty shell — but createBundle had already enqueued it for
// fill-prewarm, so it sits in the PSO-warm queue with its fields still naming the
// textures the target now owns. The NEXT setText disposes the target, deleting exactly
// those textures, and the warmer then binds them:
//
//   WebGL: INVALID_OPERATION: bindTexture: attempt to use a deleted object
//
// Once per warm, for every text bundle a scene retypes — a score, a label, a timer. It
// spammed the console of a running game and nothing in the suite noticed, because the
// text smokes never ran the warmer and the warm smokes never retyped any text.
//
// Retype, warm, repeat — and require that nothing binds a texture we deleted.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const fontB64 = readFileSync(new URL('./font/fixtures/roboto-regular.ttf', import.meta.url)).toString('base64');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  const m = p.endsWith('.html') ? 'text/html'
    : (p.endsWith('.js') || p.endsWith('.mjs')) ? 'text/javascript'
    : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  let body;
  try { body = readFileSync(path.join(ROOT, p)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': m + '; charset=utf-8' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 500 });
page.on('pageerror', e => console.error('  [page-err]', e.message));

// Track every texture we delete, and flag anyone who binds one afterwards. Installed
// before the page's GL context exists.
await page.evaluateOnNewDocument(() => {
  globalThis.__deadBinds = [];
  const P = WebGL2RenderingContext.prototype;
  const dead = new WeakSet();
  const od = P.deleteTexture;
  P.deleteTexture = function (t) { if (t) dead.add(t); return od.call(this, t); };
  const ob = P.bindTexture;
  P.bindTexture = function (target, t) {
    if (t && dead.has(t)) {
      const st = (new Error().stack || '').split('\n').slice(1, 4)
        .map(l => l.trim().replace(/https?:\/\/[^/]+/g, '')).join(' <- ');
      globalThis.__deadBinds.push(st);
    }
    return ob.call(this, target, t);
  };
});
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const res = await page.evaluate(async (fontB64) => {
  const { createTextBundle, MantleFontAsset } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  cnv.width = 500; cnv.height = 400;
  renderer.setViewport(500, 400);

  const font = new MantleFontAsset(Uint8Array.from(atob(fontB64), c => c.charCodeAt(0)));
  const tb = await createTextBundle(gl, {
    font, text: '0', style: { fill: [1, 0, 0, 1], fontSizePx: 48 },
  });
  const h = renderer.createBundleHandle(tb.bundle);

  // ORDER MATTERS. Retype REPEATEDLY FIRST, with no warm in between: each setText leaves
  // a spent shell in the prewarm queue, and the NEXT one disposes the target — deleting
  // the very textures the earlier shells still name. Warming after each retype would find
  // those textures still alive and prove nothing; the warmer draining ONE bundle per
  // frame (which is what it does in a game) is exactly what lets a shell go stale.
  let drew = 0;
  for (let round = 0; round < 8; round++) await tb.setText(String(1000 + round * 137));
  // Now warm. The queue holds 8 shells, 7 of them naming deleted textures.
  if (renderer.precompileFills) renderer.precompileFills();
  for (let f = 0; f < 8; f++) {
    renderer.beginFrame([1, 1, 1, 1]);   // beginFrame also runs the per-frame warm tick
    h.draw({});
    renderer.endFrame();
    drew++;
  }
  const px = new Uint8Array(500 * 400 * 4);
  gl.readPixels(0, 0, 500, 400, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) ink++;
  h.dispose(); if (tb.dispose) tb.dispose();
  return { drew, ink, glErr: gl.getError(), deadBinds: globalThis.__deadBinds.slice(0, 5),
           deadCount: globalThis.__deadBinds.length };
}, fontB64);

{
  if (res.ink < 100) {
    fail(`the retyped text barely rendered (${res.ink}px) — a dead-texture bind would look `
       + `the same as this, so the check below proves nothing`);
  } else {
    ok(`retyped text renders after ${res.drew} transplant+warm rounds (${res.ink}px of ink)`);
  }
  if (res.deadCount > 0) {
    fail(`${res.deadCount} bind(s) of a DELETED texture after setText + pipeline warm. `
       + `transplantBundle leaves the fresh bundle as a shell whose fields still name the `
       + `textures the target adopted; it must be marked dead so the warm queues skip it.\n`
       + res.deadBinds.map(s => '      ' + s).join('\n'));
  } else {
    ok('no bind of a deleted texture (0)');
  }
  if (res.glErr !== 0) fail(`GL error ${res.glErr} after the transplant+warm rounds`);
  else ok('no GL error');
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nTEXT-TRANSPLANT-WARM PASS');
process.exit(failures ? 1 : 0);
