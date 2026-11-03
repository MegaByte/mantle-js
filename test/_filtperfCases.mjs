// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _filtperfCases.mjs -- the shader rewrites of the filter/paint performance pass, each as a
// PASS A/B: one fragment shader's text before the rewrite and after it, run on identical inputs. Shared by
//   * the node smokes, which run both texts on the CPU in float32 (test/_fragEmu.mjs) and compare bit for bit or at
//     8 bits, and count the work each does (texture fetches, calls into named functions);
//   * test/filterPassParityRenderSmoke.mjs, which runs both on the GPU into an RGBA8 target and diffs the readback;
//   * probes/filtperf/passAB.mjs, which times them on the GPU in one page.
// The same file loads in node and in the browser: it only builds data, and names the shader texts by path from the
// package root ('probes/filtperf/pre-*.glsl' for the text before a rewrite, 'src/shaders/generated/*.glsl' for the
// shipped one). A rewrite that moves work to the CPU changes the uniforms, so each side has its own inputs.
//
// A case:
//   { item, name, frag: { old, new },       shader texts by path
//     size: [W, H],                         the target; fragment (x, y) has vUV = ((x + .5) / W, (y + .5) / H)
//     inputs: { old: {uniforms, textures}, new: {uniforms, textures} }
//             a texture is { w, h, u8: Uint8Array (RGBA8, sampled as v / 255) | f32: Float32Array (RGBA32F), linear }
//     tol: 0 | 'ties' | n                   how far apart at 8 bits: identical; 1 LSB only where exact() is a rounding
//                                           tie; at most n LSB
//     exact(x, y, c): number                the exact answer (for 'ties')
//     count: [fn...], calls: { new: [n...] }  functions to count, and how many calls per fragment the new text makes }

import { flipConvolveKernel } from '../src/filterGraph/convolveKernel.js';
import { porterDuffCoefficients, feCompositeMode } from '../src/filterGraph/porterDuff.js';
import { feImageMaps } from '../src/filterGraph/primitives/image.js';

// The 'new' side of a case is always the SHIPPED text, fed what the shipped handler sets -- so when a
// later item changes a shader an earlier item also changed, the earlier item's cases take the current
// uniforms from here and keep comparing its before-text with what ships.
/// What paints.js sets for PaintComposite: its Porter-Duff weights, and each input's own rect map (the identity for inputs
/// covering the output's rect, as these do).
const paintCompositeUniforms = (mode) => ({
  uMode: mode,
  uPD: porterDuffCoefficients(mode),
  uSrcMap: [1, 1, 0, 0],
  uDstMap: [1, 1, 0, 0],
});

// ---- shared input builders ---------------------------------------------------------------------------------------
/// A square grid holding every pairing of the texels in `texels` (src texel, dst texel), padded with zeros.
export function pairGrid(texels) {
  const n = texels.length * texels.length,
    W = Math.ceil(Math.sqrt(n)),
    H = Math.ceil(n / W);
  const src = new Uint8Array(W * H * 4),
    dst = new Uint8Array(W * H * 4),
    pairs = [];
  let i = 0;
  for (const s of texels)
    for (const d of texels) {
      src.set(s, i * 4);
      dst.set(d, i * 4);
      pairs.push([s, d]);
      i++;
    }
  return { W, H, src, dst, pairs };
}
/// Texels for a blend: every alpha in A with every red in R (so rgb > alpha, and rgb at alpha 0, occur -- a
/// non-normalized feConvolveMatrix can produce both), then valid premultiplied texels from a fixed seed.
export function blendTexels() {
  const A = [0, 1, 2, 64, 127, 128, 200, 254, 255],
    R = [0, 1, 100, 200, 255],
    out = [];
  for (const a of A) for (const r of R) out.push([r, (r * 3) % 256, 255 - r, a]);
  const rnd = seeded(12345);
  for (let k = 0; k < 64; k++) {
    const a = rnd(256);
    out.push([rnd(a + 1), rnd(a + 1), rnd(a + 1), a]);
  }
  return out;
}
export function seeded(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % n;
  };
}
/// A premultiplied RGBA8 image with soft edges, flat areas and a few degenerate texels (rgb > alpha).
export function testImage(W, H, seed = 7) {
  const rnd = seeded(seed),
    px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const cx = x - W * 0.45,
        cy = y - H * 0.55,
        r = Math.hypot(cx, cy) / (0.35 * Math.min(W, H));
      let a = r < 0.8 ? 255 : r < 1.2 ? Math.round((255 * (1.2 - r)) / 0.4) : 0;
      if ((x ^ y) % 13 === 0) a = rnd(256);
      const i = (y * W + x) * 4;
      px[i] = rnd(a + 1);
      px[i + 1] = Math.round((a * ((x * 7) % W)) / W);
      px[i + 2] = Math.round((a * y) / H);
      px[i + 3] = a;
      if (x % 29 === 3 && y % 17 === 5) {
        px[i] = 255;
        px[i + 3] = 0;
      } // color at alpha 0
    }
  return px;
}
/// Round-to-nearest 8-bit with a tie test: |v*255 - (k + 1/2)| < 1e-3.
export const onTie = (v) => {
  const x = Math.min(1, Math.max(0, v)) * 255;
  return Math.abs(x - Math.floor(x) - 0.5) < 1e-3;
};

// ---- convolve.frag reads its kernel from a uniform array, and branches on preserveAlpha outside the loops --
// The before-text reads the kernel from a 7-texel RGBA32F row (texelFetch + integer divide + channel if-chain per tap)
// and runs both accumulators on every tap. The new one takes the kernel flipped into a 5-wide uniform array by the
// shipping CPU helper, so the flip is under test too. The kernel sits in row 2 of a 3-row texture on the `old` side
// (rows 0 and 1 hold other values) so a wrong row would show.
function convolveKernelCases() {
  const W = 48,
    H = 40,
    img = testImage(W, H, 3);
  const rnd = seeded(72);
  const signed = (n) => Array.from({ length: n }, () => (rnd(2001) - 1000) / 400);
  const K = [
    {
      name: '3x3 Sobel-X, bias 0.5 (examples/_convolve.svg)',
      ox: 3,
      oy: 3,
      tx: 1,
      ty: 1,
      k: [-1, 0, 1, -2, 0, 2, -1, 0, 1],
      div: 1,
      bias: 0.5,
      edge: 0,
      pa: 0,
    },
    {
      name: '5x5 box, divisor 25',
      ox: 5,
      oy: 5,
      tx: 2,
      ty: 2,
      k: Array(25).fill(1),
      div: 25,
      bias: 0,
      edge: 0,
      pa: 0,
    },
    {
      name: '3x2, target (1,0), divisor 21, bias 0.1, preserveAlpha',
      ox: 3,
      oy: 2,
      tx: 1,
      ty: 0,
      k: [1, 2, 3, 4, 5, 6],
      div: 21,
      bias: 0.1,
      edge: 0,
      pa: 1,
    },
    {
      name: '5x5 signed, target (0,4), wrap',
      ox: 5,
      oy: 5,
      tx: 0,
      ty: 4,
      k: signed(25),
      div: 3,
      bias: 0,
      edge: 1,
      pa: 0,
    },
    {
      name: '5x5 signed, edge none, preserveAlpha',
      ox: 5,
      oy: 5,
      tx: 2,
      ty: 1,
      k: signed(25),
      div: 2,
      bias: -0.05,
      edge: 2,
      pa: 1,
    },
    {
      name: '1x5, edge none',
      ox: 1,
      oy: 5,
      tx: 0,
      ty: 2,
      k: [1, -2, 4, -2, 1],
      div: 2,
      bias: 0,
      edge: 2,
      pa: 0,
    },
    {
      name: '5x3, preserveAlpha, wrap',
      ox: 5,
      oy: 3,
      tx: 4,
      ty: 0,
      k: signed(15),
      div: 1.5,
      bias: 0.2,
      edge: 1,
      pa: 1,
    },
  ];
  return K.map((c) => {
    const kernel = new Float32Array(25);
    kernel.set(c.k);
    const rows = new Float32Array(3 * 28);
    for (let i = 0; i < 56; i++) rows[i] = (((i * 37) % 11) - 5) / 3; // rows 0, 1: other values
    rows.set(kernel, 2 * 28);
    const common = {
      uTexel: [1 / W, 1 / H],
      uInMap: [1, 1, 0, 0],
      uOrder: [c.ox, c.oy],
      uTarget: [c.tx, c.ty],
      uDivisor: c.div,
      uBias: c.bias,
      uEdgeMode: c.edge,
      uPreserveAlpha: c.pa,
    };
    const u = { w: W, h: H, u8: img, linear: false };
    return {
      item: 'convolveKernel',
      name: `convolve.frag ${c.name}`,
      frag: {
        old: 'probes/filtperf/pre-convolveKernel.convolve.frag.glsl',
        new: 'src/shaders/generated/convolve.frag.glsl',
      },
      size: [W, H],
      inputs: {
        old: {
          uniforms: Object.assign({ uKernelRow: 2 }, common),
          textures: { uTex: u, uKernelTex: { w: 7, h: 3, f32: rows } },
        },
        new: {
          uniforms: Object.assign(
            { uKernel: flipConvolveKernel(kernel, 0, c.ox, c.oy, new Float32Array(25)) },
            common,
          ),
          textures: { uTex: u },
        },
      },
      tol: 0,
      taps: c.ox * c.oy,
      preserveAlpha: !!c.pa,
    };
  });
}

/// A gradient stop LUT as resolveStops packs it (colrPaintShared.js): opaque stops take one texel each
/// (rgb, offset) with a negative count, otherwise two (straight rgba, then offset).
function stopsLut(stops) {
  const q = (x) => Math.min(255, Math.max(0, Math.round(x * 255)));
  const opaque = stops.every((st) => q(st.color[3]) === 255);
  const per = opaque ? 1 : 2,
    N = stops.length,
    u8 = new Uint8Array(N * per * 4);
  stops.forEach((st, i) => {
    const c = i * per * 4;
    u8[c] = q(st.color[0]);
    u8[c + 1] = q(st.color[1]);
    u8[c + 2] = q(st.color[2]);
    u8[c + 3] = opaque ? q(st.offset) : q(st.color[3]);
    if (!opaque) u8[c + 4] = q(st.offset);
  });
  return { tex: { w: N * per, h: 1, u8, linear: false }, count: opaque ? -N : N };
}

// ---- the cache blit's uv remap runs per vertex --------------------------------------------------------
// The blit is drawn over a rect of the canvas and reads a canvas-sized texture; the before-text maps the quad's uv into
// the texture per fragment. The map is affine, so the shipped text applies it per vertex and the rasterizer interpolates. The
// GPU side runs each text with its own vertex stage; the CPU side feeds the new fragment stage the mapped uv at the
// fragment center in float32 -- what the interpolation gives, up to its rounding.
function cacheBlitMapCases() {
  const CW = 64,
    CH = 48,
    img = testImage(CW, CH, 9),
    f = Math.fround;
  const out = [];
  for (const [name, rect, tint] of [
    ['whole texture', [0, 0, CW, CH], [1, 1, 1, 1]],
    ['a group rect, opacity 0.6', [10, 6, 40, 30], [0.6, 0.6, 0.6, 0.6]],
    ['an odd rect', [3, 17, 51, 29], [1, 1, 1, 1]],
  ]) {
    const [gx, gy, gw, gh] = rect;
    const m = [gw / CW, gh / CH, gx / CW, gy / CH];
    const tex = { uCacheTex: { w: CW, h: CH, u8: img, linear: true } };
    const u = { uInMap: m, uTint: tint };
    const mapped = (x, y, W, H) => ({
      vUV: [f(f(f((x + 0.5) / W) * f(m[0])) + f(m[2])), f(f(f((y + 0.5) / H) * f(m[1])) + f(m[3]))],
    });
    out.push({
      item: 'cacheBlitMap',
      name: `cacheBlit ${name}`,
      vert: {
        old: 'probes/filtperf/pre-cacheBlitMap.cacheBlit.vert.glsl',
        new: 'src/shaders/generated/cacheBlit.vert.glsl',
      },
      frag: {
        old: 'probes/filtperf/pre-cacheBlitMap.cacheBlit.frag.glsl',
        new: 'src/shaders/generated/cacheBlit.frag.glsl',
      },
      size: [gw, gh],
      tol: 0,
      inputs: {
        old: { uniforms: u, textures: tex },
        new: { uniforms: u, textures: tex, varyings: mapped },
      },
    });
  }
  return out;
}

// ---- the box blur decides its pairing once, not every iteration -------------------------------------
// The before-text's loop re-tests whether each fetch is a pair or the odd radius's last single texel, and counts the
// taps as it goes; the radius decides both. Same fetches, same order of accumulation: bit-identical, at every radius
// the cap allows and past it (the cap's behavior at 257+ is kept).
function boxBlurCases() {
  const W = 64,
    H = 48,
    img = testImage(W, H, 13);
  const u = { uTex: { w: W, h: H, u8: img, linear: true } };
  const out = [];
  for (const r of [1, 2, 3, 8, 21, 255, 256, 257, 300]) {
    for (const dir of r === 21
      ? [
          [1, 0],
          [0, 1],
        ]
      : [[1, 0]]) {
      const io = {
        uniforms: { uTexel: [1 / W, 1 / H], uInMap: [1, 1, 0, 0], uDir: dir, uRadius: r },
        textures: u,
      };
      out.push({
        item: 'boxBlur',
        name: `boxBlur radius ${r}, ${dir[0] ? 'horizontal' : 'vertical'}`,
        frag: {
          old: 'probes/filtperf/pre-boxBlur.boxBlur.frag.glsl',
          new: 'src/shaders/generated/boxBlur.frag.glsl',
        },
        size: [W, H],
        tol: 0,
        inputs: { old: io, new: io },
      });
    }
  }
  return out;
}

// ---- feMorphology picks its loop by operator instead of branching inside it -------------------------
function morphologyCases() {
  const W = 64,
    H = 48,
    img = testImage(W, H, 17);
  const u = { uTex: { w: W, h: H, u8: img, linear: false } };
  const out = [];
  for (const op of [0, 1]) {
    for (const [r, dir] of [
      [0.4, [1, 0]],
      [1, [1, 0]],
      [3.2, [0, 1]],
      [8, [1, 0]],
      [48, [0, 1]],
      [80, [1, 0]],
    ]) {
      const io = {
        uniforms: {
          uTexel: [1 / W, 1 / H],
          uInMap: [1, 1, 0, 0],
          uDir: dir,
          uRadius: r,
          uOperator: op,
        },
        textures: u,
      };
      out.push({
        item: 'morphology',
        name: `morph ${op ? 'dilate' : 'erode'} radius ${r}, ${dir[0] ? 'horizontal' : 'vertical'}`,
        frag: {
          old: 'probes/filtperf/pre-morphology.morph.frag.glsl',
          new: 'src/shaders/generated/morph.frag.glsl',
        },
        size: [W, H],
        tol: 0,
        inputs: { old: io, new: io },
      });
    }
  }
  return out;
}

// ---- feLighting drops the unused center tap --------------------------------------------------------------
// The before-text fetches a center tap neither kernel weights. Both sides take the same uniforms.
function lightingCases() {
  const W = 56,
    H = 44,
    img = testImage(W, H, 19);
  const u = { uIn: { w: W, h: H, u8: img, linear: false } };
  const deg = Math.PI / 180;
  const distant = (az, el) => [
    Math.cos(el * deg) * Math.cos(az * deg),
    Math.cos(el * deg) * Math.sin(az * deg),
    Math.sin(el * deg),
  ];
  const LIGHTS = [
    ['distant az 225 el 35', 0, distant(225, 35), [0, 0, 0], 1, 2],
    ['distant az 60 el 70', 0, distant(60, 70), [0, 0, 0], 1, 2],
    ['point', 1, [18, 12, 40], [0, 0, 0], 1, 2],
    ['spot with a 40 degree cone', 2, [10, 8, 60], [30, 26, 0], 4, Math.cos(40 * deg)],
    ['spot with no cone', 2, [44, 30, 50], [20, 18, 0], 1.5, 2],
  ];
  const out = [];
  for (const [name, type, lp, sa, sexp, cone] of LIGHTS) {
    for (const mode of [0, 1]) {
      const common = {
        uTexel: [1 / W, 1 / H],
        uInMap: [1, 1, 0, 0],
        uOutRect: [0, 0, W, H],
        uWorldScale: [1, 1],
        uSurfaceScale: 3,
        uK: 1.2,
        uExponent: 20,
        uLightColor: [1, 0.9, 0.8, 1],
        uMode: mode,
        uLightType: type,
        uLightPos: lp,
        uSpotExp: sexp,
        uSpotCosCone: cone,
      };
      out.push({
        item: 'lighting',
        name: `feLighting ${mode ? 'specular' : 'diffuse'}, ${name}`,
        frag: {
          old: 'probes/filtperf/pre-lighting.feLighting.frag.glsl',
          new: 'src/shaders/generated/feLighting.frag.glsl',
        },
        size: [W, H],
        tol: { lsb: 1, outliers: 0.01 },
        inputs: {
          old: { uniforms: Object.assign({ uSpotAt: sa }, common), textures: u },
          new: { uniforms: Object.assign({ uSpotAt: sa }, common), textures: u },
        },
      });
    }
  }
  return out;
}

// ---- five small ones -----------------------------------------------------------------------------------
// feDisplacementMap picks channels by a one-hot dot product; feImage's aspect and atlas maps are composed on the
// CPU; feTile loses its dead negative-fract fixups; the Porter-Duff dispatch becomes coefficient uniforms
// (feComposite, PaintComposite); sampleStops stops re-testing a zero stop count. All but feImage are exact.
function compositingCases() {
  const out = [];
  const W = 48,
    H = 40;
  const img = testImage(W, H, 23),
    map = testImage(W, H, 29);
  const u8 = (px, lin = false) => ({ w: W, h: H, u8: px, linear: lin });
  // feDisplacementMap: every pairing of X and Y channel, a scale that reaches past the edge.
  for (const [xc, yc] of [
    [0, 1],
    [3, 2],
    [1, 3],
    [2, 0],
    [3, 3],
  ]) {
    const common = {
      uScale: 18,
      uTexel: [1 / W, 1 / H],
      uIn1Map: [1, 1, 0, 0],
      uIn2Map: [1, 1, 0, 0],
    };
    const sel = (c) => [0, 1, 2, 3].map((i) => (i === c ? 1 : 0));
    const tex = { uIn1: u8(img, true), uIn2: u8(map) };
    out.push({
      item: 'compositing',
      name: `feDisplacementMap channels (${'RGBA'[xc]}, ${'RGBA'[yc]})`,
      frag: {
        old: 'probes/filtperf/pre-compositing.feDisplacementMap.frag.glsl',
        new: 'src/shaders/generated/feDisplacementMap.frag.glsl',
      },
      size: [W, H],
      tol: 0,
      inputs: {
        old: { uniforms: Object.assign({ uXChan: xc, uYChan: yc }, common), textures: tex },
        new: { uniforms: Object.assign({ uXSel: sel(xc), uYSel: sel(yc) }, common), textures: tex },
      },
    });
  }
  // feImage: a slot in a taller atlas, the whole region or a sub-rect of it, 'none' and 'meet', wide and tall images.
  const AW = 64,
    AH = 96,
    atlas = testImage(AW, AH, 31);
  // The shipped maps read the slot's rows bottom-up (the image's top at the region's top), and the text before the
  // rewrite reads them top-down. So the `old` side reads the atlas MIRRORED
  // vertically, with its slot moved to the mirrored rows: the same texels at the same fragments,
  // which is what the rewrite's composition is held to.
  const mirrored = new Uint8Array(atlas.length);
  for (let y = 0; y < AH; y++)
    mirrored.set(atlas.subarray((AH - 1 - y) * AW * 4, (AH - y) * AW * 4), y * AW * 4);
  for (const [name, slot, region, par] of [
    ['wide image, meet, whole region', [20, 60, 30], [1, 1, 0, 0], 1],
    ['tall image, meet, a sub-rect', [4, 24, 70], [0.5, 0.4, 0.25, 0.3], 1],
    ['wide image, none', [20, 60, 30], [0.8, 0.9, 0.1, 0.05], 0],
    ['square image, meet', [30, 40, 40], [1, 1, 0, 0], 1],
  ]) {
    const m = feImageMaps(region, par, slot, [AW, AH]);
    out.push({
      item: 'compositing',
      name: `feImage ${name}`,
      frag: {
        old: 'probes/filtperf/pre-compositing.feImage.frag.glsl',
        new: 'src/shaders/generated/feImage.frag.glsl',
      },
      size: [W, H],
      tol: { lsb: 1, outliers: 0.01 },
      inputs: {
        old: {
          uniforms: {
            uAtlasSize: [AW, AH],
            uAtlasRect: [AH - slot[0] - slot[2], slot[1], slot[2], 0],
            uPreserveAR: par,
            uRegionMap: region,
          },
          textures: { uIn: { w: AW, h: AH, u8: mirrored, linear: true } },
        },
        new: {
          uniforms: { uImgMap: m.img, uAtlasMap: m.atlas },
          textures: { uIn: { w: AW, h: AH, u8: atlas, linear: true } },
        },
      },
    });
  }
  // feTile: maps that wrap, including negative coordinates.
  for (const m of [
    [1, 1, 0, 0],
    [2.5, 1.75, -0.7, -0.3],
    [3.2, 3.2, -1.63, 0.41],
  ]) {
    // The shipped tile is the input's subregion, placed by two CPU maps: A takes vUV to the tile
    // coordinate (its offset already reduced to [0,1)), B takes that to the texture's uv. A subregion that is the
    // whole texture (B = identity) tiles exactly as the before-text's whole-texture fract(mapIn(vUV)) does.
    // The offset is reduced from the float32 the `old` side holds, exactly (a float32 difference of nearby values), as the CPU's
    // double-precision reduction does for any offset a float32 holds.
    const fractF32 = (x) => {
      const f = Math.fround(x);
      return f - Math.floor(f);
    };
    const tex = { uTex: u8(img) };
    out.push({
      item: 'compositing',
      name: `feTile map (${m.join(', ')})`,
      frag: {
        old: 'probes/filtperf/pre-compositing.feTile.frag.glsl',
        new: 'src/shaders/generated/feTile.frag.glsl',
      },
      size: [W, H],
      tol: 0,
      inputs: {
        old: { uniforms: { uInMap: m }, textures: tex },
        new: {
          uniforms: { uTileA: [m[0], m[1], fractF32(m[2]), fractF32(m[3])], uTileB: [1, 1, 0, 0] },
          textures: tex,
        },
      },
    });
  }
  // feComposite's operators (and arithmetic, unchanged) and PaintComposite's Porter-Duff half, over texel pairs.
  const g = pairGrid(blendTexels());
  const pairTex = (a, b) => ({
    [a]: { w: g.W, h: g.H, u8: g.src },
    [b]: { w: g.W, h: g.H, u8: g.dst },
  });
  for (const op of [0, 1, 2, 3, 4, 5]) {
    const common = {
      uIn1Map: [1, 1, 0, 0],
      uIn2Map: [1, 1, 0, 0],
      uOp: op,
      uK: [0.3, 0.5, 0.4, -0.1],
    };
    const tex = pairTex('uIn1', 'uIn2');
    out.push({
      item: 'compositing',
      name: `feComposite op ${['over', 'in', 'out', 'atop', 'xor', 'arithmetic'][op]}`,
      frag: {
        old: 'probes/filtperf/pre-compositing.feComposite.frag.glsl',
        new: 'src/shaders/generated/feComposite.frag.glsl',
      },
      size: [g.W, g.H],
      tol: 0,
      inputs: {
        old: { uniforms: common, textures: tex },
        new: {
          uniforms: Object.assign({ uPD: porterDuffCoefficients(feCompositeMode(op)) }, common),
          textures: tex,
        },
      },
    });
  }
  for (let mode = 0; mode <= 12; mode++) {
    const tex = pairTex('uSrc', 'uDst');
    out.push({
      item: 'compositing',
      name: `paintComposite Porter-Duff mode ${mode}`,
      frag: {
        old: 'probes/filtperf/pre-compositing.paintComposite.frag.glsl',
        new: 'src/shaders/generated/paintComposite.frag.glsl',
      },
      size: [g.W, g.H],
      tol: 0,
      inputs: {
        old: { uniforms: { uMode: mode }, textures: tex },
        new: { uniforms: paintCompositeUniforms(mode), textures: tex },
      },
    });
  }
  // sampleStops through the linear gradient: no stops, one stop, opaque and translucent ramps, every extend mode.
  const soft = stopsLut([
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 0.4, color: [1, 0.8, 0, 0.6] },
    { offset: 1, color: [0, 0.2, 1, 1] },
  ]);
  const opaque = stopsLut([
    { offset: 0, color: [0, 0, 0, 1] },
    { offset: 1, color: [0.2, 0.9, 0.4, 1] },
  ]);
  const one = stopsLut([{ offset: 0.5, color: [0.3, 0.6, 0.9, 1] }]);
  for (const [name, lut, count] of [
    ['no stops', soft, 0],
    ['one stop', one, one.count],
    ['opaque ramp', opaque, opaque.count],
    ['translucent ramp', soft, soft.count],
  ]) {
    for (const ext of [0, 1, 2]) {
      const common = {
        uStopsOffset: 0,
        uStopCount: count,
        uExtend: ext,
        uP0: [30, 40],
        uP1: [90, 70],
        uP2: [0, 100],
      };
      // The before-text's q = uBboxOrigin + vUV * uBboxSize is the same affine as a paint map.
      const io = {
        uniforms: Object.assign({ uBboxOrigin: [10, 20], uBboxSize: [128, 96] }, common),
        textures: { uGradientStops: lut.tex },
      };
      // (uStopsChrome: this program's straight mix, the one the before-text has. The rewrite under test is the stop walk; its default, a COLR gradient's premultiplied mix, has its own check.)
      const ioNew = {
        uniforms: Object.assign(
          { uPaintMapX: [128, 0, 10], uPaintMapY: [0, 96, 20], uStopsChrome: 1 },
          common,
        ),
        textures: { uGradientStops: lut.tex },
      };
      out.push({
        item: 'compositing',
        name: `sampleStops, ${name}, extend ${['pad', 'repeat', 'reflect'][ext]}`,
        frag: {
          old: 'probes/filtperf/pre-compositing.paintLinearGradient.frag.glsl',
          new: 'src/shaders/generated/paintLinearGradient.frag.glsl',
        },
        size: [64, 48],
        tol: 0,
        inputs: { old: io, new: ioNew },
      });
    }
  }
  return out;
}

/// Every case, by item. Built lazily: some inputs are large.
export function filtperfCases(items = null) {
  const all = {
    convolveKernel: convolveKernelCases,
    cacheBlitMap: cacheBlitMapCases,
    boxBlur: boxBlurCases,
    morphology: morphologyCases,
    lighting: lightingCases,
    compositing: compositingCases,
  };
  return Object.keys(all)
    .filter((k) => !items || items.includes(k))
    .flatMap((k) => all[k]());
}
