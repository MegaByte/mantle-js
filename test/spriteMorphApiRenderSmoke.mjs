// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteMorphApiRenderSmoke -- the sprite / nine-slice / morph / streaming / override-table API behaviors that show in
// PIXELS, on the GPU. The CPU proofs are test/spriteMorphApiSmoke.mjs.
//
// Each cell renders through the PRODUCTION API (`fix`), then draws the same picture a LITERAL way (`control`: the art authored directly at
// the target size / pose / state, with simpler features), at 128 px on a white ground:
//   fix      must match control to within `tol` (default 2/255);
//   old      (optional) the WRONG reading, authored literally: it must DIFFER from fix by at least 48/255 somewhere, so a pass cannot
//            be a picture the wrong reading also draws;
//   probes   analytic expectations: a stated point reads a stated color, independent of both pictures.
// Cells with no literal `old` rest on their probes for non-vacuity.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHITE = [255, 255, 255],
  RED = [200, 30, 30],
  BLUE = [30, 30, 200],
  GREEN = [30, 200, 30];

// Scenario source (runs in the page). `S.name(T)` returns the pixels of one picture; T is the toolbox the page builds below.
const SCENARIOS = String.raw`
const rectDoc = (x, y, w, h, f, extra = '') => T.doc('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + f + '" ' + extra + '/>');
const M3 = (tx) => new Float32Array([1, 0, 0, 0, 1, 0, tx, 0, 1]);
const lit = async (x, y, f) => T.bun(rectDoc(x, y, 30, 30, f));
const blank = async () => T.frame(() => {});
const S = {

  endpoint_overlap: async (cpu) => {
    const a = await T.bun(T.doc('<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/>'));
    const ad = await T.bun(T.doc('<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/><rect id="D" x="0" y="0" width="80" height="80" fill="red"/>'));
    const first = T.M.createShapeMorph(T.gl, a, ad, { cpuLerp: cpu });
    const chain = T.M.createShapeMorph(T.gl, first.bundle, first.bundle, { cpuLerp: cpu });
    try {
      const deadline = Date.now() + 60000;
      while (chain.bundle._morphCullPending) {
        if (Date.now() > deadline) throw Error('Morph cull incomplete');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return await T.frame(() => T.R.drawBundle(chain.bundle));
    } finally { chain.dispose(); first.dispose(); ad.dispose(); a.dispose(); }
  },
  endpoint_chain: async (cpu, kind, t) => {
    const a = await T.bun(T.doc('<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/>'));
    const ad = await T.bun(T.doc('<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/><rect id="D" x="50" y="50" width="20" height="20" fill="red"/>'));
    const first = T.M.createShapeMorph(T.gl, a, ad, { cpuLerp: cpu });
    const m = T.M.createShapeMorph(T.gl, kind === 'destination' ? ad : first.bundle, kind === 'source' ? ad : first.bundle, { cpuLerp: cpu });
    try { m.setT(t); return await T.frame(() => T.R.drawBundle(m.bundle)); }
    finally { m.dispose(); first.dispose(); ad.dispose(); a.dispose(); }
  },
  endpoint_literal: async (opacity) => {
    const b = await T.bun(T.doc('<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/><rect id="D" x="50" y="50" width="20" height="20" fill="red" opacity="' + opacity + '"/>'));
    try { return await T.frame(() => T.R.drawBundle(b)); } finally { b.dispose(); }
  },

  // one options object reused for two submits
  sm2_reused: async () => {
    const b = await T.bun(T.doc('<rect x="35" y="35" width="30" height="30" fill="#c81e1e"/><rect x="0" y="0" width="1" height="1" fill="#fff"/><rect x="99" y="99" width="1" height="1" fill="#fff"/>'));
    const o = {};
    return T.frame(() => { o.worldMatrix = M3(-0.6); T.R.submitBundle(b, o); o.worldMatrix = M3(0.6); T.R.submitBundle(b, o); });
  },
  sm2_fresh: async () => {
    const b = await T.bun(T.doc('<rect x="35" y="35" width="30" height="30" fill="#c81e1e"/><rect x="0" y="0" width="1" height="1" fill="#fff"/><rect x="99" y="99" width="1" height="1" fill="#fff"/>'));
    return T.frame(() => { T.R.submitBundle(b, { worldMatrix: M3(-0.6) }); T.R.submitBundle(b, { worldMatrix: M3(0.6) }); });
  },
  sm2_last: async () => {
    const b = await T.bun(T.doc('<rect x="35" y="35" width="30" height="30" fill="#c81e1e"/><rect x="0" y="0" width="1" height="1" fill="#fff"/><rect x="99" y="99" width="1" height="1" fill="#fff"/>'));
    return T.frame(() => { T.R.drawBundle(b, { worldMatrix: M3(0.6) }); T.R.drawBundle(b, { worldMatrix: M3(0.6) }); });
  },
  // always on top / underneath
  sm12_top: async () => { const r = await lit(20, 20, '#c81e1e'), b = await lit(40, 40, '#1e1ec8');
    return T.frame(() => { T.R.submitBundle(r, { zOrder: Infinity }); T.R.submitBundle(b, { zOrder: 100 }); }); },
  sm12_top_ctl: async () => { const r = await lit(20, 20, '#c81e1e'), b = await lit(40, 40, '#1e1ec8');
    return T.frame(() => { T.R.drawBundle(b); T.R.drawBundle(r); }); },
  sm12_top_old: async () => { const r = await lit(20, 20, '#c81e1e'), b = await lit(40, 40, '#1e1ec8');
    return T.frame(() => { T.R.drawBundle(r); T.R.drawBundle(b); }); },
  sm12_bottom: async () => { const r = await lit(20, 20, '#c81e1e'), b = await lit(40, 40, '#1e1ec8');
    return T.frame(() => { T.R.submitBundle(r, { zOrder: -Infinity }); T.R.submitBundle(b, { zOrder: -5 }); }); },
  sm12_bottom_ctl: async () => { const r = await lit(20, 20, '#c81e1e'), b = await lit(40, 40, '#1e1ec8');
    return T.frame(() => { T.R.drawBundle(r); T.R.drawBundle(b); }); },
  sm12_bottom_old: async () => { const r = await lit(20, 20, '#c81e1e'), b = await lit(40, 40, '#1e1ec8');
    return T.frame(() => { T.R.drawBundle(b); T.R.drawBundle(r); }); },
  // a repeated top-level sprite id
  sm3_dup: async () => { const b = await T.bun(T.doc('<g id="a"><rect x="0" y="0" width="30" height="30" fill="#c81e1e"/></g><g id="b"><rect x="40" y="40" width="30" height="30" fill="#1ec81e"/></g><g id="a"><rect x="70" y="70" width="25" height="25" fill="#c81e1e"/></g>'));
    return T.frame(() => T.R.drawSprite(b, 'a')); },
  sm3_unique: async () => { const b = await T.bun(T.doc('<g id="a"><rect x="0" y="0" width="30" height="30" fill="#c81e1e"/></g><g id="b"><rect x="40" y="40" width="30" height="30" fill="#1ec81e"/></g><g id="c"><rect x="70" y="70" width="25" height="25" fill="#c81e1e"/></g>'));
    return T.frame(() => T.R.drawSprite(b, 'a')); },
  sm3_old: async () => { const b = await T.bun(T.doc('<g id="a"><rect x="0" y="0" width="30" height="30" fill="#c81e1e"/></g><g id="b"><rect x="40" y="40" width="30" height="30" fill="#1ec81e"/></g><g id="c"><rect x="70" y="70" width="25" height="25" fill="#c81e1e"/></g>'));
    return T.frame(() => T.R.drawBundle(b)); },
  // a morph chained from a morph's bundle
  sm4_chain: async (cpu, t) => {
    const A = await lit(10, 10, '#c81e1e'), B = await lit(60, 60, '#1e1ec8'), C = await lit(10, 60, '#1ec81e');
    const m = T.M.createShapeMorph(T.gl, A, B, { cpuLerp: cpu }); m.setT(0.5);
    const c = T.M.createShapeMorph(T.gl, m.bundle, C, { cpuLerp: cpu }); c.setT(t);
    return T.frame(() => T.R.drawBundle(c.bundle));
  },
  sm4_pose: async () => { const b = await lit(35, 35, '#731e73'); return T.frame(() => T.R.drawBundle(b)); },
  sm4_half: async () => { const b = await lit(22.5, 47.5, '#497349'); return T.frame(() => T.R.drawBundle(b)); },
  sm4_A: async () => { const b = await lit(10, 10, '#c81e1e'); return T.frame(() => T.R.drawBundle(b)); },
  // streaming input
  stream: async (kind) => {
    const M = T.M, line = (p) => p.map((q, i) => M.mkLine(q, p[(i + 1) % p.length]));
    const sh = (ps) => ps.map((p, i) => ({ segs: line(p), fill: i ? [.1, .1, .8, 1] : [.8, .1, .1, 1] }));
    const sq0 = [[10, 10], [40, 10], [40, 40], [10, 40]], sq1 = [[60, 60], [90, 60], [90, 90], [60, 90]];
    const mk = () => M.createBundle(T.gl, M.buildStreamableSections(sh([sq0, [[60, 10], [90, 10], [90, 40], [60, 40]]]), [0, 0, 100, 100], { lightweight: true }));
    const live = mk();
    M.updateBundleGeometry(T.gl, live, [sq0, sq1].map(line), { lightweight: true });   // the picture on screen before the update under test
    live.globalBBox = [0, 0, 100, 100];
    await T.frame(() => T.R.drawBundle(live));
    let segs;
    if (kind === 'nan') segs = [[[10, 10], [NaN, 10], [40, 40], [10, 40]], sq1].map(line);
    else if (kind === 'zero') segs = [[[10, 10], [40, 10], [40, 10], [10, 10]], sq1].map(line);
    else if (kind === 'empty') segs = [[], sq1].map(line);
    else segs = [sq0, sq1].map(line);
    M.updateBundleGeometry(T.gl, live, segs, { lightweight: true });
    live.globalBBox = [0, 0, 100, 100];
    return T.frame(() => T.R.drawBundle(live), false);
  },
  // override values
  ovr: async (o, withStroke) => {
    const b = await T.bun(T.doc('<rect id="a" x="25" y="25" width="50" height="50" fill="#c81e1e" ' + (withStroke ? 'stroke="#1e1ec8" stroke-width="10"' : '') + '/>'));
    const t = T.M.createOverrideTable(T.gl, b);
    // a stroked rect is two meta rows: the fill ('a') and the stroke ('a_stroke'); a width override addresses the stroke row
    if (o) t.set(withStroke ? b.shapeIds.indexOf('a_stroke') : 0, o);
    return T.frame(() => T.R.drawBundle(b, { overrides: t }));
  },
  lit_rect: async (f, withStroke) => { const b = await T.bun(T.doc('<rect x="25" y="25" width="50" height="50" fill="' + f + '" ' + (withStroke ? 'stroke="#1e1ec8" stroke-width="10"' : '') + '/>')); return T.frame(() => T.R.drawBundle(b)); },
  // the first draw after an override change, with the occlusion cull active
  sm9: async () => {
    const mk = () => T.bun(T.doc('<rect id="u" x="40" y="40" width="20" height="20" fill="#1e1ec8"/><rect id="o" x="10" y="10" width="80" height="80" fill="#c81e1e"/>'));
    const b = await mk(); const t = T.M.createOverrideTable(T.gl, b);
    const draw = () => T.R.drawBundle(b, { overrides: t });
    await T.frame(draw); await T.frame(draw, false);
    t.set(1, { visibility: 0 });
    return T.frame(draw, false);
  },
  sm9_ctl: async () => {
    const b = await T.bun(T.doc('<rect id="u" x="40" y="40" width="20" height="20" fill="#1e1ec8"/><rect id="o" x="10" y="10" width="80" height="80" fill="#c81e1e"/>'));
    const t = T.M.createOverrideTable(T.gl, b); t.set(1, { visibility: 0 });
    return T.frame(() => T.R.drawBundle(b, { overrides: t }));
  },
  // nine-slice
  nine_art: '<rect x="0" y="0" width="100" height="100" rx="20" fill="#c81e1e"/><circle cx="50" cy="50" r="10" fill="#1e1ec8"/>',
  nine_lit: async () => { const b = await T.bun(T.doc('<rect x="0" y="0" width="160" height="100" rx="20" fill="#c81e1e"/><ellipse cx="80" cy="50" rx="22" ry="10" fill="#1e1ec8"/>', '0 0 160 100')); return T.frame(() => T.R.drawBundle(b)); },
  nine_lit_noblue: async () => { const b = await T.bun(T.doc('<rect x="0" y="0" width="160" height="100" rx="20" fill="#c81e1e"/>', '0 0 160 100')); return T.frame(() => T.R.drawBundle(b)); },
  nine_prepare_inst: async () => { const b = await T.bun(T.doc(S.nine_art)); const i = b.nineSliceInstance({ border: [25, 25, 25, 25], worldSize: [160, 100] }); T.R.prepareBundle(i); return T.frame(() => T.R.drawBundle(i)); },
  nine_prepare_then_apply: async () => { const b = await T.bun(T.doc(S.nine_art)); T.R.prepareBundle(b); await T.frame(() => T.R.drawBundle(b)); b.applyNineSlice({ border: [25, 25, 25, 25], worldSize: [160, 100] }); return T.frame(() => T.R.drawBundle(b), false); },
  nine_apply_then_prepare: async () => { const b = await T.bun(T.doc(S.nine_art)); b.applyNineSlice({ border: [25, 25, 25, 25], worldSize: [160, 100] }); T.R.prepareBundle(b); return T.frame(() => T.R.drawBundle(b)); },
  nine_invalid: async () => { const b = await T.bun(T.doc('<rect x="0" y="0" width="100" height="100" fill="#c81e1e"/>'));
    const bad = [{ border: [25, 25, 25, 25], worldSize: [200, 100], nativeBBox: [100, 100, 0, 0] }, { border: [-30, 25, 25, 25], worldSize: [200, 100] }, { border: [25, 25, 25, 25], worldSize: [Infinity, 100] }];
    let threw = 0; for (const o of bad) { try { b.applyNineSlice(o); } catch { threw++; } }
    if (threw !== bad.length) throw Error('invalid options did not throw (' + threw + ' of ' + bad.length + ')');
    return T.frame(() => T.R.drawBundle(b)); },
  nine_native: async () => { const b = await T.bun(T.doc('<rect x="0" y="0" width="100" height="100" fill="#c81e1e"/>')); return T.frame(() => T.R.drawBundle(b)); },
  // hit tests agree with the drawn pixels of a sliced bundle
  nine_hit: async () => {
    const b = await T.bun(T.doc('<rect x="0" y="0" width="25" height="100" fill="#c81e1e"/><rect x="45" y="0" width="10" height="100" fill="#1e1ec8"/><rect x="75" y="0" width="25" height="100" fill="#c81e1e"/>'));
    const inst = b.nineSliceInstance({ border: [25, 25, 25, 25], worldSize: [200, 100] });
    const px = await T.frame(() => T.R.drawBundle(inst));
    const bad = []; let hits = 0, ink = 0;
    for (let ex = 4; ex < 200; ex += 8) for (const ey of [20, 50, 80]) {
      const c = T.at(px, Math.floor(ex * 0.64), 32 + Math.floor(ey * 0.64));
      const drawn = c[0] < 235 || c[1] < 235 || c[2] < 235;
      const hit = T.M.fillHitShape(inst, ex, ey) >= 0;
      if (hit) hits++; if (drawn) ink++;
      if (hit !== drawn) bad.push(ex + ',' + ey);
    }
    return { bad, hits, ink };
  },
  // group opacity in a morph
  gop: (o) => '<g id="g" opacity="' + o + '"><rect id="a" x="10" y="10" width="50" height="50" fill="#c81e1e"/><rect id="b" x="40" y="40" width="50" height="50" fill="#1e1ec8"/></g>',
  sm13_morph: async (from, to, t) => { const A = await T.bun(T.doc(S.gop(from))), B = await T.bun(T.doc(S.gop(to))); const m = T.M.createShapeMorph(T.gl, A, B); m.setT(t); return T.frame(() => T.R.drawBundle(m.bundle)); },
  sm13_lit: async (o) => { const b = await T.bun(T.doc(S.gop(o))); return T.frame(() => T.R.drawBundle(b)); },
};
`;

const CELLS = [
  {
    name: 'Chained source initial hidden row',
    fix: ['endpoint_chain', true, 'source', 0],
    control: ['endpoint_literal', 0],
    tol: 2,
  },
  {
    name: 'Chained source half fade',
    fix: ['endpoint_chain', true, 'source', 0.5],
    control: ['endpoint_literal', 0.5],
    tol: 2,
  },
  {
    name: 'Chained destination hidden endpoint',
    fix: ['endpoint_chain', true, 'destination', 1],
    control: ['endpoint_literal', 0],
    tol: 2,
  },
  {
    name: 'Chained constant hidden row after setT',
    fix: ['endpoint_chain', true, 'both', 0.5],
    control: ['endpoint_literal', 0],
    tol: 2,
  },
  {
    name: 'Chained hidden occluder after worker completion',
    fix: ['endpoint_overlap', false],
    control: ['endpoint_literal', 0],
    tol: 2,
  },
  {
    name: 'Chained half fade with automatic interpolation',
    fix: ['endpoint_chain', false, 'source', 0.5],
    control: ['endpoint_literal', 0.5],
    tol: 2,
  },

  {
    name: 'one reused options object, two submits',
    fix: ['sm2_reused'],
    control: ['sm2_fresh'],
    old: ['sm2_last'],
    probes: [
      [30, 64, RED],
      [98, 64, RED],
      [64, 64, WHITE],
    ],
  },
  {
    name: 'zOrder Infinity paints on top of 100',
    fix: ['sm12_top'],
    control: ['sm12_top_ctl'],
    old: ['sm12_top_old'],
    probes: [[58, 58, RED]],
  },
  {
    name: 'zOrder -Infinity paints under -5',
    fix: ['sm12_bottom'],
    control: ['sm12_bottom_ctl'],
    old: ['sm12_bottom_old'],
    probes: [[58, 58, BLUE]],
  },
  {
    name: 'a repeated sprite id draws the first element only',
    fix: ['sm3_dup'],
    control: ['sm3_unique'],
    old: ['sm3_old'],
  },
  {
    name: 'chain from a morph at t=.5, t=0 (GPU lerp)',
    fix: ['sm4_chain', false, 0],
    control: ['sm4_pose'],
    old: ['sm4_A'],
    tol: 3,
  },
  {
    name: 'chain from a morph at t=.5, t=0 (CPU lerp)',
    fix: ['sm4_chain', true, 0],
    control: ['sm4_pose'],
    old: ['sm4_A'],
    tol: 3,
  },
  {
    name: 'chain half way (GPU lerp)',
    fix: ['sm4_chain', false, 0.5],
    control: ['sm4_half'],
    tol: 4,
  },
  {
    name: 'chain half way (CPU lerp)',
    fix: ['sm4_chain', true, 0.5],
    control: ['sm4_half'],
    tol: 4,
  },
  {
    name: 'a NaN vertex is refused: the previous picture stays',
    fix: ['stream', 'nan'],
    control: ['stream', 'good'],
  },
  {
    name: 'a zero-area polygon in a lightweight stream draws nothing',
    fix: ['stream', 'zero'],
    control: ['stream', 'empty'],
  },
  {
    name: 'a short fill [0,1,0] is opaque green',
    fix: ['ovr', { fill: [0, 1, 0] }, false],
    control: ['lit_rect', '#00ff00', false],
    tol: 2,
    probes: [[64, 64, [0, 255, 0]]],
  },
  {
    name: 'a NaN fill component takes its default',
    fix: ['ovr', { fill: [NaN, 1, 0, 1] }, false],
    control: ['lit_rect', '#00ff00', false],
    tol: 2,
  },
  {
    name: 'strokeWidth Infinity sets no width override',
    fix: ['ovr', { strokeWidth: Infinity }, true],
    control: ['ovr', null, true],
  },
  {
    name: 'strokeWidth NaN sets no width override',
    fix: ['ovr', { strokeWidth: NaN }, true],
    control: ['ovr', null, true],
  },
  {
    name: 'a negative strokeWidth is 0',
    fix: ['ovr', { strokeWidth: -5 }, true],
    control: ['lit_rect', '#c81e1e', false],
  },
  {
    name: 'the first draw after an override change shows the exposed shape',
    fix: ['sm9'],
    control: ['sm9_ctl'],
    old: ['nothing'],
    probes: [[64, 64, BLUE]],
  },
  {
    name: 'prepareBundle on a nine-slice instance',
    fix: ['nine_prepare_inst'],
    control: ['nine_lit'],
    old: ['nine_lit_noblue'],
    tol: 40,
    probes: [[64, 64, BLUE]],
  },
  {
    name: 'a prepared bundle sliced in place',
    fix: ['nine_prepare_then_apply'],
    control: ['nine_lit'],
    old: ['nine_lit_noblue'],
    tol: 40,
    probes: [[64, 64, BLUE]],
  },
  {
    name: 'a sliced bundle, then prepared',
    fix: ['nine_apply_then_prepare'],
    control: ['nine_lit'],
    old: ['nine_lit_noblue'],
    tol: 40,
    probes: [[64, 64, BLUE]],
  },
  {
    name: 'invalid nine-slice options leave the native picture',
    fix: ['nine_invalid'],
    control: ['nine_native'],
    old: ['nothing'],
    probes: [[58, 58, RED]],
  },
  {
    name: 'group opacity .8 -> .2 interpolates when both poses have the group',
    fix: ['sm13_morph', 0.8, 0.2, 0.5],
    control: ['sm13_lit', 0.5],
    old: ['sm13_lit', 0.8],
    tol: 3,
  },
  {
    name: 'a pose without the group is a group of opacity 1: 1 -> .2 ends at .2',
    fix: ['sm13_morph', 1, 0.2, 1],
    control: ['sm13_lit', 0.2],
    old: ['sm13_lit', 1],
    tol: 3,
  },
  {
    name: '... and is half way at t = .5 (opacity .6)',
    fix: ['sm13_morph', 1, 0.2, 0.5],
    control: ['sm13_lit', 0.6],
    old: ['sm13_lit', 1],
    tol: 3,
  },
  {
    name: '.2 -> 1 is at .8 at t = .75',
    fix: ['sm13_morph', 0.2, 1, 0.75],
    control: ['sm13_lit', 0.8],
    old: ['sm13_lit', 0.2],
    tol: 3,
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import * as M from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
const R = M.createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const doc = (b, vb = '0 0 100 100') => '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="' + vb + '">' + b + '</svg>';
const bun = async (s, o) => M.createBundle(gl, await M.importSvg(s, Object.assign({ preserveViewport: true }, o || {})));
const SIZE = 128;
const frame = async (fn, warm = true) => {
  R.setViewport(SIZE, SIZE);
  const f = () => { R.beginFrame([1, 1, 1, 1]); fn(); R.endFrame(); };
  if (warm) { const w = await R.warmScene([{ draw: f }], { maxPasses: 16, fenceTimeoutMs: 60000 }); if (!w.complete) throw Error('warm incomplete'); }
  f();
  const p = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, p); return Array.from(p);
};
const at = (p, x, y) => { const i = ((SIZE - 1 - y) * SIZE + x) * 4; return [p[i], p[i + 1], p[i + 2]]; };
const T = { M, gl, R, doc, bun, frame, at };
${SCENARIOS.replace('const S = {', 'const S = window.S = {')}
S.nothing = async () => frame(() => {});
window.__run = (id, args) => S[id](...args);
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
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = ((127 - y) * 128 + x) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const inkOf = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235) n++;
  return n;
};
const run = (spec) => page.evaluate((id, args) => window.__run(id, args), spec[0], spec.slice(1));
for (const c of CELLS) {
  let a,
    b,
    o = null;
  try {
    a = await run(c.fix);
    b = await run(c.control);
    if (c.old) o = await run(c.old);
  } catch (e) {
    fail(c.name + ': ' + (e.message || e).toString().slice(0, 300));
    continue;
  }
  const vsControl = maxDiff(a, b),
    vsOld = o ? maxDiff(a, o) : null;
  const bad = (c.probes || [])
    .filter(([x, y, want]) => maxDiff(at(a, x, y), want) > 40)
    .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
  const line =
    `${c.name}: control maxByte ${vsControl}` +
    (o ? `, old differs by ${vsOld}` : '') +
    `, ink px fix ${inkOf(a)} / control ${inkOf(b)}`;
  if (vsControl > (c.tol ?? 2)) fail(line + ' -- render differs from its control');
  else if (o && vsOld < 48) fail(line + " -- vacuous: the wrong reading's picture is the same");
  else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
  else ok(line);
}
{
  // the hit answers and the drawn pixels agree on a grid over a sliced bundle (the middle blue strip is stretched 3x).
  try {
    const r = await page.evaluate(() => window.S.nine_hit());
    if (r.bad.length)
      fail(
        `hit tests vs pixels of a nine-sliced bundle disagree at em ${r.bad.slice(0, 8).join(' ')} (${r.bad.length} of the grid; ${r.hits} hit, ${r.ink} drawn)`,
      );
    else if (r.hits < 20 || r.ink < 20)
      fail(`vacuous: only ${r.hits} hits / ${r.ink} drawn grid points`);
    else
      ok(
        `hit tests agree with the drawn pixels at every grid point (${r.hits} hit, ${r.ink} drawn)`,
      );
  } catch (e) {
    fail('' + e.message);
  }
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nspriteMorphApiRenderSmoke: the sprite / nine-slice / morph / streaming / override API fixes render as their controls on the GPU',
);
