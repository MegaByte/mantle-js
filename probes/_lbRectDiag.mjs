// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect x="0" y="0" width="100" height="40" fill="#3070c0" fill-opacity="0.392"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="400" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(400, 200);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);
const keys = Object.keys(bundle).filter(k=>/lb|Lb|mesh|Mesh|stream|geom/.test(k));
const meshInfo = {};
for(const k of keys){ const v=bundle[k]; meshInfo[k]= v==null?String(v): (typeof v==='object'? ('obj:'+Object.keys(v).slice(0,6).join(',')) : typeof v); }
renderer.setLoopBlinnFill('on');
const r0=renderer.debugStats.loopBlinnRouteCount;
renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
const routedDrawBundle = renderer.debugStats.loopBlinnRouteCount - r0;
const wouldServe = renderer._lbWouldServe ? renderer._lbWouldServe(bundle) : 'n/a';
window.__out={ keys, meshInfo, routedDrawBundle, wouldServe, fillMode: renderer._lbFillMode };
window.__ready=true;
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
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
page.on('console', (m) => console.log('[' + m.type() + ']', m.text()));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
const o = await page.evaluate(() => window.__out);
console.log(
  'fillMode',
  o.fillMode,
  'wouldServe',
  o.wouldServe,
  'routedDrawBundle',
  o.routedDrawBundle,
);
console.log('lb-ish keys:', JSON.stringify(o.meshInfo, null, 0));
await browser.close();
server.close();
