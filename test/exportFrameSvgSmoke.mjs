// exportFrameSvgSmoke.mjs — proof that the WebGL (non-native) renderer can
// serialize the CURRENT FRAME to an SVG string by replaying its recorded
// draw list through the native (DOM) backend — renderer.exportFrameSVG().
//
// Runs in a real browser (puppeteer) with a REAL WebGL2 context (the
// non-native renderer is the thing under test) AND real DOMParser /
// XMLSerializer (so the native replay + serialization are genuine).
//
// Asserts:
//   1. renderer.exportFrameSVG exists; capture is on by default.
//   2. A drawn frame serializes to a parseable <svg> with content.
//   3. Per-shape overrides land in the markup: a hidden shape is hidden,
//      a recolored shape carries its new fill.
//   4. A shape MORPH reconstructs geometry on demand: export at t=0 and
//      t=0.5 differ (the lerped path is rebuilt on the CPU at call time),
//      with zero skipped draws.
//   5. PRECONDITION: a bundle imported WITHOUT retainSource is skipped
//      (and reported in notes), not silently emitted blank.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Three id'd shapes so overrides can address them by id.
const ART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect id="box" x="10" y="10" width="30" height="30" fill="#e74c3c"/>
  <circle id="dot" cx="72" cy="25" r="15" fill="#2980b9"/>
  <rect id="bar" x="20" y="60" width="60" height="25" fill="#27ae60"/>
</svg>`;

// Two matched-topology poses (same id 'p', same path topology, different x)
// for a whole-bundle shape morph. The matched path lerps geometrically.
const POSE_A = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path id="p" d="M10 10 H40 V40 H10 Z" fill="#ff0000"/>
</svg>`;
const POSE_B = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path id="p" d="M60 10 H90 V40 H60 Z" fill="#0000ff"/>
</svg>`;

// A two-sprite sheet for drawSprite subset export.
const SHEET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <g id="poseA"><rect id="ra" x="10" y="20" width="60" height="60" fill="#ff0000"/></g>
  <g id="poseB"><rect id="rb" x="130" y="20" width="60" height="60" fill="#0000ff"/></g>
</svg>`;

// A clipped shape whose clip can be moved via setClipper('win', …).
const CLIPART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <clipPath id="win"><rect id="winrect" x="0" y="0" width="40" height="100"/></clipPath>
  <rect id="wide" x="0" y="0" width="100" height="100" fill="#8e44ad" clip-path="url(#win)"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable, createShapeMorph }
  from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

const artSections = await importSvg(${JSON.stringify(ART)}, { retainSource: true });
const art = createBundle(gl, artSections);
const noSrc = createBundle(gl, await importSvg(${JSON.stringify(ART)})); // no retainSource

const poseA = createBundle(gl, await importSvg(${JSON.stringify(POSE_A)}, { retainSource: true }));
const poseB = createBundle(gl, await importSvg(${JSON.stringify(POSE_B)}, { retainSource: true }));
const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}, { retainSource: true }));
const clipArt = createBundle(gl, await importSvg(${JSON.stringify(CLIPART)}, { retainSource: true }));

window.__hasFn = typeof renderer.exportFrameSVG === 'function';
// Capture defaults OFF (export instrumentation is opt-in); enable it for
// the frames we want to export — the intended usage pattern.
window.__capDefaultOff = renderer.frameCaptureEnabled === false;
renderer.setFrameCapture(true);

// Draw a plain frame, then export it.
window.__exportPlain = async () => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(art, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// Draw with overrides: hide 'dot', recolor 'box' to a unique green.
window.__exportOverridden = async () => {
  const ovr = createOverrideTable(gl, art);
  ovr.set('dot', { visibility: 0 });
  ovr.set('box', { fill: [0.1, 0.8, 0.3, 1] });
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(art, { overrides: ovr });
  renderer.endFrame();
  return await renderer.exportFrameSVG();
};

// Morph poseA→poseB; export at a given t.
const morph = createShapeMorph(gl, poseA, poseB);
window.__exportMorph = async (t) => {
  morph.setT(t);
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(morph, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// drawSprite subset: only the addressed sprite's shapes should survive;
// the rest of the sheet is hidden. Compare a full-sheet draw (nothing
// hidden) against a single-sprite draw (the other sprite hidden).
window.__exportSheetFull = async () => {
  renderer.setViewport(200, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(sheet, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG();
};
window.__exportSprite = async () => {
  renderer.setViewport(200, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawSprite(sheet, 'poseB', {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// Animated clipper: move the clip via setClipper, then export — the live
// <clipPath> element should carry the transform in the markup.
window.__exportClipper = async () => {
  const ovr = createOverrideTable(gl, clipArt);
  ovr.setClipper('win', { localPosition: [30, 0] });
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(clipArt, { overrides: ovr });
  renderer.endFrame();
  return await renderer.exportFrameSVG();
};

// A bundle with no retained source must be skipped, not blank-emitted.
window.__exportNoSrc = async () => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(noSrc, {});
  renderer.endFrame();
  return await renderer.exportFrameSVG({ detail: true });
};

// Parse helper run in-page (real DOMParser).
window.__parse = (svg) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  // Count visually-hidden elements (opacity 0 via attr or style).
  let hidden = 0;
  for (const el of root.querySelectorAll('*')) {
    const op = el.getAttribute('opacity');
    const st = (el.getAttribute('style') || '');
    const disp = el.style ? el.style.display : '';
    if (op === '0' || /opacity\\s*:\\s*0(?!\\.)/.test(st) || disp === 'none'
        || /display\\s*:\\s*none/.test(st)) hidden++;
  }
  return {
    tag: root.tagName.toLowerCase(),
    childCount: root.querySelectorAll('*').length,
    hidden,
    // The recolor fill [0.1,0.8,0.3,1] serializes (rgbaToCss) to
    // rgba(26,204,77,1). Assert that exact value reached the markup.
    hasGreenFill: /rgba\\(\\s*26\\s*,\\s*204\\s*,\\s*77\\b/.test(svg),
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

// (1) API surface.
if (await page.evaluate(() => window.__hasFn)) ok('renderer.exportFrameSVG exists');
else fail('exportFrameSVG not present');
if (await page.evaluate(() => window.__capDefaultOff)) ok('frame capture OFF by default (export instrumentation is opt-in)');
else fail('frameCaptureEnabled should default to false');

// (2) Plain frame serializes to a parseable, non-empty <svg>.
const plain = await page.evaluate(async () => {
  const rep = await window.__exportPlain();
  return { rep, p: window.__parse(rep.svg) };
});
if (typeof plain.rep.svg === 'string' && plain.p.tag === 'svg' && plain.p.childCount > 0)
  ok('plain frame → parseable <svg> with ' + plain.p.childCount + ' elements');
else fail('plain export malformed: ' + JSON.stringify(plain.rep).slice(0, 200));
if (plain.rep.drawn === 1 && plain.rep.skipped === 0) ok('plain frame: drawn=1 skipped=0');
else fail('plain draw/skip counts: ' + JSON.stringify({ d: plain.rep.drawn, s: plain.rep.skipped }));

// (3) Overrides land in the markup: one hidden, one recolored.
const ovr = await page.evaluate(async () => {
  const svg = await window.__exportOverridden();
  return { svg, p: window.__parse(svg) };
});
if (ovr.p.hidden >= 1) ok('overridden frame hides the addressed shape (' + ovr.p.hidden + ' hidden)');
else fail('hidden-shape override did not land in markup');
if (ovr.p.hasGreenFill) ok('overridden frame carries the recolored fill');
else fail('recolor override fill not found in markup');

// (4) Morph reconstructs geometry on demand: t=0 vs t=0.5 differ.
const m = await page.evaluate(async () => {
  const a = await window.__exportMorph(0);
  const b = await window.__exportMorph(0.5);
  return { a, b };
});
if (m.a.drawn >= 1 && m.a.skipped === 0 && m.b.drawn >= 1 && m.b.skipped === 0)
  ok('morph frames export with no skipped draws');
else fail('morph export draw/skip: ' + JSON.stringify({ a: m.a, b: m.b }).slice(0, 200));
if (m.a.svg !== m.b.svg) ok('morph geometry differs between t=0 and t=0.5 (CPU rebuild at export time)');
else fail('morph export identical across t — geometry not reconstructed');

// (5) drawSprite subset export: only the sprite's shapes survive.
const sp = await page.evaluate(async () => {
  const full = window.__parse(await window.__exportSheetFull());
  const rep = await window.__exportSprite();
  return { fullHidden: full.hidden, rep, p: window.__parse(rep.svg) };
});
if (sp.fullHidden === 0 && sp.p.hidden >= 1 && sp.rep.drawn === 1 && sp.rep.skipped === 0)
  ok('drawSprite exports the sprite subset (other sprite hidden: full=' + sp.fullHidden
     + ' sprite=' + sp.p.hidden + ')');
else fail('sprite-subset export wrong: ' + JSON.stringify({ full: sp.fullHidden, rep: sp.rep, hidden: sp.p.hidden }).slice(0, 200));

// (6) Animated clipper export: the <clipPath> child carries the transform.
const clip = await page.evaluate(async () => {
  const svg = await window.__exportClipper();
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  // The transform lands on the clip element (clipPath or its child).
  const moved = [...doc.documentElement.querySelectorAll('*')].some(e => {
    const t = e.getAttribute('transform') || '';
    return /translate\(\s*30\b/.test(t);
  });
  return { moved, hasClip: /clipPath/i.test(svg) };
});
if (clip.hasClip && clip.moved) ok('setClipper transform reproduced on the live <clipPath> (translate 30)');
else fail('animated clipper not reproduced in export: ' + JSON.stringify(clip));

// (7) Precondition: no-retainSource bundle is skipped + noted, not blank.
const ns = await page.evaluate(async () => await window.__exportNoSrc());
if (ns.skipped >= 1 && ns.drawn === 0 && ns.notes.some(n => /svgSource|retainSource/i.test(n)))
  ok('bundle without retainSource is skipped + reported (not silently blank)');
else fail('no-retainSource handling wrong: ' + JSON.stringify(ns).slice(0, 200));

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nexportFrameSvgSmoke: all assertions passed');
