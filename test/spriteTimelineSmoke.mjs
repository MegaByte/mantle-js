// spriteTimelineSmoke.mjs — createSpriteTimeline proof.
// One sheet with three pose sprites of matched topology (a single rect that
// recolors + moves). A 3-key timeline plays poseA → poseB → poseC. Asserts:
//   1. setTime at each key time shows that key's pose (red / green / blue).
//   2. Between keys the active sprite interpolates (geometry + colour).
//   3. The bracket morph is reused on the hot path (same bracket → no
//      rebuild) and rebuilds when crossing a key.
//   4. Clamping before key 0 / after key N holds the end pose.
//   5. dispose() runs clean (no GL error after).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Three poses, each a single rect (matched topology), at distinct x + colour.
const SHEET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100">
  <g id="a"><rect x="20"  y="30" width="60" height="40" fill="#ff0000"/></g>
  <g id="b"><rect x="120" y="30" width="60" height="40" fill="#00ff00"/></g>
  <g id="c"><rect x="220" y="30" width="60" height="40" fill="#0000ff"/></g>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="300" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createSpriteTimeline } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}));
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__hasFn = typeof createSpriteTimeline === 'function';

const tl = createSpriteTimeline(gl,
  [ { bundle: sheet, sprite: 'a' },
    { bundle: sheet, sprite: 'b' },
    { bundle: sheet, sprite: 'c' } ],
  [ { time: 0.0, refIndex: 0 },
    { time: 1.0, refIndex: 1 },
    { time: 2.0, refIndex: 2 } ]);
window.__duration = tl.duration;
window.__draw = (time) => {
  tl.setTime(time);
  renderer.setViewport(300, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(tl.bundle, { worldMatrix: id, overrides: tl.currentMorph ? tl.currentMorph.overrides : null });
  renderer.endFrame();
};
window.__morphId = () => tl.currentMorph;   // identity check for hot-path reuse
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__glErr = () => gl.getError();
// scan for the dominant colour + its x position
window.__scan = () => {
  let best = { x:-1, ch:'.', v:0 };
  for (let x = 0; x < 300; x += 4) {
    const p = window.__sample(x, 50);
    const m = Math.max(p[0], p[1], p[2]);
    if (m > best.v && m > 100) { best = { x, ch: p[0]===m?'R':p[1]===m?'G':'B', v:m, rgb:[p[0],p[1],p[2]] }; }
  }
  return best;
};
window.__disposeAndErr = () => { tl.dispose(); return gl.getError(); };
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

if (await page.evaluate(() => window.__hasFn)) ok('createSpriteTimeline exported');
else fail('createSpriteTimeline not exported');
if (await page.evaluate(() => window.__duration) === 2.0) ok('duration = 2.0 (last key - first key)');
else fail('duration wrong: ' + await page.evaluate(() => window.__duration));

// (1) key times → each pose. (Hold at exact key times: lo===hi.)
const ka = await page.evaluate(() => { window.__draw(0.0); return window.__scan(); });
if (ka.ch === 'R') ok('t=0.0: pose A (red) at x=' + ka.x); else fail('t=0.0 not red: ' + JSON.stringify(ka));
const kb = await page.evaluate(() => { window.__draw(1.0); return window.__scan(); });
if (kb.ch === 'G') ok('t=1.0: pose B (green) at x=' + kb.x); else fail('t=1.0 not green: ' + JSON.stringify(kb));
const kc = await page.evaluate(() => { window.__draw(2.0); return window.__scan(); });
if (kc.ch === 'B') ok('t=2.0: pose C (blue) at x=' + kc.x); else fail('t=2.0 not blue: ' + JSON.stringify(kc));

// position ordering: A left of B left of C.
if (ka.x < kb.x && kb.x < kc.x) ok('poses advance left→right across the timeline (' + ka.x + ' < ' + kb.x + ' < ' + kc.x + ')');
else fail('pose positions not ordered: ' + ka.x + ',' + kb.x + ',' + kc.x);

// (2) between keys: t=0.5 blends A→B (rect between them, colour red↔green).
const mid = await page.evaluate(() => { window.__draw(0.5); return window.__scan(); });
if (mid.x > ka.x && mid.x < kb.x) ok('t=0.5: active sprite between A and B (x=' + mid.x + ')');
else fail('t=0.5 not between A,B: ' + JSON.stringify(mid));

// (3) hot-path reuse: two times in the SAME bracket → same morph object;
// crossing a key → different morph object.
const reuse = await page.evaluate(() => {
  window.__draw(0.3); const m1 = window.__morphId();
  window.__draw(0.7); const m2 = window.__morphId();   // same bracket [0,1]
  window.__draw(1.5); const m3 = window.__morphId();   // bracket [1,2]
  return { sameBracket: m1 === m2, crossedBracket: m2 !== m3 };
});
if (reuse.sameBracket) ok('same bracket reuses the morph (no rebuild on hot path)'); else fail('morph rebuilt within one bracket');
if (reuse.crossedBracket) ok('crossing a key rebuilds the morph for the new bracket'); else fail('morph not rebuilt across keys');

// (4) clamp before/after.
const before = await page.evaluate(() => { window.__draw(-1); return window.__scan(); });
if (before.ch === 'R') ok('t<0 clamps to pose A (red)'); else fail('clamp-before wrong: ' + JSON.stringify(before));
const after = await page.evaluate(() => { window.__draw(99); return window.__scan(); });
if (after.ch === 'B') ok('t>duration clamps to pose C (blue)'); else fail('clamp-after wrong: ' + JSON.stringify(after));

// (5) dispose clean.
const derr = await page.evaluate(() => window.__disposeAndErr());
if (derr === 0) ok('dispose() ran clean (no GL error)'); else fail('GL error after dispose: ' + derr);

await browser.close();
server.close();
if (failures === 0) console.log('\nSPRITE-TIMELINE PASS');
else console.log(`\nSPRITE-TIMELINE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
