// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRibbonGateSmoke — Loop-Blinn's counter-hole ribbon gate keeps the antialiasing just outside an
// even-odd ring's outer extreme points.
//
// ISOLATED on the CPU (test/_lbMorphDrawEmu.mjs against exact even-odd coverage, 512 px). The model
// matches the GPU to the pixel. With a chord-measured gate, lbMorphEvenOdd at t = 0.03 differs from
// Slug by up to 100 levels, and against exact coverage those pixels are LOOP-BLINN's: 0.000 where the
// pixel is 0.375 covered and Slug paints 0.393 (Slug's own error there is its usual AA).
//
// THE SEGMENT: every quarter-circle cubic of the ring's OUTER contour, at its ends -- the ring's four
// extreme points -- where a kind-12 exterior curve band is the only piece that reaches a pixel just
// outside the arc. THE TRAP: a counter-hole ribbon gate that discards a band fragment near the
// implicit (|dpx| < 1) but more than 1.5 px from the piece's CHORD, and applies
// to every band with a negative sign. It assumes a negative sign means a counter whose ink is on the
// control side; an even-odd ring's OUTER bowl carries one too. Near an arc's end the arc runs along
// its end tangent, 45 degrees or more off the chord, so a pixel 0.09 px outside the arc reads 1.83 px
// from the chord and loses all of its antialiasing. It is the chord-for-a-curve defect family.
//
// THE GATE measures the distance to the region the arc can occupy -- the triangle of its chord and the
// point its end tangents meet -- which contains the chord, so it discards a subset of what a chord
// gate does: fragments past the arc's ENDS, where the extrapolated implicit lives. This pins:
//   - lbMorphEvenOdd loses NO ink against exact at t = 0, 0.03, 0.09, 0.12, 0.75 (a chord gate loses
//     80 / 72 / 56 / 56 / 48 px there), at 2^-20, 1 and 2^20 for t = 0.03;
//   - the chord gate, run through the same model, still loses them (the instrument is live);
//   - lbTangentTriDist never exceeds the chord distance, is ~0 just outside the arc near its end, and
//     still reads far along the implicit's continuation past the end, so the gate keeps its purpose;
//   - the shipped shader calls it in the gate, so the model and the GLSL cannot drift apart quietly.
// NOT COVERED by the gate, and still in the model at these t: interior (kind 0) triangles that end on the INNER
// ring's extreme tangent paint 1.0 over a pixel whose lower part is hole (0.81 exact at t = 0.03, up
// to 96 levels over at t = 0.04), and at t = 0.035 no triangle reaches a strip just outside the arc.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildMorphBundle } = await import('../src/renderer/lbMorphCore.js');
const EMU = await import('./_lbMorphDrawEmu.mjs');
const warn = console.warn;
console.warn = () => {};

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const SRC = readFileSync(path.join(ROOT, 'examples/smoke/lbMorphEvenOdd__SRC.svg'), 'utf8');
const DST = readFileSync(path.join(ROOT, 'examples/smoke/lbMorphEvenOdd__DST.svg'), 'utf8');
// Scale every coordinate in the viewBox and the path data by s.
const scaled = (svg, s) =>
  svg.replace(
    /(viewBox|d)="([^"]*)"/g,
    (_, k, v) => `${k}="${v.replace(/-?\d+(\.\d+)?(e-?\d+)?/g, (n) => String(Number(n) * s))}"`,
  );

async function morphOf(s) {
  const A = await importSvg(scaled(SRC, s), { preserveViewport: true }),
    B = await importSvg(scaled(DST, s), { preserveViewport: true });
  const pa = parseMetaBin(A.meta, A.metaFloatsPerShape),
    pb = parseMetaBin(B.meta, B.metaFloatsPerShape);
  const input = {
    srcCurve: new Float32Array(A.curves),
    dstCurve: new Float32Array(B.curves),
    srcMeta: pa.metaFloats,
    dstMeta: pb.metaFloats,
    metaStride: pa.floatsPerShape,
    ranges: A.curveRangesByShape,
    numShapes: A.numShapes,
    bb: A.globalBBox,
  };
  const res = buildMorphBundle(input),
    mesh = res && res.meshes && res.meshes[0];
  const sc = curveRangeToContours(
    input.srcCurve,
    A.curveRangesByShape[0].begin,
    A.curveRangesByShape[0].end,
  );
  const dc = curveRangeToContours(
    input.dstCurve,
    B.curveRangesByShape[0].begin,
    B.curveRangesByShape[0].end,
  );
  const poseAt = (t) =>
    sc.map((c, ci) =>
      c.map((g, si) => {
        const d = dc[ci][si],
          lp = (p, q) => p && [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        return {
          type: g.type,
          w: g.w,
          p1: lp(g.p1, d.p1),
          p2: lp(g.p2, d.p2),
          p3: lp(g.p3, d.p3),
          p4: lp(g.p4, d.p4),
        };
      }),
    );
  return { mesh, bb: Array.from(A.globalBBox), poseAt };
}
const N = 512;
const score = (m, t, opts) =>
  EMU.scoreExact(
    EMU.render(EMU.morphPacksAt(m.mesh, t), m.bb, N, opts).cov,
    m.poseAt(t),
    m.bb,
    N,
    12,
    true,
  );
const tell = (r) =>
  `${r.off} off exact (over ${r.over}, lost inside ${r.lostIn}, lost outside ${r.lostOut})`;

const M1 = await morphOf(1);
ok(
  !!M1.mesh && M1.mesh.mode === 'partitionPair',
  `lbMorphEvenOdd builds a Loop-Blinn morph mesh (${M1.mesh ? M1.mesh.mode : 'none'})`,
);
for (const t of [0, 0.03, 0.09, 0.12, 0.75]) {
  const r = score(M1, t),
    c = score(M1, t, { chordGate: true });
  ok(r.lostIn + r.lostOut === 0, `t = ${t}: ${tell(r)}; no ink lost`);
  ok(
    c.lostOut > 0,
    `t = ${t}: ...and the CHORD gate, through the same model, loses ${c.lostOut} px outside (${tell(c)})`,
  );
}
for (const k of [-20, 20]) {
  const Ms = await morphOf(2 ** k),
    r = score(Ms, 0.03);
  ok(r.lostIn + r.lostOut === 0, `2^${k}, t = 0.03: ${tell(r)}; no ink lost`);
}

// ---- the distance itself, on the ring's quarter arc from (4.09, 22) to its top (22, 4.09) ------------
{
  const a = [4.09, 22],
    b = [22, 4.09],
    ab = [b[0] - a[0], b[1] - a[1]],
    nA = [1, 0],
    nB = [0, -1],
    px = 44 / 512;
  const chordOf = (p) => {
    const u = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)),
    );
    return Math.hypot(p[0] - a[0] - ab[0] * u, p[1] - a[1] - ab[1] * u);
  };
  const D = (p) => EMU.tangentTriDist([p[0] - a[0], p[1] - a[1]], ab, nA, nB, chordOf(p));
  const nearEnd = [21.785, 4.082]; // the gate's pixel: 0.09 px outside the arc, 2.5 px from its end
  ok(
    chordOf(nearEnd) / px > 1.5 && D(nearEnd) / px < 0.2,
    `a pixel just outside the arc near its end: ${(chordOf(nearEnd) / px).toFixed(2)} px from the chord (gated), ${(D(nearEnd) / px).toFixed(3)} px from the arc's triangle`,
  );
  const r = 17.91,
    past = [22 + r * Math.sin(0.02), 22 - r * Math.cos(0.02)]; // on the circle, 0.36 em past the end
  ok(
    D(past) / px > 1.5,
    `the implicit's continuation 4 px past the arc's end still reads ${(D(past) / px).toFixed(2)} px away (the gate keeps its purpose)`,
  );
  let worst = -Infinity,
    s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let i = 0; i < 20000; i++) {
    const p = [-5 + 55 * rnd(), -5 + 55 * rnd()];
    worst = Math.max(worst, D(p) - chordOf(p));
  }
  ok(
    worst <= 1e-12,
    `over 20,000 points the triangle is never further than the chord (worst excess ${worst.toExponential(2)})`,
  );
}

// ---- the model and the shipped GLSL agree on what the gate measures ----------------------------------
{
  const G = readFileSync(path.join(ROOT, 'src/shaders/_lbCoverage.glsl'), 'utf8');
  const gate = G.slice(
    G.indexOf('Counter-hole chord ribbons'),
    G.indexOf('Counter-hole chord ribbons') + 2000,
  );
  ok(
    /float lbTangentTriDist\(vec2 p, vec2 ab, vec2 nA, vec2 nB, float chordD\)/.test(G),
    '_lbCoverage.glsl defines lbTangentTriDist',
  );
  ok(
    /lbTangentTriDist\(rA, ab, nOA, nOB, length\(rA - ab \* t\)\)/.test(gate),
    "the ribbon gate measures through it, from the piece's own end normals",
  );
  const gen = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  ok(
    gen.includes('lbTangentTriDist(rA, ab, nOA, nOB,'),
    'and the generated fill shader carries it (npm run build:shaders)',
  );
}

console.warn = warn;
console.log(fail ? `lbRibbonGateSmoke FAIL (${fail})` : 'lbRibbonGateSmoke PASS');
process.exit(fail ? 1 : 0);
