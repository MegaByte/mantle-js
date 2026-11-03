// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRingReachSmoke — a static Loop-Blinn ring reaches every pixel whose box meets its hull edge, and is bounded exactly
// there.
//
// A QUARTER-PIXEL RING IS NOT ENOUGH. Both exterior rings, the Bezout crescent's (kind 4) and the klm crescent's curve
// band (kind 12), are pushed along the edge normal. A pixel's box filter reaches sqrt(2)/2 px on a diagonal, so with a
// fixed LB_BEZ_RING / LB_KLM_RING = 0.25 px push a pixel whose center sits 0.25 to 0.71 px past the hull edge has no
// fragment at all and its antialiasing is dropped. The reach is DERIVED, the box's
// support along the edge normal, 0.5 (|w.x| + |w.y|) with w the normal carried into pixel space (lbBoxReach). A wider
// ring reaches pixels the arc does not, so each ring fragment is bounded by the box's share of an exact half-plane that
// holds its arc: the klm ring by the arc's support along its normal (packed in the seam slot), the Bezout ring by the
// hull edge it grows from with the keep plane, the quad band by its arc's end tangents (convex) or chord (concave).
//
// AND A REFLEX CORNER'S NEIGHBOR IS NOT A whole HALF-PLANE. Added to a curve band's union corner as the half-plane of
// its line, which runs back past the shared vertex over the own arc, a near-tangent neighbor would paint the gap
// between the own arc and its hull edge. The neighbor's boundary starts at the vertex, so its region is taken on its
// own side of its span-start line (exactBoxCov3).
//
// Morph draws keep the quarter-pixel klm rings and no bound (the morph program's bound would need both poses' support); a
// QUAD band on a morph draw takes the reach and mode 2 as a static one does (its end data is lerped with it).
import { readFileSync } from 'fs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const REF = await import('../probes/lbAccuracy/_lbAaRef.mjs');
const K = await import('../probes/lbAccuracy/_lbKernel.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const src = (f) => readFileSync(new URL(`../src/shaders/${f}`, import.meta.url), 'utf8');
const svg = (d, vb) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path d="${d}" fill="#000"/></svg>`;

/// Which preprocessor branch each line sits in: the innermost #ifdef/#ifndef and whether it is past its #else.
function branchAt(text) {
  const out = [],
    st = [];
  for (const ln of text.split('\n')) {
    const m = ln.match(/^\s*#\s*(ifdef|ifndef|if|else|elif|endif)\b\s*(\w*)/);
    if (m) {
      if (m[1] === 'endif') st.pop();
      else if (m[1] === 'else' || m[1] === 'elif') {
        if (st.length) st[st.length - 1].els = true;
      } else st.push({ kw: m[1], mac: m[2], els: false });
    }
    out.push({ ln, top: st.length ? { ...st[st.length - 1] } : null });
  }
  return out;
}
const inMorph = (b) =>
  b.top && b.top.mac === 'MANTLE_LB_MORPH' && (b.top.kw === 'ifdef') !== b.top.els;

{
  console.log("-- the vertex stage pushes the static rings by the box filter's reach");
  const vs = src('_lbVertexSetup.glsl'),
    lines = branchAt(vs);
  ok(
    /float\s+lbBoxReach\(\s*vec2\s+n\s*,\s*float\s+basePx\s*\)/.test(vs) &&
      /return\s+0\.5\s*\*\s*basePx\s*\*\s*\(\s*abs\(n\.x\)\s*\+\s*abs\(n\.y\)\s*\)/.test(vs) &&
      /transpose\(\s*inverse\(\s*C\s*\)\s*\)\s*\*\s*n/.test(vs),
    "_lbVertexSetup.glsl defines lbBoxReach as the box's support along the normal",
  );
  const uses = lines.filter((b) => /\bLB_(BEZ|KLM)_RING\b/.test(b.ln) && !/^\s*#/.test(b.ln));
  ok(
    uses.length > 0 && uses.every(inMorph),
    `the quarter-pixel ring constants are read only by the morph program (${uses.length} uses)`,
  );
  const reach = lines.filter((b) =>
    /lbBoxReach\(\s*u4\s*,\s*basePx\s*\)|lbBandReach\(\s*aC0\.xy\s*,\s*basePx\s*\)/.test(b.ln),
  );
  ok(
    reach.length === 3 &&
      reach.filter((b) => !inMorph(b)).length === 2 &&
      reach.filter(inMorph).length === 1,
    'the Bezout ring and the curve band both take lbBoxReach on the static program, and a quad band on the morph program',
  );

  // THE REACH IS THE BOX'S SUPPORT under any em -> pixel map: the ring's far edge passes the farthest corner of a box
  // whose center sits on it, for a sheared, mirrored, anisotropic world matrix as for none. The shader's formula,
  // line for line, against the four corners.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const lbBoxReach = (n, basePx, Wm) => {
    if (!Wm) return 0.5 * basePx * (Math.abs(n[0]) + Math.abs(n[1]));
    // C = (Fy W Fy) / basePx, the em -> pixel map; w = C^-T n.
    const c00 = Wm[0] / basePx,
      c01 = -Wm[2] / basePx,
      c10 = -Wm[1] / basePx,
      c11 = Wm[3] / basePx; // rows of C
    const det = c00 * c11 - c01 * c10,
      i00 = c11 / det,
      i01 = -c01 / det,
      i10 = -c10 / det,
      i11 = c00 / det;
    const w = [i00 * n[0] + i10 * n[1], i01 * n[0] + i11 * n[1]];
    return 0.5 * (Math.abs(w[0]) + Math.abs(w[1]));
  };
  let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const th = rnd() * 2 * Math.PI,
      n = [Math.cos(th), Math.sin(th)],
      basePx = Math.exp((rnd() - 0.5) * 16);
    const Wm = i % 4 === 0 ? null : [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2]; // column-major 2x2
    if (Wm && Math.abs(Wm[0] * Wm[3] - Wm[1] * Wm[2]) < 0.05) continue;
    // pixel -> em: the inverse of C, applied to each box corner; the support is the largest n . corner.
    const c00 = Wm ? Wm[0] / basePx : 1 / basePx,
      c01 = Wm ? -Wm[2] / basePx : 0,
      c10 = Wm ? -Wm[1] / basePx : 0,
      c11 = Wm ? Wm[3] / basePx : 1 / basePx;
    const det = c00 * c11 - c01 * c10;
    let sup = -Infinity;
    for (const [u, v] of [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ]) {
      const ex = (c11 * u - c01 * v) / det,
        ey = (-c10 * u + c00 * v) / det;
      sup = Math.max(sup, n[0] * ex + n[1] * ey);
    }
    worst = Math.max(worst, Math.abs(lbBoxReach(n, basePx, Wm) - sup) / sup);
  }
  ok(
    worst < 1e-12,
    `the reach is the pixel box's support along the ring normal under 3000 random maps (worst relative ${worst.toExponential(1)})`,
  );

  // A CURVE BAND'S PUSH IS NOT ITS NORMAL. A fat ring's end pushes n +- t and a hull box's corner (+-1, +-1), so the reach
  // taken along the push's own direction is the wrong one: at a 45-degree edge n + t is axis-aligned and read half a pixel
  // where the edge needs sqrt(2)/2. lbBandReach takes the larger of the push's two candidate normals.
  ok(
    /float\s+lbBandReach\(\s*vec2\s+v\s*,\s*float\s+basePx\s*\)/.test(vs) &&
      typeof K.bandReach === 'function',
    '_lbVertexSetup.glsl reaches a band push by lbBandReach, and the twin mirrors it (bandReach)',
  );
  if (typeof K.bandReach === 'function') {
    let short = 0,
      over = 0,
      n45 = 0;
    for (let i = 0; i < 2000; i++) {
      const th = rnd() * 2 * Math.PI,
        n = [Math.cos(th), Math.sin(th)],
        t = [-n[1], n[0]];
      for (const sg of [-1, 0, 1]) {
        const v = [n[0] + sg * t[0], n[1] + sg * t[1]],
          need = K.boxSupport(n),
          got = K.bandReach(v); // n . v = 1: got IS the reach along n
        if (got < need - 1e-12) short++;
        // A unit push can round to |v| = 1 + ulp, which leans it sqrt(2 ulp) off n: over by that much, never short.
        if (got > need + 1e-6) over++;
        if (Math.abs(Math.abs(Math.cos(th)) - Math.SQRT1_2) < 0.01 && sg !== 0) n45++;
      }
    }
    ok(
      short === 0 && over === 0 && n45 > 0,
      `every band push reaches exactly the box's support along its edge normal (${short} short, ${over} over; ${n45} flared pushes at 45 degrees)`,
    );
  }
}

{
  console.log("-- each ring fragment is bounded by the box's share of an exact half-plane");
  const fs = src('_lbCoverage.glsl');
  ok(
    /c12c\s*=\s*min\(\s*curveCov\([^;]*\)\s*,\s*bound12\s*\)/.test(fs) &&
      /cOwn12\s*=\s*min\(\s*exactBoxCov\(\s*nOwn12\s*,\s*dOwn12\s*\)\s*,\s*bound12\s*\)/.test(fs),
    'the curve band clamps both its crescent and its own-edge coverage to bound12',
  );
  ok(
    /lbHalfPlanesBoxCov2\(\s*vTC\.xy\s*,\s*vTC\.z\s*,\s*u4f\s*,\s*vEmPerPx/.test(fs),
    'the Bezout ring takes the keep plane and its hull edge together',
  );
  // The bound helpers are the box's share under any affine em -> pixel map: against a 64 x 64 supersample.
  ok(
    typeof K.lbHalfPlanesBoxCov2 === 'function',
    'the kernel twin exports the two-plane bound (lbHalfPlanesBoxCov2)',
  );
  if (typeof K.lbHalfPlanesBoxCov2 === 'function') {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    let worst = 0,
      part = 0;
    for (let i = 0; i < 1500; i++) {
      const sc = Math.exp((rnd() - 0.5) * 10),
        sk = (rnd() - 0.5) * 1.5,
        fl = rnd() < 0.5 ? -1 : 1;
      const emx = [sc, sk * sc],
        emy = [0.3 * sk * sc, fl * sc * (0.5 + rnd())],
        em = [rnd() * 10 - 5, rnd() * 10 - 5];
      const pl = () => {
        const th = rnd() * 2 * Math.PI,
          n = [Math.cos(th), Math.sin(th)];
        const r =
          0.5 * (Math.abs(n[0] * emx[0] + n[1] * emx[1]) + Math.abs(n[0] * emy[0] + n[1] * emy[1]));
        return [n, n[0] * em[0] + n[1] * em[1] + r * (rnd() * 3 - 1.5)];
      };
      const [n1, c1] = pl(),
        [n2, c2] = pl();
      const k = K.lbHalfPlanesBoxCov2(n1, c1, n2, c2, em, emx, emy);
      let a = 0;
      const S = 64;
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const u = (x + 0.5) / S - 0.5,
            v = (y + 0.5) / S - 0.5,
            p = [em[0] + u * emx[0] + v * emy[0], em[1] + u * emx[1] + v * emy[1]];
          if (n1[0] * p[0] + n1[1] * p[1] <= c1 && n2[0] * p[0] + n2[1] * p[1] <= c2) a++;
        }
      if (k > 0 && k < 1) part++;
      worst = Math.max(worst, Math.abs(a / (S * S) - k));
    }
    ok(
      worst < 2 / 64 && part > 200,
      `two half-planes' box share is exact (worst ${worst.toFixed(4)} from a 64 x 64 supersample, ${part} partial)`,
    );
  }
}

async function audit(text, N, opt) {
  const bundle = await importSvg(text);
  const { shapes, bbox } = await R.shapesOf(bundle);
  const view = R.viewOf(bbox, N);
  const { rowSpans, contoursToConverter, closed } = await REF.refKit();
  let unreached = 0,
    stray = 0,
    under = 0,
    err = 0,
    built = 0;
  for (const sh of shapes) {
    const b = await R.buildMesh(sh);
    if (!b) continue;
    built++;
    const acc = new Float64Array(N * N).fill(1);
    R.rasterMesh(
      b.pk,
      view,
      acc,
      opt,
      new Int32Array(N * N),
      new Int32Array(N * N).fill(-1),
      new Float64Array(N * N),
    );
    const curves = closed(contoursToConverter(sh.contours, null));
    for (let j = 0; j < N; j++) {
      const rc = new Map();
      for (let i = 0; i < N; i++) {
        const ex = REF.exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, rc),
          mo = 1 - acc[j * N + i];
        err += Math.abs(mo - ex);
        if (ex > 0.02 && mo === 0) unreached++;
        if (ex === 0 && mo > 0) stray += mo;
        if (ex > mo) under += ex - mo;
      }
    }
  }
  return { built, unreached, stray, under, err };
}

{
  console.log(
    '-- a smooth cubic blob: every antialiased pixel is reached, and none loses ink to the bound',
  );
  const blob = svg(
    'M162 100C169.31 136.44 174.04 139.17 131 153.69C103.1 178.25 103.1 183.7 69 153.69C33.79 141.81 29.06 144.54 38 100' +
      'C30.69 63.56 25.96 60.83 69 46.31C96.9 21.75 96.9 16.3 131 46.31C166.21 58.19 170.94 55.46 162 100Z',
    '0 0 200 200',
  );
  for (const N of [32, 64, 128]) {
    const q = await audit(blob, N, { legacyRing: true }),
      d = await audit(blob, N, {});
    ok(
      d.built === 1 &&
        q.unreached > 0 &&
        d.unreached === 0 &&
        d.under <= q.under + 1e-9 &&
        d.err < q.err,
      `${N} px: pixels with coverage and no fragment ${q.unreached} -> ${d.unreached}; ink lost ${q.under.toFixed(3)} -> ${d.under.toFixed(3)} px^2; ` +
        `error ${q.err.toFixed(2)} -> ${d.err.toFixed(2)} px^2 (quarter-pixel ring -> derived)`,
    );
  }
}

{
  console.log(
    "-- a reflex corner between two quadratics: the neighbor's region starts at the shared vertex",
  );
  // A scale motif: a quadratic meets the next at a slight reflex turn, and the next bends back the other way.
  // The first one's line, extended past the vertex, runs through the second one's exterior band.
  const tr = svg('M288 45Q271 91 220 125Q150 180 50 180L50 20L288 20Z', '0 0 340 340');
  for (const N of [32, 64, 128]) {
    const d = await audit(tr, N, {});
    // Zero up to the reference's own resolution: it integrates 64 slices a pixel, so a pixel it reads empty can hold
    // ink under a sixty-fourth of a slice. The unrestricted neighbor painted 0.14 to 0.54 px^2 here.
    ok(
      d.built === 1 && d.stray < 1e-3,
      `${N} px: ink painted where the exact coverage is zero ${d.stray.toExponential(2)} px^2`,
    );
  }
  const fs = src('_lbCoverage.glsl');
  // The span-start line is built in EM from the neighbor's unit normal and mapped into the window frame through the em
  // derivatives, as every em plane of the band is: its window normal nF and offset dF.
  ok(
    ['A', 'B'].every((X) =>
      new RegExp(
        `if\\s*\\(\\s*ty${X}\\s*<\\s*0\\.0\\s*\\)\\s*\\{[^}]*gF${X}12\\s*=\\s*vec2\\(\\s*dot\\(\\s*sN${X}12\\s*,\\s*emx12\\s*\\)\\s*,\\s*dot\\(\\s*sN${X}12\\s*,\\s*emy12\\s*\\)\\s*\\)` +
          `[^}]*c${X}12\\s*=\\s*exactBoxCov2\\(\\s*n${X}n12\\s*,\\s*d${X}12\\s*,\\s*nF${X}12\\s*,\\s*dF${X}12\\s*\\)` +
          `[^}]*inter${X}12\\s*=\\s*min\\(\\s*exactBoxCov3\\(\\s*nOwn12\\s*,\\s*dOwn12\\s*,\\s*n${X}n12\\s*,\\s*d${X}12\\s*,\\s*nF${X}12\\s*,\\s*dF${X}12\\s*\\)`,
      ).test(fs),
    ),
    "_lbCoverage.glsl restricts both ends' union neighbor to its own side of its span-start line, mapped to the window frame",
  );
}

console.warn = warn;
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
