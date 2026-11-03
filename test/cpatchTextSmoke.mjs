// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchTextSmoke.mjs — CPatch renders TEXT, through the ordinary draw path.
//
// Three things have to be true at once:
//
//  1. The pooled conversion lands between frames and sets _cpatchRetry, and the draw re-asks;
//     otherwise a caller that prepared once (the documented way) draws Slug forever, and only a
//     probe that polls _cpatchConv and prepares a second time escapes it.
//  2. The LB auto-builder must not DECLINE when cpatchFill is set -- builders are a chain, so
//     declining hands the bundle to the next renderer's builder, which builds Loop-Blinn meshes
//     and claims it; CPatch's own claim then fails and it falls to Slug.
//  3. The build must not pass a FLAT tolPx of 0.05 to the converter, defeating defaultTolPx's
//     scale-relative bar. A text bundle is laid out in em -- about one unit across -- where 0.05
//     is a tenth of the artwork, so the decomposition coarsens until a tenth of the glyph is
//     covered by no patch at all (a single Roboto 'o' loses 1554 pixels of a 512px render).
//
// So this asserts the ROUTE (CPatch actually drew, not Slug under its name) and the INK (against
// the Slug render of the same text, which is what CPatch has to match).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { fontFixture, requireAsset } from './_assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FONT = requireAsset(fontFixture('roboto-regular.ttf'));
const ttf = Array.from(new Uint8Array(readFileSync(FONT)));
const N = 512;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const backend = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const grab = () => { const p = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a = new Uint8Array(${N}*${N}); for (let i=0;i<a.length;i++) a[i] = p[i*4]; return a; };
window.__run = async (ttf, text) => {
  const font = new MantleFontAsset(new Uint8Array(ttf));
  // ONE renderer per engine, and the CPatch one drawn through the ORDINARY path: prepare once,
  // then draw. No polling of _cpatchConv, no second prepareBundle -- that private handshake is
  // exactly what this is here to make unnecessary.
  const out = {};
  const run = async (opts, label, tweak) => {
    const r = createRenderer(gl, shaders, opts);
    if (tweak) tweak(r);
    const tb = await createTextBundle(gl, { font, text, style: { fontSize: 1, fill: [0,0,0,1] } });
    // PREPARE ONCE, THEN JUST DRAW FRAMES. Deliberately NOT awaitEngine: that helper performs the
    // two-phase prepare itself, so a test using it passes with the draw-time retry removed and
    // proves nothing about the path an embedder actually takes.
    r.prepareBundle(tb.bundle);
    if (!opts.cpatchFill && r.awaitLbReady) await r.awaitLbReady(tb.bundle);
    r.setViewport(${N}, ${N}); gl.viewport(0,0,${N},${N});
    let px = null, frames = 0;
    for (let f = 0; f < 200; f++) {
      r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame();
      px = grab(); frames = f + 1;
      const d = (r.debugStats.engines && r.debugStats.engines.draws) || {};
      if (!opts.cpatchFill || (d.cpatch | 0) > 0) break;
      await new Promise((z) => setTimeout(z, 10));
    }
    let ink = 0; for (let i=0;i<px.length;i++) if (px[i] < 128) ink++;
    out[label] = { px, ink, frames,
      draws: (r.debugStats.engines && r.debugStats.engines.draws) || {},
      key: r.debugStats.drawnFillVariantKey, glError: gl.getError() };
    tb.dispose && tb.dispose();
  };
  await run({}, 'slug');
  // A SECOND RENDERER WITH LOOP-BLINN FORCED ON, REGISTERED BEFORE THE CPATCH ONE. Builders are a
  // global CHAIN walked last-registered-first, so this is what turns a CPatch decline into an LB
  // build: CPatch's builder says "not me", the chain falls through to this one, it builds LB
  // meshes and CLAIMS the bundle, and CPatch's own build then fails its claim for good. Without a
  // second renderer here the chain has nobody to fall through to and the bug cannot appear -- which
  // is exactly why it survived: a single-renderer test never sees it.
  await run({}, 'lb', (r) => r.setLoopBlinnFill && r.setLoopBlinnFill('on'));
  await run({ cpatchFill: true, aacFill: false }, 'cpatch');
  // Disagreement against Slug, counted where it is a WHOLE pixel rather than an AA difference:
  // the engines antialias differently and always will, so only a solid/empty flip is a defect.
  const a = out.slug.px, b = out.cpatch.px;
  let flips = 0; for (let i=0;i<a.length;i++) if ((a[i] < 40) !== (b[i] < 40)) flips++;
  return { backend, slugInk: out.slug.ink, cpatchInk: out.cpatch.ink, flips, frames: out.cpatch.frames,
           key:out.cpatch.key, glError:out.cpatch.glError, slugDraws: out.slug.draws, cpatchDraws: out.cpatch.draws };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
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
  protocolTimeout: 600000,
});
const page = await browser.newPage();
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
let o = null;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 200 });
  o = await page.evaluate((t, s) => window.__run(t, s), ttf, process.env.CPTEXT || 'oooo');
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();

if (o) {
  console.log(
    '  ',
    JSON.stringify({
      backend: o.backend,
      slugInk: o.slugInk,
      cpatchInk: o.cpatchInk,
      flips: o.flips,
      slug: o.slugDraws,
      cpatch: o.cpatchDraws,
    }),
  );
  // THE ROUTE. A fallback renders CORRECTLY, so ink alone cannot tell CPatch from the Slug that
  // stood in for it -- the tally is the only thing that can, and for most of this engine's life it
  // said {"slug":1} under CPatch's name.
  const cpDrew = (o.cpatchDraws.cpatch | 0) > 0;
  if (cpDrew) ok(`CPatch drew the text itself (${JSON.stringify(o.cpatchDraws)})`);
  else fail(`CPatch did not draw — the tally says ${JSON.stringify(o.cpatchDraws)}`);
  if (o.key && o.key.split('|').includes('MANTLE_CPATCH')) ok('bound program hosts CPatch');
  else fail('bound program lacks CPatch: ' + o.key);
  if (o.glError === 0) ok('no GL error');
  else fail('GL error ' + o.glError);
  // Slug draws BEFORE the conversion lands are correct and expected -- that is the fallback doing
  // its job. What matters is that the wait ends: CPatch must take over within a bounded number of
  // frames rather than never.
  if (o.frames < 200) ok(`CPatch took over after ${o.frames} frame(s)`);
  else fail('CPatch never took over within 200 frames');
  // NON-VACUOUS: a blank frame has no flips either.
  if (o.slugInk > 2000) ok(`the reference frame has real ink (${o.slugInk} px)`);
  else fail(`Slug drew almost nothing (${o.slugInk} px) — the test proves nothing`);
  // THE INK BAR, set from both sides rather than picked. On this text a clean CPatch differs from
  // Slug on 46 solid/empty pixels -- the engines antialias differently and always will -- and the
  // flat-tolPx defect differs on 343. 0.5% of the ink sits at ~126: 2.7x above the clean
  // number and 2.7x below the defect, so it separates them with room on both sides.
  const bar = Math.max(40, Math.round(o.slugInk * 0.005));
  if (o.flips <= bar) ok(`CPatch matches Slug to ${o.flips} solid/empty pixel(s) (bar ${bar})`);
  else fail(`CPatch differs from Slug on ${o.flips} solid/empty pixels (bar ${bar})`);
  if (Math.abs(o.cpatchInk - o.slugInk) <= bar) ok(`ink agrees (${o.cpatchInk} vs ${o.slugInk})`);
  else fail(`ink disagrees: CPatch ${o.cpatchInk} vs Slug ${o.slugInk} (bar ${bar})`);
}
console.log(
  failures
    ? '\nCPATCH-TEXT FAIL'
    : '\ncpatchTextSmoke: CPatch renders text through the ordinary draw path',
);
process.exit(failures ? 1 : 0);
