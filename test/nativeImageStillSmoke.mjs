// nativeImageStillSmoke.mjs — native (no-WebGL) raster drawImage writes only
// what changed since the slot's last frame. A slow device's SVG fallback
// redraws every raster each frame; re-appending each <image> and rewriting its
// attributes made the browser restyle and repaint the whole scene per frame.
//
// Given a raster drawn at the same place two frames in a row, the second frame
// mutates no DOM. Given it moves, only its transform changes. Given it fades,
// only its opacity changes, and dropping the fade removes only the opacity.
// A canvas raster draws from a short blob URL rather than a PNG data URL, so a
// new <image> of it parses no long string.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10">'
  + '<rect x="0" y="0" width="20" height="10" fill="#ff0000"/></svg>');

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<script type="module">
import { createNativeScene } from '/src/fallback/nativeSvgFallback.js';
const SRC = ${JSON.stringify(SRC)};
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const matrix = (tx) => new Float32Array([1, 0, 0, 0, 1, 0, tx, 0, 1]);
window.__frame = async (draws) => {
  const changes = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') changes.push(record.target.tagName + '.' + record.attributeName);
      else changes.push(record.target.tagName + ' children');
    }
  });
  observer.observe(scene.svg, { subtree: true, childList: true, attributes: true, attributeFilter: undefined });
  scene.beginFrame([0, 0, 0, 1]);
  for (const draw of draws) scene.drawImage(SRC, { dstRect: [0, 0, 40, 20], worldMatrix: matrix(draw.tx), ...(draw.alpha === undefined ? {} : { alpha: draw.alpha }) });
  scene.endFrame();
  await Promise.resolve();
  const pending = observer.takeRecords();
  for (const record of pending) changes.push(record.type === 'attributes' ? record.target.tagName + '.' + record.attributeName : record.target.tagName + ' children');
  observer.disconnect();
  return { changes: [...new Set(changes)].sort(), images: scene.svg.querySelectorAll('image').length };
};
const colored = (fill) => 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10">'
  + '<rect x="0" y="0" width="20" height="10" fill="' + fill + '"/></svg>');
const SOURCES = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'].map(colored);
window.__created = (order) => {
  scene.beginFrame([0, 0, 0, 1]);
  order.forEach((source, index) => scene.drawImage(SOURCES[source], { dstRect: [0, 0, 10, 10], worldMatrix: matrix(index * 12) }));
  scene.endFrame();
  const after = [...scene.svg.querySelectorAll('image')];
  const created = after.filter((image) => !image.__seenBySmoke).length;
  for (const image of after) image.__seenBySmoke = true;
  return { created, drawn: after.map((image) => SOURCES.indexOf(image.getAttribute('href'))) };
};
window.__canvasHref = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 32;
  canvas.getContext('2d').fillRect(0, 0, 64, 32);
  const token = scene.createImage(canvas);
  await token.ready;
  scene.beginFrame([0, 0, 0, 1]);
  scene.drawImage(token, { dstRect: [0, 0, 64, 32] });
  scene.endFrame();
  const href = scene.svg.querySelector('image').getAttribute('href');
  token.dispose();
  const revoked = await fetch(href).then(() => false, () => true);
  return { blob: href.startsWith('blob:'), revoked };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  const p = decodeURIComponent(req.url.split('?')[0]);
  try { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const expect = (message, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log('ok ' + message);
  else { failures++; console.error(`FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
};

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });

const frame = (draws) => page.evaluate((d) => window.__frame(d), draws);
await frame([{ tx: 0 }, { tx: 50 }]);
expect('Given two rasters drawn in place again, then the frame mutates no DOM', await frame([{ tx: 0 }, { tx: 50 }]), { changes: [], images: 2 });
expect('Given a raster moves, then only its transform changes', await frame([{ tx: 0 }, { tx: 60 }]), { changes: ['image.transform'], images: 2 });
expect('Given a raster fades, then only its opacity changes', await frame([{ tx: 0, alpha: 0.5 }, { tx: 60 }]), { changes: ['image.opacity'], images: 2 });
expect('Given its fade ends, then only its opacity is removed', await frame([{ tx: 0 }, { tx: 60 }]), { changes: ['image.opacity'], images: 2 });
expect('Given a raster is no longer drawn, then its image leaves the scene', (await frame([{ tx: 0 }])).images, 1);

await page.evaluate(() => window.__created([0, 1, 2, 3]));
expect('Given a raster leaves the middle of the draw order, then the rasters after it keep their images, none created', await page.evaluate(() => window.__created([0, 2, 3])), { created: 0, drawn: [0, 2, 3] });
expect('Given a new raster joins the middle of the draw order, then only its image is created', await page.evaluate(() => window.__created([0, 4, 2, 3])), { created: 1, drawn: [0, 4, 2, 3] });
expect('Given two rasters swap places, then both keep their images', await page.evaluate(() => window.__created([0, 2, 4, 3])), { created: 0, drawn: [0, 2, 4, 3] });
await page.evaluate(() => window.__created([0, 1]));
await page.evaluate(() => window.__created([0]));
await page.evaluate(() => window.__created([0]));
expect('Given a raster skips a few frames, when it is drawn again, then it reuses its image', await page.evaluate(() => window.__created([0, 1])), { created: 0, drawn: [0, 1] });
expect('Given a canvas raster once ready, then its image draws from a short blob URL, which disposing it revokes', await page.evaluate(() => window.__canvasHref()), { blob: true, revoked: true });

await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-IMAGE-STILL PASS');
else console.log(`\nNATIVE-IMAGE-STILL FAIL (${failures})`);
process.exit(failures ? 1 : 0);
