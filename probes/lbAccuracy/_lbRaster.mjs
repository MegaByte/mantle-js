// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbRaster — draw a shape's Loop-Blinn mesh on the CPU exactly as the unified fill pass draws it,
// and hand back the coverage buffer plus, per pixel, WHICH kinds painted it.
//
// THE DRAW, as modelled (unifiedFillDraw.js + mantle.vert.glsl):
//   * the renderer fits `bundle.globalBBox` to the viewport --
//     THAT BOX AND NO OTHER, because it is the one bound to uGlobalBBox and the one arScale turns
//     into uCanvasAR. On a square canvas one device pixel is max(gw, gh)/N em and the mapping is
//     ISOTROPIC. That number is `basePx`, which is also `vEmPerPx` for every vertex (no world
//     matrix). The CONTROL-POINT HULL would be a different box wherever an off-curve control
//     point lies outside its curve -- 4.4% and 21.8 em out on tiger, i.e. a different SIZE of
//     drawing compared against the GPU's.
//   * a triangle covers a pixel when the pixel CENTER is inside it (the rasterizer's rule), with
//     GL's top-left tie-break so a shared edge is claimed once.
//   * `flat` varyings come from the LAST vertex of the triangle (GL's default provoking convention).
//   * an opaque static bundle takes unifiedFillDraw's NO-CLAIM path: depth off, blendFunc
//     (ONE, ONE_MINUS_SRC_ALPHA). One color under OVER gives alpha = 1 - prod(1 - c), which is
//     order-independent — so the buffer does not depend on the emission order and a reordering of
//     the pack cannot move it.
//
// The em->screen map has em +y DOWNWARD (clip.y = -plane.y), so row j increases with em y. dFdy is
// therefore -basePx in window coordinates; every use of it in the kernel is invariant under that
// sign (kappa is quadratic in the y derivative, fxy is bilinear and appears only multiplied by fy),
// so the model carries +basePx and the two agree exactly.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeVert, lbVertexSetup, lbCoverage, LBK, LB_VERT_FLOATS } from './_lbKernel.mjs';
import { orient2dXY } from '../../src/geom/predicates.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Import an SVG with the DOM shims the probes use. */
export async function loadSvg(file) {
  const xd = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
  globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
  const { default: importSvg } = await import('../../src/svg/importer.js');
  // PRESERVE_VIEWPORT=1 imports the way a page that passes `{ preserveViewport: true }` does: the viewBox is the box.
  return importSvg(
    readFileSync(path.resolve(ROOT, file), 'utf8'),
    process.env.PRESERVE_VIEWPORT === '1' ? { preserveViewport: true } : undefined,
  );
}

/**
 * Every shape's contours, its fill rule, and THE BOX THE RENDERER FITS.
 *
 * `bbox` is the bundle's own `globalBBox`, because that is the box the em->screen map is built
 * from: mantle.vert computes `uv = (em - uGlobalBBox.xy) / uGlobalBBox.zw` and the fragment's
 * `basePx = uGlobalBBox.z / (uCanvasAR.x * uViewportSize.x)`, with uGlobalBBox bound straight from
 * `bundle.globalBBox` (fillPass.js `u4f(variant, 'gbb', ...)`) and uCanvasAR from `arScale` of the
 * same box. Any other box is a different drawing.
 *
 * THE CONTROL-POINT HULL walked below is NOT that box: an off-curve control point sits outside
 * the curve it steers, so on tiger the hull reads 879.96 x 940.03 at (0.152, -21.844) against the
 * bundle's 873.05 x 900.00 at (0, 0) — a 4.4% scale error plus a translation, i.e. a model fitted
 * to it renders a DIFFERENT SIZE of tiger than the GPU and then compares the two per pixel. That
 * is enough on its own to put a corner pixel at 255/255 disagreement. `hullBbox` is returned for a
 * caller that genuinely wants the control hull.
 *
 * `opt.fit === 'hull'` fits the hull instead, so a number taken on a hull fit can be reproduced;
 * a comparison that cannot reproduce what it compares against is an assertion. `FIT=hull` on the audits.
 */
export async function shapesOf(bundle, opt) {
  const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
  const { isStrokeRow } = await import('../../src/renderer/engineLedger.js');
  const cf = new Float32Array(bundle.curves);
  // metaFloats is a view the importer may not have materialised; the buffer always has a
  // 32-byte header, and wrapping it whole mis-routes shapes.
  const meta = bundle.metaFloats || new Float32Array(bundle.meta, 32);
  const st = bundle.metaFloatsPerShape | 0;
  const out = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let s = 0; s < bundle.numShapes; s++) {
    const r = bundle.curveRangesByShape && bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    // `opt.rows === 'fill'`: only THE ROWS THE FILL PASS MESHES. A STROKE row is drawn by its cover quad
    // and the stroke kernel, never by its Loop-Blinn mesh (unifiedFillDraw: "A STROKE ROW never TAKES ITS LB MESH"), and
    // a row with no fill paint, a group bracket or a COLR mask-only row is not drawn as a fill at all (bundle.js
    // buildDrawList). A comparison with a RENDER needs this set: meshing and filling every row painted each stroked
    // path's interior a second time and every stroke-only path solid -- 3,034 px off by more than 4/255 on tiger at
    // 512 px, the largest share of what _gpuModelCheck reported against the GPU. The default stays every row with
    // curves, which is what the BUILDER probes (cover guard, build-path drift, T-junctions) ask about.
    if (opt && opt.rows === 'fill') {
      const b0 = s * st,
        flags = st >= 28 ? Math.floor(meta[b0 + 27] + 0.5) : 0;
      if ((flags & (64 | 128 | 256)) !== 0) continue;
      if (!(meta[b0 + 7] > 0) || !(Math.floor(meta[b0 + 14] + 0.5) > 0) || isStrokeRow(meta, st, s))
        continue;
    }
    let cs = null;
    try {
      cs = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      cs = null;
    }
    if (!cs || !cs.length) continue;
    for (const c of cs)
      for (const sg of c)
        for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
          if (!p) continue;
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
    const b = s * st;
    out.push({
      s,
      contours: cs,
      evenOdd: meta[b + 13] > 0.5,
      // FILL ALPHA ZERO (`fill="none"`, a stroke-only row): the mesh is built and draws no fill, so _lbAaAudit scores
      // it apart from the picture.
      noFill: !(meta[b + 7] > 0),
      // buildLbShape's `transSolid`: a translucent, unclipped, unfiltered solid.
      transSolid:
        meta[b + 7] < 0.996 &&
        Math.floor(meta[b + 28] + 0.5) === 0 &&
        (st < 36 || Math.floor(meta[b + 35] + 0.5) === 0),
    });
  }
  const hullBbox = [x0, y0, x1, y1];
  const g = bundle.globalBBox;
  const fitBbox =
    g && g.length === 4 && g[2] > 0 && g[3] > 0 ? [g[0], g[1], g[0] + g[2], g[1] + g[3]] : hullBbox;
  const bbox = opt && opt.fit === 'hull' ? hullBbox : fitBbox;
  return { shapes: out, bbox, hullBbox, fitBbox, globalBBox: g ? Array.from(g) : null };
}

/**
 * The raster geometry the renderer would use for an NxN canvas showing `bbox` (x0,y0,x1,y1).
 *
 * DERIVED FROM THE SHADER, not guessed. mantle.vert maps em -> window as
 *   uv    = (em - g.xy) / g.zw
 *   plane = (uv*2 - 1) * canvasAR            canvasAR = arScale(g, N, N)
 *   px.x  = (plane.x + 1) * N/2              px.y = (1 + plane.y) * N/2   (top-down)
 * On a SQUARE canvas arScale gives (1, gh/gw) when gw > gh and (gw/gh, 1) otherwise, so both axes
 * scale by N / max(gw, gh): the map is isotropic with `basePx = max(gw, gh) / N` and the box's
 * center lands at the canvas center. The fragment's own `basePx` is
 * `g.z / (canvasAR.x * N)`, which is the same number on either branch.
 *
 * NON-SQUARE CANVASES ARE NOT MODELLED — arScale would then give two different axis scales and
 * `vEmPerPx` (one flat float) could not describe the map. Every probe here renders NxN.
 */
export function viewOf(bbox, N) {
  const [x0, y0, x1, y1] = bbox;
  const ext = Math.max(x1 - x0, y1 - y0);
  const basePx = ext / N;
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  return {
    N,
    basePx,
    ox: cx - (N / 2) * basePx,
    oy: cy - (N / 2) * basePx,
    emX(i) {
      return this.ox + (i + 0.5) * this.basePx;
    },
    emY(j) {
      return this.oy + (j + 0.5) * this.basePx;
    },
  };
}

/** Build one shape's LB mesh; null when the builder declines it (Slug would draw it). */
export async function buildMesh(sh) {
  const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
  let b = null;
  try {
    b = buildLbShape(sh.contours, sh.transSolid, sh.evenOdd);
  } catch {
    b = null;
  }
  if (!b || !b.pk || !b.pk.vertexCount) return null;
  if (b.pk.fallback && b.pk.fallback.length) return null;
  return b;
}

// Screen-space edge function with GL's top-left tie-break, so a pixel center on a shared edge is
// claimed by exactly one of the two triangles.
//
// THE SIGN MUST BE exact, not merely computed in doubles. A pixel center lying ON a shared edge is
// not rare here: a CDT interior is a fan of triangles whose shared edges run through the raster,
// and the two sides evaluate the determinant from DIFFERENT vertex orders, so plain doubles can
// hand both of them a tiny same-signed value and the pixel is dropped by both. Measured on a
// 45-degree diamond at 512 px: 38 interior pixels painted by nothing (exact 1.000, model 0.000) in
// runs along the interior diagonals -- an artifact of the model's rasterizer, not of the kernel.
// Shewchuk's adaptive predicate (src/geom/predicates.js, already the mesher's own) decides the
// uncertain band exactly, and the top-left rule then breaks the true ties antisymmetrically.
const UNSURE = 1e-9;
function topLeft(ax, ay, bx, by) {
  return ay === by ? bx < ax : by < ay;
}
function edgeAccept(ax, ay, bx, by, px, py, tl) {
  let e = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (e > UNSURE) return true;
  if (e < -UNSURE) return false;
  e = orient2dXY(ax, ay, bx, by, px, py);
  return e > 0 || (e === 0 && tl);
}

/**
 * Rasterize a packed LB mesh over the view and composite by OVER.
 * `acc` is a Float64Array of N*N "open" values (1 - alpha), seeded to 1.
 * `kindAcc`, when given, records the kinds that painted each pixel as a bitmask; `domAcc` records
 * the kind of the LARGEST single contribution, which is the pixel's dominant painter and what an
 * attribution by mechanism needs (a 0.9 band and a 0.02 strip are not equally responsible).
 * An INTERIOR face is reported as its own sub-kind: 0 solid, 20 line rows, 21 chain, 22 conic.
 */
export function rasterMesh(pk, view, acc, opt, kindAcc, domAcc, domCov) {
  const v = pk.verts,
    n = pk.vertexCount,
    N = view.N,
    basePx = view.basePx;
  const inv = 1 / basePx;
  // per-vertex vertex-stage output
  const P = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = decodeVert(v, i);
    const o = lbVertexSetup(a, basePx, opt);
    P[i] = { a, em: o.emPos, tc: o.tc, emPerPx: o.emPerPx, LB0: o.LB0 };
  }
  const stat = { frags: 0, discards: 0, tris: 0 };
  for (let t = 0; t + 2 < n; t += 3) {
    const A = P[t],
      B = P[t + 1],
      C = P[t + 2];
    const flat = P[t + 2].a; // GL default: LAST vertex provokes
    // screen (pixel) coordinates
    const sx = (p) => (p.em[0] - view.ox) * inv - 0.5;
    const sy = (p) => (p.em[1] - view.oy) * inv - 0.5;
    let ax = sx(A),
      ay = sy(A),
      bx = sx(B),
      by = sy(B),
      cx = sx(C),
      cy = sy(C);
    let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!(Math.abs(area) > 1e-12)) continue;
    let V0 = A,
      V1 = B,
      V2 = C;
    if (area < 0) {
      // orient CCW in pixel space
      const tx = bx,
        ty = by;
      bx = cx;
      by = cy;
      cx = tx;
      cy = ty;
      V1 = C;
      V2 = B;
      area = -area;
    }
    stat.tris++;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.001));
    const i1 = Math.min(N - 1, Math.floor(Math.max(ax, bx, cx) + 0.001));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.001));
    const j1 = Math.min(N - 1, Math.floor(Math.max(ay, by, cy) + 0.001));
    if (i1 < i0 || j1 < j0) continue;
    // affine gradients of the interpolated tc, in screen px
    const invA = 1 / area;
    const g = (f0, f1, f2) => {
      // f(x,y) = f0 + gx*(x-ax) + gy*(y-ay)
      const d1 = f1 - f0,
        d2 = f2 - f0;
      const e1x = bx - ax,
        e1y = by - ay,
        e2x = cx - ax,
        e2y = cy - ay;
      return [(d1 * e2y - d2 * e1y) * invA, (d2 * e1x - d1 * e2x) * invA];
    };
    const gtc = [
      g(V0.tc[0], V1.tc[0], V2.tc[0]),
      g(V0.tc[1], V1.tc[1], V2.tc[1]),
      g(V0.tc[2], V1.tc[2], V2.tc[2]),
    ];
    const dtcx = [gtc[0][0], gtc[1][0], gtc[2][0]];
    const dtcy = [gtc[0][1], gtc[1][1], gtc[2][1]];
    const demx = [basePx, 0],
      demy = [0, basePx];
    const F = {
      kind: flat.kind,
      sign: flat.sign,
      seam: flat.seam,
      emPerPx: P[t + 2].emPerPx,
      LB0: P[t + 2].LB0 || flat.C0,
      LB1: flat.C1,
      LB2: flat.C2,
      LB3: flat.C3,
      tc: [0, 0, 0],
      em: [0, 0],
      dtcx,
      dtcy,
      demx,
      demy,
      emQuad: null,
    };
    const tl01 = topLeft(ax, ay, bx, by),
      tl12 = topLeft(bx, by, cx, cy),
      tl20 = topLeft(cx, cy, ax, ay);
    for (let j = j0; j <= j1; j++) {
      const py = j;
      for (let i = i0; i <= i1; i++) {
        const px = i;
        if (!edgeAccept(ax, ay, bx, by, px, py, tl01)) continue;
        if (!edgeAccept(bx, by, cx, cy, px, py, tl12)) continue;
        if (!edgeAccept(cx, cy, ax, ay, px, py, tl20)) continue;
        const dx = px - ax,
          dy = py - ay;
        F.tc[0] = V0.tc[0] + dtcx[0] * dx + dtcy[0] * dy;
        F.tc[1] = V0.tc[1] + dtcx[1] * dx + dtcy[1] * dy;
        F.tc[2] = V0.tc[2] + dtcx[2] * dx + dtcy[2] * dy;
        F.em[0] = view.emX(i);
        F.em[1] = view.emY(j);
        if (F.kind === LBK.CUBIC_BEZ) {
          const qi = i & ~1,
            qj = j & ~1;
          F.emQuad = [
            [view.emX(qi), view.emY(qj)],
            [view.emX(qi + 1), view.emY(qj)],
            [view.emX(qi), view.emY(qj + 1)],
          ];
          if (!(opt && opt.coarseDeriv)) {
            F.emQuadX = [
              [view.emX(qi), view.emY(j)],
              [view.emX(qi + 1), view.emY(j)],
            ];
            F.emQuadY = [
              [view.emX(i), view.emY(qj)],
              [view.emX(i), view.emY(qj + 1)],
            ];
          }
        }
        F._hit = null;
        F._why = null;
        const cov = lbCoverage(F, opt);
        stat.frags++;
        // Per-fragment hook (opt.onFrag): triangle index within this pack, pixel, coverage (null = discarded) and
        // the branch that answered -- what a fragment-for-fragment comparison against the shader needs.
        if (opt && opt.onFrag)
          opt.onFrag(t / 3, i, j, cov === null ? null : cov, F._hit || F._why, F);
        if (cov === null) {
          stat.discards++;
          continue;
        }
        const c = cov < 0 ? 0 : cov > 1 ? 1 : cov;
        const k = j * N + i;
        acc[k] *= 1 - c;
        const sub =
          F._hit === 'CUBIC_BEZ_ARC'
            ? 24
            : F.kind !== LBK.INTERIOR
              ? F.kind
              : F._hit === 'INTERIOR_CUBIC'
                ? 23
                : F._hit === 'INTERIOR_CONIC'
                  ? 22
                  : F._hit === 'INTERIOR_CHAIN'
                    ? 21
                    : F._hit === 'INTERIOR_LINE'
                      ? 20
                      : 0;
        if (kindAcc) kindAcc[k] |= 1 << F.kind;
        if (domAcc && c > (domCov ? domCov[k] : -1)) {
          domAcc[k] = sub;
          if (domCov) domCov[k] = c;
        }
      }
    }
  }
  return stat;
}

/**
 * WHICH PIXELS A GPU IS ALLOWED TO DISAGREE ON — the knife-edge set.
 *
 * The model rasterizes in exact real arithmetic; a GPU snaps every vertex to a fixed-point
 * SUBPIXEL GRID (1/256 of a pixel on most desktop hardware, 1/16 on some mobile) before it
 * evaluates its edge functions, and runs the kernel's own epsilons in float32 rather than float64.
 * A pixel whose center lies within that grid of a triangle edge, or whose coverage sits on one of
 * the kernel's discard thresholds (0.004, 0.999, the 1e-4 border tests), can therefore land either
 * way — and it lands there by a whole FRAGMENT, not by an ulp.
 *
 * So the honest claim about a model-vs-GPU comparison is not "every pixel agrees to N/255"; it is
 * "every pixel agrees, EXCEPT inside a set the model can name IN ADVANCE". This names it: a pixel
 * is fragile when shifting the whole raster grid by `delta` of a pixel in any of the four axis
 * directions moves its composited coverage by more than 1/255. That is the same ambiguity vertex
 * snapping creates, measured THROUGH the kernel rather than argued about, and it needs no
 * knowledge of which branch is near its edge.
 *
 * `delta` defaults to 1/512 — half of a 1/256 subpixel quantum, the most a snap can move an edge.
 * Returns the mask, its count, and the unperturbed coverage.
 */
export function fragileMask(pks, view, delta, opt) {
  const d = delta == null ? 1 / 512 : delta;
  const N = view.N;
  const base = new Float64Array(N * N).fill(1);
  for (const pk of pks) if (pk) rasterMesh(pk, view, base, opt || {}, null, null, null);
  const mask = new Uint8Array(N * N);
  for (const [sx, sy] of [
    [d, 0],
    [-d, 0],
    [0, d],
    [0, -d],
  ]) {
    const v2 = {
      N: view.N,
      basePx: view.basePx,
      ox: view.ox + sx * view.basePx,
      oy: view.oy + sy * view.basePx,
      emX(i) {
        return this.ox + (i + 0.5) * this.basePx;
      },
      emY(j) {
        return this.oy + (j + 0.5) * this.basePx;
      },
    };
    const acc = new Float64Array(N * N).fill(1);
    for (const pk of pks) if (pk) rasterMesh(pk, v2, acc, opt || {}, null, null, null);
    for (let i = 0; i < mask.length; i++) if (Math.abs(acc[i] - base[i]) * 255 > 1) mask[i] = 1;
  }
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return { mask, n, cov: Float64Array.from(base, (a) => 1 - a) };
}
