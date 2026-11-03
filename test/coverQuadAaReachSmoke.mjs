// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverQuadAaReachSmoke — the cover quad's AA margin: what it already has, and the one case that is
// short of it.
//
// The fill's cover quad is "the path-tight AABB/OBB expanded by padEm, and padEm is the STROKE
// half-width — zero for a fill-only shape", which suggests "every shape loses the outer half of
// its AA ramp wherever its outline touches its own bounding box". That is true of the quad the
// IMPORTER writes and false of the quad that is RASTERIZED: `coverQuadDilate` in
// mantle.vert.glsl (Lengyel's dynamic dilation) already pushes every cover-quad EDGE out by half a
// device pixel in the vertex stage.
//
// AND HALF A PIXEL IS THE exact REACH, on an axis-aligned edge. A pixel has coverage iff its 1x1
// box meets the shape, so its center lies within half a pixel of the shape ALONG each SCREEN AXIS.
// As measured below: outside the raw quad, an S glyph loses 3.44% of its ink at 16 px and a slab
// 8.88%; outside the DILATED quad, both are 0.00% and the S glyph keeps 0.07%.
//
// WHAT IS LEFT IS THE ROTATED QUAD. Half a pixel along each screen axis is up to 0.7071 px along an
// edge normal at 45 degrees, and the PCA-fitted OBB is the quad that is not axis-aligned. The answer
// is not "the AA reach" as a constant — it is the unit box's SUPPORT in the edge's own direction,
// which is ½(|cos θ| + |sin θ|): exactly the shipped half pixel when θ = 0, and 0.7071 at 45
// degrees. `setCoverAaReach(true)` (uniform uCoverAaReach, not a define, so a fill-rate A/B runs
// one program) turns that on.
//
//   (a) the shipped vertex text pushes each cover-quad edge exactly 0.5 device px;
//   (b) on six fixtures at 16, 64 and 256 px the dilation removes at least 98% of the ink that
//       falls outside the raw quad, and all of it on every axis-aligned one;
//   (c) with uCoverAaReach on, the remaining ink outside the quad is zero, and an AXIS-ALIGNED
//       quad's dilation does not move at all — so the fill-rate cost on the common case is none;
//   (d) the factor and its gate are in the shipped shader text.
//
// THE TWIN. `coverQuadDilate` is a VERTEX function and test/_glslEmu.mjs compiles fragment kernels,
// so the dilation here is a JS twin of it, pinned to the shader by (d) and by (a)'s measured half
// pixel. The GEOMETRY is not a twin: the quads and their bisector normals are read out of
// importSvg's own `curveGeom` section, and the coverage reference is the path.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { rowSpans } = await import('../src/renderer/cpatchConvert.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- (d) the shipped text -------------------------------------------------------------------------
const VERT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
ok(
  /uniform int uCoverAaReach;/.test(VERT),
  '(d) uCoverAaReach is a uniform in the shipped vertex shader (not a define)',
);
// THE TWIN FOLLOWS THE TEXT. Without this the "reach on" arm below could measure a rule the shader
// does not have, and every number in (c) would stay green with the factor deleted.
const HAS_REACH =
  VERT.includes('if (uCoverAaReach == 1) {') &&
  VERT.includes('d *= 1.41421356 * max(abs(u), abs(v)) / len;');
ok(HAS_REACH, '(d) ...and it gates the box-support factor sqrt(2) * max(|bx|, |by|)');
ok(
  VERT.includes('float d = s2 * (st + sqrt(uv)) / denom;'),
  '(d) the Lengyel dilation itself is unchanged',
);

// ---- the twin of coverQuadDilate -------------------------------------------------------------------
function coverQuadDilate(emPos, normal, m0, m1, m3, vp, reach) {
  if (normal[0] * normal[0] + normal[1] * normal[1] < 1e-12) return [0, 0];
  const L = Math.hypot(normal[0], normal[1]),
    nH = [normal[0] / L, normal[1] / L];
  const s = m3[0] * emPos[0] + m3[1] * emPos[1] + m3[3];
  const t = m3[0] * nH[0] + m3[1] * nH[1];
  const u =
    (s * (m0[0] * nH[0] + m0[1] * nH[1]) - t * (m0[0] * emPos[0] + m0[1] * emPos[1] + m0[3])) *
    vp[0];
  const v =
    (s * (m1[0] * nH[0] + m1[1] * nH[1]) - t * (m1[0] * emPos[0] + m1[1] * emPos[1] + m1[3])) *
    vp[1];
  const s2 = s * s,
    st = s * t,
    uv = u * u + v * v,
    den = uv - st * st;
  if (Math.abs(den) < 1e-12) return [0, 0];
  let d = (s2 * (st + Math.sqrt(uv))) / den;
  if (reach && HAS_REACH) {
    const len = Math.sqrt(uv);
    if (len > 0) d *= (1.41421356 * Math.max(Math.abs(u), Math.abs(v))) / len;
  }
  return [normal[0] * d, normal[1] * d];
}
const arScale = (bb, vw, vh) => {
  const cAR = vw / vh,
    sAR = bb[2] / bb[3];
  return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
};
const inPoly = (poly, x, y) => {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      c = poly[(i + 1) % poly.length];
    if (a[1] <= y) {
      if (c[1] > y && (c[0] - a[0]) * (y - a[1]) - (x - a[0]) * (c[1] - a[1]) > 0) w++;
    } else if (c[1] <= y && (c[0] - a[0]) * (y - a[1]) - (x - a[0]) * (c[1] - a[1]) < 0) w--;
  }
  return w !== 0;
};

/// Ink whose pixel center falls outside the cover quad — raw, dilated, and dilated with the reach.
// THE BOX QUAD (coverFan: false, the test hook): this smoke is about the box's dilation, which every stroke row and
// every shape its hull does not beat still takes. A fill row's default cover is its convex hull, whose
// miter normals push each edge the full 0.7071 px (coverFanSmoke, probes/fillperf/coverFanProof.mjs).
async function measure(svg, N) {
  const b = await importSvg(svg, { preserveViewport: true, coverFan: false });
  const bb = b.globalBBox;
  const [ax, ay] = arScale(bb, N, N);
  const m0 = [(ax * 2) / bb[2], 0, 0, -ax - (2 * bb[0] * ax) / bb[2]];
  const m1 = [0, (-ay * 2) / bb[3], 0, ay + (2 * bb[1] * ay) / bb[3]];
  const m3 = [0, 0, 0, 1],
    vp = [N, N];
  const toPxX = (x) => (((x - bb[0]) / bb[2]) * 2 - 1) * ax * 0.5 * N + N * 0.5;
  const toPxY = (y) => (((y - bb[1]) / bb[3]) * 2 - 1) * ay * 0.5 * N + N * 0.5;
  const geo = new Float32Array(b.curveGeom);
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats;
  const curve = new Float32Array(b.curves);
  // curveGeom: per shape a 12-float header (nv, gid, rgba, ...) then nv * 12-float verts.
  const quads = [];
  for (let o = 0; o + 12 <= geo.length;) {
    const nv = geo[o] | 0;
    o += 12;
    const vs = [];
    for (let k = 0; k < nv; k++, o += 12)
      vs.push({ p: [geo[o], geo[o + 1]], n: [geo[o + 2], geo[o + 3]] });
    quads.push(vs);
  }
  const r = {
    ink: 0,
    raw: 0,
    dil: 0,
    reach: 0,
    axisAligned: true,
    push: 0,
    pushReach: 0,
    areaDil: 0,
    areaReach: 0,
  };
  let q = 0;
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (!(F[o + M.META_FILL_A] > 0)) continue;
    const rg = b.curveRangesByShape[s];
    const vs = quads[q++];
    if (!rg || !vs) continue;
    const cs = contoursToConverter(curveRangeToContours(curve, rg.begin, rg.end), null);
    const segs = cs ? cs.flat() : null;
    if (!segs) continue;
    const eo = (F[o + M.META_FILL_RULE] | 0) === 1;
    const corners = [vs[0], vs[1], vs[2], vs[5]];
    const px = (p) => [toPxX(p[0]), toPxY(p[1])];
    const rawPx = corners.map((c) => px(c.p));
    const dilPx = corners.map((c) => {
      const d = coverQuadDilate(c.p, c.n, m0, m1, m3, vp, false);
      return px([c.p[0] + d[0], c.p[1] + d[1]]);
    });
    const rchPx = corners.map((c) => {
      const d = coverQuadDilate(c.p, c.n, m0, m1, m3, vp, true);
      return px([c.p[0] + d[0], c.p[1] + d[1]]);
    });
    // is this quad axis aligned in screen space, and how far did edge 0 move?
    const e = [rawPx[1][0] - rawPx[0][0], rawPx[1][1] - rawPx[0][1]];
    const aa = Math.abs(e[0]) < 1e-4 || Math.abs(e[1]) < 1e-4;
    if (!aa) r.axisAligned = false;
    const edgePush = (P) => {
      // distance edge (0,1) moved outward, in px
      const eL = Math.hypot(e[0], e[1]);
      if (eL <= 0) return 0;
      const n = [e[1] / eL, -e[0] / eL];
      const dot0 = (P[0][0] - rawPx[0][0]) * n[0] + (P[0][1] - rawPx[0][1]) * n[1];
      return Math.abs(dot0);
    };
    r.push = Math.max(r.push, edgePush(dilPx));
    r.pushReach = Math.max(r.pushReach, edgePush(rchPx));
    // FILL RATE: the rasterized area of each quad, in device px2. The reach's cost is the ring
    // between them, and on an axis-aligned quad the two are the same polygon.
    const area = (P) => {
      let a = 0;
      for (let i = 0; i < P.length; i++) {
        const q1 = P[i],
          q2 = P[(i + 1) % P.length];
        a += q1[0] * q2[1] - q2[0] * q1[1];
      }
      return Math.abs(a) / 2;
    };
    r.areaDil += area(dilPx);
    r.areaReach += area(rchPx);
    const SL = 16;
    const xs = rchPx.map((p) => p[0]),
      ys = rchPx.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs)) - 3,
      x1 = Math.ceil(Math.max(...xs)) + 3;
    const y0 = Math.floor(Math.min(...ys)) - 3,
      y1 = Math.ceil(Math.max(...ys)) + 3;
    for (let j = y0; j <= y1; j++) {
      const acc = new Float64Array(x1 - x0 + 1);
      for (let t = 0; t < SL; t++) {
        const yPx = j + (t + 0.5) / SL;
        const yEm = bb[1] + (((yPx / N) * 2 - 1) / ay + 1) * 0.5 * bb[3];
        const spans = rowSpans(segs, yEm, eo);
        for (let i = x0; i <= x1; i++) {
          let a = 0;
          for (const sp of spans) {
            const sl = Math.max(toPxX(sp[0]), i),
              sh = Math.min(toPxX(sp[1]), i + 1);
            if (sh > sl) a += sh - sl;
          }
          acc[i - x0] += a;
        }
      }
      for (let i = x0; i <= x1; i++) {
        const cov = acc[i - x0] / SL;
        if (cov <= 0) continue;
        r.ink += cov;
        const cx = i + 0.5,
          cy = j + 0.5;
        if (!inPoly(rawPx, cx, cy)) r.raw += cov;
        if (!inPoly(dilPx, cx, cy)) r.dil += cov;
        if (!inPoly(rchPx, cx, cy)) r.reach += cov;
      }
    }
  }
  return r;
}

const wrap = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="${d}" fill="#000"/></svg>`;
const FIX = {
  ess: wrap(
    'M 46 16 C 46 6 18 6 18 18 C 18 30 46 30 46 44 C 46 58 16 58 16 46 L 22 46 C 22 52 40 52 40 44 C 40 34 12 34 12 18 C 12 2 52 2 52 16 Z',
  ),
  slab: wrap('M 10 10 L 54 10 L 54 54 L 10 54 Z'),
  diamond: wrap('M 32 8 L 56 32 L 32 56 L 8 32 Z'),
  disc: wrap('M 32 8 A 24 24 0 1 1 31.99 8 Z'),
  bowl: wrap('M 8 32 A 24 24 0 0 0 56 32 L 48 32 A 16 16 0 0 1 16 32 Z'),
  tilt: wrap('M 20 8 L 56 26 L 44 56 L 8 38 Z'),
};
const R = {};
for (const N of [16, 64, 256])
  for (const [k, v] of Object.entries(FIX)) R[`${k}@${N}`] = await measure(v, N);

// ---- (a) the shipped push is half a device pixel ------------------------------------------------------
{
  const s = R['slab@64'];
  ok(
    s.axisAligned && Math.abs(s.push - 0.5) < 1e-3,
    `(a) an axis-aligned cover quad's edge is pushed ${s.push.toFixed(4)} device px by the SHIPPED dilation — so a fill-only cover quad is not undilated`,
  );
  ok(
    Math.abs(s.pushReach - 0.5) < 1e-3,
    `(a) ...and uCoverAaReach leaves it at ${s.pushReach.toFixed(4)} px, because the unit box's support along an axis IS a half pixel — the reach costs this quad no extra fragment at all`,
  );
}

// ---- (b) what the dilation is worth -------------------------------------------------------------------
{
  const worstRaw = Math.max(...Object.values(R).map((r) => r.raw / r.ink));
  const worstDil = Math.max(...Object.values(R).map((r) => r.dil / r.ink));
  ok(
    worstRaw > 0.02,
    `(b) ink whose centre falls outside the RAW quad: worst ${(100 * worstRaw).toFixed(3)}% ` +
      `(ess@16 ${((100 * R['ess@16'].raw) / R['ess@16'].ink).toFixed(3)}%, slab@16 ${((100 * R['slab@16'].raw) / R['slab@16'].ink).toFixed(3)}%)`,
  );
  ok(
    worstDil < worstRaw / 40,
    `(b) ...and outside the DILATED quad, which is what is rasterized: worst ${(100 * worstDil).toFixed(4)}% — the vertex stage already removes over 97% of it`,
  );
  for (const k of [
    'slab@16',
    'diamond@16',
    'disc@16',
    'bowl@16',
    'tilt@16',
    'slab@64',
    'tilt@64',
  ]) {
    if (R[k].dil !== 0) {
      ok(false, `(b) ${k} still loses ${R[k].dil.toFixed(4)} px2 outside the dilated quad`);
      break;
    }
  }
  ok(
    ['slab@16', 'diamond@16', 'disc@16', 'bowl@16', 'tilt@16', 'slab@64', 'tilt@64'].every(
      (k) => R[k].dil === 0,
    ),
    '(b) ...and it is exactly zero on the slab, diamond, disc, bowl and tilted quad',
  );
}

// ---- (c) the residue, and what the reach costs ---------------------------------------------------------
{
  const resid = Object.entries(R).filter(([, r]) => r.dil > 0);
  ok(
    resid.length > 0,
    `(c) the residue is the ROTATED quad: ${resid.map(([k, r]) => `${k} ${((100 * r.dil) / r.ink).toFixed(4)}%`).join(', ')}`,
  );
  const left = Object.entries(R).filter(([, r]) => r.reach > 0);
  ok(
    left.length === 0,
    `(c) with uCoverAaReach on, ink outside the quad is zero on all ${Object.keys(R).length} cells` +
      (left.length ? `: ${left.map(([k]) => k).join(' ')}` : ''),
  );
  // The fill-rate cost, in fragments, is the extra ring: (perimeter + 4*push) * extra push.
  ok(
    Object.values(R).every((r) => r.pushReach >= r.push - 1e-6 && r.pushReach <= r.push * 1.41422),
    '(c) the push never shrinks and never exceeds sqrt(2)x: ' +
      Object.entries(R)
        .map(([k, r]) => `${k} ${(r.pushReach / r.push).toFixed(4)}x`)
        .join(', '),
  );
  // THE FILL-RATE NUMBER. Extra rasterized area, in device px2 and as a fraction of the quad.
  const rate = Object.entries(R).map(
    ([k, r]) =>
      `${k} +${(r.areaReach - r.areaDil).toFixed(1)} px2 (${(100 * (r.areaReach / r.areaDil - 1)).toFixed(2)}%)`,
  );
  const aaWorst = Math.max(
    ...Object.entries(R)
      .filter(([k]) => /slab|diamond|disc|bowl/.test(k))
      .map(([, r]) => r.areaReach / r.areaDil - 1),
  );
  ok(
    Math.abs(aaWorst) < 1e-6,
    `(c) FILL RATE — extra rasterized area: ${(aaWorst * 100).toExponential(1)}% on every axis-aligned quad (the factor is 1 there, to float), and ` +
      rate.filter((x) => /ess|tilt/.test(x)).join(', '),
  );
}

console.log(fail ? `coverQuadAaReachSmoke FAIL (${fail})` : 'coverQuadAaReachSmoke PASS');
process.exit(fail ? 1 : 0);
