// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeBandEmu.mjs — shared by the stroke checks (not a test on its own).
//
// What the RENDERER reaches for one pixel of a stroke row, on the CPU, from an imported bundle:
//   * the row's cover quad (the importer's baked chunk; fragments exist only inside it),
//   * the H band the fragment picks through the META bbox (strokeMinDist),
//   * the band walk's line sub-loop with its break, far and saturation gates (strokeBandAccum,
//     uStrokeGates on or off),
//   * each listed LINE segment decoded from the curve texels and evaluated with the port of the
//     line branch in test/_strokeShapeRef.mjs, or — with `kind: 'quad'` — each listed QUAD
//     evaluated with the port of the curve branch in test/_strokeCurveRef.mjs.
// So a pad, band membership or reach that is too small shows up as a pixel center that SVG 2 puts
// inside the stroke and this leaves unpainted — which the port alone, looping over every segment,
// cannot see.
import { lineSeg, coverageTail } from './_strokeShapeRef.mjs';
import { quadSeg } from './_strokeCurveRef.mjs';

const TEX_W = 4096;
const M = {
  BB: 0,
  FILL_A: 7,
  STROKE_W: 12,
  ACCUM: 14,
  DASH: 15,
  GLX: 16,
  GLY: 17,
  BMX: 18,
  BMY: 19,
  CAP: 24,
  JOIN: 25,
  MITER: 26,
  ENDCAP: 46,
};

/** The shader's _reach (_coverage.glsl strokeBandAccum), in half-widths. */
export function shaderReachFactor(joinStyle, miterLimit, startCap, endCap) {
  const ml = Math.max(miterLimit, 1);
  return Math.max(
    joinStyle === 0 ? ml : joinStyle === 3 || joinStyle === 4 ? Math.sqrt(ml * ml + 1) : 1,
    startCap === 2 || endCap === 2 ? 1.41421356 : 1,
  );
}

function coverQuads(curveGeom) {
  const f = new Float32Array(curveGeom),
    byGid = new Map();
  for (let o = 0; o + 12 <= f.length;) {
    const nv = f[o] | 0,
      gid = f[o + 1] | 0,
      tris = [];
    const p = (v) => [f[o + 12 + v * 12], f[o + 12 + v * 12 + 1]];
    for (let v = 0; v + 2 < nv; v += 3) tris.push([p(v), p(v + 1), p(v + 2)]);
    // getCoverQuadMesh emits one rectangle as (c0, c1, c2, c0, c2, c3)
    tris.rect = nv === 6 ? [p(0), p(1), p(2), p(5)] : null;
    byGid.set(gid, tris);
    o += 12 + nv * 12;
  }
  return byGid;
}
const crs = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function inTris(tris, c, dilate = 0) {
  if (dilate > 0 && tris.rect) {
    // the vertex shader's coverQuadDilate moves each edge of the rectangle out by `dilate` (half a pixel)
    const [c0, c1, , c3] = tris.rect;
    const ux = c1[0] - c0[0],
      uy = c1[1] - c0[1],
      vx = c3[0] - c0[0],
      vy = c3[1] - c0[1];
    const lu = Math.hypot(ux, uy),
      lv = Math.hypot(vx, vy);
    const qx = c[0] - c0[0],
      qy = c[1] - c0[1];
    const su = (qx * ux + qy * uy) / lu,
      sv = (qx * vx + qy * vy) / lv;
    return su >= -dilate && su <= lu + dilate && sv >= -dilate && sv <= lv + dilate;
  }
  for (const [A, B, C] of tris) {
    const s1 = crs(A, B, c),
      s2 = crs(B, C, c),
      s3 = crs(C, A, c);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
  }
  return false;
}

/** The stroke rows (meta row indices) of an importSvg bundle. */
export function strokeRowsOf(bundle) {
  const meta = new Float32Array(bundle.meta, 32),
    stride = bundle.metaFloatsPerShape || 48,
    rows = [];
  for (let i = 0; i * stride < meta.length; i++)
    if (meta[i * stride + M.STROKE_W] > 0 && !(meta[i * stride + M.FILL_A] > 0)) rows.push(i);
  return rows;
}

/** A per-pixel evaluator for stroke row `row`: emu.eval([x, y]) -> { inQuad, minD, cov }. */
export function makeStrokeEmu(
  bundle,
  row,
  {
    rule = 'fixed',
    gates = true,
    bandBBox = null,
    reachFactor = null,
    dilate = 0,
    kind = 'line',
  } = {},
) {
  const meta = new Float32Array(bundle.meta, 32),
    stride = bundle.metaFloatsPerShape || 48,
    o = row * stride;
  const bands = new Float32Array(bundle.bands),
    curves = new Float32Array(bundle.curves);
  // bandBBox: index bands through this box instead of the meta bbox (a diagnostic, not the shader)
  const bb = bandBBox || [meta[o], meta[o + 1], meta[o + 2], meta[o + 3]];
  const halfW = meta[o + M.STROKE_W] * 0.5,
    joinStyle = meta[o + M.JOIN] | 0,
    miterLimit = meta[o + M.MITER];
  // Slot 46 carries (endCap + 1) on a stroke row, 0 = "same as the start cap" — the encoding
  // mantle.frag.glsl decodes. It is the rect corner radius on a primKind-3 row, which has no
  // segments to walk here.
  const cap = meta[o + M.CAP] | 0,
    endEnc = meta[o + M.ENDCAP] | 0,
    endCap = endEnc === 0 ? cap : endEnc - 1;
  if (meta[o + M.DASH] > 0) throw new Error('dashes are not modelled');
  const tris = coverQuads(bundle.curveGeom).get(meta[o + M.ACCUM] | 0) || [];
  const gl = meta[o + M.GLY] * TEX_W + meta[o + M.GLX];
  const bandsY = (meta[o + M.BMY] | 0) + 1;
  // reachFactor: another shader's _reach (e.g. an alternative build's), in half-widths
  // The shader's strokeAaReachEm at one em per pixel (ePx = (1, 1)): how far past halfW coverage is
  // still nonzero. Added to the reach and to the break, as strokeBandAccum does.
  const aaEm = Math.max(0.5 - halfW, 0) + 0.5 * Math.SQRT2;
  const reach =
    halfW *
      (reachFactor != null ? reachFactor : shaderReachFactor(joinStyle, miterLimit, cap, endCap)) +
    aaEm;
  const texel = (arr, lin) => arr.subarray(lin * 4, lin * 4 + 4);
  const segCache = new Map();
  const segAt = (loc) => {
    let s = segCache.get(loc);
    if (s) return s;
    const hdr = texel(curves, loc),
      pts = texel(curves, loc + 1);
    if (kind === 'quad') {
      // encodeSeg's SEG_QUAD layout: hdr, (p1, p2), (p3, startPrevReach, endNextReach), (inTan,
      // outTan), and the arcs-join curvature texel after it when the row is stroke-linejoin:arcs.
      const p3 = texel(curves, loc + 2),
        jn = texel(curves, loc + 3);
      const cv = joinStyle === 4 ? texel(curves, loc + 4) : [0, 0, 0, 0];
      s = {
        skip: (hdr[0] & 4) !== 0,
        freeStart: hdr[1] > 0.5,
        freeEnd: hdr[2] > 0.5,
        p0: [pts[0], pts[1]],
        p1: [pts[2], pts[3]],
        p2: [p3[0], p3[1]],
        startPrevReach: p3[2],
        endNextReach: p3[3],
        inTan: [jn[0], jn[1]],
        outTan: [jn[2], jn[3]],
        kSS: cv[0],
        kSE: cv[1],
        kPE: cv[2],
        kNS: cv[3],
      };
    } else {
      const jn = texel(curves, loc + 2);
      s = {
        skip: (hdr[0] & 4) !== 0,
        freeStart: hdr[1] > 0.5,
        freeEnd: hdr[2] > 0.5,
        a: [pts[0], pts[1]],
        b: [pts[2], pts[3]],
        inTan: [jn[0], jn[1]],
        outTan: [jn[2], jn[3]],
      };
    }
    segCache.set(loc, s);
    return s;
  };
  const satD = Math.max(halfW - 0.5 * Math.SQRT2, 0); // max(halfW - 0.5 * length(ePx), 0) at one em per pixel
  return {
    halfW,
    joinStyle,
    miterLimit,
    cap,
    endCap,
    reach,
    tris,
    eval(c) {
      // dilate: the cover quad's half-pixel dilation in em (0 = the baked quad alone, the strict test)
      const inQuad = inTris(tris, c, dilate);
      const bbH = Math.max(bb[3] - bb[1], 1e-6);
      const by = Math.min(Math.max(Math.trunc(((c[1] - bb[1]) / bbH) * bandsY), 0), bandsY - 1);
      const hdr = gl + by * 2;
      const cnts = texel(bands, hdr),
        arrIdx = bands[(hdr + 1) * 4] | 0;
      // the far gate reads z as the far bound, which a structure with ray-range reject lanes does not hold (farGate)
      const farGate = gates && ((bands[(hdr + 1) * 4 + 1] | 0) & 1) === 0;
      // the band's per-type counts (nLine, nQuad, nCubic, nArc); the entry array is in that order
      const nLine = cnts[0] | 0,
        nQuad = cnts[1] | 0;
      const first = kind === 'quad' ? nLine : 0,
        count = kind === 'quad' ? nQuad : nLine;
      let minD = 1e20,
        grad = [0, 0];
      for (let i = first; i < first + count; i++) {
        const e = texel(bands, gl + arrIdx + i);
        if (e[1] < c[0] - halfW - aaEm) break;
        if (farGate && e[2] > c[0] + reach) continue;
        const s = segAt(e[0]);
        if (s.skip) continue;
        const r =
          kind === 'quad'
            ? quadSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap)
            : lineSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap);
        if (r.d < minD) {
          minD = r.d;
          grad = r.g || [0, 0];
        }
        if (gates && minD <= satD) break;
      }
      return { inQuad, minD, cov: inQuad ? coverageTail(minD, grad, halfW) : 0 };
    },
  };
}
