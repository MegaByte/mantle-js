// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStaticChainSmoke — the static Loop-Blinn build's interior chain never lies inside the fill, a
// Bezout crescent's keep half-plane bounds its coverage by the box filter's own reach, and a chain edge's stored
// outside is its own piece's air side.
//
// The chain route clips an interior face's pixel box against a window of the outline polyline, and for a cubic piece a
// polyline a -> m -> b through the piece's on-curve midpoint is not enough. On a CONVEX piece (control points outside
// the fill) those two chords stand inside the arc by up to a quarter of the half-arcs' sagitta, and the interior then
// clips real ink wherever its chain reaches the arc: at every joint, where the crescent narrows to nothing and the
// interior owns the pixels. In a morph pair a piece convex at every t takes its CONTROL POLYGON, which holds the arc.
// The static build carries the ARC itself (the chords with their piece, cubicChainBoxCov), which holds no ink out and
// over-paints none; a control polygon over-paints where it stands off the arc (lbConvexArcSmoke).
//
// No GPU. The static build of unifiedMorphSmoke's solid morph at four poses, through test/_lbMorphDrawEmu.mjs on a
// 256 px canvas over the source's box: no pixel whose center is inside the fill loses more than 32/255 of its ink, and
// the convex pieces' faces carry their arcs. With the straight chords (`__LB_CUBIC_CHAIN = false`) the poses at
// t = 0.25 / 0.5 / 0.75 / 1 lose 2 / 3 / 2 / 1 such pixels.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const EMU = await import('./_lbMorphDrawEmu.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" fill="#3060c0"/></svg>`;
const contoursOf = async (d) => {
  const b = await importSvg(svg(d)),
    r = b.curveRangesByShape[0];
  return { c: curveRangeToContours(new Float32Array(b.curves), r.begin, r.end), bb: b.globalBBox };
};
const poseAt = (sc, dc, t) =>
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

// ── a convex piece's chain carries its arc ────────────────────────────────────────────────────
{
  console.log("-- unifiedMorphSmoke's solid morph, each pose built static");
  const A = await contoursOf(
    'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z',
  );
  const B = await contoursOf(
    'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z',
  );
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const pose = poseAt(A.c, B.c, t),
      b = buildLbShape(pose, false, false);
    const P = b && EMU.staticPacks(b.raw),
      s = P && EMU.scoreExact(EMU.render(P, A.bb).cov, pose, A.bb);
    let arcs = 0;
    for (let q = 0; P && q + 2 < P.n; q += 3)
      if (Math.round(P.S[(q + 2) * 24 + 5]) === 0 && P.S[(q + 2) * 24 + 2] > 3.5) arcs++;
    ok(
      !!s && s.lostIn <= 2 && s.off <= 12 && arcs > 0,
      `t = ${t}: ${s ? `${s.off} px off exact (over ${s.over}, lost inside ${s.lostIn}, lost outside ${s.lostOut})` : 'did not build'}; ` +
        `${arcs / 3} faces carry an arc; at most 2 lost inside, 12 off (the hull chain: 0 lost inside, 11 off at worst)`,
    );
  }
}

// ── the Bezout keep half-plane bounds coverage by the box filter's own reach ────────────────────
// The ink of a Bezout crescent lies in its keep half-plane g = m . em - c <= 0, so a pixel holds at most the part of its
// box the half-plane covers. The kernel clamps the crescent to that part and cuts the fragment where it is zero. Checked
// on the kernel's CPU twin against the definition -- the four corners of the pixel box under the em -> pixel map, and
// the area by supersampling -- for planes of every direction and length under skewed, scaled and mirrored maps; and the
// shader's own text is checked to compute the same thing. A constant quarter-pixel fence along a unit normal would cut
// every pixel whose center sits 0.25 to 0.71 px past the arc's extreme.
{
  console.log("-- the keep half-plane's bound is the pixel box's share of it");
  const TWIN = await import('../probes/lbAccuracy/_lbKernel.mjs');
  const keepCov = TWIN.bezKeepCov;
  ok(typeof keepCov === 'function', 'the kernel twin exports its keep-plane bound (bezKeepCov)');
  if (typeof keepCov === 'function') {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    let cutWrong = 0,
      areaWorst = 0,
      n = 0,
      cutN = 0,
      partN = 0;
    for (let i = 0; i < 4000; i++) {
      const th = rnd() * 2 * Math.PI,
        len = Math.exp((rnd() - 0.5) * 8),
        m = [Math.cos(th) * len, Math.sin(th) * len];
      const sc = Math.exp((rnd() - 0.5) * 12),
        sk = (rnd() - 0.5) * 1.5,
        fl = rnd() < 0.5 ? -1 : 1; // em per px, skew, mirror
      const emx = [sc, sk * sc],
        emy = [0.3 * sk * sc, fl * sc * (0.5 + rnd())];
      const em = [rnd() * 10 - 5, rnd() * 10 - 5],
        reach =
          0.5 * (Math.abs(m[0] * emx[0] + m[1] * emx[1]) + Math.abs(m[0] * emy[0] + m[1] * emy[1]));
      const c = m[0] * em[0] + m[1] * em[1] - reach * (rnd() * 3 - 1.5); // pixel centers -1.5 to 1.5 reaches past the plane
      const g = (u, v) =>
        m[0] * (em[0] + u * emx[0] + v * emy[0]) + m[1] * (em[1] + u * emx[1] + v * emy[1]) - c;
      const misses = [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ].every(([u, v]) => g(u, v) > 0);
      const k = keepCov(m, c, em, emx, emy);
      if (k <= 0 !== misses) cutWrong++;
      if (k <= 0) cutN++;
      else if (k < 1) partN++;
      let a = 0;
      const S = 64;
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) if (g((x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5) <= 0) a++;
      areaWorst = Math.max(areaWorst, Math.abs(a / (S * S) - k));
      n++;
    }
    ok(
      cutWrong === 0 && cutN > 0 && partN > 0,
      `the fragment is cut exactly where its pixel box misses the half-plane (${cutWrong} of ${n} wrong; ${cutN} cut, ${partN} partial)`,
    );
    ok(
      areaWorst < 2 / 64,
      `the bound is the box's share of the half-plane (worst ${areaWorst.toFixed(4)} from a 64 x 64 supersample)`,
    );
  }
  // THE SHADER'S TEXT: the Bezout branch reads the plane's slope per pixel from the em derivatives and takes exactBoxCov's
  // share, and the curve's coverage is clamped to it.
  const { readFileSync } = await import('fs');
  const glsl = readFileSync(new URL('../src/shaders/_lbCoverage.glsl', import.meta.url), 'utf8');
  // (Through lbHalfPlaneBoxCov, which reads the slope as d = (n . emx, n . emy) and decides a box wholly inside or outside
  // before it normalizes, for cost.)
  ok(
    /float\s+lbHalfPlaneBoxCov\(\s*vec2 n\s*,\s*float c\s*,\s*vec2 emx\s*,\s*vec2 emy\s*\)\s*\{[^}]*vec2\s+d\s*=\s*vec2\(\s*dot\(\s*n\s*,\s*emx\s*\)\s*,\s*dot\(\s*n\s*,\s*emy\s*\)\s*\)[^}]*exactBoxCov\(\s*d\s*\/\s*L\s*,\s*-g\s*\/\s*L\s*\)/.test(
      glsl,
    ) &&
      /if\s*\(\s*keepOn4\s*\)\s*keep4\s*=\s*lbHalfPlaneBoxCov\(\s*vTC\.xy\s*,\s*vTC\.z\s*,\s*emxT\s*,\s*emyT\s*\)/.test(
        glsl,
      ) &&
      /cov\s*=\s*min\(\s*curveCov\(f,\s*fx4[^;]*,\s*keep4\s*\)/.test(glsl) &&
      !/LB_BEZ_FENCE/.test(glsl),
    '_lbCoverage.glsl bounds the Bezout crescent by the same share, with no constant release',
  );
}

// ── a chain edge's outside is its own piece's air side ─────────────────────────────────────────
// Each chain edge stores an outward normal, which interiorChainsFromTris reads when the asking face's centroid is on the
// edge's line and cannot orient it. ONE sign for the whole outline, from a shoelace over the cubic pieces' endpoints --
// an open chain wherever the outline has lines or quads, and weighted by fan triangles -- would answer by where the
// origin is, so each edge's normal is its own piece's. Every cubic piece's chain edges are checked here against the fill rule's exact
// winding a hair off the piece's own arc, on either side of its midpoint, at a thousandth and a hundredth of its chord
// (a piece where the two distances disagree on either side sits beside a feature thinner than the probe, and is
// skipped). With one whole-outline sign, a dome whose outline has lines stores all 12 of its edges' normals pointing
// into the ink, and its dish all 4.
{
  console.log("-- every cubic chain edge's outside is its piece's air side");
  const { tigerOrFixture } = await import('./_tigerOrFixture.mjs');
  const LC = await import('../src/geom/lbContour.js');
  const { rayWinding, lbFrameOrigin, translateContours } = LC;
  const { parseMetaBin } = await import('../src/core/metaBin.js');
  const B3 = (P, t) => {
    const u = 1 - t;
    return [0, 1].map(
      (k) =>
        u * u * u * P[0][k] +
        3 * u * u * t * P[1][k] +
        3 * u * t * t * P[2][k] +
        t * t * t * P[3][k],
    );
  };
  const D3 = (P, t) => {
    const u = 1 - t;
    return [0, 1].map(
      (k) =>
        3 *
        (u * u * (P[1][k] - P[0][k]) +
          2 * u * t * (P[2][k] - P[1][k]) +
          t * t * (P[3][k] - P[2][k])),
    );
  };
  let dumped = [];
  globalThis.__LB_CHAINEDGEDUMP = (d) => dumped.push(d);
  const check = async (name, svgText, every = 1) => {
    const bun = await importSvg(svgText),
      pm = parseMetaBin(bun.meta, bun.metaFloatsPerShape),
      mst = pm.floatsPerShape,
      meta = pm.metaFloats;
    const cf = new Float32Array(bun.curves);
    let pieces = 0,
      edges = 0,
      wrong = 0,
      skipped = 0,
      fine = 0;
    for (let s = 0; s < bun.numShapes; s += every) {
      const r = bun.curveRangesByShape[s];
      let C;
      try {
        C = curveRangeToContours(cf, r.begin, r.end);
      } catch {
        continue;
      }
      // buildLbShape builds in the shape's own frame, so the pieces it reports are in that frame too.
      // The builder fills a row's contours CLOSED, so its sides are read against the closed path.
      const Cc = LC.closeOpenContours ? LC.closeOpenContours(C) : C;
      const o = lbFrameOrigin(C),
        eo = meta[s * mst + 13] > 0.5,
        segs = (o ? translateContours(Cc, -o[0], -o[1]) : Cc).flat();
      dumped = [];
      try {
        buildLbShape(C, false, eo);
      } catch {
        continue;
      }
      // THE BUILDER'S PROBE HAS A RESOLUTION. Its ink test casts from the probe point nudged 1e-5 of the shape's extent
      // along +y, and probes 0.01 of the piece's chord off the arc, so on a piece under a thousandth of its shape the
      // nudge is the larger and the probe can read the far side of its own arc -- which misreads the crescent's sign
      // too. Those pieces are counted, not scored: that probe is its own question.
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const g of segs)
        for (const q of [g.p1, g.p2, g.p3, g.p4])
          if (q) {
            x0 = Math.min(x0, q[0]);
            x1 = Math.max(x1, q[0]);
            y0 = Math.min(y0, q[1]);
            y1 = Math.max(y1, q[1]);
          }
      const nudge = 1e-5 * Math.max(x1 - x0, y1 - y0);
      for (const { cp, edges: es } of dumped) {
        if (!es.length) continue;
        const m = B3(cp, 0.5),
          T = D3(cp, 0.5),
          L = Math.hypot(T[0], T[1]),
          ch = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]);
        if (!(L > 0) || !(ch > 0)) continue;
        if (0.01 * ch <= nudge) {
          fine++;
          continue;
        }
        const inkAt = (f) => {
          const w = rayWinding(segs, m[0] - (T[1] / L) * f * ch, m[1] + (T[0] / L) * f * ch);
          return eo ? (w & 1) === 1 : w !== 0;
        };
        const inkLeft = inkAt(1e-3),
          inkRight = inkAt(-1e-3);
        if (inkLeft !== inkAt(1e-2) || inkRight !== inkAt(-1e-2) || inkLeft === inkRight) {
          skipped++;
          continue;
        }
        pieces++;
        for (const e of es) {
          edges++;
          const dx = e.p2[0] - e.p1[0],
            dy = e.p2[1] - e.p1[1];
          if (dx * e.ny - dy * e.nx > 0 !== !inkLeft) wrong++; // the normal points left exactly when the air is on the left
        }
      }
    }
    ok(
      pieces > 0 && wrong === 0,
      `${name}: ${wrong} of ${edges} chain edges on ${pieces} cubic pieces point their outside into the ink ` +
        `(${skipped} pieces beside a feature too thin to probe, ${fine} below the builder's probe resolution)`,
    );
  };
  await check(
    'a dome (lines and a cubic)',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z"/></svg>`,
  );
  await check(
    'its dish',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z"/></svg>`,
  );
  await check('tiger, every fourth shape', tigerOrFixture(), 4);
  delete globalThis.__LB_CHAINEDGEDUMP;
}

console.warn = warn;
console.log(fail ? `LB-STATIC-CHAIN FAIL (${fail})` : 'LB-STATIC-CHAIN PASS');
process.exit(fail ? 1 : 0);
