// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchIntegrated — CPatch as a real LB kind, ALL curve types, through the full draw path.
//
// Both arms go through r.drawBundle(): same ubershader, same meta rows, same paint, same blend,
// same per-draw binds. LBK_CPATCH (14) lives in the real _lbCoverage.glsl behind
// MANTLE_CPATCH; patches ride the real 24-float LB vertex stream and their curves the real
// curve plane, so no new sampler. The only difference left is the coverage kernel.
//
// ONE PACKED FORM COVERS every CURVE TYPE. Each implicit here is a sum of products of AFFINE
// functionals, so four texels of coefficients plus a kind tag serve all of them and the kernel
// is one dispatch:
//
//   0 LINE  f = A0            2 CUT  same, drawn HARD (a converter seam, shared by two patches:
//   1 QUAD  f = A0^2 - A1            antialiasing both sides composites to 0.75, not 1)
//   5 RQUAD f = A0^2 - A1*A2   arcs and ellipse segments, exact — the rational quadratic
//   3 KLMN  f = A0^3 - A1*A2   4 BEZ  the exact 3x3 Bezout resultant, for the cusps and
//                                     near-degenerate cubics cubicKLMN declines
//
// Coefficients are computed at conversion time, so a quadratic does not invert a
// control-triangle barycentric per fragment. Gradients are ANALYTIC per type — a screen-space
// derivative of a cubic implicit is the AA wobble the CUBIC_BEZ kind exists to avoid.
//
// Rational quadratics also required the CONVERTER's geometry to work in homogeneous
// coordinates: de Casteljau, blossoms and affine composition are all linear, so they are the
// same algorithms one component wider with the projection deferred to the end. Two places
// needed real care — implAlongSeg must multiply terms up to a common factor count (each affine
// factor carries a 1/W, so terms of different degree are divided by different powers and adding
// them directly is the wrong function), and a rational segment's extrema are NOT the roots of
// its projected control polygon's derivative, so the tight bbox falls back to the control-point
// box rather than returning one that is too small.
//
// THE GRID SPLIT is what makes it win everywhere. A CPatch fragment pays N implicit
// evaluations wherever it lands, and in a large patch most fragments are deep interior where
// every constraint holds by a mile. gridSplitPatch (probes/_cpatchCutter.mjs) is Dokter's
// hierarchy without a compute pass: each patch's cover is cut into cells, and every cell
// carries only the curves that can still affect IT.
//
//   some curve is negative over the whole cell   -> outside; the cell is never emitted
//   a curve is positive by more than the AA reach -> it cannot affect this cell; dropped
//   nothing left                                  -> solid interior; the kernel loop never runs
//
// Bounds come from interval arithmetic on the packed form — an affine over a box takes its
// extremes at the corners, and the products compose by interval rules — so a cell is only
// simplified when the bound PROVES it. On cubic n=8 that took 3.80 curves per pixel to 0.80 and
// dropped 22% of the cover area outright.
//
// RESULT (2048^2, ms per drawBundle, ink-gated, all patches converter-validated; G = 8):
//
//   curves | QUADRATIC              | ARC (rquad)            | CUBIC
//        3 | 0.36 / 2.50   6.90x    | 0.58 / 1.93   3.35x    | 0.70 / 0.70   1.00x
//        8 | 0.41 / 1.06   2.58x    | 0.48 / 0.83   1.74x    | 0.51 / 0.64   1.24x
//       16 | 0.41 / 0.86   2.09x    | 0.41 / 0.65   1.58x    | 0.45 / 0.56   1.25x
//
//   without the grid, for comparison:
//        3 | 3.94x                  | 1.88x                  | 0.62x
//        8 | 1.53x                  | 1.25x                  | 0.82x
//       16 | 1.23x                  | 0.79x                  | 0.90x
//
// Cubics gain the most: they pay the most per curve, so removing curves per fragment helps them most.
//
// THE CELLS MUST BE CLIPPED TO THE COVER HULL. A grid over the cover's bounding BOX silently
// swaps the tight hull for a loose box, and a corner cell outside the hull can satisfy every
// constraint by accident (an unclipped grid multiplies cubic N=3's AA error by two orders of
// magnitude). Cells are clipped with Sutherland-Hodgman against the hull's half-planes; without
// it the far-branch leak the hull cover exists to prevent comes back through the grid.
//
// THE COVER POLYGON IS THE CONTROL-POINT HULL, not the minimum-area box:
//   * A box lets a far branch of a cubic's algebraic curve through, which paints a visible
//     wedge of over-fill; inside the control hull a curve has exactly ONE arc — the bound
//     Loop-Blinn's own correctness rests on.
//   * Fewer cuts: cubic N=3 converts to 1 patch, and every family converts with
//     unresolved = 0 and gridCheck clean.
//   * Fewer shaded fragments than the box.
// The validator uses the same bound (patchCoverLines). A validator on a looser bound reports a
// correctly rendered patch as leaking, and the converter keeps cutting to fix a defect that is
// not there.
//
// GATES: ink against the LB arm on the same shape; coverage against an 8x supersampled
// reference (the one that sees a far-branch wedge — the 15% ink gate passes it); a kind
// count (a "cubic" family whose edges quietly degree-reduce to
// quadratics would otherwise report a passing cubic test having never run one); and an
// UNVALIDATED count, because a row holding patches the converter could not prove valid must
// not read as a clean measurement.
//
// SCOPE: one simple contour, patches hand-packed into _lbMeshes. Real integration would have
// lbPack emit the kind. Kind 4 (Bezout) is exercised by the JS-vs-shader agreement test but
// not by this fixture family — these cubics are well-conditioned, so cubicKLMN never declines.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import {
  convertContour,
  patchCoverHull,
  gridSplitPatch,
  validatePatch,
} from '../src/renderer/cpatchConvert.js';
import { segPt, segImplicitPacked, packedEval, CPK_CUT } from '../src/geom/cpatchImplicit.js';
import { cubicInflections, cubicLoopCuts, cubicSlice } from '../src/geom/lbCubicMath.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = 200,
  R = 150,
  AMT = 26;
const LBK_CPATCH = 14,
  LB_STRIDE = 24;
const PLAIN = process.env.PLAIN === '1'; // emit the patch quads as INTERIOR instead
// Diagnostic: push the injected quads off-screen. If the ink does not change, they were
// never contributing and every timing taken from this arm is of some other path.
const SHIFT = +(process.env.SHIFT || 0);

/// An n-gon of genuine CUBIC edges. The two control points are pushed out by DIFFERENT
/// amounts on purpose: a symmetric elevation of the quadratic family has C3 == 0, and
/// cubicDegreeReduce would turn every edge straight back into a quadratic, so the cubic
/// kernel would never be exercised at all.
/// An n-gon of circular ARCS, as rational quadratics. For a chord (a,b) and arc half-angle
/// PHI: radius = |b-a| / 2sin(PHI), the middle control point sits where the end tangents meet,
/// and the weight is cos(PHI) — the exact rational-quadratic form of a circular arc, not an
/// approximation of one.
const ARC_PHI = 0.62;
// The sweep flag decides which side the arc bulges. Guessing it silently renders a DIFFERENT
// shape in the Loop-Blinn arm, which the ink gate catches as a mismatch rather than as a
// kernel bug — hence a switch and a check rather than a comment claiming it is right.
const SWEEP = process.env.SWEEP || '1';
// GRID=n splits each patch's cover into an n x n grid, each cell carrying only the curves that
// can still affect it (probes/_cpatchCutter.mjs gridSplitPatch). Dokter's hierarchy without a
// compute pass: cells proven outside are not emitted at all, and cells proven interior emit a
// quad whose curve count is ZERO, so the kernel's loop never runs there.
const GRID = +(process.env.GRID || 0);
// AA reach in SHAPE units, sized for the LOWEST resolution timed (512): ~0.6 units per device
// pixel there, so 1.2 leaves a pixel of margin. Being conservative only means fewer cells get
// simplified — it can never change the picture.
const GRID_AA = 1.2;
const ngonCurvesArc = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const cx = (a[0] + b[0]) / 2,
      cy = (a[1] + b[1]) / 2;
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let ox = cx - C,
      oy = cy - C;
    const L = Math.hypot(ox, oy) || 1;
    ox /= L;
    oy /= L;
    const r = chord / (2 * Math.sin(ARC_PHI));
    const M = [
      cx + ox * (r / Math.cos(ARC_PHI) - r * Math.cos(ARC_PHI)),
      cy + oy * (r / Math.cos(ARC_PHI) - r * Math.cos(ARC_PHI)),
    ];
    out.push({ t: 'rquad', P: [a, M, b], w: Math.cos(ARC_PHI) });
  }
  return out;
};
const ngonSvgArc = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const f = (v) => v.map((q) => q.toFixed(4)).join(' ');
  let d = 'M ' + f(pt(0)) + ' ';
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = chord / (2 * Math.sin(ARC_PHI));
    d += `A ${r.toFixed(4)} ${r.toFixed(4)} 0 0 ${SWEEP} ${f(b)} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}Z" fill="#000"/></svg>`;
};

const ngonCurvesCubic = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const o = (t, amt) => {
      const x = a[0] + (b[0] - a[0]) * t,
        y = a[1] + (b[1] - a[1]) * t;
      let ox = x - C,
        oy = y - C;
      const L = Math.hypot(ox, oy) || 1;
      return [x + (ox / L) * amt, y + (oy / L) * amt];
    };
    // Same inflection / double-point pre-split Loop-Blinn applies. The implicit needs the
    // control hull to hold ONE arc of its own algebraic curve; that is a shared precondition
    // of both engines, not a CPatch concession.
    const P = [a, o(1 / 3, AMT * 0.7), o(2 / 3, AMT * 1.45), b];
    const ts = cubicInflections(P)
      .concat(cubicLoopCuts(P))
      .sort((u, v) => u - v);
    let prev = 0;
    for (const t of ts) {
      if (t - prev > 1e-4) {
        out.push({ t: 'cubic', P: cubicSlice(P, prev, t) });
        prev = t;
      }
    }
    out.push({ t: 'cubic', P: cubicSlice(P, prev, 1) });
  }
  return out;
};
const ngonSvgCubic = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const f = (v) => v.map((q) => q.toFixed(3)).join(' ');
  let d = 'M ' + f(pt(0)) + ' ';
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const o = (t, amt) => {
      const x = a[0] + (b[0] - a[0]) * t,
        y = a[1] + (b[1] - a[1]) * t;
      let ox = x - C,
        oy = y - C;
      const L = Math.hypot(ox, oy) || 1;
      return [x + (ox / L) * amt, y + (oy / L) * amt];
    };
    d += 'C ' + f(o(1 / 3, AMT * 0.7)) + ' ' + f(o(2 / 3, AMT * 1.45)) + ' ' + f(b) + ' ';
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}Z" fill="#000"/></svg>`;
};

const ngonCurves = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let ox = mx - C,
      oy = my - C;
    const L = Math.hypot(ox, oy) || 1;
    out.push({ t: 'quad', P: [a, [mx + (ox / L) * AMT, my + (oy / L) * AMT], b] });
  }
  return out;
};
const ngonSvg = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  let d =
    'M ' +
    pt(0)
      .map((v) => v.toFixed(3))
      .join(' ') +
    ' ';
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let ox = mx - C,
      oy = my - C;
    const L = Math.hypot(ox, oy) || 1;
    d += `Q ${(mx + (ox / L) * AMT).toFixed(3)} ${(my + (oy / L) * AMT).toFixed(3)} ${b[0].toFixed(3)} ${b[1].toFixed(3)} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}Z" fill="#000"/></svg>`;
};

/// Mirror of the shader's quad implicit, same vertex order and weights, so the orientation
/// sign is derived from the function that will actually evaluate it. A sign taken from a
/// differently-ordered barycentric flips a curve and clips the region silently.
function quadEvJS(p, a, b, c) {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
  const wc = 1 - wa - wb;
  return (wb * 0.5 + wc) * (wb * 0.5 + wc) - wc;
}
const lineEvJS = (p, A, B) => {
  const dx = B[0] - A[0],
    dy = B[1] - A[1],
    L = Math.hypot(dx, dy) || 1;
  return (-dy / L) * (p[0] - A[0]) + (dx / L) * (p[1] - A[1]);
};

/// Convert, then emit (a) the curve texels to append to the curve plane and (b) the LB vertex
/// stream: two triangles per patch over its oriented box, carrying only the (first, count)
/// range in aC3. Vertex layout is lbPack's: [0,1] aPos · [2,3,4] aTC · [5] kind · [6] sign ·
/// [7..10] aC0 · [11..14] aC1 · [15..18] aC2 · [19..22] aC3 · [23] pad.
function buildCPatchMesh(curves, baseTexel) {
  const { patches, stats } = convertContour(curves, { maxCurves: 8, tolPx: 0.05 });
  const texels = [],
    verts = [];
  // Count of the kinds actually packed. Without it a "cubic" run whose edges quietly
  // degree-reduced to quadratics would report a passing cubic test having never run one.
  const kindCensus = {};
  let dropped = 0,
    cellCount = 0;
  for (const p of patches) {
    if (!p.obb) {
      dropped++;
      continue;
    }
    const first = baseTexel + texels.length / 4 / 4; // 4 texels per curve
    // One emission path, driven by a list of (cover polygon, curve subset) pairs. Without a
    // grid that list is a single entry: the whole cover hull with every curve.
    const parts = [];
    // A CURVE-COUNT-ADAPTIVE grid measures WORSE at every size here. The grid's benefit is
    // not only dropping curves from cells, it is dropping whole CELLS proven outside, which
    // tightens the cover and cuts fragments even on a patch with one or two curves. So the
    // grid should not be backed off where curves are few.
    if (GRID > 1) {
      const cells = gridSplitPatch(p, GRID, GRID_AA);
      // c.poly is the cell CLIPPED TO THE COVER HULL, not the raw cell rectangle.
      if (cells) for (const c of cells) parts.push({ poly: c.poly, idx: c.curves });
    }
    if (!parts.length) {
      const HULL = patchCoverHull(p.curves) || p.obb.corners;
      parts.push({ poly: HULL, idx: p.curves.map((_, i) => i) });
    }

    let ok = true;
    for (const part of parts) {
      const first = baseTexel + texels.length / 4 / 4; // 4 texels per curve
      for (const ci of part.idx) {
        const seg = p.curves[ci];
        // ONE path for every curve type. The packed form is four texels of affine coefficients
        // plus a kind tag, so lines, quadratics, rational quadratics, klmn cubics and Bezout
        // cubics differ only in which products the kernel forms — and the orientation sign
        // comes from packedEval, the exact function the shader evaluates.
        const pk = segImplicitPacked(seg);
        if (!pk) {
          ok = false;
          break;
        }
        const kind = seg.cut ? 8 + pk.kind : pk.kind; // hardness is bit 3 over the real kind
        kindCensus[kind] = (kindCensus[kind] | 0) + 1;
        const sg = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
        texels.push(pk.a[0][0], pk.a[0][1], pk.a[0][2], kind);
        texels.push(pk.a[1][0], pk.a[1][1], pk.a[1][2], sg);
        texels.push(pk.a[2][0], pk.a[2][1], pk.a[2][2], pk.c[0]);
        texels.push(pk.a[3][0], pk.a[3][1], pk.a[3][2], pk.c[1]);
      }
      if (!ok) break;
      const c = part.poly,
        order = [];
      for (let k = 1; k + 1 < c.length; k++) order.push(0, k, k + 1);
      cellCount++;
      for (const k of order) {
        const v = new Array(LB_STRIDE).fill(0);
        v[0] = c[k][0] + SHIFT;
        v[1] = c[k][1];
        v[5] = PLAIN ? 0 : LBK_CPATCH;
        v[6] = 1;
        if (!PLAIN) {
          v[19] = first;
          v[20] = part.idx.length;
        } // aC3 -> cCen = (first, count)
        verts.push(...v);
      }
    }
    if (!ok) {
      dropped++;
      continue;
    }
  }
  return {
    texels: new Float32Array(texels),
    verts: new Float32Array(verts),
    vertexCount: verts.length / LB_STRIDE,
    patches: patches.length,
    dropped,
    stats,
    kinds: kindCensus,
    cells: cellCount,
    // Patches the converter could NOT validate. Surfaced because a row carrying these
    // still passes a 15% ink gate while painting a visible wedge of over-fill — which
    // is exactly what the cubic N=3 case did until the AA column caught it.
    unresolved: stats.unresolved | 0,
  };
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const sync=()=>{const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return p[0];};
const TW=4096;
const process_env_dbg=new URL(location.href).searchParams.get('dbg')==='1';
// CPDEFS=MANTLE_CPATCH_HARD (or _RAMP=0.5) adds a define to the CPATCH arm only, which is how
// the coverage kernel gets taken apart: HARD drops the AA ramp entirely, so the AA column then
// reports whether the REGION is right independently of how it is feathered.
const CPDEFS=(new URL(location.href).searchParams.get('cpdefs')||'').split(',').filter(Boolean);
const LAZY=new URL(location.href).searchParams.get('lazy')==='1';
const META=new URL(location.href).searchParams.get('meta')==='1';
const EXTRA=META?['MANTLE_METAPROBE']:[];

const APPEND=new URL(location.href).searchParams.get('app')==='1';

/// Grow the section's curve plane by the patch texels. The plane is a raw RGBA32F ArrayBuffer,
/// 4096 texels wide, and the shader addresses it linearly (x = i & 4095, y = i >> 12), so
/// appending past the existing count needs no repacking — only that the caller was told the
/// same base index that is used here.
function appendCurves(sec, texels){
  // Pad to an EVEN texel count first. A CPatch curve occupies two texels and the shader
  // addresses it as (first + i) * 2, so first is a CURVE index; an odd starting texel could
  // not be expressed as one. Returning the raw texel offset and adding it to a curve index —
  // which is what this did — mixes the two units and points every patch at the wrong data.
  let oldTexels=sec.curves.byteLength/16;
  const pad=(4-(oldTexels%4))%4;
  const total=(oldTexels+pad)*16 + texels.byteLength;
  const buf=new ArrayBuffer(total);
  new Uint8Array(buf).set(new Uint8Array(sec.curves), 0);
  new Float32Array(buf, (oldTexels+pad)*16).set(texels);
  sec.curves=buf;
  return (oldTexels+pad)/4;          // in CURVES, matching the shader's (first + i) * 4
}

async function timeArmWith(svg, mesh, engine, res, extraOpts){
  const r=createRenderer(gl,shaders,extraOpts); r.setLoopBlinnFill('on');
  const sec=await importSvg(svg);
  const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  if(r.awaitLbReady) await r.awaitLbReady(b,20000).catch(()=>{});
  cv.width=res; cv.height=res; r.setViewport(res,res); gl.viewport(0,0,res,res);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]<128) ink++;
  b.dispose();
  return {ms:0, ink, draws:0, gate:'(plumbing-check)', kept:-1, emit:'', cacheInfo:'', px:res===256?px:null};
}
async function mkBundle(svg, mesh, engine){
  // MANTLE_LB_FILL is the route's own documented force: _unifiedFillReady() returns true for
  // 'forced' before it consults variant readiness. Without it the route sits at
  // 'variant-warming' forever, because the variant is requested from the kind mask the bundle
  // had when it was BUILT, and this bundle's kinds were swapped in afterwards.
  // unifiedFillCurveTex:false opts out of the per-curve COEFFICIENT texture. A CPatch vertex
  // carries neither coefficients nor a curve index — its curves are addressed by the (first,
  // count) range in aC3 — so the coef path has nothing to do here, and the forced variant has
  // no uFillCurveCoef for it to bind, which is what 'no-curvetex-uniform' was reporting.
  // The LB arm keeps every default, so nothing is taken away from the engine being compared to.
  // NOT forced. MANTLE_LB_FILL in fillDefines makes _unifiedFillReady return 'forced' BEFORE
  // it consults variant readiness — and the route's own comment says what that costs: a
  // variant still linking "draws with its base, which has no LB attributes at all", so the
  // buffer is read as cover quads and the LB triangles paint garbage. That is what rendered
  // nothing here, and it did it even for plain INTERIOR quads, which is how it was caught.
  // Let the route decline honestly instead and warm the variant it asks for.
  // PLUMBING CHECK: give the LB arm the same debug define. LB renders correctly, so if its
  // output does NOT change to a solid forced-black quad, the define is not reaching the
  // compiled variant at all — and every "forced" experiment on the CPatch arm was inert,
  // which would explain why forcing gl_Position, fCov and fragColor each changed nothing.
  if (engine==='lb' && process_env_dbg)
    return timeArmWith(svg, mesh, engine, res, {fillDefines:['MANTLE_CPATCH_DEBUG']});
  const opts = engine==='cpatch'
    ? {fillDefines:(process_env_dbg?['MANTLE_CPATCH','MANTLE_CPATCH_DEBUG',...EXTRA,...CPDEFS]
                                    :['MANTLE_CPATCH',...EXTRA,...CPDEFS]),
       unifiedFillCurveTex:false,
       // The view-cull trim narrows the single drawArrays to the span between the first and
       // last ON-SCREEN entry, using each entry's meta bbox. An injected entry the meta rows
       // know nothing about can fall outside that span and simply not be drawn — which is
       // consistent with lbCoverage never being reached even when it returns 1.0 for every kind.
       viewCull:false} : (EXTRA.length?{fillDefines:EXTRA}:{});
  const r=createRenderer(gl,shaders,opts);
  r.setLoopBlinnFill('on');
  const sec=await importSvg(svg);
  let verts=mesh.verts;
  if(engine==='cpatch'){
    // The curve texels land AFTER whatever the section already holds, so every vertex's
    // (first) index must be rebased onto that offset. Packing it as 0 in Node and forgetting
    // to add the base here would point every patch at the shape's own curve data — which
    // renders something, plausibly, and wrong.
    const beforeTexels=sec.curves.byteLength/16;
    const base=appendCurves(sec, new Float32Array(mesh.texels));
    verts=new Float32Array(mesh.verts);
    for(let i=0;i<verts.length;i+=${LB_STRIDE}) verts[i+19]+=base;
    if(new URL(location.href).searchParams.get('diag')==='1'){
      const cf=new Float32Array(sec.curves);
      const rows=[]; const seen=new Set();
      for(let i=0;i<verts.length;i+=${LB_STRIDE}){
        const k=verts[i+19]+'/'+verts[i+20]; if(seen.has(k)) continue; seen.add(k);
        const f=verts[i+19]|0, n=verts[i+20]|0, kinds=[];
        for(let c2=0;c2<n;c2++){ const t=(f+c2)*4*4;
          const a0=[cf[t],cf[t+1],cf[t+2]], sg=cf[t+7];
          const at=(x,y)=>(sg*(a0[0]*x+a0[1]*y+a0[2])).toFixed(3);
          kinds.push(cf[t+3]+':'+sg+' a0=('+a0.map(v=>v.toFixed(4)).join(',')+') f@(305,268)='+at(305,268)); }
        rows.push('first='+f+' n='+n+'\\n      '+kinds.join('\\n      '));
      }
      window.__diag={ beforeTexels, base, appended:mesh.texels.length/16, totalTexels:sec.curves.byteLength/16, rows };
    }
  }
  const b=createBundle(gl,sec);
  r.prepareBundle&&r.prepareBundle(b);
  if(r.awaitLbReady) await r.awaitLbReady(b,20000).catch(()=>{});
  if(engine==='cpatch'){
    // Replace the Loop-Blinn mesh with the patch mesh BEFORE the first draw, so no cached
    // vertex stream exists yet to invalidate. The derived caches are dropped rather than
    // recomputed by hand — a stale kind mask compiles the wrong variant and the kind's block
    // vanishes from the program, which reads as an empty render.
    // APPEND mode concatenates the patch quads ONTO the real Loop-Blinn mesh instead of
    // replacing it, and needs no instrumentation to read: if the patch triangles rasterize at
    // all, ink must EXCEED Loop-Blinn's, because the debug branch fills their whole cover box.
    // Replacing the mesh cannot tell "my quads draw nothing" from "my quads are not in the
    // stream" — both give ink 0, which is where this had been stuck.
    if(APPEND && b._lbMeshes && b._lbMeshes[0] && b._lbMeshes[0].verts){
      const orig=b._lbMeshes[0];
      const cat=new Float32Array(orig.verts.length+verts.length);
      cat.set(orig.verts,0); cat.set(verts,orig.verts.length);
      b._lbMeshes=[{verts:cat, vertexCount:orig.vertexCount+mesh.vertexCount, fallback:false,
                    slug:false, kindMask:(orig.kindMask|0)|(1<<${LBK_CPATCH})}];
    } else
    b._lbMeshes=[{verts, vertexCount:mesh.vertexCount, fallback:false, slug:false,
                  kindMask:(1<<${LBK_CPATCH})}];
    b._lbHasSlug=false;
    // PIN THE GENERATION. _ensureLbMeshes rebuilds whenever _lbGen != _geomGen, and a rebuild
    // silently restores the ORIGINAL Loop-Blinn mesh — which is what happened here: 30 verts
    // where 6 were installed, the arm quietly measuring the engine it was supposed to be
    // compared against, with ink identical to LB's because it WAS LB's.
    b._lbGen=b._geomGen|0;
    b._cpatchMesh=b._lbMeshes;
    // _unifiedFill is THE cache that matters: it holds the built entry list and vertex stream,
    // keyed on the geometry generation. Pinning _lbGen to _geomGen (so the mesh stops being
    // rebuilt) also stops this from being invalidated, so the route kept drawing the entry list
    // it made from the ORIGINAL mesh. Five derived caches were being cleared and not this one.
    for(const k of ['_unifiedFill','_lbKindMask','_lbKindMaskGen','_lbCombined',
                    '_lbDepthClaim','_lbDepthClaimGen','_fillBakedOmit'])
      delete b[k];
    // Re-warm. prepareBundle is what asks the fill pass to compile this bundle's variant, and
    // it ran BEFORE the kinds were swapped in — so the program it warmed has no LB coverage
    // for kind 14 and the route declines forever. This is the legitimate version of the
    // MANTLE_LB_FILL force that made the route draw with an LB-less base program.
    r.prepareBundle&&r.prepareBundle(b);
    if(r.awaitLbReady) await r.awaitLbReady(b,20000).catch(()=>{});
    reassert(b);
  }
  return {r,b};
}
/// Drive frames until the unified route stops reporting 'variant-warming'.
///
/// This is not optional bookkeeping. A bundle whose kind mask changed after awaitLbReady has
/// never had its variant requested, so the route declines and the CLASSIC path draws instead —
/// producing a correct picture, byte-identical ink, and a timing that is not the arm under
/// test at all. That is exactly what the first run of this probe measured: gate=variant-warming
/// with the patch mesh sitting installed and unused.
let firstAssert=true;
const reassert=(b)=>{ if(b._cpatchMesh){ b._lbMeshes=b._cpatchMesh; b._lbGen=b._geomGen|0;
  if(firstAssert){ delete b._unifiedFill; firstAssert=false; } } };
async function warmVariant(r,b,res){
  let last='(none)';
  for(let i=0;i<600;i++){
    reassert(b);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
    const g=r.debugStats&&r.debugStats.unifiedFillGate;
    last=g||'(none)';
    // The route re-enqueues the PSO warm each time it finds the mismatch, so the way through
    // is to keep drawing; a bundle whose kinds changed after it was warmed needs that loop.
    if(last!=='variant-warming') return last;
    await new Promise(rs=>setTimeout(rs,8));
  }
  return 'variant-warming(timeout)';
}
async function timeArm(svg, mesh, engine, res){
  const {r,b}=await mkBundle(svg,mesh,engine);
  cv.width=res; cv.height=res; r.setViewport(res,res); gl.viewport(0,0,res,res);
  await warmVariant(r,b,res);
  const K=8, runs=[];
  for(let rep=0;rep<9;rep++){
    reassert(b);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
    const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b);
    r.endFrame(); sync(); runs.push((performance.now()-t0)/K);
  }
  reassert(b);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]<128) ink++;
  const draws=(r.debugStats&&(r.debugStats.unifiedFillDraws|0))||0;
  // The route records WHY it declined; without it every wrong turn on this path looks like
  // a plausible render that some other path produced.
  const gate=(r.debugStats&&r.debugStats.unifiedFillGate)||'(none)';
  const d=r.debugStats||{};
  // Concatenation, not a template literal: this code lives INSIDE the page's backtick
  // template, and a nested backtick ends it — the whole probe dies at parse.
  const emit='lb='+(d.uniEmitLb|0)+' cover='+(d.uniEmitCover|0)+' other='+(d.uniEmitOther|0)+' streamed='+(d.uniEmitLbStreamed|0);
  const kept=b._lbMeshes&&b._lbMeshes[0]?b._lbMeshes[0].vertexCount:-1;
  // The single drawArrays covers cache.vertexCount vertices. Everything upstream can look
  // healthy — gate 'on', draws counted — and still paint nothing if this is 0 or if the
  // stream simply does not contain the injected mesh.
  const uf=b._unifiedFill||{};
  // Read the STREAM ITSELF. Every diagnostic so far has been about whether the draw covers
  // these vertices; none has asked what is in them. Six vertices of zeros rasterize to nothing
  // and look identical, from the outside, to six vertices that were never drawn.
  const V=uf.verts;
  const cname=V?(V.constructor&&V.constructor.name):'none';
  let dump='verts='+cname+' len='+(V&&V.length);
  if(V&&V.length>=48){
    const g=(o)=>Array.from(V.slice(o,o+6)).map(n=>+n.toFixed(1)).join(',');
    dump+=' v0='+g(0)+' v1='+g(uf.vertBytes?uf.vertBytes/4:0);
  }
  const cacheInfo='cacheVerts='+(uf.vertexCount|0)+' keys='+Object.keys(uf).join('/')+' '+dump;
  b.dispose(); runs.sort((a,b)=>a-b);
  return {ms:+runs[4].toFixed(4), ink, draws, gate, kept, emit, cacheInfo, px:res===256?px:null};
}
function down(px,N,S){const n=N/S,out=new Float64Array(n*n);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){let s=0;
    for(let j=0;j<S;j++)for(let i=0;i<S;i++) s+=255-px[(((y*S+j)*N)+(x*S+i))*4];
    out[y*n+x]=s/(S*S)/255;} return out;}
function score(a,ref){let s=0,c=0;
  for(let i=0;i<a.length;i++){if(a[i]>0.004||ref[i]>0.004){s+=Math.abs(a[i]-ref[i]);c++;}}
  return +(255*s/Math.max(c,1)).toFixed(3);}

/// A scalar mean cannot tell OVER-coverage from UNDER-coverage, and for CPatch that is the whole
/// question: two patches sharing a seam that double-paint it read as darker, a seam that leaves a
/// gap reads as lighter, and both land in the same mean. Split by sign, and report the worst
/// pixel and how many are badly off, so "the ramp is miscalibrated" can be told apart from
/// "the patches do not tile".
window.__scoreSplit=(a,ref)=>{
  let over=0,under=0,nOver=0,nUnder=0,worst=0,bad=0,c=0;
  for(let i=0;i<a.length;i++){
    if(!(a[i]>0.004||ref[i]>0.004)) continue;
    c++;
    const d=a[i]-ref[i];
    if(d>0){ over+=d; nOver++; } else if(d<0){ under-=d; nUnder++; }
    const m=Math.abs(d); if(m>worst) worst=m;
    if(m>0.25) bad++;
  }
  return {n:c, map:null, over:+(255*over/Math.max(c,1)).toFixed(3), under:+(255*under/Math.max(c,1)).toFixed(3),
          nOver, nUnder, worst:+(255*worst).toFixed(1), bad};
};

/// Dump the arm's render as ASCII. Every diagnostic so far has been a scalar — ink, a gate
/// string, a ratio — and a scalar cannot tell "nothing drew" from "something drew in the wrong
/// place, at the wrong size, or in the wrong color". This should have come first.
window.__ascii=async(cs,engine,res)=>{
  const a=await timeArm(cs.svg,cs.mesh,engine,res);
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const rows=[];
  for(let y=res-1;y>=0;y--){ let r='';
    for(let x=0;x<res;x++){ const i=(y*res+x)*4, v=px[i];
      r += v<64?'#':v<160?'+':v<250?'.':' '; }
    rows.push(r); }
  return rows;
};
/// Histogram of the red channel. The ASCII glyphs bucket four coverage levels into one
/// character, which is fine for "is anything there" and useless for reading back an index the
/// kernel encoded as a value.
window.__hist=async(cs,engine,res)=>{
  await timeArm(cs.svg,cs.mesh,engine,res);
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const h={}, bbx={};
  for(let i=0;i<px.length;i+=4){ const v=px[i]; h[v]=(h[v]|0)+1;
    const q=(i/4)|0, x=q%res, y=(q/res)|0;
    const b=bbx[v]||(bbx[v]=[1e9,1e9,-1e9,-1e9]);
    if(x<b[0])b[0]=x; if(y<b[1])b[1]=y; if(x>b[2])b[2]=x; if(y>b[3])b[3]=y; }
  return {h, bbx, res};
};
window.__run=async(cases,res)=>{
  const out=[];
  const LO=512;
  for(const cs of cases){
    let cp,lb,err='';
    try { cp=await timeArm(cs.svg,cs.mesh,'cpatch',res); } catch(e){ err='cpatch: '+e.message; cp={ms:0,ink:0,draws:0,gate:'threw',kept:-1}; }
    lb=await timeArm(cs.svg,cs.mesh,'lb',res);
    // SECOND RESOLUTION, so the absolute can be split. The slope (t_hi - t_lo) / (px_hi - px_lo)
    // is per-fragment shading; whatever is left of the absolute is per-draw fixed cost — the
    // ubershader's binds, the frame, the meta prologue's setup. Without this the integrated
    // number is one lump and "where did 0.5 ms become 3 ms" has no answer.
    let cpLo=null, lbLo=null;
    try { cpLo=await timeArm(cs.svg,cs.mesh,'cpatch',LO); } catch(e){}
    lbLo=await timeArm(cs.svg,cs.mesh,'lb',LO);
    const dpx=res*res-LO*LO;
    const nsPx=(lo,hi)=> lo&&hi ? +(((hi.ms-lo.ms)/dpx)*1e6).toFixed(4) : -1;
    const fixedOf=(lo,hi,ns)=> lo&&hi ? +(hi.ms - (ns*1e-6)*res*res).toFixed(3) : -1;
    const cpNs=nsPx(cpLo,cp), lbNs=nsPx(lbLo,lb);
    // quality at 256 against an 8x AAC reference of the same shape
    const Q=256; let eC=-1,eL=-1;
    try{
      const {r:rr,b:bb}=await mkBundle(cs.svg,cs.mesh,'aacref');
      cv.width=Q*8; cv.height=Q*8; rr.setViewport(Q*8,Q*8); gl.viewport(0,0,Q*8,Q*8);
      rr.beginFrame([1,1,1,1]); rr.drawBundle(bb); rr.endFrame(); sync();
      const rp=new Uint8Array(Q*8*Q*8*4); gl.readPixels(0,0,Q*8,Q*8,gl.RGBA,gl.UNSIGNED_BYTE,rp);
      const ref=down(rp,Q*8,8); bb.dispose();
      const a=await timeArm(cs.svg,cs.mesh,'cpatch',Q); const aD=down(a.px,Q,1); eC=score(aD,ref);
      window.__lastSplit=window.__scoreSplit(aD,ref);
      // WHERE, not just how much. A 48x48 map of the under-covered pixels tells a seam (thin
      // lines) from a dropped patch (a solid wedge) at a glance, which no scalar can.
      {
        const G=48, m=new Array(G*G).fill(0), cnt=new Array(G*G).fill(0);
        const W=Q;
        for(let y=0;y<W;y++) for(let x=0;x<W;x++){
          const i=y*W+x; if(!(aD[i]>0.004||ref[i]>0.004)) continue;
          const gi=((y*G/W)|0)*G+((x*G/W)|0);
          const d=ref[i]-aD[i]; if(d>0) m[gi]+=d; cnt[gi]++;
        }
        let out=''; for(let r=G-1;r>=0;r--){ let line='';
          for(let c2=0;c2<G;c2++){ const gi=r*G+c2, v=cnt[gi]?m[gi]/cnt[gi]:0;
            line += v>0.5?'#':v>0.25?'+':v>0.05?'.':cnt[gi]?' ':' '; }
          out+=line+'\\n'; }
        window.__lastSplit.map=out;
      }
      const l=await timeArm(cs.svg,cs.mesh,'lb',Q);     eL=score(down(l.px,Q,1),ref);
    }catch(e){ err=err||('quality: '+e.message); }
    out.push({N:cs.N, patches:cs.patches, cpMs:cp.ms, lbMs:lb.ms, cpInk:cp.ink, lbInk:lb.ink,
              cpDraws:cp.draws, lbDraws:lb.draws, cpGate:cp.gate, cpKept:cp.kept, cpNs, lbNs, cpFixed:fixedOf(cpLo,cp,cpNs), lbFixed:fixedOf(lbLo,lb,lbNs), want:cs.mesh.vertexCount, unres:cs.unres|0, eC, eL, split:window.__lastSplit, err});
  }
  return out;
};
window.__ready=true;
</script></body></html>`;

const NS = (process.env.NS || '3,8,16').split(',').map(Number);
// CUBIC=1 swaps the whole family from quadratic edges to genuine cubic ones, so the same
// measurement covers the klmn and Bezout kernels rather than only u^2 - v.
const CUBIC = process.env.CUBIC === '1';
const ARC = process.env.ARC === '1';
const cases = NS.map((N) => {
  const curves = ARC ? ngonCurvesArc(N) : CUBIC ? ngonCurvesCubic(N) : ngonCurves(N);
  const mesh = buildCPatchMesh(curves, 0); // base fixed up in-page after append
  return {
    N,
    curves,
    mesh,
    svg: ARC ? ngonSvgArc(N) : CUBIC ? ngonSvgCubic(N) : ngonSvg(N),
    patches: mesh.patches,
  };
});
for (const c of cases)
  if (c.mesh.dropped) console.log(`[warn] N=${c.N}: ${c.mesh.dropped} patch(es) dropped`);
console.log(
  'edges: ' +
    (ARC ? 'ARC (rational quadratic)' : CUBIC ? 'CUBIC' : 'quadratic') +
    '  · kinds packed: ' +
    JSON.stringify(cases.map((c) => ({ N: c.N, kinds: c.mesh.kinds }))),
);

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 600000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() !== 'log') console.log('[' + m.type() + ']', m.text());
});
await pg.goto(
  `http://127.0.0.1:${server.address().port}/?dbg=${process.env.DBG || '0'}&app=${process.env.APPEND || '0'}&lazy=${process.env.LAZY || '0'}&meta=${process.env.META || '0'}&cpdefs=${encodeURIComponent(process.env.CPDEFS || '')}&diag=${process.env.DIAG || '0'}`,
  { waitUntil: 'load', timeout: 60000 },
);
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
if (process.env.ASCII) {
  const cs0 = cases.map(({ N, svg, mesh, patches }) => ({
    N,
    svg,
    patches,
    unres: mesh.unresolved,
    mesh: {
      texels: Array.from(mesh.texels),
      verts: Array.from(mesh.verts),
      vertexCount: mesh.vertexCount,
    },
  }))[0];
  for (const eng of ['cpatch', 'lb']) {
    const rows = await pg.evaluate((c, e, r) => window.__ascii(c, e, r), cs0, eng, 56);
    console.log('---- ' + eng + ' ----');
    for (const r of rows) console.log(r);
  }
  if (process.env.HIST === '1') {
    const { h, bbx, res } = await pg.evaluate(
      (c, e, r) => window.__hist(c, e, r),
      cs0,
      'cpatch',
      256,
    );
    console.log('---- red-channel histogram (cpatch) ----');
    for (const [v, n] of Object.entries(h)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)) {
      const b = bbx[v],
        cov = 1 - v / 255;
      console.log(
        `   value ${String(v).padStart(3)}  cov ${cov.toFixed(3)}  n*8+i+1=${Math.round(cov * 64)}  ${String(n).padStart(6)} px  px-bbox [${b.join(',')}] of ${res}`,
      );
    }
  }
  const dg = await pg.evaluate(() => window.__diag || null);
  if (dg) {
    console.log('---- diag ----');
    console.log(
      '  section texels before append ' +
        dg.beforeTexels +
        '  base(blocks) ' +
        dg.base +
        '  appended blocks ' +
        dg.appended +
        '  total texels ' +
        dg.totalTexels,
    );
    for (const r of dg.rows) console.log('  ' + r);
  }
  await br.close();
  server.close();
  process.exit(0);
}
const rows = await pg.evaluate(
  (cs, res) => window.__run(cs, res),
  cases.map(({ N, svg, mesh, patches }) => ({
    N,
    svg,
    patches,
    unres: mesh.unresolved,
    mesh: {
      texels: Array.from(mesh.texels),
      verts: Array.from(mesh.verts),
      vertexCount: mesh.vertexCount,
    },
  })),
  2048,
);

console.log(
  'BOTH arms through r.drawBundle(): same ubershader, same meta/paint/blend, same per-draw cost.',
);
console.log('Absolute ms per drawBundle at 2048^2 — per-draw cost INCLUDED, which is the point.\n');
console.log(
  'curves patches |  ms CPatch      LB   ratio | ns/px: CP     LB | per-draw ms: CP    LB | AA: CP    LB | ink',
);
for (const r of rows) {
  const ok = r.lbInk > 0 && Math.abs(r.cpInk - r.lbInk) / r.lbInk < 0.15;
  console.log(
    `${String(r.N).padStart(6)} ${String(r.patches).padStart(7)} | ` +
      `${String(r.cpMs).padStart(9)} ${String(r.lbMs).padStart(7)} ${(r.lbMs > 0 ? (r.lbMs / r.cpMs).toFixed(2) + 'x' : '--').padStart(7)} | ` +
      `${String(r.cpNs).padStart(10)} ${String(r.lbNs).padStart(6)} | ` +
      `${String(r.cpFixed).padStart(12)} ${String(r.lbFixed).padStart(5)} | ` +
      `${String(r.eC).padStart(5)} ${String(r.eL).padStart(5)} | ` +
      `${ok ? 'OK' : 'BAD'}` +
      (r.err ? '  ERR ' + r.err : ''),
  );
  console.log(
    `         gate=${r.cpGate}  verts=${r.cpKept}/${r.want}` +
      (r.unres
        ? `   *** ${r.unres} UNVALIDATED patch(es) — this row's fill is not trusted ***`
        : ''),
  );
}
for (const r of rows) {
  if (!r.split) continue;
  const q = r.split;
  console.log(
    `         N=${r.N}: OVER ${q.over} (${q.nOver} px) · UNDER ${q.under} (${q.nUnder} px)` +
      `  worst ${q.worst}/255  |  ${q.bad} px off by >64/255  of ${q.n} inked`,
  );
  if (q.map && process.env.MAP === '1') {
    console.log('  UNDER-coverage map (# >50%, + >25%, . >5%):');
    console.log(q.map.replace(/^/gm, '   '));
  }
}
await br.close();
server.close();
