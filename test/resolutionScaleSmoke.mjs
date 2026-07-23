// resolutionScaleSmoke.mjs — setResolutionScale must cut the pixels, not the picture.
//
// Fill cost is LINEAR in backing-store pixels (measured across all three games: 2-5
// ms/Mpx). So the guaranteed-60fps lever is to render fewer of them and let the
// compositor scale the result to the same screen size. That is what this API is.
//
// Three things have to hold, and each one has been wrong in some renderer somewhere:
//   1. the backing store actually shrinks (scale 0.5 → a quarter of the pixels);
//   2. the SCENE still fills the canvas — it renders at lower resolution, it does not
//      render smaller in a corner;
//   3. the resize does not strand the canvas-sized resources. Nothing invalidated them:
//      the RT pools bucket by size, so a resize quietly allocated a fresh set and leaked
//      the old one, forever. A resolution scaler resizes constantly, so a leak here is
//      not academic.

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

// Filtered + plain content, so the resize has canvas-sized resources to strand.
const SCENE = readFileSync(new URL('../examples/smoke/resolutionScale__SCENE.svg', import.meta.url), 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 600, height: 500 });
page.on('pageerror', e => console.error('  [page-err]', e.message));

// Count live GL objects, so a resize that strands its render targets shows up.
await page.evaluateOnNewDocument(() => {
  globalThis.__live = { tex: 0, fbo: 0 };
  const P = WebGL2RenderingContext.prototype;
  const ct = P.createTexture; P.createTexture = function () { globalThis.__live.tex++; return ct.call(this); };
  const dt = P.deleteTexture; P.deleteTexture = function (t) { if (t) globalThis.__live.tex--; return dt.call(this, t); };
  const cf = P.createFramebuffer; P.createFramebuffer = function () { globalThis.__live.fbo++; return cf.call(this); };
  const df = P.deleteFramebuffer; P.deleteFramebuffer = function (f) { if (f) globalThis.__live.fbo--; return df.call(this, f); };
});
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const res = await page.evaluate(async (svg) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  // Give the canvas a real CSS box — setResolutionScale derives the backing store from it.
  cnv.style.width = '600px';
  cnv.style.height = '450px';
  cnv.width = 600; cnv.height = 450;

  const b = createBundle(gl, await importSvg(svg));
  const h = renderer.createBundleHandle(b);

  const frame = () => { renderer.beginFrame([1, 1, 1, 1]); h.draw({}); renderer.endFrame(); };
  // Ink COVERAGE as a fraction of the canvas — resolution-independent, so it tells us the
  // scene still FILLS the canvas rather than shrinking into a corner.
  const coverage = () => {
    const w = cnv.width, hh = cnv.height;
    const px = new Uint8Array(w * hh * 4);
    gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0, right = 0;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nonWhite = px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245;
      if (nonWhite) { ink++; if (x > w * 0.75) right++; }   // the shadowed card lives right
    }
    return { frac: ink / (w * hh), rightFrac: right / (w * hh) };
  };

  const out = { steps: [] };
  for (const s of [1, 0.5, 0.75, 1]) {
    const size = renderer.setResolutionScale(s, { dpr: 1 });
    for (let i = 0; i < 3; i++) frame();     // settle: bake caches at the new size
    const c = coverage();
    out.steps.push({ scale: s, size, cw: cnv.width, ch: cnv.height,
                     cssW: cnv.clientWidth, cssH: cnv.clientHeight,
                     frac: c.frac, rightFrac: c.rightFrac,
                     live: { ...globalThis.__live } });
  }
  h.dispose(); b.dispose();
  return out;
}, SCENE);

for (const s of res.steps) {
  console.log(`  scale ${s.scale}  backing ${s.cw}x${s.ch}  css ${s.cssW}x${s.cssH}  `
            + `ink ${(s.frac * 100).toFixed(1)}%  live tex ${s.live.tex} fbo ${s.live.fbo}`);
}
const [full, half, threeQ, back] = res.steps;

// 1. The backing store actually shrinks; the CSS box does not.
if (half.cw !== Math.round(full.cw * 0.5) || half.ch !== Math.round(full.ch * 0.5)) {
  fail(`scale 0.5 gave ${half.cw}x${half.ch}, expected half of ${full.cw}x${full.ch} — `
     + `the backing store is what costs, so if it didn't shrink, nothing was saved`);
} else if (half.cssW !== full.cssW || half.cssH !== full.cssH) {
  fail(`the CSS size changed (${full.cssW}x${full.cssH} → ${half.cssW}x${half.cssH}) — `
     + `the point is to render fewer pixels at the SAME screen size`);
} else {
  ok(`scale 0.5 quarters the pixels (${full.cw}x${full.ch} → ${half.cw}x${half.ch}) at the same CSS size`);
}

// 2. The scene still fills the canvas — lower resolution, not smaller.
for (const s of res.steps) {
  if (Math.abs(s.frac - full.frac) > 0.03) {
    fail(`at scale ${s.scale} the scene covers ${(s.frac * 100).toFixed(1)}% of the canvas vs `
       + `${(full.frac * 100).toFixed(1)}% at scale 1 — it is rendering SMALLER, not at lower `
       + `resolution. The scene must still fill the canvas.`);
  }
}
if (!failures) ok('the scene fills the canvas at every scale (coverage within 3%)');
if (full.rightFrac < 0.01) {
  fail(`the filtered card never rendered — this smoke would pass on a blank canvas`);
} else {
  ok(`the filtered card renders (right-hand ink ${(full.rightFrac * 100).toFixed(1)}%)`);
}

// 3. Returning to scale 1 must return to the same GL object count. Growth here means a
//    resize stranded its render targets — and a scaler resizes constantly.
const leak = back.live.tex - full.live.tex;
const leakFbo = back.live.fbo - full.live.fbo;
if (leak > 4 || leakFbo > 4) {
  fail(`after 1 → 0.5 → 0.75 → 1, live GL objects grew by ${leak} textures / ${leakFbo} FBOs. `
     + `A resize must drop everything sized to the old canvas — the RT pools bucket BY SIZE, `
     + `so without that they just allocate a fresh set and keep the old one forever.`);
} else {
  ok(`no resources stranded across three resizes (${leak >= 0 ? '+' : ''}${leak} tex, `
   + `${leakFbo >= 0 ? '+' : ''}${leakFbo} fbo)`);
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nRESOLUTION-SCALE PASS');
process.exit(failures ? 1 : 0);
