// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbTextParitySmoke.mjs — a text run renders through the LB route matching Slug.
// Text bundles carry authoritative per-shape curve ranges (each glyph's
// _curveStartF) so curveRangeToContours reconstructs glyph contours correctly.
// Without them createBundle falls back to buildCurveRangesByShape (glyphLoc = a
// BAND index, not a curve offset) → the first glyphs come out unfilled /
// garbled and multi-glyph ranges corrupt.
//
// Explicit LB validates support and parity; automatic mode remains free to keep
// this high-coverage text on the faster coverage renderer.
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
const W = 900,
  H = 200;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(${W}, ${H});
// The coverage reference: the plain cover pass (router A*: 'auto' draws a static bundle there; setLoopBlinnFill('off') is a pinned unified-family program, 1/255 apart).
const plain = createRenderer(gl, shaders, { unifiedFill: false });
plain.setViewport(${W}, ${H});
window.__run = async (ttf, word) => {
  const font = new MantleFontAsset(new Uint8Array(ttf));
  const tb = await createTextBundle(gl, { font, text: word, style: { fontSize: 1, fill: [0,0,0,1] } }); renderer.prepareBundle(tb.bundle); await renderer.awaitLbReady(tb.bundle);
  const readCols = () => { const px = new Uint8Array(${W}*${H}*4); gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,px);
    const b = 14, bw = Math.floor(${W}/b), o = new Array(b).fill(0);
    for (let i=0;i<b;i++){ let s=0; for(let x=i*bw;x<(i+1)*bw;x++) for(let y=0;y<${H};y++){ const q=(y*${W}+x)*4; if(px[q]<200) s++; } o[i]=s; } return o; };
  const routed = () => renderer.debugStats.loopBlinnRouteCount + renderer.debugStats.loopBlinnMorphRouteCount;
  const draw = async (mode) => { const R = mode === 'off' ? plain : renderer; R.setLoopBlinnFill(mode); if (mode === 'on') { renderer.prepareBundle(tb.bundle); await renderer.awaitLbReady(tb.bundle); } const r0 = routed();   // (a static bundle builds its meshes when a pin asks, so wait for them before the measured draw)
    // Both arms are measured on their settled (lean) programs, not one on the general stand-in and the other on its variant: draw, build the variants, draw again.
    const frame = () => { R.beginFrame([1,1,1,1]); R.drawBundle(tb); R.endFrame(); };
    frame(); frame(); if (R.precompileFills) R.precompileFills(); frame();
    R.beginFrame([1,1,1,1]); R.drawBundle(tb); R.endFrame();
    return { cols: readCols(), routed: routed() - r0 }; };
  const slug = await draw('off');
  const auto = await draw('auto');
  const on = await draw('on');
  const tot = a => a.reduce((x,y)=>x+y,0);
  // per-band relative diff of on vs slug
  let maxBandRel = 0;
  for (let i=0;i<slug.cols.length;i++){ const s=slug.cols[i], l=on.cols[i]; if (s>50) maxBandRel = Math.max(maxBandRel, Math.abs(l-s)/s); }
  return { numShapes: tb.bundle.numShapes, slugTot: tot(slug.cols), autoTot: tot(auto.cols), onTot: tot(on.cols),
    autoRouted: auto.routed, onRouted: on.routed, maxBandRel: +maxBandRel.toFixed(3) };
};
window.__ready = true;
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
const port = server.address().port;

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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 20000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

for (const word of ['Reading files', 'oo']) {
  const o = await page.evaluate((t, w) => window.__run(t, w), ttf, word);
  console.log(`  [${word}] ` + JSON.stringify(o));
  // Correctness ('on' routes + matches Slug).
  if (o.onRouted > 0) ok(`[${word}] routes through LB on 'on'`);
  else fail(`[${word}] did not route LB on 'on'`);
  if (Math.abs(o.onTot - o.slugTot) <= o.slugTot * 0.03)
    ok(`[${word}] LB total ink matches Slug (${o.onTot} vs ${o.slugTot})`);
  else fail(`[${word}] LB total != Slug (${o.onTot} vs ${o.slugTot}) — glyph reconstruction`);
  if (o.maxBandRel <= 0.15)
    ok(`[${word}] every glyph band matches Slug (max band rel ${o.maxBandRel})`);
  else
    fail(
      `[${word}] a glyph band diverges (max band rel ${o.maxBandRel}) — first-glyph unfill / garble`,
    );
  if (o.autoRouted === 0 && o.autoTot === o.slugTot)
    ok(`[${word}] 'auto' keeps high-coverage text on the coverage fallback`);
  else
    fail(
      `[${word}] unexpected auto route/output (routes=${o.autoRouted}, ink=${o.autoTot}/${o.slugTot})`,
    );
}

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nlbTextParitySmoke: text reconstructs correctly under forced LB and auto fallback');
