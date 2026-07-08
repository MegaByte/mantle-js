// spriteSheetSmoke.mjs — sprite-sheet addressing proof.
// One SVG sheet with 3 addressable sprites at distinct x-positions:
//   #red   — top-level <g id> with 2 rects, left third   (x≈0..100)
//   #green — top-level <g id> with 1 rect,  middle third  (x≈100..200)
//   #blue  — lone id'd top-level <rect>,    right third   (x≈200..300)
// plus one UN-id'd top-level rect (not addressable).
//
// Asserts:
//   1. bundle.spriteRanges maps each id to the right meta-row range; the
//      un-id'd shape gets no entry.
//   2. drawSprite(id) renders ONLY that sprite — its pixels present, the
//      OTHER sprites' pixels absent (subset clip works).
//   3. drawSprite output for a sprite == the matching region of a full
//      drawBundle (parity — the subset is a faithful slice).
//   4. drawSpriteInstanced stamps one sprite at N transforms (count + a
//      shifted copy lands where expected).
//   5. opts.sprites import filter keeps only listed sprites and SHRINKS
//      the bundle (numShapes drops; dropped sprites are gone, not hidden).
//   6. Unknown sprite id → drawSprite returns false (no throw).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SHEET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100">
  <g id="red"><rect x="10" y="10" width="80" height="40" fill="#ff0000"/><rect x="10" y="55" width="80" height="35" fill="#cc0000"/></g>
  <g id="green"><rect x="110" y="10" width="80" height="80" fill="#00ff00"/></g>
  <rect id="blue" x="210" y="10" width="80" height="80" fill="#0000ff"/>
  <rect x="0" y="95" width="300" height="4" fill="#ffffff"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="300" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sheetSections = await importSvg(${JSON.stringify(SHEET)});
const bundle = createBundle(gl, sheetSections);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__ranges = bundle.spriteRanges;
window.__numShapes = bundle.numShapes;
window.__hasDrawSprite = typeof renderer.drawSprite === 'function';
window.__T = (s, tx, ty) => new Float32Array([s,0,0, 0,s,0, tx,ty,1]);
window.__full = () => {
  renderer.setViewport(300, 100); renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, { worldMatrix: id }); renderer.endFrame();
};
window.__sprite = (sid, opts) => {
  renderer.setViewport(300, 100); renderer.beginFrame([0,0,0,1]);
  const r = renderer.drawSprite(bundle, sid, opts || { worldMatrix: id }); renderer.endFrame();
  return r;
};
window.__spriteInst = (sid, instances, shared) => {
  renderer.setViewport(300, 100); renderer.beginFrame([0,0,0,1]);
  const n = renderer.drawSpriteInstanced(bundle, sid, instances, shared || {}); renderer.endFrame();
  return n;
};
// import-filter probe: returns the filtered bundle's shape count + ranges.
window.__filtered = async () => {
  const sec = await importSvg(${JSON.stringify(SHEET)}, { sprites: ['red', 'green'] });
  const b = createBundle(gl, sec);
  return { numShapes: b.numShapes, ranges: b.spriteRanges };
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try { res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { const t = m.text(); if (/Mantle\]/.test(t)) console.log('  [page]', t); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

if (await page.evaluate(() => window.__hasDrawSprite)) ok('renderer.drawSprite exists');
else fail('drawSprite not exported');

// (1) spriteRanges map.
const ranges = await page.evaluate(() => window.__ranges);
const ns = await page.evaluate(() => window.__numShapes);
if (ranges && ranges.red && ranges.green && ranges.blue) ok('spriteRanges has red/green/blue: ' + JSON.stringify(ranges));
else fail('spriteRanges missing ids: ' + JSON.stringify(ranges));
if (ranges && ranges.red && ranges.red[0] === 0 && ranges.red[1] === 1) ok('red maps to its 2 shapes [0,1]');
else fail('red range wrong: ' + JSON.stringify(ranges && ranges.red));
if (ranges && Object.keys(ranges).length === 3) ok('un-id top-level shape is NOT addressable (3 sprites total)');
else fail('unexpected sprite count: ' + Object.keys(ranges || {}).length);

// Establish the full-render colors at each sprite's center.
const fullCols = await page.evaluate(() => {
  window.__full();
  return { red: window.__sample(50, 30), green: window.__sample(150, 50), blue: window.__sample(250, 50) };
});
if (fullCols.red[0] > 180 && fullCols.green[1] > 180 && fullCols.blue[2] > 180) ok('full render: red|green|blue at their thirds');
else fail('full render colors wrong: ' + JSON.stringify(fullCols));

// (2)+(3) drawSprite isolates each sprite + matches the full-render region.
for (const [sid, cx, cy, chan] of [['red', 50, 30, 0], ['green', 150, 50, 1], ['blue', 250, 50, 2]]) {
  const r = await page.evaluate((sid, cx, cy) => {
    const drew = window.__sprite(sid);
    return { drew, self: window.__sample(cx, cy) };
  }, sid, cx, cy);
  if (r.drew) ok('drawSprite("' + sid + '") drew'); else fail('drawSprite("' + sid + '") returned false');
  if (r.self[chan] > 180) ok('  ' + sid + ': its own pixels present (chan ' + chan + '=' + r.self[chan] + ')');
  else fail('  ' + sid + ': own pixels missing: ' + r.self);
}
// Cross-absence: after drawing ONLY green, red & blue regions are background.
const greenOnly = await page.evaluate(() => {
  window.__sprite('green');
  return { red: window.__sample(50, 30), green: window.__sample(150, 50), blue: window.__sample(250, 50) };
});
if (greenOnly.green[1] > 180 && greenOnly.red[0] < 40 && greenOnly.blue[2] < 40)
  ok('drawSprite("green") isolates green — red & blue regions are empty (subset clip works)');
else fail('green isolation failed: ' + JSON.stringify(greenOnly));

// Parity: drawSprite("blue") center == full-render blue center.
const par = await page.evaluate(() => {
  window.__full(); const full = window.__sample(250, 50);
  window.__sprite('blue'); const sub = window.__sample(250, 50);
  return { full, sub };
});
const pdmax = Math.max(...[0,1,2,3].map(k => Math.abs(par.full[k] - par.sub[k])));
if (pdmax <= 2) ok('drawSprite parity: blue subset == full-render blue (Δ=' + pdmax + ')');
else fail('subset ≠ full region: full=' + par.full + ' sub=' + par.sub);

// (4) drawSpriteInstanced: 2 copies of blue, one shifted left. Verify the
// instance count, that the origin copy is present, and that a shifted copy
// puts blue somewhere LEFT of the original (exact landing depends on the
// clip→pixel fit, so scan the left half rather than guess a pixel).
const inst = await page.evaluate(() => {
  const n = window.__spriteInst('blue', [
    { worldMatrix: window.__T(1, 0, 0) },
    { worldMatrix: window.__T(1, -0.6, 0) },   // shift left
  ]);
  let blueLeft = false;
  for (let x = 0; x < 230; x += 8) { const p = window.__sample(x, 50); if (p[2] > 150 && p[0] < 80) { blueLeft = true; break; } }
  return { n, orig: window.__sample(250, 50), blueLeft };
});
if (inst.n === 2) ok('drawSpriteInstanced drew 2 instances'); else fail('instance count: ' + inst.n);
if (inst.orig[2] > 150) ok('  instanced sprite present at origin'); else fail('  origin instance missing: ' + inst.orig);
if (inst.blueLeft) ok('  shifted instance moved blue into the left half'); else fail('  shifted instance not found left of origin');

// (5) import filter shrinks the bundle.
const filt = await page.evaluate(() => window.__filtered());
if (filt.numShapes < ns) ok('opts.sprites filter shrank bundle: ' + filt.numShapes + ' < ' + ns + ' shapes');
else fail('filter did not shrink bundle: ' + filt.numShapes + ' vs ' + ns);
if (filt.ranges.red && filt.ranges.green && !filt.ranges.blue) ok('  filtered bundle keeps red+green, drops blue entirely');
else fail('  filter kept wrong sprites: ' + JSON.stringify(filt.ranges));

// (6) unknown id → false.
const unk = await page.evaluate(() => window.__sprite('nope'));
if (unk === false) ok('unknown sprite id → drawSprite returns false'); else fail('unknown id returned: ' + unk);

await browser.close();
server.close();
if (failures === 0) console.log('\nSPRITE-SHEET PASS');
else console.log(`\nSPRITE-SHEET FAIL (${failures})`);
process.exit(failures ? 1 : 0);
