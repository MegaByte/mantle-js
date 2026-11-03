// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _synthBoldInkModel.mjs — how much ink a synthetically bolded run GAINS from its stroke row's pad, on the CPU.
// Shared by probes/strokeRest/_synthBoldInk.mjs (which prints it) and
// test/synthBoldInkModelSmoke.mjs (which holds it to the two measured renders). Not a test.
//
// WHAT THE PAD DOES. Synthetic bold has no SVG form: with no bold face to select,
// font/textColrEmit.js paints the run's color as a 0.04 em STROKE on top of each glyph's fill,
// through the one `svg/buildContext.js` emitShape every glyph goes through. An emit that sized
// the row from the PATH box alone (band-membership pad 0, cover-quad pad 0, meta bbox path-tight)
// would leave the outer half of the synthesised weight with no fragments wherever the outline
// touches its own bbox. This re-emits each glyph's decoded outline through the shipped emitShape
// and through an UNPADDED one (PRE_FIX) and reports the DIFFERENCE in rendered ink.
//
// WHY NOT THE NAIVE MODEL, which reads 44% high. It asks "how much stroke coverage does the
// unpadded COVER QUAD exclude", as a plain difference of two coverages gated on the baked quad.
// Two things are wrong with that, and the render shows both:
//
//  1. THE QUAD IS NOT THE BAKED RECTANGLE. mantle.vert.glsl's coverQuadDilate pushes every
//     cover-quad corner outward along its bisector before rasterization, by exactly half a
//     DEVICE pixel per edge. (2-D ortho, so m3 = (0,0,0,1) and s = 1, t = 0; then
//     |(u,v)| = 2·|(pxX·n̂x, pxY·n̂y)|, and for an AABB corner with normal (±1,±1) that is 2·P,
//     so Δem = (±1,±1)/2P — half a pixel on each axis. Same for the OBB's ±û±v̂.) The unpadded
//     build already paints that band, and the naive model counts it as excluded. It is a perimeter
//     times a fixed device reach, so it is SCALE-LINEAR in device pixels: 311 px of the 1307
//     at 96 px/em, and 627 of the 4892 at 192.
//
//  2. THE EXCLUDED REGION IS NOT DISJOINT FROM THE FILL. The naive model needs no fill term
//     only if "the excluded region is outside the path and the fill is inside it, so the two do
//     not overlap". That is false, and band membership is why. The
//     unpadded build indexes bands through a PATH-TIGHT bbox with pad 0; the shipped one pads
//     the meta bbox by halfW and band membership by the full stroke reach (up to 4·halfW at a
//     miter). So the shipped band walk reaches pixels the unpadded walk does not — including
//     pixels on the INNER half of the stroke, which lie inside the path, where the fill is
//     already solid. emitShape puts the fill and the stroke on ONE meta row, so the row's
//     coverage is their union: added stroke coverage over an already-opaque fill adds no ink at
//     all. Worth 238 px at 96 px/em and 663 at 192: the gain there is zero, not merely smaller.
//
// So the gain per pixel is `max(fill, strokeNew) − max(fill, strokeOld)`, with both strokes
// gated on the DILATED quad. Against the measured renders (0.000 A/A floor, byte-identical
// across Slug, Loop-Blinn and CPatch): 746.6 against 724.0 at 96 px/em (+3.1%) and 3548.8
// against 3548.4 at 192 (+0.01%).
//
// WHAT IS still APPROXIMATED, which is where the 3.1% at 96 px/em lives: coverage is the
// renderer's slope ramp evaluated at the pixel CENTER rather than an exact area, so a pixel
// holding a corner, a join or both edges of a 3.84 px-wide stroke is off by a little, and that
// error is a boundary effect — it shrinks with size, which is exactly the shape of the residual.
// The fill's own coverage is taken from ONE build (the shipped one); where the outline runs
// along the unpadded bbox the unpadded fill is clipped where the shipped one is not, so the render
// also gains a sliver of FILL ink that this does not model. Both are named rather than folded
// into a fudge factor.
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');

const { decodeSegs, curveView, SEG_LINE, SEG_QUAD } = await import('../src/hitTest/curveGeom.js');
const { packMetaBody } = await import('../src/svg/meta.js');
const { texelToBytes } = await import('../src/svg/textures.js');
const { makeStrokeEmu } = await import('./_strokeBandEmu.mjs');

// buildContext.js as shipped and with the stroke pad taken out (PRE_FIX).
const BC_PATH = path.join(ROOT, 'src/svg/buildContext.js');
const BC_SRC = readFileSync(BC_PATH, 'utf8');
const loadBC = (src) => {
  const abs = src.replace(
    /from '(\.\.?\/[^']+)'/g,
    (m, rel) => `from '${new URL(rel, pathToFileURL(BC_PATH)).href}'`,
  );
  return import('data:text/javascript;base64,' + Buffer.from(abs).toString('base64'));
};
export const PAD_HINGE = `  const strokePad = hasStroke
    ? halfW * strokeReachFactor(opts.joinStyle | 0, opts.miterLimit ?? 4, opts.capStyle | 0,
                                opts.endCapStyle == null ? (opts.capStyle | 0) : opts.endCapStyle)
    : 0;
  const bbMeta = hasStroke ? [bb[0] - halfW, bb[1] - halfW, bb[2] + halfW, bb[3] + halfW] : bb;`;
if (!BC_SRC.includes(PAD_HINGE))
  throw new Error('buildContext hinge missing — this model is out of date');
const SHIPPED = await loadBC(BC_SRC);
const PRE_FIX = await loadBC(
  BC_SRC.replace(PAD_HINGE, '  const strokePad = 0;\n  const bbMeta = bb;'),
);

/// One shape's segments through emitShape, packed into the sections dict the emulator reads.
// both ARMS BUILD BOX COVERS (coverFan: false, the test hook). The GPU gains this model is held to are measured between
// two box-cover builds; the unpadded arm's row would otherwise take a fan, and the model reads its cover as a quad.
function emitBundle(BC, segs, opts) {
  const ctx = BC.makeBuildContext({ coverFan: false });
  BC.emitShape(ctx, segs, opts, { next: 1 }, null);
  const body = packMetaBody(ctx.metas);
  const ab = new ArrayBuffer(32 + body.byteLength);
  new DataView(ab).setUint32(0, ctx.metas.length, true);
  new Uint8Array(ab, 32).set(body);
  return {
    numShapes: ctx.metas.length,
    metaFloatsPerShape: 48,
    meta: ab,
    curves: texelToBytes(ctx.curveBuf).buffer,
    bands: texelToBytes(ctx.bandBuf).buffer,
    curveGeom: new Float32Array(ctx.hybridFloats).buffer,
  };
}

/// The emulator's answer over both segment kinds a TrueType outline carries.
const evalBoth = (a, b, c) => {
  const ra = a.eval(c),
    rb = b.eval(c);
  return { inQuad: ra.inQuad || rb.inQuad, minD: Math.min(ra.minD, rb.minD) };
};

/// Nonzero winding of a TrueType outline at (x, y), by horizontal ray crossings. Only its SIGN
/// is used — to turn the stroke walk's unsigned distance into the fill's signed one — so a
/// 16-chord flattening of each quad is far finer than it needs to be.
function insidePath(segs, x, y) {
  let w = 0;
  const cross = (x0, y0, x1, y1) => {
    if (y0 <= y === y1 <= y) return;
    const t = (y - y0) / (y1 - y0);
    if (x0 + t * (x1 - x0) > x) w += y1 > y0 ? 1 : -1;
  };
  for (const s of segs) {
    if (s.type === SEG_LINE) {
      cross(s.p1[0], s.p1[1], s.p2[0], s.p2[1]);
      continue;
    }
    const [ax, ay] = s.p1,
      [bx, by] = s.p2,
      [cx, cy] = s.p3;
    let px = ax,
      py = ay;
    for (let k = 1; k <= 16; k++) {
      const t = k / 16,
        u = 1 - t;
      const qx = u * u * ax + 2 * u * t * bx + t * t * cx;
      const qy = u * u * ay + 2 * u * t * by + t * t * cy;
      cross(px, py, qx, qy);
      px = qx;
      py = qy;
    }
  }
  return w !== 0;
}

/**
 * The ink a synthetically bolded run gains from its stroke row's pad, in device pixels.
 *
 * @param {object} sections buildTextSections output for the run (weight 700, no bold face)
 * @param {number} PX       device pixels per em the run is drawn at
 * @returns {{total:number, rows:Array, quadDilation:number, fillAlready:number}}
 *   `quadDilation` and `fillAlready` are what the two corrections remove, so a caller can see
 *   which of them a disagreement is about.
 */
export function synthBoldInkGain(sections, PX) {
  const meta = new Float32Array(sections.meta, 32),
    st = sections.metaFloatsPerShape | 0;
  const nRows = Math.floor(meta.length / st);
  const cv = curveView({ curves: sections.curves });
  const ranges = sections.curveRangesByShape;
  // HALF A DEVICE PIXEL, IN EM — what coverQuadDilate moves each cover-quad edge outward by
  // before rasterization. See the header for the derivation; it is why the unpadded build already
  // paints a band the naive model counts as excluded.
  const DILATE_PX = 0.5;
  const D = DILATE_PX / PX;

  const rows = [];
  let total = 0,
    quadDilation = 0,
    fillAlready = 0;
  for (let i = 0; i < nRows; i++) {
    const o = i * st,
      sw = meta[o + 12],
      halfW = sw * 0.5;
    if (!(halfW > 0) || !ranges || !ranges[i]) continue;
    const hit = decodeSegs(cv, ranges[i].begin, ranges[i].end, meta[o + 25] | 0);
    const segs = [];
    for (const s of hit) {
      if (s.t === SEG_LINE) segs.push({ type: SEG_LINE, p1: [s.x0, s.y0], p2: [s.x1, s.y1] });
      else if (s.t === SEG_QUAD)
        segs.push({ type: SEG_QUAD, p1: [s.x0, s.y0], p2: [s.cx, s.cy], p3: [s.x1, s.y1] });
      else {
        segs.length = 0;
        break;
      } // a cubic or an arc: not a TrueType outline
    }
    if (!segs.length) continue;
    const opts = {
      fillRgba: [0, 0, 0, 1],
      strokeRgba: [0, 0, 0, 1],
      strokeWidth: sw,
      joinStyle: meta[o + 25] | 0,
      miterLimit: meta[o + 26] || 4,
      capStyle: meta[o + 24] | 0,
    };
    const bPre = emitBundle(PRE_FIX, segs, opts),
      bNew = emitBundle(SHIPPED, segs, opts);
    // The unpadded quad carries its AA dilation; the shipped one is already padded by halfW, and
    // its own dilation lands outside everything either build paints.
    const pre = [
      makeStrokeEmu(bPre, 0, { kind: 'line', dilate: D }),
      makeStrokeEmu(bPre, 0, { kind: 'quad', dilate: D }),
    ];
    const bare = [
      makeStrokeEmu(bPre, 0, { kind: 'line' }),
      makeStrokeEmu(bPre, 0, { kind: 'quad' }),
    ];
    const post = [
      makeStrokeEmu(bNew, 0, { kind: 'line' }),
      makeStrokeEmu(bNew, 0, { kind: 'quad' }),
    ];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of segs)
      for (const p of [s.p1, s.p2, s.p3].filter(Boolean)) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    const pad = halfW * 5 + 2 / PX;
    // The renderer's slope ramp in DEVICE pixels — not the emulator's own `cov`, which is only
    // valid at one em per pixel.
    const ramp = (r) => (r.inQuad ? Math.min(1, Math.max(0, 0.5 - (r.minD - halfW) * PX)) : 0);
    let gain = 0,
      dGain = 0,
      fGain = 0;
    for (let py = Math.floor((y0 - pad) * PX); py <= Math.ceil((y1 + pad) * PX); py++)
      for (let px = Math.floor((x0 - pad) * PX); px <= Math.ceil((x1 + pad) * PX); px++) {
        const c = [(px + 0.5) / PX, (py + 0.5) / PX];
        const rn = evalBoth(post[0], post[1], c);
        const covN = ramp(rn),
          covP = ramp(evalBoth(pre[0], pre[1], c));
        // The FILL's coverage on the same meta row: the stroke walk's distance to the outline,
        // signed by the fill rule, through the same ramp. Deep inside the path the walk reports
        // no segment at all (1e20), which signs to "solid" and is the right answer.
        const f = Math.min(
          1,
          Math.max(0, 0.5 - (insidePath(segs, c[0], c[1]) ? -rn.minD : rn.minD) * PX),
        );
        gain += Math.max(f, covN) - Math.max(f, covP);
        // What each correction removes, against the naive model, which has neither.
        const covBare = ramp(evalBoth(bare[0], bare[1], c));
        dGain += covP - covBare;
        fGain += covN - covP - (Math.max(f, covN) - Math.max(f, covP));
      }
    total += gain;
    quadDilation += dGain;
    fillAlready += fGain;
    const mbPre = new Float32Array(bPre.meta, 32),
      mbNew = new Float32Array(bNew.meta, 32);
    rows.push({
      row: i,
      halfWpx: halfW * PX,
      gain,
      bboxPre: [0, 1, 2, 3].map((k) => mbPre[k] * PX),
      bboxNew: [0, 1, 2, 3].map((k) => mbNew[k] * PX),
    });
  }
  // Both are reported as POSITIVE amounts the correction takes OFF the naive model's answer.
  return { total, rows, quadDilation, fillAlready };
}
