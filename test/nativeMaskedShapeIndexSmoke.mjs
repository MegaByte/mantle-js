// nativeMaskedShapeIndexSmoke.mjs — guards the positional shape→element
// mapping on masked/clipped art.
//
// A <mask>/<clipPath>/<defs> contains shape elements (the mask geometry)
// that appear first in document order. The native fallback's positional
// shapeElByIndex walk must NOT count them: if it did, every visible shape's
// index would shift by the number of mask/clip shapes and
// overrides/morph/recolor would land on the wrong element. Shape elements
// inside non-rendered containers are excluded from the positional walk.
//
// This hides visible shape index 0 via a per-shape override and asserts the
// box disappears while the masked text stays — proving shape 0 maps to the
// box, not the mask's rect (hiding the mask rect would empty the mask and
// blank everything).

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MROOT = path.resolve(__dirname, '..');
const fontB64 = readFileSync(new URL('./font/fixtures/roboto-regular.ttf', import.meta.url)).toString('base64');

// Full-canvas mask (everything visible) whose rect is the FIRST shape
// element in document order — the index-shift trigger. Box (blue) +
// masked text (red).
const SVG = readFileSync(new URL('../examples/smoke/nativeMaskedShapeIndex__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body><div id="host"></div><canvas id="cv" width="100" height="50"></canvas>
<script type="module">
import { importSvg } from '/src/svg/importer.js';
import { MantleFontAsset } from '/src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '/src/font/textRun.js';
import { createNativeScene, createNativeOverrideTable } from '/src/fallback/index.js';

const FONT = new MantleFontAsset(Uint8Array.from(atob('${fontB64}'), c => c.charCodeAt(0)));
const bundle = await importSvg(${JSON.stringify(SVG)}, {
  retainSource: true, keepInvisibleShapes: true,
  fonts: { Roboto: FONT }, svgTextLayout: buildSvgTextGlyphs });
window.__numShapes = bundle.numShapes;

const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'bundle' });
const ovr = createNativeOverrideTable(bundle);
const ID = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

async function sample(useOvr) {
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(bundle, useOvr ? { worldMatrix: ID, overrides: ovr } : { worldMatrix: ID });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej;
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml))); });
  const ctx = document.getElementById('cv').getContext('2d');
  ctx.clearRect(0,0,100,50); ctx.drawImage(img, 0,0,100,50);
  const at = (x,y) => { const d = ctx.getImageData(x,y,1,1).data; return [d[0],d[1],d[2],d[3]]; };
  return { box: at(18,24), text: at(48,26) };
}

window.__before = await sample(false);          // no override
ovr.set(0, { visibility: 0 });                  // hide VISIBLE shape 0 (the box)
window.__after = await sample(true);
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, {'content-type':'text/html'}); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try { res.writeHead(200, {'content-type':'text/javascript'}); res.end(readFileSync(path.join(MROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };
const isBlue = (p) => p[2] > 150 && p[0] < 100 && p[3] > 100;
// "red-dominant" — robust to anti-aliased glyph-edge samples that blend
// red over the white background (e.g. 255,191,191).
const isRed  = (p) => p[0] > 120 && p[0] > p[1] + 30 && p[0] > p[2] + 30;
const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
const near = (a, b) => Math.abs(a[0]-b[0]) < 20 && Math.abs(a[1]-b[1]) < 20 && Math.abs(a[2]-b[2]) < 20;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type()==='error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  const got = await page.waitForFunction('window.__ready === true', { timeout: 30000 }).then(()=>1).catch(()=>0);
  if (!got) { fail('page did not become ready'); }
  else {
    const before = await page.evaluate('window.__before');
    const after = await page.evaluate('window.__after');
    const n = await page.evaluate('window.__numShapes');
    console.log('numShapes:', n, '| before:', JSON.stringify(before), '| after:', JSON.stringify(after));

    // Baseline: box renders blue, masked text renders red (mask reveals both).
    if (isBlue(before.box)) ok('baseline: box renders blue'); else fail('baseline box not blue: ' + before.box);
    if (isRed(before.text)) ok('baseline: masked text renders red'); else fail('baseline text not red: ' + before.text);

    // The fix: hiding VISIBLE shape 0 hides the BOX...
    if (isWhite(after.box)) ok('hide shape 0 → box gone (shape 0 == box, not the mask rect)');
    else fail('box still present after hiding shape 0: ' + after.box);
    // ...and leaves the masked TEXT intact + unchanged (mask not emptied,
    // indices not shifted). If shape 0 were the mask rect, hiding it would
    // empty the mask and the text would go white.
    if (isRed(after.text) && near(after.text, before.text))
      ok('text unchanged (still red) — mask intact, indices not shifted');
    else fail('text changed after hiding shape 0 — shape 0 was the mask rect (the old bug): ' + after.text);
  }
} finally { await browser.close(); server.close(); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nNATIVE-MASKED-SHAPE-INDEX PASS');
process.exit(failures ? 1 : 0);
