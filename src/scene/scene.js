// scene.js — programmatic scene tree → Mantle bundle.
//
// A scene tree (Scene / SceneNode / Shape / IFill / Stroke) is
// accepted via the plain-object schema documented below.
//
// Lets consumers build a Mantle bundle without an SVG round-trip:
//
//   import { createScene, sceneToBundle } from '@kontek/mantle';
//
//   const scene = createScene();
//   scene.root.shapes.push({
//     contours: [{
//       segments: [
//         { p0: [10, 10], p1: [10, 10], p2: [90, 10] },  // top edge
//         { p0: [90, 10], p1: [90, 10], p2: [90, 90] },  // right
//         { p0: [90, 90], p1: [90, 90], p2: [10, 90] },  // bottom
//         { p0: [10, 90], p1: [10, 90], p2: [10, 10] },  // left
//       ],
//       closed: true,
//     }],
//     fill: { kind: 'solid', color: [1, 0, 0, 1] },
//   });
//   const sections = await sceneToBundle(scene);
//   const bundle = createBundle(gl, sections);
//
// Under the hood this assembles an SVG string and routes it through
// importSvg. The text path stays the source of truth for parser,
// gradients, clip, etc. — `sceneToBundle` is just a programmatic
// constructor that bypasses the SVG-author-as-text step.
//
// Schema:
//
//   Scene { root: SceneNode }
//   SceneNode {
//     transform?: number[6]  // SVG matrix(a b c d e f); default identity
//     shapes?: SceneShape[]
//     children?: SceneNode[]
//     clipper?: SceneNode    // optional clip applied to this node + subtree
//   }
//   SceneShape {
//     id?: string             // friendly name; round-trips to
//                              // bundle.shapeIds + OverrideTable lookup.
//                              // When omitted, the importer falls back
//                              // to its auto-generated `shape_N_fill`
//                              // names (depend on emission order).
//     contours: BezierContour[]
//     fill?: SolidFill | GradientFill | null   // null = `fill="none"`
//     pathProps?: { stroke?: Stroke, corners?, head?, tail? }
//     isConvex?: boolean
//   }
//   BezierContour { segments: PathSegment[], closed?: boolean }
//   PathSegment is one of:
//     CubicSegment { p0: [x,y], p1: [x,y], p2: [x,y] }
//       (default — no `kind` field. C1, C2 are the cubic controls on
//       the *outgoing* edge from p0 to the next segment's p0.)
//     ArcSegment {
//       kind: 'arc',
//       p0: [x,y],                  // start point
//       rx: number, ry: number,     // ellipse radii
//       rotation?: number,          // x-axis rotation in degrees (default 0)
//       largeArc?: boolean,         // SVG large-arc-flag (default false)
//       sweep?: boolean,            // SVG sweep-flag (default true = CW in y-down)
//     }
//       // Endpoint is the NEXT segment's p0 (same chain convention as
//       // cubic). Emits SVG `A rx ry rot lA sw endX endY`; the
//       // importer keeps it as a native SEG_ARC (the coverage walker
//       // renders true ellipse arcs, no Bezier approximation).
//       // Use this for circles / ellipses / pie wedges — no
//       // cardinal-axis cancellation, smaller curve buffer.
//   End-of-list segments connect back to segments[0].p0 when
//   closed === true (same for both kinds).
//
//   SolidFill    { kind: 'solid', color: [r,g,b,a], mode?: 'nonzero'|'evenodd', opacity? }
//   GradientFill { kind: 'gradient', type: 'linear'|'radial',
//                  stops: [{position, color}], addressing?: 'clamp'|'wrap'|'mirror',
//                  radialFocus?: [fx, fy] /* unit-circle [-1,1] */,
//                  mode?, opacity? }
//   Stroke       { fill: SolidFill|GradientFill,
//                  halfThickness: number,
//                  pattern?: number[],      // dash array (em units)
//                  patternOffset?: number,
//                  tippedCornerLimit?: number,   // miter-limit (default 10)
//                  corners?: 'tipped'|'round'|'beveled',
//                  head?: 'chop'|'square'|'round',
//                  tail?: 'chop'|'square'|'round' }
//
// All shapes inherit the SVG coordinate system used by importSvg:
// +Y down, em-relative. The emitted SVG's viewBox is computed from
// the scene-wide bbox so consumers don't have to set it. Contours
// follow the BezierPathSegment chain convention (p0, c1, c2
// per segment with the NEXT segment's p0 as the endpoint).

import importSvg from '../svg/importer.js';
import { makeBuildContext, emitShape as emitShapeToCtx } from '../svg/buildContext.js';
import { packMetaBody } from '../svg/meta.js';
import { texelToBytes } from '../svg/textures.js';
import { SEG_CUBIC, mkLine } from '../primitives/seg.js';

/// Convenience constructor. Returns `{ root: { children: [], shapes: [] } }`.
export function createScene() {
  return { root: { children: [], shapes: [] } };
}

/// Build a contour for an axis-aligned rectangle. `x, y` is top-left,
/// `w, h` extents. Returns a BezierContour with 4 line-as-cubic
/// segments (each cubic has its controls collinear with the chord so
/// the path renders as straight lines through the fill walker (ray-cast)).
export function rectContour(x, y, w, h) {
  const x1 = x + w, y1 = y + h;
  return {
    segments: [
      linearSeg([x,  y ], [x1, y ]),
      linearSeg([x1, y ], [x1, y1]),
      linearSeg([x1, y1], [x,  y1]),
      linearSeg([x,  y1], [x,  y ]),
    ],
    closed: true,
  };
}

/// Build a contour for a circle/ellipse centred at `(cx, cy)` with
/// radii `(rx, ry)`. Emits TWO native SVG arc segments (`A` commands)
/// which the importer keeps as SEG_ARC primitives end-to-end — the
/// coverage walker renders TRUE ellipses via `evalArc`, no Bezier
/// approximation, no shared-vertex cancellation, smaller curve
/// buffer (~40% the size of a 4-cubic approximation).
///
/// Native arcs render via a parametric θ sweep (not t-roots of a
/// cubic), so a circle has no "dead-axis cancellation" hairline at
/// canvas widths where the centre column lands on an exact pixel centre.
export function ellipseContour(cx, cy, rx, ry) {
  // Two semicircular arcs joined at the left + right cardinals.
  // sweep=true matches SVG's CW direction in y-down (positive area
  // for both arcs, NonZero fill renders inside as expected).
  return {
    segments: [
      arcSeg([cx - rx, cy], rx, ry, /*rotation=*/0, /*largeArc=*/false, /*sweep=*/true),
      arcSeg([cx + rx, cy], rx, ry, 0, false, true),
    ],
    closed: true,
  };
}

/// Build a contour for an arbitrary elliptical-arc shape. Each
/// segment is one SVG `A` command. End point of each segment is the
/// NEXT segment's `p0` (or `segments[0].p0` when closed).
///
/// Native arcs are the right primitive for any path whose curves are
/// elliptical (pie wedges, rings, button-rounded-rect corners, ...) —
/// they render TRUE ellipses through the coverage walker's `evalArc`
/// rather than approximating with cubics. A scene built only from
/// cubic segments will use cubics for these shapes — that path
/// remains supported.
export function arcContour(segments, closed = true) {
  return { segments: segments.slice(), closed };
}

/// Build a single arc segment for inclusion in an arcContour.
/// `p0` is the start point; the end is the NEXT segment's p0. SVG
/// `A rx ry rotation largeArc sweep endX endY` semantics apply.
export function arcSeg(p0, rx, ry, rotation = 0, largeArc = false, sweep = true) {
  return {
    kind: 'arc',
    p0: [p0[0], p0[1]],
    rx, ry, rotation, largeArc, sweep,
  };
}

/// Build a closed polygon contour from an [x,y] vertex list. Each
/// edge becomes a linear cubic.
export function polygonContour(points) {
  if (!Array.isArray(points) || points.length < 3)
    throw new Error('polygonContour: need ≥ 3 points');
  const segs = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    segs.push(linearSeg(a, b));
  }
  return { segments: segs, closed: true };
}

/// Build a single-segment "linear" cubic — controls collinear with
/// the chord so the path traces a straight line. Convenience for
/// callers building contours manually.
export function linearSeg(p0, p1) {
  // Controls coincident with the endpoints (C1 = p0, C2 = p1) lie on
  // the chord, so the curve is collinear with it and renders as a
  // straight line through the fill walker (ray-cast).
  return { p0: [p0[0], p0[1]], p1: [p0[0], p0[1]], p2: [p1[0], p1[1]] };
}

/// Compile a Scene into a `sections` dict suitable for createBundle.
/// Returns the same shape `importSvg` returns, so the caller can do:
///
///   const sections = await sceneToBundle(scene);
///   const bundle   = createBundle(gl, sections);
///
/// `opts` is forwarded to `importSvg` (baseUrl, etc.). Native arc
/// segments are always preserved end-to-end.
/// `opts.viewBox` (optional `[x, y, w, h]`) is forwarded to
/// `sceneToSvg` to pin the emitted viewBox instead of auto-computing
/// it from shape extents. Use this for animated scenes where shapes
/// move frame-to-frame: an auto-computed viewBox tracks the scene's
/// extent, which makes the bundle's "world" expand/contract between
/// frames and individual shape coordinates appear to shift on screen
/// even though their absolute values are unchanged.
export async function sceneToBundle(scene, opts = {}) {
  const svg = sceneToSvg(scene, opts.viewBox);
  return importSvg(svg, opts);
}

/// Compile a Scene DIRECTLY into a `sections` dict — the same output as
/// `sceneToBundle`, but WITHOUT the `sceneToSvg` → SVG-string → `importSvg`
/// round-trip. For a programmatic scene rebuilt per frame, that round-trip
/// is the dominant allocator (path-`d` string concatenation per segment, then
/// a full re-parse); this walks the scene tree and emits each shape straight
/// through the build context (the same `emitShape` `buildStreamableSections`
/// uses), skipping both.
///
/// SCOPE: the direct path handles SOLID-fill shapes with nested-node
/// transforms (the per-frame-rebuild road case). Scenes using gradient fills,
/// strokes, clippers/masks, or arc segments — which `emitShape` can't express
/// without the importer's gradient/clip machinery — transparently FALL BACK
/// to `sceneToBundle` (the SVG round-trip), so every scene still builds
/// correctly; only the supported subset gets the fast path.
///
/// Drop-in for `sceneToBundle`:
///   const bundle = createBundle(gl, await sceneToSections(scene));
///
/// @param {object} scene  { root: SceneNode }
/// @param {object} [opts]  { viewBox?: [x,y,w,h] } — pin the global bbox
///   (recommended for animated scenes; see `sceneToSvg`).
export async function sceneToSections(scene, opts = {}) {
  if (!scene || !scene.root) throw new Error('sceneToSections: scene.root required');
  // Anything the direct emit can't express → use the proven SVG round-trip.
  if (!sceneDirectEligible(scene.root)) return sceneToBundle(scene, opts);

  const ctx = makeBuildContext();
  const gidBox = { next: 1 };
  const bb = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  walkSceneDirect(scene.root, IDENTITY, ctx, gidBox, bb);

  const vb = (Array.isArray(opts.viewBox) && opts.viewBox.length === 4
    && opts.viewBox.every(v => Number.isFinite(v))) ? opts.viewBox : null;
  const fin = Number.isFinite(bb.xmin) && Number.isFinite(bb.xmax);
  // globalBBox semantics MATCH importSvg: path-tight content bbox by default;
  // the viewBox only when opts.preserveViewport is set. (The viewBox is still
  // recorded as sections.viewBox for preserveAspectRatio either way.)
  const cx = fin ? bb.xmin : 0, cy = fin ? bb.ymin : 0;
  const cw = fin ? Math.max(bb.xmax - bb.xmin, 1) : 1;
  const ch = fin ? Math.max(bb.ymax - bb.ymin, 1) : 1;
  const pv = !!opts.preserveViewport && vb;
  const bx = pv ? vb[0] : cx;
  const by = pv ? vb[1] : cy;
  const bw = pv ? Math.max(vb[2], 1) : cw;
  const bh = pv ? Math.max(vb[3], 1) : ch;

  const body = packMetaBody(ctx.metas);
  const meta = new ArrayBuffer(32 + body.byteLength);
  const dv = new DataView(meta);
  dv.setUint32(0, ctx.metas.length, true);
  dv.setFloat32(4, bx, true); dv.setFloat32(8, by, true);
  dv.setFloat32(12, bw, true); dv.setFloat32(16, bh, true);
  new Uint8Array(meta, 32).set(body);
  return {
    flags: 7, // HYBRID_MESH_IN_CGEOM | HYBRID_MESH_CHUNKED | WIDE_BAND_HEADERS
    numShapes: ctx.metas.length,
    metaFloatsPerShape: 48,
    meta,
    curves: texelToBytes(ctx.curveBuf).buffer,
    bands: texelToBytes(ctx.bandBuf).buffer,
    curveGeom: new Float32Array(ctx.hybridFloats).buffer,
    shapeIds: ctx.shapeIds.slice(),
    // viewBox is the PAR frame (pinned or content-derived), independent of the
    // globalBBox the meta header carries above.
    viewBox: vb ? [vb[0], vb[1], Math.max(vb[2], 1), Math.max(vb[3], 1)] : [cx, cy, cw, ch],
  };
}

// True when every shape in the tree is a plain solid fill with no
// stroke / clipper / gradient / arc — the subset emitShape can build
// directly. Anything else routes through the SVG round-trip.
function sceneDirectEligible(node) {
  if (!node) return true;
  if (node.clipper) return false;
  if (Array.isArray(node.shapes)) {
    for (const s of node.shapes) {
      const f = s.fill;
      if (f && f.kind && f.kind !== 'solid') return false;   // gradient / other paint
      if (s.pathProps && s.pathProps.stroke) return false;   // stroke needs the importer
      if (Array.isArray(s.contours)) {
        for (const c of s.contours) {
          const segs = c && c.segments;
          if (Array.isArray(segs)) for (const seg of segs) if (seg && seg.kind === 'arc') return false;
        }
      }
    }
  }
  if (Array.isArray(node.children)) for (const c of node.children) if (!sceneDirectEligible(c)) return false;
  return true;
}

// Resolve a solid fill to a premultiplied-into-alpha RGBA (fill opacity
// folded into A), matching emitFill's alpha math. null when there's no fill.
function solidFillRgba(fill) {
  if (!fill || fill.kind !== 'solid') return null;
  const c = fill.color || [0, 0, 0, 1];
  const a = (fill.opacity != null ? fill.opacity : 1) * (c.length >= 4 ? c[3] : 1);
  return [c[0], c[1], c[2], a];
}

// Convert a scene contour to importer-native cubic segs ({type, p1..p4}),
// transformed by m. Segment i runs segs[i].p0 → segs[i+1].p0 (or segs[0].p0
// when closed) with controls p1, p2 — the same threading emitPathData emits.
function contourToSegs(contour, m, out) {
  const segs = contour && contour.segments;
  if (!Array.isArray(segs) || !segs.length) return;
  const useM = !isIdentity(m);
  const tp = (p) => useM ? applyMat(m, p[0], p[1]) : [p[0], p[1]];
  const start = tp(segs[0].p0);
  let pen = start;
  for (let i = 0; i < segs.length; i++) {
    const cur = segs[i];
    let end;
    if (i + 1 < segs.length) end = segs[i + 1].p0;
    else if (contour.closed) end = segs[0].p0;
    else break;   // open contour: trailing anchor has no following segment
    const e = tp(end);
    out.push({ type: SEG_CUBIC, p1: tp(cur.p0), p2: tp(cur.p1), p3: tp(cur.p2), p4: e });
    pen = e;
  }
  // Synthetic subpath-close edge for fill, mirroring the importer (which adds
  // a fillOnly close line per subpath). Zero-length for an already-closed
  // contour (matches the importer's redundant Z close → byte parity); the real
  // closing edge for an open-but-filled contour (correct fill).
  out.push(mkLine(pen, [start[0], start[1]], /* fillOnly */ true));
}

function walkSceneDirect(node, parentM, ctx, gidBox, bb) {
  if (!node) return;
  const m = multiplyMat(parentM, nodeTransform(node));
  if (Array.isArray(node.shapes)) {
    for (const s of node.shapes) {
      const fill = solidFillRgba(s.fill);
      if (!fill) continue;   // fill:none (eligible scenes carry no stroke) → nothing to draw
      const out = [];
      if (Array.isArray(s.contours)) for (const c of s.contours) contourToSegs(c, m, out);
      if (!out.length) continue;
      emitShapeToCtx(ctx, out, {
        fillRgba: fill,
        shapeId: s.id || '',
        // Forward the fill rule — eligibility admits evenodd solids, and
        // defaulting to nonzero here made the direct path disagree with the
        // sceneToBundle round-trip on self-intersecting shapes.
        fillRule: (s.fill && s.fill.mode) || 'nonzero',
      }, gidBox, bb);
    }
  }
  if (Array.isArray(node.children)) for (const ch of node.children) walkSceneDirect(ch, m, ctx, gidBox, bb);
}

/// Compile a Scene into an SVG string. Exposed for advanced consumers
/// that want to inspect / mutate the emitted SVG before importing,
/// or that want to render the same scene through a non-Mantle SVG path.
///
/// `viewBoxOverride` (optional): when supplied as `[x, y, w, h]`, pins
/// the emitted SVG's viewBox to those exact values instead of computing
/// from the scene's shape extents. Required for per-frame-rebuilt
/// scenes whose shapes move — without it the auto-computed viewBox
/// jitters and rendered coordinates appear to shift between frames.
export function sceneToSvg(scene, viewBoxOverride) {
  if (!scene || !scene.root) throw new Error('sceneToSvg: scene.root required');
  const ctx = { gradients: new Map(), gradientDefs: [], clippers: new Map(), clipDefs: [], gradId: 1, clipId: 1 };
  let x0, y0, w, h;
  if (viewBoxOverride
      && Array.isArray(viewBoxOverride)
      && viewBoxOverride.length === 4
      && viewBoxOverride.every(v => Number.isFinite(v))) {
    x0 = viewBoxOverride[0];
    y0 = viewBoxOverride[1];
    w  = Math.max(viewBoxOverride[2], 1);
    h  = Math.max(viewBoxOverride[3], 1);
  } else {
    // First pass: compute scene-wide bbox so the emitted SVG's viewBox
    // fits the geometry exactly. Avoids the importer clipping anything
    // negative-coordinate at the global bbox.
    const bb = computeBbox(scene.root, IDENTITY);
    const finite = isFinite(bb[0]) && isFinite(bb[2]);
    x0 = finite ? bb[0] : 0;
    y0 = finite ? bb[1] : 0;
    w  = finite ? Math.max(bb[2] - bb[0], 1) : 1;
    h  = finite ? Math.max(bb[3] - bb[1], 1) : 1;
  }
  // Second pass: register gradient + clipper defs (depth-first walk).
  collectDefs(scene.root, ctx);
  // Third pass: emit the SVG body.
  let out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="'
    + F(x0) + ' ' + F(y0) + ' ' + F(w) + ' ' + F(h)
    + '" width="' + F(w) + '" height="' + F(h) + '">';
  if (ctx.gradientDefs.length || ctx.clipDefs.length) {
    out += '<defs>' + ctx.gradientDefs.join('') + ctx.clipDefs.join('') + '</defs>';
  }
  out += emitNode(scene.root, ctx);
  out += '</svg>';
  return out;
}

// ---- Internals ------------------------------------------------------

const IDENTITY = [1, 0, 0, 1, 0, 0];

function isIdentity(m) {
  return m && m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

function multiplyMat(a, b) {
  // SVG matrix(a b c d e f) compose: a * b applied to (x, y) =
  // (a.a*x + a.c*y + a.e, a.b*x + a.d*y + a.f).
  return [
    a[0]*b[0] + a[2]*b[1],
    a[1]*b[0] + a[3]*b[1],
    a[0]*b[2] + a[2]*b[3],
    a[1]*b[2] + a[3]*b[3],
    a[0]*b[4] + a[2]*b[5] + a[4],
    a[1]*b[4] + a[3]*b[5] + a[5],
  ];
}

function applyMat(m, x, y) {
  return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
}

function nodeTransform(n) {
  return Array.isArray(n.transform) && n.transform.length === 6
    ? n.transform : IDENTITY;
}

function computeBbox(n, parent) {
  let bb = [Infinity, Infinity, -Infinity, -Infinity];
  if (!n) return bb;
  const local = multiplyMat(parent, nodeTransform(n));
  if (Array.isArray(n.shapes))
    for (const s of n.shapes) bb = unionBbox(bb, shapeBbox(s, local));
  if (Array.isArray(n.children))
    for (const c of n.children) bb = unionBbox(bb, computeBbox(c, local));
  return bb;
}

function unionBbox(a, b) {
  if (!isFinite(b[0])) return a;
  if (!isFinite(a[0])) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
          Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function shapeBbox(s, m) {
  let bb = [Infinity, Infinity, -Infinity, -Infinity];
  if (!s || !Array.isArray(s.contours)) return bb;
  for (const c of s.contours) {
    if (!Array.isArray(c.segments)) continue;
    for (const seg of c.segments) {
      bb = expand(bb, applyMat(m, seg.p0[0], seg.p0[1]));
      if (seg.kind === 'arc') {
        // Loose bbox for an arc: expand p0 by (rx, ry) on each
        // axis. Catches the full elliptical extent regardless of
        // sweep direction or rotation. A loose bbox doesn't affect
        // render correctness — it just makes the auto-computed viewBox
        // slightly larger than tight; the importer recomputes anyway.
        const cx = seg.p0[0], cy = seg.p0[1];
        bb = expand(bb, applyMat(m, cx - seg.rx, cy - seg.ry));
        bb = expand(bb, applyMat(m, cx + seg.rx, cy - seg.ry));
        bb = expand(bb, applyMat(m, cx - seg.rx, cy + seg.ry));
        bb = expand(bb, applyMat(m, cx + seg.rx, cy + seg.ry));
      } else {
        if (seg.p1) bb = expand(bb, applyMat(m, seg.p1[0], seg.p1[1]));
        if (seg.p2) bb = expand(bb, applyMat(m, seg.p2[0], seg.p2[1]));
      }
    }
  }
  return bb;
}

function expand(bb, p) {
  return [Math.min(bb[0], p[0]), Math.min(bb[1], p[1]),
          Math.max(bb[2], p[0]), Math.max(bb[3], p[1])];
}

function collectDefs(n, ctx) {
  if (!n) return;
  if (n.clipper) registerClipper(n.clipper, ctx);
  if (Array.isArray(n.shapes))
    for (const s of n.shapes) {
      if (s.fill && s.fill.kind === 'gradient') registerGradient(s.fill, ctx);
      const stroke = s.pathProps && s.pathProps.stroke;
      if (stroke && stroke.fill && stroke.fill.kind === 'gradient')
        registerGradient(stroke.fill, ctx);
    }
  if (Array.isArray(n.children))
    for (const c of n.children) collectDefs(c, ctx);
}

function registerGradient(g, ctx) {
  if (!g || ctx.gradients.has(g)) return ctx.gradients.get(g);
  const id = ctx.gradId++;
  ctx.gradients.set(g, id);
  ctx.gradientDefs.push(buildGradientDef(g, id));
  return id;
}

function registerClipper(c, ctx) {
  if (!c || ctx.clippers.has(c)) return ctx.clippers.get(c);
  const id = ctx.clipId++;
  ctx.clippers.set(c, id);
  let body = '<clipPath id="clip' + id + '">';
  body += emitClipShapes(c, IDENTITY);
  body += '</clipPath>';
  ctx.clipDefs.push(body);
  return id;
}

function emitClipShapes(n, parent) {
  if (!n) return '';
  const local = multiplyMat(parent, nodeTransform(n));
  let out = '';
  if (Array.isArray(n.shapes))
    for (const s of n.shapes) {
      if (!Array.isArray(s.contours) || s.contours.length === 0) continue;
      out += '<path d="' + emitPathData(s.contours, local) + '"/>';
    }
  if (Array.isArray(n.children))
    for (const c of n.children) out += emitClipShapes(c, local);
  return out;
}

function emitNode(n, ctx) {
  if (!n) return '';
  const transform = nodeTransform(n);
  const needsWrap = !isIdentity(transform) || n.clipper != null;
  let out = '';
  if (needsWrap) {
    out += '<g';
    if (!isIdentity(transform)) out += ' transform="' + emitMatrix(transform) + '"';
    if (n.clipper) {
      const cid = registerClipper(n.clipper, ctx);
      out += ' clip-path="url(#clip' + cid + ')"';
    }
    out += '>';
  }
  if (Array.isArray(n.shapes))
    for (const s of n.shapes) out += emitShape(s, ctx);
  if (Array.isArray(n.children))
    for (const c of n.children) out += emitNode(c, ctx);
  if (needsWrap) out += '</g>';
  return out;
}

function emitMatrix(m) {
  return 'matrix(' + F(m[0]) + ' ' + F(m[1]) + ' ' + F(m[2]) + ' '
                  + F(m[3]) + ' ' + F(m[4]) + ' ' + F(m[5]) + ')';
}

function emitShape(s, ctx) {
  if (!s || !Array.isArray(s.contours) || s.contours.length === 0) return '';
  let out = '<path d="' + emitPathData(s.contours, IDENTITY) + '"';
  // Friendly id round-trips to `bundle.shapeIds` so consumers can
  // address shapes via `OverrideTable.set('bg', ...)` instead of the
  // importer's auto-generated `shape_N_fill` names. Empty / missing
  // id keeps the auto-naming fallback.
  if (s.id) out += ' id="' + escapeAttr(String(s.id)) + '"';
  out += emitFill(s.fill, ctx);
  out += emitStroke(s.pathProps && s.pathProps.stroke, ctx);
  if (s.fill && s.fill.mode === 'evenodd') out += ' fill-rule="evenodd"';
  out += '/>';
  return out;
}

/// Minimal SVG-attribute escape — only `&`, `<`, and `"` need
/// escaping inside a double-quoted attribute value. Newlines stay
/// literal (the importer's parser tolerates them). Validating against
/// the SVG `Name` grammar is left to the importer.
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function emitPathData(contours, m) {
  const useM = !isIdentity(m);
  let out = '';
  for (const c of contours) {
    const segs = c && c.segments;
    if (!Array.isArray(segs) || segs.length === 0) continue;
    let p0 = segs[0].p0;
    if (useM) p0 = applyMat(m, p0[0], p0[1]);
    out += 'M' + F(p0[0]) + ' ' + F(p0[1]);
    for (let i = 0; i < segs.length; i++) {
      const cur = segs[i];
      let endpoint;
      if (i + 1 < segs.length) endpoint = segs[i + 1].p0;
      else if (c.closed)       endpoint = segs[0].p0;
      else break;
      if (cur.kind === 'arc') {
        // SVG A rx ry rotation largeArc sweep endX endY. Note: the
        // CTM applies to the endpoint but radii / rotation are in
        // the local space — non-uniform CTM scaling of an arc would
        // emit a wrong path, so error out loudly if we see one.
        let ep = endpoint;
        let rScale = 1;
        if (useM) {
          if (Math.abs(m[0] - m[3]) > 1e-7 || Math.abs(m[1]) > 1e-7 || Math.abs(m[2]) > 1e-7) {
            throw new Error('sceneToSvg: arc segments inside a non-uniform-scaled <g> transform are not supported (decompose the arc to multiple sub-arcs at author time).');
          }
          ep = applyMat(m, ep[0], ep[1]);
          rScale = Math.abs(m[0]);   // uniform by the guard above — radii scale with the endpoints
        }
        const lA = cur.largeArc ? 1 : 0;
        const sw = (cur.sweep === false) ? 0 : 1;
        out += 'A' + F(cur.rx * rScale) + ' ' + F(cur.ry * rScale) + ' ' + F(cur.rotation || 0)
             + ' ' + lA + ' ' + sw + ' '
             + F(ep[0]) + ' ' + F(ep[1]);
      } else {
        // Default: cubic Bezier.
        let c1 = cur.p1, c2 = cur.p2;
        if (useM) {
          c1 = applyMat(m, c1[0], c1[1]);
          c2 = applyMat(m, c2[0], c2[1]);
          endpoint = applyMat(m, endpoint[0], endpoint[1]);
        }
        out += 'C' + F(c1[0]) + ' ' + F(c1[1]) + ' '
                  + F(c2[0]) + ' ' + F(c2[1]) + ' '
                  + F(endpoint[0]) + ' ' + F(endpoint[1]);
      }
    }
    if (c.closed) out += 'Z';
  }
  return out;
}

function emitFill(fill, ctx) {
  if (fill == null) return ' fill="none"';
  if (fill.kind === 'solid') {
    const c = fill.color || [0, 0, 0, 1];
    let out = ' fill="' + emitColor(c) + '"';
    const a = (fill.opacity != null ? fill.opacity : 1) * (c.length >= 4 ? c[3] : 1);
    if (a < 1) out += ' fill-opacity="' + F(a) + '"';
    return out;
  }
  if (fill.kind === 'gradient') {
    const id = registerGradient(fill, ctx);
    let out = ' fill="url(#g' + id + ')"';
    if (fill.opacity != null && fill.opacity < 1) out += ' fill-opacity="' + F(fill.opacity) + '"';
    return out;
  }
  return '';
}

function emitStroke(stroke, ctx) {
  if (!stroke || !(stroke.halfThickness > 0) || !stroke.fill) return '';
  let out = '';
  if (stroke.fill.kind === 'solid') {
    const c = stroke.fill.color || [0, 0, 0, 1];
    out += ' stroke="' + emitColor(c) + '"';
    if (c.length >= 4 && c[3] < 1) out += ' stroke-opacity="' + F(c[3]) + '"';
  } else if (stroke.fill.kind === 'gradient') {
    const id = registerGradient(stroke.fill, ctx);
    out += ' stroke="url(#g' + id + ')"';
  }
  out += ' stroke-width="' + F(stroke.halfThickness * 2) + '"';
  out += ' stroke-linecap="' + capStr(stroke.head) + '"';
  out += ' stroke-linejoin="' + joinStr(stroke.corners) + '"';
  out += ' stroke-miterlimit="' + F(stroke.tippedCornerLimit != null ? stroke.tippedCornerLimit : 10) + '"';
  if (Array.isArray(stroke.pattern) && stroke.pattern.length > 0) {
    out += ' stroke-dasharray="' + stroke.pattern.map(F).join(' ') + '"';
    if (stroke.patternOffset) out += ' stroke-dashoffset="' + F(stroke.patternOffset) + '"';
  }
  return out;
}

function capStr(end) {
  if (end === 'round')  return 'round';
  if (end === 'square') return 'square';
  return 'butt';
}

function joinStr(corner) {
  if (corner === 'round')   return 'round';
  if (corner === 'beveled') return 'bevel';
  return 'miter';
}

function emitColor(c) {
  const r = Math.max(0, Math.min(255, Math.round((c[0] || 0) * 255)));
  const g = Math.max(0, Math.min(255, Math.round((c[1] || 0) * 255)));
  const b = Math.max(0, Math.min(255, Math.round((c[2] || 0) * 255)));
  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
}

function buildGradientDef(g, id) {
  const tag = g.type === 'radial' ? 'radialGradient' : 'linearGradient';
  let out = '<' + tag + ' id="g' + id + '" gradientUnits="objectBoundingBox"';
  if (g.type === 'radial') {
    out += ' cx="0.5" cy="0.5" r="0.5"';
    if (Array.isArray(g.radialFocus) && (g.radialFocus[0] !== 0 || g.radialFocus[1] !== 0)) {
      out += ' fx="' + F(0.5 + 0.5 * g.radialFocus[0]) + '"';
      out += ' fy="' + F(0.5 + 0.5 * g.radialFocus[1]) + '"';
    }
  } else {
    // Linear: default is left→right across the shape bbox. Callers can
    // override with `start` / `end` (each `[x, y]` in objectBoundingBox
    // coords, 0..1 across width/height) to pick any direction —
    // including top→bottom for vertical gradients.
    const s = Array.isArray(g.start) ? g.start : [0, 0.5];
    const e = Array.isArray(g.end) ? g.end : [1, 0.5];
    out += ' x1="' + F(s[0]) + '" y1="' + F(s[1]) + '"';
    out += ' x2="' + F(e[0]) + '" y2="' + F(e[1]) + '"';
  }
  if (g.addressing === 'mirror') out += ' spreadMethod="reflect"';
  else if (g.addressing === 'wrap') out += ' spreadMethod="repeat"';
  out += '>';
  if (Array.isArray(g.stops))
    for (const s of g.stops) {
      const c = s.color || [0, 0, 0, 1];
      out += '<stop offset="' + F(s.position || 0) + '"'
          + ' stop-color="' + emitColor(c) + '"';
      if (c.length >= 4 && c[3] < 1) out += ' stop-opacity="' + F(c[3]) + '"';
      out += '/>';
    }
  out += '</' + tag + '>';
  return out;
}

function F(v) {
  // SVG number serialisation: short form, locale-invariant.
  const n = Math.abs(v) < 1e-7 ? 0 : v;
  let s = n.toFixed(6);
  if (s.indexOf('.') >= 0) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s;
}
