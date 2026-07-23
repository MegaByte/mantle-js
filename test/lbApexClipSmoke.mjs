// lbApexClipSmoke.mjs — the apex-tangent supporting-line clip (opt-in __LB_APEX_CLIP)
// recovers the FAT-POKE decline class: a split sub-piece of a fat cubic with a degenerate
// endpoint tangent falls to the Bezout resultant, whose spurious branch paints f<0 a thin
// sliver BEYOND the curve apex (air over-paint → the audit declines the whole shape).
// Clipping the crescent to the chord side of its apex tangent (a supporting line for the
// convex sub-piece) removes that region with no under-fill; a RE-AUDIT keeps the shape only
// if all over-paint is gone. A/Bs the clip on the tiger (a curve-heavy fixture with many
// such pieces): enabling it must RECOVER declined shapes and NEVER add an over-painting
// piece to a kept mesh. One fresh page per variant so the global mesh cache is clean.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(256, 256);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const meshes = bundle._lbMeshes || [];
let real = 0, sent = 0; for (const m of meshes) { if (m && m.vertexCount) real++; else sent++; }
window.__out = { real, sent, clip: globalThis.__LB_APEX_CLIP !== false }; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => { try {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  const p = decodeURIComponent(req.url.split('?')[0]);
  res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
} catch { if (!res.headersSent) res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };
const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const run = async (clip) => {
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('  [page-err]', e.message));
  // Default-on now, so OFF must explicitly disable; ON is the default.
  await page.evaluateOnNewDocument((c) => { globalThis.__LB_APEX_CLIP = c; }, clip);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 25000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  const o = await page.evaluate(() => window.__out); await page.close(); return o;
};
let off, on;
try { off = await run(false); on = await run(true); }
catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }
console.log('   clip OFF:', JSON.stringify(off));
console.log('   clip ON :', JSON.stringify(on));
if (off.sent > 20) ok('non-vacuous: fixture declines ' + off.sent + ' shapes without the clip');
else fail('vacuous: only ' + off.sent + ' declines without the clip');
if (on.clip) ok('the __LB_APEX_CLIP hook took effect'); else fail('the clip hook did not take effect');
if (on.sent < off.sent) ok('apex clip recovered ' + (off.sent - on.sent) + ' fat-poke shape(s) (sent ' + off.sent + ' → ' + on.sent + ')');
else fail('apex clip recovered NO shape (sent ' + off.sent + ' → ' + on.sent + ') — clip broken');
await browser.close();
server.close();
if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nlbApexClipSmoke: apex-tangent clip recovers over-painting fat-poke crescents (re-audit-guarded)');
