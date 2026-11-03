// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// variantFirstDefaultSmoke -- `variantFirst` is the DEFAULT, so the first frame of every engine/route class draws with the bundle's
// LEAN fill program and must be the same picture the base-program-first path (`variantFirst: false`) settles on.
//
// A cold GPU shader cache makes the general (base) fill program's first draw cost 13-50 s, so a renderer draws a fill bundle (and an
// instanced bundle) with its own lean program from frame 1 instead of the base. That is only allowed to change WHEN a program is
// compiled, never the picture. For each class below this renders the same steps in four arms, every arm a fresh context and renderer:
//   D   the default (variantFirst unset), pipelines never warm: every frame is a first-frame, lean-first draw;
//   D2  the same again -- the A/A CONTROL: the noise of two identical fresh renderers (a diff of D against anything is judged against it);
//   B   variantFirst: false, pipelines never warm: the base program draws (the base-first first frame);
//   S   variantFirst: false, warmed to its settled program (what the picture becomes after warm-up);
//   DS  the default, warmed: the lean -> settled transition must not move a pixel.
// MANTLE_SMOKE_SRC_ROOT=<a checkout> runs the same arms against another tree (where the default is the base-first path, the
// "first frame draws lean" claim fails).
// Steps carry the transitions a lean program must survive: a feature that appears AFTER the first frame (recolor, an external clip, group
// opacity, a transform override, a stroke override, a mask or clip bundle appearing later), a morph moving t, and a streamed update.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = process.env.MANTLE_SMOKE_SRC_ROOT
  ? path.resolve(process.env.MANTLE_SMOKE_SRC_ROOT)
  : ROOT;
const N = 128;

const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy} C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const quadRing = (cx, cy, r, n) => {
  const P = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = `M${P[0][0].toFixed(3)} ${P[0][1].toFixed(3)}`;
  for (let i = 0; i < n; i++) {
    const p = P[i],
      q = P[(i + 1) % n],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    d += ` Q${(cx + (mx - cx) * 1.18).toFixed(3)} ${(cy + (my - cy) * 1.18).toFixed(3)} ${q[0].toFixed(3)} ${q[1].toFixed(3)}`;
  }
  return d + ' Z';
};
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs>${defs}</defs>${body}</svg>`;
const P = blob(50, 50, 30);
const GRAD =
  '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="50" x2="80" y2="50"><stop offset="0" stop-color="#e22"/><stop offset="1" stop-color="#22e"/></linearGradient>';
const S = {
  solid: svg(
    `<path d="${P}" fill="#48c"/><path d="${blob(30, 70, 14)}" fill="#c84" fill-opacity=".7"/>`,
  ),
  mix: svg(
    `<circle cx="30" cy="50" r="22" fill="#222"/><path d="${quadRing(72, 50, 22, 14)}" fill="#222"/>`,
  ),
  stroked: svg(`<path d="${P}" fill="#48c" stroke="#112" stroke-width="4"/>`),
  strokeOnly: svg(`<path d="${P}" fill="none" stroke="#112" stroke-width="3"/>`),
  dashed: svg(`<path d="${P}" fill="none" stroke="#112" stroke-width="3" stroke-dasharray="6 4"/>`),
  gradient: svg(`<path d="${P}" fill="url(#g)"/>`, GRAD),
  mask: svg(
    `<g mask="url(#m)"><path d="${P}" fill="#4a8"/></g>`,
    '<mask id="m"><circle cx="50" cy="50" r="24" fill="#fff"/></mask>',
  ),
  clip: svg(
    `<path d="${P}" fill="#a48" clip-path="url(#c)"/>`,
    '<clipPath id="c"><rect x="25" y="25" width="50" height="50"/></clipPath>',
  ),
  filter: svg(
    `<path d="${blob(50, 50, 24)}" fill="#c84" filter="url(#f)"/>`,
    '<filter id="f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2"/></filter>',
  ),
  pattern: svg(
    `<path d="${P}" fill="url(#p)"/>`,
    '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#333"/></pattern>',
  ),
  group: svg(
    `<g opacity=".5"><path d="${P}" fill="#48c"/><path d="${blob(40, 60, 20)}" fill="#c48"/></g>`,
  ),
  // two rows, only the second carries a stroke, so the bundle compiles WITH stroke while the first row never needs it
  // (the stroke-appears-later cases use `solid`, which has no stroke at all: an override must not conjure one the program lacks)
  sheet: svg(
    `<g id="s0"><path d="${blob(25, 50, 18)}" fill="#c33"/></g><g id="s1"><path d="${blob(75, 50, 18)}" fill="#33c" stroke="#111" stroke-width="3"/></g>`,
  ),
};
const MORPH_B = {
  solid: svg(
    `<path d="${blob(55, 45, 24)}" fill="#48c"/><path d="${blob(30, 70, 14)}" fill="#c84" fill-opacity=".7"/>`,
  ),
  gradient: svg(`<path d="${blob(55, 45, 24)}" fill="url(#g)"/>`, GRAD),
  stroked: svg(`<path d="${blob(55, 45, 24)}" fill="#48c" stroke="#112" stroke-width="4"/>`),
};
const R2 = [0.9, 0.3, -0.3, 0.9, 0.2, 0.1]; // a rotated world matrix (becomes a 3x3 in the page)

// One case = a bundle, a route/engine setup, and STEPS drawn in order; every step's picture is compared across the arms.
const CASES = [
  { name: 'solid/default', svg: S.solid, steps: [{}, {}] },
  { name: 'solid/aacFill:false', ropts: { aacFill: false }, svg: S.solid, steps: [{}] },
  { name: 'solid/aacFill:true', ropts: { aacFill: true }, svg: S.solid, steps: [{}] },
  { name: 'solid/route lb', route: 'lb', svg: S.solid, steps: [{}] },
  {
    name: 'solid/route cpatch',
    route: 'cpatch',
    ropts: { cpatchFill: true },
    svg: S.solid,
    steps: [{}],
  },
  { name: 'mix circle+ring/default', svg: S.mix, steps: [{}] },
  { name: 'mix circle+ring/route lb', route: 'lb', svg: S.mix, steps: [{}] },
  {
    name: 'mix circle+ring/route cpatch',
    route: 'cpatch',
    ropts: { cpatchFill: true },
    svg: S.mix,
    steps: [{}],
  },
  { name: 'stroked fill (hard-band class)/default', svg: S.stroked, steps: [{}] },
  { name: 'stroked fill/route lb', route: 'lb', svg: S.stroked, steps: [{}] },
  { name: 'stroke only/default', svg: S.strokeOnly, steps: [{}] },
  { name: 'dashed stroke/default', svg: S.dashed, steps: [{}] },
  { name: 'gradient/default', svg: S.gradient, steps: [{}] },
  { name: 'gradient/route lb', route: 'lb', svg: S.gradient, steps: [{}] },
  { name: 'mask/default', svg: S.mask, steps: [{}] },
  { name: 'clip/default', svg: S.clip, steps: [{}] },
  { name: 'filter/default', svg: S.filter, steps: [{}] },
  { name: 'filter/route lb', route: 'lb', svg: S.filter, steps: [{}] },
  { name: 'pattern/default', svg: S.pattern, steps: [{}] },
  { name: 'group opacity bundle/default', svg: S.group, steps: [{}] },
  // draw state
  { name: 'rotated world matrix/default', svg: S.solid, steps: [{ wm: R2 }] },
  { name: 'rotated world matrix/route lb', route: 'lb', svg: S.solid, steps: [{ wm: R2 }] },
  { name: 'draw alpha 0.5/default', svg: S.solid, steps: [{ alpha: 0.5 }] },
  // a feature that appears AFTER the first frame: the program for step 1 was chosen for a plain draw
  { name: 'later: recolor (colorMatrix)', svg: S.solid, steps: [{}, { cm: true }, {}] },
  { name: 'later: group alpha', svg: S.solid, steps: [{}, { alpha: 0.5 }, {}] },
  { name: 'later: external clip', svg: S.solid, steps: [{}, { extClip: true }, {}] },
  { name: 'later: rotation (world matrix)', svg: S.solid, steps: [{}, { wm: R2 }, {}] },
  {
    name: 'later: transform override',
    svg: S.solid,
    steps: [{}, { ovr: { 1: { localPosition: [0, -14] } } }, {}],
  },
  {
    name: 'later: rotating override',
    svg: S.solid,
    steps: [{}, { ovr: { 1: { localRotation: 0.7 } } }, {}],
  },
  {
    name: 'later: tint override',
    svg: S.solid,
    steps: [{}, { ovr: { 0: { tint: [1, 0.3, 0.3, 1] } } }, {}],
  },
  {
    name: 'later: fill override',
    svg: S.solid,
    steps: [{}, { ovr: { 0: { fill: [0, 1, 0, 1] } } }, {}],
  },
  {
    name: 'later: stroke override on a fill-only bundle',
    svg: S.solid,
    steps: [{}, { ovr: { 0: { stroke: [1, 0, 0, 1], strokeWidth: 5 } } }, {}],
  },
  {
    name: 'later: stroke override on a stroked bundle',
    svg: S.stroked,
    steps: [{}, { ovr: { 0: { strokeWidth: 9 } } }, {}],
  },
  // two bundles on one renderer: the second bundle's content (mask, gradient, stroke) is new AFTER the base/lean state of the first
  {
    name: 'later: a masked bundle after a solid one',
    svg: S.solid,
    steps: [
      {},
      { other: 'mask' },
      { other: 'gradient' },
      { other: 'stroked' },
      { other: 'filter' },
      { other: 'clip' },
      {},
    ],
  },
  // sprites (one sprite of a sheet), instances, morphs
  {
    name: 'sprite of a sheet',
    svg: S.sheet,
    steps: [{ sprite: 's0' }, { sprite: 's1' }, { sprite: 's0' }],
  },
  { name: 'instanced bundle', svg: S.solid, steps: [{ inst: 3 }, { inst: 3 }] },
  { name: 'instanced bundle after a plain draw', svg: S.solid, steps: [{}, { inst: 3 }, {}] },
  {
    name: 'morph (LB auto)',
    svg: S.solid,
    morph: MORPH_B.solid,
    route: 'lb',
    steps: [{ t: 0 }, { t: 0.5 }, { t: 1 }, { t: 0.25 }],
  },
  {
    name: 'morph (LB off)',
    svg: S.solid,
    morph: MORPH_B.solid,
    lbOff: true,
    steps: [{ t: 0 }, { t: 0.5 }, { t: 1 }, { t: 0.25 }],
  },
  // the same draw held for 90 frames: the deadline swaps the specialized pipeline in (frame ~60) and the picture must not move (a swap that resets the morph jumps to t = 0)
  {
    name: 'morph circle+ring (LB off), held past the pipeline deadline',
    svg: S.mix,
    morph: S.mix.replace('r="22"', 'r="14"'),
    lbOff: true,
    held: true,
    steps: [{ t: 0.5 }, { t: 0.5, rep: 90 }],
  },
  {
    name: 'morph gradient circle+ring (LB off), held past the pipeline deadline',
    svg: S.mix.replace('<defs>', `<defs>${GRAD}`).replaceAll('fill="#222"', 'fill="url(#g)"'),
    morph: S.mix
      .replace('<defs>', `<defs>${GRAD}`)
      .replaceAll('fill="#222"', 'fill="url(#g)"')
      .replace('r="22"', 'r="14"'),
    lbOff: true,
    held: true,
    steps: [{ t: 0.5 }, { t: 0.5, rep: 90 }],
  },
  {
    name: 'morph gradient (LB off)',
    svg: S.gradient,
    morph: MORPH_B.gradient,
    lbOff: true,
    steps: [{ t: 0 }, { t: 0.5 }, { t: 1 }],
  },
  {
    name: 'morph gradient (LB auto)',
    svg: S.gradient,
    morph: MORPH_B.gradient,
    route: 'lb',
    steps: [{ t: 0 }, { t: 0.5 }, { t: 1 }],
  },
  {
    name: 'morph stroked (LB off)',
    svg: S.stroked,
    morph: MORPH_B.stroked,
    lbOff: true,
    steps: [{ t: 0 }, { t: 0.5 }, { t: 1 }],
  },
  {
    name: 'morph circle+ring (LB off)',
    svg: S.mix,
    morph: S.mix.replace('r="22"', 'r="14"'),
    lbOff: true,
    steps: [{ t: 0 }, { t: 0.5 }],
  },
  // a streamed update that changes a curve (fixed shape count): the lean program has to follow
  {
    name: 'streamed update (full): quads, cubics, lines',
    stream: true,
    steps: [{ upd: 0 }, { upd: 1 }, { upd: 2 }, { upd: 3 }],
  },
  {
    name: 'streamed update (lightweight): quads, cubics, lines',
    stream: true,
    light: true,
    steps: [{ upd: 0 }, { upd: 1 }, { upd: 2 }, { upd: 3 }],
  },
  {
    name: 'streamed update then a transform',
    stream: true,
    steps: [{ upd: 0 }, { upd: 1, wm: R2 }, { upd: 2 }],
  },
];

const HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable, createShapeMorph, updateBundleGeometry, buildStreamableSections } from '/src/index.js';
import { mkQuad, mkCubic, mkLine } from '/src/primitives/seg.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const sleep = (ms) => new Promise((f) => setTimeout(f, ms));
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const M3 = (a) => new Float32Array([a[0], a[1], 0, a[2], a[3], 0, a[4] * 2, a[5] * 2, 1]);   // 2x3 -> column-major 3x3 (translation in clip units)
// Streamed shapes: quads first, then cubics, then straight lines -- a lean program built for the first pose must keep every segment type a
// later pose can reach (bundle.segTypeMask of a streamable bundle).
const ringQ = (r, n) => { const o = []; for (let i = 0; i < n; i++) { const a0 = i * 2 * Math.PI / n, a1 = (i + 1) * 2 * Math.PI / n, am = (a0 + a1) / 2, k = 1 / Math.cos(Math.PI / n);
  o.push(mkQuad([50 + r * Math.cos(a0), 50 + r * Math.sin(a0)], [50 + r * k * Math.cos(am), 50 + r * k * Math.sin(am)], [50 + r * Math.cos(a1), 50 + r * Math.sin(a1)])); } return o; };
const ringC = (r, n) => { const o = []; for (let i = 0; i < n; i++) { const a0 = i * 2 * Math.PI / n, a1 = (i + 1) * 2 * Math.PI / n, h = 4 / 3 * Math.tan((a1 - a0) / 4);
  const p0 = [50 + r * Math.cos(a0), 50 + r * Math.sin(a0)], p3 = [50 + r * Math.cos(a1), 50 + r * Math.sin(a1)];
  o.push(mkCubic(p0, [p0[0] - h * r * Math.sin(a0), p0[1] + h * r * Math.cos(a0)], [p3[0] + h * r * Math.sin(a1), p3[1] - h * r * Math.cos(a1)], p3)); } return o; };
const ringL = (r, n) => { const o = []; for (let i = 0; i < n; i++) { const a0 = i * 2 * Math.PI / n, a1 = (i + 1) * 2 * Math.PI / n;
  o.push(mkLine([50 + r * Math.cos(a0), 50 + r * Math.sin(a0)], [50 + r * Math.cos(a1), 50 + r * Math.sin(a1)])); } return o; };
const SEQ = [ringQ(28, 8), ringC(30, 4), ringL(26, 7), ringQ(22, 8)];
const secCache = new Map();
const sec = async (s) => { if (!secCache.has(s)) secCache.set(s, await importSvg(s, { preserveViewport: true })); return secCache.get(s); };
// One arm: a fresh canvas and context, a fresh renderer, the steps in order. rounds > 1 repeats the sequence so the programs warm, and the
// pictures come from the LAST round (the settled one). Between rounds the renderer settles: warmScene draws until a whole pass builds
// nothing (no program, variant, pending link, queued warm or open demand). Nothing is drawn after the last round's last picture.
window.__arm = async (cs, ropts, rounds, settle) => {
  const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
  const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
  const r = createRenderer(gl, shaders, Object.assign({ aacPoints: false }, cs.ropts || {}, ropts));
  r.setViewport(N, N);
  if (cs.route) r.setFillEngine({ route: cs.route, kernel: 'slug' });
  if (cs.lbOff && !cs.held) r.setLoopBlinnFill('off');
  const b = cs.stream ? createBundle(gl, buildStreamableSections([{ segs: SEQ[0], fill: [0.2, 0.4, 0.8, 1] }], [0, 0, 100, 100], cs.light ? { lightweight: true } : {}))
    : createBundle(gl, await sec(cs.svg));
  let drawable = b, b2 = null;
  if (cs.morph) { b2 = createBundle(gl, await sec(cs.morph)); drawable = createShapeMorph(gl, b, b2); }
  const others = {};
  const otherOf = async (k) => others[k] || (others[k] = createBundle(gl, await sec(window.__S[k])));
  r.prepareBundle(b);
  if (cs.held) {
    if (!(await r.awaitLbReady(drawable, 20000))) throw new Error('held morph requires a completed pair mesh');
    r.setLoopBlinnFill('off');
  }
  if (cs.route === 'lb' || cs.route === 'cpatch' || (cs.morph && !cs.lbOff)) { try { await r.awaitLbReady(cs.morph ? drawable : b, 20000); } catch {} }
  const ovr = cs.steps.some((s) => s.ovr) ? createOverrideTable(gl, b) : null;
  let clipTex = null;
  const inst = (k) => { const o = []; for (let i = 0; i < k; i++) o.push({ worldMatrix: new Float32Array([0.4, 0, 0, 0, 0.4, 0, -0.5 + i * 0.5, 0.3 - i * 0.3, 1]) }); return o; };
  const grab = () => { const p = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  const pics = [], keys = [];
  let settled = 0;
  for (let round = 0; round < rounds; round++) {
    const last = round === rounds - 1;
    for (let si = 0; si < cs.steps.length; si++) {
      const st = cs.steps[si];
      const o = {};
      if (st.wm) o.worldMatrix = M3(st.wm);
      if (st.alpha != null) o.alpha = st.alpha;
      if (st.cm) { o.colorMatrix = new Float32Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].slice(0, 16)); o.colorMatrixOffset = new Float32Array([0.05, 0, 0, 0]); }
      if (st.ovr) { ovr.reset && ovr.reset(); for (const [row, v] of Object.entries(st.ovr)) ovr.set(+row, v); o.overrides = ovr; }
      if (st.extClip) {
        if (!clipTex) {
          const cb = createBundle(gl, await sec('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="26" fill="#000"/></svg>'));
          clipTex = r.renderClipCoverage(cb, { worldMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
        }
        o.extClipTex = clipTex; o.extClipMode = 1;
      }
      if (cs.morph) drawable.setT(st.t || 0);
      if (st.upd != null) { const res = updateBundleGeometry(gl, b, [SEQ[st.upd]]); if (res && res.ok === false) throw new Error('updateBundleGeometry refused step ' + si); }
      for (let rp = 0; rp < (st.rep | 0); rp++) {   // st.rep: draw this step again for a while, so deadline-built pipelines swap in (60 frames by default)
        gl.viewport(0, 0, N, N); r.beginFrame([1, 1, 1, 1]); r.drawBundle(drawable, o); r.endFrame(); await sleep(6);
      }
      gl.viewport(0, 0, N, N);
      r.beginFrame([1, 1, 1, 1]);
      if (st.sprite) r.drawSprite(b, st.sprite, o);
      else if (st.inst) r.drawBundleInstanced(b, inst(st.inst), o);
      else if (st.other) r.drawBundle(await otherOf(st.other), o);
      else r.drawBundle(drawable, o);
      r.endFrame();
      pics[si] = b64(grab());
      keys[si] = r.debugStats.drawnFillVariantKey || '';
      if (settle && !(last && si === cs.steps.length - 1)) { for (let w = 0; w < 4; w++) { r.beginFrame([1, 1, 1, 1]); if (st.sprite) r.drawSprite(b, st.sprite, o); else if (st.inst) r.drawBundleInstanced(b, inst(st.inst), o); else if (st.other) r.drawBundle(await otherOf(st.other), o); else r.drawBundle(drawable, o); r.endFrame(); await sleep(8); } }
    }
    if (settle && !last) {
      for (const bb of [b, ...Object.values(others)]) { try { r.prewarmBundle(bb); } catch {} }
      try { r.precompileFills(); } catch {}
      const warm = await r.warmScene([{ name: 'settle', draw: () => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(drawable, {}); r.endFrame(); } }], { maxPasses: 60 });
      if (warm.complete) settled++;
    }
  }
  r.dispose && r.dispose();
  const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
  return { pics, keys, settled };
};
window.__S = ${JSON.stringify(S)};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(p.startsWith('/src/') ? SRC_ROOT : ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  protocolTimeout: 900000,
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const pg = await br.newPage();
let fail = 0;
pg.on('pageerror', (e) => {
  console.error('  [page-err]', e.message);
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });

const COLD = { psoWarmIdle: () => false };
const diff = (a, b) => {
  let mx = 0,
    bad = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
    if (d > mx) mx = d;
    if (d > 8) bad++;
  }
  return { mx, bad };
};
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const rows = [];
let unsettled = 0;
for (const cs of CASES) {
  if (only && !only.test(cs.name)) continue;
  const run = (ropts, rounds, settle) =>
    pg.evaluate(
      (c, o, n, s) => {
        // psoWarmIdle is a function: rebuild it page-side
        const ro = Object.assign({}, o);
        if (o.__cold) {
          delete ro.__cold;
          ro.psoWarmIdle = () => false;
        } else if (o.__idle) {
          delete ro.__idle;
          ro.psoWarmIdle = () => true;
        }
        return window.__arm(c, ro, n, s);
      },
      cs,
      ropts,
      rounds,
      settle,
    );
  let D, D2, B, SS, DS;
  const unb = (arm) => ({
    ...arm,
    pics: arm.pics.map((p) => new Uint8Array(Buffer.from(p, 'base64'))),
  });
  try {
    D = unb(await run(cs.held ? {} : { __cold: true }, 1, false));
    D2 = unb(await run(cs.held ? {} : { __cold: true }, 1, false));
    B = unb(
      await run(
        cs.held ? { variantFirst: false } : { __cold: true, variantFirst: false },
        1,
        false,
      ),
    );
    SS = unb(await run({ __idle: true, variantFirst: false }, 2, true));
    DS = unb(await run({ __idle: true }, 2, true));
    unsettled += 2 - SS.settled - DS.settled;
  } catch (e) {
    console.error(`FAIL ${cs.name}: ${e.message.split('\n')[0]}`);
    fail++;
    continue;
  }
  if (cs.held) {
    for (const [name, arm] of Object.entries({ D, D2, B, SS, DS })) {
      const held = diff(arm.pics[0], arm.pics[1]);
      console.log(`  ${cs.name} ${name}: held pixel delta ${held.mx}/${held.bad}`);
      if (held.mx > 2) {
        console.error(`  FAIL ${cs.name} ${name}: a held pose changed by ${held.mx}`);
        fail++;
      }
    }
  }
  for (let i = 0; i < cs.steps.length; i++) {
    const aa = diff(D.pics[i], D2.pics[i]),
      dS = diff(D.pics[i], SS.pics[i]),
      dB = diff(D.pics[i], B.pics[i]),
      dsS = diff(DS.pics[i], SS.pics[i]),
      bS = diff(B.pics[i], SS.pics[i]);
    const ink = (p) => {
      let n = 0;
      for (let k = 0; k < p.length; k += 4) if (p[k] < 240 || p[k + 1] < 240 || p[k + 2] < 240) n++;
      return n;
    };
    rows.push({
      name: cs.name,
      held: !!cs.held,
      step: i,
      aa,
      dS,
      dB,
      dsS,
      bS,
      ink: ink(D.pics[i]),
      inkS: ink(SS.pics[i]),
      keyD: D.keys[i],
      keyB: B.keys[i],
      keyS: SS.keys[i],
      keyDS: DS.keys[i],
    });
  }
}
await br.close();
server.close();

const lean = (k) => k !== '';
for (const r of rows) {
  const tag = `${r.name} [step ${r.step}]`;
  const line = `A/A ${r.aa.mx}/${r.aa.bad}  D~S ${r.dS.mx}/${r.dS.bad}  D~B ${r.dB.mx}/${r.dB.bad}  B~S ${r.bS.mx}/${r.bS.bad}  DS~S ${r.dsS.mx}/${r.dsS.bad}  ink ${r.ink}/${r.inkS}`;
  console.log(`  ${tag}: ${line}`);
  const bad = [];
  if (r.aa.mx > 2)
    bad.push(
      `the A/A control (two fresh default renderers) differs by ${r.aa.mx}: the arm is noisy, so nothing below proves anything`,
    );
  // The first-frame picture is the settled picture: the lean program is the one the settled path uses. Bound by the A/A noise plus the
  // base-first path's own distance to its settled picture (B~S): a default that moves a pixel farther than the base-first path does is a change.
  const allow = Math.max(r.aa.mx, 2);
  if (r.dS.mx > Math.max(allow, r.bS.mx))
    bad.push(
      `default first frame differs from the settled picture by ${r.dS.mx} (${r.dS.bad} px > 8), more than the base-first path's own ${r.bS.mx}`,
    );
  if (r.dB.mx > 16 && r.dB.bad > 40)
    bad.push(
      `default first frame differs from the base-program picture by ${r.dB.mx} (${r.dB.bad} px > 8)`,
    );
  if (r.dsS.mx > allow)
    bad.push(
      `the warmed default differs from the warmed opt-out by ${r.dsS.mx} (${r.dsS.bad} px > 8)`,
    );
  if (r.ink === 0 || Math.abs(r.ink - r.inkS) > Math.max(30, r.inkS * 0.03))
    bad.push(`ink area ${r.ink} vs settled ${r.inkS}`);
  for (const b of bad) {
    console.error(`  FAIL ${tag}: ${b}`);
    fail++;
  }
}
// A held draw is the same picture before and after the deadline swap.
for (const nm of new Set(rows.filter((r) => /held/.test(r.name)).map((r) => r.name))) {
  const rs = rows.filter((r) => r.name === nm);
  if (rs.length > 1 && Math.abs(rs[0].ink - rs[1].ink) > 20) {
    console.error(
      `  FAIL ${nm}: the picture changed while the draw was held (ink ${rs[0].ink} -> ${rs[1].ink})`,
    );
    fail++;
  }
}
// A morph must MOVE: the settled picture at t = 0.5 is not the picture at t = 0 (a draw frozen at the first pose is a wrong picture the
// base program hides until its lean program warms, with Loop-Blinn fill off).
for (const nm of new Set(
  rows.filter((r) => r.name.startsWith('morph') && !r.held).map((r) => r.name),
)) {
  const rs = rows.filter((r) => r.name === nm);
  if (rs.length > 1 && rs[0].inkS === rs[1].inkS && rs[0].ink === rs[1].ink) {
    console.error(
      `  FAIL ${nm}: the picture did not change between t = 0 and t = ${nm.includes('circle') ? 0.5 : 0.5}`,
    );
    fail++;
  }
}
// The first frame really is lean-first (not just equal): the default binds a specialized program, the opt-out the base (empty key).
const first = rows.filter(
  (r) =>
    r.step === 0 && !/instanced|sprite/.test(r.name) && !/route lb|route cpatch|morph/.test(r.name),
);
const leanFirst = first.filter((r) => lean(r.keyD)).length;
if (leanFirst < first.length * 0.8) {
  console.error(
    `  FAIL the default drew a specialized program on frame 1 for only ${leanFirst}/${first.length} classes`,
  );
  fail++;
} else
  console.log(
    `  ok the default drew a specialized program on frame 1 for ${leanFirst}/${first.length} classes`,
  );
if (unsettled)
  console.log(`  (${unsettled} warmed arms were still building when the settle pass ended)`);
console.log(
  fail
    ? `\nFAIL variantFirstDefaultSmoke: ${fail}`
    : `\nvariantFirstDefaultSmoke PASS (${rows.length} steps)`,
);
process.exit(fail ? 1 : 0);
