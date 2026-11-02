// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeOpenStrokePaintMorphSmoke.mjs — two things the native (no-WebGL)
// morph must get right, as the WebGL path does:
//
//   1. OPEN CONTOURS STAY OPEN. A `Z` appended to every subpath would give a
//      stroked open contour (a checkmark's tick, a viewfinder bracket) a
//      phantom edge back to its start — the tick would render as a triangle.
//      The header's freeEnd bit says which contours are open.
//   2. PAINT TWEENS. Lerping curves only, while the GL path also lerps the
//      morphable meta slots (fill RGBA, stroke RGBA, stroke width), a fade —
//      identical geometry, fill-opacity 0.2 → 1 — would snap from pose to pose
//      instead of fading. The rgba the morph writes
//      REPLACES the resolved paint (whose alpha already folded in the
//      authored fill-opacity), so the scene must neutralise that attribute
//      too or it multiplies in twice.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// An open stroked tick (3 points, 2 segments) that grows; plus a square
// whose fill fades in over identical geometry.
const TICK_A =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M20 50L45 75L80 25" fill="none" stroke="#ffffff" stroke-width="10"/></svg>';
const TICK_B =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 50L45 85L90 15" fill="none" stroke="#ffffff" stroke-width="10"/></svg>';
const FADE_A =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M20 20L80 20L80 80L20 80Z" fill="#ff0000" fill-opacity="0.2"/></svg>';
const FADE_B =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M20 20L80 20L80 80L20 80Z" fill="#ff0000" fill-opacity="1"/></svg>';

const HTML = `<!DOCTYPE html><html><body><div id="host"></div>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';

async function mount(a, b) {
  const src = await importSvg(a, { retainSource: true });
  const dst = await importSvg(b, { retainSource: true });
  const scene = createNativeScene(document.createElement('div'));
  scene.setViewport(100, 100);
  const morph = createNativeMorph(src, dst);
  const at = (t) => {
    morph.setT(t);
    scene.beginFrame([0, 0, 0, 1]);
    scene.drawBundle(morph.bundle, { overrides: morph.overrides });
    scene.endFrame();
    const el = scene.svg.querySelector('path');
    return el ? { d: el.getAttribute('d'), fill: el.getAttribute('fill'),
      fillOpacity: el.getAttribute('fill-opacity'), stroke: el.getAttribute('stroke') } : null;
  };
  return { morph, at };
}

const tick = await mount(${JSON.stringify(TICK_A)}, ${JSON.stringify(TICK_B)});
const fade = await mount(${JSON.stringify(FADE_A)}, ${JSON.stringify(FADE_B)});
window.__tick = (ts) => ts.map((t) => tick.at(t));
window.__fade = (ts) => ts.map((t) => fade.at(t));
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(b);
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
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const TS = [0, 0.25, 0.5, 0.75, 1];
const tick = await page.evaluate((ts) => window.__tick(ts), TS);
if (tick.every((r) => r && r.d)) ok('open-stroke morph decodes a path at every t');
else fail('no path decoded: ' + JSON.stringify(tick));

const closed = tick.filter((r) => r && /[Zz]/.test(r.d));
if (closed.length === 0) ok('open contour stays OPEN at every t (no Z appended)');
else
  fail(
    'open contour closed with Z — the tick renders as a triangle: ' +
      JSON.stringify(closed.map((r) => r.d)),
  );

// Geometry still tweens (the paint tween must not freeze it).
const firstX = tick.map((r) => parseFloat(r.d.match(/-?\d+(?:\.\d+)?/)[0]));
if (firstX[0] > firstX[4] && new Set(firstX.map((x) => Math.round(x))).size >= 4)
  ok('open contour still interpolates (start x ' + firstX.join(' → ') + ')');
else fail('open contour geometry not tweening: ' + firstX.join(','));

const fade = await page.evaluate((ts) => window.__fade(ts), TS);
const alpha = fade.map((r) => {
  const m = r && r.fill && r.fill.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/);
  return m ? Number(m[1]) : null;
});
if (alpha.every((a) => a != null)) ok('paint morph writes an rgba fill at every t');
else fail('no rgba fill written — paint is not tweening: ' + JSON.stringify(fade));

if (alpha[0] != null && Math.abs(alpha[0] - 0.2) < 0.02 && alpha[4] > 0.98)
  ok('fade endpoints: ' + alpha[0].toFixed(2) + ' → ' + alpha[4].toFixed(2));
else fail('fade endpoints wrong: ' + JSON.stringify(alpha));
if (alpha[2] != null && Math.abs(alpha[2] - 0.6) < 0.05)
  ok('t=0.5 fill alpha at the MIDPOINT (' + alpha[2].toFixed(2) + '), not snapped to a pose');
else fail('t=0.5 alpha ' + alpha[2] + ' — the fade snaps instead of tweening');

// The authored fill-opacity is already inside that rgba: left in place it would
// multiply in again and the fade would top out at the authored 0.2.
const stacked = fade.filter((r) => r.fillOpacity != null && Number(r.fillOpacity) !== 1);
if (stacked.length === 0)
  ok('authored fill-opacity neutralised — the rgba alpha is the whole fade');
else
  fail(
    'fill-opacity still multiplying the override: ' +
      JSON.stringify(stacked.map((r) => r.fillOpacity)),
  );

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeOpenStrokePaintMorphSmoke: all checks passed');
