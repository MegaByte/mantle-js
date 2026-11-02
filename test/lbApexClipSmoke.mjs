// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbApexClipSmoke.mjs — over-painting Bezout crescents do not make tiger decline.
//
// An over-painting crescent is handled by the face PROOF (lbPartition), hull CONTAINMENT splitting,
// and dropping all-air faces, not by clipping it back to the chord side of its arc's apex tangent and
// re-checking: such a re-check is the same ten hull samples that miss the over-paint to begin with,
// and a clipped shape still paints outside its own path. Together they take tiger to essentially no
// declines.
//
// So this asserts that invariant: the fixture declines essentially nothing. If the decline count
// climbs, something in the gate is broken and this fails.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
import { example, requireAsset } from './_assets.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// examples/tiger.svg is gitignored, so a fresh checkout does not have it. Say so and stop, rather than dying on ENOENT
// and reading as a failure.
const TIGER = requireAsset(example('tiger.svg'));
const SVG = readFileSync(TIGER, 'utf8');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
// A SENTINEL IS A ROUTING ANSWER, NOT AN ATTRIBUTION. Counting the entries of _lbMeshes that are
// not a mesh reports "the builder gave up on this shape" for five different outcomes, three of
// which never attempted it -- so the decline statistic this file is named for could climb without
// a single shape declining. lbMeshCensus splits them (src/renderer/lbBuildCore.js).
import { lbMeshCensus } from '/src/renderer/lbBuildCore.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(256, 256);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const meshes = bundle._lbMeshes || [];
let real = 0, sent = 0; for (const m of meshes) { if (m && m.vertexCount) real++; else sent++; }
window.__out = { real, sent, census: lbMeshCensus(bundle) };
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
const run = async () => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 25000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000, polling: 100 });
  const o = await page.evaluate(() => window.__out);
  await page.close();
  return o;
};
let off;
try {
  off = await run();
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
console.log('   built:', JSON.stringify(off));
// THE GATE DOES THE WORK. Without the proof, containment and the all-air drop over a hundred shapes
// decline here; a handful is the expectation, and a climb means the gate is broken.
//
// READ FROM lbMeshCensus, not from the sentinel count. They agree on this fixture only because tiger
// has exactly one shape without a mesh and it is a real decline.
// On an asset with a shape the caller's memory budget refuses the two differ, and the sentinel
// count reports a decline for an asset with none — so it cannot be what the over-paint gate is
// judged on.
const c = off.census;
if (c.declined <= 8) ok('the gate leaves ' + c.declined + ' decline(s)');
else fail('declines climbed to ' + c.declined + ' — the over-paint gate is broken');
// ...and the other outcomes are still visible, so a defect that stops BUILDING shapes cannot
// hide behind the decline count being clean. prepareBundle + awaitLbReady wait for full quality, so
// nothing should be left unbuilt here.
if (c.notBuilt === 0) ok('every shape was attempted (nothing left unbuilt after awaitLbReady)');
else fail(c.notBuilt + ' shape(s) were never built — that is not a decline, but it is not nothing');
console.log('   lbMeshCensus:', JSON.stringify(c));
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nlbApexClipSmoke: over-painting crescents do not decline');
