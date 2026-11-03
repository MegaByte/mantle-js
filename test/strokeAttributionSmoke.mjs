// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeAttributionSmoke — a stroke is drawn by the STROKE path, and the engine ledger has to say so.
//
// debugStats.engines answers "which engine painted this frame", and every measurement that trusts
// it (the balance bench picks winners from it) inherits whatever it says. Attribution that asks one
// question -- "does this shape have an analytic mesh?" -- answers `no` for stroke rows and unshaded
// fills alike, and naming the cover kernel for both reports `slug` for a stroke row. On the tiger
// that is 78 stroke rows and ZERO cover-shaded fill rows: the fill combiner runs on nothing, and
// the frame would still report a Slug draw.
//
// What actually shades a stroke row is the stroke path -- caps, joins, dashes, the exact-area edge.
// It does take its DISTANCE from the same band walk Slug uses, so the two are not unrelated; what
// never runs is the fill combiner, which is precisely what the name `slug` asserted.
//
// Three bundles, because the failure is a CONFLATION and only a pair of opposite cases pins it:
// stroke-only must not report the fill kernel, fill-only must not report the stroke path, and a
// bundle with both must report both -- simply renaming slug to stroke passes the first case and
// fails the third.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const R = 192;

const svg = (body) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' + body + '</svg>';
// A CURVED stroke, so this is the real stroke path and not a line special case.
const CURVE = 'M20 96 C 44 24, 84 24, 108 96';
const CASES = {
  strokeOnly: svg(`<path d="${CURVE}" fill="none" stroke="#000" stroke-width="9"/>`),
  fillOnly: svg('<path d="M20 20 L108 20 L108 108 L20 108 Z" fill="#000"/>'),
  both: svg(
    '<path d="M16 16 L60 16 L60 60 L16 60 Z" fill="#000"/>' +
      `<path d="${CURVE}" fill="none" stroke="#000" stroke-width="9"/>`,
  ),
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, preserveDrawingBuffer:true, depth:true, stencil:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const CASES = ${JSON.stringify(CASES)};
const out = {};
for (const name of Object.keys(CASES)) {
  // psoWarmIdle: a variant is only USED once its pipeline is built, and that build waits for an
  // idle frame a test drawing back to back never has.
  const r = createRenderer(gl, shaders, { psoWarmIdle: () => true });
  r.setViewport(${R}, ${R});
  const b = createBundle(gl, await importSvg(CASES[name]));
  r.prepareBundle(b);
  if (r.awaitEngine) { try { await r.awaitEngine(b, 'none', 30000); } catch {} }
  const paint = () => { r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame(); };
  for (let w = 0; w < 32; w++) paint();
  paint();
  const px = new Uint8Array(${R} * ${R} * 4);
  gl.readPixels(0, 0, ${R}, ${R}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // INK BY COUNT, not by sample point. setViewport+drawBundle fit the CONTENT BBOX rather than the
  // viewBox 1:1, so a stroke-only bundle's curve is scaled to fill the canvas and viewBox
  // coordinates do not address it -- a point sample read 0 on a stroke that was plainly painted.
  let inkPx = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 128) inkPx++;
  const e = (r.debugStats.engines && r.debugStats.engines.draws) || {};
  const meta = b.metaFloats, st = b.metaFloatsPerShape | 0, n = b.numShapes | 0;
  let strokeRows = 0;
  for (let s = 0; s < n; s++) if (meta && st && meta[s * st + 11] > 0 && meta[s * st + 12] > 0) strokeRows++;
  out[name] = {
    engines: Object.keys(e).filter((k) => e[k] > 0).sort(),
    strokeRows,
    // So a pass here can never mean "attributed nothing because it painted nothing".
    inkPx,
  };
  b.dispose && b.dispose();
}
window.__out = out;
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
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  // Poll on a TIMER: waitForFunction polls inside requestAnimationFrame by default, and a headless
  // page that is not presenting never runs one.
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
console.log('  ', JSON.stringify(o));

const so = o.strokeOnly,
  fo = o.fillOnly,
  bo = o.both;
if (!so || !fo || !bo) {
  console.error('FAIL: missing results');
  process.exit(1);
}

// Not vacuous: each case has to have painted what it is being asked about.
for (const [nm, c] of [
  ['stroke-only', so],
  ['fill-only', fo],
  ['fill+stroke', bo],
]) {
  if (c.inkPx > 200) ok(`${nm} actually painted (${c.inkPx} px)`);
  else
    fail(`${nm} painted almost nothing (${c.inkPx} px) — the attribution below would be vacuous`);
}
if (so.strokeRows > 0) ok(`stroke-only has ${so.strokeRows} stroke row(s)`);
else fail('stroke-only has no stroke row — the fixture is wrong, not the renderer');

if (so.engines.includes('stroke'))
  ok(`stroke-only reports the stroke path (${so.engines.join('+')})`);
else fail(`stroke-only does not report 'stroke' — engines ${so.engines.join('+')}`);
if (!so.engines.includes('slug')) ok('stroke-only does NOT claim a Slug fill draw');
else fail(`stroke-only still reports 'slug' — engines ${so.engines.join('+')}`);
// The other half of the conflation: an analytic engine must not be credited either, when the
// bundle carries no analytic geometry at all.
if (!so.engines.includes('lb') && !so.engines.includes('cpatch'))
  ok('stroke-only credits no analytic engine');
else fail(`stroke-only credits an analytic engine that drew nothing — ${so.engines.join('+')}`);

if (!fo.engines.includes('stroke'))
  ok(`fill-only does not report a stroke (${fo.engines.join('+')})`);
else fail(`fill-only reports 'stroke' with no stroke row — engines ${fo.engines.join('+')}`);

// The case a rename would fail: both kinds present, both reported, neither swallowed.
if (bo.engines.includes('stroke') && bo.engines.length > 1)
  ok(`fill+stroke reports both (${bo.engines.join('+')})`);
else fail(`fill+stroke lost one side — engines ${bo.engines.join('+')}`);

console.log(
  '\nstrokeAttributionSmoke: a stroke row is reported as the stroke path, not as a fill kernel',
);
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
