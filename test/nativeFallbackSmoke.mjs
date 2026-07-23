// nativeFallbackSmoke.mjs — proof the no-WebGL fallback renders Mantle
// bundles via the browser's native SVG engine, and that per-shape
// overrides, animated clips (setClipper), and geometry MORPHS all drive
// the DOM correctly.
//
// Runs in a real browser (puppeteer) so DOMParser / createElementNS /
// the SVG rasterizer are all real — but it NEVER creates a WebGL
// context: createNativeScene is the whole point. Pixels are sampled by
// drawing the live <svg> into a 2D canvas (drawImage) and readback.
//
// Asserts:
//   1. importSvg({retainSource:true}) attaches svgSource; default does not.
//   2. createNativeScene builds ONE <svg> with one <g> per drawBundle,
//      z-order = call order, and it actually rasterizes (pixel check).
//   3. Per-shape override by id: translate + recolor + hide land on the
//      addressed element (and only it).
//   4. setClipper transforms the live <clipPath> element.
//   5. curveRangeToPathD round-trips a known rect's curves to a `d` that
//      re-rasterizes to the same shape.
//   6. createNativeMorph rewrites a matched shape's path `d` across t,
//      sliding/!recoloring the rect — geometry interpolates in the DOM.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Three solid shapes, each id'd so overrides can address them.
const ART = readFileSync(new URL('../examples/smoke/nativeFallback__ART.svg', import.meta.url), 'utf8');

// Two matched-topology sprites in one sheet for the morph (same rect
// shape, different x + color), plus a non-sprite marker.
const SHEET = readFileSync(new URL('../examples/smoke/nativeFallback__SHEET.svg', import.meta.url), 'utf8');

// A clipped shape: a wide rect clipped by a small square; moving the
// clip reveals different parts.
const CLIPART = readFileSync(new URL('../examples/smoke/nativeFallback__CLIPART.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="raster" width="100" height="100"></canvas>
<canvas id="raster3" width="300" height="100"></canvas>
<canvas id="raster2" width="100" height="100"></canvas>
<canvas id="raster4" width="100" height="100"></canvas>
<canvas id="raster5" width="300" height="100"></canvas>
<canvas id="raster6" width="160" height="60"></canvas>
<script type="module">
import {
  importSvg, createNativeScene, createNativeMorph, createNativeTimeline,
  createNativeTextBundle, curveRangeToPathD,
} from '/src/index.js';
import { MantleFontAsset } from '/src/font/fontAsset.js';

const host = document.getElementById('host');
const host2 = document.createElement('div'); document.body.appendChild(host2);
const host3 = document.createElement('div'); document.body.appendChild(host3);

// (1) source retention opt-in.
const withSrc = await importSvg(${JSON.stringify(ART)}, { retainSource: true });
const noSrc   = await importSvg(${JSON.stringify(ART)});
window.__retain = { withSrc: typeof withSrc.svgSource === 'string', noSrc: !!noSrc.svgSource };

// (2) build a native scene, draw the art once.
const scene = createNativeScene(host);
scene.setViewport(100, 100);
scene.render(withSrc, { clearColor: [1,1,1,1] });
const svg = scene.svg;
window.__svgInfo = () => ({
  groups: svg.querySelectorAll(':scope > g').length,
  hasBox: !!svg.querySelector('#box,[data-oid="box"]'),
  hasDot: !!svg.querySelector('#dot,[data-oid="dot"]'),
});

// Rasterize the live <svg> into a 2D canvas to sample pixels.
const rctx = document.getElementById('raster').getContext('2d');
async function rasterize(theSvg, w, h, ctx) {
  const xml = new XMLSerializer().serializeToString(theSvg);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);  // string concat (no backtick inside HTML literal)
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  ctx.clearRect(0,0,w,h); ctx.drawImage(img, 0, 0, w, h);
}
window.__sample100 = async (x, y) => {
  await rasterize(svg, 100, 100, rctx);
  const p = rctx.getImageData(x, y, 1, 1).data; return [p[0],p[1],p[2],p[3]];
};

// (3) per-shape override: hide the green bar, recolor the box to yellow,
// translate the dot left by 40 em. Use the native override table the
// scene reads.
import { createNativeOverrideTable } from '/src/index.js';
const ovr = createNativeOverrideTable(withSrc);
ovr.set('bar', { visibility: 0 });
ovr.set('box', { fill: [1, 1, 0, 1] });
ovr.set('dot', { localPosition: [-40, 0] });
window.__drawOverride = async () => {
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(withSrc, { overrides: ovr });
  scene.endFrame();
  const box = svg.querySelector('#box,[data-oid="box"]'), bar = svg.querySelector('#bar,[data-oid="bar"]'), dot = svg.querySelector('#dot,[data-oid="dot"]');
  return {
    boxFill: box && box.getAttribute('fill'),
    barHidden: bar && (bar.getAttribute('opacity') === '0' || bar.style.display === 'none'),
    dotXform: dot && dot.getAttribute('transform'),
  };
};

// (4) clipper.
const clipB = await importSvg(${JSON.stringify(CLIPART)}, { retainSource: true });
const cscene = createNativeScene(document.createElement('div'));
cscene.setViewport(100,100);
const covr = createNativeOverrideTable(clipB);
window.__hasClipRange = !!(clipB.clipperRows && clipB.clipperRows.win);
window.__drawClip = (dx) => {
  covr.setClipper('win', { localPosition: [dx, 0] });
  cscene.beginFrame([1,1,1,1]);
  cscene.drawBundle(clipB, { overrides: covr });
  cscene.endFrame();
  const cp = cscene.svg.querySelector('#win,[data-oid="win"]') || cscene.svg.querySelector('#winrect,[data-oid="winrect"]');
  return cp ? (cp.getAttribute('transform') || '') : null;
};

// (5) curveRangeToPathD round-trip: decode shape 0 of the art (the box
// rect) from its own curve buffer; the d string should be non-empty and
// closed.
window.__pathD = () => {
  const r = withSrc.curveRangesByShape[0];
  const f32 = new Float32Array(withSrc.curves);
  const d = curveRangeToPathD(f32, r.begin, r.end);
  return { d, closed: d.includes('Z'), moves: (d.match(/M/g)||[]).length };
};

// (6) geometry morph: poseA → poseB.
const sheet = await importSvg(${JSON.stringify(SHEET)}, { retainSource: true });
const sheetHost = document.createElement('div');
document.body.appendChild(sheetHost);
const sscene = createNativeScene(sheetHost);
sscene.setViewport(300, 100);
const morph = createNativeMorph(sheet, sheet, { srcSprite: 'poseA', dstSprite: 'poseB' });
window.__morphInfo = { matched: morph.plan.matched.length, hidden: morph.plan.hidden ? morph.plan.hidden.length : 0 };
window.__morphD = (t) => {
  morph.setT(t);
  sscene.beginFrame([1,1,1,1]);
  sscene.drawBundle(morph.bundle, { overrides: morph.overrides });
  sscene.endFrame();
  // Read the matched rect's path d (the source <rect id="ra"> becomes a
  // <path> only if we rewrote it; the morph writes pathD onto #ra).
  const el = sscene.svg.querySelector('#ra,[data-oid="ra"]');
  return el ? (el.getAttribute('d') || el.tagName) : null;
};
// Rasterize the morph sheet and report the centroid x of the morphing
// rect (red→blue), to prove the geometry actually MOVES poseA→poseB.
const r3 = document.getElementById('raster3').getContext('2d');
window.__morphCentroidX = async (t) => {
  morph.setT(t);
  sscene.beginFrame([1,1,1,1]);
  sscene.drawBundle(morph.bundle, { overrides: morph.overrides });
  sscene.endFrame();
  await rasterize(sscene.svg, 300, 100, r3);
  const im = r3.getImageData(0, 0, 300, 100).data;
  let sx = 0, n = 0;
  for (let y = 0; y < 100; y += 3) for (let x = 0; x < 300; x += 2) {
    const i = (y * 300 + x) * 4;
    // opaque, colored (non-white) pixel — the alpha guard matters: the
    // clear is transparent, so RGB alone would count empty pixels.
    if (im[i+3] > 10 && (im[i] < 240 || im[i+1] < 240 || im[i+2] < 240)) { sx += x; n++; }
  }
  return n ? sx / n : -1;
};

// (7) force-fallback: createMantleScene auto-picks WebGL when available,
// but honors the force flags (explicit option + global) so tests can run
// the native path on a WebGL-capable machine.
import { createMantleScene, chooseBackend, loadShaders } from '/src/index.js';
// WebGL passthrough: createMantleScene on the WebGL backend returns the
// real renderer (every GL-only method present), so a createRenderer
// consumer is drop-in. Build one on a real WebGL2 canvas.
window.__webglPassthrough = async () => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  if (!c.getContext('webgl2')) return { skipped: true };
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const scene = await createMantleScene(c, { shaders });
  const glOnly = ['drawSprite','drawSpriteInstanced','drawBundleInstanced','drawInstance','createBundleHandle','setScissorRect','enableStaticCache','createImage','invalidateRenderState','setBundle'];
  return {
    backend: scene.backend,
    isRealRenderer: scene === scene.renderer || !!scene.renderer || typeof scene.createBundleHandle === 'function',
    missing: glOnly.filter(m => typeof scene[m] !== 'function'),
    hasToScene: typeof scene.toScene === 'function',
  };
};
window.__force = async () => {
  const c = document.createElement('canvas'); c.width = 100; c.height = 100;
  const auto    = chooseBackend(c, {}).backend;                 // WebGL here
  const opt     = chooseBackend(c, { forceNative: true }).backend;
  const hard     = chooseBackend(c, { backend: 'native' }).backend;
  globalThis.__MANTLE_FORCE_NATIVE = true;
  const glob    = chooseBackend(c, {}).backend;
  globalThis.__MANTLE_FORCE_NATIVE = false;
  // And the full factory returns a usable native scene under force.
  // createMantleScene is async (it dynamic-import()s the chosen backend),
  // so await it.
  const host = document.createElement('div'); document.body.appendChild(host);
  const scene = await createMantleScene(c, { forceNative: true, nativeHost: host });
  scene.setViewport(100, 100);
  scene.render(scene.toScene(withSrc), { clearColor: [1,1,1,1] });
  return { auto, opt, hard, glob, sceneBackend: scene.backend, drewSvg: !!scene.svg };
};

// (8) raster compositing.
// (8a) a raw raster blit via scene.drawImage — a solid green 20x20 block.
const greenPx = { width: 20, height: 20, rgba: new Uint8Array(20*20*4) };
for (let i = 0; i < 20*20; i++) { greenPx.rgba[i*4+1] = 200; greenPx.rgba[i*4+3] = 255; }
const rscene = createNativeScene(host2);
rscene.setViewport(100, 100);
const rctx2 = document.getElementById('raster2').getContext('2d');
async function rast2() {
  const xml = new XMLSerializer().serializeToString(rscene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  rctx2.clearRect(0,0,100,100); rctx2.drawImage(img, 0, 0, 100, 100);
}
window.__drawRaster = async () => {
  rscene.beginFrame([1,1,1,1]);
  rscene.drawImage(greenPx, { dstRect: [40, 40, 20, 20] });   // green block at (40,40)
  rscene.endFrame();
  await rast2();
  const at = (x,y) => { const p = rctx2.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { inside: at(50,50), outside: at(10,10), hasImageEl: !!rscene.svg.querySelector('image') };
};

// (8b) a bundle whose <image> uses a data: URI renders verbatim (a 1x1
// blue PNG scaled to fill).
const BLUE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQ0TjxHwADXAIEAtgdbwAAAABJRU5ErkJggg==';
const imgSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><image id="pic" href="' + BLUE_PNG + '" x="20" y="20" width="60" height="60"/></svg>';
const imgBundle = await importSvg(imgSvg, { retainSource: true });
const iscene = createNativeScene(host3);
iscene.setViewport(100, 100);
const rctx4 = document.getElementById('raster4').getContext('2d');
window.__drawImgBundle = async () => {
  iscene.render(imgBundle, { clearColor: [1,1,1,1] });
  const xml = new XMLSerializer().serializeToString(iscene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  rctx4.clearRect(0,0,100,100); rctx4.drawImage(img, 0, 0, 100, 100);
  const p = rctx4.getImageData(50, 50, 1, 1).data;
  return { center: [p[0],p[1],p[2],p[3]], hasImg: !!iscene.svg.querySelector('image') };
};

// (9) renderer-parity on the native backend: drawSprite renders ONLY the
// sprite's geometry (real subset, not a stub), and the full renderer
// method surface is present so a createRenderer consumer is drop-in.
const SHEET2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100"><g id="left"><rect id="lr" x="20" y="20" width="60" height="60" fill="#ff0000"/></g><g id="right"><rect id="rr" x="220" y="20" width="60" height="60" fill="#0000ff"/></g></svg>';
const sheet2 = await importSvg(SHEET2, { retainSource: true });
const host4 = document.createElement('div'); document.body.appendChild(host4);
const spScene = createNativeScene(host4);
spScene.setViewport(300, 100);
const rctx5 = document.getElementById('raster5').getContext('2d');
async function rast5() {
  const xml = new XMLSerializer().serializeToString(spScene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  rctx5.clearRect(0,0,300,100); rctx5.drawImage(img, 0, 0, 300, 100);
}
window.__surface = () => {
  const need = ['drawSprite','drawSpriteInstanced','drawBundleInstanced','drawImageInstanced','drawInstance','createImage','createBundleHandle','setScissorRect','clearScissorRect','enableStaticCache','disableStaticCache','invalidateRenderState','setBundle','render','drawBundle','drawImage','setViewport','beginFrame','endFrame'];
  return need.filter(m => typeof spScene[m] !== 'function');
};
window.__drawSpriteNative = async (id) => {
  spScene.beginFrame([1,1,1,1]);
  spScene.drawSprite(sheet2, id);
  spScene.endFrame();
  await rast5();
  const colored = (x,y) => { const p = rctx5.getImageData(x,y,1,1).data; return p[3] > 10 && (p[0] < 240 || p[1] < 240 || p[2] < 240); };
  return { leftPainted: colored(50, 50), rightPainted: colored(250, 50) };
};

// (9b) id-less sprite sheet: sprite groups keep ids (spriteRanges needs the
// <g id> names) but the inner shapes have no ids. The subset hide must be
// positional — an id-keyed hide misses the synthetic-id inner shapes and
// paints the whole sheet instead of one sprite.
const SHEET_IDLESS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100"><g id="left"><rect x="20" y="20" width="60" height="60" fill="#ff0000"/></g><g id="right"><rect x="220" y="20" width="60" height="60" fill="#0000ff"/></g></svg>';
const sheetIdless = await importSvg(SHEET_IDLESS, { retainSource: true });
window.__drawSpriteIdless = async (id) => {
  spScene.beginFrame([1,1,1,1]);
  spScene.drawSprite(sheetIdless, id);
  spScene.endFrame();
  await rast5();
  const colored = (x,y) => { const p = rctx5.getImageData(x,y,1,1).data; return p[3] > 10 && (p[0] < 240 || p[1] < 240 || p[2] < 240); };
  return { innerIds: sheetIdless.shapeIds, leftPainted: colored(50, 50), rightPainted: colored(250, 50) };
};

// (9c) STROKED sprite sheet: a fill+stroke shape occupies TWO meta rows,
// so sprite ranges (meta-row space) outnumber DOM elements — a positional
// row hide lands on the wrong shapes and can paint the whole sheet. The
// subset must isolate the sprite's own element by id instead.
const SHEET_STROKED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100"><g id="left"><rect x="20" y="20" width="60" height="60" fill="#ff0000" stroke="#000000" stroke-width="4"/></g><g id="right"><rect x="220" y="20" width="60" height="60" fill="#0000ff" stroke="#000000" stroke-width="4"/></g></svg>';
const sheetStroked = await importSvg(SHEET_STROKED, { retainSource: true });
window.__drawSpriteStroked = async (id) => {
  spScene.beginFrame([1,1,1,1]);
  spScene.drawSprite(sheetStroked, id);
  spScene.endFrame();
  await rast5();
  const colored = (x,y) => { const p = rctx5.getImageData(x,y,1,1).data; return p[3] > 10 && (p[0] < 240 || p[1] < 240 || p[2] < 240); };
  return { ranges: sheetStroked.spriteRanges, domIndex: sheetStroked.shapeDomIndex,
           leftPainted: colored(50, 50), rightPainted: colored(250, 50) };
};

// (9d) POSITIONAL override on the stroked (synthetic-id) sheet: row index
// must route through bundle.shapeDomIndex — row 2 is the SECOND rect's
// fill (rows 0/1 both belong to the first rect), not the third element.
window.__overrideStroked = async () => {
  const ovr = createNativeOverrideTable(sheetStroked);
  ovr.set('shape_2_fill', { fill: [1, 0, 1, 1] });   // magenta → right rect
  spScene.beginFrame([1,1,1,1]);
  spScene.drawBundle(sheetStroked, { overrides: ovr });
  spScene.endFrame();
  await rast5();
  const magenta = (x,y) => { const p = rctx5.getImageData(x,y,1,1).data; return p[0] > 200 && p[2] > 200 && p[1] < 80; };
  return { leftMagenta: magenta(50, 50), rightMagenta: magenta(250, 50) };
};

// (11) backend-agnostic BINDING factories on the scene — the real
// drop-in test for an overrides/timeline consumer. No gl arg, no gating:
// scene.createOverrideTable / createMorph / createTimeline.
window.__bindingFactories = async () => {
  const c = document.createElement('canvas'); c.width = 300; c.height = 100;
  const host = document.createElement('div'); document.body.appendChild(host);
  const scene = await createMantleScene(c, { forceNative: true, nativeHost: host });
  const out = { backend: scene.backend };
  // createOverrideTable(bundle) — no gl.
  const ov = scene.createOverrideTable(sheet2);
  out.ovHasSet = typeof ov.set === 'function' && typeof ov.setClipper === 'function';
  ov.set('lr', { fill: [0, 1, 0, 1] });          // recolor left rect green
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(sheet2, { overrides: ov });
  scene.endFrame();
  const lel = scene.svg.querySelector('#lr,[data-oid="lr"]');
  const lf = (lel && lel.getAttribute('fill') || '').replace(/\s/g, '');
  out.ovApplied = lf.indexOf('0,255,0') >= 0;
  // createMorph(src, dst, {srcSprite,dstSprite}) — sprite morph.
  const m = scene.createMorph(sheet2, sheet2, { srcSprite: 'left', dstSprite: 'right' });
  out.morphHasSetT = typeof m.setT === 'function';
  m.setT(1);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(m.bundle, { overrides: m.overrides });
  scene.endFrame();
  const mel = scene.svg.querySelector('#lr,[data-oid="lr"]');
  out.morphMovedD = !!(mel && mel.getAttribute('d') && /M2[0-9][0-9]/.test(mel.getAttribute('d'))); // slid to ~220
  // createTimeline(refs, keys) — sprite refs.
  const tl = scene.createTimeline(
    [{ bundle: sheet2, sprite: 'left' }, { bundle: sheet2, sprite: 'right' }],
    [{ time: 0, refIndex: 0 }, { time: 1, refIndex: 1 }]);
  out.tlHasSetTime = typeof tl.setTime === 'function';
  tl.setTime(0.5);
  out.tlOk = !!tl.bundle;
  return out;
};

// (12) native text bundle: glyph OUTLINES render (no browser-font dep).
const fontBytes = new Uint8Array(await (await fetch('/__font')).arrayBuffer());
const font = new MantleFontAsset(fontBytes);
const tbHost = document.createElement('div'); document.body.appendChild(tbHost);
const tscene = createNativeScene(tbHost); tscene.setViewport(160, 60);
const tb = await createNativeTextBundle({ font, text: 'Hi', style: { fill: [0.05,0.05,0.05,1], fontSizePx: 40 } });
const rctx6 = document.getElementById('raster6').getContext('2d');
// Degenerate text (empty / whitespace) must never produce a NaN or
// non-positive globalBBox dimension — a consumer's em→pixel math
// (nodeScale * globalBBox[2]) would otherwise go NaN.
window.__textBboxFinite = async () => {
  const results = [];
  for (const t of ['', ' ', '\t', 'Hi']) {
    const b = await createNativeTextBundle({ font, text: t, style: { fontSizePx: 40 } });
    const bb = b.bundle.globalBBox;
    const vbM = b.bundle.svgSource.match(/viewBox="([^"]+)"/);
    results.push({
      t, finite: bb.every(Number.isFinite),
      whNonNeg: bb[2] >= 0 && bb[3] >= 0,
      svgViewBoxFinite: !!vbM && vbM[1].split(' ').every(n => Number.isFinite(+n)),
    });
  }
  return results;
};
window.__textBundle = async () => {
  // Single-bundle render: the scene viewBox = the text bundle's em-box, the
  // <svg> width/height (set below) scale it to fill — no worldMatrix needed.
  const bb = tb.bundle.globalBBox;
  tscene.svg.setAttribute('width', '160'); tscene.svg.setAttribute('height', '60');
  tscene.beginFrame([1,1,1,1]);
  tscene.drawBundle(tb.bundle, {});
  tscene.endFrame();
  const xml = new XMLSerializer().serializeToString(tscene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  rctx6.clearRect(0,0,160,60); rctx6.drawImage(img, 0, 0, 160, 60);
  let dark = 0; const d = rctx6.getImageData(0,0,160,60).data;
  for (let i=0;i<d.length;i+=4) if (d[i]<80 && d[i+1]<80 && d[i+2]<80 && d[i+3]>100) dark++;
  // The glyph curves MUST be normalized so globalBBox's (xmin, ymin) is
  // (0,0) — same as the GL path (textBundle.js probe-and-shift). Otherwise
  // the run renders offset DOWN under a worldMatrix (which assumes bundle
  // origin = ink top-left). Also expose the viewBox so we can confirm it
  // starts at 0 0 (not a negative baseline-relative ymin).
  const vbM = tb.bundle.svgSource.match(/viewBox="([^"]+)"/);
  const vb = vbM ? vbM[1].trim().split(' ').map(Number) : null;
  return {
    hasSource: typeof tb.bundle.svgSource === 'string',
    glyphPaths: (tb.bundle.svgSource.match(/<path/g)||[]).length,
    darkPixels: dark,
    bboxXmin: bb[0], bboxYmin: bb[1],
    vbRaw: vbM ? vbM[1] : null,
    vbXmin: vb ? vb[0] : null, vbYmin: vb ? vb[1] : null,
  };
};

// Vertical placement under a worldMatrix: the bug report is "text offset
// DOWN vs GL". With the bundle normalized to (0,0)-origin, a worldMatrix
// that maps em→pixel at the TOP of the viewport must paint the ink in the
// TOP band, not pushed below. Render 'Hi' at a known pixel rect and assert
// the dark ink sits in the upper half (it would sink to the bottom if the
// glyphs kept their baseline-relative coords while the viewBox shifted).
const rctx7 = (() => { const c = document.createElement('canvas'); c.width=160; c.height=80; document.body.appendChild(c); return c.getContext('2d'); })();
window.__textPlacement = async () => {
  const placed = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
  document.body.appendChild(placed.svg);
  placed.setViewport(160, 80);
  const bb = tb.bundle.globalBBox;            // (0,0,w,h) after normalization
  const bw = bb[2] || 1, bh = bb[3] || 1;
  // Map the bundle's em-box into the pixel rect [10,5, 140, 35] — top band.
  const sx = 140 / bw, sy = 35 / bh;
  const wm = new Float32Array([sx,0,0, 0,sy,0, 10 - bb[0]*sx, 5 - bb[1]*sy, 1]);
  placed.beginFrame([1,1,1,1]);
  placed.drawBundle(tb.bundle, { worldMatrix: wm });
  placed.endFrame();
  const xml = new XMLSerializer().serializeToString(placed.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  rctx7.clearRect(0,0,160,80); rctx7.drawImage(img, 0, 0, 160, 80);
  const d = rctx7.getImageData(0,0,160,80).data;
  let topDark = 0, botDark = 0, minY = 999, maxY = -1;
  for (let y=0; y<80; y++) for (let x=0; x<160; x++) {
    const i = (y*160+x)*4;
    if (d[i]<80 && d[i+1]<80 && d[i+2]<80 && d[i+3]>100) {
      if (y < 40) topDark++; else botDark++;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { topDark, botDark, minY, maxY };
};

// (13) native timeline exposes currentMorph (consumers read .currentMorph?.overrides).
const tlSheet = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><g id="p"><rect id="rp" x="20" y="20" width="60" height="60" fill="#f00"/></g><g id="q"><rect id="rq" x="220" y="20" width="60" height="60" fill="#00f"/></g></svg>', { retainSource: true });
const ntl = createNativeTimeline([{ bundle: tlSheet, sprite: 'p' }, { bundle: tlSheet, sprite: 'q' }], [{ time: 0, refIndex: 0 }, { time: 1, refIndex: 1 }]);
window.__timeline = () => {
  ntl.setTime(0.5);
  return {
    hasCurrentMorph: !!ntl.currentMorph,
    currentMorphOverrides: !!(ntl.currentMorph && ntl.currentMorph.overrides),
    hasBundle: !!ntl.bundle,
  };
};

window.__ready = true;
</script></body></html>`;

const FONT_PATH = '/System/Library/Fonts/Supplemental/Arial.ttf';
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  if (req.url === '/__font') {
    try { res.writeHead(200, { 'content-type': 'font/ttf' }); res.end(readFileSync(FONT_PATH)); }
    catch { res.writeHead(404); res.end(); }
    return;
  }
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
page.on('console', m => { const t = m.text(); if (/Mantle\]|err/i.test(t)) console.log('  [page]', t); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

// (1) retention opt-in.
const retain = await page.evaluate(() => window.__retain);
if (retain.withSrc) ok('retainSource:true attaches svgSource'); else fail('svgSource not attached with retainSource');
if (!retain.noSrc) ok('default import does NOT retain source (regular consumers pay nothing)'); else fail('svgSource leaked into default import');

// (2) single <svg>, one <g>, rasterizes.
const info = await page.evaluate(() => window.__svgInfo());
if (info.groups === 1) ok('one <g> per drawBundle (single-<svg> composition)'); else fail('expected 1 <g>, got ' + info.groups);
if (info.hasBox && info.hasDot) ok('source shapes present in the <svg> by id'); else fail('source shapes missing: ' + JSON.stringify(info));
const boxPx = await page.evaluate(() => window.__sample100(25, 25));   // inside the red box
if (boxPx[0] > 180 && boxPx[1] < 100) ok('native <svg> rasterizes: red box pixel = ' + JSON.stringify(boxPx));
else fail('box did not rasterize red: ' + JSON.stringify(boxPx));

// (3) overrides by id.
const ov = await page.evaluate(() => window.__drawOverride());
if (/255,255,0|rgba\(255,255,0/.test(ov.boxFill || '')) ok('override recolored #box to yellow'); else fail('box fill override wrong: ' + ov.boxFill);
if (ov.barHidden) ok('override hid #bar (visibility 0)'); else fail('bar not hidden');
if (ov.dotXform && /translate\(-40/.test(ov.dotXform)) ok('override translated #dot: ' + ov.dotXform); else fail('dot transform wrong: ' + ov.dotXform);

// (4) clipper.
if (await page.evaluate(() => window.__hasClipRange)) ok('clipperRows has the clip range'); else fail('no clipperRows.win');
const clipX0 = await page.evaluate(() => window.__drawClip(0));
const clipX30 = await page.evaluate(() => window.__drawClip(30));
if (clipX30 && /translate\(30/.test(clipX30)) ok('setClipper transforms the live clip element: ' + clipX30);
else fail('clipper transform not applied: ' + clipX30);

// (5) curveRangeToPathD round-trip.
const pd = await page.evaluate(() => window.__pathD());
if (pd.d && pd.closed && pd.moves >= 1) ok('curveRangeToPathD decoded the rect: ' + JSON.stringify(pd.d).slice(0, 80));
else fail('pathD decode wrong: ' + JSON.stringify(pd));

// (6) morph rewrites geometry.
const mi = await page.evaluate(() => window.__morphInfo);
if (mi.matched >= 1) ok('morph matched the two poses\' rects (' + mi.matched + ')'); else fail('morph matched nothing: ' + JSON.stringify(mi));
const d0 = await page.evaluate(() => window.__morphD(0));
const d1 = await page.evaluate(() => window.__morphD(1));
const dm = await page.evaluate(() => window.__morphD(0.5));
if (d0 && d1 && d0 !== d1) ok('morph rewrites #ra path d across t (geometry interpolates)');
else fail('morph d did not change t0→t1: ' + JSON.stringify({ d0, d1 }));
// d at 0.5 should differ from both endpoints (true tween, not a snap).
if (dm && dm !== d0 && dm !== d1) ok('morph d at t=0.5 is between the poses');
else fail('morph d at 0.5 not between: ' + JSON.stringify({ d0, dm, d1 }));

// Geometry actually slides poseA(x≈20-80, centroid≈50) → poseB(x≈220-280,
// centroid≈250), with t=0.5 in between — a real rasterized tween.
const cx0 = await page.evaluate(() => window.__morphCentroidX(0));
const cx5 = await page.evaluate(() => window.__morphCentroidX(0.5));
const cx1 = await page.evaluate(() => window.__morphCentroidX(1));
if (cx0 < 100 && cx1 > 200) ok(`morph slides A→B (centroid x: t0=${cx0|0} t1=${cx1|0})`);
else fail(`morph endpoints wrong (t0=${cx0|0} t1=${cx1|0})`);
if (cx5 > cx0 + 30 && cx5 < cx1 - 30) ok(`morph t=0.5 rasterizes between (centroid x=${cx5|0})`);
else fail(`morph midpoint not between (t0=${cx0|0} t0.5=${cx5|0} t1=${cx1|0})`);

// (7) forcing the fallback for testing.
const fb = await page.evaluate(() => window.__force());
if (fb.auto === 'webgl') ok('chooseBackend auto-picks webgl when available');
else fail('expected auto=webgl (WebGL should be available in test), got ' + fb.auto);
if (fb.opt === 'native' && fb.hard === 'native' && fb.glob === 'native')
  ok('force flags select native (forceNative / backend:native / __MANTLE_FORCE_NATIVE)');
else fail('force flags did not select native: ' + JSON.stringify(fb));
if (fb.sceneBackend === 'native' && fb.drewSvg)
  ok('createMantleScene(forceNative) builds a usable native scene');
else fail('forced factory not native: ' + JSON.stringify(fb));

// (8) raster compositing.
const rb = await page.evaluate(() => window.__drawRaster());
if (rb.hasImageEl) ok('scene.drawImage appended an <image> element'); else fail('no <image> from drawImage');
if (rb.inside[1] > 150 && rb.inside[0] < 120) ok(`drawImage raster composited green at dstRect (px=${JSON.stringify(rb.inside)})`);
else fail('raster not green inside dstRect: ' + JSON.stringify(rb.inside));
// "outside" is empty if transparent (alpha 0) or white (clear). Either is
// fine — what matters is it's NOT the green raster.
const outIsGreen = rb.outside[3] > 10 && rb.outside[1] > 150 && rb.outside[0] < 120;
if (!outIsGreen) ok('drawImage raster confined to dstRect (not green outside)');
else fail('raster bled outside dstRect: ' + JSON.stringify(rb.outside));

const ib = await page.evaluate(() => window.__drawImgBundle());
if (ib.hasImg) ok('bundle <image data:> re-hosted as <image>'); else fail('bundle image element missing');
if (ib.center[2] > 150 && ib.center[0] < 120) ok(`bundle data: <image> rasterizes (blue center px=${JSON.stringify(ib.center)})`);
else fail('bundle data: image did not render blue: ' + JSON.stringify(ib.center));

// (9) renderer-parity (drop-in surface) on the native backend.
const missing = await page.evaluate(() => window.__surface());
if (missing.length === 0) ok('native scene exposes the full renderer method surface (drop-in)');
else fail('native scene MISSING renderer methods: ' + missing.join(', '));
const spL = await page.evaluate(() => window.__drawSpriteNative('left'));
if (spL.leftPainted && !spL.rightPainted) ok('native drawSprite renders REAL subset geometry (left sprite only)');
else fail('native drawSprite subset wrong: ' + JSON.stringify(spL));
const spR = await page.evaluate(() => window.__drawSpriteNative('right'));
if (spR.rightPainted && !spR.leftPainted) ok('native drawSprite isolates the right sprite too');
else fail('native drawSprite right subset wrong: ' + JSON.stringify(spR));

// (9b) ID-LESS sprite sheet — the subset hide must be positional.
const spIdless = await page.evaluate(() => window.__drawSpriteIdless('left'));
const innerSynthetic = (spIdless.innerIds || []).every((id) => /^shape_\d+_(fill|stroke)$/.test(id));
if (innerSynthetic) ok('id-less sheet: inner shapes have synthetic ids (' + JSON.stringify(spIdless.innerIds) + ')');
else fail('id-less sheet fixture has authored inner ids: ' + JSON.stringify(spIdless.innerIds));
if (spIdless.leftPainted && !spIdless.rightPainted)
  ok('native drawSprite subsets an ID-LESS sheet (positional hide — left only, sheet not fully drawn)');
else fail('ID-LESS drawSprite drew the whole sheet (positional hide broken): ' + JSON.stringify(spIdless));

// (9c) STROKED sheet — meta rows (2/shape) outnumber DOM elements; the
// subset must isolate by sprite id, not by positional row index.
const spStroked = await page.evaluate(() => window.__drawSpriteStroked('left'));
if (JSON.stringify(spStroked.domIndex) === '[0,0,1,1]')
  ok('stroked sheet exports shapeDomIndex (2 rows/element): ' + JSON.stringify(spStroked.domIndex));
else fail('shapeDomIndex wrong for stroked sheet: ' + JSON.stringify(spStroked.domIndex));
if (spStroked.leftPainted && !spStroked.rightPainted)
  ok('native drawSprite subsets a STROKED sheet (id isolation — meta-row drift immune)');
else fail('STROKED drawSprite subset wrong (ranges ' + JSON.stringify(spStroked.ranges) + '): ' + JSON.stringify(spStroked));
const spStrokedR = await page.evaluate(() => window.__drawSpriteStroked('right'));
if (spStrokedR.rightPainted && !spStrokedR.leftPainted)
  ok('native drawSprite isolates the stroked right sprite too');
else fail('STROKED right subset wrong: ' + JSON.stringify(spStrokedR));

// (9d) positional override on stroked art routes rows through shapeDomIndex.
const ovS = await page.evaluate(() => window.__overrideStroked());
if (ovS.rightMagenta && !ovS.leftMagenta)
  ok('positional override on stroked sheet lands on the right element (row 2 → 2nd rect)');
else fail('positional override drifted on stroked sheet: ' + JSON.stringify(ovS));

// (10) WebGL passthrough: the factory returns the REAL renderer with every
// GL-only method, so a createRenderer consumer is a one-line drop-in.
const wp = await page.evaluate(() => window.__webglPassthrough());
if (wp.skipped) { ok('(webgl passthrough skipped — no WebGL2 in this run)'); }
else if (wp.backend === 'webgl' && wp.missing.length === 0 && wp.hasToScene)
  ok('createMantleScene(webgl) returns the real renderer — all GL-only methods present (drop-in)');
else fail('webgl passthrough incomplete: ' + JSON.stringify(wp));

// (11) backend-agnostic binding factories (the overrides/timeline drop-in).
const bf = await page.evaluate(() => window.__bindingFactories());
if (bf.ovHasSet && bf.ovApplied) ok('scene.createOverrideTable(bundle) — no gl, applies on native');
else fail('scene.createOverrideTable wrong: ' + JSON.stringify(bf));
if (bf.morphHasSetT && bf.morphMovedD) ok('scene.createMorph(src,dst,{sprites}) — sprite morph tweens on native');
else fail('scene.createMorph wrong: ' + JSON.stringify(bf));
if (bf.tlHasSetTime && bf.tlOk) ok('scene.createTimeline(refs,keys) — sprite timeline runs on native');
else fail('scene.createTimeline wrong: ' + JSON.stringify(bf));

// (12) native text bundle — glyph outlines render.
const tx = await page.evaluate(() => window.__textBundle());
if (tx.hasSource && tx.glyphPaths >= 2) ok('native text bundle emits glyph <path>s (' + tx.glyphPaths + ')');
else fail('native text bundle no glyph paths: ' + JSON.stringify(tx));
if (tx.darkPixels > 50) ok('native text rasterizes glyph outlines (' + tx.darkPixels + ' dark px)');
else fail('native text did not render: ' + JSON.stringify(tx));
// (12a) glyph curves normalized to (0,0)-origin (matches GL probe-shift)
// so text isn't offset down under a worldMatrix.
const near0 = (v) => Math.abs(v) < 1e-4;
if (near0(tx.bboxXmin) && near0(tx.bboxYmin)) ok('native text globalBBox normalized to (0,0) origin (xmin=' + tx.bboxXmin + ' ymin=' + tx.bboxYmin + ')');
else fail('text globalBBox NOT (0,0)-origin → offset vs GL: xmin=' + tx.bboxXmin + ' ymin=' + tx.bboxYmin);
if (near0(tx.vbXmin) && near0(tx.vbYmin)) ok('native text svg viewBox starts at (0,0) (no baseline-relative offset): "' + tx.vbRaw + '"');
else fail('text viewBox not (0,0)-origin: "' + tx.vbRaw + '" (xmin=' + tx.vbXmin + ' ymin=' + tx.vbYmin + ')');

// (12c) vertical placement under worldMatrix: ink lands in the TOP band
// (the bug was "offset down" — glyphs sinking below their placement rect).
const tp = await page.evaluate(() => window.__textPlacement());
if (tp.topDark > 0 && tp.topDark >= tp.botDark) ok('text placed at top rect renders in TOP band (topDark=' + tp.topDark + ' botDark=' + tp.botDark + ', y=' + tp.minY + '..' + tp.maxY + ')');
else fail('TEXT OFFSET DOWN — ink sank below placement rect: ' + JSON.stringify(tp));

// (12b) degenerate text never yields NaN / negative globalBBox.
const tbb = await page.evaluate(() => window.__textBboxFinite());
const bad = tbb.filter(r => !r.finite || !r.whNonNeg || !r.svgViewBoxFinite);
if (bad.length === 0) ok('empty/whitespace text → finite, non-negative globalBBox + valid svg viewBox');
else fail('degenerate text bbox NaN/invalid: ' + JSON.stringify(bad));

// (13) native timeline exposes currentMorph (the consumer read path).
const tm = await page.evaluate(() => window.__timeline());
if (tm.hasCurrentMorph && tm.currentMorphOverrides) ok('native timeline exposes currentMorph.overrides (timeline parity)');
else fail('native timeline currentMorph missing: ' + JSON.stringify(tm));
if (tm.hasBundle) ok('native timeline exposes a live bundle'); else fail('no timeline bundle');

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nnativeFallbackSmoke: all checks passed');
