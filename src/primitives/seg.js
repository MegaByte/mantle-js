// primitives/seg.js — the shared path-segment primitive.
//
// Single source of truth for the segment type tags + factories that BOTH the
// font glyph readers and the SVG path layer emit. Bundles cross that boundary,
// so the type numbering (Line=0/Quad=1/Cubic=2/Arc=3) MUST be identical on both
// sides. svg/segment.js and font/segTypes.js re-export these.
//
// Segment objects are lightweight tagged JS values; consumers branch on
// `.type` (SEG_*). `mkLine` carries `is_fill_only` (a fill-only edge that
// the stroker skips); quad/cubic never are.

// ---- segment type tags ----
export const SEG_LINE  = 0;
export const SEG_QUAD  = 1;
export const SEG_CUBIC = 2;
export const SEG_ARC   = 3;
// SEG_RQUAD is a CPU-ONLY tag the Loop-Blinn builders use to carry an arc as an
// EXACT rational-quadratic Bézier (control triangle p1,p2,p3 + weight w). It is
// never emitted by the font/svg importers and never written to a bundle curve
// buffer (which only uses the masked tags 0-3), so it doesn't cross the
// cross-language boundary the tags above must agree on.
export const SEG_RQUAD = 4;

// ---- segment constructors ----
export function mkLine(p1, p2, fillOnly = false) {
  return { type: SEG_LINE, p1, p2, is_fill_only: fillOnly };
}
export function mkQuad(p1, p2, p3)      { return { type: SEG_QUAD,  p1, p2, p3 }; }
export function mkCubic(p1, p2, p3, p4) { return { type: SEG_CUBIC, p1, p2, p3, p4 }; }
// Rational-quadratic Bézier (arc): control triangle p1,p2,p3 with middle weight w.
// `circle` (optional) = {cx,cy,r} when the arc is CIRCULAR (rx==ry, no rotation) —
// lets the Loop-Blinn builders render it as an exact circular-SDF sector (kind 7),
// which tiles seam-free across arc joins, instead of a per-piece rquad crescent.
export function mkRQuad(p1, p2, p3, w, circle)  { return { type: SEG_RQUAD, p1, p2, p3, w, circle: circle || null }; }
