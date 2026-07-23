// instancedFogSmoke.mjs — a fog must stay on the instanced fast path.
//
// Highway Hazards' writeFog is
//     out.rgb = in.rgb * fog + fogColor * (1 - fog)
// a diagonal scale PLUS an RGB offset, per hazard. It expressed that as a per-instance
// colorMatrix + colorMatrixOffset — and ANY per-instance colour matrix or offset kicked the
// whole draw off the instanced fast path, collapsing a screen of hazards into one draw call
// EACH. The fragment maths was never the cost. The draw calls were.
//
// A diagonal matrix IS a tint; a diagonal matrix plus an offset is a tint plus a bias. The
// fast path now carries both as per-instance attributes.
//
// Two things must hold, and the second is the one that bites:
//   1. it takes the fast path (ONE drawArraysInstanced, not N draws);
//   2. it paints EXACTLY what the general per-instance loop paints — the loop composes the
//      same fog into a full colour matrix, so the two must agree pixel for pixel.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

// Count real GPU draw calls, so "it took the fast path" is measured, not assumed.
await page.evaluateOnNewDocument(() => {
  globalThis.__draws = 0; globalThis.__inst = 0;
  const P = WebGL2RenderingContext.prototype;
  const da = P.drawArrays;
  P.drawArrays = function (...a) { globalThis.__draws++; return da.apply(this, a); };
  const di = P.drawArraysInstanced;
  P.drawArraysInstanced = function (...a) { globalThis.__inst++; return di.apply(this, a); };
});
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const res = await page.evaluate(async () => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  const W = 600, H = 400; cnv.width = W; cnv.height = H;

  // This one is loaded INSIDE page.evaluate — browser context, where readFileSync and

  // import.meta do not exist. The smoke's own server already serves the package root.

  const SVG = await (await fetch('/examples/smoke/instancedFog__SVG.svg')).text();
  const b = createBundle(gl, await importSvg(SVG));

  // The fog, exactly as writeFog builds it: diagonal scale + RGB offset.
  const FOG_COLOR = [0.25, 0.45, 0.75];
  const mkFog = (fog) => {
    const m = new Float32Array(16);
    m[0] = fog; m[5] = fog; m[10] = fog; m[15] = 1;                       // diagonal scale
    const off = new Float32Array([FOG_COLOR[0] * (1 - fog), FOG_COLOR[1] * (1 - fog),
                                  FOG_COLOR[2] * (1 - fog), 0]);          // + colour offset
    return { colorMatrix: m, colorMatrixOffset: off };
  };
  const N = 6;
  const mkInstances = () => Array.from({ length: N }, (_, i) => {
    const fog = 1 - i * 0.15;
    return { worldMatrix: [0.28, 0, 0, 0, 0.28, 0, -0.75 + i * 0.3, 0, 1], ...mkFog(fog) };
  });

  const shot = () => { const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

  // FAST PATH (default).
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;
  globalThis.__draws = 0; globalThis.__inst = 0;
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundleInstanced(b, mkInstances());
  renderer.endFrame();
  const fast = shot();
  const fastCalls = { draws: globalThis.__draws, inst: globalThis.__inst };

  // THE LOOP (the general path), which composes the same fog into a full colour matrix.
  globalThis.__MANTLE_NO_INSTANCED_FAST = true;
  globalThis.__draws = 0; globalThis.__inst = 0;
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundleInstanced(b, mkInstances());
  renderer.endFrame();
  const loop = shot();
  const loopCalls = { draws: globalThis.__draws, inst: globalThis.__inst };
  globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;

  let diff = 0, worst = 0, ink = 0, fogged = 0;
  for (let i = 0; i < fast.length; i += 4) {
    const nonWhite = fast[i] < 245 || fast[i + 1] < 245 || fast[i + 2] < 245;
    if (nonWhite) ink++;
    // A fogged white square is tinted toward FOG_COLOR — bluer than it is red.
    if (nonWhite && fast[i + 2] > fast[i] + 25) fogged++;
    const d = Math.max(Math.abs(fast[i] - loop[i]), Math.abs(fast[i + 1] - loop[i + 1]),
                       Math.abs(fast[i + 2] - loop[i + 2]));
    if (d > 1) diff++;
    if (d > worst) worst = d;
  }
  b.dispose();
  return { diff, worst, ink, fogged, N, fastCalls, loopCalls };
});

console.log(`  fast path: ${res.fastCalls.inst} instanced + ${res.fastCalls.draws} plain draws   `
          + `loop: ${res.loopCalls.inst} instanced + ${res.loopCalls.draws} plain draws`);
console.log(`  ink ${res.ink}px   visibly fogged ${res.fogged}px   fast-vs-loop ${res.diff}px differ (worst ${res.worst})`);

if (res.ink < 2000) {
  fail(`the hazards barely rendered (${res.ink}px) — nothing below would prove anything`);
} else {
  ok(`the ${res.N} fogged instances render (${res.ink}px)`);
}
if (res.fogged < 500) {
  fail(`no instance is visibly fogged (${res.fogged}px tinted toward the fog colour) — the `
     + `OFFSET is being dropped, so a fog would render as a plain tint and this smoke would `
     + `pass on a bug`);
} else {
  ok(`the fog's OFFSET is applied (${res.fogged}px pulled toward the fog colour)`);
}
if (res.fastCalls.inst !== 1) {
  fail(`the fog did NOT take the instanced fast path: ${res.fastCalls.inst} instanced draws, `
     + `${res.fastCalls.draws} plain ones for ${res.N} instances. A diagonal colour matrix + `
     + `offset is a tint + bias and must stay instanced — otherwise a screen of hazards is `
     + `one draw call each.`);
} else {
  ok(`the fog stays on the fast path (1 drawArraysInstanced for ${res.N} instances)`);
}
if (res.diff > 0) {
  fail(`the fast path and the per-instance loop disagree by ${res.diff}px (worst ${res.worst}). `
     + `The loop composes the same fog into a full colour matrix; the fast path folds it into `
     + `a tint + bias. They must be the same picture.`);
} else {
  ok('the fast path paints exactly what the general loop paints (0px differ)');
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nINSTANCED-FOG PASS');
process.exit(failures ? 1 : 0);
