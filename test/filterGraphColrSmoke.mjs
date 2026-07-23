// filterGraphColrSmoke.mjs — exercise the COLRv1 filter-graph dispatch
// with a stub GL recorder. Verifies:
//   - the walker invokes the right handler for each node type
//   - bbox uniforms match computeNodeBboxes output
//   - PaintSolid uniform receives premultiplied color (and foreground
//     substitution from ctx.runColor works)
//   - gradient stops are uploaded as a 1D LUT texture
//   - PaintTransform inverts the affine + threads the source bbox
//   - PaintGlyph passthroughs via blit when no mask is bound
//   - PaintMerge with 1 / 2 / 3 inputs uses the right composite path
//
// No real WebGL context needed: a recorder GL with the minimum surface
// (createTexture, createFramebuffer, uniform*, drawArrays) is enough to
// verify the dispatch logic.

import { evaluateGraph, createRTPool } from '../src/filterGraph/filterGraph.js';
import { computeNodeBboxes } from '../src/filterGraph/bbox.js';
// Importing the handler module registers the COLR paint handlers; read
// the dispatch table from the registry.
import '../src/filterGraph/colr/paints.js';
import { colrPaintDispatch, svgFilterDispatch } from '../src/filterGraph/dispatchRegistry.js';
const colrDispatch = colrPaintDispatch;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else       { console.log('ok:', msg); }
}
function approx(a, b, eps = 1e-4) { return Math.abs(a - b) < eps; }

// === stub GL recorder ===================================================
function makeGL() {
  const calls = [];                       // ordered list of {op, args}
  const uniforms = new Map();             // uniformLoc → last value
  const drawCalls = [];                   // ordered draw events
  const programs = new Map();             // prog → {uniforms by name}
  let nextHandle = 1;
  const handles = new Map();
  function H(kind) { const id = nextHandle++; handles.set(id, kind); return id; }
  const TEX = {};
  // Build a minimal GL surface; missing constants get a unique sentinel.
  return {
    calls, drawCalls, uniforms,
    // constants — fake numeric values
    FRAMEBUFFER: 1, READ_FRAMEBUFFER: 2, DRAW_FRAMEBUFFER: 3,
    COLOR_BUFFER_BIT: 4, DEPTH_BUFFER_BIT: 8, STENCIL_BUFFER_BIT: 16,
    TEXTURE_2D: 100, RGBA8: 101, RGBA: 102, UNSIGNED_BYTE: 103,
    TEXTURE_MIN_FILTER: 110, TEXTURE_MAG_FILTER: 111,
    TEXTURE_WRAP_S: 112, TEXTURE_WRAP_T: 113,
    NEAREST: 120, LINEAR: 121, CLAMP_TO_EDGE: 122,
    COLOR_ATTACHMENT0: 130, DEPTH_TEST: 140, STENCIL_TEST: 141, BLEND: 142,
    TEXTURE0: 200, TEXTURE1: 201,
    TRIANGLE_STRIP: 300, TRIANGLES: 301,
    createTexture() { return H('tex'); },
    bindTexture(t, tex) { calls.push(['bindTexture', t, tex]); },
    activeTexture(u) { calls.push(['activeTexture', u]); },
    texImage2D() { calls.push(['texImage2D']); },
    texParameteri() {},
    createFramebuffer() { return H('fbo'); },
    bindFramebuffer(t, f) { calls.push(['bindFramebuffer', t, f]); },
    framebufferTexture2D() {},
    blitFramebuffer(...a) { calls.push(['blitFramebuffer', ...a]); },
    viewport(...a) { calls.push(['viewport', ...a]); },
    clearColor(...a) { calls.push(['clearColor', ...a]); },
    clear(b) { calls.push(['clear', b]); },
    disable() {}, enable() {}, blendFunc() {}, blendEquation() {},
    useProgram(p) { calls.push(['useProgram', p]); },
    uniform1i(loc, v) { uniforms.set(loc, v); calls.push(['uniform1i', loc, v]); },
    uniform1f(loc, v) { uniforms.set(loc, v); calls.push(['uniform1f', loc, v]); },
    uniform2f(loc, x, y) { uniforms.set(loc, [x, y]); calls.push(['uniform2f', loc, x, y]); },
    uniform3f(loc, x, y, z) { uniforms.set(loc, [x, y, z]); },
    uniform4f(loc, x, y, z, w) { uniforms.set(loc, [x, y, z, w]); calls.push(['uniform4f', loc, x, y, z, w]); },
    bindVertexArray() {},
    drawArrays(mode, first, count) { calls.push(['drawArrays', mode, first, count]); drawCalls.push({ mode, first, count }); },
    deleteTexture() {}, deleteFramebuffer() {},
  };
}

// === test scaffolding ===================================================
const CW = 256, CH = 256;
const SRC = { x: 100, y: 100, w: 64, h: 64 };

function makeCtx(gl) {
  // Synthetic program handles + uniform locations. The dispatch never
  // queries these; it just sees them as opaque tokens.
  const tok = name => Symbol(name);
  return {
    gl, pool: createRTPool(gl), coverVao: tok('vao'),
    bbox: [],
    glyphAlphaTex: null,
    runColor: null,
    paintLinearGradProg: tok('linearProg'),
    paintLinearGradU: {
      uGradientStops: tok('uGradientStops'), uStopsOffset: tok('uStopsOffset'),
      uStopCount: tok('uStopCount'),
      uBboxOrigin: tok('uBboxOrigin'), uBboxSize: tok('uBboxSize'),
      uP0: tok('uP0'), uP1: tok('uP1'), uP2: tok('uP2'), uExtend: tok('uExtend'),
    },
    paintRadialGradProg: tok('radialProg'),
    paintRadialGradU: {
      uGradientStops: tok('uGradientStops'), uStopsOffset: tok('uStopsOffset'),
      uStopCount: tok('uStopCount'),
      uBboxOrigin: tok('uBboxOrigin'), uBboxSize: tok('uBboxSize'),
      uC0: tok('uC0'), uC1: tok('uC1'), uR0: tok('uR0'), uR1: tok('uR1'),
      uExtend: tok('uExtend'),
    },
    paintSweepGradProg: tok('sweepProg'),
    paintSweepGradU: {
      uGradientStops: tok('uGradientStops'), uStopsOffset: tok('uStopsOffset'),
      uStopCount: tok('uStopCount'),
      uBboxOrigin: tok('uBboxOrigin'), uBboxSize: tok('uBboxSize'),
      uCenter: tok('uCenter'), uStartAngle: tok('uStartAngle'),
      uEndAngle: tok('uEndAngle'), uExtend: tok('uExtend'),
    },
    paintTransformProg: tok('xformProg'),
    paintTransformU: {
      uIn: tok('uIn'),
      uBboxOutOrigin: tok('uBboxOutOrigin'), uBboxOutSize: tok('uBboxOutSize'),
      uBboxInOrigin: tok('uBboxInOrigin'), uBboxInSize: tok('uBboxInSize'),
      uMRow0: tok('uMRow0'), uMRow1: tok('uMRow1'),
    },
    paintGlyphProg: tok('glyphProg'),
    paintGlyphU: { uIn: tok('uIn'), uMask: tok('uMask') },
    paintCompositeProg: tok('paintCompositeProg'),
    paintCompositeU: { uSrc: tok('uSrc'), uDst: tok('uDst'), uMode: tok('uMode') },
    feCompositeProg: tok('feComposite'),
    feCompositeU: { uIn1: tok('uIn1'), uIn2: tok('uIn2'), uOp: tok('uOp'), uK: tok('uK') },
  };
}

function runGraph(graph, ctxPatches = {}) {
  const gl = makeGL();
  const ctx = Object.assign(makeCtx(gl), ctxPatches);
  const { bboxes } = computeNodeBboxes(graph, SRC, CW, CH);
  ctx.bbox = bboxes;
  const dispatch = colrDispatch();
  const root = evaluateGraph(gl, graph, ctx.pool, dispatch, ctx, CW, CH);
  return { gl, ctx, root };
}

// Helper: find the LAST clearColor before a non-clearColor-related call.
// (Tests want the value PaintSolid set, not a leftover from pool setup.)
function lastClearColor(gl) {
  const cc = gl.calls.filter(c => c[0] === 'clearColor');
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
  assert(v && approx(v[0], 0.5) && approx(v[1], 0) && approx(v[2], 0) && approx(v[3], 0.5),
         `PaintSolid premultiplied to (0.5, 0, 0, 0.5), got (${v})`);
}

// === 2: PaintSolid foreground substitution =============================
{
  const graph = {
    nodes: [{ type: 'PaintSolid', inputs: [],
              params: { rgba: [0, 0, 0, 1], isForeground: true } }],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph, { runColor: [0, 1, 0, 1] });
  const v = lastClearColor(ctx.gl);
  assert(v && approx(v[0], 0) && approx(v[1], 1) && approx(v[2], 0) && approx(v[3], 1),
         `PaintSolid foreground substitutes runColor, got (${v})`);
}

// === 3: PaintLinearGradient — bbox + p0/p1/p2 + extend ================
{
  const stops = [{ offset: 0, color: [1, 0, 0, 1] },
                 { offset: 1, color: [0, 0, 1, 1] }];
  const graph = {
    nodes: [{
      type: 'PaintLinearGradient', inputs: [],
      params: { stops, p0: [10, 20], p1: [100, 20], p2: [10, 110], extend: 0 },
    }],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintLinearGradU;
  const origin = ctx.gl.uniforms.get(u.uBboxOrigin);
  const size   = ctx.gl.uniforms.get(u.uBboxSize);
  // Generator bbox = source bbox (clamped to canvas, which doesn't matter here).
  assert(approx(origin[0], SRC.x) && approx(origin[1], SRC.y),
         `Linear bboxOrigin = source origin, got (${origin})`);
  assert(approx(size[0], SRC.w) && approx(size[1], SRC.h),
         `Linear bboxSize = source size, got (${size})`);
  const p0 = ctx.gl.uniforms.get(u.uP0);
  assert(approx(p0[0], 10) && approx(p0[1], 20), 'Linear p0 = (10, 20)');
  // uStopCount is SIGNED: |count| is the stop count, and count < 0 flags the
  // 1-texel opaque "straight" LUT format (sampleStops reads the sign). Both stops
  // here are opaque, so a 2-stop gradient encodes as -2.
  const stopCount = ctx.gl.uniforms.get(u.uStopCount);
  assert(stopCount === -2, `Linear stopCount = -2 (2 opaque stops, 1-texel format), got ${stopCount}`);
}

// === 4: PaintRadialGradient — c0/c1/r0/r1 + extend ====================
{
  const stops = [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 0, 0] }];
  const graph = {
    nodes: [{
      type: 'PaintRadialGradient', inputs: [],
      params: { stops, c0: [50, 50], r0: 0, c1: [50, 50], r1: 30, extend: 1 },
    }],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintRadialGradU;
  assert(approx(ctx.gl.uniforms.get(u.uR1), 30), 'Radial r1 = 30');
  assert(ctx.gl.uniforms.get(u.uExtend) === 1, 'Radial extend = REPEAT (1)');
}

// === 5: PaintSweepGradient — center / start / end / extend ============
{
  const stops = [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 1, 0, 1] }];
  const graph = {
    nodes: [{
      type: 'PaintSweepGradient', inputs: [],
      params: { stops, center: [128, 128], startAngle: 0, endAngle: 180, extend: 2 },
    }],
    rootOut: 0,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintSweepGradU;
  assert(approx(ctx.gl.uniforms.get(u.uEndAngle), 180), 'Sweep endAngle = 180');
  assert(ctx.gl.uniforms.get(u.uExtend) === 2, 'Sweep extend = REFLECT (2)');
}

// === 6: PaintTransform packs affine into row uniforms =================
{
  // Affine = [xx, yx, xy, yy, dx, dy] in COLR-normalised order.
  const graph = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintTransform', inputs: [0],
        params: { affine: [0.5, 0, 0, 0.5, 100, 50] } },
    ],
    rootOut: 1,
  };
  const { ctx } = runGraph(graph);
  const u = ctx.paintTransformU;
  const row0 = ctx.gl.uniforms.get(u.uMRow0);
  const row1 = ctx.gl.uniforms.get(u.uMRow1);
  // uMRow0 = (xx, xy, dx, _) = (0.5, 0, 100, 0)
  // uMRow1 = (yx, yy, dy, _) = (0, 0.5, 50, 0)
  assert(approx(row0[0], 0.5) && approx(row0[1], 0) && approx(row0[2], 100),
         `Transform row0 = (0.5, 0, 100), got (${row0})`);
  assert(approx(row1[0], 0) && approx(row1[1], 0.5) && approx(row1[2], 50),
         `Transform row1 = (0, 0.5, 50), got (${row1})`);
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
  const blitCalls = ctx.gl.calls.filter(c => c[0] === 'blitFramebuffer');
  assert(blitCalls.length >= 1, 'PaintGlyph with no mask blits the child through');
  // No paintGlyphProg draw should have happened.
  const glyphDraws = ctx.gl.calls.filter(c =>
    c[0] === 'useProgram' && c[1] === ctx.paintGlyphProg);
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
  const glyphDraws = ctx.gl.calls.filter(c =>
    c[0] === 'useProgram' && c[1] === ctx.paintGlyphProg);
  assert(glyphDraws.length === 1, 'PaintGlyph with mask uses glyphProg');
  // Mask tex should be bound to TEXTURE1 (uIn=0, uMask=1 per dispatch).
  const maskBind = ctx.gl.calls.find(c => c[0] === 'bindTexture' && c[2] === 'fake-mask-tex');
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
  const compositeDraws = ctx.gl.calls.filter(c =>
    c[0] === 'useProgram' && c[1] === ctx.feCompositeProg);
  assert(compositeDraws.length === 1, '2-input PaintMerge uses feComposite once');
  // op uniform should have been set to 0 (over) somewhere after useProgram.
  const opSet = ctx.gl.uniforms.get(ctx.feCompositeU.uOp);
  assert(opSet === 0, `PaintMerge composites with op=0 (over), got ${opSet}`);
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
  const drawCalls = ctx.gl.drawCalls.filter(d => d.mode === ctx.gl.TRIANGLE_STRIP);
  assert(drawCalls.length === 2,
         `3-solid (clear-only) + 3-merge → 2 composite draws, got ${drawCalls.length}`);
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
      { type: 'PaintLinearGradient', inputs: [],
        params: { stops, p0: [100, 100], p1: [180, 100], p2: [100, 180], extend: 0 } },
      { type: 'PaintTransform', inputs: [0],
        params: { affine: [2, 0, 0, 2, -100, -100] } },
      { type: 'PaintGlyph', inputs: [1], params: { glyphId: 5 } },
    ],
    rootOut: 2,
  };
  const { ctx, root } = runGraph(graph, { glyphAlphaTex: 'mask' });
  assert(root && root.fbo, 'end-to-end graph returns a root RT');
  // 3 nodes → 3 shader passes (gradient + transform + glyph w/ mask).
  assert(ctx.gl.drawCalls.length === 3,
         `end-to-end = 3 draws, got ${ctx.gl.drawCalls.length}`);
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
  const draws = ctx.gl.calls.filter(c =>
    c[0] === 'useProgram' && c[1] === ctx.paintCompositeProg);
  assert(draws.length === 1, `PaintComposite uses paintCompositeProg once, got ${draws.length}`);
  const mode = ctx.gl.uniforms.get(ctx.paintCompositeU.uMode);
  assert(mode === 3, `PaintComposite uMode = 3 (SrcOver), got ${mode}`);
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
  const mask5Bind = ctx.gl.calls.find(c =>
    c[0] === 'bindTexture' && c[2] === 'mask-tex-5');
  const mask9Bind = ctx.gl.calls.find(c =>
    c[0] === 'bindTexture' && c[2] === 'mask-tex-9');
  assert(mask5Bind, 'PaintGlyph(gid=5) bound mask-tex-5 from the map');
  assert(mask9Bind, 'PaintGlyph(gid=9) bound mask-tex-9 from the map');
  // Verify the fallback was NOT used for either glyph (it would only
  // be bound if the lookup failed).
  const fallbackBinds = ctx.gl.calls.filter(c =>
    c[0] === 'bindTexture' && c[2] === 'fallback-tex');
  assert(fallbackBinds.length === 0,
         `per-gid masks resolved without fallback, got ${fallbackBinds.length} fallback binds`);
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
  const fallbackBind = ctx.gl.calls.find(c =>
    c[0] === 'bindTexture' && c[2] === 'primary-tex');
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
  const compositeDraws = ctx.gl.calls.filter(c =>
    c[0] === 'useProgram' && c[1] === ctx.feCompositeProg);
  assert(compositeDraws.length === 1,
         `Missing paintCompositeProg → falls back to feComposite over, got ${compositeDraws.length}`);
}

// === 16: feComponentTransfer dispatch =================================
// (Exercises the SVG-side dispatch but via the same evaluator infra,
// so it lives here in the COLR smoke file to share the recorder GL.)
{
  // Register the SVG filter primitives, then snapshot the registry.
  await import('../src/filterGraph/primitives/all.js');
  const svgDispatch = svgFilterDispatch;
  const graph = {
    nodes: [{
      type: 'feComponentTransfer',
      inputs: [-1],  // SourceGraphic
      params: {
        lutBytes: new Uint8Array(256 * 4 * 4),   // 256×4 RGBA8
        lutIndex: 0,
      },
    }],
    rootOut: 0,
  };
  const gl = makeGL();
  const tok = name => Symbol(name);
  const fctProg = tok('feComponentTransferProg');
  const fctU = { uIn: tok('uIn'), uLUT: tok('uLUT') };
  const lutTex = 'mock-lut-tex';
  const sourceTex = 'mock-source-tex';
  const ctx = {
    gl, pool: createRTPool(gl), coverVao: tok('vao'),
    sourceRT: { fbo: 'src-fbo', tex: sourceTex, size: [CW, CH] },
    feComponentTransferProg: fctProg,
    feComponentTransferU: fctU,
    componentTransferLUTs: [lutTex],
  };
  const dispatch = svgDispatch();
  evaluateGraph(gl, graph, ctx.pool, dispatch, ctx, CW, CH);
  const usedFct = gl.calls.some(c =>
    c[0] === 'useProgram' && c[1] === fctProg);
  assert(usedFct, 'feComponentTransfer dispatch invoked the program');
  const boundLUT = gl.calls.some(c =>
    c[0] === 'bindTexture' && c[2] === lutTex);
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
  const allocations = gl.calls.filter(c => c[0] === 'texImage2D').length;
  assert(allocations === 1,
         `disconnected output was recycled before root allocation, got ${allocations} textures`);
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
    fail() { throw new Error('expected test failure'); },
  };
  let threw = false;
  try {
    evaluateGraph(gl, graph, pool, dispatch, {}, CW, CH,
                  [[0, 0, CW, CH], [0, 0, CW, CH]]);
  } catch { threw = true; }
  const allocations = gl.calls.filter(c => c[0] === 'texImage2D').length;
  const clears = gl.calls.filter(c => c[0] === 'clear').length;
  pool.acquire(CW, CH);
  const allocationsAfter = gl.calls.filter(c => c[0] === 'texImage2D').length;
  const clearsAfter = gl.calls.filter(c => c[0] === 'clear').length;
  assert(threw, 'dispatch exception propagated to the caller');
  assert(allocationsAfter === allocations,
         'dispatch exception returned acquired render targets to the pool');
  assert(clearsAfter === clears,
         'dispatch exception restored clear-on-acquire state');
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
  evaluateGraph(gl, graph, pool, { inner() {} }, {}, CW, CH,
                [[0, 0, CW, CH]]);
  const clears = gl.calls.filter(c => c[0] === 'clear').length;
  pool.acquire(CW, CH);
  const clearsAfter = gl.calls.filter(c => c[0] === 'clear').length;
  assert(clearsAfter === clears + 1,
         'nested evaluation restored the outer clear-on-acquire state');
}

console.log('---');
if (failures) console.error(`FILTER-GRAPH-COLR FAIL (${failures})`);
else          console.log('FILTER-GRAPH-COLR PASS');
process.exit(failures ? 1 : 0);
