// exportTextSvgSmoke.mjs — proof that renderer.exportFrameSVG() handles
// TEXT bundles two ways:
//   - default (recoverText off): glyph-outline <path>s, synthesized from
//     the GL text bundle's own geometry (which carries no svgSource).
//   - recoverText:true with a bundle built { retainText:true }: a real
//     SVG <text> element carrying the original string, fill and baseline.
//   - recoverText:true but NO retained text → falls back to glyph paths.
//
// Runs in a real browser (puppeteer) with a real WebGL2 context + real
// DOMParser, using the Roboto fixture for shaping.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const fontB64 = readFileSync(new URL('./font/fixtures/roboto-regular.ttf', import.meta.url)).toString('base64');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="128"></canvas>
<script type="module">
import { createRenderer, loadShaders, createTextBundle, MantleFontAsset }
  from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setFrameCapture(true);   // export capture is opt-in (defaults off)
const FONT = new MantleFontAsset(Uint8Array.from(atob('${fontB64}'), c => c.charCodeAt(0)));
const STYLE = { fill: [0.1, 0.2, 0.7, 1], fontSizePx: 32 };

const tbKeep = await createTextBundle(gl, { font: FONT, text: 'Hi', style: STYLE, retainText: true });
const tbPlain = await createTextBundle(gl, { font: FONT, text: 'Hi', style: STYLE });

window.__hasSource = !!(tbKeep.bundle && tbKeep.bundle.textSource);
window.__plainNoSource = !(tbPlain.bundle && tbPlain.bundle.textSource);

const exportOf = async (tb, recoverText) => {
  renderer.setViewport(256, 128);
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(tb.bundle, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ recoverText, detail: true });
};
window.__keepGlyphs = () => exportOf(tbKeep, false);
window.__keepText   = () => exportOf(tbKeep, true);
window.__plainRecover = () => exportOf(tbPlain, true);

window.__parse = (svg) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const text = root.querySelector('text');
  return {
    paths: root.querySelectorAll('path').length,
    hasText: !!text,
    textContent: text ? text.textContent : null,
    textFill: text ? text.getAttribute('fill') : null,
    textY: text ? text.getAttribute('y') : null,
    textSize: text ? text.getAttribute('font-size') : null,
  };
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

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

if (await page.evaluate(() => window.__hasSource)) ok('createTextBundle({retainText}) attaches bundle.textSource');
else fail('retainText did not attach textSource');
if (await page.evaluate(() => window.__plainNoSource)) ok('default createTextBundle leaves textSource unset');
else fail('plain text bundle unexpectedly has textSource');

// (1) Default export → synthesized glyph outlines, no <text>.
const glyphs = await page.evaluate(async () => {
  const rep = await window.__keepGlyphs();
  return { rep, p: window.__parse(rep.svg) };
});
if (glyphs.rep.drawn === 1 && glyphs.rep.skipped === 0 && glyphs.p.paths >= 1 && !glyphs.p.hasText)
  ok('default text export → ' + glyphs.p.paths + ' glyph <path>s (synthesized), no <text>');
else fail('glyph text export wrong: ' + JSON.stringify({ d: glyphs.rep.drawn, s: glyphs.rep.skipped, p: glyphs.p }).slice(0, 200));

// (2) recoverText → a real <text> with the original string, fill, baseline.
const txt = await page.evaluate(async () => {
  const rep = await window.__keepText();
  return { rep, p: window.__parse(rep.svg) };
});
if (txt.p.hasText && txt.p.textContent === 'Hi') ok('recoverText emits <text> with the original string "Hi"');
else fail('recovered <text> missing/incorrect string: ' + JSON.stringify(txt.p).slice(0, 200));
if (txt.p.textFill === 'rgba(26,51,179,1)') ok('recovered <text> carries the original fill (rgba(26,51,179,1))');
else fail('recovered <text> fill wrong: ' + txt.p.textFill);
if (txt.p.textSize === '1' && txt.p.textY != null && Number.isFinite(parseFloat(txt.p.textY)))
  ok('recovered <text> uses em font-size + a finite baseline y=' + txt.p.textY);
else fail('recovered <text> size/baseline wrong: size=' + txt.p.textSize + ' y=' + txt.p.textY);

// (3) recoverText on a bundle WITHOUT retained text → glyph fallback.
const fb = await page.evaluate(async () => {
  const rep = await window.__plainRecover();
  return { rep, p: window.__parse(rep.svg) };
});
if (fb.p.paths >= 1 && !fb.p.hasText && fb.rep.drawn === 1)
  ok('recoverText on a non-retained text bundle falls back to glyph outlines');
else fail('glyph fallback wrong: ' + JSON.stringify({ rep: fb.rep, p: fb.p }).slice(0, 200));

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nexportTextSvgSmoke: all assertions passed');
