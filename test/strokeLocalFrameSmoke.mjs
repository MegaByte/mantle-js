// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeLocalFrameSmoke — a stroke under a non-uniform scale, a skew, or a rotation with a non-uniform scale is the
// image, under the element's CTM, of the stroke of its LOCAL path.
//
// THE HAZARD. Baking the segments into document space and multiplying stroke-width -- and the dash lengths and
// offset -- by the MEAN of the CTM's column lengths is wrong: under scale(2 1.5) a 6-wide stroke would draw half-width
// 5.25 on both axes where SVG draws 6 across a vertical edge and 4.5 across a horizontal one; a round cap is an
// ellipse there, and a join's angle is not the local one. No single width reproduces the outline.
//
// Such a row is drawn in STROKE SPACE (src/bundle/strokeFrame.js): the walk maps each document-space segment,
// relative to the fragment, through N = sMax * M^-1 and measures the local stroke there, scaled uniformly by sMax;
// the hit test does the same.
//
// The kernel side is the SHIPPED shader text in float32 (test/_glslEmu.mjs): the walk a row's flags select --
// strokeMinDistLocal for a framed row, strokeMinDist for any other -- read as
// membership (distance <= half-width, the coverage's 0.5 level). The reference is exact and independent: the query
// point mapped back into the element's local space and tested against SVG 2's stroke shape of the local path
// (test/_strokeShapeRef.mjs svgInside for polylines, test/_strokeCubicArcRef.mjs svgInsideGeneric for an arc and a
// cubic, the annulus for a circle, the dash pattern along a polyline's length). Points within 1% of a half-width of
// the outline are skipped, so what is counted is the outline's place, not float32 noise.
//
// (a) four carriers -- scale(2 1.5), skewX(30), rotate(30) scale(3 1) and scale(-2 1.5) skewY(10) -- times seven
//     strokes (miter / round / bevel polylines with butt, round and square caps, a closed triangle, an elliptical arc,
//     a cubic, a circle), at 2^-20, 1 and 2^20: the renderer's walk and the hit test agree with the local SVG 2 shape
//     at every point;
// (b) a dashed polyline (dasharray 10 5, offset 3, local units): points on the body inside dashes and inside gaps;
// (c) the rows: framed (flag, texel 5 = N, width sMax * w, the circle off the annulus fast path), and a conformal
//     carrier -- rotate(30) scale(2), and scale(-2 2) -- is not.
import { strict as assert } from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { svgInside } from './_strokeShapeRef.mjs';
import { svgInsideGeneric, arcSegs, cubicSegs } from './_strokeCubicArcRef.mjs';
import { arcEndpointToCenter } from '../src/svg/segment.js';
import { fillHitShape, HitMode } from '../src/hitTest/index.js';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SCALES = [2 ** -20, 1, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const D2R = Math.PI / 180;
const FS_STROKE_LOCAL = 4,
  META = {
    STROKE_W: 12,
    FILL_A: 7,
    GLX: 16,
    GLY: 17,
    BMX: 18,
    BMY: 19,
    T5: 20,
    CAP: 24,
    JOIN: 25,
    MITER: 26,
    FLAGS: 27,
    DASH: 15,
    ENDCAP: 46,
    PRIM: 44,
  };

// ---- carriers: the SVG transform and its linear part [a, b, c, d] ----------------------------------------------------
const mat = (a, b, c, d) => [a, b, c, d];
const mmul = (P, Q) => [
  P[0] * Q[0] + P[2] * Q[1],
  P[1] * Q[0] + P[3] * Q[1],
  P[0] * Q[2] + P[2] * Q[3],
  P[1] * Q[2] + P[3] * Q[3],
];
const rotM = (deg) =>
  mat(Math.cos(deg * D2R), Math.sin(deg * D2R), -Math.sin(deg * D2R), Math.cos(deg * D2R));
const CARRIERS = [
  { name: 'scale(2 1.5)', t: 'scale(2 1.5)', M: mat(2, 0, 0, 1.5) },
  { name: 'skewX(30)', t: 'skewX(30)', M: mat(1, 0, Math.tan(30 * D2R), 1) },
  { name: 'rotate(30) scale(3 1)', t: 'rotate(30) scale(3 1)', M: mmul(rotM(30), mat(3, 0, 0, 1)) },
  {
    name: 'scale(-2 1.5) skewY(10)',
    t: 'scale(-2 1.5) skewY(10)',
    M: mmul(mat(-2, 0, 0, 1.5), mat(1, Math.tan(10 * D2R), 0, 1)),
  },
];
const CONFORMAL = [
  { name: 'rotate(30) scale(2)', t: 'rotate(30) scale(2)' },
  { name: 'scale(-2 2)', t: 'scale(-2 2)' },
];

// ---- strokes, each with an exact local membership test at half-width h ---------------------------------------------
const ARC = arcEndpointToCenter([0, 0], 20, 12, 30, 0, 1, [30, 20]);
const ARC_SEGS = arcSegs(
  [
    {
      cx: ARC.cx,
      cy: ARC.cy,
      rx: ARC.rx,
      ry: ARC.ry,
      phi: ARC.phi,
      th0: ARC.theta1,
      th1: ARC.theta1 + ARC.dtheta,
    },
  ],
  false,
);
const CUB_SEGS = cubicSegs(
  [
    [
      [0, 0],
      [10, -20],
      [30, 20],
      [40, 0],
    ],
  ],
  false,
);
const POLY = [
  [0, 0],
  [40, 0],
  [40, 30],
  [10, 40],
];
const STROKES = [
  {
    name: 'polyline, miter joins, butt caps',
    el: '<path d="M0 0 L40 0 L40 30 L10 40"/>',
    attrs: 'stroke-linejoin="miter" stroke-linecap="butt"',
    w: 6,
    inside: (p, h) => svgInside(p, POLY, false, h, 0, 0, 4),
    box: [-6, -6, 46, 46],
  },
  {
    name: 'polyline, round joins, round caps',
    el: '<path d="M0 0 L40 0 L40 30 L10 40"/>',
    attrs: 'stroke-linejoin="round" stroke-linecap="round"',
    w: 6,
    inside: (p, h) => svgInside(p, POLY, false, h, 1, 1, 4),
    box: [-6, -6, 46, 46],
  },
  {
    name: 'polyline, bevel joins, square caps',
    el: '<path d="M0 0 L40 0 L40 30 L10 40"/>',
    attrs: 'stroke-linejoin="bevel" stroke-linecap="square"',
    w: 6,
    inside: (p, h) => svgInside(p, POLY, false, h, 2, 2, 4),
    box: [-8, -8, 48, 48],
  },
  {
    name: 'closed triangle, miter joins',
    el: '<path d="M0 0 L40 0 L20 30 Z"/>',
    attrs: 'stroke-linejoin="miter" stroke-miterlimit="4"',
    w: 4,
    inside: (p, h) =>
      svgInside(
        p,
        [
          [0, 0],
          [40, 0],
          [20, 30],
        ],
        true,
        h,
        0,
        0,
        4,
      ),
    box: [-10, -8, 50, 40],
  },
  {
    name: 'elliptical arc, round caps',
    el: '<path d="M0 0 A20 12 30 0 1 30 20"/>',
    attrs: 'stroke-linecap="round"',
    w: 5,
    inside: (p, h) => svgInsideGeneric(p, ARC_SEGS, false, h, 1, 0, 4),
    box: [-40, -40, 60, 60],
  },
  {
    name: 'cubic, butt caps',
    el: '<path d="M0 0 C10 -20 30 20 40 0"/>',
    attrs: 'stroke-linecap="butt"',
    w: 5,
    inside: (p, h) => svgInsideGeneric(p, CUB_SEGS, false, h, 0, 0, 4),
    box: [-5, -15, 45, 15],
  },
  {
    name: 'circle',
    el: '<circle cx="0" cy="0" r="15"/>',
    attrs: '',
    w: 4,
    inside: (p, h) => Math.abs(Math.hypot(p[0], p[1]) - 15) <= h,
    box: [-19, -19, 19, 19],
    circle: true,
  },
];
const DASHED = {
  name: 'dashed polyline (10 5, offset 3)',
  el: '<path d="M0 0 L60 0 L60 30"/>',
  w: 4,
  attrs:
    'stroke-linejoin="miter" stroke-linecap="butt" stroke-dasharray="10 5" stroke-dashoffset="3"',
};

const svgOf = (S, carrier, st) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">` +
  `<g transform="scale(${S})"><g transform="${carrier}"><g fill="none" stroke="#000" stroke-width="${st.w}" ${st.attrs}>${st.el}</g></g></g></svg>`;

/// The one stroke row of a stroke-only bundle, and what the renderer needs to walk it.
function strokeRow(b) {
  const meta = new Float32Array(b.meta, 32),
    stride = b.metaFloatsPerShape || 48;
  const rows = [];
  for (let i = 0; i * stride < meta.length; i++) {
    const o = i * stride;
    if (meta[o + META.STROKE_W] > 0 && !(meta[o + META.FILL_A] > 0)) rows.push(i);
  }
  assert.equal(rows.length, 1, 'one stroke row');
  const o = rows[0] * stride,
    m = (k) => meta[o + k];
  const cap = m(META.CAP) | 0,
    endEnc = m(META.PRIM) === 3 ? 0 : Math.round(m(META.ENDCAP)) | 0;
  return {
    row: rows[0],
    meta,
    o,
    GD: [m(META.GLX) | 0, m(META.GLY) | 0, m(META.BMX) | 0, m(META.BMY) | 0],
    bb: [m(0), m(1), m(2), m(3)],
    halfW: m(META.STROKE_W) * 0.5,
    cap,
    endCap: endEnc === 0 ? cap : endEnc - 1,
    join: m(META.JOIN) | 0,
    miter: m(META.MITER),
    dashId: Math.round(m(META.DASH)) | 0,
    flags: Math.round(m(META.FLAGS)) | 0,
    N: [m(20), m(21), m(22), m(23)],
    prim: m(META.PRIM) | 0,
    band: new Float32Array(b.bands),
    curve: new Float32Array(b.curves),
    dash: b.dashes ? new Float32Array(b.dashes) : null,
  };
}

/// Renderer membership at document points: the walk the row's flags select, distance <= half-width.
function rendererInside(emu, r, pts, ePx) {
  const framed = (r.flags & FS_STROKE_LOCAL) !== 0;
  if (framed && EMU.K_STROKE_LOCAL === undefined)
    throw new Error('a framed row, and an emulator without the stroke-space entry');
  const qs = [];
  for (const p of pts)
    for (const which of [0, 3]) {
      const ex = [r.halfW, r.miter, r.cap, r.endCap, r.join, r.dashId, 1, which];
      if (framed)
        qs.push({
          k: EMU.K_STROKE_LOCAL,
          GD: r.GD,
          bb: r.bb,
          c: p,
          ePx: [ePx, ePx],
          ex: [...ex, ...r.N],
        });
      // the conformal walk, as the main pass calls it (satD = max(halfW - 0.5 |ePx|, 0)); its half-width is the row's
      else
        qs.push({
          k: EMU.K_STROKE_WALK,
          GD: r.GD,
          bb: r.bb,
          c: p,
          ePx: [ePx, ePx],
          ex: [...ex.slice(0, 7), 0, Math.max(r.halfW - 0.5 * Math.SQRT2 * ePx, 0)],
        });
    }
  const out = emu.run(r.band, r.curve, qs, r.dash);
  const res = [];
  for (let i = 0; i < pts.length; i++) {
    const d = out[2 * i],
      hw = framed ? out[2 * i + 1] : r.halfW; // the walk's halfW out, or the row's
    res.push(d <= hw);
  }
  return res;
}

/// Local points on a grid over the stroke's box, kept only where the exact answer is clear of the outline by 1% of
/// the half-width; each with its answer.
function samples(st, n = 56) {
  const h = st.w / 2,
    [x0, y0, x1, y1] = st.box,
    out = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const p = [x0 + ((x1 - x0) * (i + 0.37)) / n, y0 + ((y1 - y0) * (j + 0.61)) / n];
      const inner = st.inside(p, h * 0.99),
        outer = st.inside(p, h * 1.01);
      if (inner === outer) out.push({ p, want: inner });
    }
  return out;
}
/// The frame the row must carry, computed here from the carrier (not from src/bundle/strokeFrame.js): sMax, the larger
/// singular value of M, and N = sMax * M^-1, column-major.
function frameOf(M) {
  const [a, b, c, d] = M,
    Q = Math.hypot((a + d) / 2, (b - c) / 2),
    R = Math.hypot((a - d) / 2, (b + c) / 2);
  const sMax = Q + R,
    det = a * d - b * c;
  return { sMax, N: [(d * sMax) / det, (-b * sMax) / det, (-c * sMax) / det, (a * sMax) / det] };
}
const toDoc = (S, M, p) => [S * (M[0] * p[0] + M[2] * p[1]), S * (M[1] * p[0] + M[3] * p[1])];

// ---- (a) and (c) -------------------------------------------------------------------------------------------------------
const emu = EMU.hasCxx() ? EMU.buildGlslEmu(ROOT, { stroke: true }) : null;
if (!emu)
  console.log(
    '  SKIPPED the renderer half: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation',
  );
const tally = new Map(); // carrier -> { n, render, hit }
let framedRows = 0,
  wantFramed = 0,
  rowFacts = [];
for (const S of SCALES)
  for (const car of CARRIERS)
    for (const st of STROKES) {
      const b = await importSvg(svgOf(S, car.t, st), { preserveViewport: true });
      const r = strokeRow(b);
      const fr = frameOf(car.M);
      wantFramed++;
      if ((r.flags & FS_STROKE_LOCAL) !== 0) {
        framedRows++;
        const Nerr =
          Math.max(...r.N.map((v, k) => Math.abs(v - fr.N[k]))) / Math.max(...fr.N.map(Math.abs));
        const wErr = Math.abs(2 * r.halfW - st.w * fr.sMax * S) / (st.w * fr.sMax * S);
        if (!(Nerr < 1e-6 && wErr < 1e-6) || (st.circle && r.prim === 4))
          rowFacts.push(
            `${car.name} ${st.name} at ${lg(S)}: N off ${Nerr.toExponential(1)}, width off ${wErr.toExponential(1)}, primKind ${r.prim}`,
          );
      }
      const pts = samples(st);
      const docPts = pts.map(({ p }) => toDoc(S, car.M, p));
      const t = tally.get(car.name) || { n: 0, render: 0, hit: 0, ex: [] };
      if (emu) {
        const got = rendererInside(emu, r, docPts, ((st.w / 2) * S) / 16);
        pts.forEach(({ p, want }, k) => {
          if (got[k] !== want) {
            t.render++;
            if (t.ex.length < 2)
              t.ex.push(
                `render ${st.name} at ${lg(S)} local (${p[0].toFixed(2)}, ${p[1].toFixed(2)}): ${got[k] ? 'in' : 'out'} for ${want ? 'in' : 'out'}`,
              );
          }
        });
      }
      pts.forEach(({ p, want }, k) => {
        const hit = fillHitShape(b, docPts[k][0], docPts[k][1], { mode: HitMode.Outline }) >= 0;
        if (hit !== want) {
          t.hit++;
          if (t.ex.length < 4)
            t.ex.push(
              `hit ${st.name} at ${lg(S)} local (${p[0].toFixed(2)}, ${p[1].toFixed(2)}): ${hit ? 'in' : 'out'} for ${want ? 'in' : 'out'}`,
            );
        }
      });
      t.n += pts.length;
      tally.set(car.name, t);
    }
for (const [name, t] of tally) {
  ok(
    t.render === 0 && t.hit === 0,
    `(a) ${name}: of ${t.n} points clear of the local SVG 2 outline, the renderer's walk puts ${emu ? t.render : '(skipped)'} and the hit test ${t.hit} on the wrong side${t.ex.length ? ' -- ' + t.ex.join('; ') : ''}`,
  );
}
ok(
  framedRows === wantFramed && rowFacts.length === 0,
  `(c) every non-conformal row is framed (${framedRows} of ${wantFramed}): texel 5 = sMax * M^-1, width sMax * w, the circle off the annulus fast path${rowFacts.length ? ' -- ' + rowFacts.slice(0, 3).join('; ') : ''}`,
);
{
  let bad = [];
  for (const car of CONFORMAL)
    for (const st of [STROKES[0], STROKES[6]]) {
      const r = strokeRow(await importSvg(svgOf(1, car.t, st), { preserveViewport: true }));
      if (
        (r.flags & FS_STROKE_LOCAL) !== 0 ||
        r.N.some((v) => v !== 0) ||
        Math.abs(2 * r.halfW - st.w * 2) > 1e-5
      )
        bad.push(`${car.name} ${st.name}`);
      if (st.circle && car.name === 'rotate(30) scale(2)' && r.prim !== 4)
        bad.push(`${car.name}: the circle lost the annulus fast path`);
    }
  ok(
    bad.length === 0,
    `(c) a conformal carrier (rotate(30) scale(2), scale(-2 2)) takes no frame: no flag, texel 5 zero, width 2 w${bad.length ? ' -- ' + bad.join('; ') : ''}`,
  );
}

// ---- (b) dashes -------------------------------------------------------------------------------------------------------
{
  const h = DASHED.w / 2;
  // points ON the body of each leg, clear of its ends by two half-widths and of every dash boundary by 1% of a
  // half-width, at lateral offsets inside the stroke: in a dash iff (s + 3) mod 15 < 10, s the local path length
  const pts = [];
  const legs = [
    { a: [0, 0], b: [60, 0], s0: 0 },
    { a: [60, 0], b: [60, 30], s0: 60 },
  ];
  for (const L of legs) {
    const len = Math.hypot(L.b[0] - L.a[0], L.b[1] - L.a[1]),
      t = [(L.b[0] - L.a[0]) / len, (L.b[1] - L.a[1]) / len];
    for (let s = 2 * h; s <= len - 2 * h; s += 0.37)
      for (const off of [-0.8, -0.3, 0.2, 0.7]) {
        const ph = (((L.s0 + s + 3) % 15) + 15) % 15;
        if (Math.min(Math.abs(ph), Math.abs(ph - 10), Math.abs(ph - 15)) < 0.01 * h) continue;
        pts.push({
          p: [L.a[0] + t[0] * s - t[1] * off * h, L.a[1] + t[1] * s + t[0] * off * h],
          want: ph < 10,
        });
      }
  }
  let n = 0,
    bad = 0,
    badHit = 0;
  for (const S of SCALES)
    for (const car of CARRIERS) {
      const b = await importSvg(svgOf(S, car.t, DASHED), { preserveViewport: true });
      const r = strokeRow(b);
      const docPts = pts.map(({ p }) => toDoc(S, car.M, p));
      if (emu) {
        const got = rendererInside(emu, r, docPts, (h * S) / 16);
        pts.forEach(({ want }, k) => {
          if (got[k] !== want) bad++;
        });
      }
      pts.forEach(({ want }, k) => {
        if (fillHitShape(b, docPts[k][0], docPts[k][1], { mode: HitMode.Outline }) >= 0 !== want)
          badHit++;
      });
      n += pts.length;
    }
  ok(
    bad === 0 && badHit === 0,
    `(b) a dashed polyline under the four carriers at three scales: of ${n} body points, ${emu ? bad : '(skipped)'} (renderer) and ${badHit} (hit test) land on the wrong side of a dash end`,
  );
}

console.log(fail ? `STROKE-LOCAL-FRAME FAIL (${fail})` : 'STROKE-LOCAL-FRAME PASS');
process.exit(fail ? 1 : 0);
