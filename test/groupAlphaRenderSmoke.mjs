// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupAlphaRenderSmoke -- a draw's `alpha` is GROUP opacity, on the GPU (the call-log proofs are
// test/groupAlphaSmoke.mjs).
//
// A per-leaf multiply would let two opaque rects that overlap show through each other ((171,68,222,191) where
// `<g opacity=".5">` reads (255,0,203,128): 84/255 off Chrome). The draw is one group: the whole bundle
// renders into an accumulator and is faded once.
//
// Each cell renders three documents at 128 px (64-unit viewBox, white ground), as importerSemanticsRenderSmoke's compositingGroup cells do, under four fill
// engines (auto, classic Slug, classic AAC, unified Loop-Blinn):
//   svg      the art, drawn with drawBundle(b, { alpha });
//   control  the same art wrapped in `<g opacity=alpha>` and drawn at alpha 1 (the importer's group path, already correct): the render must
//            match it to within `tol` (default 2/255);
//   old      the per-leaf multiply, authored literally (each leaf's own opacity): the render must DIFFER from svg by at least
//            24/255 (`minOld`) somewhere where the art overlaps -- or, for a one-leaf cell, match it exactly (the direct path, identical pixels).
// Then Chrome's own answer: the control rasterized at 8x by Chrome and box-averaged to 128 px (the AA reference of this repo), over the
// whole image. And analytic probes (a stated point reads a stated color), independent of every document.
// The entry-point cells have no control document: their oracle is the same draw at alpha 1 on a transparent ground, faded by hand
// (out = alpha * S over white), so drawBundleInstanced, a bundle handle's draw, submitBundle's deferral and a morph are each compared
// with what a group fade of their own alpha-1 picture is.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const bare = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${body}</svg>`;
const WHITE = [255, 255, 255];
const over = (rgb, a, under = WHITE) => rgb.map((c, i) => c * a + under[i] * (1 - a));
const CYAN = (extra = '') => `<rect x="4" y="4" width="40" height="40" fill="#0cf" ${extra}/>`;
const PINK = (extra = '') => `<rect x="20" y="20" width="40" height="40" fill="#f0c" ${extra}/>`;
const TWO = CYAN() + PINK();
const FS = (extra = '') =>
  `<rect x="14" y="14" width="36" height="36" fill="#0cf" stroke="#f0c" stroke-width="16" ${extra}/>`;
const BLUR =
  '<filter id="b" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter>';
const MASK = '<mask id="m"><rect width="64" height="64" fill="#808080"/></mask>';
const a = 0.5;

const CELLS = [
  {
    name: 'two overlapping opaque rects at alpha .5',
    alpha: a,
    svg: doc(TWO),
    control: doc(`<g opacity="${a}">${TWO}</g>`),
    old: doc(CYAN(`opacity="${a}"`) + PINK(`opacity="${a}"`)),
    probes: [
      [30, 30, over([255, 0, 204], a), 3],
      [10, 10, over([0, 204, 255], a), 3],
      [55, 55, over([255, 0, 204], a), 3],
      [62, 2, WHITE, 1],
    ],
  },
  {
    name: 'three stacked translucent-paint leaves at alpha .25',
    alpha: 0.25,
    svg: doc(TWO + '<circle cx="32" cy="32" r="18" fill="#fc0" fill-opacity=".6"/>'),
    control: doc(
      '<g opacity=".25">' +
        TWO +
        '<circle cx="32" cy="32" r="18" fill="#fc0" fill-opacity=".6"/></g>',
    ),
    old: doc(
      CYAN('opacity=".25"') +
        PINK('opacity=".25"') +
        '<circle cx="32" cy="32" r="18" fill="#fc0" fill-opacity=".15"/>',
    ),
    probes: [[10, 10, over([0, 204, 255], 0.25), 3]],
  },
  {
    name: 'a fill and a stroke of one shape at alpha .5 (the stroke overlaps its own fill)',
    alpha: a,
    svg: doc(FS()),
    control: doc(`<g opacity="${a}">${FS()}</g>`),
    old: doc(FS(`fill-opacity="${a}" stroke-opacity="${a}"`)),
    probes: [
      [32, 32, over([0, 204, 255], a), 3],
      [10, 32, over([255, 0, 204], a), 3],
    ],
  },
  {
    name: "the importer's own group inside the bundle composites first, then the draw fades",
    alpha: a,
    svg: doc(`<g opacity=".5">${TWO}</g>`),
    control: doc(`<g opacity="${a}"><g opacity=".5">${TWO}</g></g>`),
    old: doc(`<g opacity=".5">${CYAN(`opacity="${a}"`)}${PINK(`opacity="${a}"`)}</g>`),
    probes: [
      [30, 30, over([255, 0, 204], a * 0.5), 3],
      [10, 10, over([0, 204, 255], a * 0.5), 3],
    ],
  },
  {
    name: 'a blend-mode leaf is isolated by the faded group (multiply against the group, not the page)',
    alpha: a,
    svg: doc(CYAN() + PINK('style="mix-blend-mode:multiply"')),
    control: doc(`<g opacity="${a}">${CYAN()}${PINK('style="mix-blend-mode:multiply"')}</g>`),
    old: doc(CYAN(`opacity="${a}"`) + PINK(`opacity="${a}" style="mix-blend-mode:multiply"`)),
    tol: 3,
    minOld: 12,
    probes: [[10, 10, over([0, 204, 255], a), 3]],
  },
  {
    name: 'a filtered leaf fades after its filter',
    alpha: a,
    svg: doc(BLUR + CYAN('filter="url(#b)"') + PINK()),
    control: doc(`${BLUR}<g opacity="${a}">${CYAN('filter="url(#b)"')}${PINK()}</g>`),
    old: doc(BLUR + CYAN(`filter="url(#b)" opacity="${a}"`) + PINK(`opacity="${a}"`)),
    tol: 3,
    probes: [[55, 55, over([255, 0, 204], a), 3]],
  },
  {
    name: 'a filtered leaf hanging off the canvas edge (the filter frame) fades after its filter',
    alpha: a,
    svg: doc(
      BLUR + '<rect x="-12" y="20" width="40" height="30" fill="#0cf" filter="url(#b)"/>' + PINK(),
    ),
    control: doc(
      `${BLUR}<g opacity="${a}"><rect x="-12" y="20" width="40" height="30" fill="#0cf" filter="url(#b)"/>${PINK()}</g>`,
    ),
    old: doc(
      BLUR +
        `<rect x="-12" y="20" width="40" height="30" fill="#0cf" filter="url(#b)" opacity="${a}"/>` +
        PINK(`opacity="${a}"`),
    ),
    tol: 3,
    minOld: 12,
    probes: [
      [2, 35, over([0, 204, 255], a), 6],
      [55, 55, over([255, 0, 204], a), 3],
    ],
  },
  {
    name: 'a masked leaf (mask coverage applied inside the group)',
    alpha: a,
    svg: doc(MASK + CYAN('mask="url(#m)"') + PINK()),
    control: doc(`${MASK}<g opacity="${a}">${CYAN('mask="url(#m)"')}${PINK()}</g>`),
    old: doc(MASK + CYAN(`mask="url(#m)" opacity="${a}"`) + PINK(`opacity="${a}"`)),
    tol: 3,
    probes: [[55, 55, over([255, 0, 204], a), 3]],
  },
  // recovery 1: leaves that provably share no pixel need no accumulator; the picture is the group's all the same.
  {
    name: "two DISJOINT fill leaves at alpha .5 (no accumulator): the group's picture, and the per-leaf one",
    alpha: a,
    oneLeaf: true,
    svg: doc(
      CYAN().replace('width="40"', 'width="16"') +
        PINK().replace('x="20"', 'x="40"').replace('width="40"', 'width="18"'),
    ),
    control: doc(
      `<g opacity="${a}">${CYAN().replace('width="40"', 'width="16"') + PINK().replace('x="20"', 'x="40"').replace('width="40"', 'width="18"')}</g>`,
    ),
    old: doc(
      CYAN(`opacity="${a}"`).replace('width="40"', 'width="16"') +
        PINK(`opacity="${a}"`).replace('x="20"', 'x="40"').replace('width="40"', 'width="18"'),
    ),
    probes: [
      [10, 10, over([0, 204, 255], a), 3],
      [50, 50, over([255, 0, 204], a), 3],
    ],
  },
  {
    name: 'two leaves 1 px (2 device px) apart at alpha .5 (inside the AA pads: the group)',
    alpha: a,
    oneLeaf: true,
    svg: doc(
      '<rect x="4" y="4" width="26" height="40" fill="#0cf"/><rect x="31" y="4" width="26" height="40" fill="#f0c"/>',
    ),
    control: doc(
      `<g opacity="${a}"><rect x="4" y="4" width="26" height="40" fill="#0cf"/><rect x="31" y="4" width="26" height="40" fill="#f0c"/></g>`,
    ),
    old: doc(
      `<rect x="4" y="4" width="26" height="40" fill="#0cf" opacity="${a}"/><rect x="31" y="4" width="26" height="40" fill="#f0c" opacity="${a}"/>`,
    ),
    probes: [
      [10, 10, over([0, 204, 255], a), 3],
      [50, 10, over([255, 0, 204], a), 3],
    ],
  },
  {
    name: 'two leaves overlapping by 1 px at alpha .5',
    alpha: a,
    minOld: 12,
    svg: doc(
      '<rect x="4" y="4" width="26.5" height="40" fill="#0cf"/><rect x="30" y="4" width="26" height="40" fill="#f0c"/>',
    ),
    control: doc(
      `<g opacity="${a}"><rect x="4" y="4" width="26.5" height="40" fill="#0cf"/><rect x="30" y="4" width="26" height="40" fill="#f0c"/></g>`,
    ),
    old: doc(
      `<rect x="4" y="4" width="26.5" height="40" fill="#0cf" opacity="${a}"/><rect x="30" y="4" width="26" height="40" fill="#f0c" opacity="${a}"/>`,
    ),
    probes: [
      [10, 10, over([0, 204, 255], a), 3],
      [50, 10, over([255, 0, 204], a), 3],
    ],
  },
  {
    name: 'a miter tip reaching into a neighbor (stroke ink beyond the path box) at alpha .5',
    alpha: a,
    minOld: 8,
    svg: doc(
      '<path d="M4 60 L12 34 L20 60" fill="none" stroke="#0cf" stroke-width="6" stroke-linejoin="miter" stroke-miterlimit="10"/><rect x="6" y="12" width="12" height="14" fill="#f0c"/>',
    ),
    control: doc(
      `<g opacity="${a}"><path d="M4 60 L12 34 L20 60" fill="none" stroke="#0cf" stroke-width="6" stroke-linejoin="miter" stroke-miterlimit="10"/><rect x="6" y="12" width="12" height="14" fill="#f0c"/></g>`,
    ),
    old: doc(
      `<path d="M4 60 L12 34 L20 60" fill="none" stroke="#0cf" stroke-width="6" stroke-linejoin="miter" stroke-miterlimit="10" stroke-opacity="${a}"/><rect x="6" y="12" width="12" height="14" fill="#f0c" opacity="${a}"/>`,
    ),
    probes: [[12, 16, over([255, 0, 204], a), 3]],
  },
  {
    name: 'ONE paint-only leaf at alpha .5 keeps the direct path: identical pixels to the per-leaf multiply',
    alpha: a,
    oneLeaf: true,
    svg: doc(CYAN()),
    control: doc(`<g opacity="${a}">${CYAN()}</g>`),
    old: doc(CYAN(`opacity="${a}"`)),
    probes: [[20, 20, over([0, 204, 255], a), 2]],
  },
  {
    name: 'ONE stroke-only leaf at alpha .5 keeps the direct path',
    alpha: a,
    oneLeaf: true,
    svg: doc(
      '<rect x="14" y="14" width="36" height="36" fill="none" stroke="#f0c" stroke-width="10"/>',
    ),
    control: doc(
      `<g opacity="${a}"><rect x="14" y="14" width="36" height="36" fill="none" stroke="#f0c" stroke-width="10"/></g>`,
    ),
    old: doc(
      `<rect x="14" y="14" width="36" height="36" fill="none" stroke="#f0c" stroke-width="10" stroke-opacity="${a}"/>`,
    ),
    probes: [[14, 32, over([255, 0, 204], a), 3]],
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createShapeMorph, loadShaders, CacheStrategy } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const W = 128;
const read = () => { const px = new Uint8Array(W * W * 4); gl.readPixels(0, 0, W, W, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(W * W * 4); for (let y = 0; y < W; y++) out.set(px.subarray((W - 1 - y) * W * 4, (W - y) * W * 4), y * W * 4); return out; };
const ENG = { auto: { route: 'auto', kernel: 'auto' }, slug: { route: 'none', kernel: 'slug' }, aac: { route: 'none', kernel: 'aac' }, lb: { route: 'lb', kernel: 'slug' } };
const frame = async (b, draw, clear, eng) => {
  R.setFillEngine(ENG[eng]);
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(W, W); gl.viewport(0, 0, W, W);
  for (let i = 0; i < 3; i++) { R.beginFrame(clear); draw(); R.endFrame(); }
  return read();
};
// Pixels cross to node as base64 rather than as a JSON array of numbers.
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
window.__render = async (svg, drawOpts, eng) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const px = await frame(b, () => R.drawBundle(b, drawOpts || undefined), [1, 1, 1, 1], eng);
  b.dispose && b.dispose(); return b64(px);
};
// Chrome's own raster of the document at 8x, box-averaged to 128 (the opaque white ground makes straight == premultiplied).
window.__chrome8 = async (svg) => {
  const K = 8, S = W * K;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const c = document.createElement('canvas'); c.width = S; c.height = S; const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, S, S); const d = x.getImageData(0, 0, S, S).data;
  const out = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let xx = 0; xx < W; xx++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) s += d[(((y * K + j) * S) + xx * K + i) * 4 + ch];
    out[(y * W + xx) * 4 + ch] = Math.round(s / (K * K));
  }
  return b64(out);
};
// Entry points: the oracle is the same draw at alpha 1 on a transparent ground (S, premultiplied), faded by hand over white.
window.__entry = async (kind, svgA, svgB, eng) => {
  const a = createBundle(gl, await importSvg(svgA, { preserveViewport: true }));
  const T = (tx, ty, s) => new Float32Array([s, 0, 0, 0, s, 0, tx, ty, 1]);
  // 'instbatch': four instances whose painted rects are DISJOINT, two at alpha .5: they share one accumulator (R._alphaInstancePlan).
  // 'instoverlap': the instances overlap each other, so the per-instance loop (one group each, painter order) must be kept.
  const sc = kind === 'instbatch' ? 0.35 : kind === 'instoverlap' ? 0.9 : 0.5, sp = kind === 'instoverlap' ? 0.3 : 0.5;
  let placements = [{ worldMatrix: T(-sp, sp, sc), alpha: 0.5 }, { worldMatrix: T(sp, sp, sc), alpha: kind === 'instbatch' ? 0.5 : 0.25 }, { worldMatrix: T(-sp, -sp, sc), alpha: 1 }, { worldMatrix: T(sp, -sp, sc), alpha: 0.75 }];
  // instances that overlap are layered (painter order kept), and a bundle whose leaves cannot overlap keeps the single instanced draw.
  //   inst1px: two instances overlapping by 1 px (content width 2 * .4 * 64 px; centers 2 * (.4 - 1/128) apart) and one apart, all at .5
  //   instmixed: a chain of three overlapping instances at three alphas
  //   instlayers: touching pairs (layers {0,2}{1,3}) at mixed alphas, one of them 1
  //   instgrid: a 6x6 grid whose neighbors overlap (the shape of the 64-instance probe), alternating alphas
  const d1 = 0.4 - 1 / 128;
  if (kind === 'inst1px') placements = [{ worldMatrix: T(-d1, 0.5, 0.4), alpha: 0.5 }, { worldMatrix: T(d1, 0.5, 0.4), alpha: 0.5 }, { worldMatrix: T(0, -0.5, 0.4), alpha: 0.5 }];
  if (kind === 'instmixed') placements = [{ worldMatrix: T(-0.45, 0, 0.4), alpha: 0.5 }, { worldMatrix: T(0, 0, 0.4), alpha: 0.25 }, { worldMatrix: T(0.45, 0, 0.4), alpha: 0.75 }];
  if (kind === 'instlayers') placements = [-0.75, -0.3, 0.45, 0.85].map((x, i) => ({ worldMatrix: T(x, 0.2, 0.3), alpha: [0.5, 0.5, 1, 0.5][i] }));
  if (kind === 'instgrid') placements = Array.from({ length: 36 }, (_, i) => ({ worldMatrix: T(-0.83 + 0.332 * (i % 6), 0.83 - 0.332 * ((i / 6) | 0), 0.3), alpha: 0.5 }));
  const INST = kind === 'instanced' || kind === 'instbatch' || kind === 'instoverlap' || kind === 'inst1px' || kind === 'instmixed' || kind === 'instlayers' || kind === 'instgrid';
  const run = (alphaScale, clear) => {
    if (INST) return frame(a, () => R.drawBundleInstanced(a, placements.map((p) => ({ worldMatrix: p.worldMatrix, alpha: p.alpha * alphaScale + (1 - alphaScale) }))), clear, eng);
    if (kind === 'loop') return frame(a, () => { for (const p of placements) R.drawBundle(a, { worldMatrix: p.worldMatrix, alpha: p.alpha * alphaScale + (1 - alphaScale) }); }, clear, eng);
    if (kind === 'submit') return frame(a, () => { placements.forEach((p, i) => R.submitBundle(a, { worldMatrix: p.worldMatrix, alpha: p.alpha * alphaScale + (1 - alphaScale), zOrder: 3 - i })); }, clear, eng);
    if (kind === 'dstrect') return frame(a, () => { for (const p of placements) R.drawBundle(a, { dstRect: [8 + p.worldMatrix[6] * 40, 40 + p.worldMatrix[7] * 40, 60, 60], alpha: p.alpha * alphaScale + (1 - alphaScale) }); }, clear, eng);
    if (kind === 'cache') { const h = R.createBundleHandle(a, { staticCache: { strategy: CacheStrategy.ForceWholeAsset } }); return frame(a, () => { for (const p of placements) h.draw({ worldMatrix: p.worldMatrix, alpha: p.alpha * alphaScale + (1 - alphaScale) }); }, clear, eng).finally(() => h.dispose && h.dispose()); }
    if (kind === 'handle') { const h = R.createBundleHandle(a); return frame(a, () => { for (const p of placements) h.draw({ worldMatrix: p.worldMatrix, alpha: p.alpha * alphaScale + (1 - alphaScale) }); }, clear, eng).finally(() => h.dispose && h.dispose()); }
    throw new Error(kind);
  };
  const fast0 = R.debugStats.instancedFastCount | 0;
  const faded = await run(1, [1, 1, 1, 1]);
  const fastDraws = (R.debugStats.instancedFastCount | 0) - fast0;
  // alpha-1 picture of each placement on a transparent ground, one at a time, faded by hand and composed in the same order.
  const out = new Uint8Array(W * W * 4).fill(255);
  const order = kind === 'submit' ? [3, 2, 1, 0] : placements.map((_, i) => i);
  for (const k of order) {
    const p = placements[k];
    const S = await frame(a, () => R.drawBundle(a, kind === 'dstrect' ? { dstRect: [8 + p.worldMatrix[6] * 40, 40 + p.worldMatrix[7] * 40, 60, 60] } : { worldMatrix: p.worldMatrix }), [0, 0, 0, 0], eng);
    for (let i = 0; i < W * W; i++) {
      const sa = S[i * 4 + 3] / 255 * p.alpha;
      for (let ch = 0; ch < 3; ch++) out[i * 4 + ch] = Math.round(S[i * 4 + ch] * p.alpha + out[i * 4 + ch] * (1 - sa));
    }
  }
  a.dispose && a.dispose();
  return { got: b64(faded), want: b64(out), fastDraws };
};
// A faded draw of a CACHED mount: the cache holds the alpha-1 raster and the blit fades it. Each frame's picture equals a hand fade of the
// alpha-1 picture, including right after the alpha moved (no stale raster, no re-bake needed).
window.__cacheFade = async (svgA, eng) => {
  const a = createBundle(gl, await importSvg(svgA, { preserveViewport: true }));
  const h = R.createBundleHandle(a, { staticCache: { strategy: CacheStrategy.ForceWholeAsset } });
  const S = await frame(a, () => R.drawBundle(a), [0, 0, 0, 0], eng);
  const out = [];
  for (const al of [1, 0.8, 0.5, 0.5, 0.3, 0.9, 0.5]) {
    const got = await frame(a, () => h.draw({ alpha: al }), [1, 1, 1, 1], eng);
    const want = new Uint8Array(W * W * 4);
    for (let i = 0; i < W * W; i++) { const sa = S[i * 4 + 3] / 255 * al; for (let ch = 0; ch < 3; ch++) want[i * 4 + ch] = Math.round(S[i * 4 + ch] * al + 255 * (1 - sa)); want[i * 4 + 3] = 255; }
    out.push({ al, got: b64(got), want: b64(want) });
  }
  h.dispose && h.dispose(); a.dispose && a.dispose();
  return out;
};
window.__morph = async (svgA, svgB, eng) => {
  const a = createBundle(gl, await importSvg(svgA, { preserveViewport: true })), b = createBundle(gl, await importSvg(svgB, { preserveViewport: true }));
  const m = createShapeMorph(gl, a, b, {}); m.setT(0.5);
  const got = await frame(m.bundle, () => R.drawBundle(m, { alpha: 0.5 }), [1, 1, 1, 1], eng);
  const S = await frame(m.bundle, () => R.drawBundle(m), [0, 0, 0, 0], eng);
  const want = new Uint8Array(W * W * 4);
  for (let i = 0; i < W * W; i++) { const sa = S[i * 4 + 3] / 255 * 0.5; for (let ch = 0; ch < 3; ch++) want[i * 4 + ch] = Math.round(S[i * 4 + ch] * 0.5 + 255 * (1 - sa)); want[i * 4 + 3] = 255; }
  return { got: b64(got), want: b64(want) };
};
// Sprites: a sheet of three sprites (two overlapping rects / one rect / a fill+stroke); the subset's own leaves decide the group.
window.__sprite = async (svg, id, eng, instanced) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const T = (tx, ty, s) => new Float32Array([s, 0, 0, 0, s, 0, tx, ty, 1]);
  const draw = (alpha) => {
    if (instanced) R.drawSpriteInstanced(b, id, [{ worldMatrix: T(-0.4, 0, 0.8), alpha }, { worldMatrix: T(0.4, 0, 0.8), alpha: alpha === 1 ? 1 : alpha / 2 }]);
    else R.drawSprite(b, id, { alpha });
  };
  const got = await frame(b, () => draw(0.5), [1, 1, 1, 1], eng);
  const S = await frame(b, () => draw(1), [0, 0, 0, 0], eng);
  const want = new Uint8Array(W * W * 4);
  // (a hand fade is exact for ONE draw; the instanced pair has per-instance alphas, so its oracle draws each instance alone)
  if (!instanced) {
    for (let i = 0; i < W * W; i++) { const sa = S[i * 4 + 3] / 255 * 0.5; for (let ch = 0; ch < 3; ch++) want[i * 4 + ch] = Math.round(S[i * 4 + ch] * 0.5 + 255 * (1 - sa)); want[i * 4 + 3] = 255; }
  } else {
    want.fill(255);
    for (const [k, al] of [[0, 0.5], [1, 0.25]]) {
      const Sk = await frame(b, () => R.drawSpriteInstanced(b, id, [{ worldMatrix: T(k ? 0.4 : -0.4, 0, 0.8) }]), [0, 0, 0, 0], eng);
      for (let i = 0; i < W * W; i++) { const sa = Sk[i * 4 + 3] / 255 * al; for (let ch = 0; ch < 3; ch++) want[i * 4 + ch] = Math.round(Sk[i * 4 + ch] * al + want[i * 4 + ch] * (1 - sa)); }
    }
  }
  b.dispose && b.dispose();
  return { got: b64(got), want: b64(want) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300));
});
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = (Math.floor(y * 2) * 128 + Math.floor(x * 2)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (p, q) => {
  let m = 0;
  for (let i = 0; i < p.length; i++) m = Math.max(m, Math.abs(p[i] - q[i]));
  return m;
};
const u8 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const decode = (r) => {
  for (const x of Array.isArray(r) ? r : [r]) for (const k of ['got', 'want']) x[k] = u8(x[k]);
  return r;
};
// The Chrome reference depends on the document alone, so each control is rasterized once for all engines.
const chromeRefs = new Map();
const chrome8 = async (svg) => {
  if (!chromeRefs.has(svg))
    chromeRefs.set(svg, u8(await page.evaluate((s) => window.__chrome8(s), svg)));
  return chromeRefs.get(svg);
};
const meanDiff = (p, q) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]);
  return s / p.length;
};

const ENGINES = process.env.GA_ENGINES
  ? process.env.GA_ENGINES.split(',')
  : ['auto', 'slug', 'aac', 'lb'];
for (const eng of ENGINES) {
  console.log(`\n-- engine ${eng}`);
  for (const c of CELLS) {
    let svgPx, ctlPx, oldPx, chrome;
    try {
      svgPx = u8(
        await page.evaluate((s, o, e) => window.__render(s, o, e), c.svg, { alpha: c.alpha }, eng),
      );
      ctlPx = u8(await page.evaluate((s, o, e) => window.__render(s, o, e), c.control, null, eng));
      oldPx = u8(await page.evaluate((s, o, e) => window.__render(s, o, e), c.old, null, eng));
      chrome = await chrome8(c.control);
    } catch (e) {
      fail(`${c.name} [${eng}]: ${e.message}`);
      continue;
    }
    const tol = c.tol || 2;
    const vsControl = maxDiff(svgPx, ctlPx),
      vsOld = maxDiff(svgPx, oldPx),
      vsChromeMean = meanDiff(svgPx, chrome),
      vsChromeMax = maxDiff(svgPx, chrome);
    const bad = c.probes.filter(([x, y, want, t]) => maxDiff(at(svgPx, x, y), want) > t);
    const tag = `${c.name} [${eng}]`;
    const note = `vs control ${vsControl}, vs old ${vsOld}, vs Chrome 8x box mean ${vsChromeMean.toFixed(2)} max ${vsChromeMax}`;
    if (vsControl > tol)
      fail(`${tag}: differs from the <g opacity> control by ${vsControl} (tol ${tol}) -- ${note}`);
    else if (bad.length)
      fail(
        `${tag}: probe(s) off: ${bad.map(([x, y, w]) => `(${x},${y}) got ${at(svgPx, x, y)} want ${w.map(Math.round)}`).join('; ')}`,
      );
    else if (c.oneLeaf ? vsOld > 1 : vsOld < (c.minOld || 24))
      fail(
        `${tag}: ${c.oneLeaf ? 'one leaf must equal the per-leaf draw (vs old ' + vsOld + ')' : 'must differ from the per-leaf multiply by >= ' + (c.minOld || 24) + ' (got ' + vsOld + ')'} -- ${note}`,
      );
    else if (vsChromeMean > 1.5)
      fail(
        `${tag}: mean ${vsChromeMean.toFixed(2)} from Chrome's 8x box-averaged answer -- ${note}`,
      );
    else ok(`${tag} -- ${note}`);
  }
}

// Entry points (one engine each: the fade is the same code for every route).
const SH = bare(
  '<rect x="4" y="4" width="40" height="40" fill="#0cf"/><rect x="20" y="20" width="40" height="40" fill="#f0c"/>',
);
const SHFAR = bare(
  '<rect x="2" y="2" width="14" height="14" fill="#0cf"/><rect x="40" y="40" width="20" height="20" fill="#f0c"/><rect x="2" y="44" width="14" height="14" fill="#fc0"/>',
);
for (const kind of [
  'loop',
  'instanced',
  'instbatch',
  'instoverlap',
  'inst1px',
  'instmixed',
  'instlayers',
  'instgrid',
  'instdirect',
  'submit',
  'handle',
  'cache',
  'dstrect',
]) {
  for (const eng of kind.startsWith('inst') ? ['auto', 'slug', 'lb'] : ['auto', 'slug']) {
    let r;
    try {
      r = decode(
        await page.evaluate(
          (k, s, e) => window.__entry(k, s, null, e),
          kind === 'instdirect' ? 'instmixed' : kind,
          kind === 'instdirect' ? SHFAR : SH,
          eng,
        ),
      );
    } catch (e) {
      fail(`entry ${kind} [${eng}]: ${e.message}`);
      continue;
    }
    const d = maxDiff(r.got, r.want);
    (d <= 3 ? ok : fail)(
      `entry ${kind} [${eng}]: four placements at their alphas equal a hand fade of each alpha-1 picture (max ${d})`,
    );
    if (kind === 'instbatch' && eng === 'slug')
      (r.fastDraws > 0 ? ok : fail)(
        `entry instbatch [slug]: the disjoint faded instances were drawn by the instanced fast path (${r.fastDraws} fast draws over the faded run)`,
      );
    if (['inst1px', 'instlayers', 'instgrid', 'instdirect'].includes(kind) && eng === 'slug')
      (r.fastDraws > 0 ? ok : fail)(
        `entry ${kind} [slug]: drawn by the instanced fast path, layered or direct (${r.fastDraws} fast draws)`,
      );
    if (kind === 'instoverlap' && eng === 'slug')
      (r.fastDraws === 0 ? ok : fail)(
        `entry instoverlap [slug]: the overlapping faded instances left the fast path for the per-instance loop (${r.fastDraws} fast draws)`,
      );
  }
}
for (const eng of ['auto', 'slug']) {
  let r;
  try {
    r = decode(await page.evaluate((s, e) => window.__cacheFade(s, e), SH, eng));
  } catch (e) {
    fail(`cached mount fade [${eng}]: ${e.message}`);
    continue;
  }
  const ds = r.map((x) => maxDiff(x.got, x.want));
  (Math.max(...ds) <= 3 ? ok : fail)(
    `cached mount (ForceWholeAsset) drawn at alphas ${r.map((x) => x.al).join(' ')} [${eng}]: each frame equals a hand fade of the alpha-1 picture (max per frame ${ds})`,
  );
}
{
  const MA = bare(
    '<rect x="4" y="4" width="30" height="30" fill="#0cf"/><rect x="14" y="14" width="30" height="30" fill="#f0c"/>',
  );
  const MB = bare(
    '<rect x="20" y="20" width="30" height="30" fill="#0cf"/><rect x="30" y="30" width="30" height="30" fill="#f0c"/>',
  );
  for (const eng of ['auto', 'slug', 'lb', 'aac']) {
    let r;
    try {
      r = decode(await page.evaluate((a, b, e) => window.__morph(a, b, e), MA, MB, eng));
    } catch (e) {
      fail(`morph [${eng}]: ${e.message}`);
      continue;
    }
    const d = maxDiff(r.got, r.want);
    (d <= 3 ? ok : fail)(
      `morph drawBundle(alpha .5) [${eng}]: equals a hand fade of the alpha-1 morph (max ${d})`,
    );
  }
}

{
  const SHEET = bare(
    '<g id="s0"><rect x="4" y="4" width="26" height="40" fill="#0cf"/><rect x="14" y="20" width="26" height="40" fill="#f0c"/></g>' +
      '<g id="s1"><rect x="40" y="4" width="20" height="20" fill="#0a0"/></g>' +
      '<g id="s2"><rect x="38" y="30" width="16" height="16" fill="#0cf" stroke="#f0c" stroke-width="10"/></g>',
  );
  for (const eng of ['auto', 'slug', 'lb']) {
    for (const [id, inst] of [
      ['s0', false],
      ['s1', false],
      ['s2', false],
      ['s0', true],
    ]) {
      let r;
      try {
        r = decode(
          await page.evaluate((s, i, e, n) => window.__sprite(s, i, e, n), SHEET, id, eng, inst),
        );
      } catch (e) {
        fail(`sprite ${id}${inst ? ' instanced' : ''} [${eng}]: ${e.message}`);
        continue;
      }
      const d = maxDiff(r.got, r.want);
      (d <= 3 ? ok : fail)(
        `drawSprite${inst ? 'Instanced' : ''}(${id}, alpha) [${eng}]: equals a hand fade of the sprite's alpha-1 picture (max ${d})`,
      );
    }
  }
}

await browser.close();
server.close();
console.log(failures ? `\nFAIL (${failures})` : '\nPASS');
process.exit(failures ? 1 : 0);
