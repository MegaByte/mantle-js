// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _shaderIdentity.mjs -- hold two shader TEXTS to each other, bit for bit, on the CPU (test/_glslMainEmu.mjs).
//
// An output-identity claim about a fragment-shader change would otherwise rest on a code-reading argument and a GPU
// pixel diff. This runs the whole main() of both texts in float32 over real assets instead, so a claim can be proven before a GPU sees it,
// and a harness change can be checked against itself:
//
//   main   mantle.frag.glsl: every meta row of each asset drawn as a cover quad, a jittered grid over its bbox, under four
//          uniform scenarios (defaults; ext clip IN with baked masks, a color-matrix offset and a frame origin; ext clip
//          OUT with overrides, palette and channel lerp; stroke gates off with the inline mask walk) and a set of engine
//          variants (Slug, EXACT_EDGE, AAC, HARD_MIXED+TREE, GWN+SDF, HARD, INSTANCED, LB_FILL cover quads).
//   bake   maskBake.frag.glsl: every layer row, luminance and alpha, with the vertex stage's flat meta varyings filled as
//          maskBake.vert packs them (--gates A,B pins uStrokeGates per arm).
//   stops  sampleStops / sampleStopsRaw lifted alone: synthetic stop LUTs of 1..65536 stops in both layouts, wrapped as
//          the packer wraps them, t swept over every stop offset and its float neighbors.
//
// Discarded fragments compare by their flag alone (their color is never written). A NaN output compares by its bits.
//
//   node test/_shaderIdentity.mjs main  A.frag.glsl B.frag.glsl [--variants slug,aac] [--quick]
//   node test/_shaderIdentity.mjs bake  A.frag.glsl B.frag.glsl [--gates 0,1] [--quick]
//   node test/_shaderIdentity.mjs stops A.frag.glsl B.frag.glsl
// A and B are GENERATED shaders (src/shaders/generated/, or `git show <rev>:js.kontek.mantle/src/shaders/generated/...`).
// Exit 0 = bit-identical, 1 = they differ, 2 = the harness could not run.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildMainEmu, runMainEmu, preprocessGlsl } from './_glslMainEmu.mjs';
import { glslToCpp, cxx, vecHeader, fpFlags, emuContractDefault } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VARIANTS = {
  slug: [],
  exact: ['MANTLE_EXACT_EDGE'],
  aac: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'],
  mixed: ['MANTLE_HARD_MIXED', 'MANTLE_HARD_TREE'],
  gwn: ['MANTLE_GWN', 'MANTLE_GWN_SDF'],
  hard: ['MANTLE_HARD'],
  inst: ['MANTLE_INSTANCED'],
  lbcover: ['MANTLE_LB_FILL'],
};

// ---- synthetic assets: the features the corpus is thin on ---------------------------------------------------------
/// Clip unions of eight children, nested clips on union children and on a single clip row, a union of nested clips, a
/// clipped mask shape, a black luminance mask and a zero-opacity alpha mask.
export const SVG_NESTED_CLIPS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>
<clipPath id="inner"><circle cx="100" cy="100" r="60"/></clipPath>
<clipPath id="inner2"><rect x="20" y="20" width="120" height="90"/><rect x="60" y="120" width="100" height="50"/></clipPath>
<clipPath id="multi"><rect x="10" y="10" width="60" height="60"/><circle cx="120" cy="50" r="40" clip-path="url(#inner)"/>
<path d="M20 120 Q 100 60 180 140 L 150 190 Z" clip-path="url(#inner2)"/><rect x="100" y="100" width="80" height="80"/>
<circle cx="60" cy="150" r="30"/><circle cx="160" cy="160" r="25"/>
<path d="M0 100 C 50 0 150 200 200 100 L 200 110 C 150 210 50 10 0 110 Z"/><rect x="80" y="0" width="40" height="200" transform="rotate(20 100 100)"/></clipPath>
<clipPath id="single" clip-path="url(#inner2)"><path d="M0 0 L200 30 L170 200 L10 180 Z"/></clipPath>
<clipPath id="singleNested"><circle cx="100" cy="100" r="90" clip-path="url(#inner)"/></clipPath>
<clipPath id="multiNested"><circle cx="70" cy="100" r="50" clip-path="url(#inner2)"/><circle cx="130" cy="100" r="50" clip-path="url(#inner)"/></clipPath>
<mask id="m1"><rect x="0" y="0" width="200" height="200" fill="white" clip-path="url(#inner2)"/></mask>
<mask id="mblack"><rect x="0" y="0" width="120" height="200" fill="black"/></mask>
<mask id="mclear" mask-type="alpha"><rect x="0" y="0" width="120" height="200" fill="#fff" fill-opacity="0"/></mask>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f00"/><stop offset="0.5" stop-color="#0f0"/><stop offset="1" stop-color="#00f" stop-opacity="0.5"/></linearGradient>
</defs>
<rect x="0" y="0" width="200" height="200" fill="url(#g)" clip-path="url(#multi)"/>
<path d="M10 10 C 60 190 140 10 190 190" fill="none" stroke="url(#g)" stroke-width="8" clip-path="url(#single)"/>
<circle cx="100" cy="100" r="70" fill="#48c" stroke="#222" stroke-width="3" clip-path="url(#singleNested)"/>
<rect x="5" y="5" width="190" height="190" fill="#c84" fill-opacity="0.7" clip-path="url(#multiNested)"/>
<rect x="30" y="30" width="140" height="140" fill="url(#g)" mask="url(#m1)"/>
<rect x="20" y="20" width="160" height="160" fill="#393" mask="url(#mblack)"/>
<rect x="20" y="20" width="160" height="160" fill="#933" mask="url(#mclear)"/>
</svg>`;

/// A pattern with solid, gradient and dashed stroke children reaching the tile edges, and masks with stroked, dashed,
/// gradient-stroked, gradient-filled and luminance children.
export const SVG_PATTERN_MASK_STROKES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#333" stop-opacity="0.6"/></linearGradient>
<pattern id="p" width="23" height="17" patternUnits="userSpaceOnUse"><path d="M0 0 L23 17" stroke="#f40" stroke-width="3"/>
<path d="M2 15 Q 12 0 21 15" fill="none" stroke="url(#g)" stroke-width="2" stroke-dasharray="4 2"/><circle cx="11" cy="8" r="4" fill="#08f"/>
<rect x="-3" y="12" width="8" height="8" fill="url(#g)"/></pattern>
<mask id="m"><circle cx="70" cy="100" r="50" fill="none" stroke="white" stroke-width="12"/>
<path d="M100 20 L180 180" stroke="url(#g)" stroke-width="10" stroke-dasharray="15 6"/><rect x="110" y="30" width="60" height="60" fill="url(#g)"/>
<circle cx="140" cy="140" r="30" fill="#888"/></mask>
<mask id="mlum"><path d="M10 10 L190 10 L100 190 Z" fill="#808080" stroke="white" stroke-width="6"/></mask></defs>
<rect x="0" y="0" width="200" height="200" fill="url(#p)"/>
<rect x="0" y="0" width="200" height="200" fill="#2a6" mask="url(#m)"/>
<circle cx="100" cy="100" r="90" fill="url(#p)" stroke="#000" stroke-width="2" mask="url(#mlum)"/>
</svg>`;

/// 108 gradients: 1, 2, 3, 16, 256 and 1000 stops (hard stops from 3; past 256, 24-bit offsets in a wrapped stop LUT),
/// opaque and translucent (the 1- and 2-texel stop layouts), pad / reflect / repeat, linear, radial and focal radial with a transform, each as a fill and a stroke; and a
/// dashed userSpaceOnUse repeat stroke.
export function svgGradientSheet({ counts = [1, 2, 3, 16, 256, 1000] } = {}) {
  const defs = [],
    shapes = [];
  let k = 0;
  for (const n of counts)
    for (const alpha of [false, true])
      for (const spread of ['pad', 'reflect', 'repeat'])
        for (const kind of ['lin', 'rad', 'radf']) {
          const stops = [];
          for (let i = 0; i < n; i++) {
            let off = n > 1 ? i / (n - 1) : 0.5;
            if (n >= 3 && i === n >> 1) off = (i - 1) / (n - 1);
            const hx = (v) => (v % 256).toString(16).padStart(2, '0');
            const op = alpha
              ? ` stop-opacity="${(0.3 + (0.7 * ((i * 7) % 10)) / 10).toFixed(2)}"`
              : '';
            stops.push(
              `<stop offset="${off.toFixed(4)}" stop-color="#${hx(i * 53)}${hx(i * 97 + 40)}${hx(i * 29 + 90)}"${op}/>`,
            );
          }
          const id = `g${k}`,
            s = stops.join('');
          defs.push(
            kind === 'lin'
              ? `<linearGradient id="${id}" x1="0.2" y1="0.1" x2="0.6" y2="0.7" spreadMethod="${spread}">${s}</linearGradient>`
              : kind === 'rad'
                ? `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.3" spreadMethod="${spread}">${s}</radialGradient>`
                : `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.25" fx="0.9" fy="0.6" spreadMethod="${spread}" gradientTransform="rotate(15 0.5 0.5)">${s}</radialGradient>`,
          );
          shapes.push(
            `<rect x="${(k % 12) * 33}" y="${Math.floor(k / 12) * 33}" width="30" height="30" fill="url(#${id})" stroke="url(#${id})" stroke-width="2"/>`,
          );
          k++;
        }
  defs.push(
    '<linearGradient id="us" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="40" y2="10" spreadMethod="repeat"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  );
  shapes.push(
    '<path d="M10 380 Q 200 250 390 380" fill="none" stroke="url(#us)" stroke-width="6" stroke-dasharray="12 5"/>',
    '<circle cx="200" cy="330" r="40" fill="url(#us)"/>',
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>${defs.join('')}</defs>${shapes.join('')}</svg>`;
}

/// The corpus: the synthetic sheets, then the in-repo clip / mask / gradient / pattern / dash / filter art and tiger, then
/// the monorepo's MantleSamples when it is present. Each entry is { name, svg } or { name, file }; missing files drop out.
export function defaultAssets({ quick = false } = {}) {
  const EX = path.join(ROOT, 'examples'),
    SM = path.join(EX, 'smoke'),
    MS = path.join(ROOT, '../MantleSamples/Assets/Mantle');
  const synth = [
    { name: 'nested_clips', svg: SVG_NESTED_CLIPS },
    { name: 'gradients', svg: svgGradientSheet() },
    { name: 'pattern_mask_strokes', svg: SVG_PATTERN_MASK_STROKES },
  ];
  const files = [
    [MS, '_clip.svg'],
    [MS, '_clip_multi.svg'],
    [MS, '_mask.svg'],
    [MS, '_mask_multi.svg'],
    [MS, '_mask_nested.svg'],
    [MS, '_mask_features.svg'],
    [MS, '_mask_clear.svg'],
    [MS, '_mask_gradient.svg'],
    [MS, '_mask_image.svg'],
    [MS, 'mask_anim.svg'],
    [MS, '_grad.svg'],
    [MS, '_pattern.svg'],
    [MS, '_pattern_image.svg'],
    [MS, '_pattern_features.svg'],
    [MS, '_pattern_gradient.svg'],
    [EX, '_clipper_anim.svg'],
    [EX, '_dash_circle.svg'],
    [EX, '_dash_cubic.svg'],
    [EX, '_stroke_caps_joins.svg'],
    [EX, '_fgraph_cmat.svg'],
    [SM, 'clipCoverage__CLIP.svg'],
    [SM, 'aacClipConfound__AUTHORED.svg'],
    [SM, 'lbClipParity__SVG.svg'],
    [SM, 'objectBboxStroke__CLIPPED.svg'],
    [SM, 'exportFrameSvg__CLIPART.svg'],
    [SM, 'lbMaskParity__SVG.svg'],
    [SM, 'maskCache__SVG.svg'],
    [SM, 'bundleInstanced__MASK_SVG.svg'],
    [SM, 'lbGradientBatch__sheet_16_linear.svg'],
    [SM, 'lbGradientBatch__sheet_16_radial.svg'],
    [SM, 'lbGradientParity__SVG.svg'],
    [SM, 'objectBoundingBoxGradient__OBB_GRADIENT_DEMO.svg'],
    [SM, 'morphStrokeGradientRoute__SRC.svg'],
    [SM, 'splitStrokeGradientRoute__DST.svg'],
    [SM, 'lbFilterParity__SVG.svg'],
    [SM, 'patternTransform__ROTATED.svg'],
    [SM, 'colorMatrix__SVG_TWO_RECTS.svg'],
    [EX, 'tiger.svg'],
  ]
    .map(([d, f]) => ({ name: f, file: path.join(d, f) }))
    .filter((a) => existsSync(a.file));
  const all = [...synth, ...files];
  return quick ? all.slice(0, 8) : all;
}

// ---- asset -> textures -----------------------------------------------------------------------------------------------
let _svgMods = null;
async function svgMods() {
  if (_svgMods) return _svgMods;
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { parseMetaBin } = await import('../src/renderer/bundle.js');
  return (_svgMods = { importSvg, parseMetaBin });
}
const f32 = (ab) => (ab ? new Float32Array(ab) : null);
const tex = (w, h, l, data) => ({ w, h, l, data });
const unorm = (ab) => {
  const by = new Uint8Array(ab),
    fl = new Float32Array(by.length);
  for (let i = 0; i < by.length; i++) fl[i] = Math.fround(by[i] / 255);
  return fl;
};

/// Import an asset (GWN trees and synchronous occupancy grids on, so every engine variant has its data) and build the
/// textures the fill pass binds, plus synthetic ext-clip, baked-mask, override and palette textures whose values include
/// exact 0, exact 1 and partial coverage.
export async function prepareAsset(asset) {
  const { importSvg, parseMetaBin } = await svgMods();
  const svg = asset.svg ?? readFileSync(asset.file, 'utf8');
  const b = await importSvg(svg, { gwnTree: true, occupancyGrid: {} });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const N = pm.numShapes,
    S = pm.floatsPerShape;
  const meta = new Float32Array(Math.max(1, N) * 48);
  for (let s = 0; s < N; s++)
    meta.set(pm.metaFloats.subarray(s * S, s * S + Math.min(S, 48)), s * 48);
  const T = [],
    idx = {};
  const add = (t) => {
    T.push(t);
    return T.length - 1;
  };
  const curve = f32(b.curves),
    band = f32(b.bands);
  idx.uCurveData = add(tex(4096, Math.max(1, Math.ceil(curve.length / 16384)), 1, curve));
  idx.uBandData = add(tex(4096, Math.max(1, Math.ceil(band.length / 16384)), 1, band));
  idx.uMetaTex = add(tex(12, Math.max(1, N), 1, meta));
  const gr = f32(b.gradients);
  if (gr && gr.length) idx.uGradientTex = add(tex(4, gr.length / 16, 1, gr));
  if (b.gradientStops && b.gradientStops.byteLength) {
    const fl = unorm(b.gradientStops),
      texels = fl.length / 4;
    idx.uGradientStops = add(
      texels <= 2048 ? tex(texels, 1, 1, fl) : tex(2048, Math.ceil(texels / 2048), 1, fl),
    ); // GRAD_STOPS_LUT_W
  }
  const da = f32(b.dashes);
  if (da && da.length) idx.uDashTex = add(tex(16, da.length / 64, 1, da));
  const ft = f32(b.filterTab);
  if (ft && ft.length) idx.uFilterTex = add(tex(6, ft.length / 24, 1, ft));
  if (b.imageAtlas && b.imageAtlas.byteLength && b.imageAtlasDim) {
    idx.uImageTex = add(tex(b.imageAtlasDim[0], b.imageAtlasDim[1], 1, unorm(b.imageAtlas)));
    idx.atlasDim = b.imageAtlasDim;
  }
  // Override plane (6 texels a row): every third row animated (a small affine), tints, and absolute fill / stroke /
  // width overrides on every fifth. Only the overrides scenario turns the table on.
  const ov = new Float32Array(Math.max(1, N) * 24);
  for (let s = 0; s < N; s++) {
    const o = s * 24,
      anim = s % 3 === 1;
    ov.set([anim ? 1.1 : 1, anim ? 0.05 : 0, anim ? -0.03 : 0, anim ? 0.95 : 1], o);
    ov.set([anim ? 1.5 : 0, anim ? -2.25 : 0, 1, s % 5 === 2 ? 7 : 0], o + 4);
    ov.set([1, 0.9, 0.8, s % 4 === 3 ? 0.5 : 1], o + 8);
    ov.set([0.2, 0.6, 0.4, 0.8], o + 12);
    ov.set([0.9, 0.1, 0.3, 1], o + 16);
    ov.set([1.5, 0, 0, 0], o + 20);
  }
  idx.uOverrideTex = add(tex(6, Math.max(1, N), 1, ov));
  const VW = 96,
    VH = 96;
  const pat = (x, y, k) => {
    const v = ((x >> 3) + (y >> 3) + k) % 4;
    return v === 1 ? 1 : v === 2 ? Math.fround(((x * 7 + y * 3) % 256) / 255) : 0;
  };
  const rtl = new Float32Array(Math.max(1, N) * 4).fill(-1);
  let layers = 0;
  for (let s = 0; s < N; s++) if ((meta[s * 48 + 27] | 0) & 512) rtl[s * 4] = layers++; // FLAG_MASK_BEGIN rows get layers
  idx.uMaskRowToLayerTex = add(tex(1, Math.max(1, N), 1, rtl));
  const L = Math.max(1, layers),
    mrt = new Float32Array(VW * VH * L * 4);
  for (let l = 0; l < L; l++)
    for (let y = 0; y < VH; y++)
      for (let x = 0; x < VW; x++) mrt[((l * VH + y) * VW + x) * 4] = pat(x, y, l);
  idx.uMaskRTArray = add(tex(VW, VH, L, mrt));
  const ext = new Float32Array(VW * VH * 4);
  for (let y = 0; y < VH; y++)
    for (let x = 0; x < VW; x++) ext[(y * VW + x) * 4 + 3] = pat(x + 5, y + 3, 1);
  idx.uExtClipTex = add(tex(VW, VH, 1, ext));
  idx.uLBCovTex = add(tex(VW, VH, 1, ext));
  const palette = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++)
    palette.set(
      [
        Math.fround(((i * 37) % 256) / 255),
        Math.fround(((i * 91) % 256) / 255),
        Math.fround(((i * 13) % 256) / 255),
        1,
      ],
      i * 4,
    );
  idx.uPalette = add(tex(256, 1, 1, palette));
  return { b, N, meta, T, idx, VW, VH };
}

/// The four uniform scenarios.
export function scenarios(P) {
  const base = (over) => {
    const m = new Map(
      Object.entries({
        uStrokeExactAa: 1,
        uStrokeGates: 1,
        uHasOccupancy: P.b.hasOccupancy ? 1 : 0,
        uViewportSize: [P.VW, P.VH],
        uFragOrigin: [0, 0],
        uHasOffscreenMask: 0,
        uExtClipMode: 0,
        uHasOverrides: 0,
        uChannelLerpEnabled: 0,
        uColorMatrixEnabled: 0,
        uPaletteEnabled: 0,
        uImageAtlasSize: P.idx.atlasDim || [1, 1],
        uGlobalBBox: [0, 0, 1, 1],
        uCanvasAR: [1, 1],
        uHasWorldM: 0,
        uLBCovTexSize: [P.VW, P.VH],
      }),
    );
    for (const [k, v] of Object.entries(P.idx)) if (k.startsWith('u')) m.set(k, v);
    for (const [k, v] of Object.entries(over)) m.set(k, v);
    return m;
  };
  const cm = [0.8, 0.1, 0.1, 0.2, 0.1, 0.7, 0.1, 0.1, 0.1, 0.2, 0.6, 0.1, 0.1, 0.1, 0.1, 0.9];
  return [
    { name: 'defaults', U: base({}), ov: false },
    {
      name: 'extIn+baked+cmat',
      ov: false,
      U: base({
        uExtClipMode: 1,
        uHasOffscreenMask: 1,
        uColorMatrixEnabled: 1,
        uColorMatrix: cm,
        uColorMatrixOffset: [0.05, 0, 0.1, 0.2],
        uFragOrigin: [2, 4],
      }),
    },
    {
      name: 'extOut+overrides+palette',
      ov: true,
      U: base({
        uExtClipMode: 2,
        uHasOverrides: 1,
        uPaletteEnabled: 1,
        uPaletteChannel: 1,
        uPaletteSize: 256,
        uChannelLerpEnabled: 1,
        uChannelLerpPrimary: [0.9, 0.2, 0.1, 1],
        uChannelLerpContrast: [0.1, 0.3, 0.9, 1],
        uChannelLerpHighlight: [1, 1, 0.8, 1],
      }),
    },
    {
      name: 'noGates+inlineMask',
      ov: false,
      U: base({ uStrokeGates: 0, uStrokeExactAa: 0, uExtClipMode: 1, uHasOccupancy: 0 }),
    },
  ];
}

const prng = (seed) => () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) / 16777216;
};

/// Cover-quad fragments: every meta row, a jittered grid x grid over 1.3x its bbox, alternate rows rotated 30 degrees.
export function mainFrags(P, sc, grid, seed = 12345) {
  const rnd = prng(seed),
    out = [],
    M = P.meta;
  for (let s = 0; s < P.N; s++) {
    const o = s * 48,
      [x0, y0, x1, y1] = [M[o], M[o + 1], M[o + 2], M[o + 3]];
    if (!(x1 >= x0 && y1 >= y0) || !Number.isFinite(x0 + y0 + x1 + y1)) continue;
    const ext = Math.max(x1 - x0, y1 - y0, 1e-3),
      px = ext / (grid * 0.8),
      ang = s % 2 ? 0.52 : 0;
    const dx = [px * Math.cos(ang), px * Math.sin(ang)],
      dy = [-px * Math.sin(ang), px * Math.cos(ang)];
    const ovRow = sc.ov && s % 5 === 2;
    const vary = new Map(
      Object.entries({
        vInst: s,
        vKind: -1,
        vOverrideTint: sc.ov ? [1, 0.9, 0.8, s % 4 === 3 ? 0.5 : 1] : [1, 1, 1, 1],
        vOverrideMask: ovRow ? 7 : 0,
        vOverrideFill: ovRow ? [0.2, 0.6, 0.4, 0.8] : [0, 0, 0, 0],
        vOverrideStroke: ovRow ? [0.9, 0.1, 0.3, 1] : [0, 0, 0, 0],
        vOverrideStrokeWidth: ovRow ? 1.5 * px : 0,
        vInstBias: s % 3 === 0 ? [0.05, -0.02, 0, 0] : [0, 0, 0, 0],
      }),
    );
    for (let j = 0; j < grid; j++)
      for (let i = 0; i < grid; i++) {
        const u = (i + 0.5 + (rnd() - 0.5) * 0.3) / grid,
          v = (j + 0.5 + (rnd() - 0.5) * 0.3) / grid;
        const f = new Map(vary);
        f.set('vEmCoord', [x0 - 0.15 * ext + u * 1.3 * ext, y0 - 0.15 * ext + v * 1.3 * ext]);
        out.push({
          varyings: f,
          dx,
          dy,
          fc: [Math.floor((i * P.VW) / grid) + 0.5, Math.floor((j * P.VH) / grid) + 0.5],
        });
      }
  }
  return out;
}

/// Bake fragments: every layer row (mask and clip children), its meta packed into flat varyings as maskBake.vert packs
/// them (vCapJoin.w = MT_PRIM.z, vGrad7.z = MT_FILTER_BLEND.w, vFrame = a stroke-space row's MT_SOLID). Varyings a text
/// does not declare are ignored.
export function bakeFrags(P, grid, seed = 12345) {
  const rnd = prng(seed),
    out = [],
    M = P.meta;
  for (let s = 0; s < P.N; s++) {
    const o = s * 48;
    if (!((M[o + 27] | 0) & 256)) continue;
    const [x0, y0, x1, y1] = [M[o], M[o + 1], M[o + 2], M[o + 3]];
    if (!(x1 >= x0 && y1 >= y0) || !Number.isFinite(x0 + y0 + x1 + y1)) continue;
    const ext = Math.max(x1 - x0, y1 - y0, 1e-3),
      px = ext / (grid * 0.8);
    const t = (k) => Array.from(M.subarray(o + k * 4, o + k * 4 + 4));
    const vary = new Map(
      Object.entries({
        vBB: t(0),
        vFill: t(1),
        vStroke: t(2),
        vGlyph: t(4),
        vStrokePad: t(3),
        vCapJoin: [...t(6).slice(0, 3), t(11)[2]],
        vGrad7: [t(7)[0], t(7)[1], t(8)[3], t(7)[3]],
        vImgRect: t(9),
        vAtlas: t(10),
        vFrame: ((t(6)[3] + 0.5) | 0) & 4 ? t(5) : [0, 0, 0, 0], // a stroke-space row's frame (FS_STROKE_LOCAL)
      }),
    );
    for (let j = 0; j < grid; j++)
      for (let i = 0; i < grid; i++) {
        const u = (i + 0.5 + (rnd() - 0.5) * 0.3) / grid,
          v = (j + 0.5 + (rnd() - 0.5) * 0.3) / grid;
        const f = new Map(vary);
        f.set('vEmCoord', [x0 - 0.15 * ext + u * 1.3 * ext, y0 - 0.15 * ext + v * 1.3 * ext]);
        out.push({
          row: s,
          varyings: f,
          dx: [px, 0],
          dy: [0, px],
          fc: [Math.floor((i * P.VW) / grid) + 0.5, Math.floor((j * P.VH) / grid) + 0.5],
        });
      }
  }
  return out;
}

/// ...and how far: `big` counts the fragments that differ by at least half an 8-bit level in a channel, or where one
/// discarded and the other did not; `onBig` sees each of them (the rest are rounding, for a fused-vs-unfused run).
function diffCount(A, B, n, onFirst, onBig) {
  const Ai = new Uint32Array(A.buffer, A.byteOffset, n * 5),
    Bi = new Uint32Array(B.buffer, B.byteOffset, n * 5);
  let mis = 0,
    disc = 0,
    big = 0,
    max = 0;
  for (let i = 0; i < n; i++) {
    if (A[i * 5 + 4] === 1) disc++;
    let same = true;
    for (let k = 0; k < 5; k++) if (Ai[i * 5 + k] !== Bi[i * 5 + k]) same = false;
    if (!same && A[i * 5 + 4] === 1 && B[i * 5 + 4] === 1) same = true; // a discarded fragment writes no color
    if (!same) {
      if (!mis && onFirst)
        onFirst(
          i,
          Array.from(A.subarray(i * 5, i * 5 + 5)),
          Array.from(B.subarray(i * 5, i * 5 + 5)),
        );
      mis++;
      let d = A[i * 5 + 4] !== B[i * 5 + 4] ? 1 : 0;
      for (let k = 0; k < 4 && !d; k++) d = Math.max(d, Math.abs(A[i * 5 + k] - B[i * 5 + k]));
      max = Math.max(max, d);
      if (d >= 1 / 510) {
        big++;
        if (onBig)
          onBig(
            i,
            Array.from(A.subarray(i * 5, i * 5 + 5)),
            Array.from(B.subarray(i * 5, i * 5 + 5)),
          );
      }
    }
  }
  return { mis, disc, big, max };
}

/// Hold two mantle.frag texts to each other over `assets` x scenarios x `variants`. Returns per-variant counts.
/// `uniformsB` (optional) edits arm B's uniforms per scenario, for an A/B whose arms differ in a uniform too.
/// A variant is a name from VARIANTS, or { name, a: [defines], b: [defines] } for arms compiled differently (a lean
/// MANTLE_NO_* program against the full one, say). `uniforms` edits both arms' uniforms per scenario, `uniformsB` arm B's.
/// `contract` builds both arms fused, or [a, b] one of them: the same text fused against unfused.
export async function compareMain(
  textA,
  textB,
  {
    variants = Object.keys(VARIANTS),
    assets = defaultAssets(),
    grid = 18,
    log = () => {},
    uniforms = null,
    uniformsB = null,
    opt = '-O1',
    contract = emuContractDefault(),
    bigLog = null,
  } = {},
) {
  const [cA, cB] = Array.isArray(contract) ? contract : [contract, contract];
  const prepared = [];
  for (const a of assets) prepared.push({ a, P: await prepareAsset(a) });
  const res = [];
  for (const v of variants) {
    const vn = typeof v === 'string' ? v : v.name;
    const dA = typeof v === 'string' ? VARIANTS[v] : v.a,
      dB = typeof v === 'string' ? VARIANTS[v] : v.b;
    if (!dA || !dB) throw new Error('shaderIdentity: unknown variant ' + vn);
    const eA = buildMainEmu(textA, dA, { opt, contract: cA }),
      eB = buildMainEmu(textB, dB, { opt, contract: cB });
    let fr = 0,
      mis = 0,
      disc = 0,
      big = 0,
      max = 0;
    for (const { a, P } of prepared)
      for (const sc of scenarios(P)) {
        const frags = mainFrags(P, sc, grid);
        if (!frags.length) continue;
        const UA = uniforms ? uniforms(new Map(sc.U), sc) : sc.U;
        const UB = uniformsB ? uniformsB(new Map(UA), sc) : UA;
        const A = runMainEmu(eA, P.T, UA, frags),
          B = runMainEmu(eB, P.T, UB, frags);
        const d = diffCount(
          A,
          B,
          frags.length,
          (i, x, y) =>
            log(
              `  MISMATCH ${vn} ${a.name} ${sc.name} row ${frags[i].varyings.get('vInst')}: ${x} vs ${y}`,
            ),
          (i, x, y) =>
            bigLog &&
            bigLog(
              `  BIG ${vn} ${a.name} ${sc.name} row ${frags[i].varyings.get('vInst')} frag ${i}: ${x} vs ${y}`,
            ),
        );
        fr += frags.length;
        mis += d.mis;
        disc += d.disc;
        big += d.big;
        max = Math.max(max, d.max);
        if (d.mis) log(`  ${vn} ${a.name} ${sc.name}: ${d.mis}/${frags.length} differ`);
      }
    res.push({ variant: vn, fragments: fr, differ: mis, discarded: disc, big, max });
  }
  return res;
}

/// Hold two maskBake.frag texts to each other: every layer row of `assets`, 4 scenarios x luminance/alpha, plus a draw
/// with no row (it must discard). `gates` = [a, b] pins uStrokeGates per arm.
export async function compareBake(
  textA,
  textB,
  {
    assets = defaultAssets(),
    grid = 20,
    gates = null,
    log = () => {},
    opt = '-O1',
    contract = emuContractDefault(),
  } = {},
) {
  const [cA, cB] = Array.isArray(contract) ? contract : [contract, contract];
  const eA = buildMainEmu(textA, [], { opt, contract: cA }),
    eB = buildMainEmu(textB, [], { opt, contract: cB });
  let fr = 0,
    mis = 0;
  for (const a of assets) {
    const P = await prepareAsset(a);
    // Asymmetric end caps (Flash LineStyle2) never come out of an SVG import: give stroked layer rows one, so MT_PRIM.z
    // reaches the stroke child (both arms read the same texel, however they carry it).
    for (let s = 0; s < P.N; s++) {
      const o = s * 48;
      if ((P.meta[o + 27] | 0) & 256 && P.meta[o + 12] > 0) P.meta[o + 46] = 1 + (s % 3);
    }
    const frags = bakeFrags(P, grid);
    const byRow = new Map();
    for (const f of frags) {
      if (!byRow.has(f.row)) byRow.set(f.row, []);
      byRow.get(f.row).push(f);
    }
    for (const sc of scenarios(P))
      for (const lum of [0, 1])
        for (const [row, list] of [...byRow, [-1, frags.slice(0, 8)]]) {
          if (!list.length) continue;
          const U = new Map(sc.U);
          U.set('uMaskChildRow1Based', row + 1);
          U.set('uMaskIsLuminance', lum);
          U.set('uMaskOwnRow', 1);
          U.set('uMaskRTArrayPong', P.idx.uMaskRTArray);
          U.set('uMaskRowToLayerTexBake', P.idx.uMaskRowToLayerTex);
          const UA = new Map(U),
            UB = new Map(U);
          if (gates) {
            UA.set('uStrokeGates', gates[0]);
            UB.set('uStrokeGates', gates[1]);
          }
          const A = runMainEmu(eA, P.T, UA, list),
            B = runMainEmu(eB, P.T, UB, list);
          const d = diffCount(A, B, list.length, (i, x, y) =>
            log(`  MISMATCH bake ${a.name} row ${row} ${sc.name} lum ${lum}: ${x} vs ${y}`),
          );
          fr += list.length;
          mis += d.mis;
        }
  }
  return { fragments: fr, differ: mis };
}

/// sampleStops / sampleStopsRaw of two texts on synthetic stop LUTs laid out as core/gradientStops.js lays them: rows of
/// 2048 texels, the gradient starting mid-row so it wraps; 1..65536 stops in both layouts, 8-bit offsets and (past 256
/// stops, 2-texel) 24-bit base-255 ones; even, random, hard-stop, duplicated-end, interior-endpoint and non-monotone
/// offsets; t over [-0.5, 1.5], every stop's decoded offset and its float neighbors, NaN and +-Inf; three modes, three dt.
export function compareStops(
  textA,
  textB,
  { counts = null, contract = emuContractDefault() } = {},
) {
  const C = cxx();
  const tr = (t) => glslToCpp(preprocessGlsl(t, []), ['sampleStops', 'sampleStopsRaw']);
  const hdr =
    '#include <cstring>\n' +
    vecHeader()
      // the fill emulator's sampler carries its own row width and its fetch counter's slot (id 2:
      // neither band nor curve)
      .replace(
        'struct sampler2D { const float* data; long texels; long w = 4096; int id = 2; };',
        'struct sampler2D { const float* data; long texels; int id; int w; int h; };',
      )
      .replace(
        'long idx = (long)xy.y * s.w + xy.x;',
        'if (!s.data || xy.x >= s.w) return vec4(0.0f); long idx = (long)xy.y * s.w + xy.x;',
      );
  if (!hdr.includes('int w; int h;') || !hdr.includes('xy.x >= s.w'))
    throw new Error('shaderIdentity: the _glslEmu.mjs header changed; patch its sampler2D here');
  const COUNTS = counts || [
    1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 255, 256, 257, 511, 512, 513, 1023, 1024, 2047, 2048, 2049,
    4097, 32768, 65535, 65536,
  ];
  const src = `${hdr}
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <algorithm>
namespace glsl { sampler2D uGradientStops; }
namespace glsl { namespace SA {
${tr(textA)}
} namespace SB {
${tr(textB)}
} }
using namespace glsl;
int main() {
  srand(7); long total = 0, diff = 0;
  const int LW = 2048;
  static float tex[LW * 80 * 4];
  static long codes[65536];
  int counts[] = {${COUNTS.join(', ')}};
  int bases[] = {0, 2045, 3 * 2048 - 7};
  for (int ci = 0; ci < (int)(sizeof(counts) / sizeof(counts[0])); ci++) for (int lay = 0; lay < 2; lay++) for (int var = 0; var < 6; var++) {
    int n = counts[ci]; bool one = lay == 0;
    if (n > 4096 && var != 1 && var != 2) continue;
    int base = bases[(ci + var) % 3];
    bool fine = !one && n > 256;
    const long FULL = fine ? 255L * 255L * 255L : 255L;
    for (int i = 0; i < n; i++) codes[i] = n == 1 ? FULL / 2 : (long)((double)i * FULL / (double)(n - 1));
    if (var >= 1) { for (int i = 0; i < n; i++) codes[i] = ((long)rand() * 32768L + rand()) % (FULL + 1); std::sort(codes, codes + n); }
    if (var == 2 && n >= 3) codes[n / 2] = codes[n / 2 - 1];
    if (var == 3) for (int i = 0; i < n; i++) codes[i] = FULL / 4 + codes[i] / 2;
    if (var == 4 && n >= 4) { codes[1] = codes[0]; codes[n - 1] = codes[n - 2]; }
    if (var == 5) for (int i = 0; i < n; i++) codes[i] = (i * 7) % (FULL + 1);
    int texels = one ? n : 2 * n, rows = (base + texels + LW - 1) / LW;
    memset(tex, 0, sizeof(float) * LW * rows * 4);
    auto put = [&](int i, int r, int g, int b, int a) { float* p = tex + (long)(base + i) * 4; p[0] = r / 255.0f; p[1] = g / 255.0f; p[2] = b / 255.0f; p[3] = a / 255.0f; };
    for (int i = 0; i < n; i++) {
      int r = rand() % 256, g = rand() % 256, b = rand() % 256, a = rand() % 256;
      if (one) put(i, r, g, b, (int)codes[i]);
      else { put(2 * i, r, g, b, a);
        if (fine) put(2 * i + 1, (int)(codes[i] / 65025), (int)((codes[i] / 255) % 255), (int)(codes[i] % 255), 0);
        else put(2 * i + 1, (int)codes[i], 0, 0, 0); }
    }
    uGradientStops.data = tex; uGradientStops.id = 2; uGradientStops.w = LW; uGradientStops.h = rows; uGradientStops.texels = (long)LW * rows;
    int cnt = one ? -n : n;
    auto check = [&](float t) {
      for (int mode = 0; mode < 3; mode++) for (int d = 0; d < 3; d++) {
        vec2 dt = d == 0 ? vec2(0.0f, 0.0f) : d == 1 ? vec2(0.01f, 0.003f) : vec2(-0.07f, 0.02f);
        vec4 x = SA::sampleStops(t, base, cnt, mode, dt), y = SB::sampleStops(t, base, cnt, mode, dt);
        total++; if (memcmp(&x, &y, 16) != 0) { if (diff < 3) printf("  diff n=%d oneTexel=%d var=%d base=%d t=%.9g mode=%d\\n", n, one, var, base, t, mode); diff++; }
      }
      vec4 x = SA::sampleStopsRaw(t, base, cnt), y = SB::sampleStopsRaw(t, base, cnt);
      total++; if (memcmp(&x, &y, 16) != 0) { if (diff < 3) printf("  rawdiff n=%d oneTexel=%d t=%.9g\\n", n, one, t); diff++; }
    };
    for (int k = 0; k <= 2000; k++) check(-0.5f + 2.0f * (float)k / 2000.0f);
    for (int i = 0; i < n; i++) {
      float o;
      if (one) o = tex[(long)(base + i) * 4 + 3];
      else { const float* q = tex + (long)(base + 2 * i + 1) * 4; o = q[0] + q[1] * (1.0f / 255.0f) + q[2] * (1.0f / 65025.0f); }
      check(o); check(std::nextafter(o, 2.0f)); check(std::nextafter(o, -2.0f));
    }
    check(NAN); check(INFINITY); check(-INFINITY); check(0.0f); check(-0.0f); check(1.0f);
  }
  printf("RESULT %ld %ld\\n", total, diff);
  return 0;
}
`;
  const base = path.join(buildDir(), `stops_${process.pid}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(base + '.cpp', src);
  const r = spawnSync(
    C,
    ['-std=c++17', '-O1', ...fpFlags(contract), '-w', '-o', base, base + '.cpp'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0)
    throw new Error(
      'shaderIdentity stops: compile failed:\n' + r.stderr.split('\n').slice(0, 20).join('\n'),
    );
  const q = spawnSync(base, [], { encoding: 'utf8', maxBuffer: 1 << 24 });
  spawnSync('rm', ['-f', base, base + '.cpp']);
  const m = /RESULT (\d+) (\d+)/.exec(q.stdout || '');
  if (!m) throw new Error('shaderIdentity stops: no result\n' + q.stdout + q.stderr);
  return {
    evaluations: +m[1],
    differ: +m[2],
    detail: q.stdout
      .split('\n')
      .filter((l) => l.startsWith('  '))
      .join('\n'),
  };
}
function buildDir() {
  const d = path.join(os.tmpdir(), 'mantle-mainemu');
  mkdirSync(d, { recursive: true });
  return d;
}

// ---- CLI ---------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, FA, FB] = process.argv.slice(2);
  const argv = process.argv.slice(5);
  const opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : null;
  };
  if (!['main', 'bake', 'stops'].includes(mode) || !FA || !FB) {
    console.log(
      'usage: node test/_shaderIdentity.mjs main|bake|stops A.glsl B.glsl [--variants a,b] [--gates a,b] [--quick] [--fma A|B|AB]',
    );
    process.exit(2);
  }
  const textA = readFileSync(FA, 'utf8'),
    textB = readFileSync(FB, 'utf8');
  const quick = argv.includes('--quick');
  // --fma A, B or AB: which arms run fused (the same text as A and B is then a fused-vs-unfused question)
  const fma = opt('--fma') || '',
    contract = fma ? [fma.includes('A'), fma.includes('B')] : undefined;
  const t0 = Date.now();
  let differ = 0;
  if (mode === 'main') {
    const assets = defaultAssets({ quick });
    const res = await compareMain(textA, textB, {
      variants: opt('--variants') ? opt('--variants').split(',') : undefined,
      assets,
      grid: quick ? 10 : 18,
      log: (l) => console.log(l),
      contract,
      bigLog: argv.includes('--big') ? (l) => console.log(l) : null,
    });
    let fr = 0;
    for (const r of res) {
      console.log(
        `${r.differ ? 'FAIL' : 'ok  '} ${r.variant}: ${r.fragments} fragments, ${r.differ} differ${r.differ ? `, ${r.big} by half a level or more (max ${r.max.toExponential(2)})` : ''} (A discarded ${r.discarded})`,
      );
      fr += r.fragments;
      differ += r.differ;
    }
    console.log(
      `${differ ? 'DIFFER' : 'BIT-IDENTICAL'}: ${fr} fragments over ${assets.length} assets, ${res.length} variants, 4 scenarios (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
    );
  } else if (mode === 'bake') {
    const assets = defaultAssets({ quick });
    const r = await compareBake(textA, textB, {
      assets,
      grid: quick ? 10 : 20,
      gates: opt('--gates') ? opt('--gates').split(',').map(Number) : null,
      log: (l) => console.log(l),
      contract,
    });
    differ = r.differ;
    console.log(
      `${differ ? 'DIFFER' : 'BIT-IDENTICAL'}: maskBake main, ${r.fragments} fragments over ${assets.length} assets (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
    );
  } else {
    const r = compareStops(textA, textB);
    differ = r.differ;
    if (r.detail) console.log(r.detail);
    console.log(
      `${differ ? 'DIFFER' : 'BIT-IDENTICAL'}: sampleStops, ${r.evaluations} evaluations, ${r.differ} differ (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
    );
  }
  process.exit(differ ? 1 : 0);
}
