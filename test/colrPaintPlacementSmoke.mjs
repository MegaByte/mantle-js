// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrPaintPlacementSmoke — a COLRv1 paint lands where its coordinates say, INSIDE the glyph.
//
// THE TRAP. A COLR paint shader that maps its output as if each node's target covered the node's BOX (a
// gradient computing q = uBboxOrigin + vUV * uBboxSize) disagrees with a COLR leaf that renders a node
// into a larger target: vUV spans that target, so the gradient is squeezed into the box's scale, spread
// across the target, and (the box y down, vUV y up) flipped. A red-to-blue gradient across a glyph reads
// purple at both ends and a vertical one runs backwards (on the GPU on both routes:
// probes/filtperf/colrGradientPlacement.mjs). A glyph from a real font has a second trap on top: a graph
// left in the font's design grid (y up, at the origin) and read as bundle em never meets the glyph's
// layout at all.
//
// HOW, with no GPU: the real renderer draws a 64 px square carrying a synthetic COLR graph, headless on
// test/_fakeGl.mjs, which records every clear, draw and blit with its program, uniforms, bound textures,
// viewport and target. The frame is then REPLAYED on the CPU: each COLR pass (gradients, PaintTransform,
// PaintGlyph, the final composite) runs its generated shader in test/_fragEmu.mjs, in float32, with the
// uniforms and textures the renderer bound, into buffers the size of its target. The one pass it cannot
// run is the fill that renders the glyph's silhouette; the replay substitutes the square's exact coverage.
// The colors inside the square are then held to the gradient's own definition -- an exact expectation,
// computed here from the case's coordinates, not from the renderer.
//
// Cases, on the classic route and the unified one:
//   - a horizontal and a vertical gradient given in bundle em (a bare graph), as the GPU probe draws them;
//   - a gradient given in a glyph's DESIGN GRID (y up) with the entry's `placement`, as TextRun emits it;
//   - the same through a paint-space PaintTransform (a 90 degree rotation about the glyph's center);
//   - a sweep in the design grid (its angles are counter-clockwise in a y-up grid);
//   - the horizontal gradient under a world matrix that moves the draw 32 px right;
//   - a COLRv1 FONT (test/font/_colrFontFixture.mjs colrV1GlyphGrad: 'h' | 'v' | 'sweep', one gradient
//     clipped by a square glyph) drawn through createTextBundle at half the canvas -- the whole chain:
//     its ColorLine stops, their LUT, the graph's placement, the leaf's rects.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { hasCxx, buildFragEmu } from './_fragEmu.mjs';
import { buildColrTestFont } from './font/_colrFontFixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer, createTextBundle } =
  await import('../src/index.js');
const { SHADER_FILENAMES } = await import('../src/shaders/index.js');
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { registerColorEmojiReaders } = await import('../src/font/color/index.js');
registerColorEmojiReaders();

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const N = 256;
const SQ = [100, 100, 164, 164]; // the square, canvas px (x0, y0, x1, y1), y down
const SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<rect x="${SQ[0]}" y="${SQ[1]}" width="${SQ[2] - SQ[0]}" height="${SQ[3] - SQ[1]}" fill="#0f0"/></svg>`;
const RED = [1, 0, 0, 1],
  BLUE = [0, 0, 1, 1];
const STOPS = [
  { offset: 0, color: RED },
  { offset: 1, color: BLUE },
];
// The glyph's design grid, y up: (0, 0) is the square's bottom-left, (1, 1) its top-right -- in bundle em,
// which the premise check below pins to canvas px.
const PLACE = [SQ[2] - SQ[0], 0, 0, -(SQ[3] - SQ[1]), SQ[0], SQ[3]];
const design = (x, y) => [(x - SQ[0]) / (SQ[2] - SQ[0]), (SQ[3] - y) / (SQ[3] - SQ[1])];
const lin = (p0, p1) => ({
  type: 'PaintLinearGradient',
  inputs: [],
  params: {
    p0,
    p1,
    p2: [p0[0] - (p1[1] - p0[1]), p0[1] + (p1[0] - p0[0])],
    extend: 0,
    stops: STOPS,
  },
});
const glyph = (inp) => ({ type: 'PaintGlyph', inputs: [inp], params: { glyphId: 1 } });
const mid = (SQ[1] + SQ[3]) / 2,
  midX = (SQ[0] + SQ[2]) / 2;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const CASES = [
  {
    name: 'horizontal gradient in bundle em',
    graph: { nodes: [lin([SQ[0], mid], [SQ[2], mid]), glyph(0)], rootOut: 1 },
    t: (x, y) => (x - SQ[0]) / (SQ[2] - SQ[0]),
  },
  {
    name: 'vertical gradient in bundle em',
    graph: { nodes: [lin([midX, SQ[1]], [midX, SQ[3]]), glyph(0)], rootOut: 1 },
    t: (x, y) => (y - SQ[1]) / (SQ[3] - SQ[1]),
  },
  {
    name: 'vertical gradient in the design grid (y up), placed',
    entry: {
      graph: { nodes: [lin([0.5, 0], [0.5, 1]), glyph(0)], rootOut: 1 },
      masks: {},
      placement: PLACE,
    },
    t: (x, y) => design(x, y)[1],
  },
  {
    name: 'horizontal gradient rotated 90 degrees about the center by a design-grid PaintTransform',
    entry: {
      graph: {
        nodes: [
          lin([0, 0.5], [1, 0.5]),
          { type: 'PaintTransform', inputs: [0], params: { affine: [0, 1, -1, 0, 1, 0] } },
          glyph(1),
        ],
        rootOut: 2,
      },
      masks: {},
      placement: PLACE,
    },
    // A counter-clockwise quarter turn in a y-up grid carries the axis's +x end to the top.
    t: (x, y) => design(x, y)[1],
  },
  {
    name: 'sweep in the design grid (counter-clockwise from +x, y up)',
    entry: {
      graph: {
        nodes: [
          {
            type: 'PaintSweepGradient',
            inputs: [],
            params: { center: [0.5, 0.5], startAngle: 0, endAngle: 360, extend: 0, stops: STOPS },
          },
          glyph(0),
        ],
        rootOut: 1,
      },
      masks: {},
      placement: PLACE,
    },
    t: (x, y) => {
      const d = design(x, y);
      let a = (Math.atan2(d[1] - 0.5, d[0] - 0.5) * 180) / Math.PI;
      if (a < 0) a += 360;
      return a / 360;
    },
    // Clear of the seam at 0 / 360 degrees (the +x axis), where a pixel may land either side.
    skip: (x, y) => {
      const d = design(x, y);
      return d[0] > 0.5 && Math.abs(d[1] - 0.5) < 0.1;
    },
  },
  {
    name: 'horizontal gradient under a world matrix (32 px right)',
    graph: { nodes: [lin([SQ[0], mid], [SQ[2], mid]), glyph(0)], rootOut: 1 },
    world: [1, 0, 0, 0, 1, 0, 0.25, 0, 1],
    sil: [SQ[0] + 32, SQ[1], SQ[2] + 32, SQ[3]],
    t: (x, y) => (x - SQ[0] - 32) / (SQ[2] - SQ[0]),
  },
];
// The COLRv1 font's glyph is a square, so the text bundle's content box is the glyph's, the fit fills the
// canvas with it, and a world scale of 0.5 leaves it on the middle half: canvas px 64..192.
const TSQ = [64, 64, 192, 192];
const tUp = (x, y) => (TSQ[3] - y) / (TSQ[3] - TSQ[1]);
for (const kind of ['h', 'v', 'sweep']) {
  CASES.push({
    name: `COLRv1 font, ${kind === 'sweep' ? 'sweep' : kind === 'h' ? 'horizontal' : 'vertical'} gradient clipped by a square glyph, through createTextBundle`,
    font: kind,
    world: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1],
    sil: TSQ,
    t:
      kind === 'h'
        ? (x, y) => (x - TSQ[0]) / (TSQ[2] - TSQ[0])
        : kind === 'v'
          ? tUp // red at the bottom: the font's grid is y up
          : (x, y) => {
              let a = (Math.atan2(128 - y, x - 128) * 180) / Math.PI;
              if (a < 0) a += 360;
              return a / 360;
            },
    skip: kind === 'sweep' ? (x, y) => x > 128 && Math.abs(y - 128) < 8 : null,
  });
}

// ---- the headless render, with the GL calls the replay needs recorded ----
async function render(c, route) {
  const F = createFakeGl({ width: N, height: N });
  const S = { unit: 0, bound: new Map(), info: new Map(), frame: 0 };
  const gl = new Proxy(
    {},
    {
      get(_t, k) {
        const v = F.gl[k];
        if (k === 'activeTexture')
          return (u) => {
            S.unit = u - F.gl.TEXTURE0;
            return v(u);
          };
        if (k === 'bindTexture')
          return (t, tex) => {
            if (t === F.gl.TEXTURE_2D) S.bound.set(S.unit, tex);
            return v(t, tex);
          };
        if (k === 'texImage2D') {
          return (...a) => {
            const tex = S.bound.get(S.unit);
            if (tex && a.length >= 9) S.info.set(tex, { w: a[3], h: a[4], data: a[8] || null });
            return v(...a);
          };
        }
        if (k === 'clearColor')
          return (...col) => {
            F.log.push({ op: 'clearColor', frame: S.frame, v: col });
          };
        return v;
      },
    },
  );
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  let b, draw, em;
  if (c.font) {
    const font = new MantleFontAsset(
      buildColrTestFont({ codepoint: 0x41, colrV1GlyphGrad: c.font }),
    );
    draw = await createTextBundle(gl, {
      font,
      text: 'A',
      style: { fontSize: 1, fill: [0, 0, 0, 1] },
    });
    b = draw.bundle;
    const op = b.drawList.filter((o) => o.kind === 'fillShape' && o.colrGraphId === 1)[0];
    const mb = op ? op.shapeIdx * b.metaFloatsPerShape : 0;
    em = op ? Array.from(b.metaFloats.slice(mb, mb + 4)) : [];
  } else {
    b = draw = createBundle(gl, await importSvg(SVG, { preserveViewport: true }));
    const op = b.drawList.filter((o) => o.kind === 'fillShape').pop();
    const mb = op.shapeIdx * b.metaFloatsPerShape;
    em = Array.from(b.metaFloats.slice(mb, mb + 4));
    b.colrGraphs = [c.entry || c.graph];
    op.colrGraphId = 1;
  }
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* the stats report it */
    }
  }
  R.setViewport(N, N);
  const FRAMES = 2;
  const before = Object.assign({}, R.debugStats);
  for (let i = 0; i < FRAMES; i++) {
    S.frame = i;
    F.setFrame(i);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(draw, c.world ? { worldMatrix: c.world } : {});
    R.endFrame();
  }
  const leaves = (R.debugStats.unifiedColrLeaves | 0) - (before.unifiedColrLeaves | 0);
  return { F, S, frame: FRAMES - 1, em, gBB: Array.from(b.globalBBox), leaves };
}

// ---- the replay ----
const FILE_OF = new Map(SHADER_FILENAMES);
const _emu = new Map();
const emuFor = (key) => {
  if (!_emu.has(key))
    _emu.set(
      key,
      buildFragEmu(
        readFileSync(path.join(ROOT, 'src/shaders/generated', FILE_OF.get(key)), 'utf8'),
      ),
    );
  return _emu.get(key);
};
const EMULATED = new Set([
  'paintLinearGradFrag',
  'paintRadialGradFrag',
  'paintSweepGradFrag',
  'paintTransformFrag',
  'paintGlyphFrag',
  'paintCompositeFrag',
  'feCompositeFrag',
  'cacheBlitFrag',
]);

function replay({ F, S, frame }, sil) {
  const COLOR = F.gl.COLOR_BUFFER_BIT;
  const bufs = new Map(); // texture (or 'canvas') -> { w, h, px: Float32Array }
  const bufOf = (tex) => {
    if (!tex) {
      if (!bufs.has('canvas')) bufs.set('canvas', { w: N, h: N, px: new Float32Array(N * N * 4) });
      return bufs.get('canvas');
    }
    if (!bufs.has(tex)) {
      const inf = S.info.get(tex);
      if (!inf) return null;
      const px = new Float32Array(inf.w * inf.h * 4);
      if (inf.data && inf.data.length >= px.length) {
        const scale = inf.data instanceof Uint8Array ? 1 / 255 : 1;
        for (let i = 0; i < px.length; i++) px[i] = inf.data[i] * scale;
      }
      bufs.set(tex, { w: inf.w, h: inf.h, px, data: !!inf.data });
    }
    return bufs.get(tex);
  };
  const target = (fbo) => (fbo ? bufOf(F.colorOf(fbo)) : bufOf(null));
  let cc = [0, 0, 0, 0];
  const skipped = new Map(),
    silhouettes = new Set();
  for (const e of F.log) {
    if (e.frame !== frame) continue;
    if (e.op === 'clearColor') {
      cc = e.v;
      continue;
    }
    if (e.op === 'clear') {
      if (!(e.mask & COLOR)) continue;
      const t = target(e.fbo);
      if (!t) continue;
      const [sx, sy, sw, sh] = e.sc || [0, 0, t.w, t.h];
      for (let y = Math.max(0, sy); y < Math.min(t.h, sy + sh); y++) {
        for (let x = Math.max(0, sx); x < Math.min(t.w, sx + sw); x++)
          t.px.set(cc, (y * t.w + x) * 4);
      }
      continue;
    }
    if (e.op === 'blit') {
      const [sx0, sy0, sx1, sy1, dx0, dy0] = e.args;
      const s = target(e.src),
        d = target(e.dst);
      if (!s || !d) continue;
      for (let y = 0; y < sy1 - sy0; y++)
        for (let x = 0; x < sx1 - sx0; x++) {
          const si = ((sy0 + y) * s.w + sx0 + x) * 4,
            di = ((dy0 + y) * d.w + dx0 + x) * 4;
          if (sx0 + x < s.w && sy0 + y < s.h && dx0 + x < d.w && dy0 + y < d.h)
            d.px.set(s.px.subarray(si, si + 4), di);
        }
      continue;
    }
    if (e.op !== 'draw') continue;
    const keys = [...F.progKeys(e.prog)];
    const frag = keys.find((k) => k.endsWith('Frag'));
    const t = target(e.fbo);
    if (!frag || !EMULATED.has(frag)) {
      // A fill that renders a silhouette into an offscreen target: the square's exact coverage stands in.
      if (e.fbo && t) {
        silhouettes.add(e.fbo);
        t.px.fill(0);
        for (let y = sil[1]; y < sil[3]; y++)
          for (let x = sil[0]; x < sil[2]; x++) {
            if (x >= 0 && x < t.w && y >= 0 && y < t.h)
              t.px.set([0, 0, 0, 1], ((N - 1 - y) * t.w + x) * 4);
          }
      } else skipped.set(frag || '?', (skipped.get(frag || '?') | 0) + 1);
      continue;
    }
    if (!t) throw new Error(`replay: no target for a ${frag} draw`);
    const emu = emuFor(frag);
    const textures = {};
    for (const s of emu.samplers) {
      const tex = e.units[e.uni[s] | 0];
      const bb = tex && bufOf(tex);
      if (bb) textures[s] = { w: bb.w, h: bb.h, data: bb.px, linear: !bb.data };
    }
    const uniforms = {};
    for (const u of emu.uniforms) if (e.uni[u] !== undefined) uniforms[u] = e.uni[u];
    // (this checks placement, with a straight color line as its oracle: the straight mix. How a COLR line interpolates is colrInterpolationRenderSmoke's)
    if (emu.uniforms.includes('uStopsChrome')) uniforms.uStopsChrome = 1;
    const [vx, vy, vw, vh] = e.vp;
    const m = frag === 'cacheBlitFrag' ? e.uni.uInMap || [1, 1, 0, 0] : [1, 1, 0, 0]; // cacheBlit.vert maps per vertex
    const frags = [],
      at = [];
    for (let j = 0; j < vh; j++)
      for (let i = 0; i < vw; i++) {
        const X = vx + i,
          Y = vy + j;
        if (X < 0 || Y < 0 || X >= t.w || Y >= t.h) continue;
        if (
          e.sc &&
          (X < e.sc[0] || Y < e.sc[1] || X >= e.sc[0] + e.sc[2] || Y >= e.sc[1] + e.sc[3])
        )
          continue;
        const u = (i + 0.5) / vw,
          v = (j + 0.5) / vh;
        frags.push({ vUV: [u * m[0] + m[2], v * m[1] + m[3]] });
        at.push((Y * t.w + X) * 4);
      }
    const out = emu.run({ uniforms, textures, frags });
    const blend = e.blend ? e.blend.join(',') : null;
    if (blend && blend !== 'ONE,ONE_MINUS_SRC_ALPHA')
      throw new Error(`replay: blend ${blend} on ${frag}`);
    for (let k = 0; k < frags.length; k++) {
      const o = k * emu.stride,
        p = at[k];
      if (out[o + 4]) continue; // discarded
      if (!blend) {
        for (let q = 0; q < 4; q++) t.px[p + q] = out[o + q];
        continue;
      }
      const ia = 1 - out[o + 3];
      for (let q = 0; q < 4; q++) t.px[p + q] = out[o + q] + t.px[p + q] * ia;
    }
  }
  return { canvas: bufOf(null), skipped, silhouettes: silhouettes.size };
}

const lerp = (t) => RED.map((r, i) => r + (BLUE[i] - r) * t);
for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  for (const route of ['none', 'lb']) {
    const r = await render(c, route);
    // The premise the expectations rest on. A synthetic case: bundle em IS canvas px (a viewBox the canvas's
    // size, the square where the SVG put it). A font case: the glyph's box IS the bundle's content box (so
    // the fit puts it on the whole canvas, and the world matrix on the middle half), and it is square.
    const premise = c.font
      ? r.em.length === 4 &&
        Math.abs(r.em[2] - r.em[0] - r.gBB[2]) < 1e-9 &&
        Math.abs(r.em[3] - r.em[1] - r.gBB[3]) < 1e-9 &&
        Math.abs(r.gBB[2] - r.gBB[3]) < 1e-9
      : r.gBB.join() === `0,0,${N},${N}` && r.em.join() === SQ.join();
    if (!premise) {
      ok(
        false,
        `route ${route}: premise -- the glyph's box (${r.em}) against the bundle's (${r.gBB})`,
      );
      continue;
    }
    // The unified route counts the COLR leaves it interrupts for (the glyph is the bundle's only shape, so
    // there is no other fill for it to draw).
    if (route === 'lb')
      ok(r.leaves > 0, `route lb: the unified route served the COLR leaf (leaves +${r.leaves})`);
    else
      ok(
        r.leaves === 0,
        `route none: the classic route served it (unified COLR leaves +${r.leaves})`,
      );
    const sil = c.sil || SQ;
    const { canvas, skipped, silhouettes } = replay(r, sil);
    if (!silhouettes) {
      ok(false, `route ${route}: no silhouette render found to stand in for`);
      continue;
    }
    // Every other pixel 3 px or more inside the glyph, against the gradient's own definition.
    let worst = 0,
      where = null,
      n = 0;
    for (let y = sil[1] + 3; y < sil[3] - 3; y += 2)
      for (let x = sil[0] + 3; x < sil[2] - 3; x += 2) {
        const cx = x + 0.5,
          cy = y + 0.5;
        if (c.skip && c.skip(cx, cy)) continue;
        const want = lerp(clamp01(c.t(cx, cy)));
        const p = ((N - 1 - y) * N + x) * 4;
        const got = Array.from(canvas.px.subarray(p, p + 4));
        const d = Math.max(...got.map((g, i) => Math.abs(g - want[i])));
        n++;
        if (d > worst) {
          worst = d;
          where = {
            x,
            y,
            got: got.map((g) => Math.round(g * 255)),
            want: want.map((w) => Math.round(w * 255)),
          };
        }
      }
    // The ends, as the GPU probe reads them: 4 px inside each edge.
    const px = (x, y) => {
      const p = ((N - 1 - y) * N + x) * 4;
      return Array.from(canvas.px.subarray(p, p + 4)).map((g) => Math.round(g * 255));
    };
    const my = (sil[1] + sil[3]) >> 1,
      mx = (sil[0] + sil[2]) >> 1;
    const ends = `left ${px(sil[0] + 4, my)} right ${px(sil[2] - 5, my)} top ${px(mx, sil[1] + 4)} bottom ${px(mx, sil[3] - 5)}`;
    ok(
      worst <= 1.5 / 255,
      `route ${route}: ${n} pixels inside the glyph match the gradient to ${(worst * 255).toFixed(2)}/255 (${ends})` +
        (worst > 1.5 / 255
          ? ` -- worst at (${where.x}, ${where.y}): got rgba(${where.got}) want rgba(${where.want})`
          : '') +
        (skipped.size
          ? ` [not replayed: ${[...skipped].map(([k, v]) => `${k} x${v}`).join(', ')}]`
          : ''),
    );
  }
}

console.log(fail ? `\ncolrPaintPlacementSmoke FAIL (${fail})` : '\ncolrPaintPlacementSmoke PASS');
process.exit(fail ? 1 : 0);
