// occlusionCullBatchSmoke.mjs — a shape the occlusion cull drops must not split the
// bundle's draw. The cull removes a hidden shape from the draw list; its cover verts
// stay in the middle of the uploaded mesh, so the shapes around it no longer sit
// contiguously and every gap costs another drawArrays. A detailed asset with dozens
// of hidden shapes (a toy car) paid dozens of draws per frame.
//
// Scene: GREEN left, BLUE under RED (culled), RED over it, YELLOW right — in that
// paint order. With the cull landed the bundle must still paint in ONE cover draw,
// paint the same pixels, and paint BLUE again once an override hides RED.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">`
  + `<rect id="left"  x="2"  y="56" width="16" height="16" fill="#00ff00"/>`
  + `<rect id="under" x="48" y="48" width="32" height="32" fill="#0000ff"/>`
  + `<rect id="over"  x="24" y="24" width="80" height="80" fill="#ff0000"/>`
  + `<rect id="right" x="110" y="56" width="16" height="16" fill="#ffff00"/>`
  + `</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders, {}); r.setViewport(${N}, ${N});
r.setLoopBlinnFill('off');
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true }));
for (let i = 0; i < 400 && !(bundle._cullGen > 0); i++) await new Promise(r => setTimeout(r, 10));
const handle = r.createBundleHandle(bundle);
const ov = createOverrideTable(gl, bundle);
const colourAt = (x, y) => {
  const px = new Uint8Array(4);
  gl.readPixels(x, ${N} - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (px[1] > 180 && px[0] < 80 && px[2] < 80) return 'green';
  if (px[2] > 180 && px[0] < 80) return 'blue';
  if (px[0] > 180 && px[1] < 80 && px[2] < 80) return 'red';
  if (px[0] > 180 && px[1] > 180 && px[2] < 80) return 'yellow';
  return 'other(' + px[0] + ',' + px[1] + ',' + px[2] + ')';
};
let draws = 0;
const drawArrays = gl.drawArrays.bind(gl);
gl.drawArrays = (...args) => { draws++; return drawArrays(...args); };
const paint = (opts) => {
  r.beginFrame([1,1,1,1]);
  draws = 0;
  handle.draw(opts);
  const counted = draws;
  r.endFrame();
  return { draws: counted, left: colourAt(10, 64), centre: colourAt(64, 64), right: colourAt(118, 64) };
};
const out = { culled: Array.from(bundle._culledShapes || []) };
paint({});
out.culledFrame = paint({});
ov.set('over', { visibility: 0 });
out.uncovered = paint({ overrides: ov });
ov.set('over', {});
paint({ overrides: ov });
out.recovered = paint({ overrides: ov });
gl.drawArrays = drawArrays;
window.__out = out; window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    const source = readFileSync(path.join(ROOT, p));
    if (url.searchParams.has('raw')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`export default ${JSON.stringify(source.toString('utf8'))};`);
      return;
    }
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(source);
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
const expect = (name, got, want) => {
  if (got === want) console.log('ok', name, '=', got);
  else { console.log(`FAIL ${name} — got ${got}, want ${want}`); fail++; }
};
if (!out.culled.length) {
  console.log('FAIL the occlusion cull never fired — this test would pass vacuously.');
  process.exit(1);
}
expect('culled bundle paints in one cover draw', out.culledFrame.draws, 1);
expect('culled bundle: left', out.culledFrame.left, 'green');
expect('culled bundle: centre', out.culledFrame.centre, 'red');
expect('culled bundle: right', out.culledFrame.right, 'yellow');
expect('occluder hidden → covered shape appears', out.uncovered.centre, 'blue');
expect('occluder hidden: right still paints', out.uncovered.right, 'yellow');
expect('occluder restored: centre', out.recovered.centre, 'red');
expect('occluder restored paints in one cover draw', out.recovered.draws, 1);
if (fail) { console.log(`\nOCCLUSION-CULL-BATCH FAIL (${fail})`); process.exit(1); }
console.log('\nOCCLUSION-CULL-BATCH PASS');
