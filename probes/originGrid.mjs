// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// originGrid.mjs -- the scale-audit battery (58 cases x pinned engines) drawn at far DOCUMENT offsets, with the per-bundle origin.
//
//   node probes/originGrid.mjs [--arms slug,aac,lb,cpatch,gwn] [--ks -10,0,10] [--offs 1e4,1e5,1e6,1e7] [--unit 1] [--origin auto|false] [--cases a,b] [--out f.json] [--gl swiftshader|metal]
//
// The art is the audit's 128-unit battery times S = 2^k (times 1/128 with --unit 1: unit-sized art), drawn at a document offset of
// `off` UNITS (not scaled by S: "unit art at 1e7" is a unit at 1e7), the viewBox [off, off, 128 S, 128 S], the device fixed at 128 px.
// Each render is diffed with the same engine's offset-0 render of the same k: a far origin that costs anything shows as a diff.
// --origin false draws the unfixed arm (absolute float32 coordinates), the control that the cells can fail.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MANTLE_SRC_ROOT || path.resolve(HERE, '..');
const { launchBrowser } = await import(path.join(ROOT, 'test/_launch.mjs'));
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const ARMS = arg('arms', 'slug,aac,lb,cpatch,gwn').split(',');
const KS = arg('ks', '-10,0,10').split(',').map(Number);
const OFFS = arg('offs', '1e4,1e6,1e7').split(',').map(Number);
const ORIGIN = arg('origin', 'auto');
const UNIT = arg('unit', '0') === '1' ? 1 / 128 : 1; // unit-sized art: the 128-unit battery divided by 128 (a viewBox 0 0 1 1 icon)
const GL = arg('gl', 'swiftshader');
const BASE = +arg('base', '2'); // S = BASE^k (2: exact; 10 or 3: inexact, exposes rounding-sensitive thresholds)
const DEV = +arg('dev', '128');
const N = DEV;
const MUTHIT = new Set();
const MUT = process.env.MUT ? JSON.parse(process.env.MUT) : [];

// ---------------------------------------------------------------- number / path scaling
const fmt = (v) => String(v);
export function scalePath(d, S, o) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  const ar = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let out = [],
    cmd = '',
    i = 0;
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) {
      cmd = toks[i++];
      out.push(cmd);
      if (!ar[cmd.toLowerCase()]) continue;
    }
    const c = cmd.toLowerCase(),
      rel = cmd === c,
      n = ar[c];
    for (let j = 0; j < n; j++) {
      const v = +toks[i++];
      let r;
      if (c === 'a') r = j < 2 ? v * S : j < 5 ? v : v * S + (rel ? 0 : o);
      else r = v * S + (rel ? 0 : o);
      out.push(fmt(r));
    }
    if (c === 'm') cmd = rel ? 'l' : 'L';
  }
  return out.join(' ');
}

// ---------------------------------------------------------------- the battery. Every case: (S, o) => svg inner markup.
const BG = (S, o) =>
  `<rect x="${fmt(o)}" y="${fmt(o)}" width="${fmt(N * S)}" height="${fmt(N * S)}" fill="#e8e8e8"/>`;
const P = (S, o, d, attrs = '') => `<path d="${scalePath(d, S, o)}" ${attrs}/>`;
const SW = (S, w) => `stroke-width="${fmt(w * S)}"`;
const CIRC = 'M104 64 A40 40 0 1 1 24 64 A40 40 0 1 1 104 64 Z';
const STAR = 'M64 12 L88 108 L12 46 L116 46 L40 108 Z';
export const FILLS = {
  circle: (S, o) => P(S, o, CIRC, 'fill="#c0392b"'),
  circleQuads: (S, o) =>
    P(
      S,
      o,
      'M104 64 Q104 104 64 104 Q24 104 24 64 Q24 24 64 24 Q104 24 104 64 Z',
      'fill="#c0392b"',
    ),
  ellipseRot: (S, o) =>
    P(S, o, 'M104 64 A44 22 30 1 1 24 64 A44 22 30 1 1 104 64 Z', 'fill="#2980b9"'),
  rotRect: (S, o) => P(S, o, 'M64 14 L114 64 L64 114 L14 64 Z', 'fill="#27ae60"'),
  rotRect17: (S, o) => P(S, o, 'M40 20 L110 38 L92 108 L22 90 Z', 'fill="#27ae60"'),
  starNZ: (S, o) => P(S, o, STAR, 'fill="#8e44ad" fill-rule="nonzero"'),
  starEO: (S, o) => P(S, o, STAR, 'fill="#8e44ad" fill-rule="evenodd"'),
  sliver: (S, o) => P(S, o, 'M10 60 L118 62 L10 62.3 Z', 'fill="#000"'),
  sliverDiag: (S, o) => P(S, o, 'M10 10 L118 118 L117.6 118 Z', 'fill="#000"'),
  tinyNearHuge: (S, o) =>
    P(S, o, 'M-2000 -2000 L2000 -2000 L2000 64.5 L-2000 64.5 Z', 'fill="#555"') +
    P(S, o, 'M66.2 63.7 L67 63.7 L67 64.5 L66.2 64.5 Z', 'fill="#f00"') +
    P(S, o, 'M20 66 Q 21 63.5 22 66 Z', 'fill="#00f"'),
  arcPie: (S, o) =>
    P(S, o, 'M64 64 L104 64 A40 40 0 0 0 64 24 Z', 'fill="#d35400"') +
    P(S, o, 'M64 70 L24 70 A40 40 0 1 0 64 110 Z', 'fill="#16a085"'),
  cubicCusp: (S, o) => P(S, o, 'M20 100 C 120 10 10 10 108 100 Z', 'fill="#c0392b"'),
  cubicLoop: (S, o) => P(S, o, 'M20 100 C 140 -10 -12 -10 108 100 Z', 'fill="#2c3e50"'),
  cubicSCurve: (S, o) => P(S, o, 'M10 100 C 60 10 70 120 118 20 L118 110 Z', 'fill="#2c3e50"'),
  degenQuad: (S, o) =>
    P(S, o, 'M10 20 Q 64 20 118 20 L118 60 Q 64 60.0001 10 60 Z', 'fill="#333"') +
    P(S, o, 'M10 80 C 10 80 118 80 118 80 L118 110 L10 110 Z', 'fill="#333"'),
  degenCubic: (S, o) =>
    P(S, o, 'M10 20 C 10 20 64 20 118 20 C 118 20 118 60 118 60 L10 60 Z', 'fill="#333"') +
    P(S, o, 'M20 80 C 20 80 20 80 100 100 L20 100 Z', 'fill="#a33"'),
  donutEO: (S, o) =>
    P(
      S,
      o,
      CIRC + ' M92 64 A28 28 0 1 1 36 64 A28 28 0 1 1 92 64 Z',
      'fill="#e67e22" fill-rule="evenodd"',
    ),
  donutNZ: (S, o) =>
    P(
      S,
      o,
      CIRC + ' M36 64 A28 28 0 1 0 92 64 A28 28 0 1 0 36 64 Z',
      'fill="#e67e22" fill-rule="nonzero"',
    ),
  holesNZsame: (S, o) =>
    P(
      S,
      o,
      'M10 10 H118 V118 H10 Z M30 30 H60 V60 H30 Z M70 70 H100 V100 H70 Z',
      'fill="#1abc9c" fill-rule="nonzero"',
    ),
  manyThin: (S, o) =>
    P(
      S,
      o,
      'M10 10 H118 V11 H10 Z M10 20 H118 V20.5 H10 Z M10 30 H118 V30.25 H10 Z M10 40 H118 V40.125 H10 Z',
      'fill="#000"',
    ),
  concave: (S, o) => P(S, o, 'M10 10 L118 10 L118 118 L64 40 L10 118 Z', 'fill="#2980b9"'),
};
const STROKE_BASE = (S, o, d, a) => P(S, o, d, `fill="none" stroke="#c0392b" ${SW(S, 8)} ${a}`);
const ZZ = 'M16 100 L48 24 L80 100 L112 24';
const CLOSED = 'M24 24 L104 24 L64 104 Z';
const CURVE = 'M14 100 C 40 10 80 130 114 28';
export const STROKES = {
  joinMiter: (S, o) => STROKE_BASE(S, o, ZZ, 'stroke-linejoin="miter" stroke-miterlimit="4"'),
  joinMiterLim1: (S, o) => STROKE_BASE(S, o, ZZ, 'stroke-linejoin="miter" stroke-miterlimit="1"'),
  joinMiterLim100: (S, o) =>
    STROKE_BASE(
      S,
      o,
      'M16 100 L48 24 L50 100 L112 24',
      'stroke-linejoin="miter" stroke-miterlimit="100"',
    ),
  joinRound: (S, o) => STROKE_BASE(S, o, ZZ, 'stroke-linejoin="round"'),
  joinBevel: (S, o) => STROKE_BASE(S, o, ZZ, 'stroke-linejoin="bevel"'),
  capButt: (S, o) => STROKE_BASE(S, o, CURVE, 'stroke-linecap="butt"'),
  capRound: (S, o) => STROKE_BASE(S, o, CURVE, 'stroke-linecap="round"'),
  capSquare: (S, o) => STROKE_BASE(S, o, CURVE, 'stroke-linecap="square"'),
  closedTri: (S, o) => STROKE_BASE(S, o, CLOSED, 'stroke-linejoin="miter"'),
  closedCircle: (S, o) => STROKE_BASE(S, o, CIRC, ''),
  quadStroke: (S, o) => STROKE_BASE(S, o, 'M14 100 Q 64 -20 114 100', 'stroke-linecap="round"'),
  arcStroke: (S, o) => STROKE_BASE(S, o, 'M20 90 A50 40 20 0 1 108 40', 'stroke-linecap="butt"'),
  hairline: (S, o) => P(S, o, CURVE, `fill="none" stroke="#000" ${SW(S, 0.2)}`),
  wideStroke: (S, o) =>
    P(S, o, CURVE, `fill="none" stroke="#000" ${SW(S, 40)} stroke-linejoin="round"`),
  cuspStroke: (S, o) =>
    STROKE_BASE(S, o, 'M20 100 C 120 10 10 10 108 100', 'stroke-linejoin="round"'),
  loopStroke: (S, o) =>
    STROKE_BASE(S, o, 'M20 100 C 140 -10 -12 -10 108 100', 'stroke-linejoin="miter"'),
  dashBasic: (S, o) =>
    STROKE_BASE(
      S,
      o,
      CURVE,
      `stroke-dasharray="${fmt(14 * S)} ${fmt(8 * S)}" stroke-dashoffset="${fmt(5 * S)}"`,
    ),
  dashRound: (S, o) =>
    STROKE_BASE(
      S,
      o,
      CLOSED,
      `stroke-linecap="round" stroke-dasharray="${fmt(1 * S)} ${fmt(14 * S)}"`,
    ),
  dashClosed: (S, o) => STROKE_BASE(S, o, CIRC, `stroke-dasharray="${fmt(20 * S)} ${fmt(10 * S)}"`),
  dashTiny: (S, o) =>
    STROKE_BASE(S, o, 'M10 64 L118 64', `stroke-dasharray="${fmt(0.5 * S)} ${fmt(0.5 * S)}"`),
  zeroLenCap: (S, o) =>
    STROKE_BASE(S, o, 'M30 64 L30 64 M64 64 L64 64.0000001 M98 64 Z', 'stroke-linecap="round"'),
  strokeFillBoth: (S, o) =>
    P(
      S,
      o,
      'M24 24 H104 V104 H24 Z',
      `fill="#f1c40f" stroke="#000" ${SW(S, 10)} stroke-linejoin="round"`,
    ),
  strokeOpacity: (S, o) =>
    P(
      S,
      o,
      ZZ,
      `fill="none" stroke="#000" stroke-opacity="0.5" ${SW(S, 12)} stroke-linejoin="round"`,
    ),
};
const defs = (s) => `<defs>${s}</defs>`;
export const PAINT = {
  linGradUser: (S, o) =>
    defs(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${fmt(20 * S + o)}" y1="${fmt(o)}" x2="${fmt(108 * S + o)}" y2="${fmt(o)}"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>`,
    ) + P(S, o, 'M10 10 H118 V118 H10 Z', 'fill="url(#g)"'),
  linGradBBox: (S, o) =>
    defs(
      `<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>`,
    ) + P(S, o, 'M10 10 H118 V118 H10 Z', 'fill="url(#g)"'),
  linGradXform: (S, o) =>
    defs(
      `<linearGradient id="g" gradientTransform="rotate(30) scale(1.5 1)"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>`,
    ) + P(S, o, 'M10 10 H118 V118 H10 Z', 'fill="url(#g)"'),
  linGradUserXform: (S, o) =>
    defs(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${fmt(10 * S)}" y1="0" x2="${fmt(118 * S)}" y2="0" gradientTransform="translate(${fmt(o)} ${fmt(o)}) rotate(20)"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>`,
    ) + P(S, o, 'M10 10 H118 V118 H10 Z', 'fill="url(#g)"'),
  radGradUser: (S, o) =>
    defs(
      `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${fmt(64 * S + o)}" cy="${fmt(64 * S + o)}" r="${fmt(54 * S)}" fx="${fmt(44 * S + o)}" fy="${fmt(54 * S + o)}"><stop offset="0" stop-color="#ff0"/><stop offset="1" stop-color="#00f"/></radialGradient>`,
    ) + P(S, o, 'M10 10 H118 V118 H10 Z', 'fill="url(#g)"'),
  radGradBBoxStroke: (S, o) =>
    defs(
      `<radialGradient id="g"><stop offset="0" stop-color="#ff0"/><stop offset="1" stop-color="#00f"/></radialGradient>`,
    ) + P(S, o, CIRC, `fill="none" stroke="url(#g)" ${SW(S, 12)}`),
  patternUser: (S, o) =>
    defs(
      `<pattern id="p" patternUnits="userSpaceOnUse" x="${fmt(o)}" y="${fmt(o)}" width="${fmt(16 * S)}" height="${fmt(16 * S)}"><rect width="${fmt(8 * S)}" height="${fmt(8 * S)}" fill="#c00"/><rect x="${fmt(8 * S)}" y="${fmt(8 * S)}" width="${fmt(8 * S)}" height="${fmt(8 * S)}" fill="#00c"/></pattern>`,
    ) + P(S, o, 'M10 10 H118 V118 H10 Z', 'fill="url(#p)"'),
  clipPath: (S, o) =>
    defs(`<clipPath id="c"><path d="${scalePath(CIRC, S, o)}"/></clipPath>`) +
    `<g clip-path="url(#c)">` +
    P(S, o, 'M0 0 H128 V64 H0 Z', 'fill="#c00"') +
    P(S, o, 'M0 64 H128 V128 H0 Z', 'fill="#00c"') +
    `</g>`,
  mask: (S, o) =>
    defs(
      `<mask id="m"><path d="${scalePath(CIRC, S, o)}" fill="#fff"/><path d="${scalePath('M40 64 H88 V90 H40 Z', S, o)}" fill="#000"/></mask>`,
    ) +
    `<g mask="url(#m)">` +
    P(S, o, 'M0 0 H128 V128 H0 Z', 'fill="#c00"') +
    `</g>`,
  groupOpacity: (S, o) =>
    `<g opacity="0.5">` +
    P(S, o, 'M20 20 H80 V80 H20 Z', 'fill="#c00"') +
    P(S, o, 'M50 50 H108 V108 H50 Z', 'fill="#00c"') +
    `</g>`,
  blurFilter: (S, o) =>
    defs(
      `<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${fmt(6 * S)}"/></filter>`,
    ) + P(S, o, CIRC.replace(/40/g, '30'), 'fill="#c00" filter="url(#f)"'),
  dropShadow: (S, o) =>
    defs(
      `<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${fmt(8 * S)}" dy="${fmt(8 * S)}" stdDeviation="${fmt(4 * S)}" flood-color="#000"/></filter>`,
    ) + P(S, o, 'M30 30 H80 V80 H30 Z', 'fill="#c00" filter="url(#f)"'),
  filterUserRegion: (S, o) =>
    defs(
      `<filter id="f" filterUnits="userSpaceOnUse" x="${fmt(10 * S + o)}" y="${fmt(10 * S + o)}" width="${fmt(80 * S)}" height="${fmt(80 * S)}"><feOffset dx="${fmt(10 * S)}" dy="0"/></filter>`,
    ) + P(S, o, 'M20 20 H100 V100 H20 Z', 'fill="#c00" filter="url(#f)"'),
  nonScalingStroke: (S, o) =>
    P(S, o, ZZ, `fill="none" stroke="#000" stroke-width="6" vector-effect="non-scaling-stroke"`),
};
export const CASES = {
  ...Object.fromEntries(Object.entries(FILLS).map(([k, v]) => ['f_' + k, v])),
  ...Object.fromEntries(Object.entries(STROKES).map(([k, v]) => ['s_' + k, v])),
  ...Object.fromEntries(Object.entries(PAINT).map(([k, v]) => ['p_' + k, v])),
};
export const svgFor = (name, k, o0 = 0) => {
  const S = Math.pow(BASE, k) * UNIT,
    o = o0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(o)} ${fmt(o)} ${fmt(N * S)} ${fmt(N * S)}" width="${N}" height="${N}">${BG(S, o)}${CASES[name](S, o)}</svg>`;
};

// ---------------------------------------------------------------- the page
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script>globalThis.__MANTLE_DEBUG__ = true;</script>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph, MantleFontAsset, createTextBundle } from '/src/index.js';
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const GWN = new URLSearchParams(location.search).get('gwn') === '1';
const R = createRenderer(gl, shaders, GWN ? { fillDefines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] } : {}); if (R.ready) await R.ready;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const ARM = { slug: [{ route: 'none', kernel: 'slug' }, {}], aac: [{ route: 'none', kernel: 'aac' }, {}], lb: [{ route: 'lb', kernel: 'slug' }, {}],
  cpatch: [{ route: 'cpatch', kernel: 'slug' }, {}], gwn: [{ route: 'none' }, { gwnTree: true }], auto: [{ route: 'auto', kernel: 'auto', commit: false }, {}] };
window.__render = async (svg, arm, origin) => {
  const [sel, io] = ARM[arm];
  R.setFillEngine(sel);
  const err = [];
  const before = Object.assign({}, (R.debugStats.engines || {}).draws || {});
  let b;
  try { b = createBundle(gl, await importSvg(svg, Object.assign({ preserveViewport: true }, io, origin === false ? { origin: false } : {}))); } catch (e) { return { err: 'import: ' + e.message }; }
  try {
    if (R.prepareBundle) R.prepareBundle(b);
    R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    // frame until the pinned engine has painted (or 8 s), then 2 more frames; never awaitLbReady (it waits its full timeout under a CPatch pin)
    const want = arm === 'lb' || arm === 'cpatch' ? arm : null;
    const t0 = performance.now();
    for (let i = 0; i < 400; i++) {
      R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
      const dr = (R.debugStats.engines || {}).draws || {};
      if (!want || (dr[want] || 0) > (before[want] || 0)) break;
      if (performance.now() - t0 > 8000) { err.push('pinned engine never drew'); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
    Object.assign(before, (R.debugStats.engines || {}).draws || {});   // the verdict is the LAST frame's draws
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
  } catch (e) { err.push('draw ' + e.message); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const after = (R.debugStats.engines || {}).draws || {};
  const drew = {}; for (const k of Object.keys(after)) { const d = after[k] - (before[k] || 0); if (d) drew[k] = d; }
  const dec = (R.debugStats.engines || {}).declines || {};
  b.dispose && b.dispose();
  return { px: b64(px), drew, declines: JSON.stringify(dec), err: err.join(';') };
};
window.__text = async (ttf, text, sizes, arm, opts) => {
  const [sel] = ARM[arm]; R.setFillEngine(sel);
  const font = new MantleFontAsset(new Uint8Array(ttf));
  const out = [];
  for (const fs of sizes) {
    const before = Object.assign({}, (R.debugStats.engines || {}).draws || {});
    let tb;
    try { tb = await createTextBundle(gl, { font, text, style: Object.assign({ fontSize: fs, fill: [0, 0, 0, 1] }, opts || {}) }); } catch (e) { out.push({ fs, err: String(e.message || e) }); continue; }
    R.prepareBundle(tb.bundle);
    R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    const want = arm === 'lb' || arm === 'cpatch' ? arm : null;
    for (let i = 0; i < 300; i++) {
      R.beginFrame([1, 1, 1, 1]); R.drawBundle(tb); R.endFrame();
      const dr = (R.debugStats.engines || {}).draws || {};
      if (!want || (dr[want] || 0) > (before[want] || 0)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(tb); R.endFrame();
    const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.push({ fs, px: b64(px), bbox: Array.from(tb.bundle.globalBBox || []) });
    tb.dispose && tb.dispose();
  }
  return out;
};
window.__morph = async (svgA, svgB, ts, arm) => {
  const [sel] = ARM[arm]; R.setFillEngine(sel);
  const A = createBundle(gl, await importSvg(svgA, { preserveViewport: true })), B = createBundle(gl, await importSvg(svgB, { preserveViewport: true }));
  const m = createShapeMorph(gl, A, B, {});
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const out = [];
  for (const t of ts) {
    m.setT(t);
    for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(m); R.endFrame(); await new Promise((r) => setTimeout(r, 15)); }
    const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.push({ t: Number.isNaN(t) ? 'NaN' : t, px: b64(px), err: gl.getError() });
  }
  m.dispose && m.dispose();
  return out;
};
window.__ready = true;
</script></body></html>`;

export async function openPage(gwn = false) {
  const server = http.createServer((req, res) => {
    try {
      const u = req.url.split('?')[0];
      if (u === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }
      const p = decodeURIComponent(u);
      res.writeHead(200, {
        'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript',
      });
      let body = readFileSync(path.join(ROOT, p), 'utf8');
      // MUT='[{"file":"filterDraw.js","old":"...","new":"..."}]' patches the SERVED text only (the tree stays untouched): confirms a suspect constant.
      for (const m of MUT)
        if (p.endsWith(m.file) && body.includes(m.old)) {
          body = body.split(m.old).join(m.new);
          MUTHIT.add(p);
        }
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await launchBrowser({
    headless: 'new',
    args:
      GL === 'swiftshader'
        ? ['--enable-unsafe-swiftshader', '--no-sandbox']
        : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200));
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/' + (gwn ? '?gwn=1' : ''), {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
  return {
    pageErrors,
    async render(svg, arm, origin) {
      const r = await page.evaluate(
        (s, a, o) => window.__render(s, a, o),
        svg,
        arm,
        origin === false ? false : null,
      );
      if (r.px) r.px = new Uint8Array(Buffer.from(r.px, 'base64'));
      return r;
    },
    async text(ttf, text, sizes, arm, opts) {
      const r = await page.evaluate(
        (a, b, c, d, e) => window.__text(a, b, c, d, e),
        Array.from(ttf),
        text,
        sizes,
        arm,
        opts || null,
      );
      return r.map((o) => (o.px ? { ...o, px: new Uint8Array(Buffer.from(o.px, 'base64')) } : o));
    },
    async morph(a, b, ts, arm) {
      const r = await page.evaluate(
        (x, y, t, ar) =>
          window.__morph(
            x,
            y,
            t.map((v) =>
              v === 'NaN' ? NaN : v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : v,
            ),
            ar,
          ),
        a,
        b,
        ts,
        arm,
      );
      return r.map((o) => ({ ...o, px: new Uint8Array(Buffer.from(o.px, 'base64')) }));
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}

export function diff(a, b) {
  let max = 0,
    over = 0,
    sum = 0,
    cx = -1,
    cy = -1;
  for (let i = 0; i < N * N; i++) {
    let m = 0;
    for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
    sum += m;
    if (m > max) {
      max = m;
      cx = i % N;
      cy = (i / N) | 0;
    }
    if (m > 40) over++;
  }
  return { max, over, mean: +(sum / (N * N)).toFixed(3), at: [cx, N - 1 - cy] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = arg('cases', Object.keys(CASES).join(','))
    .split(',')
    .filter((n) => CASES[n]);
  const rows = [];
  for (const arm of ARMS) {
    const pg = await openPage(arm === 'gwn');
    for (const name of names) {
      const line = [];
      for (const k of KS) {
        const base = await pg.render(svgFor(name, k, 0), arm);
        if (!base.px) {
          rows.push({ arm, name, k, err: base.err });
          line.push(k + ':BASE-ERR');
          continue;
        }
        const engines = Object.keys(base.drew).join('+');
        for (const off of OFFS) {
          const r = await pg.render(
            svgFor(name, k, off),
            arm,
            ORIGIN === 'false' ? false : undefined,
          );
          if (!r.px) {
            rows.push({ arm, name, k, off, err: r.err });
            line.push(`${k}@${off}:ERR`);
            continue;
          }
          const d = diff(r.px, base.px);
          const engK = Object.keys(r.drew).join('+');
          rows.push({ arm, name, k, off, ...d, engBase: engines, engK, err: r.err || undefined });
          line.push(`${k}@${off}:${d.max}/${d.over}${engK !== engines ? '[' + engK + ']' : ''}`);
        }
      }
      console.log(arm.padEnd(6), name.padEnd(22), line.join(' '));
    }
    if (pg.pageErrors.length)
      console.log('pageErrors', arm, [...new Set(pg.pageErrors)].slice(0, 5));
    await pg.close();
  }
  const worst = rows.filter((r) => r.max != null).reduce((m, r) => Math.max(m, r.max), 0);
  const bad = rows.filter((r) => r.max > 2 || r.err);
  console.log(
    `ORIGIN GRID origin=${ORIGIN}: ${rows.length} renders, worst max ${worst}/255, ${bad.length} over 2/255 or errored`,
  );
  const out = arg('out', null);
  if (out) writeFileSync(out, JSON.stringify(rows));
}
