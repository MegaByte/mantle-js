// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeClipDefLifecycleSmoke.mjs — a setNodeClip <defs> entry must not leak
// when its clipped bundle stops being drawn, and must rebuild if the bundle is
// drawn again. The positional reconciler trims the bundle's <g> on a frame it
// isn't drawn; the trim also detaches the orphaned clip def (keeping the
// _extClips descriptor so a redraw re-creates it via ensureExtClipDef).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONTENT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/></svg>';
const CLIP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<rect x="0" y="0" width="100" height="50" fill="#fff"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
import { nativeResourceLifetime } from '/test/_nativeResources.mjs';
window.__resourceLifetime = nativeResourceLifetime;
const content = await importSvg(${JSON.stringify(CONTENT)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
scene.setNodeClip(content, { maskSvg: ${JSON.stringify(CLIP)}, mode: 'in' });

const defCount = () => scene.svg.querySelectorAll('clipPath[id^="mantleExtClip"], mask[id^="mantleExtClip"]').length;
const gHasClip = () => {
  const g = scene.svg.querySelector('g[clip-path], g[mask]');
  return !!g;
};
const drawFrame = () => { scene.beginFrame([0,0,0,1]); scene.drawBundle(content, { worldMatrix: id }); scene.endFrame(); };
const emptyFrame = () => { scene.beginFrame([0,0,0,1]); scene.endFrame(); };

window.__run = () => {
  drawFrame();   const afterDraw = { defs: defCount(), clip: gHasClip() };
  emptyFrame();  const afterTrim = { defs: defCount(), clip: gHasClip() };
  drawFrame();   const afterRedraw = { defs: defCount(), clip: gHasClip() };
  return { afterDraw, afterTrim, afterRedraw };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
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
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const r = await page.evaluate(() => window.__run());
console.log('  ', JSON.stringify(r));
if (r.afterDraw.defs === 1 && r.afterDraw.clip) ok('drawn: clip def present + <g> clipped');
else fail('drawn state wrong: ' + JSON.stringify(r.afterDraw));
if (r.afterTrim.defs === 0 && !r.afterTrim.clip)
  ok('untrimmed: clip def freed (no orphan) + bundle <g> gone');
else fail('def leaked after bundle stopped drawing: ' + JSON.stringify(r.afterTrim));
if (r.afterRedraw.defs === 1 && r.afterRedraw.clip)
  ok('redraw: clip def rebuilt + <g> clipped again');
else fail('clip not restored on redraw: ' + JSON.stringify(r.afterRedraw));

const lifetime = await page.evaluate(() => window.__resourceLifetime());
if (
  lifetime.twice === 1 &&
  lifetime.once === 1 &&
  lifetime.onceBottom.every((v) => v === 0) &&
  lifetime.swappedDefs === 1 &&
  lifetime.replaced === 1 &&
  lifetime.empty === 0
)
  ok('live clip survives partial trimming; replaced/unused definitions retire');
else fail('clip resource lifetime ' + JSON.stringify(lifetime));
if (
  lifetime.templatesAfterEmpty === 0 &&
  lifetime.templateReused &&
  lifetime.heldTemplateDefs === 0 &&
  lifetime.rasterDefsAfterReplace === 2 &&
  lifetime.rasterDefsAfterTrim === 0
)
  ok('unused instance and raster definitions retire; live templates are reused');
else fail('template/raster lifetime ' + JSON.stringify(lifetime));
const cdp = await page.target().createCDPSession();
for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
const retained = await page.evaluate(() =>
  Object.fromEntries(
    Object.entries(window.__nativeLifetime.refs).map(([key, refs]) => [
      key,
      refs.filter((ref) => ref.deref()).length,
    ]),
  ),
);
if (
  lifetime.observed.clip === 16 &&
  lifetime.observed.template === 16 &&
  Object.values(retained).every((n) => n === 0)
)
  ok(
    'live scene releases retired clip/template owners, selected bundle and borrowed clear-color storage',
  );
else fail('retained native resources ' + JSON.stringify({ observed: lifetime.observed, retained }));
await page.evaluate(() => {
  for (const scene of window.__nativeLifetime.scenes) scene.dispose();
  delete window.__nativeLifetime;
});
await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-CLIP-DEF-LIFECYCLE PASS');
else console.log(`\nNATIVE-CLIP-DEF-LIFECYCLE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
