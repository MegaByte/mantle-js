// clipCoverageSmoke.mjs — renderer.renderClipCoverage renders an analytic
// (coverage) clip mask to a framebuffer-aligned coverage RT, with NO browser
// rasterization. This is the resolution-independent replacement for the
// consumer-rasterized createClipTexture bitmap behind setNodeClip.
//
// The clip is a STATIONARY screen-space mask (sampled per-fragment via
// gl_FragCoord) that moving content is drawn through — the case Mantle's
// intra-bundle <mask> (which moves WITH its bundle) can't express.
//
// Fixture:
//   - clip bundle = opaque white rect over the TOP half (SVG y 0..50) of a
//     100×100 viewBox. renderClipCoverage rasterizes it via the coverage walker.
//   - content bundle = solid GREEN full-canvas rect.
// Assertions:
//   1. clip-IN  (mode 1): green in the masked half, background in the other.
//   2. clip-OUT (mode 2): the exact complement of clip-IN.
//   3. The two modes PARTITION the content (every pixel green in exactly one),
//      i.e. the coverage is real analytic coverage, not empty/full/garbage.
//   4. Orientation: the masked half is the SVG-top half (screen-space sample
//      aligns with the canvas render — no Y flip needed, unlike a bitmap).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Asymmetric mask: opaque white over the TOP half (SVG y 0..50). Asymmetry
// catches an orientation (Y-flip) bug a centered disc would hide.
const CLIP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">'
  + '<rect x="0" y="0" width="100" height="50" fill="#ffffff"/></svg>';
// Content: solid green full canvas.
const CONTENT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">'
  + '<rect x="0" y="0" width="100" height="100" fill="#00ff00"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const clip = createBundle(gl, await importSvg(${JSON.stringify(CLIP)}));
const content = createBundle(gl, await importSvg(${JSON.stringify(CONTENT)}));
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

renderer.setViewport(100, 100);
// Render the clip coverage ONCE (between frames), coverage-rendered.
const clipTex = renderer.renderClipCoverage(clip, { worldMatrix: id });
window.__gotTex = !!clipTex;

window.__draw = (mode) => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(content, { worldMatrix: id, extClipTex: clipTex, extClipMode: mode });
  renderer.endFrame();
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
// Independence probe: make a SECOND coverage texture, then redraw with the
// FIRST and report whether it survived (distinct object + correct pixels).
window.__independence = () => {
  const clip2 = renderer.renderClipCoverage(clip, { worldMatrix: id });
  const distinct = clip2 !== clipTex;
  renderer.setViewport(100, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(content, { worldMatrix: id, extClipTex: clipTex, extClipMode: 1 });
  renderer.endFrame();
  return { distinct, top: window.__sample(50, 25), bot: window.__sample(50, 75) };
};
// Unified per-bundle API: register a clip against the TARGET bundle, then a
// PLAIN drawBundle (no extClip opts) must auto-apply it — same model as the
// native scene, so a consumer needs no backend branch.
window.__autoApply = (mode) => {
  renderer.setNodeClip(content, { clipBundle: clip, worldMatrix: id, mode });
  renderer.setViewport(100, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(content, { worldMatrix: id });   // NO extClipTex/Mode
  renderer.endFrame();
  const r = { top: window.__sample(50, 25), bot: window.__sample(50, 75) };
  renderer.clearNodeClip(content);
  return r;
};
window.__afterClear = () => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(content, { worldMatrix: id });
  renderer.endFrame();
  return { top: window.__sample(50, 25), bot: window.__sample(50, 75) };
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
const isGreen = (p) => p[1] > 150 && p[0] < 90 && p[2] < 90;
const isBg = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

if (await page.evaluate(() => window.__gotTex)) ok('renderClipCoverage returned a texture');
else fail('renderClipCoverage returned null');

// yTop 25 = SVG-top half; yTop 75 = SVG-bottom half.
const inMode = await page.evaluate(() => { window.__draw(1); return { top: window.__sample(50, 25), bot: window.__sample(50, 75) }; });
const outMode = await page.evaluate(() => { window.__draw(2); return { top: window.__sample(50, 25), bot: window.__sample(50, 75) }; });

// (1) clip-IN: green where masked, background elsewhere.
if (isGreen(inMode.top) && isBg(inMode.bot)) ok('clip-IN: green top half, bg bottom (' + inMode.top + ' / ' + inMode.bot + ')');
else fail('clip-IN wrong: top=' + inMode.top + ' bot=' + inMode.bot);

// (2)+(3) clip-OUT is the exact complement — together they partition content.
if (isBg(outMode.top) && isGreen(outMode.bot)) ok('clip-OUT: complement — bg top, green bottom (partition holds)');
else fail('clip-OUT not the complement: top=' + outMode.top + ' bot=' + outMode.bot);

// (4) Orientation: the SVG-TOP half is the masked (clip-IN green) half.
if (isGreen(inMode.top) && isBg(inMode.bot)) ok('orientation: SVG-top maps to screen-top (no Y flip needed)');
else fail('orientation flipped: clip-IN lit the wrong half');

// (5) Independence: a SECOND renderClipCoverage call returns its own texture
// and does NOT clobber the first (each clip owns a distinct RT).
const indep = await page.evaluate(() => window.__independence());
if (indep.distinct) ok('a second renderClipCoverage returns a DISTINCT texture');
else fail('renderClipCoverage returned the same texture object (would clobber)');
if (isGreen(indep.top) && isBg(indep.bot)) ok('first clip texture intact after a second call (no clobber)');
else fail('first clip texture was clobbered by the second call: top=' + indep.top + ' bot=' + indep.bot);

// (6) Unified per-bundle setNodeClip: a plain drawBundle auto-applies the clip.
const auto = await page.evaluate(() => window.__autoApply('in'));
if (isGreen(auto.top) && isBg(auto.bot)) ok('setNodeClip + plain drawBundle auto-applies (no per-draw extClip, no backend branch)');
else fail('auto-apply failed: top=' + auto.top + ' bot=' + auto.bot);
const cleared = await page.evaluate(() => window.__afterClear());
if (isGreen(cleared.top) && isGreen(cleared.bot)) ok('clearNodeClip: bundle draws unclipped again');
else fail('clearNodeClip left a clip applied: top=' + cleared.top + ' bot=' + cleared.bot);

await browser.close();
server.close();
if (failures === 0) console.log('\nCLIP-COVERAGE PASS');
else console.log(`\nCLIP-COVERAGE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
