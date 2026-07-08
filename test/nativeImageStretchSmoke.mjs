// nativeImageStretchSmoke.mjs — native (no-WebGL) raster drawImage must stretch
// the bitmap to fill dstRect (matching WebGL drawImage), not letterbox it.
//
// The native <image> sets preserveAspectRatio="none" by default (honoring
// drawOpts.par when given); otherwise it defaults to "xMidYMid meet" and a
// non-source-aspect dstRect shows a source-aspect box with margins. This draws
// a 2:1 source into a 1:1 box and asserts the whole box fills (no top/bottom
// letterbox margins), and that an explicit 'meet' par does letterbox (the opt
// is honored).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 2:1 (wide) red source. In a 100×100 dst: stretch → fills; meet → 100×50
// band centred at y25..75 with bg margins top/bottom.
const SRC = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10">'
  + '<rect x="0" y="0" width="20" height="10" fill="#ff0000"/></svg>');

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { createNativeScene } from '/src/index.js';
const SRC = ${JSON.stringify(SRC)};
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const ctx = document.getElementById('cv').getContext('2d');

window.__draw = async (opts) => {
  scene.beginFrame([0,0,0,1]);
  scene.drawImage(SRC, Object.assign({ dstRect: [0,0,100,100] }, opts));
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { top: at(50,8), mid: at(50,50), bot: at(50,92) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };
const isRed = (px) => px[0] > 150 && px[1] < 90 && px[2] < 90;
const isBg = (px) => px[0] < 60 && px[1] < 60 && px[2] < 60;

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

// Default: STRETCH — red fills top, middle AND bottom (no letterbox margins).
const def = await page.evaluate(() => window.__draw({}));
if (isRed(def.top) && isRed(def.mid) && isRed(def.bot))
  ok('default drawImage STRETCHES to fill dstRect (top/mid/bot all red): ' + JSON.stringify(def));
else fail('default not stretched — letterbox margins present: ' + JSON.stringify(def));

// Explicit 'meet' par ([1,1,0] = xMidYMid meet) IS honored → letterbox: a 2:1
// source in a 1:1 box fills the middle band only, margins (top/bottom) are bg.
const meet = await page.evaluate(() => window.__draw({ par: [1, 1, 0] }));
if (isRed(meet.mid) && isBg(meet.top) && isBg(meet.bot))
  ok("explicit par 'meet' is honored → letterboxed (mid red, margins bg): " + JSON.stringify(meet));
else fail("explicit par 'meet' not honored: " + JSON.stringify(meet));

await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-IMAGE-STRETCH PASS');
else console.log(`\nNATIVE-IMAGE-STRETCH FAIL (${failures})`);
process.exit(failures ? 1 : 0);
