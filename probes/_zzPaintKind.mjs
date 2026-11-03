// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzPaintKind — WHICH PRIMITIVE puts the ink outside the path. Four guesses at the mechanism have
// now been built and scored against measured ground truth and all four missed (a foreign segment
// crossing a crescent hull 24%, overlapping control hulls 5%, an interior face reaching outside 2%,
// extra zero crossings on the hull boundary 96% false). So stop guessing the mechanism and ask the
// emitted mesh directly: sweep the shape's pixels, find the ones the path does not cover at all,
// and report the KIND of every packed triangle that claims them.
//
// The coverage model here is the audit's -- a piece paints where its implicit is negative -- which
// is the GPU's up to the antialiasing ramp, and a pixel fully outside the path is not on a ramp.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const KIND = {
  0: 'INTERIOR',
  2: 'CUBIC',
  4: 'CUBIC_BEZ',
  5: 'ARC',
  7: 'DISC',
  10: 'EDGE_STRIP',
  12: 'CURVE_BAND',
  13: 'CHAIN_STRIP',
};
function spansOf(segs, y, evenOdd) {
  if (!evenOdd) return rowSpans(segs, y) || [];
  const xs = [];
  for (const sg of segs) rowCross(sg, y, (x) => xs.push(x));
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
}
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const EMPP = +(process.env.EMPP || 900 / 512);
const WANT = (process.env.SHAPES || '36,96,152,83,120,153').split(',').map(Number);

const tally = new Map();
let totPx = 0;
const arcD = [],
  arcK = [],
  atEnd = [],
  atEndK = [],
  hullsOver = [],
  outPx = [],
  pastChord = [],
  airFace = [];
let arcRight = 0,
  arcWrong = 0,
  arcNoVerdict = 0;
for (const s of WANT) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  // The audit is what declines these, and its verdict is exactly what is under examination -- so
  // build the mesh it would have rejected and ask what that mesh paints.
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__lbAuditOff = 1;
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (!m) {
    console.log(`s${s}: no mesh even with the audit off`);
    continue;
  }
  let segs = null;
  try {
    const cv = contoursToConverter(cs, null);
    segs = [];
    for (const c of cv) for (const sg of c) segs.push(sg);
  } catch {
    continue;
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of segs)
    for (const P of sg.P) {
      if (P[0] < x0) x0 = P[0];
      if (P[0] > x1) x1 = P[0];
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  // THE MESH RECORDS, not the packed stream: a CUBIC_BEZ vertex carries its implicit in texels the
  // stream does not spell out, and "the triangle covers this pixel" is not "this piece paints it".
  // Records carry F, the sign and the far-branch fence, so the claim can be the real one.
  const prim = [];
  const I = m.interior || [];
  for (let t = 0; t + 5 < I.length; t += 6)
    prim.push({ k: 0, h: [I[t], I[t + 1], I[t + 2], I[t + 3], I[t + 4], I[t + 5]] });
  for (const c of m.cubics || []) prim.push({ k: c.klmn ? 2 : 4, h: c.hull, c });
  for (const q of m.quads || []) prim.push({ k: 5, h: q.tri, q });
  for (const P of prim) {
    const xs = [P.h[0], P.h[2], P.h[4]],
      ys = [P.h[1], P.h[3], P.h[5]];
    P.bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const per = new Map();
  let n = 0;
  for (let y = y0 - EMPP; y <= y1 + EMPP; y += EMPP) {
    const sp = spansOf(segs, y, evenOdd);
    for (let x = x0 - EMPP; x <= x1 + EMPP; x += EMPP) {
      // MARGIN=0 judges every pixel whose CENTER is outside the path, rim included; the default
      // pixel of margin excludes the rim, and the difference between the two answers is the whole
      // question -- a structural wedge shows up in both, a ramp spilling off the edge only in the
      // first.
      const MG = EMPP * +(process.env.MARGIN === undefined ? 1 : process.env.MARGIN);
      let out = true;
      for (const [a, b] of sp)
        if (x > a - MG && x < b + MG) {
          out = false;
          break;
        }
      if (!out) continue;
      const kinds = new Set();
      for (const P of prim) {
        if (x < P.bb[0] || x > P.bb[2] || y < P.bb[1] || y > P.bb[3]) continue;
        const H = P.h;
        const d = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
        if (!(Math.abs(d) > 0)) continue;
        const w1 = ((x - H[0]) * (H[5] - H[1]) - (y - H[1]) * (H[4] - H[0])) / d;
        const w2 = ((H[2] - H[0]) * (y - H[1]) - (H[3] - H[1]) * (x - H[0])) / d;
        const w0 = 1 - w1 - w2;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        if (P.k === 0) {
          kinds.add(0);
          continue;
        }
        if (P.k === 2) {
          const T = P.c.klmn;
          const K = w0 * T[0] + w1 * T[3] + w2 * T[6];
          const L = w0 * T[1] + w1 * T[4] + w2 * T[7];
          const M = w0 * T[2] + w1 * T[5] + w2 * T[8];
          if (P.c.sign * (K * K * K - L * M) < 0) {
            kinds.add(2);
            const cp = P.c.cp;
            if (cp) {
              let dmin = Infinity,
                tmin = 0;
              for (let t = 0; t <= 1.0001; t += 1 / 256) {
                const u = 1 - t;
                const ax =
                  u * u * u * cp[0][0] +
                  3 * u * u * t * cp[1][0] +
                  3 * u * t * t * cp[2][0] +
                  t * t * t * cp[3][0];
                const ay =
                  u * u * u * cp[0][1] +
                  3 * u * u * t * cp[1][1] +
                  3 * u * t * t * cp[2][1] +
                  t * t * t * cp[3][1];
                const d = Math.hypot(x - ax, y - ay);
                if (d < dmin) {
                  dmin = d;
                  tmin = t;
                }
              }
              const chord = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]);
              // WHERE ON THE ARC the closest point is. A pixel just past an arc's END has the
              // ENDPOINT as its nearest point, so it reads as "close to the arc" while sitting
              // beyond the span the piece actually draws -- which is a junction, not a band.
              if (chord > 0) {
                arcK.push(dmin / chord);
                atEndK.push(tmin <= 1 / 256 || tmin >= 1 - 1 / 256 ? 1 : 0);
              }
            }
          }
          continue;
        }
        if (P.k === 4) {
          const kp = P.c.keep;
          if (kp && kp[0] * x + kp[1] * y > kp[2]) continue; // the kernel's far-branch fence
          if (P.c.sign * evalBezout(P.c.F, x, y) < 0) {
            kinds.add(4);
            // HOW FAR FROM THE DRAWN ARC, over the chord. CPatch bounds its kind-4 constraint by a
            // distance to the arc rather than by the implicit alone, and whether that would cut
            // this ink depends entirely on whether the wrong pixels are FAR from the curve the
            // piece actually draws. If they sit on top of it, no distance bound can help.
            const cp = P.c.cp;
            if (cp) {
              let dmin = Infinity,
                tmin = 0;
              for (let t = 0; t <= 1.0001; t += 1 / 256) {
                const u = 1 - t;
                const ax =
                  u * u * u * cp[0][0] +
                  3 * u * u * t * cp[1][0] +
                  3 * u * t * t * cp[2][0] +
                  t * t * t * cp[3][0];
                const ay =
                  u * u * u * cp[0][1] +
                  3 * u * u * t * cp[1][1] +
                  3 * u * t * t * cp[2][1] +
                  t * t * t * cp[3][1];
                const d = Math.hypot(x - ax, y - ay);
                if (d < dmin) {
                  dmin = d;
                  tmin = t;
                }
              }
              const chord = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]);
              // WHERE ON THE ARC the closest point is. A pixel just past an arc's END has the
              // ENDPOINT as its nearest point, so it reads as "close to the arc" while sitting
              // beyond the span the piece actually draws -- which is a junction, not a band.
              if (chord > 0) {
                arcD.push(dmin / chord);
                atEnd.push(tmin <= 1 / 256 || tmin >= 1 - 1 / 256 ? 1 : 0);
              }
            }
          }
          continue;
        }
        kinds.add(P.k);
      }
      // HOW MANY CURVE HULLS CONTAIN this PIXEL. A Loop-Blinn face carries ONE implicit, so a
      // pixel lying inside two curve pieces' hulls is one the model cannot describe: the face is
      // awarded to a single arc and painted by its half-space alone, which on a feature thinner
      // than the hull runs straight across the shape and out the far side.
      if (kinds.size) {
        let nh = 0;
        for (const P of prim) {
          if (P.k !== 2 && P.k !== 4) continue;
          const H = P.h;
          const d = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
          if (!(Math.abs(d) > 0)) continue;
          const w1 = ((x - H[0]) * (H[5] - H[1]) - (y - H[1]) * (H[4] - H[0])) / d;
          const w2 = ((H[2] - H[0]) * (y - H[1]) - (H[3] - H[1]) * (x - H[0])) / d;
          if (w1 >= 0 && w2 >= 0 && 1 - w1 - w2 >= 0) nh++;
        }
        hullsOver.push(nh);
      }
      // IS THE FACE ITSELF ENTIRELY AIR? The builder classifies a CDT face that falls inside a
      // curve hull as that curve's crescent and emits it WITHOUT asking whether the shape has any
      // ink there -- the implicit is trusted to carve. But the implicit knows one curve, and the
      // face's ink is decided by the whole outline. A face with no ink anywhere in it contributes
      // nothing but its implicit's half-space, which is the over-paint.
      if (kinds.size) {
        for (const P of prim) {
          if (P.k !== 2 && P.k !== 4) continue;
          const H = P.h;
          const d0 = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
          if (!(Math.abs(d0) > 0)) continue;
          const w1 = ((x - H[0]) * (H[5] - H[1]) - (y - H[1]) * (H[4] - H[0])) / d0;
          const w2 = ((H[2] - H[0]) * (y - H[1]) - (H[3] - H[1]) * (x - H[0])) / d0;
          if (!(w1 >= 0 && w2 >= 0 && 1 - w1 - w2 >= 0)) continue;
          let anyInk = false;
          for (let a3 = 1; a3 < 6 && !anyInk; a3++)
            for (let b3 = 1; b3 < 6 - a3; b3++) {
              const u0 = a3 / 6,
                u1 = b3 / 6,
                u2 = 1 - u0 - u1;
              const qx = u0 * H[0] + u1 * H[2] + u2 * H[4],
                qy = u0 * H[1] + u1 * H[3] + u2 * H[5];
              for (const [s2, e2] of spansOf(segs, qy, evenOdd))
                if (qx >= s2 && qx <= e2) {
                  anyInk = true;
                  break;
                }
            }
          airFace.push(anyInk ? 0 : 1);
          break;
        }
      }
      // WHICH SIDE OF ITS own CHORD. A crescent is supposed to fill the LENS between its chord and
      // its arc; everything past the chord is the interior polygon's business and the interior
      // knows the whole shape. If the wrong ink is beyond the chord, a chord half-plane on the
      // crescent removes exactly it and can take away nothing the interior does not already cover.
      if (kinds.size) {
        for (const P of prim) {
          if ((P.k !== 2 && P.k !== 4) || !P.c.cp) continue;
          const H = P.h;
          const d0 = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
          if (!(Math.abs(d0) > 0)) continue;
          const w1 = ((x - H[0]) * (H[5] - H[1]) - (y - H[1]) * (H[4] - H[0])) / d0;
          const w2 = ((H[2] - H[0]) * (y - H[1]) - (H[3] - H[1]) * (x - H[0])) / d0;
          if (!(w1 >= 0 && w2 >= 0 && 1 - w1 - w2 >= 0)) continue;
          const cp = P.c.cp;
          const ax = cp[0][0],
            ay = cp[0][1],
            bx = cp[3][0],
            by = cp[3][1];
          let nx = -(by - ay),
            ny = bx - ax;
          const L = Math.hypot(nx, ny);
          if (!(L > 0)) break;
          nx /= L;
          ny /= L;
          // The arc's own midpoint fixes which side of the chord the lens is on.
          const mx = 0.125 * cp[0][0] + 0.375 * cp[1][0] + 0.375 * cp[2][0] + 0.125 * cp[3][0];
          const my = 0.125 * cp[0][1] + 0.375 * cp[1][1] + 0.375 * cp[2][1] + 0.125 * cp[3][1];
          const sArc = nx * (mx - ax) + ny * (my - ay);
          const sPix = nx * (x - ax) + ny * (y - ay);
          pastChord.push(sArc * sPix < 0 ? 1 : 0);
          break;
        }
      }
      // WHAT THE ARC ITSELF WOULD SAY. The implicit is the whole algebraic cubic, so a second
      // branch near the fragment reports an edge where the drawn outline has none. CPatch answers
      // this by measuring the DRAWN ARC instead, wherever the foot point is interior (past an end
      // the boundary has turned onto the next curve and the implicit's extension is what closes
      // the corner). If the arc's own side is right where the implicit's is wrong, the same
      // transfer fixes Loop-Blinn's stray-zero class.
      if (kinds.size) {
        for (const P of prim) {
          if ((P.k !== 2 && P.k !== 4) || !P.c.cp) continue;
          const H = P.h;
          const d0 = (H[2] - H[0]) * (H[5] - H[1]) - (H[3] - H[1]) * (H[4] - H[0]);
          if (!(Math.abs(d0) > 0)) continue;
          const w1 = ((x - H[0]) * (H[5] - H[1]) - (y - H[1]) * (H[4] - H[0])) / d0;
          const w2 = ((H[2] - H[0]) * (y - H[1]) - (H[3] - H[1]) * (x - H[0])) / d0;
          if (!(w1 >= 0 && w2 >= 0 && 1 - w1 - w2 >= 0)) continue;
          const cp = P.c.cp;
          let bt = -1,
            bd = Infinity;
          for (let t = 0; t <= 1.0001; t += 1 / 512) {
            const u = 1 - t;
            const ax =
              u * u * u * cp[0][0] +
              3 * u * u * t * cp[1][0] +
              3 * u * t * t * cp[2][0] +
              t * t * t * cp[3][0];
            const ay =
              u * u * u * cp[0][1] +
              3 * u * u * t * cp[1][1] +
              3 * u * t * t * cp[2][1] +
              t * t * t * cp[3][1];
            const dd = Math.hypot(x - ax, y - ay);
            if (dd < bd) {
              bd = dd;
              bt = t;
            }
          }
          // Interior foot point only, exactly as CPatch gates it.
          if (bt <= 1 / 512 || bt >= 1 - 1 / 512) {
            arcNoVerdict++;
            break;
          }
          const u = 1 - bt;
          const nx0 =
            3 *
            (u * u * (cp[1][0] - cp[0][0]) +
              2 * u * bt * (cp[2][0] - cp[1][0]) +
              bt * bt * (cp[3][0] - cp[2][0]));
          const ny0 =
            3 *
            (u * u * (cp[1][1] - cp[0][1]) +
              2 * u * bt * (cp[2][1] - cp[1][1]) +
              bt * bt * (cp[3][1] - cp[2][1]));
          const nL = Math.hypot(nx0, ny0);
          if (!(nL > 0)) {
            arcNoVerdict++;
            break;
          }
          const fx =
            u * u * u * cp[0][0] +
            3 * u * u * bt * cp[1][0] +
            3 * u * bt * bt * cp[2][0] +
            bt * bt * bt * cp[3][0];
          const fy =
            u * u * u * cp[0][1] +
            3 * u * u * bt * cp[1][1] +
            3 * u * bt * bt * cp[2][1] +
            bt * bt * bt * cp[3][1];
          const sgn = (-ny0 / nL) * (x - fx) + (nx0 / nL) * (y - fy);
          // Which side is ink, read exactly at the foot point.
          const h2 = 1e-7 * (Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]) || 1);
          const inkPos = (() => {
            for (const [a2, b2] of spansOf(segs, fy + (nx0 / nL) * h2, evenOdd)) {
              const xx = fx + (-ny0 / nL) * h2;
              if (xx >= a2 && xx <= b2) return true;
            }
            return false;
          })();
          // The arc says this fragment is ink iff it is on the ink side.
          const arcSaysInk = sgn > 0 === inkPos;
          if (arcSaysInk) arcWrong++;
          else arcRight++;
          break;
        }
      }
      if (!kinds.size) continue;
      // HOW FAR OUTSIDE THE PATH, in pixels. Everything else measured here is relative to a chord,
      // and a chord can be long: the question that decides whether this is a structural region or
      // an antialiased rim is how many PIXELS of clear space separate the pixel from the shape.
      {
        let dOut = Infinity;
        for (let dy = -4; dy <= 4; dy++) {
          const yy = y + dy * EMPP;
          for (const [a2, b2] of spansOf(segs, yy, evenOdd)) {
            const dx = x < a2 ? a2 - x : x > b2 ? x - b2 : 0;
            dOut = Math.min(dOut, Math.hypot(dx, dy * EMPP));
          }
        }
        if (Number.isFinite(dOut)) outPx.push(dOut / EMPP);
      }
      n++;
      totPx++;
      const key = [...kinds]
        .sort((a, b) => a - b)
        .map((k) => KIND[k] || 'k' + k)
        .join('+');
      per.set(key, (per.get(key) || 0) + 1);
      tally.set(key, (tally.get(key) || 0) + 1);
    }
  }
  console.log(
    `s${s}: ${n} px outside the path claimed by  ` +
      [...per]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join('  '),
  );
}
console.log(`\nover ${totPx} px, the claimants are:`);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);

// The same question for the pixels the piece paints CORRECTLY, so the two distributions can be
// compared: a bound only works if they separate.
arcD.sort((a, b) => a - b);
const q = (f) =>
  arcD.length ? arcD[Math.min(arcD.length - 1, Math.floor(f * arcD.length))].toFixed(3) : 'n/a';
console.log(`\ndistance from a WRONGLY painted pixel to the arc its piece draws, over that chord:`);
console.log(
  `  BEZOUT  n=${arcD.length}  p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}  max ${q(1)}`,
);
arcK.sort((a, b) => a - b);
const qk = (f) =>
  arcK.length ? arcK[Math.min(arcK.length - 1, Math.floor(f * arcK.length))].toFixed(3) : 'n/a';
const pct = (a) =>
  a.length ? ((100 * a.reduce((x, y) => x + y, 0)) / a.length).toFixed(0) + '%' : 'n/a';
console.log(
  `  of those BEZOUT pixels, ${pct(atEnd)} are nearest an ARC ENDPOINT (i.e. past where the piece's curve stops)`,
);
console.log(
  `  KLMN    n=${arcK.length}  p10 ${qk(0.1)}  median ${qk(0.5)}  p90 ${qk(0.9)}  max ${qk(1)}`,
);
console.log(`  of those KLMN pixels,   ${pct(atEndK)} are nearest an ARC ENDPOINT`);

const h1 = hullsOver.filter((v) => v <= 1).length,
  h2 = hullsOver.filter((v) => v >= 2).length;
console.log(
  `\ncurve hulls containing a wrongly-painted pixel: one ${h1}, two or more ${h2} (${((100 * h2) / Math.max(1, hullsOver.length)).toFixed(0)}%)`,
);

outPx.sort((a, b) => a - b);
const qo = (f) =>
  outPx.length ? outPx[Math.min(outPx.length - 1, Math.floor(f * outPx.length))].toFixed(2) : 'n/a';
console.log(`how far OUTSIDE THE PATH the wrong pixels are, in pixels at 512:`);
console.log(`  n=${outPx.length}  p10 ${qo(0.1)}  median ${qo(0.5)}  p90 ${qo(0.9)}  max ${qo(1)}`);
console.log(
  `  within 1px of the outline: ${((100 * outPx.filter((v) => v <= 1).length) / Math.max(1, outPx.length)).toFixed(0)}%`,
);

console.log(
  `  of the wrong pixels, ${((100 * pastChord.filter(Boolean).length) / Math.max(1, pastChord.length)).toFixed(0)}% lie BEYOND the piece's own chord (outside the chord-arc lens)`,
);

console.log(
  `  and ${((100 * airFace.filter(Boolean).length) / Math.max(1, airFace.length)).toFixed(0)}% sit in a face with NO INK ANYWHERE IN IT -- a face the builder should never have emitted`,
);

console.log(
  `\nwould the ARC's own side have got these right?  yes ${arcRight}  no ${arcWrong}  no verdict (foot point at an end) ${arcNoVerdict}`,
);
