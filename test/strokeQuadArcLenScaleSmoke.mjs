// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeQuadArcLenScaleSmoke — the stroke shader measures a quad's arc length the way the encoder does, at every
// coordinate scale (_strokeMath.glsl quadArcLen; its twins are src/svg/textures.js _quadLenAt, which writes every
// segment's dash startDist, and src/hitTest/curveGeom.js).
//
// THE HAZARD. A quadArcLen that takes the CHORD when Aq = |p1 - 2 p2 + p3|^2 is under an absolute 1e-12, and drops
// its log term when that term's argument is under an absolute 1e-12, cuts off at lengths SQUARED, so both cut-offs move
// with the drawing: at 2^-20 a curved quad under about a unit across measures as its chord. The encoder's two cut-offs
// are relative (A <= 1e-12 C; the log term kept while its argument is more than 1e-12 of its own two addends), and if
// the shader's were absolute the in-shader distance at a segment's end along a dashed chain of quads would fall short
// of the next segment's startDist, and the dash phase would JUMP at every seam.
//
// The kernel side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs, `stroke: true`).
//
// (a) a dashed chain of curved quads, imported at 2^-20, 1 and 2^20: at every seam the shader's distance at the end of
//     one segment (its startDist + quadArcLen to t = 1) is the next segment's startDist, to 1e-5 of the chain so far;
// (b) quadArcLen at t = 1/4, 1/2, 3/4, 1 over seeded quads matches the encoder's _quadLenAt to 1e-5 of the length, at
//     all three scales, and reads the same at each scale as at 1 (divided by the scale);
// (c) quads that ARE straight (collinear control points) still match the encoder, including A = 0, which takes the
//     chord, at all three scales;
// (d) mutation: the absolute Aq < 1e-12 restored (with the length scale removed) is caught by (a) and (b).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_QUAD_ARCLEN } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP strokeQuadArcLenScaleSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(77);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { decodeSegs, SEG_QUAD } = await import('../src/hitTest/curveGeom.js');
const { _quadLenAt } = await import('../src/svg/textures.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const NO_DATA = new Float32Array(4);
const SCALES = [2 ** -20, 1, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;

// ---- (a) the dash seams of an imported chain --------------------------------------------------------------------------
// Eight curved quads end to end, each well under a unit across at 2^-20 (so an absolute cut-off would take every one
// for its chord), with a dash array so the encoder writes startDist. The scales are powers of two, so the scale is the only
// thing that varies.
const CHAIN = [
  [0, 0],
  [0.5, 0.4],
  [1, 0],
  [1.25, -0.6],
  [1.5, 0],
  [2, 0.3],
  [2.5, 0],
  [2.75, 0.5],
  [3, 0],
  [3.5, -0.4],
  [4, 0],
  [4.25, 0.2],
  [4.5, 0],
  [5, -0.5],
  [5.5, 0],
  [5.75, 0.35],
  [6, 0],
];
async function chain(S) {
  const f = (v) => +(v * S).toPrecision(17);
  let d = `M ${f(CHAIN[0][0])} ${f(CHAIN[0][1])}`;
  for (let i = 1; i + 1 < CHAIN.length; i += 2)
    d += ` Q ${f(CHAIN[i][0])} ${f(CHAIN[i][1])} ${f(CHAIN[i + 1][0])} ${f(CHAIN[i + 1][1])}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(-1)} ${f(-1)} ${f(8)} ${f(2)}">` +
    `<path d="${d}" fill="none" stroke="#000" stroke-width="${f(0.05)}" stroke-dasharray="${f(0.3)} ${f(0.2)}"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
  const rg = b.curveRangesByShape[0];
  return decodeSegs(new Float32Array(b.curves), rg.begin, rg.end).filter((s) => s.t === SEG_QUAD);
}
/// Every seam's jump, as a fraction of the chain's length so far: the shader's distance at the end of segment i minus
/// segment i+1's startDist. The control points go in RELATIVE to a point near the segment, as the band walk passes them.
function seams(emu, segs) {
  const qs = segs.map((s) => ({
    k: K_QUAD_ARCLEN,
    bb: [s.x0 - s.x0, s.y0 - s.y0, s.cx - s.x0, s.cy - s.y0],
    c: [s.x1 - s.x0, s.y1 - s.y0],
    ePx: [1, 0],
  }));
  const len = emu.run(NO_DATA, NO_DATA, qs);
  const out = [];
  for (let i = 0; i + 1 < segs.length; i++)
    out.push(Math.abs(segs[i].sd + len[i] - segs[i + 1].sd) / segs[i + 1].sd);
  return out;
}
const CHAINS = [];
for (const S of SCALES) CHAINS.push([S, await chain(S)]);
const EMU = buildGlslEmu(ROOT, { stroke: true });
function seamWorst(emu) {
  const r = [];
  for (const [S, segs] of CHAINS) r.push([S, Math.max(...seams(emu, segs)), segs.length]);
  return r;
}
{
  const r = seamWorst(EMU);
  ok(
    r.every(([, , n]) => n === 8),
    `(a) the chain imports as 8 native quads at every scale (${r.map(([, , n]) => n).join(', ')})`,
  );
  ok(
    r.every(([, w]) => w <= 1e-5),
    `(a) at every dash seam the shader's end distance is the next startDist: worst jump ${r.map(([S, w]) => `${w.toExponential(1)} at ${lg(S)}`).join(', ')} of the chain so far (bar 1e-5)`,
  );
}

// ---- (b) quadArcLen against the encoder's _quadLenAt ------------------------------------------------------------------
let seed = 0x51f10;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const QUADS = [];
for (let i = 0; i < 200; i++) {
  const w = 0.05 + rnd() * 2; // extents from a twentieth of a unit to two units
  QUADS.push([
    [0, 0],
    [(rnd() - 0.5) * w, (rnd() - 0.5) * w],
    [(rnd() - 0.5) * w, (rnd() - 0.5) * w],
  ]);
}
const TS = [0.25, 0.5, 0.75, 1];
function lenWorst(emu) {
  const qs = [],
    ref = [];
  for (const S of SCALES)
    for (const q of QUADS)
      for (const t of TS) {
        const p = q.map(([x, y]) => [Math.fround(x * S), Math.fround(y * S)]);
        qs.push({
          k: K_QUAD_ARCLEN,
          bb: [p[0][0], p[0][1], p[1][0], p[1][1]],
          c: p[2],
          ePx: [t, 0],
        });
        ref.push({
          S,
          want: _quadLenAt({ p1: p[0], p2: p[1], p3: p[2] }, t),
          full: _quadLenAt({ p1: p[0], p2: p[1], p3: p[2] }, 1),
        });
      }
  const got = emu.run(NO_DATA, NO_DATA, qs);
  const worst = new Map(SCALES.map((S) => [S, 0]));
  let scaleGap = 0;
  const per = qs.length / SCALES.length;
  for (let i = 0; i < qs.length; i++) {
    worst.set(
      ref[i].S,
      Math.max(worst.get(ref[i].S), Math.abs(got[i] - ref[i].want) / ref[i].full),
    );
    const i1 = per + (i % per); // the same quad and t at scale 1
    scaleGap = Math.max(scaleGap, Math.abs(got[i] / ref[i].S - got[i1]) / ref[i1].full);
  }
  return { worst, scaleGap };
}
{
  const r = lenWorst(EMU);
  ok(
    [...r.worst.values()].every((w) => w <= 1e-5),
    `(b) ${QUADS.length} quads x ${TS.length} parameters: quadArcLen matches the encoder's _quadLenAt to ${[...r.worst].map(([S, w]) => `${w.toExponential(1)} at ${lg(S)}`).join(', ')} of the length (bar 1e-5)`,
  );
  ok(
    r.scaleGap <= 1e-5,
    `(b) ...and reads the same at 2^-20 and 2^20 as at 1, divided by the scale (worst ${r.scaleGap.toExponential(1)} of the length)`,
  );
}

// ---- (c) straight quads --------------------------------------------------------------------------
{
  const qs = [],
    want = [];
  for (const S of SCALES)
    for (const [p1, p2, p3] of [
      [
        [0, 0],
        [0.5, 0.5],
        [1, 1],
      ],
      [
        [0, 0],
        [0.25, 0],
        [1, 0],
      ],
      [
        [0, 0],
        [2, 0],
        [1, 0],
      ],
    ]) {
      const p = [p1, p2, p3].map(([x, y]) => [x * S, y * S]);
      qs.push({
        k: K_QUAD_ARCLEN,
        bb: [p[0][0], p[0][1], p[1][0], p[1][1]],
        c: p[2],
        ePx: [0.5, 0],
      });
      want.push(_quadLenAt({ p1: p[0], p2: p[1], p3: p[2] }, 0.5));
    }
  const got = EMU.run(NO_DATA, NO_DATA, qs);
  let worst = 0;
  for (let i = 0; i < qs.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]) / want[i]);
  // Evenly spaced control points make A = 0 exactly, which is the chord cut-off. Unevenly spaced ones make A parallel
  // to B, so the closed form runs with a zero log coefficient (4AC - B^2 = 0); the third overshoots its end and comes
  // back, which the closed form measures as the doubled-back length.
  ok(
    worst <= 1e-6,
    `(c) collinear quads (evenly spaced, unevenly spaced, doubling back) match the encoder at all three scales (worst ${worst.toExponential(1)})`,
  );
}

// ---- (d) mutation ---------------------------------------------------------------------------------------------------------
{
  // The shipped code normalizes by the largest control component (lengthScale) and cuts the chord off RELATIVELY. The earlier
  // shader had neither: no normalization and an absolute `Aq < 1e-12`. The mutation restores both.
  const FIXED = 'if (Aq <= 1e-12 * Cq) return length((p3 - p1) / lengthScale) * lengthScale * t;';
  const SCALE = 'float lengthScale = max(max(abs(A.x), abs(A.y)), max(abs(B.x), abs(B.y)));';
  ok(
    GLSL.split(FIXED).length === 2 && GLSL.split(SCALE).length === 2,
    '(d) the relative chord cut-off and the length scale are in the shipped text once (the mutation hinges)',
  );
  const mut = buildGlslEmu(ROOT, {
    stroke: true,
    glsl: GLSL.replace(FIXED, 'if (Aq < 1e-12) return length(p3 - p1) * t;').replace(
      SCALE,
      'float lengthScale = 1.0;',
    ),
  });
  const a = seamWorst(mut),
    b = lenWorst(mut);
  ok(
    a.some(([, w]) => w > 1e-3) && [...b.worst.values()].some((w) => w > 1e-3),
    `(d) the absolute Aq < 1e-12 restored is caught: worst seam jump ${Math.max(...a.map(([, w]) => w)).toExponential(1)}, worst length ${Math.max(...b.worst.values()).toExponential(1)}`,
  );
}

console.log(fail ? `STROKE-QUAD-ARCLEN-SCALE FAIL (${fail})` : 'STROKE-QUAD-ARCLEN-SCALE PASS');
process.exit(fail ? 1 : 0);
