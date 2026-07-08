// shaderBuildSmoke.mjs — the build-time generated shaders (src/shaders/generated/
// *.glsl: assembled, valid, unminified) must compile and render IDENTICALLY to
// the runtime loadShaders() path. This validates the build pipeline: the
// per-file assembled GLSL is valid (no @@markers@@), and a consumer that imports
// the generated files (here: fetches them) gets behavior identical to the
// runtime marker-splice. Files (not a JS string module) so downstream GLSL
// tooling — minifiers, validators, bundler glsl loaders — can process them.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">'
  + '<circle cx="30" cy="30" r="22" fill="#ff3030"/>'
  + '<rect x="55" y="10" width="35" height="35" fill="#2080ff"/>'
  + '<rect x="20" y="62" width="60" height="28" fill="#30c040"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, SHADER_FILENAMES } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { stencil:true, depth:true, antialias:false, preserveDrawingBuffer:true });
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));

// Build the createRenderer dict by FETCHING each committed generated/*.glsl —
// the consumption a bundler does via ?raw imports of the same files.
async function loadGenerated() {
  const base = new URL('/src/shaders/generated/', location.href).href;
  const out = {};
  for (const [key, file] of SHADER_FILENAMES) {
    const res = await fetch(new URL(file, base));
    if (res.ok) out[key] = await res.text();   // optional shaders may 404 → skip
  }
  return out;
}

function renderWith(sources) {
  const r = createRenderer(gl, sources);
  r.setViewport(100, 100);
  r.beginFrame([0,0,0,1]);
  r.drawBundle(bundle, { worldMatrix: id });
  r.endFrame();
  const px = new Uint8Array(100*100*4);
  gl.readPixels(0,0,100,100, gl.RGBA, gl.UNSIGNED_BYTE, px);
  r.dispose();
  return px;
}

window.__run = async () => {
  const GEN = await loadGenerated();
  const meta = {
    keys: Object.keys(GEN).length,
    hasMarker: /@@[A-Z_]+@@/.test(GEN.fillFrag || ''),
    versionFirst: (GEN.fillFrag || '').startsWith('#version'),
  };
  const runtime = await loadShaders(new URL('/src/shaders/', location.href).href);
  const a = renderWith(GEN);
  const b = renderWith(runtime);
  let diff = 0, maxd = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]-b[i]); if (d > maxd) maxd = d; if (d > 2) diff++; }
  const at = (x,yTop) => { const o=((100-1-yTop)*100+x)*4; return [a[o],a[o+1],a[o+2],a[o+3]]; };
  return { meta, diff, maxd, circle: at(30,30), blueRect: at(72,27), greenRect: at(50,76) };
};
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
const isRed = (p) => p[0]>150 && p[1]<90 && p[2]<90;
const isBlue = (p) => p[2]>150 && p[0]<90;
const isGreen = (p) => p[1]>120 && p[0]<120 && p[2]<120;

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const r = await page.evaluate(() => window.__run());
console.log('  meta:', JSON.stringify(r.meta), '| diff px:', r.diff, 'maxd:', r.maxd);

// (1) The generated files are valid standalone GLSL (markers spliced).
if (r.meta.keys > 20 && !r.meta.hasMarker && r.meta.versionFirst)
  ok('generated/*.glsl are valid standalone GLSL (no @@markers@@, #version first, ' + r.meta.keys + ' shaders)');
else fail('generated files not valid: ' + JSON.stringify(r.meta));

// (2) They render the artwork correctly.
if (isRed(r.circle) && isBlue(r.blueRect) && isGreen(r.greenRect))
  ok('generated shaders render the artwork (red circle, blue + green rects)');
else fail('generated render wrong: circle=' + r.circle + ' blue=' + r.blueRect + ' green=' + r.greenRect);

// (3) Generated == runtime render (assembly is behavior-preserving).
if (r.diff === 0) ok('generated render is PIXEL-IDENTICAL to the runtime loadShaders path');
else if (r.maxd <= 2) ok('generated render matches runtime within AA tolerance (diff ' + r.diff + ' px, maxd ' + r.maxd + ')');
else fail('generated render differs from runtime: ' + r.diff + ' px, maxd ' + r.maxd);

await browser.close();
server.close();
if (failures === 0) console.log('\nSHADER-BUILD PASS');
else console.log(`\nSHADER-BUILD FAIL (${failures})`);
process.exit(failures ? 1 : 0);
