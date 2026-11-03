// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBezRingArcSmoke — a Bezout ring carries its piece's ARC, and its coverage is the box's exact share of the arc's ink
// side (the stray remainder).
//
// THE STRAY REMAINDER IS THE RESULTANT'S SECOND BRANCH. A ring that reaches the box filter's own distance can reach a
// zero of the resultant the Bezier never traces, running alongside the arc, and paint stray ink there. The exact bound
// from what a ring vertex carries otherwise (the keep plane and the hull edge) does not exclude it; bounding the pixel by
// the arc itself needs the arc's eight floats.
//
// NO FETCH IS NEEDED FOR THEM. The resultant is 15 of a Bezout vertex's slots and the arc is 8, and a ring fragment
// with its arc has no use for the resultant at all: the box's exact share of the ink side of the arc (continued along
// its end tangents) is what the cubic chain kernel computes. So a ring vertex whose piece the builder knows -- its control
// points and which side is ink -- carries the arc in aC0 / aC1, fill-left, marked aSeamM = 10. On tiger at 512 px, in
// the twin, that halves the stray ink. The TEST HOOK __LB_BEZ_RING_ARC = false (under __MANTLE_DEBUG__) keeps the resultant.
//
// And transformLoopBlinnRaw carries the ink side and the Bezout KEEP half-plane through its similarity: without the keep
// plane a crescent reached through the canonical cache would pack no fence where a cache miss fences it.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const REF = await import('../probes/lbAccuracy/_lbAaRef.mjs');
const { transformLoopBlinnRaw, LB_VERT_FLOATS: VF } = await import('../src/renderer/lbPack.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const src = (f) => readFileSync(path.join(ROOT, 'src/shaders', f), 'utf8');
/// Build with the arc ring on (the default) or off (the TEST HOOK, which is read at pack time, inside the build).
const withArc = async (on, fn) => {
  globalThis.__MANTLE_DEBUG__ = true;
  if (!on) globalThis.__LB_BEZ_RING_ARC = false;
  try {
    return await fn();
  } finally {
    delete globalThis.__LB_BEZ_RING_ARC;
    delete globalThis.__MANTLE_DEBUG__;
  }
};

{
  console.log('-- the shader reads a ring that carries its arc');
  const fs = src('_lbCoverage.glsl'),
    vs = src('_lbVertexSetup.glsl');
  ok(
    /if \(vSeam > 9\.5\) \{[\s\S]{0,400}cubicChainBoxCov\(lbChainCell\(vLB0\.xy[\s\S]{0,300}false, 0\.0\)/.test(
      fs,
    ),
    "_lbCoverage.glsl: a kind-4 fragment with vSeam 10 takes the box's exact share of its arc (cubicChainBoxCov)",
  );
  ok(
    /if \(aSeamM > 9\.5\) vEmPerPx = emPerPxFor\(vec2\(0\.0\), basePx\);/.test(vs),
    '_lbVertexSetup.glsl: ...mapped into the pixel cell at the directionless scale',
  );
}

const TIGER = path.join(ROOT, 'examples/tiger.svg');
if (!existsSync(TIGER)) {
  console.log('  SKIP examples/tiger.svg is absent');
} else {
  const bundle = await R.loadSvg(TIGER);
  const { shapes, bbox } = await R.shapesOf(bundle);
  const N = 512,
    view = R.viewOf(bbox, N);
  const { rowSpans, contoursToConverter, closed } = await REF.refKit();

  console.log('-- the pack: every Bezout ring vertex whose piece is known carries it, fill-left');
  {
    const sh = shapes.find((s) => s.s === 145);
    const b = await withArc(true, () => R.buildMesh(sh));
    const raw = b.raw,
      pk = b.pk,
      v = pk.verts;
    const arcs = new Set();
    // (a static klm piece's ring carries its arc too)
    for (const c of raw.cubics || [])
      if (c.cp && c.inkLeft != null) {
        const W = c.inkLeft ? c.cp : [c.cp[3], c.cp[2], c.cp[1], c.cp[0]];
        arcs.add(W.map((q) => [Math.fround(q[0]), Math.fround(q[1])].join(',')).join('|'));
      }
    let rings = 0,
      carried = 0,
      matched = 0;
    for (let i = 0; i < pk.vertexCount; i++) {
      const o = i * VF;
      if (Math.round(v[o + 5]) !== 4 || v[o + 23] < 5) continue;
      rings++;
      if (v[o + 23] > 9.5) {
        carried++;
        const key = [0, 1, 2, 3]
          .map((q) => [v[o + 7 + 2 * q], v[o + 8 + 2 * q]].join(','))
          .join('|');
        if (arcs.has(key)) matched++;
      }
    }
    const off = (await withArc(false, () => R.buildMesh(sh))).pk;
    let offArc = 0;
    for (let i = 0; i < off.vertexCount; i++)
      if (Math.round(off.verts[i * VF + 5]) === 4 && off.verts[i * VF + 23] > 9.5) offArc++;
    ok(
      rings > 0 && carried === rings && matched === rings && offArc === 0,
      `tiger #145: ${carried} of ${rings} Bezout ring vertices carry an arc, ${matched} of them their own piece's, fill-left; the hook off packs ${offArc}`,
    );
  }

  console.log('-- the picture, in the twin (512 px, filled shapes)');
  for (const s of [132, 145]) {
    const sh = shapes.find((q) => q.s === s);
    const curves = closed(contoursToConverter(sh.contours, null));
    const score = async (on) => {
      const b = await withArc(on, () => R.buildMesh(sh));
      const acc = new Float64Array(N * N).fill(1);
      R.rasterMesh(
        b.pk,
        view,
        acc,
        {},
        new Int32Array(N * N),
        new Int32Array(N * N).fill(-1),
        new Float64Array(N * N),
      );
      let stray = 0,
        off = 0,
        lostIn = 0;
      for (let j = 0; j < N; j++) {
        const rc = new Map(),
          row = rowSpans(curves, view.oy + (j + 0.5) * view.basePx, sh.evenOdd);
        for (let i = 0; i < N; i++) {
          const mo = 1 - acc[j * N + i];
          if (
            !(mo > 1e-6) &&
            acc[j * N + i] === 1 &&
            !row.some(
              (q) =>
                view.ox + (i + 0.5) * view.basePx >= q[0] - 2 * view.basePx &&
                view.ox + (i + 0.5) * view.basePx < q[1] + 2 * view.basePx,
            )
          )
            continue;
          const ex = REF.exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, rc),
            d = mo - ex;
          if (ex <= 1e-6 && mo > 0) stray += mo;
          if (Math.abs(d) > 32 / 255) {
            off++;
            const cx = view.ox + (i + 0.5) * view.basePx;
            if (d < 0 && row.some((q) => cx >= q[0] && cx < q[1])) lostIn++;
          }
        }
      }
      return { stray, off, lostIn };
    };
    const a = await score(false),
      c = await score(true);
    ok(
      c.stray < a.stray && c.off < a.off && c.lostIn <= a.lostIn,
      `tiger #${s}: stray ${a.stray.toFixed(2)} -> ${c.stray.toFixed(2)} px^2, off by > 32/255 ${a.off} -> ${c.off}, lost inside ${a.lostIn} -> ${c.lostIn} (resultant ring -> arc ring)`,
    );
  }

  console.log('-- the similarity cache keeps the ink side and the keep half-plane');
  {
    const sh = shapes.find((q) => q.s === 145);
    const raw = (await R.buildMesh(sh)).raw;
    const M = { s: 1.75, cos: Math.cos(0.7), sin: Math.sin(0.7), dx: 31.5, dy: -12.25 };
    const T = transformLoopBlinnRaw(raw, M);
    let n = 0,
      keptSide = 0,
      fenced = 0,
      worst = 0;
    raw.cubics.forEach((c, i) => {
      if (c.klmn || !c.keep || !c.cp) return;
      n++;
      const t = T.cubics[i];
      if (t.inkLeft === c.inkLeft) keptSide++;
      if (!t.keep) return;
      // The keep plane sits at its arc's support along its normal; transformed, it must still: the largest n . p over
      // the transformed arc, sampled, is the plane's offset (to the sampling's resolution) and never past it.
      let sup = -Infinity;
      for (let k = 0; k <= 1024; k++) {
        const u = k / 1024,
          w = [(1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3];
        const p = [0, 1].map((d) => w.reduce((acc, wj, j) => acc + wj * t.cp[j][d], 0));
        sup = Math.max(sup, t.keep[0] * p[0] + t.keep[1] * p[1]);
      }
      const chord = Math.hypot(t.cp[3][0] - t.cp[0][0], t.cp[3][1] - t.cp[0][1]) || 1;
      worst = Math.max(worst, Math.abs(sup - t.keep[2]) / chord);
      if (sup <= t.keep[2] + 1e-9 * chord) fenced++;
    });
    ok(
      n > 0 && keptSide === n && fenced === n && worst < 1e-5,
      `tiger #145 through a similarity: ${keptSide} of ${n} Bezout pieces keep their ink side, ${fenced} their keep plane, which still touches the arc (worst ${worst.toExponential(1)} of the chord)`,
    );
  }
}

console.warn = warn;
console.log(fail ? `LB-BEZ-RING-ARC FAIL (${fail})` : 'LB-BEZ-RING-ARC PASS');
process.exit(fail ? 1 : 0);
