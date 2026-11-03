// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeFallback — proof the no-WebGL fallback renders Mantle
// bundles via the browser's native SVG engine, and that per-shape
// overrides, animated clips (setClipper), and geometry MORPHS all drive
// the DOM correctly.
//
// Runs in a real browser (puppeteer) so DOMParser / createElementNS /
// the SVG rasterizer are all real — but it never creates a WebGL
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
//
// The other cases each pin one contract of the native scene in a real browser, on a fresh page of one shared Chrome (each
// case's own notes are above it): raster images (recolor, stretch, instancing), per-draw recolor chains, blend modes, the
// viewport coordinate space, <defs> id uniqueness, clip-def lifetime, stationary clips, mask -> shape indexing, text clip
// teardown, streaming, gradient / id-less / destination-only / group-opacity / transformed-group morphs, and full-sweep
// arcs. What the scene writes into its DOM without rasterizing is checked in the node lane (nativeSceneDomSmoke).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
import * as groupArt from './_nativeMorphGroupArt.mjs';
import { fontFixture, optionalAsset } from './_assets.mjs';
import { openPageSuite, tally } from './_pageSuite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const T = tally();

// Three solid shapes, each id'd so overrides can address them.
const ART = readFileSync(
  new URL('../examples/smoke/nativeFallback__ART.svg', import.meta.url),
  'utf8',
);

// Two matched-topology sprites in one sheet for the morph (same rect
// shape, different x + color), plus a non-sprite marker.
const SHEET = readFileSync(
  new URL('../examples/smoke/nativeFallback__SHEET.svg', import.meta.url),
  'utf8',
);

// A clipped shape: a wide rect clipped by a small square; moving the
// clip reveals different parts.
const CLIPART = readFileSync(
  new URL('../examples/smoke/nativeFallback__CLIPART.svg', import.meta.url),
  'utf8',
);

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

// Repeated template content with named SVG definitions. Both use an authored
// id so the test proves the fast path keeps the clone's namespaced id, rather
// than relying on document-global #sharedPaint / #tile lookup.
const BLUE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQ0TjxHwADXAIEAtgdbwAAAABJRU5ErkJggg==';
const TEMPLATE_GRADIENT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="sharedPaint"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect id="gradientRect" x="0" y="0" width="80" height="80" fill="url(#sharedPaint)"/></svg>';
const TEMPLATE_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><image id="tile" href="' + BLUE_PNG + '" x="0" y="0" width="80" height="80"/></svg>';
const templateGradient = await importSvg(TEMPLATE_GRADIENT, { retainSource: true });
const templateImage = await importSvg(TEMPLATE_IMAGE, { retainSource: true });

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
  // No global (and no ?mantleNative URL query) forces it: setting one is inert.
  globalThis.__MANTLE_FORCE_NATIVE = true; globalThis.__MANTLE_DEBUG__ = true;
  const glob    = chooseBackend(c, {}).backend;
  delete globalThis.__MANTLE_FORCE_NATIVE; delete globalThis.__MANTLE_DEBUG__;
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
  const firstImage = rscene.svg.querySelector('image');
  rscene.beginFrame([1,1,1,1]);
  rscene.drawImage(greenPx, { dstRect: [40, 40, 20, 20] });
  rscene.endFrame();
  await rast2();
  const at = (x,y) => { const p = rctx2.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return {
    inside: at(50,50), outside: at(10,10),
    hasImageEl: !!rscene.svg.querySelector('image'),
    reusedImage: firstImage === rscene.svg.querySelector('image'),
  };
};

// (8a1) a canvas raster, once its createImage token is ready, draws from a short blob: URL rather than a PNG data: URL, so a new
// <image> of it parses no long string; the frame's exportFrameSVG() carries the raster as a data: URL and the live <image> keeps its
// blob: URL; disposing the token revokes the URL, and a later draw falls back to a data: URL.
window.__canvasHref = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 32;
  canvas.getContext('2d').fillRect(0, 0, 64, 32);
  const token = rscene.createImage(canvas);
  await token.ready;
  rscene.beginFrame([1,1,1,1]);
  rscene.drawImage(token, { dstRect: [0, 0, 64, 32] });
  rscene.endFrame();
  const href = rscene.svg.querySelector('image').getAttribute('href');
  const exported = await rscene.exportFrameSVG();
  const exportedDataOnly = !exported.includes('blob:') && exported.includes('data:image/png;base64,');
  const liveKeepsBlob = rscene.svg.querySelector('image').getAttribute('href') === href;
  token.dispose();
  const revoked = await fetch(href).then(() => false, () => true);
  rscene.beginFrame([1,1,1,1]);
  rscene.drawImage(token, { dstRect: [0, 0, 64, 32] });
  rscene.endFrame();
  const after = rscene.svg.querySelector('image').getAttribute('href');
  return { blob: href.startsWith('blob:'), exportedDataOnly, liveKeepsBlob, revoked, afterDispose: after.slice(0, 22) };
};

// (8a2) compatible repeated vectors use one defs template and lightweight
// <use> slots; per-instance overrides deliberately retain the clone path.
const instHost = document.createElement('div'); document.body.appendChild(instHost);
const instScene = createNativeScene(instHost);
instScene.setViewport(300, 100);
const instMat = (tx) => new Float32Array([1,0,0, 0,1,0, tx,0,1]);
window.__nativeInstances = () => {
  instScene.beginFrame([1,1,1,1]);
  instScene.drawBundleInstanced(withSrc, [
    { worldMatrix: instMat(0) }, { worldMatrix: instMat(100) }, { worldMatrix: instMat(200) },
  ]);
  instScene.endFrame();
  const uses = instScene.svg.querySelectorAll('use').length;
  const templates = instScene.svg.querySelectorAll('defs > g[id^="mantleNativeInstance"]').length;
  const fallbackHost = document.createElement('div'); document.body.appendChild(fallbackHost);
  const fallback = createNativeScene(fallbackHost); fallback.setViewport(100, 100);
  const local = createNativeOverrideTable(withSrc); local.set('box', { visibility: 0.5 });
  fallback.beginFrame([1,1,1,1]);
  fallback.drawBundleInstanced(withSrc, [{ overrides: local }, { overrides: local }]);
  fallback.endFrame();
  return { uses, templates, fallbackUses: fallback.svg.querySelectorAll('use').length };
};

// Gradient and image definitions deliberately remain on the clone path. The
// source ids are deliberately generic so this also proves clone namespacing
// remains correct when templates reject definition-bearing content.
const defHost = document.createElement('div'); document.body.appendChild(defHost);
const defScene = createNativeScene(defHost, { coordinateSpace: 'viewport' });
defScene.setViewport(400, 100);
const fallbackUses = (bundle, draw) => {
  const h = document.createElement('div'); document.body.appendChild(h);
  const s = createNativeScene(h); s.setViewport(100, 100);
  s.beginFrame();
  draw(s, bundle);
  s.endFrame();
  return s.svg.querySelectorAll('use').length;
};
window.__nativeDefinitionInstances = async () => {
  defScene.beginFrame([1,1,1,1]);
  defScene.drawBundleInstanced(templateGradient, [
    { worldMatrix: instMat(0) }, { worldMatrix: instMat(100) },
  ]);
  defScene.drawBundleInstanced(templateImage, [
    { worldMatrix: instMat(200) }, { worldMatrix: instMat(300) },
  ]);
  defScene.endFrame();
  const gradient = defScene.svg.querySelector('defs linearGradient[data-oid="sharedPaint"]');
  const gradientRect = defScene.svg.querySelector('defs [data-oid="gradientRect"]');
  const image = defScene.svg.querySelector('defs image[data-oid="tile"]');
  const cv = document.createElement('canvas'); cv.width = 400; cv.height = 100;
  const ctx = cv.getContext('2d');
  await rasterize(defScene.svg, 400, 100, ctx);
  const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  const filterBundle = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><filter id="blur"><feGaussianBlur stdDeviation="1"/></filter></defs><rect x="0" y="0" width="80" height="80" fill="#f00" filter="url(#blur)"/></svg>', { retainSource: true });
  const clipBundle = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><clipPath id="crop"><rect x="0" y="0" width="40" height="80"/></clipPath></defs><rect x="0" y="0" width="80" height="80" fill="#f00" clip-path="url(#crop)"/></svg>', { retainSource: true });
  const maskBundle = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><mask id="fade"><rect x="0" y="0" width="80" height="80" fill="#fff"/></mask></defs><rect x="0" y="0" width="80" height="80" fill="#f00" mask="url(#fade)"/></svg>', { retainSource: true });
  const spriteBundle = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><g id="only"><rect x="0" y="0" width="80" height="80" fill="#f00"/></g></svg>', { retainSource: true });
  const textBundle = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><text x="4" y="40">x</text></svg>', { retainSource: true });
  const streamBundle = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#0f0"/></svg>', { retainSource: true }); streamBundle.__streamGen = 1;
  const ovr = createNativeOverrideTable(withSrc); ovr.set('box', { visibility: 0.5 });
  return {
    uses: defScene.svg.querySelectorAll('use').length,
    templates: defScene.svg.querySelectorAll('defs > g[id^="mantleNativeInstance"]').length,
    namespacedGradient: !!gradient && gradient.id !== 'sharedPaint'
      && !!gradientRect && gradientRect.getAttribute('fill') === 'url(#' + gradient.id + ')',
    namespacedImage: !!image && image.id !== 'tile',
    gradientPainted: pixel(20, 50)[0] > 120 && pixel(20, 50)[3] > 200,
    imagePainted: pixel(220, 50)[2] > 120 && pixel(220, 50)[3] > 200,
    cloneFallbacks: {
      override: fallbackUses(withSrc, (s, b) => s.drawBundleInstanced(b, [{ overrides: ovr }, { overrides: ovr }])),
      sprite: fallbackUses(spriteBundle, (s, b) => s.drawSpriteInstanced(b, 'only', [{}, {}])),
      clip: fallbackUses(clipBundle, (s, b) => s.drawBundleInstanced(b, [{}, {}])),
      mask: fallbackUses(maskBundle, (s, b) => s.drawBundleInstanced(b, [{}, {}])),
      filter: fallbackUses(filterBundle, (s, b) => s.drawBundleInstanced(b, [{}, {}])),
      text: fallbackUses(textBundle, (s, b) => s.drawBundleInstanced(b, [{}, {}])),
      stream: fallbackUses(streamBundle, (s, b) => s.drawBundleInstanced(b, [{}, {}])),
      blend: fallbackUses(withSrc, (s, b) => s.drawBundleInstanced(b, [{ blendMode: 1 }, { blendMode: 1 }])),
    },
  };
};

// (8b) a bundle whose <image> uses a data: URI renders verbatim (a 1x1
// blue PNG scaled to fill).
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
  const need = ['drawSprite','drawSpriteInstanced','drawBundleInstanced','drawImageInstanced','drawInstance','createImage','createBundleHandle','setScissorRect','clearScissorRect','enableStaticCache','disableStaticCache','invalidateRenderState','setBundle','render','drawBundle','submitBundle','drawImage','setViewport','beginFrame','endFrame'];
  return need.filter(m => typeof spScene[m] !== 'function');
};
const zRed = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"/></svg>', { retainSource: true });
const zBlue = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0000ff"/></svg>', { retainSource: true });
const zHost = document.createElement('div'); document.body.appendChild(zHost);
const zScene = createNativeScene(zHost); zScene.setViewport(100, 100);
window.__nativeSubmitOrder = () => {
  zScene.beginFrame([1,1,1,1]);
  zScene.submitBundle(zBlue, { zOrder: 10 });
  zScene.submitBundle(zRed, { zOrder: 0 });
  zScene.endFrame();
  const groups = zScene.svg.querySelectorAll(':scope > g');
  const last = groups[groups.length - 1];
  return last && last.querySelector('rect') && last.querySelector('rect').getAttribute('fill');
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
  ovr.set(sheetStroked.shapeIds[2], { fill: [1, 0, 1, 1] });   // magenta → right rect
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

async function nativeFallback(suite) {
  const { ok, fail } = T;
  // The text case's font: served as it was found, and a 404 (which the page reports) where the machine has none.
  try {
    suite.route('/__font', 'font/ttf', readFileSync(FONT_PATH));
  } catch {
    /* absent */
  }
  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/Mantle\]|err/i.test(t)) console.log('  [page]', t);
  });
  try {
    // The page never paints (the DOM-only native fallback, no canvas, nothing driving frames), so the readiness wait must
    // poll on an interval, which openReady does, rather than on requestAnimationFrame.
    await suite.goto(page, HTML, { ready: () => window.__ready === true });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  // (1) retention opt-in.
  const retain = await page.evaluate(() => window.__retain);
  if (retain.withSrc) ok('retainSource:true attaches svgSource');
  else fail('svgSource not attached with retainSource');
  if (!retain.noSrc) ok('default import does NOT retain source (regular consumers pay nothing)');
  else fail('svgSource leaked into default import');

  // (2) single <svg>, one <g>, rasterizes.
  const info = await page.evaluate(() => window.__svgInfo());
  if (info.groups === 1) ok('one <g> per drawBundle (single-<svg> composition)');
  else fail('expected 1 <g>, got ' + info.groups);
  if (info.hasBox && info.hasDot) ok('source shapes present in the <svg> by id');
  else fail('source shapes missing: ' + JSON.stringify(info));
  const boxPx = await page.evaluate(() => window.__sample100(25, 25)); // inside the red box
  if (boxPx[0] > 180 && boxPx[1] < 100)
    ok('native <svg> rasterizes: red box pixel = ' + JSON.stringify(boxPx));
  else fail('box did not rasterize red: ' + JSON.stringify(boxPx));

  // (3) overrides by id.
  const ov = await page.evaluate(() => window.__drawOverride());
  if (/255,255,0|rgba\(255,255,0/.test(ov.boxFill || '')) ok('override recolored #box to yellow');
  else fail('box fill override wrong: ' + ov.boxFill);
  if (ov.barHidden) ok('override hid #bar (visibility 0)');
  else fail('bar not hidden');
  if (ov.dotXform && /translate\(-40/.test(ov.dotXform))
    ok('override translated #dot: ' + ov.dotXform);
  else fail('dot transform wrong: ' + ov.dotXform);

  // (4) clipper.
  if (await page.evaluate(() => window.__hasClipRange)) ok('clipperRows has the clip range');
  else fail('no clipperRows.win');
  const clipX0 = await page.evaluate(() => window.__drawClip(0));
  const clipX30 = await page.evaluate(() => window.__drawClip(30));
  if (clipX30 && /translate\(30/.test(clipX30))
    ok('setClipper transforms the live clip element: ' + clipX30);
  else fail('clipper transform not applied: ' + clipX30);

  // (5) curveRangeToPathD round-trip.
  const pd = await page.evaluate(() => window.__pathD());
  if (pd.d && pd.closed && pd.moves >= 1)
    ok('curveRangeToPathD decoded the rect: ' + JSON.stringify(pd.d).slice(0, 80));
  else fail('pathD decode wrong: ' + JSON.stringify(pd));

  // (6) morph rewrites geometry.
  const mi = await page.evaluate(() => window.__morphInfo);
  if (mi.matched >= 1) ok("morph matched the two poses' rects (" + mi.matched + ')');
  else fail('morph matched nothing: ' + JSON.stringify(mi));
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
  if (cx0 < 100 && cx1 > 200) ok(`morph slides A→B (centroid x: t0=${cx0 | 0} t1=${cx1 | 0})`);
  else fail(`morph endpoints wrong (t0=${cx0 | 0} t1=${cx1 | 0})`);
  if (cx5 > cx0 + 30 && cx5 < cx1 - 30)
    ok(`morph t=0.5 rasterizes between (centroid x=${cx5 | 0})`);
  else fail(`morph midpoint not between (t0=${cx0 | 0} t0.5=${cx5 | 0} t1=${cx1 | 0})`);

  // (7) forcing the fallback for testing.
  const fb = await page.evaluate(() => window.__force());
  if (fb.auto === 'webgl') ok('chooseBackend auto-picks webgl when available');
  else fail('expected auto=webgl (WebGL should be available in test), got ' + fb.auto);
  if (fb.opt === 'native' && fb.hard === 'native')
    ok('force options select native (forceNative / backend:native)');
  else fail('force options did not select native: ' + JSON.stringify(fb));
  if (fb.glob === 'webgl') ok('the removed __MANTLE_FORCE_NATIVE global is inert, debug on or off');
  else fail('__MANTLE_FORCE_NATIVE still forces native: ' + JSON.stringify(fb));
  if (fb.sceneBackend === 'native' && fb.drewSvg)
    ok('createMantleScene(forceNative) builds a usable native scene');
  else fail('forced factory not native: ' + JSON.stringify(fb));

  // (8) raster compositing.
  const rb = await page.evaluate(() => window.__drawRaster());
  if (rb.hasImageEl) ok('scene.drawImage appended an <image> element');
  else fail('no <image> from drawImage');
  if (rb.reusedImage) ok('native drawImage reuses its persistent image slot');
  else fail('native drawImage replaced its image slot');
  if (rb.inside[1] > 150 && rb.inside[0] < 120)
    ok(`drawImage raster composited green at dstRect (px=${JSON.stringify(rb.inside)})`);
  else fail('raster not green inside dstRect: ' + JSON.stringify(rb.inside));
  // "outside" is empty if transparent (alpha 0) or white (clear). Either is
  // fine — what matters is it's NOT the green raster.
  const outIsGreen = rb.outside[3] > 10 && rb.outside[1] > 150 && rb.outside[0] < 120;
  if (!outIsGreen) ok('drawImage raster confined to dstRect (not green outside)');
  else fail('raster bled outside dstRect: ' + JSON.stringify(rb.outside));
  const ch = await page.evaluate(() => window.__canvasHref());
  if (ch.blob) ok('a ready canvas raster draws from a blob: URL');
  else fail('a ready canvas raster did not draw from a blob: URL: ' + JSON.stringify(ch));
  if (ch.exportedDataOnly && ch.liveKeepsBlob)
    ok("a ready canvas raster's exported frame carries it as a data: URL, and its live <image> keeps the blob: URL");
  else fail('the exported frame of a ready canvas raster: ' + JSON.stringify(ch));
  if (ch.revoked) ok('disposing the canvas token revokes its blob: URL');
  else fail('the blob: URL still loads after dispose: ' + JSON.stringify(ch));
  if (ch.afterDispose === 'data:image/png;base64,')
    ok('a draw after dispose falls back to a data: URL');
  else fail('a draw after dispose used ' + JSON.stringify(ch.afterDispose));

  const ni = await page.evaluate(() => window.__nativeInstances());
  if (ni.uses === 3 && ni.templates === 1) ok('compatible native instances share one SVG template');
  else fail('native instance template structure wrong: ' + JSON.stringify(ni));
  if (ni.fallbackUses === 0) ok('per-instance overrides retain clone parity path');
  else fail('override instance unexpectedly used shared template: ' + JSON.stringify(ni));

  const di = await page.evaluate(() => window.__nativeDefinitionInstances());
  if (di.uses === 0 && di.templates === 0)
    ok('definition-bearing native instances retain namespaced clone fallback');
  else fail('native definition fallback structure wrong: ' + JSON.stringify(di));
  if (di.gradientPainted && di.imagePainted) ok('definition-bearing clone fallbacks rasterize');
  else fail('instanced definitions did not rasterize: ' + JSON.stringify(di));
  if (Object.values(di.cloneFallbacks).every((n) => n === 0))
    ok('overrides, sprites, clips/masks, and filters retain clone fallback');
  else
    fail(
      'effectful native instances unexpectedly used shared templates: ' +
        JSON.stringify(di.cloneFallbacks),
    );

  const ib = await page.evaluate(() => window.__drawImgBundle());
  if (ib.hasImg) ok('bundle <image data:> re-hosted as <image>');
  else fail('bundle image element missing');
  if (ib.center[2] > 150 && ib.center[0] < 120)
    ok(`bundle data: <image> rasterizes (blue center px=${JSON.stringify(ib.center)})`);
  else fail('bundle data: image did not render blue: ' + JSON.stringify(ib.center));

  // (9) renderer-parity (drop-in surface) on the native backend.
  const missing = await page.evaluate(() => window.__surface());
  if (missing.length === 0) ok('native scene exposes the full renderer method surface (drop-in)');
  else fail('native scene MISSING renderer methods: ' + missing.join(', '));
  const nativeZTop = await page.evaluate(() => window.__nativeSubmitOrder());
  if (nativeZTop === '#0000ff') ok('native submitBundle sorts lower z underneath');
  else fail('native submitBundle z-order wrong: ' + nativeZTop);
  const spL = await page.evaluate(() => window.__drawSpriteNative('left'));
  if (spL.leftPainted && !spL.rightPainted)
    ok('native drawSprite renders REAL subset geometry (left sprite only)');
  else fail('native drawSprite subset wrong: ' + JSON.stringify(spL));
  const spR = await page.evaluate(() => window.__drawSpriteNative('right'));
  if (spR.rightPainted && !spR.leftPainted) ok('native drawSprite isolates the right sprite too');
  else fail('native drawSprite right subset wrong: ' + JSON.stringify(spR));

  // (9b) ID-LESS sprite sheet — the subset hide must be positional.
  const spIdless = await page.evaluate(() => window.__drawSpriteIdless('left'));
  const innerSynthetic = (spIdless.innerIds || []).every((id) =>
    /^shape_(?:L)?\d+_(fill|stroke)$/.test(id),
  );
  if (innerSynthetic)
    ok(
      'id-less sheet: inner shapes have synthetic ids (' + JSON.stringify(spIdless.innerIds) + ')',
    );
  else fail('id-less sheet fixture has authored inner ids: ' + JSON.stringify(spIdless.innerIds));
  if (spIdless.leftPainted && !spIdless.rightPainted)
    ok(
      'native drawSprite subsets an ID-LESS sheet (positional hide — left only, sheet not fully drawn)',
    );
  else
    fail(
      'ID-LESS drawSprite drew the whole sheet (positional hide broken): ' +
        JSON.stringify(spIdless),
    );

  // (9c) STROKED sheet — meta rows (2/shape) outnumber DOM elements; the
  // subset must isolate by sprite id, not by positional row index.
  const spStroked = await page.evaluate(() => window.__drawSpriteStroked('left'));
  if (JSON.stringify(spStroked.domIndex) === '[0,0,1,1]')
    ok(
      'stroked sheet exports shapeDomIndex (2 rows/element): ' + JSON.stringify(spStroked.domIndex),
    );
  else fail('shapeDomIndex wrong for stroked sheet: ' + JSON.stringify(spStroked.domIndex));
  if (spStroked.leftPainted && !spStroked.rightPainted)
    ok('native drawSprite subsets a STROKED sheet (id isolation — meta-row drift immune)');
  else
    fail(
      'STROKED drawSprite subset wrong (ranges ' +
        JSON.stringify(spStroked.ranges) +
        '): ' +
        JSON.stringify(spStroked),
    );
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
  if (wp.skipped) {
    ok('(webgl passthrough skipped — no WebGL2 in this run)');
  } else if (wp.backend === 'webgl' && wp.missing.length === 0 && wp.hasToScene)
    ok(
      'createMantleScene(webgl) returns the real renderer — all GL-only methods present (drop-in)',
    );
  else fail('webgl passthrough incomplete: ' + JSON.stringify(wp));

  // (11) backend-agnostic binding factories (the overrides/timeline drop-in).
  const bf = await page.evaluate(() => window.__bindingFactories());
  if (bf.ovHasSet && bf.ovApplied)
    ok('scene.createOverrideTable(bundle) — no gl, applies on native');
  else fail('scene.createOverrideTable wrong: ' + JSON.stringify(bf));
  if (bf.morphHasSetT && bf.morphMovedD)
    ok('scene.createMorph(src,dst,{sprites}) — sprite morph tweens on native');
  else fail('scene.createMorph wrong: ' + JSON.stringify(bf));
  if (bf.tlHasSetTime && bf.tlOk)
    ok('scene.createTimeline(refs,keys) — sprite timeline runs on native');
  else fail('scene.createTimeline wrong: ' + JSON.stringify(bf));

  // (12) native text bundle — glyph outlines render.
  const tx = await page.evaluate(() => window.__textBundle());
  if (tx.hasSource && tx.glyphPaths >= 2)
    ok('native text bundle emits glyph <path>s (' + tx.glyphPaths + ')');
  else fail('native text bundle no glyph paths: ' + JSON.stringify(tx));
  if (tx.darkPixels > 50)
    ok('native text rasterizes glyph outlines (' + tx.darkPixels + ' dark px)');
  else fail('native text did not render: ' + JSON.stringify(tx));
  // (12a) glyph curves normalized to (0,0)-origin (matches GL probe-shift)
  // so text isn't offset down under a worldMatrix.
  const near0 = (v) => Math.abs(v) < 1e-4;
  if (near0(tx.bboxXmin) && near0(tx.bboxYmin))
    ok(
      'native text globalBBox normalized to (0,0) origin (xmin=' +
        tx.bboxXmin +
        ' ymin=' +
        tx.bboxYmin +
        ')',
    );
  else
    fail(
      'text globalBBox NOT (0,0)-origin → offset vs GL: xmin=' +
        tx.bboxXmin +
        ' ymin=' +
        tx.bboxYmin,
    );
  if (near0(tx.vbXmin) && near0(tx.vbYmin))
    ok('native text svg viewBox starts at (0,0) (no baseline-relative offset): "' + tx.vbRaw + '"');
  else
    fail(
      'text viewBox not (0,0)-origin: "' +
        tx.vbRaw +
        '" (xmin=' +
        tx.vbXmin +
        ' ymin=' +
        tx.vbYmin +
        ')',
    );

  // (12c) vertical placement under worldMatrix: ink lands in the TOP band
  // (not "offset down" — glyphs sinking below their placement rect).
  const tp = await page.evaluate(() => window.__textPlacement());
  if (tp.topDark > 0 && tp.topDark >= tp.botDark)
    ok(
      'text placed at top rect renders in TOP band (topDark=' +
        tp.topDark +
        ' botDark=' +
        tp.botDark +
        ', y=' +
        tp.minY +
        '..' +
        tp.maxY +
        ')',
    );
  else fail('TEXT OFFSET DOWN — ink sank below placement rect: ' + JSON.stringify(tp));

  // (12b) degenerate text never yields NaN / negative globalBBox.
  const tbb = await page.evaluate(() => window.__textBboxFinite());
  const bad = tbb.filter((r) => !r.finite || !r.whNonNeg || !r.svgViewBoxFinite);
  if (bad.length === 0)
    ok('empty/whitespace text → finite, non-negative globalBBox + valid svg viewBox');
  else fail('degenerate text bbox NaN/invalid: ' + JSON.stringify(bad));

  // (13) native timeline exposes currentMorph (the consumer read path).
  const tm = await page.evaluate(() => window.__timeline());
  if (tm.hasCurrentMorph && tm.currentMorphOverrides)
    ok('native timeline exposes currentMorph.overrides (timeline parity)');
  else fail('native timeline currentMorph missing: ' + JSON.stringify(tm));
  if (tm.hasBundle) ok('native timeline exposes a live bundle');
  else fail('no timeline bundle');

  // Primitive replacement preserves overrides written by an earlier metadata row.
  // A fill+stroke leaf with opacity below 1 is one composited group (group begin, fill, stroke and group end rows), so the opacity
  // override lands on the group row while the fill row is converted; a fill-only leaf has one row and both writes address it.
  const conversion = await page.evaluate(async () => {
    const { importSvg, createNativeScene, createNativeOverrideTable } =
      await import('/src/index.js');
    const results = [];
    for (const both of [true, false])
      for (const named of [false, true]) {
        const b = await importSvg(
          '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect ' +
            (named ? 'id="leaf" ' : '') +
            'x="8" y="8" width="48" height="48" fill="red"' +
            (both ? ' stroke="blue" stroke-width="4"' : '') +
            ' opacity="0.5"/></svg>',
          { retainSource: true, preserveViewport: true },
        );
        const rows = both ? 4 : 1,
          groupRow = 0,
          fillRow = both ? 1 : 0;
        if (b.numShapes !== rows)
          throw Error(
            'expected ' +
              (both ? 'group begin, fill, stroke and group end rows' : 'one row') +
              ', got ' +
              b.numShapes,
          );
        const scene = createNativeScene(document.createElement('div'), {
          coordinateSpace: 'bundle',
        });
        scene.setViewport(64, 64);
        const table = createNativeOverrideTable(b);
        table.update(groupRow, { groupOpacity: 0.75 });
        table.update(fillRow, { pathD: 'M8 8L56 8L56 56L8 56Z' });
        const draw = async () => {
          scene.beginFrame([0, 0, 0, 0]);
          scene.drawBundle(b, { overrides: table });
          scene.endFrame();
          const image = new Image();
          image.src =
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent(new XMLSerializer().serializeToString(scene.svg));
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 64;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(32, 32, 1, 1).data);
        };
        const first = await draw(),
          cached = await draw();
        table.clear(groupRow);
        const restored = await draw();
        table.update(groupRow, { groupOpacity: 0.25 });
        const changed = await draw();
        results.push({ both, named, rows: b.numShapes, first, cached, restored, changed });
        table.dispose();
        scene.dispose();
      }
    return results;
  });
  for (const item of conversion) {
    const label =
      (item.both ? 'fill+stroke group' : 'fill-only') + ', ' + (item.named ? 'named' : 'unnamed');
    if (
      Math.abs(item.first[3] - 191) <= 1 &&
      item.first.join() === item.cached.join() &&
      Math.abs(item.restored[3] - 128) <= 1 &&
      Math.abs(item.changed[3] - 64) <= 1
    )
      ok(
        'primitive replacement preserves first/cached opacity and authored restoration (' +
          label +
          ')',
      );
    else
      fail(
        'primitive replacement loses current-frame ownership (' +
          label +
          '): ' +
          JSON.stringify(item),
      );
  }
  await page.close();
}

// nativeImageRecolor — the native (no-WebGL) raster drawImage must
// honor a PER-DRAW colorMatrix / colorMatrixOffset, matching the WebGL path
// (src/shaders/drawImage.frag.glsl, covered by test/drawImageSmoke.mjs).
//
// Both backends apply `out = colorMatrix * in + colorMatrixOffset` to STRAIGHT
// color before the tint multiply; natively that is an feColorMatrix chained
// ahead of the tint's. Two blits of the same source with different offsets
// must differ — a per-ASSET tint cannot express that.
async function nativeImageRecolor(suite) {
  const { ok, fail } = T;
  // Solid red source — every recolor below is checked against pure red in.
  const SRC =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">' +
        '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>',
    );

  const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { createNativeScene } from '/src/index.js';
const SRC = ${JSON.stringify(SRC)};
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const ctx = document.getElementById('cv').getContext('2d');

// Draw N blits in one frame and sample the center of each dstRect.
window.__draw = async (calls) => {
  scene.beginFrame([0,0,0,1]);
  for (const c of calls) scene.drawImage(SRC, c);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  return calls.map(c => {
    const [x,y,w,h] = c.dstRect;
    const p = ctx.getImageData(x + w/2 | 0, y + h/2 | 0, 1, 1).data;
    return [p[0],p[1],p[2],p[3]];
  });
};
window.__ready = true;
</script></body></html>`;

  const near = (a, b, t = 20) => Math.abs(a - b) <= t;
  const rgbNear = (c, r, g, b, t = 20) => near(c[0], r, t) && near(c[1], g, t) && near(c[2], b, t);

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  // 1) Two blits of ONE source with different offsets recolor independently:
  //    red +G → yellow, red +B → magenta, and a third plain blit stays red
  //    (the filter is per-draw and must not leak).
  {
    const s = await page.evaluate(() =>
      window.__draw([
        { dstRect: [0, 0, 50, 50], colorMatrixOffset: [0, 1, 0, 0] },
        { dstRect: [50, 0, 50, 50], colorMatrixOffset: [0, 0, 1, 0] },
        { dstRect: [0, 50, 50, 50] },
      ]),
    );
    if (rgbNear(s[0], 255, 255, 0)) ok('colorMatrixOffset +G: red → yellow');
    else fail('offset +G: ' + s[0]);
    if (rgbNear(s[1], 255, 0, 255)) ok('colorMatrixOffset +B: red → magenta');
    else fail('offset +B: ' + s[1]);
    if (!rgbNear(s[0], s[1][0], s[1][1], s[1][2]))
      ok('two blits of one source recolor independently');
    else fail('offsets produced identical pixels: ' + s[0]);
    if (rgbNear(s[2], 255, 0, 0)) ok('recolor does not leak to the next drawImage');
    else fail('leaked recolor: ' + s[2]);
  }

  // 2) A column-major mat4 that swaps R↔B — the GL→SVG row/column transpose
  //    is the easy thing to get wrong, so assert the actual channel landing.
  {
    const swapRB = [
      0,
      0,
      1,
      0, // in.r → out.b
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      0, // in.b → out.r
      0,
      0,
      0,
      1,
    ];
    const s = await page.evaluate(
      (m) => window.__draw([{ dstRect: [0, 0, 50, 50], colorMatrix: m }]),
      swapRB,
    );
    if (rgbNear(s[0], 0, 0, 255)) ok('colorMatrix R↔B: red → blue');
    else fail('swap: ' + s[0]);
  }

  // 3) colorMatrix and tint compose in shader order (recolor, then tint):
  //    red --(+G offset)--> yellow --(tint green)--> green.
  {
    const s = await page.evaluate(() =>
      window.__draw([
        { dstRect: [0, 0, 50, 50], colorMatrixOffset: [0, 1, 0, 0], tint: [0, 1, 0, 1] },
      ]),
    );
    if (rgbNear(s[0], 0, 255, 0)) ok('colorMatrix then tint compose in shader order');
    else fail('compose: ' + s[0]);
  }

  await page.close();
}

// nativeImageStretch — native (no-WebGL) raster drawImage must stretch
// the bitmap to fill dstRect (matching WebGL drawImage), not letterbox it.
//
// The native <image> sets preserveAspectRatio="none" by default (honoring
// drawOpts.par when given); otherwise it defaults to "xMidYMid meet" and a
// non-source-aspect dstRect shows a source-aspect box with margins. This draws
// a 2:1 source into a 1:1 box and asserts the whole box fills (no top/bottom
// letterbox margins), and that an explicit 'meet' par does letterbox (the opt
// is honored).
async function nativeImageStretch(suite) {
  const { ok, fail } = T;
  // 2:1 (wide) red source. In a 100×100 dst: stretch → fills; meet → 100×50
  // band centerd at y25..75 with bg margins top/bottom.
  const SRC =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10">' +
        '<rect x="0" y="0" width="20" height="10" fill="#ff0000"/></svg>',
    );

  const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { createNativeScene } from '/src/index.js';
const SRC = ${JSON.stringify(SRC)};
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const ctx = document.getElementById('cv').getContext('2d');

window.__draw = async (opts) => {
  scene.beginFrame([0,0,0,1]);
  scene.drawImage(SRC, Object.assign({ dstRect: [0,0,100,100] }, opts));
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { top: at(50,8), mid: at(50,50), bot: at(50,92) };
};
window.__ready = true;
</script></body></html>`;

  const isRed = (px) => px[0] > 150 && px[1] < 90 && px[2] < 90;
  const isBg = (px) => px[0] < 60 && px[1] < 60 && px[2] < 60;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  // Default: STRETCH — red fills top, middle AND bottom (no letterbox margins).
  const def = await page.evaluate(() => window.__draw({}));
  if (isRed(def.top) && isRed(def.mid) && isRed(def.bot))
    ok('default drawImage STRETCHES to fill dstRect (top/mid/bot all red): ' + JSON.stringify(def));
  else fail('default not stretched — letterbox margins present: ' + JSON.stringify(def));

  // Explicit 'meet' par ([1,1,0] = xMidYMid meet) IS honored → letterbox: a 2:1
  // source in a 1:1 box fills the middle band only, margins (top/bottom) are bg.
  const meet = await page.evaluate(() => window.__draw({ par: [1, 1, 0] }));
  if (isRed(meet.mid) && isBg(meet.top) && isBg(meet.bot))
    ok(
      "explicit par 'meet' is honored → letterboxed (mid red, margins bg): " + JSON.stringify(meet),
    );
  else fail("explicit par 'meet' not honored: " + JSON.stringify(meet));

  await page.close();
}

// nativeImageInstanced — drawImageInstanced on the native backend must
// draw N copies of the same raster source. A DOM <image> node can have only one
// parent, so same-href instances need per-slot image elements, not one shared
// href-keyed node.
async function nativeImageInstanced(suite) {
  const { ok, fail } = T;
  const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="120" height="40"></canvas>
<script type="module">
import { createNativeScene } from '/src/index.js';
const scene = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
scene.setViewport(120, 40);
const px = { width: 1, height: 1, rgba: new Uint8Array([0, 220, 0, 255]) };
const ctx = document.getElementById('c').getContext('2d');
window.__render = async () => {
  scene.beginFrame([0,0,0,1]);
  const n = scene.drawImageInstanced(px, [
    { dstRect: [10, 10, 20, 20] },
    { dstRect: [50, 10, 20, 20] },
    { dstRect: [90, 10, 20, 20] },
  ]);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,120,40); ctx.drawImage(img, 0, 0, 120, 40);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return {
    n,
    imageEls: scene.svg.querySelectorAll('image').length,
    a: at(20,20), b: at(60,20), c: at(100,20), gap: at(40,20),
  };
};
window.__ready = true;
</script></body></html>`;

  const isGreen = (p) => p[1] > 150 && p[0] < 80 && p[2] < 80 && p[3] > 120;
  const isBg = (p) => p[0] < 40 && p[1] < 40 && p[2] < 40;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const r = await page.evaluate(() => window.__render());
  if (r.n === 3) ok('drawImageInstanced returned 3');
  else fail('instance count: ' + r.n);
  if (r.imageEls === 3) ok('same source produced 3 live <image> nodes');
  else fail('expected 3 image nodes, got ' + r.imageEls);
  if (isGreen(r.a) && isGreen(r.b) && isGreen(r.c))
    ok('all three same-source raster instances rendered');
  else fail('missing same-source instance(s): ' + r.a + ' / ' + r.b + ' / ' + r.c);
  if (isBg(r.gap)) ok('gap between instances stays clear');
  else fail('unexpected fill in gap: ' + r.gap);

  await page.close();
}

// nativeRecolor — the native (no-WebGL) fallback's per-draw
// recolor parity with the GL fill shader (mantle.frag.glsl). The native
// path applies the same color algebra to each shape's resolved fill color
// (not via a filter) — for solid-fill artwork the per-shape result equals
// the GL per-pixel result.
//
// Cases:
//   dualTint(primary=red, contrast=blue) on a red+blue SVG → identity
//     (red shape's R selects red primary, blue shape's B selects blue).
//   dualTint(primary=green, contrast=magenta) → red rect→green, blue→magenta.
//   monochrome(yellow) → both rects map to a yellow-weighted luminance.
//   channelLerp(primary=green) → red rect→green, a white shape→highlight.
//   revert: a non-recolor draw after a recolor draw is passthrough again.
async function nativeRecolor(suite) {
  const { ok, fail } = T;
  // Two side-by-side rects (left red, right blue). Deliberately no id
  // attributes — real artwork is often id-less, so the recolor must address
  // shapes positionally, not by shapeId. An id-keyed recolor pass would no-op
  // on id-less art.
  const SVG =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="50" height="100" fill="#FF0000"/>' +
    '<rect x="50" y="0" width="50" height="100" fill="#0000FF"/></svg>';

  const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeOverrideTable,
  colorMatrixDualTint, colorMatrixMonochrome, channelLerpParams } from '/src/index.js';

const bundle = await importSvg(${JSON.stringify(SVG)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'));
scene.setViewport(100, 100);
const ctx = document.getElementById('c').getContext('2d');

async function drawAndSample(opts) {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(bundle, opts || {});
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { left: at(25,50), right: at(75,50) };
}

window.__plain = () => drawAndSample({});
window.__dualIdentity = () => { const {matrix,offset} = colorMatrixDualTint([1,0,0,1],[0,0,1,1]); return drawAndSample({ colorMatrix: matrix, colorMatrixOffset: offset }); };
window.__dualSwap = () => { const {matrix,offset} = colorMatrixDualTint([0,1,0,1],[1,0,1,1]); return drawAndSample({ colorMatrix: matrix, colorMatrixOffset: offset }); };
window.__mono = () => { const {matrix,offset} = colorMatrixMonochrome([1,1,0,1]); return drawAndSample({ colorMatrix: matrix, colorMatrixOffset: offset }); };
window.__channelLerp = () => drawAndSample({ channelLerp: channelLerpParams([0,1,0,1],[0,0,1,1],[1,1,1,1]) });
// Palette LUT keyed on the RED channel: index 0 = black, index 1 = white.
// Red rect (R=1) → floor(1*2)=1 (clamped) → white; blue rect (R=0) → 0 → black.
window.__palette = () => drawAndSample({
  palette: { __nativePalette: true, entries: [[0,0,0,255],[255,255,255,255]] },
  paletteChannel: 'r',
});
window.__revertAfterRecolor = async () => {
  await drawAndSample({ colorMatrix: colorMatrixDualTint([0,1,0,1],[1,0,1,1]).matrix, colorMatrixOffset: [0,0,0,0] });
  return drawAndSample({});   // no recolor → back to authored red/blue
};

// ── Per-shape override tint RGB ───────────────────────────────────────────
// White-authored art tinted via the override table's tint (multiplicative
// RGBA, like the GL shader's vFill *= tint); a cyan tint must color a white
// bar, not leave it white. The bundle has an id so the override addresses it;
// a second white shape stays untinted to prove it's per-shape.
const WHITE = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">'
  + '<rect id="bar" x="0" y="0" width="50" height="100" fill="#FFFFFF"/>'
  + '<rect x="50" y="0" width="50" height="100" fill="#FFFFFF"/></svg>';
const whiteBundle = await importSvg(WHITE, { retainSource: true });
async function drawWhite(setup) {
  const ov = createNativeOverrideTable(whiteBundle);
  setup(ov);
  scene.beginFrame([0.5,0.5,0.5,1]);        // gray bg so a translucent tint shows
  scene.drawBundle(whiteBundle, { overrides: ov });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { tinted: at(25,50), untinted: at(75,50) };
}
// Cyan tint (#39BCE4, full alpha) on a white bar → cyan.
window.__tintCyan = () => drawWhite(ov => ov.set('bar', { tint: [0.224, 0.737, 0.894, 1] }));
// Translucent-black tint [0,0,0,0.502] on white over gray → darkened (≈ mid-gray).
window.__tintDarken = () => drawWhite(ov => ov.set('bar', { tint: [0, 0, 0, 0.502] }));
// Per-draw: drop the tint next frame → bar reverts to white.
window.__tintRevert = async () => {
  await drawWhite(ov => ov.set('bar', { tint: [0.224, 0.737, 0.894, 1] }));
  return drawWhite(() => {});   // empty override → authored white again
};
window.__ready = true;
</script></body></html>`;

  const near = (px, r, g, b, tol = 24) =>
    Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const plain = await page.evaluate(() => window.__plain());
  if (near(plain.left, 255, 0, 0) && near(plain.right, 0, 0, 255))
    ok('baseline: left red, right blue');
  else fail('baseline wrong: ' + JSON.stringify(plain));

  const di = await page.evaluate(() => window.__dualIdentity());
  if (near(di.left, 255, 0, 0) && near(di.right, 0, 0, 255))
    ok('dualTint(red,blue) is identity for red+blue art');
  else fail('dualTint identity changed colors: ' + JSON.stringify(di));

  const ds = await page.evaluate(() => window.__dualSwap());
  if (near(ds.left, 0, 255, 0)) ok('dualTint primary=green: red rect → GREEN (' + ds.left + ')');
  else fail('left not green: ' + ds.left);
  if (near(ds.right, 255, 0, 255))
    ok('dualTint contrast=magenta: blue rect → MAGENTA (' + ds.right + ')');
  else fail('right not magenta: ' + ds.right);

  const mo = await page.evaluate(() => window.__mono());
  // monochrome(yellow): red lum=0.2126 → (0.2126*255≈54) yellow-scaled → R&G≈54, B=0.
  if (mo.left[2] < 40 && mo.left[0] > 20 && Math.abs(mo.left[0] - mo.left[1]) < 24)
    ok('monochrome(yellow): red rect → yellow-weighted luminance (' + mo.left + ')');
  else fail('monochrome wrong: ' + JSON.stringify(mo.left));

  const cl = await page.evaluate(() => window.__channelLerp());
  if (near(cl.left, 0, 255, 0)) ok('channelLerp primary=green: red rect → GREEN (' + cl.left + ')');
  else fail('channelLerp left not green: ' + cl.left);
  // blue rect: B=1 → contrast=blue; G=0,A=1 → k=0 → stays contrast (blue).
  if (near(cl.right, 0, 0, 255))
    ok('channelLerp contrast=blue: blue rect stays blue (k=0, ' + cl.right + ')');
  else fail('channelLerp right wrong: ' + cl.right);

  const pal = await page.evaluate(() => window.__palette());
  if (near(pal.left, 255, 255, 255))
    ok('palette[R]: red rect (R=1) → white LUT entry (' + pal.left + ')');
  else fail('palette red→white failed: ' + pal.left);
  if (near(pal.right, 0, 0, 0))
    ok('palette[R]: blue rect (R=0) → black LUT entry (' + pal.right + ')');
  else fail('palette blue→black failed: ' + pal.right);

  const rv = await page.evaluate(() => window.__revertAfterRecolor());
  if (near(rv.left, 255, 0, 0) && near(rv.right, 0, 0, 255))
    ok('recolor is PER-DRAW: a plain draw after a recolor draw reverts to authored colors');
  else fail('recolor stuck after dropped: ' + JSON.stringify(rv));

  // ── Per-shape override tint RGB ───────────────────────────────────────────
  const tc = await page.evaluate(() => window.__tintCyan());
  // white #FFF × cyan #39BCE4 = cyan ≈ (57,188,228).
  if (near(tc.tinted, 57, 188, 228, 30))
    ok('override tint RGB: white bar × cyan → CYAN (' + tc.tinted + '), not white');
  else fail('override tint dropped RGB — bar not cyan: ' + JSON.stringify(tc.tinted));
  if (near(tc.untinted, 255, 255, 255, 20))
    ok('override tint is PER-SHAPE: the un-tinted white bar stays white (' + tc.untinted + ')');
  else fail('tint leaked to other shape: ' + JSON.stringify(tc.untinted));

  const td = await page.evaluate(() => window.__tintDarken());
  // white × [0,0,0,0.502] = black at 0.502 over gray(128) ≈ (64,64,64). Must be
  // markedly darker than the untinted white half.
  if (td.tinted[0] < 110 && td.tinted[1] < 110 && td.tinted[2] < 110)
    ok('override tint [0,0,0,0.502]: white pill DARKENED over gray (' + td.tinted + ')');
  else fail('translucent-black tint did not darken the pill: ' + JSON.stringify(td.tinted));

  const trv = await page.evaluate(() => window.__tintRevert());
  if (near(trv.tinted, 255, 255, 255, 20))
    ok(
      'override tint is PER-DRAW: dropping the tint reverts the bar to white (' + trv.tinted + ')',
    );
  else fail('override tint stuck after drop: ' + JSON.stringify(trv.tinted));

  await page.close();
}

// nativeInstancedRecolor — the native fallback's instanced draws
// must honor per-instance recolor (tint / colorMatrix / …), like the GL
// instanced path: N instances of one white source must each render in their
// own tint, not a single shared color.
async function nativeInstancedRecolor(suite) {
  const { ok, fail } = T;
  // One white bundle, instanced three times with different tints → R/G/B.
  const WHITE =
    '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="20" height="20" fill="#FFFFFF"/></svg>';

  const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="200" height="60"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';

const bundle = await importSvg(${JSON.stringify(WHITE)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
scene.setViewport(200, 60);
const ctx = document.getElementById('c').getContext('2d');

// em→pixel affine placing the 20×20 bundle at a pixel rect.
function emToPx(px, py, s) { return new Float32Array([s/20,0,0, 0,s/20,0, px,py,1]); }

window.__instancedTint = async () => {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundleInstanced(bundle, [
    { worldMatrix: emToPx(20,  20, 20), tint: [1, 0, 0, 1] },   // red
    { worldMatrix: emToPx(90,  20, 20), tint: [0, 1, 0, 1] },   // green
    { worldMatrix: emToPx(160, 20, 20), tint: [0, 0, 1, 1] },   // blue
  ]);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,200,60); ctx.drawImage(img, 0, 0, 200, 60);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { groups: scene.svg.querySelectorAll(':scope > g').length, r: at(30,30), g: at(100,30), b: at(170,30) };
};
window.__ready = true;
</script></body></html>`;

  const near = (px, r, g, b, tol = 40) =>
    Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const r = await page.evaluate(() => window.__instancedTint());
  if (r.groups === 3) ok('drawBundleInstanced drew 3 instances (3 <g>)');
  else fail('instance count: ' + r.groups);
  if (near(r.r, 255, 0, 0)) ok('instance 0: PER-INSTANCE tint → red (' + r.r + ')');
  else fail('instance 0 not red — per-instance tint dropped: ' + r.r);
  if (near(r.g, 0, 255, 0)) ok('instance 1: PER-INSTANCE tint → green (' + r.g + ')');
  else fail('instance 1 not green: ' + r.g);
  if (near(r.b, 0, 0, 255)) ok('instance 2: PER-INSTANCE tint → blue (' + r.b + ')');
  else fail('instance 2 not blue: ' + r.b);

  await page.close();
}

// nativeBlendMode — the native fallback must honor a per-draw
// blendMode on drawBundle (CSS mix-blend-mode), like the GL path.
async function nativeBlendMode(suite) {
  const { ok, fail } = T;
  // A full-canvas magenta backdrop, then a cyan square blended over it.
  // multiply(magenta #FF00FF, cyan #00FFFF) = #0000FF (blue). normal = cyan.
  const MAGENTA =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="100" fill="#FF00FF"/></svg>';
  const CYAN =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="25" y="25" width="50" height="50" fill="#00FFFF"/></svg>';

  const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
const magenta = await importSvg(${JSON.stringify(MAGENTA)}, { retainSource: true });
const cyan = await importSvg(${JSON.stringify(CYAN)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const ctx = document.getElementById('c').getContext('2d');

async function draw(cyanBlend) {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(magenta, { worldMatrix: id });
  scene.drawBundle(cyan, { worldMatrix: id, blendMode: cyanBlend });   // 0=normal, 1=multiply
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const p = ctx.getImageData(50,50,1,1).data; return [p[0],p[1],p[2]];
}
window.__normal = () => draw(0);
window.__multiply = () => draw(1);
window.__ready = true;
</script></body></html>`;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const normal = await page.evaluate(() => window.__normal());
  // normal: cyan square shows cyan (G & B high, R low).
  if (normal[0] < 80 && normal[1] > 180 && normal[2] > 180)
    ok('blendMode=normal: cyan over magenta stays cyan (' + normal + ')');
  else fail('normal blend wrong: ' + normal);

  const mult = await page.evaluate(() => window.__multiply());
  // multiply(magenta, cyan) = blue: R≈0, G≈0, B≈255.
  if (mult[0] < 80 && mult[1] < 80 && mult[2] > 180)
    ok('blendMode=multiply: cyan × magenta → BLUE (' + mult + ')');
  else fail('multiply blend not applied (bundle blendMode dropped?): ' + mult);

  await page.close();
}

// The native fallback's PIXEL-VIEWPORT coordinate mode (multi-bundle
// compositor contract).
//
// In 'viewport' mode the root <svg> viewBox is the pixel viewport
// (0 0 W H), NOT the first bundle's em-box, and each bundle is placed by
// an em→pixel worldMatrix. Proves N bundles land at distinct, correct
// pixel positions rather than all being interpreted in the first bundle's
// em-space.
async function nativeViewportSpace(suite) {
  const { ok, fail } = T;
  // A 1-unit bundle with a NON-pixel em-box (viewBox -50 0 200 100) so the
  // "first bundle's em-box ≠ viewport" mismatch would be obvious if present.
  const PREFAB =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 0 200 100" width="200" height="100"><rect id="r" x="-50" y="0" width="200" height="100" fill="#c0392b"/></svg>';

  const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="400" height="300"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';

const prefab = await importSvg(${JSON.stringify(PREFAB)}, { retainSource: true });
const host = document.getElementById('host');
const scene = createNativeScene(host, { coordinateSpace: 'viewport' });
scene.setViewport(400, 300);

// Build an em→pixel affine that maps the bundle's bbox (-50 0 200 100)
// into a target pixel rect (px, py, pw, ph). em x in [-50,150] → [px,px+pw].
function emToPx(bbox, px, py, pw, ph) {
  const [bx, by, bw, bh] = bbox;
  const sx = pw / bw, sy = ph / bh;
  // column-major mat3: col0=(sx,0,0) col1=(0,sy,0) col2=(tx,ty,1)
  const tx = px - bx * sx, ty = py - by * sy;
  return new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
}
const bbox = prefab.globalBBox;

// Two instances of the SAME prefab at two pixel rects:
//   A → top-left  (20,20, 100x60)
//   B → bottom-right (260,200, 120x80)
window.__draw = () => {
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(prefab, { worldMatrix: emToPx(bbox, 20, 20, 100, 60) });
  scene.drawBundle(prefab, { worldMatrix: emToPx(bbox, 260, 200, 120, 80) });
  scene.endFrame();
  return {
    viewBox: scene.svg.getAttribute('viewBox'),
    par: scene.svg.getAttribute('preserveAspectRatio'),
    groups: scene.svg.querySelectorAll(':scope > g').length,
    space: scene.coordinateSpace,
  };
};

// Raster in viewport mode: a green block via drawImage must land at its
// dstRect (pixel space) and ALIGN with bundles (no nested-svg distortion).
const GREEN = { width: 10, height: 10, rgba: (() => { const a = new Uint8Array(400); for (let i=0;i<100;i++){a[i*4+1]=200;a[i*4+3]=255;} return a; })() };
const cctx = document.getElementById('cv').getContext('2d');
window.__rasterAlign = async () => {
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(prefab, { worldMatrix: emToPx(bbox, 20, 20, 100, 60) });   // red A top-left
  scene.drawImage(GREEN, { dstRect: [260, 200, 120, 80] });                   // green at B's spot
  scene.endFrame();
  // raster in viewport mode hosts in a <g> (no nested <svg> re-projection);
  // confirm there's no nested <svg> wrapper for the raster.
  const noNestedSvg = scene.svg.querySelector('svg image') === null && !!scene.svg.querySelector('image');
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  cctx.clearRect(0,0,400,300); cctx.drawImage(img, 0, 0, 400, 300);
  const at = (x,y) => { const p = cctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  const green = (px) => px[3] > 10 && px[1] > 150 && px[0] < 120 && px[2] < 120;
  return {
    directImage: noNestedSvg,                  // <image> straight in root (viewport mode)
    greenAtRect: green(at(320, 240)),          // center of [260,200,120,80]
    greenNotAtA: !green(at(70, 50)),           // not where the red bundle is
  };
};

const ctx = document.getElementById('cv').getContext('2d');
window.__sample = async () => {
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,400,300); ctx.drawImage(img, 0, 0, 400, 300);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  const red = (px) => px[3] > 10 && px[0] > 150 && px[1] < 100 && px[2] < 100;
  return {
    insideA: red(at(70, 50)),     // center of rect A (20..120, 20..80)
    insideB: red(at(320, 240)),   // center of rect B (260..380, 200..280)
    gapBetween: !red(at(190, 140)),// empty space between them
    cornerEmpty: !red(at(395, 5)), // top-right corner: nothing
  };
};
window.__ready = true;
</script></body></html>`;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const info = await page.evaluate(() => window.__draw());
  if (info.space === 'viewport') ok('scene.coordinateSpace === viewport');
  else fail('space wrong: ' + info.space);
  if (info.viewBox === '0 0 400 300')
    ok('root viewBox is the PIXEL VIEWPORT, not the bundle em-box (' + info.viewBox + ')');
  else fail('viewBox is not the viewport: ' + info.viewBox);
  if (info.par === 'none') ok('preserveAspectRatio=none (1:1 pixel mapping)');
  else fail('par wrong: ' + info.par);
  if (info.groups === 2) ok('two bundles → two <g> in one <svg>');
  else fail('group count: ' + info.groups);

  const s = await page.evaluate(() => window.__sample());
  if (s.insideA) ok('bundle A lands at its pixel rect (top-left)');
  else fail('A mispositioned');
  if (s.insideB) ok('bundle B lands at its DISTINCT pixel rect (bottom-right)');
  else fail('B mispositioned');
  if (s.gapBetween) ok('the two bundles are separately placed (gap between)');
  else fail('bundles overlap/fill — em-space mismatch');
  if (s.cornerEmpty) ok('no stray fill outside the placed rects');
  else fail('stray content in corner');

  const ra = await page.evaluate(() => window.__rasterAlign());
  if (ra.greenAtRect) ok('viewport-mode raster lands at its dstRect (aligns with bundles)');
  else fail('raster mispositioned in viewport mode: ' + JSON.stringify(ra));
  if (ra.greenNotAtA) ok('raster confined (not over the bundle)');
  else fail('raster bled: ' + JSON.stringify(ra));

  await page.close();
}

// nativeDefIdCollision — cross-bundle <defs> id collision on the
// native (no-WebGL) backend.
//
// Two independent bundles each ship `<mask id="m1">` (valid in a self-
// contained SVG). The native backend hosts every bundle's markup — defs
// included — into one shared host <svg>. SVG resolves url(#m1) at document
// scope (first match wins), not within the referencing subtree, so without
// per-bundle id namespacing both bundles' `mask="url(#m1)"` bind to whichever
// m1 mounted first → wrong mask on the other. Authored ids are namespaced
// per clone (m1 → m1_b<seq>, authored id kept on data-oid) and all url(#…) /
// href refs rewritten, so each bundle masks with its own def.
//
// Fixture: bundle A = red square masked to its LEFT half; bundle B = blue
// square masked to its RIGHT half (opposite masks, same id). If they collide,
// B would be masked by A's left-half mask (or vice versa) → wrong region.
async function nativeDefIdCollision(suite) {
  const { ok, fail } = T;
  // Mask shows the LEFT half (x 0..50). Red fill.
  const A =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<mask id="m1"><rect x="0" y="0" width="50" height="100" fill="#fff"/></mask>' +
    '<rect x="0" y="0" width="100" height="100" fill="#ff0000" mask="url(&quot;#m1&quot;)"/></svg>';
  // same id m1, but mask shows the RIGHT half (x 50..100). Blue fill.
  const B =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<mask id="m1"><rect x="50" y="0" width="50" height="100" fill="#fff"/></mask>' +
    '<rect x="0" y="0" width="100" height="100" fill="#0000ff" style="mask:url(&apos;#m1&apos;)"/></svg>';

  const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
import { nativeResourcePixels } from '/test/_nativeResources.mjs';
window.__generatedResources = nativeResourcePixels;
const a = await importSvg(${JSON.stringify(A)}, { retainSource: true });
const b = await importSvg(${JSON.stringify(B)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
// Place both at the SAME pixel rect (overlapping). With correct masks A fills
// the LEFT half (red), B fills the RIGHT half (blue) — together they tile the
// canvas with no overlap. A collision would put both halves on the same side.
function emToPx(s) { return new Float32Array([s,0,0, 0,s,0, 0,0,1]); }
const ctx = document.getElementById('cv').getContext('2d');
window.__run = async () => {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(a, { worldMatrix: emToPx(1) });
  scene.drawBundle(b, { worldMatrix: emToPx(1) });
  scene.endFrame();
  // DOM: count distinct mask ids actually present.
  const masks = [...scene.svg.querySelectorAll('mask')].map(m => m.getAttribute('id'));
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return {
    maskIds: masks,
    left:  at(25, 50),   // expect RED (bundle A's left-half mask)
    right: at(75, 50),   // expect BLUE (bundle B's right-half mask)
  };
};
window.__ready = true;
</script></body></html>`;

  const isRed = (px) => px[0] > 150 && px[1] < 90 && px[2] < 90;
  const isBlue = (px) => px[2] > 150 && px[0] < 90 && px[1] < 90;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const r = await page.evaluate(() => window.__run());
  // Two masks, UNIQUE ids (namespaced), not one shared "m1".
  if (r.maskIds.length === 2 && new Set(r.maskIds).size === 2)
    ok('two bundles → two UNIQUE mask ids (' + JSON.stringify(r.maskIds) + '), no collision');
  else fail('mask ids collided/missing: ' + JSON.stringify(r.maskIds));
  // Each bundle masked by its own def: A shows left-red, B shows right-blue.
  if (isRed(r.left))
    ok('left half is RED — bundle A masked by ITS m1 (left-half) (' + r.left + ')');
  else fail('left not red — A masked by wrong def: ' + r.left);
  if (isBlue(r.right))
    ok('right half is BLUE — bundle B masked by ITS m1 (right-half) (' + r.right + ')');
  else fail('right not blue — B bound the FIRST m1 (collision): ' + r.right);

  const generated = await page.evaluate(() => window.__generatedResources());
  for (const row of generated) {
    if (!row.duplicates.length && row.wrongPoints === 0)
      ok('generated resources ' + row.mode + ': unique ids and exact authored pixels');
    else fail('generated resources ' + JSON.stringify(row));
  }

  await page.close();
}

// nativeClipDefLifecycle — a setNodeClip <defs> entry must not leak
// when its clipped bundle stops being drawn, and must rebuild if the bundle is
// drawn again. The positional reconciler trims the bundle's <g> on a frame it
// isn't drawn; the trim also detaches the orphaned clip def (keeping the
// _extClips descriptor so a redraw re-creates it via ensureExtClipDef).
async function nativeClipDefLifecycle(suite) {
  const { ok, fail } = T;
  const CONTENT =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/></svg>';
  const CLIP =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<rect x="0" y="0" width="100" height="50" fill="#fff"/></svg>';

  const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
import { nativeResourceLifetime } from '/test/_nativeResources.mjs';
window.__resourceLifetime = nativeResourceLifetime;
const content = await importSvg(${JSON.stringify(CONTENT)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
scene.setNodeClip(content, { maskSvg: ${JSON.stringify(CLIP)}, mode: 'in' });

const defCount = () => scene.svg.querySelectorAll('clipPath[id^="mantleExtClip"], mask[id^="mantleExtClip"]').length;
const gHasClip = () => {
  const g = scene.svg.querySelector('g[clip-path], g[mask]');
  return !!g;
};
const drawFrame = () => { scene.beginFrame([0,0,0,1]); scene.drawBundle(content, { worldMatrix: id }); scene.endFrame(); };
const emptyFrame = () => { scene.beginFrame([0,0,0,1]); scene.endFrame(); };

window.__run = () => {
  drawFrame();   const afterDraw = { defs: defCount(), clip: gHasClip() };
  emptyFrame();  const afterTrim = { defs: defCount(), clip: gHasClip() };
  drawFrame();   const afterRedraw = { defs: defCount(), clip: gHasClip() };
  return { afterDraw, afterTrim, afterRedraw };
};
window.__ready = true;
</script></body></html>`;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const r = await page.evaluate(() => window.__run());
  console.log('  ', JSON.stringify(r));
  if (r.afterDraw.defs === 1 && r.afterDraw.clip) ok('drawn: clip def present + <g> clipped');
  else fail('drawn state wrong: ' + JSON.stringify(r.afterDraw));
  if (r.afterTrim.defs === 0 && !r.afterTrim.clip)
    ok('untrimmed: clip def freed (no orphan) + bundle <g> gone');
  else fail('def leaked after bundle stopped drawing: ' + JSON.stringify(r.afterTrim));
  if (r.afterRedraw.defs === 1 && r.afterRedraw.clip)
    ok('redraw: clip def rebuilt + <g> clipped again');
  else fail('clip not restored on redraw: ' + JSON.stringify(r.afterRedraw));

  const lifetime = await page.evaluate(() => window.__resourceLifetime());
  if (
    lifetime.twice === 1 &&
    lifetime.once === 1 &&
    lifetime.onceBottom.every((v) => v === 0) &&
    lifetime.swappedDefs === 1 &&
    lifetime.replaced === 1 &&
    lifetime.empty === 0
  )
    ok('live clip survives partial trimming; replaced/unused definitions retire');
  else fail('clip resource lifetime ' + JSON.stringify(lifetime));
  if (
    lifetime.templatesAfterEmpty === 0 &&
    lifetime.templateReused &&
    lifetime.heldTemplateDefs === 0 &&
    lifetime.rasterDefsAfterReplace === 2 &&
    lifetime.rasterDefsAfterTrim === 0
  )
    ok('unused instance and raster definitions retire; live templates are reused');
  else fail('template/raster lifetime ' + JSON.stringify(lifetime));
  const cdp = await page.target().createCDPSession();
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  const retained = await page.evaluate(() =>
    Object.fromEntries(
      Object.entries(window.__nativeLifetime.refs).map(([key, refs]) => [
        key,
        refs.filter((ref) => ref.deref()).length,
      ]),
    ),
  );
  if (
    lifetime.observed.clip === 16 &&
    lifetime.observed.template === 16 &&
    Object.values(retained).every((n) => n === 0)
  )
    ok(
      'live scene releases retired clip/template owners, selected bundle and borrowed clear-color storage',
    );
  else
    fail('retained native resources ' + JSON.stringify({ observed: lifetime.observed, retained }));
  await page.evaluate(() => {
    for (const scene of window.__nativeLifetime.scenes) scene.dispose();
    delete window.__nativeLifetime;
  });
  await page.close();
}

// nativeStationaryClip — setNodeClip on the native (no-WebGL)
// backend: a STATIONARY viewport-space clip that MOVING content is drawn
// through. This is the case Mantle's intra-bundle <mask> can't express (an
// intra-bundle mask shares the bundle's em-space and translates WITH it).
//
// On native it's fully analytic — a <clipPath>/<mask> in <defs>, transformed
// each frame by inverse(worldMatrix) so it stays put while the bundle's <g>
// transform animates. NO rasterization, NO sampling (the GL analogue is
// renderClipCoverage → a coverage RT).
//
// Fixture: content = a 20×20 red square at the TOP (em y 0..20). Its
// worldMatrix translates it DOWN. The clip = the top half (viewport y 0..50).
//   mode 'in' : square visible while it's in the top half; clipped out once it
//               descends past y=50. (If the clip moved with the bundle, the
//               square would stay visible forever.)
//   mode 'out': the exact complement — square hidden at top, appears below.
async function nativeStationaryClip(suite) {
  const { ok, fail } = T;
  // 20×20 red square at the top (em 40..60 x, 0..20 y) of a 100×100 em box.
  const CONTENT =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<rect x="40" y="0" width="20" height="20" fill="#ff0000"/></svg>';
  // Clip mask shape: the TOP half of the viewport (px 0..50 in y). Paint is
  // irrelevant for mode 'in' (clipPath uses geometry); for 'out' the impl
  // forces it black.
  const CLIP =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<rect x="0" y="0" width="100" height="50" fill="#fff"/></svg>';

  const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
const content = await importSvg(${JSON.stringify(CONTENT)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
// em→px identity; translate Y by dy (column-major mat3: tx=[6], ty=[7]).
const wm = (dy) => new Float32Array([1,0,0, 0,1,0, 0,dy,1]);
const ctx = document.getElementById('cv').getContext('2d');

window.__setClip = (mode) => scene.setNodeClip(content, { maskSvg: ${JSON.stringify(CLIP)}, mode });
window.__clearClip = () => scene.clearNodeClip(content);

window.__renderAt = async (dy) => {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(content, { worldMatrix: wm(dy) });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  // Sample the CENTER of where the square is now (viewport y = dy+10).
  const p = ctx.getImageData(50, dy + 10, 1, 1).data;
  return [p[0], p[1], p[2], p[3]];
};
window.__ready = true;
</script></body></html>`;

  const isRed = (px) => px[0] > 150 && px[1] < 90 && px[2] < 90;
  const isBg = (px) => px[0] < 60 && px[1] < 60 && px[2] < 60;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  // mode 'in': visible in the top half, clipped out below.
  await page.evaluate(() => window.__setClip('in'));
  const inTop = await page.evaluate(() => window.__renderAt(10)); // square at y10..30 → inside
  const inBot = await page.evaluate(() => window.__renderAt(60)); // square at y60..80 → below clip
  if (isRed(inTop)) ok("mode 'in': square RED while in the top half (y~20): " + inTop);
  else fail("mode 'in' top: expected red, got " + inTop);
  if (isBg(inBot))
    ok("mode 'in': square CLIPPED OUT once it descends past y=50 (clip is stationary): " + inBot);
  else fail("mode 'in' bottom: square still visible — clip moved WITH the bundle: " + inBot);

  // mode 'out': complement — hidden at top, visible once below.
  await page.evaluate(() => window.__setClip('out'));
  const outTop = await page.evaluate(() => window.__renderAt(10)); // top → destination-out → hidden
  const outBot = await page.evaluate(() => window.__renderAt(60)); // below → visible
  if (isBg(outTop)) ok("mode 'out': square HIDDEN in the top half (destination-out): " + outTop);
  else fail("mode 'out' top: expected bg, got " + outTop);
  if (isRed(outBot)) ok("mode 'out': square VISIBLE once below the stationary mask: " + outBot);
  else fail("mode 'out' bottom: expected red, got " + outBot);

  // clearNodeClip removes the clip entirely (square visible everywhere).
  await page.evaluate(() => window.__clearClip());
  const clrBot = await page.evaluate(() => window.__renderAt(60));
  if (isRed(clrBot)) ok('clearNodeClip: clip removed, square visible at y60 again: ' + clrBot);
  else fail('clearNodeClip did not remove the clip: ' + clrBot);

  await page.close();
}

// nativeMaskedShapeIndex — guards the positional shape→element
// mapping on masked/clipped art.
//
// A <mask>/<clipPath>/<defs> contains shape elements (the mask geometry)
// that appear first in document order. The native fallback's positional
// shapeElByIndex walk must NOT count them: if it did, every visible shape's
// index would shift by the number of mask/clip shapes and
// overrides/morph/recolor would land on the wrong element. Shape elements
// inside non-rendered containers are excluded from the positional walk.
//
// This hides visible shape index 0 via a per-shape override and asserts the
// box disappears while the masked text stays — proving shape 0 maps to the
// box, not the mask's rect (hiding the mask rect would empty the mask and
// blank everything).
async function nativeMaskedShapeIndex(suite) {
  const { ok, fail } = T;
  const fontPath = optionalAsset(fontFixture('roboto-regular.ttf'));
  if (!fontPath) return;
  const fontB64 = readFileSync(fontPath).toString('base64');
  // Full-canvas mask (everything visible) whose rect is the FIRST shape
  // element in document order — the index-shift trigger. Box (blue) +
  // masked text (red).
  const SVG = readFileSync(
    new URL('../examples/smoke/nativeMaskedShapeIndex__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body><div id="host"></div><canvas id="cv" width="100" height="50"></canvas>
<script type="module">
import { importSvg } from '/src/svg/importer.js';
import { MantleFontAsset } from '/src/font/fontAsset.js';
import { buildSvgTextGlyphs } from '/src/font/textRun.js';
import { createNativeScene, createNativeOverrideTable } from '/src/fallback/index.js';

const FONT = new MantleFontAsset(Uint8Array.from(atob('${fontB64}'), c => c.charCodeAt(0)));
const bundle = await importSvg(${JSON.stringify(SVG)}, {
  retainSource: true, keepInvisibleShapes: true,
  fonts: { Roboto: FONT }, svgTextLayout: buildSvgTextGlyphs });
window.__numShapes = bundle.numShapes;

const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'bundle' });
const ovr = createNativeOverrideTable(bundle);
const ID = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

async function sample(useOvr) {
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(bundle, useOvr ? { worldMatrix: ID, overrides: ovr } : { worldMatrix: ID });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej;
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml))); });
  const ctx = document.getElementById('cv').getContext('2d');
  ctx.clearRect(0,0,100,50); ctx.drawImage(img, 0,0,100,50);
  const at = (x,y) => { const d = ctx.getImageData(x,y,1,1).data; return [d[0],d[1],d[2],d[3]]; };
  return { box: at(18,24), text: at(48,26) };
}

window.__before = await sample(false);          // no override
ovr.set(0, { visibility: 0 });                  // hide VISIBLE shape 0 (the box)
window.__after = await sample(true);
window.__ready = true;
</script></body></html>`;
  const isBlue = (p) => p[2] > 150 && p[0] < 100 && p[3] > 100;
  // "red-dominant" — robust to anti-aliased glyph-edge samples that blend
  // red over the white background (e.g. 255,191,191).
  const isRed = (p) => p[0] > 120 && p[0] > p[1] + 30 && p[0] > p[2] + 30;
  const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
  const near = (a, b) =>
    Math.abs(a[0] - b[0]) < 20 && Math.abs(a[1] - b[1]) < 20 && Math.abs(a[2] - b[2]) < 20;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  const got = await suite
    .goto(page, HTML, { ready: 'flag' })
    .then(() => 1)
    .catch(() => 0);
  if (!got) {
    fail('page did not become ready');
  } else {
    const before = await page.evaluate('window.__before');
    const after = await page.evaluate('window.__after');
    const n = await page.evaluate('window.__numShapes');
    console.log(
      'numShapes:',
      n,
      '| before:',
      JSON.stringify(before),
      '| after:',
      JSON.stringify(after),
    );

    // Baseline: box renders blue, masked text renders red (mask reveals both).
    if (isBlue(before.box)) ok('baseline: box renders blue');
    else fail('baseline box not blue: ' + before.box);
    if (isRed(before.text)) ok('baseline: masked text renders red');
    else fail('baseline text not red: ' + before.text);

    // Hiding VISIBLE shape 0 hides the BOX...
    if (isWhite(after.box)) ok('hide shape 0 → box gone (shape 0 == box, not the mask rect)');
    else fail('box still present after hiding shape 0: ' + after.box);
    // ...and leaves the masked TEXT intact + unchanged (mask not emptied,
    // indices not shifted). If shape 0 were the mask rect, hiding it would
    // empty the mask and the text would go white.
    if (isRed(after.text) && near(after.text, before.text))
      ok('text unchanged (still red) — mask intact, indices not shifted');
    else fail('text changed after hiding shape 0 — shape 0 is the mask rect: ' + after.text);
  }
  await page.close();
}

// clearNodeClip must clear the clip record for the current nativeText mode:
// a nativeText scene stores its clip under __nativeRecordText, so clearNodeClip
// must not delete only the normal __nativeRecord id and leave the clip active.
async function nativeTextClipClear(suite) {
  const { ok, fail } = T;
  const CONTENT =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/></svg>';
  const CLIP =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<rect x="0" y="0" width="100" height="50" fill="#fff"/></svg>';

  const HTML = `<!DOCTYPE html><html><body style="margin:0">
<div id="host"></div><canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
const content = await importSvg(${JSON.stringify(CONTENT)}, { retainSource: true });

// Create the normal-mode bundle record first: the clip must be cleared even
// when both cache slots (__nativeRecord and __nativeRecordText) exist.
const warm = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
warm.setViewport(100, 100);
warm.beginFrame([1,1,1,1]); warm.drawBundle(content); warm.endFrame();

const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport', nativeText: true });
scene.setViewport(100, 100);
const ctx = document.getElementById('cv').getContext('2d');

window.__run = async () => {
  scene.setNodeClip(content, { maskSvg: ${JSON.stringify(CLIP)}, mode: 'in' });
  scene.clearNodeClip(content);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(content);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { top: at(50, 25), bottom: at(50, 75) };
};
window.__ready = true;
</script></body></html>`;

  const isRed = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90 && p[3] > 120;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const r = await page.evaluate(() => window.__run());
  if (isRed(r.top) && isRed(r.bottom))
    ok('nativeText clearNodeClip removed the clip from both top and bottom samples');
  else fail('nativeText clearNodeClip left a stale clip: top=' + r.top + ' bottom=' + r.bottom);

  await page.close();
}

// nativeStream — geometry streaming on the no-WebGL NATIVE scene.
//
// A buildStreamableSections bundle carries a synthesized svgSource (one
// <path> per shape), so createNativeScene can render it; updateNativeBundleGeometry
// streams new per-shape geometry (and fills) by rewriting each <path d> via an
// override table the scene auto-applies. This proves a streamed shape actually
// MOVES + RECOLORS in the live SVG DOM on the native path (the WebGL streaming
// road's no-WebGL equivalent).
//
// Real browser (puppeteer), NO WebGL context — createNativeScene only. Pixels
// sampled by rasterizing the live <svg> into a 2D canvas.
async function nativeStream(suite) {
  const { ok, fail } = T;
  const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="raster" width="120" height="120"></canvas>
<script type="module">
import { buildStreamableSections, createNativeScene, updateNativeBundleGeometry } from '/src/index.js';
import { mkLine } from '/src/primitives/seg.js';

const W=120,H=120,VBOX=[0,0,W,H];
const rect=(x,y,w,h)=>[mkLine([x,y],[x+w,y]),mkLine([x+w,y],[x+w,y+h]),mkLine([x+w,y+h],[x,y+h]),mkLine([x,y+h],[x,y])];

// Streamable bundle: ONE red square at top-left. On native the bundle IS the
// sections object (svgSource + numShapes + shapeIds — all the native scene reads).
const bundle = buildStreamableSections([{ segs: rect(10,10,30,30), fill:[1,0,0,1] }], VBOX);
bundle.globalBBox = VBOX.slice();
window.__hasSvgSource = typeof bundle.svgSource === 'string' && bundle.svgSource.includes('<path');

const host = document.getElementById('host');
const scene = createNativeScene(host);
scene.setViewport(W,H);
const drawOnce = () => { scene.beginFrame([1,1,1,1]); scene.drawBundle(bundle); scene.endFrame(); };

const rctx = document.getElementById('raster').getContext('2d');
async function sampleAll() {
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src=url;});
  rctx.clearRect(0,0,W,H); rctx.drawImage(img,0,0,W,H);
}
const at = (x,y) => { const p = rctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
const isRed = c => c[0]>180 && c[1]<80 && c[2]<80;
const isBlue = c => c[2]>180 && c[0]<80 && c[1]<80;
const isWhite = c => c[0]>200 && c[1]>200 && c[2]>200;

// Frame 1: initial geometry at top-left (25,25); bottom-right (95,95) empty.
drawOnce(); await sampleAll();
const f1 = { atStart: at(25,25), atTarget: at(95,95) };

// Stream: move the square to the BOTTOM-RIGHT.
const r2 = updateNativeBundleGeometry(bundle, [rect(80,80,30,30)]);
drawOnce(); await sampleAll();
const f2 = { ok:r2.ok, atStart: at(25,25), atTarget: at(95,95) };

// Stream fills: recolor (in place) red → blue at the streamed position.
const r3 = updateNativeBundleGeometry(bundle, [rect(80,80,30,30)], { fills:[[0,0,1,1]] });
drawOnce(); await sampleAll();
const f3 = { ok:r3.ok, atTarget: at(95,95) };

window.__out = {
  hasSvgSource: window.__hasSvgSource,
  f1_start_red: isRed(f1.atStart), f1_target_empty: isWhite(f1.atTarget),
  f2_ok: f2.ok, f2_start_empty: isWhite(f2.atStart), f2_target_red: isRed(f2.atTarget),
  f3_ok: f3.ok, f3_target_blue: isBlue(f3.atTarget),
  raw: { f1, f2, f3 },
};
window.__ready = true;
</script></body></html>`;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o.raw));

  if (o.hasSvgSource) ok('buildStreamableSections synthesizes an svgSource (<path> per shape)');
  else fail('no synthesized svgSource — native scene cannot render a streamable bundle');
  if (o.f1_start_red && o.f1_target_empty)
    ok('initial streamed geometry renders on the native scene');
  else fail('initial render wrong: ' + JSON.stringify(o.raw.f1));
  if (o.f2_ok) ok('updateNativeBundleGeometry returns ok');
  else fail('updateNativeBundleGeometry failed');
  if (o.f2_start_empty && o.f2_target_red)
    ok('streamed geometry MOVED in the live SVG DOM (start cleared, target filled)');
  else fail('stream did not move geometry: ' + JSON.stringify(o.raw.f2));
  if (o.f3_ok && o.f3_target_blue) ok('streamed per-shape fill recolors the shape (red→blue)');
  else fail('fill stream wrong: ' + JSON.stringify(o.raw.f3));

  await page.close();
}

// nativeGradientMorph — the native (no-WebGL) morph interpolates a matched shape's gradient stops and parameters
// the way the WebGL morph does. Without a gradient channel in the native override table a gradient fill would
// keep its source value at every t, including t = 1 (README "What interpolates").
//
//   shape "a"   linear, objectBoundingBox, 2 stops (one with stop-opacity), axis and colors both change
//   shape "b"   radial in user space on a STROKE, center and radius change
//   shape "c"   linear in the source, radial in the destination: incompatible, held at the source (as the GL morph holds it)
//   shape "d"   same type, stop COUNT differs: the parameters tween, the stops hold at the source (as the GL stop plan does)
//   shape "e"   gradientTransform: the gradient-space transform tweens and the element carries its inverse
//   shape "f"   an opaque gradient (one texel per stop) to one with a translucent stop (two): the stops still tween
//
// The expected numbers are the GL morph's own: the record slots lerp linearly, the stop bytes lerp linearly. The picture is
// read back from the browser's rasterization of the native <svg> too, so a gradient element the browser cannot use fails here.
async function nativeGradientMorph(suite) {
  const { ok, fail } = T;
  const pose = (defs, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
  const BODY = (fa, fb, fc, fd, fe, ff) =>
    `<rect id="a" x="0" y="0" width="100" height="20" fill="${fa}"/>` +
    `<circle id="b" cx="50" cy="50" r="10" fill="none" stroke="${fb}" stroke-width="8"/>` +
    `<rect id="c" x="0" y="60" width="100" height="10" fill="${fc}"/>` +
    `<rect id="d" x="0" y="72" width="100" height="10" fill="${fd}"/>` +
    `<rect id="e" x="0" y="84" width="100" height="10" fill="${fe}"/>` +
    `<rect id="f" x="0" y="95" width="100" height="5" fill="${ff}"/>`;
  const A = pose(
    '<linearGradient id="ga" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff" stop-opacity="0.8"/></linearGradient>' +
      '<radialGradient id="gb" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/></radialGradient>' +
      '<linearGradient id="gc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
      '<linearGradient id="gd" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
      '<linearGradient id="ge" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0" gradientTransform="translate(0 0)"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
      '<linearGradient id="gf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>',
    BODY('url(#ga)', 'url(#gb)', 'url(#gc)', 'url(#gd)', 'url(#ge)', 'url(#gf)'),
  );
  const B = pose(
    '<linearGradient id="ga" x1="0.25" y1="0" x2="0.75" y2="0"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ffff00" stop-opacity="0.5"/></linearGradient>' +
      '<radialGradient id="gb" gradientUnits="userSpaceOnUse" cx="60" cy="50" r="20"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#00ff00"/></radialGradient>' +
      '<radialGradient id="gc" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ffff00"/></radialGradient>' +
      '<linearGradient id="gd" x1="0.5" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#00ff00"/><stop offset="0.5" stop-color="#ffffff"/><stop offset="1" stop-color="#ffff00"/></linearGradient>' +
      '<linearGradient id="ge" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0" gradientTransform="translate(20 0)"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
      '<linearGradient id="gf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#ffff00" stop-opacity="0.5"/></linearGradient>',
    BODY('url(#ga)', 'url(#gb)', 'url(#gc)', 'url(#gd)', 'url(#ge)', 'url(#gf)'),
  );

  // Raster parity against the GL morph's own semantics: shapes p/q/r/s (opaque stops, so the browser's gradient interpolation and the
  // shader's agree), compared pixel by pixel with sampleGradientAt on the record lerped the way the GL morph lerps it.
  const PA = pose(
    '<linearGradient id="gp" x1="0.1" y1="0.2" x2="0.9" y2="0.7" gradientTransform="rotate(30) skewX(10)" spreadMethod="reflect"><stop offset="0" stop-color="#ff0000"/><stop offset="0.4" stop-color="#ffff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
      '<radialGradient id="gq" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="30" fx="40" fy="45" spreadMethod="repeat"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#220066"/></radialGradient>' +
      '<linearGradient id="gr" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="60" y2="0" gradientTransform="scale(1.5 1) translate(5 0)"><stop offset="0" stop-color="#00ffff"/><stop offset="1" stop-color="#ff00ff"/></linearGradient>' +
      '<radialGradient id="gs" cx="0.3" cy="0.6" r="0.5" gradientTransform="rotate(20)"><stop offset="0" stop-color="#ffcc00"/><stop offset="0.6" stop-color="#00cc44"/><stop offset="1" stop-color="#000000"/></radialGradient>',
    '<rect id="p" x="0" y="0" width="100" height="25" fill="url(#gp)"/><rect id="q" x="0" y="25" width="100" height="25" fill="url(#gq)"/>' +
      '<rect id="r" x="0" y="50" width="100" height="25" fill="url(#gr)"/><rect id="s" x="0" y="75" width="100" height="25" fill="url(#gs)"/>',
  );
  const PB = pose(
    '<linearGradient id="gp" x1="0.3" y1="0" x2="0.6" y2="0.9" gradientTransform="rotate(-20) skewX(25)" spreadMethod="reflect"><stop offset="0" stop-color="#00ff00"/><stop offset="0.6" stop-color="#ff00ff"/><stop offset="1" stop-color="#000000"/></linearGradient>' +
      '<radialGradient id="gq" gradientUnits="userSpaceOnUse" cx="60" cy="40" r="20" fx="65" fy="35" spreadMethod="repeat"><stop offset="0" stop-color="#ff8800"/><stop offset="1" stop-color="#00ff88"/></radialGradient>' +
      '<linearGradient id="gr" gradientUnits="userSpaceOnUse" x1="0" y1="10" x2="40" y2="20" gradientTransform="scale(0.8 1.2) translate(-5 3)"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
      '<radialGradient id="gs" cx="0.6" cy="0.4" r="0.35" gradientTransform="rotate(-35)"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#cc0000"/><stop offset="1" stop-color="#220044"/></radialGradient>',
    '<rect id="p" x="0" y="0" width="100" height="25" fill="url(#gp)"/><rect id="q" x="0" y="25" width="100" height="25" fill="url(#gq)"/>' +
      '<rect id="r" x="0" y="50" width="100" height="25" fill="url(#gr)"/><rect id="s" x="0" y="75" width="100" height="25" fill="url(#gs)"/>',
  );

  const HTML = `<!DOCTYPE html><html><body><div id="host"></div>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const src = await importSvg(${JSON.stringify(A)}, { retainSource: true });
const dst = await importSvg(${JSON.stringify(B)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'));
scene.setViewport(100, 100);
const morph = createNativeMorph(src, dst);
function paintOf(el, prop) {
  const v = el.getAttribute(prop) || '';
  const m = /url\\(#([^)]+)\\)/.exec(v);
  if (!m) return { value: v };
  const g = scene.svg.querySelector('[id="' + m[1] + '"]');
  if (!g) return { value: v, missing: true };
  const attrs = {};
  for (const a of g.getAttributeNames()) attrs[a] = g.getAttribute(a);
  const stops = Array.from(g.querySelectorAll('stop')).map(s => ({ offset: s.getAttribute('offset'), color: s.getAttribute('stop-color'), opacity: s.getAttribute('stop-opacity') }));
  return { value: v, tag: g.localName, attrs, stops };
}
window.__at = (t) => {
  morph.setT(t);
  scene.beginFrame([0, 0, 0, 0]); scene.drawBundle(morph.bundle, { overrides: morph.overrides }); scene.endFrame();
  const out = {};
  for (const [id, prop] of [['a', 'fill'], ['b', 'stroke'], ['c', 'fill'], ['d', 'fill'], ['e', 'fill'], ['f', 'fill']]) {
    const el = scene.svg.querySelector('[data-oid="' + id + '"]');
    out[id] = el ? paintOf(el, prop) : null;
  }
  return out;
};
// Rasterize the native <svg> as the browser draws it and read pixels.
window.__pixels = async (t, pts) => {
  window.__at(t);
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 100;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, 100, 100);
  return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
};
// ---- raster parity: the native scene vs sampleGradientAt on the GL-lerped record --------------------------------------------
import { sampleGradientAt } from '/src/hitTest/paintSample.js';
const psrc = await importSvg(${JSON.stringify(PA)}, { retainSource: true });
const pdst = await importSvg(${JSON.stringify(PB)}, { retainSource: true });
const pscene = createNativeScene(document.createElement('div'));
pscene.setViewport(100, 100);
const pmorph = createNativeMorph(psrc, pdst);
const SLOTS = [3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15];
window.__parity = async (t) => {
  pmorph.setT(t);
  pscene.beginFrame([0, 0, 0, 0]); pscene.drawBundle(pmorph.bundle, { overrides: pmorph.overrides }); pscene.endFrame();
  const xml = new XMLSerializer().serializeToString(pscene.svg);
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 100;
  const g2 = c.getContext('2d'); g2.drawImage(img, 0, 0, 100, 100);
  const px = g2.getImageData(0, 0, 100, 100).data;
  const ga = new Float32Array(psrc.gradients), gb = new Float32Array(pdst.gradients);
  const sa = new Uint8Array(psrc.gradientStops), sb = new Uint8Array(pdst.gradientStops);
  const out = {};
  for (let k = 0; k < 4; k++) {
    const gid = k + 1, base = k * 16;
    const rec = Float32Array.from(ga.subarray(base, base + 16));
    for (const s of SLOTS) rec[s] = ga[base + s] * (1 - t) + gb[base + s] * t;
    // stops: both poses pack the same layout here (same counts), so the byte lerp is index for index
    const stops = Uint8Array.from(sa);
    for (let i = 0; i < stops.length; i++) stops[i] = Math.round(sa[i] * (1 - t) + sb[i] * t);
    // the record's own stop offset: pose A's table; B's offsets for the same gradient index differ only if counts differ
    const gd = { g: rec, s: stops };
    const y0 = k * 25; let worst = 0, n = 0, at = null;
    for (let y = y0 + 2; y < y0 + 23; y += 2) for (let x = 2; x < 98; x += 3) {
      const e = sampleGradientAt(gd, 1, x + 0.5, y + 0.5, [0, y0, 100, y0 + 25]);
      const i = (y * 100 + x) * 4;
      const d = Math.max(Math.abs(px[i] - e[0] * 255), Math.abs(px[i + 1] - e[1] * 255), Math.abs(px[i + 2] - e[2] * 255));
      n++; if (d > worst) { worst = d; at = [x, y, [px[i], px[i + 1], px[i + 2]], e.map(v => Math.round(v * 255))]; }
    }
    out['pqrs'[k]] = { worst, n, at };
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const rgb = (c) => {
    if (!c) return null;
    let m = /^#([0-9a-f]{6})$/i.exec(c.trim());
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /rgba?\(([^)]*)\)/.exec(c);
    return m ? m[1].split(',').slice(0, 3).map(Number) : null;
  };
  const num = (v) => (v == null ? NaN : parseFloat(v));
  const colorNear = (c, want, tol = 1.5) => {
    const g = rgb(c);
    return !!g && g.every((v, i) => near(v, want[i], tol));
  };
  const matrix = (s) => {
    const m = /matrix\(([^)]*)\)/.exec(s || '');
    const v = m
      ? m[1]
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [1, 0, 0, 1, 0, 0];
    return { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
  };

  const at = {};
  for (const t of [0, 0.5, 1]) at[t] = await page.evaluate((x) => window.__at(x), t);

  if (process.env.DBG)
    console.log(await page.evaluate(() => document.getElementById('host').innerHTML));
  // a: linear bbox units
  {
    const g0 = at[0].a,
      gh = at[0.5].a,
      g1 = at[1].a;
    if (
      colorNear(gh.stops?.[0]?.color, [127.5, 127.5, 0]) &&
      colorNear(gh.stops?.[1]?.color, [127.5, 127.5, 127.5])
    )
      ok('a: stop colors at t=0.5 are the midpoint');
    else fail('a: stops at t=0.5 ' + JSON.stringify(gh.stops));
    if (near(num(gh.stops?.[1]?.opacity), 0.65, 0.02))
      ok('a: stop-opacity tweens (0.8 -> 0.5 = 0.65)');
    else fail('a: stop-opacity at t=0.5 ' + JSON.stringify(gh.stops));
    if (near(num(gh.attrs?.x1), 0.125, 1e-4) && near(num(gh.attrs?.x2), 0.875, 1e-4))
      ok('a: axis x1/x2 tween (0.125, 0.875)');
    else fail('a: axis at t=0.5 ' + JSON.stringify(gh.attrs));
    if (colorNear(g0.stops?.[0]?.color, [255, 0, 0]) && near(num(g0.attrs?.x1 ?? 0), 0, 1e-6))
      ok('a: t=0 is the source');
    else fail('a: t=0 ' + JSON.stringify(g0));
    if (
      colorNear(g1.stops?.[0]?.color, [0, 255, 0]) &&
      near(num(g1.attrs?.x1), 0.25, 1e-4) &&
      near(num(g1.stops?.[1]?.opacity), 0.5, 0.01)
    )
      ok('a: t=1 is the destination');
    else fail('a: t=1 ' + JSON.stringify(g1));
    if ((gh.attrs?.gradientUnits ?? 'objectBoundingBox') === 'objectBoundingBox')
      ok('a: units stay objectBoundingBox');
    else fail('a: units ' + gh.attrs?.gradientUnits);
  }
  // b: radial on a stroke
  {
    const gh = at[0.5].b;
    if (
      gh.tag === 'radialGradient' &&
      near(num(gh.attrs.cx), 55, 0.01) &&
      near(num(gh.attrs.r), 30, 0.01)
    )
      ok('b: stroke radial cx/r tween (55, 30)');
    else fail('b: ' + JSON.stringify(gh));
    if (colorNear(gh.stops?.[0]?.color, [255, 127.5, 127.5], 2))
      ok('b: stop 0 white -> red midpoint');
    else fail('b: stop 0 ' + JSON.stringify(gh.stops));
  }
  // c: incompatible types -> held
  {
    const h = at[0.5].c,
      h1 = at[1].c;
    if (
      h.tag === 'linearGradient' &&
      colorNear(h.stops?.[0]?.color, [255, 0, 0]) &&
      h1.tag === 'linearGradient'
    )
      ok('c: incompatible types hold the source gradient');
    else fail('c: ' + JSON.stringify(h));
  }
  // d: stop count differs -> params tween, stops hold
  {
    const h = at[0.5].d;
    if (near(num(h.attrs?.x1), 0.25, 1e-4)) ok('d: axis tweens even when the stop counts differ');
    else fail('d: axis ' + JSON.stringify(h.attrs));
    if (h.stops?.length === 2 && colorNear(h.stops[0].color, [255, 0, 0]))
      ok('d: stops hold at the source');
    else fail('d: stops ' + JSON.stringify(h.stops));
  }
  // e: gradientTransform
  {
    const h = at[0.5].e,
      m = matrix(h.attrs?.gradientTransform);
    if (near(m.e, 10, 0.01) && near(m.a, 1, 1e-6) && near(m.d, 1, 1e-6))
      ok('e: gradientTransform tweens (translate 10)');
    else fail('e: ' + JSON.stringify(h.attrs));
  }
  // f: opaque (one texel per stop) -> a translucent stop (two texels): the packings differ, the stops still tween
  {
    const h = at[0.5].f;
    if (
      colorNear(h.stops?.[0]?.color, [127.5, 127.5, 0]) &&
      colorNear(h.stops?.[1]?.color, [127.5, 127.5, 127.5]) &&
      near(num(h.stops?.[1]?.opacity), 0.75, 0.02)
    )
      ok('f: stops tween across the one-texel / two-texel packings');
    else fail('f: stops at t=0.5 ' + JSON.stringify(h.stops));
  }
  // pixels: the browser can use the gradient
  {
    const px = await page.evaluate((t, pts) => window.__pixels(t, pts), 0.5, [
      [1, 10],
      [50, 10],
      [98, 10],
    ]);
    // a at t=0.5: axis 0.125..0.875 over x in [0,100]; left of 12.5 -> stop 0 (127.5,127.5,0), right of 87.5 -> stop 1 (127.5,127.5,127.5, alpha .75)
    if (
      px[0][0] >= 120 &&
      px[0][0] <= 135 &&
      px[0][1] >= 120 &&
      px[0][1] <= 135 &&
      px[0][2] <= 8 &&
      px[0][3] > 250
    )
      ok('pixels: a at x=1 reads stop 0 mid color');
    else fail('pixels: a at x=1 ' + px[0]);
    if (px[2][3] >= 160 && px[2][3] <= 172)
      ok('pixels: a at x=98 carries the tweened stop alpha (~166)');
    else fail('pixels: a at x=98 ' + px[2]);
    if (px[1][3] > 200 && px[1][3] < 255) ok('pixels: a at x=50 between');
    else fail('pixels: a at x=50 ' + px[1]);
  }

  // raster parity (t = 0, 0.37, 1)
  for (const t of [0, 0.37, 1]) {
    const r = await page.evaluate((x) => window.__parity(x), t);
    for (const k of Object.keys(r)) {
      if (r[k].worst <= 4)
        ok(
          `raster ${k} t=${t}: ${r[k].n} pixels within ${r[k].worst.toFixed(1)}/255 of the GL-lerped gradient`,
        );
      else
        fail(
          `raster ${k} t=${t}: worst ${r[k].worst.toFixed(1)}/255 at ${JSON.stringify(r[k].at)}`,
        );
    }
  }

  await page.close();
}

// nativeIdlessMatchedMorph — matched native morph rows must apply by
// numeric shape index when SVG leaves have no authored id. The native morph
// writes pathD/visibility with overrides.update(shapeIndex, ...); drawBundle
// reads those rows by index, then uses positional DOM addressing.
async function nativeIdlessMatchedMorph(suite) {
  const { ok, fail } = T;
  const SRC =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="10" y="40" width="20" height="20" fill="#ff0000"/></svg>';
  const DST =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="70" y="40" width="20" height="20" fill="#ff0000"/></svg>';

  const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const src = await importSvg(${JSON.stringify(SRC)}, { retainSource: true });
const dst = await importSvg(${JSON.stringify(DST)}, { retainSource: true });
// The importer synthesizes a stable id (shape_N_fill) for every leaf that has
// no authored id=, so SVG rows are never literally id-less. Clear those
// synthetic ids to model a genuinely id-less bundle (programmatic / some text
// sources) — this is what forces buildMorphPlan's POSITIONAL match and the
// native drawBundle's index-based DOM addressing, the paths under test.
for (const b of [src, dst]) if (b.shapeIds) b.shapeIds = b.shapeIds.map(() => '');
const scene = createNativeScene(document.createElement('div'));
scene.setViewport(100, 100);
const morph = createNativeMorph(src, dst);
const ctx = document.getElementById('c').getContext('2d');
window.__shapeIds = src.shapeIds;
window.__render = async (t) => {
  morph.setT(t);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(morph.bundle, { overrides: morph.overrides });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { left: at(20, 50), right: at(80, 50) };
};
window.__ready = true;
</script></body></html>`;

  const isRed = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90 && p[3] > 120;
  const isWhite = (p) => p[0] > 220 && p[1] > 220 && p[2] > 220 && p[3] > 120;

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const ids = await page.evaluate(() => window.__shapeIds);
  if (ids.length === 1 && !ids[0]) ok('fixture has one id-less shape row');
  else fail('fixture unexpectedly has authored/synthetic id: ' + JSON.stringify(ids));

  const r0 = await page.evaluate(() => window.__render(0));
  if (isRed(r0.left) && isWhite(r0.right)) ok('t=0 red shape starts on the left');
  else fail('t=0 wrong: left=' + r0.left + ' right=' + r0.right);

  const r1 = await page.evaluate(() => window.__render(1));
  if (isWhite(r1.left) && isRed(r1.right)) ok('t=1 id-less matched shape moved to the right');
  else fail('t=1 pathD override missed: left=' + r1.left + ' right=' + r1.right);

  await page.close();
}

// nativeDstOnlyMorph — dst-only morph shapes (geometry present only
// in the destination pose, with no element in the cloned source markup) must
// render on native, faded in across t. The native morph decodes each from the
// dst bundle and injects it as a <path> the scene fades in.
async function nativeDstOnlyMorph(suite) {
  const { ok, fail } = T;
  // SRC: one red square on the left. DST: the same red square PLUS a blue
  // square on the right (the dst-only shape). The blue square exists only in
  // the destination, so it must fade in over the right half as t→1.
  const SRC =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/></svg>';
  const DST =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/>' +
    '<rect x="70" y="40" width="20" height="20" fill="#0000FF"/></svg>';

  const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const src = await importSvg(${JSON.stringify(SRC)}, { retainSource: true });
const dst = await importSvg(${JSON.stringify(DST)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'));
scene.setViewport(100, 100);
const morph = createNativeMorph(src, dst);
const ctx = document.getElementById('c').getContext('2d');
window.__info = {
  dstOnly: morph.plan.dstOnly.length,
  extras: (morph.overrides.extraShapes || []).length,
  unrenderable: morph.unrenderableDstOnly.length,
};
async function blueAt(t) {
  morph.setT(t);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(morph.bundle, { overrides: morph.overrides });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const p = ctx.getImageData(80, 50, 1, 1).data;   // center of the blue dst-only square
  return [p[0], p[1], p[2], p[3]];
}
window.__sweep = async () => ({ t0: await blueAt(0), t05: await blueAt(0.5), t1: await blueAt(1) });

// Per-draw recolor must also reach the injected dst-only shape (it's drawn
// geometry like any other). Tint the blue square green via a colorMatrix
// that maps the blue (B) channel to green output. At t=1 the dst-only square
// should be GREEN, proving recolor composes with the injected extra.
async function blueAtRecolored(t) {
  morph.setT(t);
  // colorMatrix (col-major mat4) that sends in.b → out.g, alpha passthrough.
  const cm = new Float32Array([
    0,0,0,0,   // in.r → nothing
    0,0,0,0,   // in.g → nothing
    0,1,0,0,   // in.b → out.g
    0,0,0,1,   // in.a → out.a
  ]);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(morph.bundle, { overrides: morph.overrides, colorMatrix: cm, colorMatrixOffset: [0,0,0,0] });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const p = ctx.getImageData(80, 50, 1, 1).data;
  return [p[0], p[1], p[2], p[3]];
}
window.__recoloredExtra = () => blueAtRecolored(1);
window.__ready = true;
</script></body></html>`;

  const isBlue = (px) => px[3] > 120 && px[2] > 150 && px[0] < 120 && px[1] < 120;
  const isWhite = (px) => px[0] > 220 && px[1] > 220 && px[2] > 220; // bg

  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.goto(page, HTML, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return;
  }

  const info = await page.evaluate(() => window.__info);
  if (info.dstOnly === 1) ok('plan has 1 dst-only shape (the blue square)');
  else fail('dstOnly count: ' + info.dstOnly);
  if (info.extras === 1) ok('morph exposes 1 injected extra shape');
  else fail('extras count: ' + info.extras);
  if (info.unrenderable === 0) ok('unrenderableDstOnly is EMPTY (dst-only renders)');
  else fail('still unrenderable: ' + info.unrenderable);

  const s = await page.evaluate(() => window.__sweep());
  if (isWhite(s.t0)) ok('t=0: dst-only square ABSENT (bg, ' + s.t0 + ') — not yet faded in');
  else fail('t=0 should be empty: ' + s.t0);
  if (s.t05[3] > 60 && s.t05[2] > s.t05[0])
    ok('t=0.5: dst-only square FADING IN (partial blue, ' + s.t05 + ')');
  else fail('t=0.5 not fading in: ' + s.t05);
  if (isBlue(s.t1))
    ok('t=1: dst-only square FULLY RENDERED blue (' + s.t1 + ') — dst-only renders');
  else fail('t=1 dst-only not rendered: ' + s.t1);

  // Per-draw recolor reaches the injected dst-only shape too.
  const rc = await page.evaluate(() => window.__recoloredExtra());
  const isGreen = (px) => px[3] > 120 && px[1] > 150 && px[0] < 120 && px[2] < 120;
  if (isGreen(rc))
    ok('per-draw recolor RECOLORS the dst-only shape (blue→green via colorMatrix, ' + rc + ')');
  else fail('recolor did not reach the injected dst-only shape: ' + rc);

  await page.close();
}

// nativeMorphGroupOpacity — leaf opacity on the no-WebGL fallback: the native morph (createNativeMorph, the browser's own SVG engine
// drawing the source markup) fades a fill+stroke leaf's opacity as ONE element, across 1 as well (.5 -> 1, 1 -> .5) and within .5 -> .8.
//
// The leaf's group rows have no element of their own in the source markup (the leaf is the element), so the morph drives the leaf's
// opacity from the leaf's rows (override `elementOpacity`), and for a pose that has no group (1 -> .5) from the rows the target's
// group stands for. Each cell draws the morph at t and the authored pose of that t through the same scene, 1x, on white, and they
// must agree to within 2/255; the one-after-the-other picture (fill-opacity and stroke-opacity) must differ by at least 24/255.
async function nativeMorphGroupOpacity(suite) {
  const { ok, fail } = T;
  const XA = 20,
    XB = 40,
    TS = [0, 0.25, 0.5, 0.75, 1];
  const leaf = (x, extra, id) =>
    `<path${id} d="M${x} 20h64v64h-64Z" fill="#ff0000" stroke="#0000ff" stroke-width="16"${extra}/>`;
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
  const CELLS = [];
  for (const named of [true, false])
    for (const [oa, ob] of [
      [0.5, 1],
      [0.5, 0.8],
      [1, 0.5],
    ])
      for (const t of TS) {
        const a = oa + (ob - oa) * t,
          x = XA + (XB - XA) * t,
          id = named ? ' id="a"' : '',
          op = (v) => (v === 1 ? '' : ` opacity="${v}"`);
        CELLS.push({
          name: `${named ? 'named' : 'unnamed'} ${oa} -> ${ob} at t=${t}`,
          t,
          a,
          from: doc(leaf(XA, op(oa), id)),
          to: doc(leaf(XB, op(ob), id)),
          control: doc(leaf(x, op(a), id)),
          old: doc(leaf(x, ` fill-opacity="${a}" stroke-opacity="${a}"`, id)),
        });
      }
  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const ctx = document.getElementById('c').getContext('2d', { willReadFrequently: true });
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
async function shot(scene) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(scene.svg)); });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 128, 128); ctx.drawImage(img, 0, 0, 128, 128);
  return b64(new Uint8Array(ctx.getImageData(0, 0, 128, 128).data.buffer));
}
window.__morph = async (from, to, t) => {
  const a = await importSvg(from, { retainSource: true }), b = await importSvg(to, { retainSource: true });
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(128, 128);
  const m = createNativeMorph(a, b); m.setT(t);
  scene.beginFrame([1, 1, 1, 1]); scene.drawBundle(m.bundle, { overrides: m.overrides }); scene.endFrame();
  const r = await shot(scene); m.dispose(); return r;
};
window.__still = async (svg) => {
  const a = await importSvg(svg, { retainSource: true });
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(128, 128);
  scene.beginFrame([1, 1, 1, 1]); scene.drawBundle(a); scene.endFrame();
  return shot(scene);
};
window.__ready = true;
</script></body></html>`;
  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await suite.goto(page, HTML, { ready: 'flag' });
  const u8 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
  const maxDiff = (a, b) => {
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };
  for (const c of CELLS) {
    let svg, control, old;
    try {
      svg = u8(await page.evaluate((f, t, tt) => window.__morph(f, t, tt), c.from, c.to, c.t));
      control = u8(await page.evaluate((s) => window.__still(s), c.control));
      old = u8(await page.evaluate((s) => window.__still(s), c.old));
    } catch (e) {
      fail(c.name + ': ' + e.message);
      continue;
    }
    const vsControl = maxDiff(svg, control),
      vsOld = maxDiff(svg, old),
      mid = c.a > 0.04 && c.a < 0.96;
    const line = `${c.name}: vs control ${vsControl}, vs old ${vsOld}`;
    if (vsControl > 2) {
      fail(line + ' -- the native morph differs from the authored pose');
    } else if (mid && vsOld < 24) {
      fail(line + ' -- vacuous');
    } else ok(line);
  }
  await page.close();
}

// nativeMorphGroupRaster — pixels for transformed native morphs. A native morph inside a transformed group (and <use>, an own transform, a stroke
// that changes width under a scale) is rasterized by the browser and compared with the browser's own rendering of the same pose
// imported as a static svg: t = 0 is pose A, t = 1 pose B, t = 0.5 the pose authored at the average geometry (exact for lines, cubics
// and a circle whose radius and center are averaged). A morph shape left in bundle coordinates would sit displaced by the group's transform.
// Both sides go through the same <img> -> canvas path at 100x100, so antialiasing is the browser's on both.
async function nativeMorphGroupRaster(suite) {
  const { ok, fail } = T;
  const { CASES, PA, PB, MID, shapes } = groupArt;
  const svgOf = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${body}</svg>`;
  const ALL = {
    ...CASES,
    stroked: (P, sw = 2) => `<g transform="rotate(15) scale(1.4 0.8)">${shapes(P, '', sw)}</g>`,
  };
  const POSES = {};
  for (const [name, mk] of Object.entries(ALL)) {
    const sw = name === 'stroked' ? [2, 6, 4] : [undefined, undefined, undefined];
    POSES[name] = [svgOf(mk(PA, sw[0])), svgOf(mk(PB, sw[1])), svgOf(mk(MID, sw[2]))];
  }

  const HTML = `<!DOCTYPE html><html><body><div id="host"></div><script type="module">
import { importSvg, createNativeScene, createNativeMorph, createNativeOverrideTable } from '/src/index.js';
const POSES = ${JSON.stringify(POSES)};
async function raster(xml) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 100; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 100, 100);
  return Array.from(g.getImageData(0, 0, 100, 100).data);
}
window.__case = async (name) => {
  const [a, b] = await Promise.all([importSvg(POSES[name][0], { retainSource: true }), importSvg(POSES[name][1], { retainSource: true })]);
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(100, 100);
  const morph = createNativeMorph(a, b);
  const out = [];
  for (const [t, k] of [[0, 0], [0.5, 2], [1, 1]]) {
    morph.setT(t);
    scene.beginFrame([0, 0, 0, 0]); scene.drawBundle(morph.bundle, { overrides: morph.overrides }); scene.endFrame();
    out.push({ t, native: await raster(new XMLSerializer().serializeToString(scene.svg)), ref: await raster(POSES[name][k]) });
  }
  return out;
};
window.__groupOverride = async (source, expected, values) => {
  const b = await importSvg(source, { retainSource: true, preserveViewport: true });
  const scene = createNativeScene(document.createElement('div')); scene.setViewport(100, 100);
  const table = createNativeOverrideTable(b), out = [];
  try {
    for (const value of values) {
      table.clearAll();
      if (value) for (const [id, override] of value) table.set(id, override);
      scene.beginFrame([0, 0, 0, 0]); scene.drawBundle(b, { overrides: table }); scene.endFrame();
      out.push(await raster(new XMLSerializer().serializeToString(scene.svg)));
    }
    return { images: out, reference: await raster(expected), original: await raster(source) };
  } finally { table.dispose(); scene.dispose(); }
};
window.__ready = true;
</script></body></html>`;
  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await suite.goto(page, HTML, { ready: 'flag' });
  for (const name of Object.keys(ALL)) {
    const frames = await page.evaluate((n) => window.__case(n), name);
    for (const { t, native, ref } of frames) {
      let sum = 0,
        big = 0,
        painted = 0;
      for (let i = 0; i < native.length; i += 4) {
        const d = Math.max(
          Math.abs(native[i] - ref[i]),
          Math.abs(native[i + 1] - ref[i + 1]),
          Math.abs(native[i + 2] - ref[i + 2]),
          Math.abs(native[i + 3] - ref[i + 3]),
        );
        sum += d;
        if (d > 48) big++;
        if (ref[i + 3] > 0) painted++;
      }
      const mean = sum / (native.length / 4);
      // A displaced shape differs over its whole footprint (hundreds of pixels); edge antialiasing differs on a few (under 3% of the painted area).
      if (painted > 300 && big <= 0.03 * painted + 10)
        ok(
          `${name} t=${t}: ${painted} painted pixels, ${big} differ by more than 48/255 (mean ${mean.toFixed(3)})`,
        );
      else
        fail(
          `${name} t=${t}: ${painted} painted pixels, ${big} differ by more than 48/255 (mean ${mean.toFixed(3)})`,
        );
    }
  }
  const filterDefs = '<defs><filter id="f"><feGaussianBlur stdDeviation="1.5"/></filter></defs>';
  const content = (opacity = 1, tinted = false) =>
    '<path id="a" d="M15 15h25v25h-25Z" fill="' +
    (tinted ? '#800000' : '#ff0000') +
    '" opacity="' +
    opacity +
    '"/><path id="b" d="M30 30h25v25h-25Z" fill="#00aa00" opacity="' +
    opacity +
    '"/>';
  const grouped = (c, original = '') =>
    '<g id="H" transform="' +
    original +
    '"><g id="G" filter="url(#f)" opacity=".8">' +
    c +
    '</g></g>';
  const makeOverrideCase = (
    name,
    value,
    transform = '',
    original = '',
    opacity = 1,
    tinted = false,
    outer = null,
  ) => ({
    name,
    source: svgOf(filterDefs + grouped(content(), original)),
    expected: svgOf(
      filterDefs +
        (transform ? '<g transform="' + transform + '">' : '') +
        grouped(content(opacity, tinted), original) +
        (transform ? '</g>' : ''),
    ),
    values: [['G', value], ...(outer ? [['H', outer]] : [])],
  });
  for (const c of [
    makeOverrideCase('filtered translation', { localPosition: [12, 4] }, 'translate(12 4)'),
    makeOverrideCase('filtered scale', { localScale: [1.2, 0.8] }, 'scale(1.2 .8)'),
    makeOverrideCase(
      'nested authored transform',
      { localPosition: [12, 4] },
      'translate(12 4)',
      'translate(5 3) rotate(10) scale(.8 .9)',
    ),
    makeOverrideCase(
      'two active groups',
      { localPosition: [12, 4] },
      'rotate(12) translate(12 4)',
      'translate(5 3) scale(.8 .9)',
      1,
      false,
      { localRotation: (12 * Math.PI) / 180 },
    ),
    makeOverrideCase('filtered visibility', { visibility: 0.5 }, '', '', 0.5),
    makeOverrideCase(
      'filtered tint and visibility',
      { visibility: 0.5, tint: [0.5, 1, 0.25, 0.5] },
      '',
      '',
      0.25,
      true,
    ),
    makeOverrideCase('filtered hidden', { visibility: 0 }, '', '', 0),
  ]) {
    const row = await page.evaluate(
      (c) => window.__groupOverride(c.source, c.expected, [c.values, null, c.values]),
      c,
    );
    const delta = (a, b) => {
      let max = 0;
      for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
      return max;
    };
    const max = Math.max(
      delta(row.images[0], row.reference),
      delta(row.images[1], row.original),
      delta(row.images[2], row.reference),
    );
    if (max <= 2) ok('native ' + c.name + ': max ' + max + ', clear/reapply restored');
    else fail('native ' + c.name + ': max ' + max);
  }
  await page.close();
}

// nativeCircleArc — a circle decoded back to a path `d` must still
// be a circle in the browser.
//
// The no-WebGL fallback decodes curve buffers to SVG path data (morph frames
// and streamed geometry have no source markup to reuse). svg/shape.js encodes
// every <circle> and <ellipse> as ONE arc over [-PI, PI], and a full
// revolution lands back on its own start point — so the decoder emitted
//
//   M20 50 A30 30 0 1 1 20 50 ...
//
// with identical endpoints. SVG §F.6.2: an elliptical arc whose endpoints are
// identical "is equivalent to omitting the elliptical arc segment entirely."
// The circle didn't render.
//
// The browser is the authority on that rule, not the spec text or my reading
// of it, so this renders the decoded `d` for real and compares it against the
// <circle> it came from. A pure-JS assertion on the string could only check
// what I already believe.
async function nativeCircleArc(suite) {
  const { ok, fail } = T;
  globalThis.DOMParser = DP;
  globalThis.XMLSerializer = XS;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { curveRangeToPathD } = await import('../src/fallback/curveToPathD.js');
  const { segsToPathD } = await import('../src/svg/segment.js');
  const { parseShape } = await import('../src/svg/shape.js');
  // Decode each shape through the fallback's own decoder.
  const decode = async (markup) => {
    const r = await importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markup}</svg>`,
      {},
    );
    const cf = r.curveFloats || new Float32Array(r.curves);
    const rg = r.curveRangesByShape[0];
    return curveRangeToPathD(cf, rg.begin, rg.end);
  };

  // The OTHER path to a `d` string. curveRangeToPathD decodes the packed curve
  // buffer (morph frames); segsToPathD converts a segment list, and is what the
  // native streaming road and the WebGL stream's path cache use. Both had the
  // same full-sweep bug, so both are checked here — fixing one and not the other
  // would have left circles vanishing on the streaming path only.
  const decodeSegs = (markup) => {
    const doc = new DP().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markup}</svg>`,
      'text/xml',
    );
    const el = doc.documentElement.getElementsByTagName('*')[0];
    return segsToPathD(parseShape(el, { vx: 100, vy: 100, vd: 100 }));
  };

  const CASES = [
    { name: 'circle', markup: '<circle cx="50" cy="50" r="30"/>' },
    { name: 'ellipse', markup: '<ellipse cx="50" cy="50" rx="30" ry="18"/>' },
    // A genuine half arc must be untouched by the full-sweep split.
    { name: 'half arc', markup: '<path d="M20 50A30 30 0 0 1 80 50Z"/>' },
  ];
  for (const c of CASES) {
    c.d = await decode(c.markup);
    c.dSegs = decodeSegs(c.markup);
  }
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 200, height: 200 });
  try {
    // Any document will do: the page only rasterizes SVG markup through an <img> into a 2D canvas.
    await suite.goto(page, '<!DOCTYPE html><html><body></body></html>', { ready: () => true });
    const out = await page.evaluate(
      async (cases) => {
        // Rasterize a fragment of SVG markup and count filled pixels.
        const inkOf = async (inner) => {
          const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ' +
            `width="200" height="200">${inner}</svg>`;
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error('img load failed'));
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          });
          const cv = document.createElement('canvas');
          cv.width = 200;
          cv.height = 200;
          const c = cv.getContext('2d');
          c.fillStyle = '#fff';
          c.fillRect(0, 0, 200, 200);
          c.drawImage(img, 0, 0, 200, 200);
          const d = c.getImageData(0, 0, 200, 200).data;
          let ink = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] < 128) ink++;
          return ink;
        };
        const res = [];
        for (const c of cases) {
          res.push({
            name: c.name,
            source: await inkOf(c.markup.replace('/>', ' fill="#000"/>')),
            decoded: await inkOf(`<path d="${c.d}" fill="#000"/>`),
            decodedSegs: await inkOf(`<path d="${c.dSegs}" fill="#000"/>`),
          });
        }
        return res;
      },
      CASES.map(({ name, markup, d, dSegs }) => ({ name, markup, d, dSegs })),
    );

    for (const r of out) {
      if (r.source < 500) {
        fail(`${r.name}: the SOURCE markup rendered ${r.source} px — the rig is broken`);
        continue;
      }
      if (r.decoded < 500) {
        fail(
          `${r.name}: decoded path rendered ${r.decoded} px vs ${r.source} for the source — ` +
            'the browser dropped the arc (identical endpoints, §F.6.2)',
        );
        continue;
      }
      const drift = Math.abs(r.decoded - r.source) / r.source;
      if (drift < 0.02)
        ok(`${r.name}: curve-buffer decode matches the source (${r.decoded} vs ${r.source} px)`);
      else
        fail(
          `${r.name}: curve-buffer decode covers ${r.decoded} px vs ${r.source} (${(drift * 100).toFixed(1)}% off)`,
        );

      if (r.decodedSegs < 500) {
        fail(
          `${r.name}: segsToPathD rendered ${r.decodedSegs} px vs ${r.source} — ` +
            'the browser dropped the arc on the streaming path',
        );
      } else {
        const ds = Math.abs(r.decodedSegs - r.source) / r.source;
        if (ds < 0.02)
          ok(`${r.name}: segsToPathD matches the source (${r.decodedSegs} vs ${r.source} px)`);
        else
          fail(
            `${r.name}: segsToPathD covers ${r.decodedSegs} px vs ${r.source} (${(ds * 100).toFixed(1)}% off)`,
          );
      }
    }
  } catch (e) {
    fail(`drive failed: ${e.message}`);
  }
  await page.close();
}

const suite = await openPageSuite({ root: ROOT });
try {
  await T.run(
    [
      ['nativeFallback', nativeFallback],
      ['nativeImageRecolor', nativeImageRecolor],
      ['nativeImageStretch', nativeImageStretch],
      ['nativeImageInstanced', nativeImageInstanced],
      ['nativeRecolor', nativeRecolor],
      ['nativeInstancedRecolor', nativeInstancedRecolor],
      ['nativeBlendMode', nativeBlendMode],
      ['nativeViewportSpace', nativeViewportSpace],
      ['nativeDefIdCollision', nativeDefIdCollision],
      ['nativeClipDefLifecycle', nativeClipDefLifecycle],
      ['nativeStationaryClip', nativeStationaryClip],
      ['nativeMaskedShapeIndex', nativeMaskedShapeIndex],
      ['nativeTextClipClear', nativeTextClipClear],
      ['nativeStream', nativeStream],
      ['nativeGradientMorph', nativeGradientMorph],
      ['nativeIdlessMatchedMorph', nativeIdlessMatchedMorph],
      ['nativeDstOnlyMorph', nativeDstOnlyMorph],
      ['nativeMorphGroupOpacity', nativeMorphGroupOpacity],
      ['nativeMorphGroupRaster', nativeMorphGroupRaster],
      ['nativeCircleArc', nativeCircleArc],
    ],
    suite,
  );
} finally {
  await suite.close();
}
if (T.failures()) {
  console.error(`\n${T.failures()} failure(s)`);
  process.exit(1);
}
console.log('\nnativeFallbackSmoke: all checks passed');
