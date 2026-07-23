// spriteRangeRouteSmoke.mjs — drawSprite must paint ONE sprite, on every fill route.
//
// drawSprite communicates the subset ONLY by setting R.draw.shapeRange (drawSprites.js), and that
// field was consumed in exactly one place: the Slug cover-quad op loop (renderer.js ~:1579). The
// analytic (Loop-Blinn) route never read it — _ensureLbCombined packs the WHOLE drawList into one
// VBO — so drawSprite under LB painted the ENTIRE SHEET. Silent, because the usual usage draws
// every sprite in the sheet and the over-draw hides under identical content.
//
// Guards the invariant directly: draw ONE sprite from a multi-sprite sheet and require the inked
// bbox to match the Slug route's (which was always correct). Runs LB 'on' AND 'off' so the two
// routes must agree, and asserts the ink stays inside the sprite's own column.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 4 sprites in 4 well-separated columns. Curved (cubic) so the LB route genuinely engages.
const N = 256;
const blob = (cx, cy, r, fill) =>
  `<path fill="${fill}" d="M ${cx - r} ${cy} C ${cx - r} ${cy - r * 1.3} ${cx + r} ${cy - r * 1.3} ${cx + r} ${cy} C ${cx + r} ${cy + r * 1.3} ${cx - r} ${cy + r * 1.3} ${cx - r} ${cy} Z"/>`;
const SHEET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">`
  + [0, 1, 2, 3].map((i) => `<g id="s${i}">${blob(32 + i * 64, 128, 24, '#3366cc')}</g>`).join('')
  + `</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders, {}); r.setViewport(${N}, ${N});
const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}, { preserveViewport: true }));
r.prepareBundle && r.prepareBundle(sheet);
if (r.awaitLbReady) await r.awaitLbReady(sheet);

// Inked bbox + pixel count of one drawn sprite.
const measure = () => {
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
    const o = (y * ${N} + x) * 4;
    if (px[o] < 200 || px[o+1] < 200 || px[o+2] < 200) {   // anything not white
      ink++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return ink ? { ink, x0, x1, y0, y1 } : { ink: 0, x0: -1, x1: -1, y0: -1, y1: -1 };
};
const one = (mode, id) => {
  r.setLoopBlinnFill(mode);
  r.beginFrame([1,1,1,1]); r.drawSprite(sheet, id, {}); r.endFrame();
  return measure();
};
const out = {};
for (const id of ['s0', 's2']) { out[id + '_slug'] = one('off', id); out[id + '_lb'] = one('on', id); }
// Reference: the WHOLE sheet, so a test that accidentally draws everything is detectable.
r.setLoopBlinnFill('off');
r.beginFrame([1,1,1,1]); r.drawBundle(sheet, {}); r.endFrame();
out.whole = measure();
window.__out = out; window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
const out = await page.evaluate(() => window.__out);
await browser.close(); server.close();

let fail = 0;
const bb = (o) => `ink=${o.ink} bbox=[${o.x0},${o.x1}]x[${o.y0},${o.y1}]`;
console.log('  whole sheet (reference):', bb(out.whole));
for (const id of ['s0', 's2']) {
  const s = out[id + '_slug'], l = out[id + '_lb'];
  console.log(`  ${id}: slug ${bb(s)}`);
  console.log(`  ${id}: lb   ${bb(l)}`);
  // The LB route must paint the same sprite the Slug route does — not the whole sheet.
  if (l.ink === 0) { console.log(`FAIL ${id}: LB drew nothing`); fail++; continue; }
  const wideningX = (l.x1 - l.x0) - (s.x1 - s.x0);
  if (wideningX > 4) {
    console.log(`FAIL ${id}: LB ink spans ${l.x1 - l.x0}px vs Slug ${s.x1 - s.x0}px — LB is painting beyond the sprite`);
    fail++;
  } else if (Math.abs(l.ink - s.ink) > Math.max(40, s.ink * 0.15)) {
    console.log(`FAIL ${id}: LB ink ${l.ink} vs Slug ${s.ink} — routes disagree`);
    fail++;
  } else {
    console.log(`ok ${id}: LB matches Slug (one sprite, not the sheet)`);
  }
}
if (fail) { console.log(`\nSPRITE-RANGE-ROUTE FAIL (${fail})`); process.exit(1); }
console.log('\nSPRITE-RANGE-ROUTE PASS');
