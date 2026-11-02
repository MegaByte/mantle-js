// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPU graph dispatch, upload-packet and target-ownership contracts.
// Pixel accuracy belongs to the physical COLR render checks and development diagnostics.
import { evaluateGraph, createRTPool, releaseRoot } from '../src/filterGraph/filterGraph.js';
import { colrNodeBoxes } from '../src/filterGraph/bbox.js';
// Importing the handler module registers the COLR paint handlers; read
// the dispatch table from the registry.
import '../src/filterGraph/colr/paints.js';
import { colrPaintDispatch, svgFilterDispatch } from '../src/filterGraph/dispatchRegistry.js';
const colrDispatch = colrPaintDispatch;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
function approx(a, b, eps = 1e-4) {
  return Math.abs(a - b) < eps;
}

// === stub GL recorder ===================================================
function makeGL() {
  const calls = []; // ordered list of {op, args}
  const uniforms = new Map(); // uniformLoc → last value
  const drawCalls = []; // ordered draw events
  const programs = new Map(); // prog → {uniforms by name}
  let nextHandle = 1;
  const handles = new Map();
  function H(kind) {
    const id = nextHandle++;
    handles.set(id, kind);
    return id;
  }
  const TEX = {};
  // Build a minimal GL surface; missing constants get a unique sentinel.
  return {
    calls,
    drawCalls,
    uniforms,
    // constants — fake numeric values
    FRAMEBUFFER: 1,
    READ_FRAMEBUFFER: 2,
    DRAW_FRAMEBUFFER: 3,
    COLOR_BUFFER_BIT: 4,
    DEPTH_BUFFER_BIT: 8,
    STENCIL_BUFFER_BIT: 16,
    TEXTURE_2D: 100,
    RGBA8: 101,
    RGBA: 102,
    UNSIGNED_BYTE: 103,
    TEXTURE_MIN_FILTER: 110,
    TEXTURE_MAG_FILTER: 111,
    TEXTURE_WRAP_S: 112,
    TEXTURE_WRAP_T: 113,
    NEAREST: 120,
    LINEAR: 121,
    CLAMP_TO_EDGE: 122,
    COLOR_ATTACHMENT0: 130,
    DEPTH_TEST: 140,
    STENCIL_TEST: 141,
    BLEND: 142,
    TEXTURE0: 200,
    TEXTURE1: 201,
    TRIANGLE_STRIP: 300,
    TRIANGLES: 301,
    createTexture() {
      return H('tex');
    },
    bindTexture(t, tex) {
      calls.push(['bindTexture', t, tex]);
    },
    activeTexture(u) {
      calls.push(['activeTexture', u]);
    },
    texImage2D() {
      calls.push(['texImage2D']);
    },
    texParameteri() {},
    createFramebuffer() {
      return H('fbo');
    },
    bindFramebuffer(t, f) {
      calls.push(['bindFramebuffer', t, f]);
    },
    framebufferTexture2D() {},
    blitFramebuffer(...a) {
      calls.push(['blitFramebuffer', ...a]);
    },
    viewport(...a) {
      calls.push(['viewport', ...a]);
    },
    clearColor(...a) {
      calls.push(['clearColor', ...a]);
    },
    clear(b) {
      calls.push(['clear', b]);
    },
    disable() {},
    enable() {},
    blendFunc() {},
    blendEquation() {},
    useProgram(p) {
      calls.push(['useProgram', p]);
    },
    uniform1i(loc, v) {
      uniforms.set(loc, v);
      calls.push(['uniform1i', loc, v]);
    },
    uniform1f(loc, v) {
      uniforms.set(loc, v);
      calls.push(['uniform1f', loc, v]);
    },
    uniform2f(loc, x, y) {
      uniforms.set(loc, [x, y]);
      calls.push(['uniform2f', loc, x, y]);
    },
    uniform3f(loc, x, y, z) {
      uniforms.set(loc, [x, y, z]);
    },
    uniform4f(loc, x, y, z, w) {
      uniforms.set(loc, [x, y, z, w]);
      calls.push(['uniform4f', loc, x, y, z, w]);
    },
    bindVertexArray() {},
    drawArrays(mode, first, count) {
      calls.push(['drawArrays', mode, first, count]);
      drawCalls.push({ mode, first, count });
    },
    deleteTexture() {},
    deleteFramebuffer() {},
  };
}

// === test scaffolding ===================================================
const CW = 256,
  CH = 256;
const SRC = { x: 100, y: 100, w: 64, h: 64 };

function makeCtx(gl) {
  // Synthetic program handles + uniform locations. The dispatch never
  // queries these; it just sees them as opaque tokens.
  const tok = (name) => Symbol(name);
  return {
    gl,
    pool: createRTPool(gl),
    coverVao: tok('vao'),
    w: CW,
    h: CH,
    glyphAlphaTex: null,
    runColor: null,
    paintLinearGradProg: tok('linearProg'),
    paintLinearGradU: {
      uGradientStops: tok('uGradientStops'),
      uStopsOffset: tok('uStopsOffset'),
      uStopCount: tok('uStopCount'),
      uPaintMapX: tok('uPaintMapX'),
      uPaintMapY: tok('uPaintMapY'),
      uP0: tok('uP0'),
      uP1: tok('uP1'),
      uP2: tok('uP2'),
      uExtend: tok('uExtend'),
    },
    paintRadialGradProg: tok('radialProg'),
    paintRadialGradU: {
      uGradientStops: tok('uGradientStops'),
      uStopsOffset: tok('uStopsOffset'),
      uStopCount: tok('uStopCount'),
      uPaintMapX: tok('uPaintMapX'),
      uPaintMapY: tok('uPaintMapY'),
      uC0: tok('uC0'),
      uC1: tok('uC1'),
      uR0: tok('uR0'),
      uR1: tok('uR1'),
      uExtend: tok('uExtend'),
    },
    paintSweepGradProg: tok('sweepProg'),
    paintSweepGradU: {
      uGradientStops: tok('uGradientStops'),
      uStopsOffset: tok('uStopsOffset'),
      uStopCount: tok('uStopCount'),
      uPaintMapX: tok('uPaintMapX'),
      uPaintMapY: tok('uPaintMapY'),
      uCenter: tok('uCenter'),
      uStartAngle: tok('uStartAngle'),
      uEndAngle: tok('uEndAngle'),
      uExtend: tok('uExtend'),
    },
    paintTransformProg: tok('xformProg'),
    paintTransformU: {
      uIn: tok('uIn'),
      uBboxOutOrigin: tok('uBboxOutOrigin'),
      uBboxOutSize: tok('uBboxOutSize'),
      uBboxInOrigin: tok('uBboxInOrigin'),
      uBboxInSize: tok('uBboxInSize'),
      uMRow0: tok('uMRow0'),
      uMRow1: tok('uMRow1'),
    },
    paintGlyphProg: tok('glyphProg'),
    paintGlyphU: {
      uIn: tok('uIn'),
      uMask: tok('uMask'),
      uInMap: tok('uInMap'),
      uMaskMap: tok('uMaskMap'),
    },
    paintCompositeProg: tok('paintCompositeProg'),
    paintCompositeU: {
      uSrc: tok('uSrc'),
      uDst: tok('uDst'),
      uMode: tok('uMode'),
      uPD: tok('uPD'),
      uSrcMap: tok('uSrcMap'),
      uDstMap: tok('uDstMap'),
    },
    feCompositeProg: tok('feComposite'),
    feCompositeU: {
      uIn1: tok('uIn1'),
      uIn2: tok('uIn2'),
      uOp: tok('uOp'),
      uK: tok('uK'),
      uPD: tok('uPD.fc'),
      uIn1Map: tok('uIn1Map'),
      uIn2Map: tok('uIn2Map'),
    },
  };
}

// `rects`: per-node GL rects (origin bottom-left), as the renderer's COLR leaf passes them; omitted, every
// target is the canvas.
function runGraph(graph, ctxPatches = {}, rects = undefined) {
  const gl = makeGL();
  const ctx = Object.assign(makeCtx(gl), ctxPatches);
  const dispatch = colrDispatch();
  const root = evaluateGraph(gl, graph, ctx.pool, dispatch, ctx, CW, CH, rects);
  return { gl, ctx, root };
}
// Helper: find the LAST clearColor before a non-clearColor-related call.
// (Tests want the value PaintSolid set, not a leftover from pool setup.)
function lastClearColor(gl) {
  const cc = gl.calls.filter((c) => c[0] === 'clearColor');
  return cc.length ? cc[cc.length - 1].slice(1) : null;
}

// === 1: PaintSolid premultiplies the color (via clearColor — feFlood path) =
{
  const graph = {
    nodes: [{ type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 0.5] } }],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph);
  const v = lastClearColor(ctx.gl);
  assert(
    v && approx(v[0], 0.5) && approx(v[1], 0) && approx(v[2], 0) && approx(v[3], 0.5),
    `PaintSolid premultiplied to (0.5, 0, 0, 0.5), got (${v})`,
  );
}

// === 2: PaintSolid foreground substitution =============================
{
  const graph = {
    nodes: [{ type: 'PaintSolid', inputs: [], params: { rgba: [0, 0, 0, 1], isForeground: true } }],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph, { runColor: [0, 1, 0, 1] });
  const v = lastClearColor(ctx.gl);
  assert(
    v && approx(v[0], 0) && approx(v[1], 1) && approx(v[2], 0) && approx(v[3], 1),
    `PaintSolid foreground substitutes runColor, got (${v})`,
  );
}

// === 3: PaintLinearGradient — bbox + p0/p1/p2 + extend ================
{
  const stops = [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 0, 1, 1] },
  ];
  const graph = {
    nodes: [
      {
        type: 'PaintLinearGradient',
        inputs: [],
        params: { stops, p0: [10, 20], p1: [100, 20], p2: [10, 110], extend: 0 },
      },
    ],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintLinearGradU;
  const mx = ctx.gl.uniforms.get(u.uPaintMapX),
    my = ctx.gl.uniforms.get(u.uPaintMapY);
  assert(
    mx?.join() === [CW, 0, 0].join() && my?.join() === [0, -CH, CH].join(),
    'Linear paint uploads the canvas-to-paint affine coefficients',
  );
  const p0 = ctx.gl.uniforms.get(u.uP0);
  assert(approx(p0[0], 10) && approx(p0[1], 20), 'Linear p0 = (10, 20)');
  // uStopCount is SIGNED: |count| is the stop count, and count < 0 flags the
  // 1-texel opaque "straight" LUT format (sampleStops reads the sign). Both stops
  // here are opaque, so a 2-stop gradient encodes as -2.
  const stopCount = ctx.gl.uniforms.get(u.uStopCount);
  assert(
    stopCount === -2,
    `Linear stopCount = -2 (2 opaque stops, 1-texel format), got ${stopCount}`,
  );
}

// === 4: PaintRadialGradient — c0/c1/r0/r1 + extend ====================
{
  const stops = [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 0, 0, 0] },
  ];
  const graph = {
    nodes: [
      {
        type: 'PaintRadialGradient',
        inputs: [],
        params: { stops, c0: [50, 50], r0: 0, c1: [50, 50], r1: 30, extend: 1 },
      },
    ],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintRadialGradU;
  assert(approx(ctx.gl.uniforms.get(u.uR1), 1), 'Radial radius upload is normalized');
  assert(
    ctx.gl.uniforms.get(u.uC0).join() === '0,0' && ctx.gl.uniforms.get(u.uC1).join() === '0,0',
    'Radial centers use the same translated frame',
  );
  assert(ctx.gl.uniforms.get(u.uExtend) === 1, 'Radial extend = REPEAT (1)');
}

// === 5: PaintSweepGradient — center / start / end / extend ============
{
  const stops = [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 1, 0, 1] },
  ];
  const graph = {
    nodes: [
      {
        type: 'PaintSweepGradient',
        inputs: [],
        params: { stops, center: [128, 128], startAngle: 0, endAngle: 180, extend: 2 },
      },
    ],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintSweepGradU;
  assert(approx(ctx.gl.uniforms.get(u.uEndAngle), 180), 'Sweep endAngle = 180');
  assert(ctx.gl.uniforms.get(u.uExtend) === 2, 'Sweep extend = REFLECT (2)');
}

// === 6: PaintTransform packs affine into row uniforms =================
{
  // Affine = [xx, yx, xy, yy, dx, dy] in COLR-normalized order.
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 1 } },
      { type: 'PaintTransform', inputs: [1], params: { affine: [0.5, 0, 0, 0.5, 100, 50] } },
    ],
    rootOut: 2,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintTransformU;
  const row0 = ctx.gl.uniforms.get(u.uMRow0);
  const row1 = ctx.gl.uniforms.get(u.uMRow1);
  // uMRow0 = (xx, xy, dx, _) = (0.5, 0, 100, 0)
  // uMRow1 = (yx, yy, dy, _) = (0, 0.5, 50, 0)
  assert(
    approx(row0[0], 0.5) && approx(row0[1], 0) && approx(row0[2], 100),
    `Transform row0 = (0.5, 0, 100), got (${row0})`,
  );
  assert(
    approx(row1[0], 0) && approx(row1[1], 0.5) && approx(row1[2], 50),
    `Transform row1 = (0, 0.5, 50), got (${row1})`,
  );
  // Both targets are the canvas: vUV (0,0) is canvas px (0, CH) -- the bottom-left -- and the size runs
  // y DOWN the canvas as vUV runs up.
  const oO = ctx.gl.uniforms.get(u.uBboxOutOrigin),
    oS = ctx.gl.uniforms.get(u.uBboxOutSize);
  assert(
    oO && approx(oO[0], 0) && approx(oO[1], CH) && approx(oS[0], CW) && approx(oS[1], -CH),
    `Transform output map = origin (0, ${CH}), size (${CW}, ${-CH}), got (${oO}) (${oS})`,
  );
}

// === 7: PaintGlyph passes through when no mask is bound ===============
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 2 } },
    ],
    rootOut: 1,
  };
  const { ctx } = runGraph(graph);
  // Without glyphAlphaTex the handler blits — verify by looking for the blit call.
  const blitCalls = ctx.gl.calls.filter((c) => c[0] === 'blitFramebuffer');
  assert(blitCalls.length >= 1, 'PaintGlyph with no mask blits the child through');
  // No paintGlyphProg draw should have happened.
  const glyphDraws = ctx.gl.calls.filter(
    (c) => c[0] === 'useProgram' && c[1] === ctx.paintGlyphProg,
  );
  assert(glyphDraws.length === 0, 'PaintGlyph did not bind glyphProg without a mask');
}

// === 8: PaintGlyph with mask binds the mask and runs the shader =======
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 2 } },
    ],
    rootOut: 1,
  };
  const { ctx } = runGraph(graph, { glyphAlphaTex: 'fake-mask-tex' });
  const glyphDraws = ctx.gl.calls.filter(
    (c) => c[0] === 'useProgram' && c[1] === ctx.paintGlyphProg,
  );
  assert(glyphDraws.length === 1, 'PaintGlyph with mask uses glyphProg');
  // Mask tex should be bound to TEXTURE1 (uIn=0, uMask=1 per dispatch).
  const maskBind = ctx.gl.calls.find((c) => c[0] === 'bindTexture' && c[2] === 'fake-mask-tex');
  assert(maskBind, 'PaintGlyph bound the mask texture');
}

// === 9: PaintMerge with 2 inputs uses feComposite over ===============
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 1, 0, 0.5] } },
      { type: 'PaintMerge', inputs: [0, 1], params: {} },
    ],
    rootOut: 2,
  };
  const { ctx } = runGraph(graph);
  const compositeDraws = ctx.gl.calls.filter(
    (c) => c[0] === 'useProgram' && c[1] === ctx.feCompositeProg,
  );
  assert(compositeDraws.length === 1, '2-input PaintMerge uses feComposite once');
  // op uniform should have been set to 0 (over) somewhere after useProgram.
  const opSet = ctx.gl.uniforms.get(ctx.feCompositeU.uOp);
  assert(opSet === 0, `PaintMerge composites with op=0 (over), got ${opSet}`);
  const mpd = ctx.gl.uniforms.get(ctx.feCompositeU.uPD);
  assert(
    mpd && mpd.join() === '1,0,1,-1',
    `PaintMerge sends src-over's Porter-Duff weights (1, 0, 1, -1), got (${mpd})`,
  );
}

// === 10: PaintMerge with 3 inputs ping-pongs ==========================
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 1, 0, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 0, 1, 1] } },
      { type: 'PaintMerge', inputs: [0, 1, 2], params: {} },
    ],
    rootOut: 3,
  };
  const { ctx } = runGraph(graph);
  // 3-input merge → 2 composite draws (in[1] over in[0], then in[2] over that).
  // PaintSolid uses clearColor (no draw call) — only composite passes draw.
  const drawCalls = ctx.gl.drawCalls.filter((d) => d.mode === ctx.gl.TRIANGLE_STRIP);
  assert(
    drawCalls.length === 2,
    `3-solid (clear-only) + 3-merge → 2 composite draws, got ${drawCalls.length}`,
  );
}

// === 11: end-to-end — gradient → transform → glyph ====================
{
  // A realistic 3-node COLR fragment: a linear gradient transformed
  // by 2× scale and clipped by a glyph silhouette. Verifies the
  // bbox-sized RT pipeline at every step.
  const stops = [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 0, 1, 1] },
  ];
  const graph = {
    nodes: [
      {
        type: 'PaintLinearGradient',
        inputs: [],
        params: { stops, p0: [100, 100], p1: [180, 100], p2: [100, 180], extend: 0 },
      },
      { type: 'PaintTransform', inputs: [0], params: { affine: [2, 0, 0, 2, -100, -100] } },
      { type: 'PaintGlyph', inputs: [1], params: { glyphId: 5 } },
    ],
    rootOut: 2,
  };
  const { ctx, root } = runGraph(graph, { glyphAlphaTex: 'mask' });
  assert(root && root.fbo, 'end-to-end graph returns a root RT');
  // 3 nodes → 3 shader passes (gradient + transform + glyph w/ mask).
  assert(ctx.gl.drawCalls.length === 3, `end-to-end = 3 draws, got ${ctx.gl.drawCalls.length}`);
}

// === 12: PaintComposite Porter-Duff (mode=3 src-over) ==================
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 0, 1, 1] } },
      { type: 'PaintComposite', inputs: [0, 1], params: { mode: 3 } },
    ],
    rootOut: 2,
  };
  const { ctx } = runGraph(graph);
  const draws = ctx.gl.calls.filter(
    (c) => c[0] === 'useProgram' && c[1] === ctx.paintCompositeProg,
  );
  assert(draws.length === 1, `PaintComposite uses paintCompositeProg once, got ${draws.length}`);
  const mode = ctx.gl.uniforms.get(ctx.paintCompositeU.uMode);
  assert(mode === 3, `PaintComposite uMode = 3 (SrcOver), got ${mode}`);
  // The Porter-Duff weights, per draw: src over is Fa = 1, Fb = 1 - as -> (1, 0, 1, -1).
  const pd = ctx.gl.uniforms.get(ctx.paintCompositeU.uPD);
  assert(
    pd && pd.join() === '1,0,1,-1',
    `PaintComposite uPD = (1, 0, 1, -1) for src over, got (${pd})`,
  );
}

// === 13: PaintComposite blend (mode=14 Overlay) =========================
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [0.5, 0.5, 0.5, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintComposite', inputs: [0, 1], params: { mode: 14 } },
    ],
    rootOut: 2,
  };
  const { ctx } = runGraph(graph);
  const mode = ctx.gl.uniforms.get(ctx.paintCompositeU.uMode);
  assert(mode === 14, `PaintComposite uMode = 14 (Overlay), got ${mode}`);
}

// === 14a: PaintGlyph resolves per-gid mask via ctx.glyphAlphaMasks ====
{
  // Two PaintGlyph nodes referencing different gids. Each should bind
  // the gid-specific mask from the map (not the fallback glyphAlphaTex).
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 5 } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 0, 1, 1] } },
      { type: 'PaintGlyph', inputs: [2], params: { glyphId: 9 } },
      { type: 'PaintMerge', inputs: [1, 3], params: {} },
    ],
    rootOut: 4,
  };
  const masks = new Map();
  masks.set(5, 'mask-tex-5');
  masks.set(9, 'mask-tex-9');
  const { ctx } = runGraph(graph, {
    glyphAlphaTex: 'fallback-tex',
    glyphAlphaMasks: masks,
  });
  const mask5Bind = ctx.gl.calls.find((c) => c[0] === 'bindTexture' && c[2] === 'mask-tex-5');
  const mask9Bind = ctx.gl.calls.find((c) => c[0] === 'bindTexture' && c[2] === 'mask-tex-9');
  assert(mask5Bind, 'PaintGlyph(gid=5) bound mask-tex-5 from the map');
  assert(mask9Bind, 'PaintGlyph(gid=9) bound mask-tex-9 from the map');
  // Verify the fallback was NOT used for either glyph (it would only
  // be bound if the lookup failed).
  const fallbackBinds = ctx.gl.calls.filter(
    (c) => c[0] === 'bindTexture' && c[2] === 'fallback-tex',
  );
  assert(
    fallbackBinds.length === 0,
    `per-gid masks resolved without fallback, got ${fallbackBinds.length} fallback binds`,
  );
}

// === 14b: PaintGlyph falls back to glyphAlphaTex when gid not in map ===
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 99 } },
    ],
    rootOut: 1,
  };
  // Map exists but doesn't contain gid 99 — fall back to glyphAlphaTex.
  const masks = new Map();
  masks.set(5, 'unused-mask');
  const { ctx } = runGraph(graph, {
    glyphAlphaTex: 'primary-tex',
    glyphAlphaMasks: masks,
  });
  const fallbackBind = ctx.gl.calls.find((c) => c[0] === 'bindTexture' && c[2] === 'primary-tex');
  assert(fallbackBind, 'unknown gid → falls back to ctx.glyphAlphaTex');
}

// === 15: PaintComposite falls back to PaintMerge when shader missing ===
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 0, 1, 1] } },
      { type: 'PaintComposite', inputs: [0, 1], params: { mode: 3 } },
    ],
    rootOut: 2,
  };
  // Strip paintCompositeProg from ctx — simulate a renderer that hasn't
  // compiled the COLR composite shader yet (e.g., a font without any
  // PaintComposite nodes wanting to avoid the program-link cost).
  const { ctx } = runGraph(graph, { paintCompositeProg: null });
  const compositeDraws = ctx.gl.calls.filter(
    (c) => c[0] === 'useProgram' && c[1] === ctx.feCompositeProg,
  );
  assert(
    compositeDraws.length === 1,
    `Missing paintCompositeProg → falls back to feComposite over, got ${compositeDraws.length}`,
  );
}

// === 16: feComponentTransfer dispatch =================================
// (Exercises the SVG-side dispatch but via the same evaluator infra,
// so it lives here in the COLR smoke file to share the recorder GL.)
{
  // Register the SVG filter primitives, then snapshot the registry.
  await import('../src/filterGraph/primitives/all.js');
  const svgDispatch = svgFilterDispatch;
  const graph = {
    nodes: [
      {
        type: 'feComponentTransfer',
        inputs: [-1], // SourceGraphic
        params: {
          lutBytes: new Uint8Array(256 * 4 * 4), // 256×4 RGBA8
          lutIndex: 0,
        },
      },
    ],
    rootOut: 0,
  };
  const gl = makeGL();
  const tok = (name) => Symbol(name);
  const fctProg = tok('feComponentTransferProg');
  const fctU = { uIn: tok('uIn'), uLUT: tok('uLUT') };
  const lutTex = 'mock-lut-tex';
  const sourceTex = 'mock-source-tex';
  const ctx = {
    gl,
    pool: createRTPool(gl),
    coverVao: tok('vao'),
    sourceRT: { fbo: 'src-fbo', tex: sourceTex, size: [CW, CH] },
    feComponentTransferProg: fctProg,
    feComponentTransferU: fctU,
    componentTransferLUTs: [lutTex],
  };
  const dispatch = svgDispatch();
  evaluateGraph(gl, graph, ctx.pool, dispatch, ctx, CW, CH);
  const usedFct = gl.calls.some((c) => c[0] === 'useProgram' && c[1] === fctProg);
  assert(usedFct, 'feComponentTransfer dispatch invoked the program');
  const boundLUT = gl.calls.some((c) => c[0] === 'bindTexture' && c[2] === lutTex);
  assert(boundLUT, 'feComponentTransfer bound the LUT texture');
}

// === 17: disconnected graph outputs are recycled ======================
{
  const gl = makeGL();
  const pool = createRTPool(gl);
  const graph = {
    nodes: [
      { type: 'unused', inputs: [], params: null },
      { type: 'root', inputs: [], params: null },
    ],
    rootOut: 1,
  };
  const dispatch = { unused() {}, root() {} };
  evaluateGraph(gl, graph, pool, dispatch, {}, CW, CH);
  const allocations = gl.calls.filter((c) => c[0] === 'texImage2D').length;
  assert(
    allocations === 1,
    `disconnected output was recycled before root allocation, got ${allocations} textures`,
  );
}

// === 18: dispatch failures restore pool state ==========================
{
  const gl = makeGL();
  const pool = createRTPool(gl);
  const graph = {
    nodes: [
      { type: 'source', inputs: [], params: null },
      { type: 'fail', inputs: [0], params: null },
    ],
    rootOut: 1,
  };
  const dispatch = {
    source() {},
    fail() {
      throw new Error('expected test failure');
    },
  };
  let threw = false;
  try {
    evaluateGraph(gl, graph, pool, dispatch, {}, CW, CH, [
      [0, 0, CW, CH],
      [0, 0, CW, CH],
    ]);
  } catch {
    threw = true;
  }
  const allocations = gl.calls.filter((c) => c[0] === 'texImage2D').length;
  const clears = gl.calls.filter((c) => c[0] === 'clear').length;
  pool.acquire(CW, CH);
  const allocationsAfter = gl.calls.filter((c) => c[0] === 'texImage2D').length;
  const clearsAfter = gl.calls.filter((c) => c[0] === 'clear').length;
  assert(threw, 'dispatch exception propagated to the caller');
  assert(
    allocationsAfter === allocations,
    'dispatch exception returned acquired render targets to the pool',
  );
  assert(clearsAfter === clears, 'dispatch exception restored clear-on-acquire state');
}

// === 19: nested evaluations preserve outer clear state =================
{
  const gl = makeGL();
  const pool = createRTPool(gl);
  pool.setClearOnAcquire(true);
  const graph = {
    nodes: [{ type: 'inner', inputs: [], params: null }],
    rootOut: 0,
  };
  evaluateGraph(gl, graph, pool, { inner() {} }, {}, CW, CH, [[0, 0, CW, CH]]);
  const clears = gl.calls.filter((c) => c[0] === 'clear').length;
  pool.acquire(CW, CH);
  const clearsAfter = gl.calls.filter((c) => c[0] === 'clear').length;
  assert(clearsAfter === clears + 1, 'nested evaluation restored the outer clear-on-acquire state');
}

// === 20: rect-sized targets ===============================
// The renderer's COLR leaf renders each node into a target covering its own canvas rect. Every pass must
// then map ITS vUV: a gradient into paint space, an input into the input's rect, a silhouette into the
// canvas. A pass that reads vUV as if every target were the canvas (and a gradient's box as if the
// target were the box) puts a glyph's gradient on the canvas instead of the glyph.
{
  // Paint space: a glyph's design grid, y UP -- 64 px per unit, the glyph's origin at canvas (100, 164).
  const paintToPx = [64, 0, 0, -64, 100, 164];
  const stops = [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 0, 1, 1] },
  ];
  const graph = {
    nodes: [
      {
        type: 'PaintLinearGradient',
        inputs: [],
        params: { stops, p0: [0, 0.5], p1: [1, 0.5], p2: [0, 1.5], extend: 0 },
      },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 1 } },
    ],
    rootOut: 1,
  };
  // GL rects (origin bottom-left): the gradient's target is larger than the glyph's and offset from it.
  const rects = [
    [80, 60, 128, 128],
    [96, 88, 80, 80],
  ];
  const { ctx } = runGraph(graph, { paintToPx, glyphAlphaTex: 'mask' }, rects);
  const u = ctx.paintLinearGradU;
  const mx = ctx.gl.uniforms.get(u.uPaintMapX),
    my = ctx.gl.uniforms.get(u.uPaintMapY);
  assert(
    mx.join() === '2,0,-0.3125' && my.join() === '0,2,-0.5',
    'Gradient rect uploads its paint-map coefficients',
  );
  const g = ctx.paintGlyphU;
  assert(
    ctx.gl.uniforms.get(g.uInMap).join() === '0.625,0.625,0.125,0.21875',
    'Glyph input rect upload',
  );
  assert(
    ctx.gl.uniforms.get(g.uMaskMap).join() === '0.3125,0.3125,0.375,0.34375',
    'Glyph mask rect upload',
  );
}

// === 21: PaintTransform between rect targets ============================
{
  // A paint-space rotation by 90 degrees about the paint origin, placed by a y-up paint space.
  const paintToPx = [64, 0, 0, -64, 100, 164];
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 1 } },
      { type: 'PaintTransform', inputs: [1], params: { affine: [0, 1, -1, 0, 0, 0] } },
    ],
    rootOut: 2,
  };
  const rects = [
    [20, 30, 128, 128],
    [20, 30, 128, 128],
    [90, 70, 64, 96],
  ];
  const { ctx } = runGraph(graph, { paintToPx }, rects);
  const u = ctx.paintTransformU;
  const U = (k) => ctx.gl.uniforms.get(u[k]);
  const oO = U('uBboxOutOrigin'),
    oS = U('uBboxOutSize'),
    iO = U('uBboxInOrigin'),
    iS = U('uBboxInSize');
  const r0 = U('uMRow0'),
    r1 = U('uMRow1');
  assert(oO.join() === '90,186' && oS.join() === '64,-96', 'Raster transform output rect upload');
  assert(iO.join() === '20,226' && iS.join() === '128,-128', 'Raster transform input rect upload');
  assert(
    r0.join() === '0,1,-64,0' && r1.join() === '-1,0,264,0',
    'Raster transform conjugated affine upload',
  );
}

// === 22: PaintComposite and PaintMerge map each input's rect ============
{
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 0, 1, 1] } },
      { type: 'PaintSolid', inputs: [], params: { rgba: [0, 1, 0, 1] } },
      { type: 'PaintComposite', inputs: [0, 1], params: { mode: 3 } },
      { type: 'PaintMerge', inputs: [3, 2], params: {} },
    ],
    rootOut: 4,
  };
  const rects = [
    [10, 10, 64, 64],
    [40, 20, 32, 96],
    [0, 0, 128, 128],
    [10, 10, 64, 110],
    [0, 0, 128, 128],
  ];
  const { ctx } = runGraph(graph, {}, rects);
  const c = ctx.paintCompositeU,
    f = ctx.feCompositeU;
  const sm = ctx.gl.uniforms.get(c.uSrcMap),
    dm = ctx.gl.uniforms.get(c.uDstMap);
  assert(sm.join() === [1, 110 / 64, 0, 0].join(), 'Composite source rect upload');
  assert(
    dm.join() === [2, 110 / 96, -30 / 32, -10 / 96].join(),
    'Composite destination rect upload',
  );
  const m1 = ctx.gl.uniforms.get(f.uIn1Map),
    m2 = ctx.gl.uniforms.get(f.uIn2Map);
  assert(m1.join() === '1,1,0,0', 'Merge top-layer rect upload');
  assert(m2.join() === [2, 128 / 110, -10 / 64, -10 / 110].join(), 'Merge lower-layer rect upload');
}

// Analytic generator transforms preserve and restore CPU placement state.
{
  const placement = [2, 0, 0, 2, 10, 20];
  const graph = {
    nodes: [
      {
        type: 'PaintLinearGradient',
        inputs: [],
        params: {
          stops: [
            { offset: 0, color: [1, 0, 0, 1] },
            { offset: 1, color: [0, 0, 1, 1] },
          ],
        },
      },
      { type: 'PaintTransform', inputs: [0], params: { affine: [1, 0, 0, 1, 600, 0] } },
    ],
    rootOut: 1,
  };
  const { ctx } = runGraph(graph, { paintToPx: placement });
  assert(
    ctx.paintToPx === placement && ctx._paintNodes === undefined,
    'Graph restores borrowed CPU placement and node scope',
  );
  assert(
    !ctx.gl.uniforms.has(ctx.paintTransformU.uMRow0),
    'Generator transform uses its analytic gradient upload',
  );
  const mx = ctx.gl.uniforms.get(ctx.paintLinearGradU.uPaintMapX);
  assert(
    mx.join() === [CW / 2, 0, -605].join(),
    'Generator transform composes the CPU paint placement',
  );
  graph.nodes[1].params.affine = [0, 0, 0, 1, 0, 0];
  const singular = runGraph(graph);
  assert(
    lastClearColor(singular.gl).join() === '0,0,0,0',
    'Singular analytic transform clears its output',
  );
}

// Analytic chains omit only targets whose consumers can read their records.
{
  const gradient = {
    type: 'PaintLinearGradient',
    inputs: [],
    params: {
      stops: [
        { offset: 0, color: [1, 0, 0, 1] },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    },
  };
  const transform = (input) => ({
    type: 'PaintTransform',
    inputs: [input],
    params: { affine: [1, 0, 0, 1, 600, 0] },
  });
  const glyph = (input) => ({ type: 'PaintGlyph', inputs: [input], params: { glyphId: 1 } });
  for (const nodes of [
    [gradient, transform(0), transform(1), glyph(2)],
    [
      gradient,
      transform(0),
      glyph(0),
      transform(1),
      { type: 'PaintMerge', inputs: [2, 3], params: {} },
    ],
  ]) {
    const { ctx, root } = runGraph(
      { nodes, rootOut: nodes.length - 1 },
      { analyticPaintTransforms: true, glyphAlphaTex: 'mask' },
    );
    assert(
      ctx.gl.drawCalls.length === (nodes.length === 4 ? 2 : 4),
      'Only required generator, glyph and merge passes draw',
    );
    releaseRoot(ctx.pool, root);
    const stats = ctx.pool.stats();
    assert(stats.targets === stats.free, 'Shared and deferred inputs release every pooled target');
  }
}

// === 23: colrNodeBoxes -- a generator covers what its consumers READ ====
{
  // gradient -> translate by (+100, 0) px -> glyph at (150..200, 40..90). The gradient must cover the
  // PREIMAGE of the glyph's region, 100 px to its left -- the source box would miss it entirely.
  const graph = {
    nodes: [
      { type: 'PaintLinearGradient', inputs: [], params: {} },
      { type: 'PaintTransform', inputs: [0], params: { affine: [1, 0, 0, 1, 100, 0] } },
      { type: 'PaintGlyph', inputs: [1], params: { glyphId: 7 } },
    ],
    rootOut: 2,
  };
  const glyph = { x: 150, y: 40, w: 50, h: 50 };
  const boxes = colrNodeBoxes(graph, { canvasW: CW, canvasH: CH, glyphBoxOf: () => glyph });
  const b0 = boxes[0],
    b2 = boxes[2];
  assert(
    b2.x <= 150 && b2.x + b2.w >= 200 && b2.x >= 148,
    `the glyph's box is its silhouette, got ${JSON.stringify(b2)}`,
  );
  assert(
    b0.x <= 50 && b0.x + b0.w >= 100 && b0.x + b0.w <= 103,
    `the gradient covers the transform's preimage, got ${JSON.stringify(b0)}`,
  );
  // A node nothing reads needs nothing.
  const lone = colrNodeBoxes(
    {
      nodes: [
        { type: 'PaintSolid', inputs: [] },
        { type: 'PaintSolid', inputs: [] },
      ],
      rootOut: 1,
    },
    { canvasW: CW, canvasH: CH },
  );
  assert(
    !(lone[0].w > 0) && lone[1].w === CW,
    `an unread node's box is empty and the root's is the canvas, got ${JSON.stringify(lone)}`,
  );
}

console.log('---');
if (failures) console.error(`FILTER-GRAPH-COLR FAIL (${failures})`);
else console.log('FILTER-GRAPH-COLR PASS');
process.exit(failures ? 1 : 0);
