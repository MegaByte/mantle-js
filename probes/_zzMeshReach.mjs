// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzMeshReach — does a shape's Loop-Blinn mesh reach a point its PATH does not contain?
//
// A cover triangle that extends past the outline is not itself a defect -- the crescents are
// dilated and the kernel is supposed to reject the fragment. It becomes one if the kernel says
// yes. So this reports both: whether the geometry reaches, and whether the path contains it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf32 = new Float32Array(sec.curves);
const cf64 = sec.curves64 ? new Float64Array(sec.curves64) : cf32;
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const EMPERPX = +(process.env.EMPERPX || 900 / 512);
const PTS = (process.env.EM || '586.2,313.8').split(' ').map((q) => q.split(',').map(Number));
const inTri = (P, x, y) => {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  const d1 = d(P[0], P[1], [x, y]),
    d2 = d(P[1], P[2], [x, y]),
    d3 = d(P[2], P[0], [x, y]);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
};
for (const s of (process.env.SHAPES || '12').split(',').map(Number)) {
  const r = sec.curveRangesByShape[s];
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  // THE ROUTE THE RENDERER TAKES, not the CDT in isolation: buildLbShape tries the fast mesh, then
  // the CDT, then the fast mesh again for cubics, and the three produce different cubics. Testing
  // the CDT while the renderer draws the fast mesh is testing the wrong geometry.
  const cts = curveRangeToContours(cf32, r.begin | 0, r.end | 0);
  let mesh = null,
    packed = null,
    route = 'none';
  if (process.env.CDT) {
    try {
      mesh = buildLoopBlinnCDT(cts, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
      route = 'cdt';
    } catch {
      mesh = null;
    }
  } else {
    let o = null;
    try {
      o = buildLbShape(cts, false, evenOdd);
    } catch {
      o = null;
    }
    if (o && o.raw && !o.raw.slug) {
      mesh = o.raw;
      packed = o.pk;
      route = 'buildLbShape';
    }
  }
  const cs = contoursToConverter(curveRangeToContours(cf64, r.begin | 0, r.end | 0), null);
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  for (const [x, y] of PTS) {
    let inPath = false;
    for (const sp of rowSpans(all, y) || [])
      if (x >= sp[0] && x <= sp[1]) {
        inPath = true;
        break;
      }
    if (!mesh) {
      console.log(`s${s} @(${x},${y}): no mesh; inPath=${inPath}`);
      continue;
    }
    let nInt = 0,
      nCub = 0,
      nQuad = 0;
    const cubDetail = [];
    const tri = mesh.interior || [];
    for (let t = 0; t + 5 < tri.length; t += 6)
      if (
        inTri(
          [
            [tri[t], tri[t + 1]],
            [tri[t + 2], tri[t + 3]],
            [tri[t + 4], tri[t + 5]],
          ],
          x,
          y,
        )
      )
        nInt++;
    for (const c of mesh.cubics || []) {
      const H = c.hull;
      for (let k = 0; k + 5 < H.length; k += 6) {
        if (
          !inTri(
            [
              [H[k], H[k + 1]],
              [H[k + 2], H[k + 3]],
              [H[k + 4], H[k + 5]],
            ],
            x,
            y,
          )
        )
          continue;
        nCub++;
        // WHAT THE CRESCENT'S own IMPLICIT SAYS. A hull triangle covering the point is not a
        // defect -- the kernel is supposed to reject the fragment. It becomes one if the implicit
        // agrees with the triangle, and the two answers need different fixes: a sign or a frame
        // that is wrong here is geometry, and a model that says OUT while the GPU paints is the
        // kernel.
        let f = null,
          how = '';
        if (c.klmn) {
          const A = [H[0], H[1]],
            B = [H[2], H[3]],
            C = [H[4], H[5]];
          const den = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
          if (Math.abs(den) > 0) {
            const w1 = ((x - A[0]) * (C[1] - A[1]) - (y - A[1]) * (C[0] - A[0])) / den;
            const w2 = ((B[0] - A[0]) * (y - A[1]) - (B[1] - A[1]) * (x - A[0])) / den;
            const w0 = 1 - w1 - w2;
            const T = c.klmn;
            const kk = w0 * T[0] + w1 * T[3] + w2 * T[6];
            const ll = w0 * T[1] + w1 * T[4] + w2 * T[7];
            const mm = w0 * T[2] + w1 * T[5] + w2 * T[8];
            f = c.sign * (kk * kk * kk - ll * mm);
            how = 'klmn';
          }
        } else if (c.F) {
          f = c.sign * evalBezout(c.F, x, y);
          how = 'bezout';
        }
        // COVERAGE, NOT THE SIGN. The kernel does not test f -- it ramps f/|grad f| over a pixel,
        // so a fragment OUTSIDE the arc still paints if the gradient is small enough that the ramp
        // reaches it. That is the number to look at: how many PIXELS outside this fragment is.
        let dpx = null;
        if (f !== null && c.F) {
          const h = 1e-4 * (Math.abs(x) + Math.abs(y) + 1);
          const gx =
            (c.sign * evalBezout(c.F, x + h, y) - c.sign * evalBezout(c.F, x - h, y)) / (2 * h);
          const gy =
            (c.sign * evalBezout(c.F, x, y + h) - c.sign * evalBezout(c.F, x, y - h)) / (2 * h);
          const gl2 = Math.hypot(gx, gy);
          dpx = gl2 > 0 ? f / (gl2 * EMPERPX) : Infinity;
        }
        // THE same DETERMINANT IN FLOAT32, which is what the GPU has. The model runs in float64,
        // so a disagreement between them is not a different formula -- it is the formula losing
        // its answer to cancellation at the precision the varyings and the ALU actually carry.
        let f32 = null;
        if (c.F) {
          const F2 = c.F,
            fr = Math.fround;
          const nx2 = fr(fr(x - fr(F2.cx)) / fr(F2.s)),
            ny2 = fr(fr(y - fr(F2.cy)) / fr(F2.s));
          const lin = fr(fr(fr(F2.m02.b) * nx2) + fr(fr(F2.m02.c) * ny2));
          const A00 = fr(fr(F2.m00.a) + fr(fr(fr(F2.m00.b) * nx2) + fr(fr(F2.m00.c) * ny2)));
          const A01 = fr(fr(F2.m01.a) + fr(fr(fr(F2.m01.b) * nx2) + fr(fr(F2.m01.c) * ny2)));
          const A02 = fr(fr(F2.m02.a) + lin),
            A11 = fr(fr(F2.m11a) + lin);
          const m12 = fr(F2.m12),
            m22 = fr(F2.m22);
          const det = fr(
            fr(
              fr(A00 * fr(fr(A11 * m22) - fr(m12 * m12))) -
                fr(A01 * fr(fr(A01 * m22) - fr(m12 * A02))),
            ) + fr(A02 * fr(fr(A01 * m12) - fr(A11 * A02))),
          );
          f32 = c.sign * det;
        }
        // THE CROSS-CHORD STRIP, the bound CPatch gives its kind-4 constraint and Loop-Blinn's
        // Bezout crescent has none of: the chord's unit normal, and the arc's exact support either
        // side of the chord's line. The crescent lies between the chord and the arc, so it is
        // inside that band by construction -- a fragment outside it is being claimed by the
        // implicit's OTHER branch and by nothing that was drawn.
        let stripPx = null;
        if (c.cp && c.cp.length === 4) {
          const P0 = c.cp[0],
            P3 = c.cp[3];
          const dx2 = P3[0] - P0[0],
            dy2 = P3[1] - P0[1],
            L3 = Math.hypot(dx2, dy2);
          if (L3 > 0) {
            const nx2 = -dy2 / L3,
              ny2 = dx2 / L3;
            // The functional along the cubic is a Bernstein cubic in the control values; its true
            // extremes need the derivative's roots, which is a quadratic.
            const b0 = nx2 * c.cp[0][0] + ny2 * c.cp[0][1],
              b1 = nx2 * c.cp[1][0] + ny2 * c.cp[1][1];
            const b2 = nx2 * c.cp[2][0] + ny2 * c.cp[2][1],
              b3 = nx2 * c.cp[3][0] + ny2 * c.cp[3][1];
            const at = (t) => {
              const u = 1 - t;
              return u * u * u * b0 + 3 * u * u * t * b1 + 3 * u * t * t * b2 + t * t * t * b3;
            };
            const ts = [0, 1];
            const A2 = 3 * (-b0 + 3 * b1 - 3 * b2 + b3),
              B2 = 6 * (b0 - 2 * b1 + b2),
              C2 = 3 * (b1 - b0);
            if (Math.abs(A2) > 1e-12 * (Math.abs(B2) + Math.abs(C2) + 1e-300)) {
              const D = B2 * B2 - 4 * A2 * C2;
              if (D >= 0) {
                const sq = Math.sqrt(D);
                for (const t of [(-B2 + sq) / (2 * A2), (-B2 - sq) / (2 * A2)])
                  if (t > 0 && t < 1) ts.push(t);
              }
            } else if (Math.abs(B2) > 0) {
              const t = -C2 / B2;
              if (t > 0 && t < 1) ts.push(t);
            }
            let lo3 = Infinity,
              hi3 = -Infinity;
            for (const t of ts) {
              const v = at(t);
              if (v < lo3) lo3 = v;
              if (v > hi3) hi3 = v;
            }
            const v3 = nx2 * x + ny2 * y;
            stripPx = Math.max(lo3 - v3, v3 - hi3) / EMPERPX;
          }
        }
        cubDetail.push(
          `${how} sign=${c.sign} f=${f === null ? 'n/a' : f.toExponential(3)}` +
            (stripPx === null
              ? ''
              : `  STRIP: ${stripPx > 0 ? stripPx.toFixed(2) + 'px OUTSIDE -> would reject' : (-stripPx).toFixed(2) + 'px inside -> passes'}`) +
            (f32 === null
              ? ''
              : ` f32=${f32.toExponential(3)}${f32 >= 0 !== f >= 0 ? '  <-- SIGN FLIPS IN FLOAT32' : ''}`) +
            (dpx === null ? '' : `  |grad|-> ${dpx.toFixed(2)} px inside`) +
            ` -> ${dpx !== null && dpx > -0.5 ? 'PAINTS (ramp reaches)' : 'rejects'}`,
        );
      }
    }
    for (const q of mesh.quads || []) {
      const T = q.tri;
      if (
        T &&
        inTri(
          [
            [T[0], T[1]],
            [T[2], T[3]],
            [T[4], T[5]],
          ],
          x,
          y,
        )
      )
        nQuad++;
    }
    // THE PACKED STREAM, which is what the GPU rasterizes: bands, strips and chains exist only
    // there, they are DILATED outward by design, and a raw-mesh test cannot see them at all.
    if (packed) {
      const V = packed.verts,
        ST2 = packed.stride || 24,
        hits = new Map();
      for (let t = 0; t + 3 * ST2 <= V.length; t += 3 * ST2) {
        for (const dil of [0, 1.5, 3.0]) {
          const P2 = [0, 1, 2].map((u) => {
            const o = t + u * ST2;
            return [V[o] + V[o + 2] * dil * EMPERPX, V[o + 1] + V[o + 3] * dil * EMPERPX];
          });
          if (!inTri(P2, x, y)) continue;
          const kd = Math.round(V[t + 5]);
          hits.set(kd, (hits.get(kd) || 0) + 1);
          break;
        }
      }
      if (hits.size)
        console.log(
          `     packed stream reaches: ` + [...hits].map(([k, v]) => `kind ${k} x${v}`).join('  '),
        );
    }
    console.log(
      `s${s} @(${x},${y}) [${route}]: inPath=${inPath}  mesh reaches: ${nInt} interior, ${nCub} cubic hulls, ${nQuad} quads` +
        (cubDetail.length ? '\n     ' + cubDetail.join('\n     ') : ''),
    );
  }
}
