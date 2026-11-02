// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeFloorsScaleSmoke — the stroke distance of a drawing scaled by a power of two is the drawing's distance scaled
// by it, bit for bit: _strokeMath.glsl's and the band walk's absolute floors.
//
// THE PROPERTY. Multiplying every coordinate by 2^k is exact in float32, and so is every product, quotient and square
// root of the results (barring subnormals, which [2^-20, 2^20] does not reach): a kernel with no absolute constant in a
// length returns exactly 2^k times the distance and exactly the same boundary normal. So the test is equality, not a
// tolerance, and anything that differs is a constant that carries a length. The ones that bite:
//   * `max(length(dStart | dEnd), 1e-12)` to normalize an end direction for a cap or join plane: at 2^-20 a handle 1e-7
//     of its span is 1.9e-13 long, the "unit" direction comes out 0.19 long, and a pixel 0.2 halfW behind a butt cap
//     reads 1.038 halfW for 1.200;
//   * strokeArcAccum's `atan(foot.y / max(radii.y, 1e-9), foot.x / max(radii.x, 1e-9))` and its band-walk twin in
//     _coverage.glsl: an arc under 1e-9 across -- 1e-3 of a unit at 2^-20 -- has its foot's angle, so its in-range
//     test and its cap parameter, taken against radii it does not have;
//   * the `> 1e-12` guards on the boundary normal (strokeQuadAccum, strokeCubicAccum, strokeArcAccum, the band walk's
//     arc) and the line body's `max(thisD, 1e-12)`: at 2^-20 a pixel within 1e-12 of the centerline hands back no
//     normal, or a short one. Only where the coverage is saturated anyway -- but a normal is a direction, and zero is
//     not one;
//   * and the band walk's LINE: a squared length floored at 1e-20 gives a line under 1e-4 of a unit long at 2^-20 a
//     parameter and a direction 1e-10 / length too short.
//
// The kernels are the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs, `stroke: true`).
//
// (a) quads and cubics whose tested end has a handle 1e-2, 1e-6 or 1e-7 of the span, under a butt, round and square
//     cap and under every join (miter, round, bevel, miter-clip, arcs) at four turns, on a grid of pixels around that
//     end: distance and normal at 2^-20 and 2^20 against scale 1; and the named pixel, 0.2 halfW behind the butt
//     cap of a 1e-7 handle, reads 1.2 halfW at every scale;
// (b) strokeArcAccum on elliptical arcs of radii 1e-3 x 4e-4 and 0.5 x 0.2, the same caps and joins, pixels around
//     both ends and along the body;
// (c) the boundary normal a hair from the centerline (2^-23 .. 2^-26 of the span) of a quad, a cubic and an arc is a
//     unit vector at every scale;
// (d) the band walk itself (strokeMinDist over the encoder's planes: a line, a quad, an arc of 1e-3 x 4e-4 and a line
//     5e-5 long), distance and normal, including the line body's normal a hair from its centerline;
// (e) mutations: each floor restored in the shipped text is caught.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  hasCxx,
  buildGlslEmu,
  K_STROKE_QUAD,
  K_STROKE_CUBIC,
  K_STROKE_ARC,
  K_STROKE_WALK,
} from './_glslEmu.mjs';
import { buildTexturesShape, makeTexelBuffer } from '../src/svg/textures.js';
import { mkLine, mkQuad, mkArc } from '../src/svg/segment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const f = Math.fround;
const SCALES = [2 ** -20, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const HW = 0.05,
  ML = 4;
const GRID = [-1.7, -1.2, -0.8, -0.45, -0.15, 0.1, 0.35, 0.7, 1.1, 1.6];
const rot = (v, a) => [
  v[0] * Math.cos(a) - v[1] * Math.sin(a),
  v[0] * Math.sin(a) + v[1] * Math.cos(a),
];
const TURNS = [40, -40, 165, -165].map((d) => (d * Math.PI) / 180);
/// Cap and join configurations at one end: a free end under each cap, and an interior end under each join, the
/// neighbour's tangent turned by each of TURNS from this segment's own direction there.
function configs(T) {
  const out = [0, 1, 2].map((cap) => ({ free: true, cap, join: 0, nb: [0, 0], tag: `cap ${cap}` }));
  for (let join = 0; join <= 4; join++)
    for (const a of TURNS) {
      const n = rot(T, a);
      out.push({
        free: false,
        cap: 0,
        join,
        nb: [f(n[0]), f(n[1])],
        tag: `join ${join} turn ${Math.round((a * 180) / Math.PI)}`,
      });
    }
  return out;
}

// ---- the query sets, at scale 1 (every coordinate a float32), and their images at scale S ------------------------------
/// One query per (curve, end, configuration, pixel). `pts` are the curve's control points, `V` the tested end, `T` its
/// forward direction; the pixel grid is laid round V. Scaling multiplies the points and the pixel, which is exact.
function curveQueries(kind, S) {
  const qs = [];
  for (const h of [1e-2, 1e-6, 1e-7])
    for (const atStart of [true, false]) {
      const P =
        kind === 'quad'
          ? atStart
            ? [
                [0, 0],
                [0, h],
                [1, 0],
              ]
            : [
                [0, 0],
                [1, h],
                [1, 0],
              ]
          : atStart
            ? [
                [0, 0],
                [0, h],
                [1, 0.3],
                [1, 0],
              ]
            : [
                [0, 0],
                [0, 0.3],
                [1, h],
                [1, 0],
              ];
      const V = atStart ? P[0] : P[P.length - 1],
        T = atStart ? [0, 1] : [0, -1];
      for (const cf of configs(T))
        for (const gx of GRID)
          for (const gy of GRID) {
            const c = [f(V[0] + gx * HW) * S, f(V[1] + gy * HW) * S];
            const rel = P.map(([x, y]) => [f(x * S - c[0]), f(y * S - c[1])]);
            const GD = [
              atStart && cf.free ? 1 : 0,
              !atStart && cf.free ? 1 : 0,
              cf.cap | (cf.cap << 4),
              cf.join,
            ];
            const tans = atStart ? [...cf.nb, 0, 0] : [0, 0, ...cf.nb];
            const tag = `${kind} handle ${h} ${atStart ? 'start' : 'end'} ${cf.tag} at (${gx}, ${gy}) halfW`;
            for (const which of [0, 1, 2]) {
              const G = [GD[0], GD[1], GD[2] | (which << 8), GD[3]];
              if (kind === 'quad')
                qs.push({
                  k: K_STROKE_QUAD,
                  bb: [...rel[0], ...rel[1]],
                  c: rel[2],
                  ePx: [ML, f(HW * S)],
                  GD: G,
                  ex: tans,
                  which,
                  tag,
                });
              else
                qs.push({
                  k: K_STROKE_CUBIC,
                  bb: [...rel[0], ...rel[1]],
                  c: rel[2],
                  ePx: [ML, f(HW * S)],
                  GD: G,
                  ex: [...rel[3], ...tans],
                  which,
                  tag,
                });
            }
          }
    }
  return qs;
}
/// Arcs as encodeSeg stores them, the query RELATIVE TO THE CENTER (strokeArcAccum's convention).
function arcQueries(S) {
  const qs = [];
  for (const [rx, ry] of [
    [1e-3, 4e-4],
    [0.5, 0.2],
  ]) {
    const phi = 0.3,
      th0 = 0.2,
      th1 = 2.4,
      hw = f(0.1 * ry);
    const at = (th) => [
      rx * Math.cos(th) * Math.cos(phi) - ry * Math.sin(th) * Math.sin(phi),
      rx * Math.cos(th) * Math.sin(phi) + ry * Math.sin(th) * Math.cos(phi),
    ];
    const vel = (th) => {
      const v = [
        -rx * Math.sin(th) * Math.cos(phi) - ry * Math.cos(th) * Math.sin(phi),
        -rx * Math.sin(th) * Math.sin(phi) + ry * Math.cos(th) * Math.cos(phi),
      ];
      const l = Math.hypot(v[0], v[1]);
      return [v[0] / l, v[1] / l];
    };
    for (const where of ['start', 'end', 'body']) {
      const th = where === 'start' ? th0 : where === 'end' ? th1 : 0.5 * (th0 + th1);
      const V = at(th),
        T = vel(th);
      const cfs =
        where === 'body' ? [{ free: true, cap: 0, join: 0, nb: [0, 0], tag: 'body' }] : configs(T);
      for (const cf of cfs)
        for (const gx of GRID)
          for (const gy of GRID) {
            const pc = [f(V[0] + gx * hw) * S, f(V[1] + gy * hw) * S];
            const GD = [
              where === 'start' && cf.free ? 1 : 0,
              where === 'end' && cf.free ? 1 : 0,
              cf.cap | (cf.cap << 4),
              cf.join,
            ];
            const tans = where === 'start' ? [...cf.nb, 0, 0] : [0, 0, ...cf.nb];
            const tag = `arc ${rx} x ${ry} ${where} ${cf.tag} at (${gx}, ${gy}) halfW`;
            for (const which of [0, 1, 2]) {
              qs.push({
                k: K_STROKE_ARC,
                bb: [pc[0], pc[1], f(rx) * S, f(ry) * S],
                c: [f(phi), f(th0)],
                ePx: [ML, hw * S],
                GD: [GD[0], GD[1], GD[2] | (which << 8), GD[3]],
                ex: [f(th1), ...tans],
                which,
                tag,
              });
            }
          }
    }
  }
  return qs;
}
/// Pixels a hair off the centerline, 2^-23 .. 2^-26 of the span, where the closest point is interior: the apex of a
/// symmetric quad and cubic, and the top of a unit circle's arc.
function hairQueries(S) {
  const qs = [];
  for (const e of [23, 24, 25, 26]) {
    const d = 2 ** -e;
    {
      const c = [0, (0.5 + d) * S],
        P = [
          [-1, 0],
          [0, 1],
          [1, 0],
        ].map(([x, y]) => [f(x * S - c[0]), f(y * S - c[1])]);
      for (const which of [0, 1, 2])
        qs.push({
          k: K_STROKE_QUAD,
          bb: [...P[0], ...P[1]],
          c: P[2],
          ePx: [ML, f(HW * S)],
          GD: [1, 1, which << 8, 0],
          ex: [0, 0, 0, 0],
          which,
          tag: `quad apex + 2^-${e}`,
        });
    }
    {
      const c = [0, (0.5 + d) * S],
        P = [
          [-1, 0],
          [-0.5, 2 / 3],
          [0.5, 2 / 3],
          [1, 0],
        ].map(([x, y]) => [f(f(x) * S - c[0]), f(f(y) * S - c[1])]);
      for (const which of [0, 1, 2])
        qs.push({
          k: K_STROKE_CUBIC,
          bb: [...P[0], ...P[1]],
          c: P[2],
          ePx: [ML, f(HW * S)],
          GD: [1, 1, which << 8, 0],
          ex: [...P[3], 0, 0, 0, 0],
          which,
          tag: `cubic apex + 2^-${e}`,
        });
    }
    for (const which of [0, 1, 2])
      qs.push({
        k: K_STROKE_ARC,
        bb: [0, (1 + d) * S, S, S],
        c: [0, 0.5],
        ePx: [ML, f(HW * S)],
        GD: [1, 1, which << 8, 0],
        ex: [2.5, 0, 0, 0, 0],
        which,
        tag: `arc top + 2^-${e}`,
      });
  }
  return qs;
}

/// Run a query set at scale 1 and at S; count the answers that are not exactly S times (a distance) or exactly equal
/// (a normal) to scale 1's. Returns { n, bad, first }.
function equivariance(emu, make, S, planes1 = null, planesS = null) {
  const q1 = make(1),
    qS = make(S);
  const r1 = planes1
    ? emu.run(planes1.band, planes1.curve, q1)
    : emu.run(new Float32Array(4), new Float32Array(4), q1);
  const rS = planesS
    ? emu.run(planesS.band, planesS.curve, qS)
    : emu.run(new Float32Array(4), new Float32Array(4), qS);
  let bad = 0,
    first = '';
  for (let i = 0; i < q1.length; i++) {
    const want = q1[i].which === 0 ? f(r1[i] * S) : r1[i];
    if (rS[i] === want || (Number.isNaN(rS[i]) && Number.isNaN(want))) continue;
    bad++;
    if (!first)
      first = `${q1[i].tag}${q1[i].which ? ` normal.${'xy'[q1[i].which - 1]}` : ''}: ${q1[i].which === 0 ? (rS[i] / S).toPrecision(6) : rS[i].toPrecision(6)} for ${r1[i].toPrecision(6)}`;
  }
  return { n: q1.length, bad, first };
}

// ---- (d) the band walk over the encoder's planes -------------------------------------------------------------------------
/// One stroke row's planes at scale S: a line, a quad and a small elliptical arc, each its own open subpath. The encoder
/// is exact under a power-of-two scale (products, sums and square roots of scaled float64 values), so its planes at S
/// are the planes at 1 scaled -- which the walk then has to honour.
function walkPlanes(S) {
  const segs = [
    mkLine([-1 * S, 0.5 * S], [1 * S, 0.5 * S]),
    mkQuad([-1 * S, 1.5 * S], [0, 2.5 * S], [1 * S, 1.5 * S]),
    mkArc(2 * S, 0.5 * S, 1e-3 * S, 4e-4 * S, 0.2, 2.4, 0.3, 0, 1),
    mkLine([1.5 * S, 1.5 * S], [(1.5 + 3e-5) * S, (1.5 + 4e-5) * S]),
  ];
  const bbox = [-1.1 * S, 0.3 * S, 2.1 * S, 2.3 * S];
  const curveBuf = makeTexelBuffer(),
    bandBuf = makeTexelBuffer();
  const sm = buildTexturesShape(segs, 1, 1, bbox, curveBuf, bandBuf, 0.2 * S);
  // the texel buffers hold float64; the planes the GPU reads are float32
  return {
    band: new Float32Array(bandBuf.floats.subarray(0, bandBuf.count * 4)),
    curve: new Float32Array(curveBuf.floats.subarray(0, curveBuf.count * 4)),
    GD: [sm.glyphLoc[0], sm.glyphLoc[1], sm.bandMaxX, sm.bandMaxY],
    bbox,
  };
}
function walkQueries(S, planes) {
  const qs = [];
  const push = (c, hw, cap, join, tag) => {
    for (const which of [0, 1, 2])
      qs.push({
        k: K_STROKE_WALK,
        GD: planes.GD,
        bb: planes.bbox,
        c,
        ePx: [f(1e-3 * S), f(1e-3 * S)],
        ex: [hw, ML, cap, cap, join, 0, 0, which, -1e20],
        which,
        tag,
      });
  };
  // the line body a hair off its centerline
  for (const e of [23, 24, 25, 26])
    push([0.25 * S, (0.5 + 2 ** -e) * S], f(HW * S), 0, 0, `line body + 2^-${e}`);
  // round the quad's apex and ends, and round the small arc
  for (const gx of GRID)
    for (const gy of GRID) {
      push([f(gx * HW) * S, f(2 + gy * HW) * S], f(HW * S), 0, 0, `quad apex (${gx}, ${gy})`);
      push(
        [f(-1 + gx * HW) * S, f(1.5 + gy * HW) * S],
        f(HW * S),
        2,
        0,
        `quad start (${gx}, ${gy})`,
      );
      for (const th of [0.2, 1.3, 2.4]) {
        const V = [
          2 + 1e-3 * Math.cos(th) * Math.cos(0.3) - 4e-4 * Math.sin(th) * Math.sin(0.3),
          0.5 + 1e-3 * Math.cos(th) * Math.sin(0.3) + 4e-4 * Math.sin(th) * Math.cos(0.3),
        ];
        push(
          [f(V[0] + gx * 4e-5) * S, f(V[1] + gy * 4e-5) * S],
          f(4e-5 * S),
          0,
          0,
          `arc at ${th} (${gx}, ${gy})`,
        );
      }
      for (const cap of [0, 2])
        push(
          [f(1.5 + 1.5e-5 + gx * 2e-5) * S, f(1.5 + 2e-5 + gy * 2e-5) * S],
          f(1e-5 * S),
          cap,
          0,
          `short line cap ${cap} (${gx}, ${gy})`,
        );
    }
  return qs;
}

if (!hasCxx()) {
  console.log('  SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation');
} else {
  const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const report = (emu, label) => {
    const out = {};
    for (const S of SCALES) {
      out[S] = {
        quad: equivariance(emu, (s) => curveQueries('quad', s), S),
        cubic: equivariance(emu, (s) => curveQueries('cubic', s), S),
        arc: equivariance(emu, arcQueries, S),
        hair: equivariance(emu, hairQueries, S),
        walk: (() => {
          const p1 = walkPlanes(1),
            pS = walkPlanes(S);
          return equivariance(emu, (s) => walkQueries(s, s === 1 ? p1 : pS), S, p1, pS);
        })(),
      };
    }
    return out;
  };
  const emu = buildGlslEmu(ROOT, { stroke: true });
  const r = report(emu);
  for (const [sec, name] of [
    ['quad', '(a) quads'],
    ['cubic', '(a) cubics'],
    ['arc', '(b) arcs (strokeArcAccum)'],
    ['hair', '(c) the normal a hair off the centreline'],
    ['walk', '(d) the band walk (strokeMinDist)'],
  ]) {
    for (const S of SCALES) {
      const e = r[S][sec];
      ok(
        e.bad === 0,
        `${name} at ${lg(S)}: ${e.bad} of ${e.n} answers not exactly scale 1's${e.bad ? ' -- first ' + e.first : ''}`,
      );
    }
  }
  // The named pixel: 0.2 halfW behind the butt cap of a quad whose start handle is 1e-7 of its span.
  {
    const vals = [2 ** -20, 1, 2 ** 20].map((S) => {
      const c = [0, f(-0.2 * HW) * S];
      const P = [
        [0, 0],
        [0, 1e-7],
        [1, 0],
      ].map(([x, y]) => [f(x * S - c[0]), f(f(y) * S - c[1])]);
      return (
        emu.run(new Float32Array(4), new Float32Array(4), [
          {
            k: K_STROKE_QUAD,
            bb: [...P[0], ...P[1]],
            c: P[2],
            ePx: [ML, f(HW * S)],
            GD: [1, 1, 0, 0],
            ex: [0, 0, 0, 0],
          },
        ])[0] /
        (HW * S)
      );
    });
    ok(
      vals.every((v) => Math.abs(v - 1.2) < 1e-5),
      `(a) 0.2 halfW behind the butt cap of a 1e-7 handle reads ${vals.map((v) => v.toFixed(4)).join(' / ')} halfW at 2^-20 / 1 / 2^20 (want 1.2000)`,
    );
  }

  // ---- (e) mutations ---------------------------------------------------------------------------------------------------
  const mutate = (label, from, to, sec) => {
    if (GLSL.split(from).length !== 2) {
      ok(false, `(e) ${label}: the hinge is not in the shipped text exactly once`);
      return;
    }
    const m = report(buildGlslEmu(ROOT, { stroke: true, glsl: GLSL.replace(from, to) }));
    const e = m[2 ** -20][sec];
    ok(e.bad > 0, `(e) ${label} restored is caught at 2^-20: ${e.bad} of ${e.n} answers move`);
  };
  mutate(
    "the 1e-12 floor on the cap and join planes' directions",
    'vec2 strokeUnit(vec2 d) { float l = length(d); return l > 0.0 ? d / l : d; }',
    'vec2 strokeUnit(vec2 d) { return d / max(length(d), 1e-12); }',
    'quad',
  );
  // (the hinge is arcFootAngle's signed-zero-safe angle line; the restored text is the 1e-9 floors, so the assertion is the same)
  // (the angle is _arcMath.glsl arcFootAngle's, which strokeArcAccum and the band walk share)
  mutate(
    "the 1e-9 floors in strokeArcAccum's angle",
    'float t = fx == 0.0 ? (fy == 0.0 ? 0.0 : (fy < 0.0 ? -0.25 * TWO_PI : 0.25 * TWO_PI)) : atan(fy, fx);',
    'float t = atan(foot.y / max(radii.y, 1e-9), foot.x / max(radii.x, 1e-9));',
    'arc',
  );
  mutate(
    "the 1e-12 guard on the quad's normal",
    '(t >= 1e-4 && t <= 1.0 - 1e-4 && thisD > 0.0) ? (-q / thisD)',
    '(t >= 1e-4 && t <= 1.0 - 1e-4 && thisD > 1e-12) ? (-q / thisD)',
    'hair',
  );
}

console.log(fail ? `STROKE-FLOORS-SCALE FAIL (${fail})` : 'STROKE-FLOORS-SCALE PASS');
process.exit(fail ? 1 : 0);
