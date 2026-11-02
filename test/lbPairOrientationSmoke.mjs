// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPairOrientationSmoke — no face of a Loop-Blinn morph pair turns inside out between its poses, at any scale
//.
//
// The pair cuts both poses of a cubic at every cut either pose's plan needs, and mergeCubicPlans9 may drop a cut whose
// piece fits inside one vertex quantum of both poses. The quantum is each pose's own (2^-16 of the shape), so a morph
// whose poses differ in size puts such a piece inside one pose's quantum and outside the other's. An S-curve whose
// inflection moves by 1.3e-4 in t, beside a square that grows a thousandfold: the piece between the two inflection cuts
// is 2.68 quanta on the source and 0.08 on the destination, and its sliver fan triangle can turn inside out at the
// destination (area 3.9e-2 -> -1.6e-5) -- a cubic face, which a flip check of other faces at one sampled t misses.
//
// So the pose that cannot tell the two cuts apart loses its own cut, and pairMidFlips decides every face -- interior,
// quad and cubic -- at every t, exactly: a lerped triangle's area is a quadratic in t.
//
// No GPU:
//   - the constructed morph builds a pair with no piece inside either pose's quantum and no face whose signed area
//     changes sign on [0, 1], at 2^-20, 1 and 2^20; so do three harder members of its family, which declined bulge-flip;
//   - pairMidFlips catches a face that is inside out only for t in (1/4, 1/3), and an inverted cubic face;
//   - over the morph corpus's synthetic pairs at the three scales, no face of any built pair changes sign.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const PAIR = await import('../src/renderer/lbPartitionPair.js');
const LC = await import('../src/geom/lbContour.js');
const { mkLine, mkCubic } = await import('../src/primitives/seg.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { synthPairs } = await import('../probes/morphScale/_morphPairs.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const area = (T, o) =>
  (T[o + 2] - T[o]) * (T[o + 5] - T[o + 1]) - (T[o + 3] - T[o + 1]) * (T[o + 4] - T[o]);
/// Does the face lerped from S to D (six floats at o) change the sign of its area on [0, 1]? Faces zero at an end are
/// counted apart: their sign is not defined there.
function turns(S, D, o) {
  const a0 = area(S, o),
    a1 = area(D, o);
  if (a0 === 0 || a1 === 0) return null;
  const M = [];
  for (let k = 0; k < 6; k++) M.push((S[o + k] + D[o + k]) / 2);
  const am = area(M, 0),
    c = 2 * (a0 + a1 - 2 * am),
    b = a1 - a0 - c;
  let lo = Math.min(a0, a1, am),
    hi = Math.max(a0, a1, am);
  const tv = c !== 0 ? -b / (2 * c) : -1;
  if (tv > 0 && tv < 1) {
    const v = a0 + tv * (b + tv * c);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return a0 > 0 ? lo <= 0 : hi >= 0;
}
function pairTurns(pr) {
  let n = 0,
    bad = 0;
  const each = (S, D) => {
    for (let o = 0; o + 5 < S.length && o + 5 < D.length; o += 6) {
      const r = turns(S, D, o);
      if (r !== null) {
        n++;
        if (r) bad++;
      }
    }
  };
  each(pr.src.interior, pr.dst.interior);
  pr.src.cubics.forEach((c, i) => each(c.hull, pr.dst.cubics[i].hull));
  pr.src.quads.forEach((q, i) => {
    if (q.tri && pr.dst.quads[i] && pr.dst.quads[i].tri) each(q.tri, pr.dst.quads[i].tri);
  });
  return { n, bad };
}
const ext = (cp) =>
  Math.max(
    ...[1, 2, 3].map((j) => Math.max(Math.abs(cp[j][0] - cp[0][0]), Math.abs(cp[j][1] - cp[0][1]))),
  );

// ── an S-curve whose inflection moves, beside a square that grows ─────────────────────────────────
{
  console.log(
    '-- an S-curve whose inflection moves 1.3e-4 in t, beside a square that grows a thousandfold',
  );
  const sq = (x, y, s) => [
    mkLine([x, y], [x + s, y]),
    mkLine([x + s, y], [x + s, y + s]),
    mkLine([x + s, y + s], [x, y + s]),
    mkLine([x, y + s], [x, y]),
  ];
  const shape = (p1x, big, k) => {
    const S = (p) => [p[0] * 2 ** k, p[1] * 2 ** k],
      C = (...a) => mkCubic(...a.map(S)),
      L = (a, b) => mkLine(S(a), S(b));
    return [
      [
        C([0, 0], [p1x, 100], [50, -100], [100, 0]),
        L([100, 0], [100, 150]),
        L([100, 150], [0, 150]),
        L([0, 150], [0, 0]),
      ],
      sq(300, 0, big).map((g) => mkLine(S(g.p1), S(g.p2))),
    ];
  };
  for (const [d, big] of [
    [0.1, 10000],
    [0.3, 30000],
    [0.05, 100000],
    [0.2, 100000],
  ]) {
    const rows = [];
    for (const k of [-20, 0, 20]) {
      const sc = shape(50, 10, k),
        dc = shape(50 + d, big, k);
      const pr = PAIR.buildLoopBlinnPartitionPair(sc, dc, 'nonzero');
      if (!pr) {
        rows.push({ k, why: PAIR.lbPairDeclineWhy });
        continue;
      }
      const qS = LC.emUnitsOf(sc).res,
        qD = LC.emUnitsOf(dc).res;
      let subQ = 0;
      pr.src.cubics.forEach((c, i) => {
        if ((c.cp && ext(c.cp) <= qS) || (pr.dst.cubics[i].cp && ext(pr.dst.cubics[i].cp) <= qD))
          subQ++;
      });
      rows.push({ k, subQ, ...pairTurns(pr) });
    }
    const good = rows.every((r) => !r.why && r.subQ === 0 && r.bad === 0 && r.n > 0);
    const same = rows.every((r) => r.n === rows[1].n && r.why === rows[1].why);
    ok(
      good && same,
      `P1.x + ${d}, square x${big / 10}: ${rows.map((r) => (r.why ? `2^${r.k} declined ${r.why}` : `2^${r.k} ${r.bad} of ${r.n} faces turn, ${r.subQ} sub-quantum pieces`)).join('; ')}`,
    );
  }
}

// ── pairMidFlips decides every face at every t ────────────────────────────────────────────────────
{
  console.log('-- pairMidFlips');
  // area(t) = 1 - 7 t + 12 t^2: positive at 0, 1/2 and 1, negative on (1/4, 1/3)
  const S = new Float32Array([0, 0, 1, 0, 0, 1]),
    D = new Float32Array([0, 0, 1, 1, -12, -6]);
  const none = new Float32Array(0),
    mesh = (I, cubics = []) => ({ interior: I, quads: [], cubics });
  ok(
    PAIR.pairMidFlips(mesh(S), mesh(D)) === true,
    'a face inside out only for t in (1/4, 1/3) is caught (t = 0, 1/2 and 1 all read it right side out)',
  );
  const H0 = new Float32Array([0, 0, 1, 0, 0, 1]),
    H1 = new Float32Array([0, 0, 1, 0, 0, -1]);
  ok(
    PAIR.pairMidFlips(mesh(none, [{ hull: H0 }]), mesh(none, [{ hull: H1 }])) === true,
    'an inverted cubic face is caught',
  );
  ok(
    PAIR.pairMidFlips(mesh(S, [{ hull: H0 }]), mesh(S, [{ hull: H0 }])) === false,
    '...and a still mesh is not',
  );
}

// ── the corpus's synthetic pairs, at three scales ─────────────────────────────────────────────────
{
  console.log("-- the morph corpus's synthetic pairs");
  const pairs = await synthPairs(importSvg, parseMetaBin, LC.curveRangeToContours);
  // every point and a circular arc's `circle` record: an unscaled record does not describe its arc
  const scale = (C, s) =>
    C.map((c) =>
      c.map((g) => ({
        ...g,
        p1: g.p1 && [g.p1[0] * s, g.p1[1] * s],
        p2: g.p2 && [g.p2[0] * s, g.p2[1] * s],
        p3: g.p3 && [g.p3[0] * s, g.p3[1] * s],
        p4: g.p4 && [g.p4[0] * s, g.p4[1] * s],
        ...(g.circle
          ? { circle: { ...g.circle, cx: g.circle.cx * s, cy: g.circle.cy * s, r: g.circle.r * s } }
          : {}),
      })),
    );
  const per = [];
  for (const k of [-20, 0, 20]) {
    let built = 0,
      n = 0,
      bad = 0;
    for (const p of pairs) {
      let pr = null;
      try {
        pr = PAIR.buildLoopBlinnPartitionPair(
          scale(p.src, 2 ** k),
          scale(p.dst, 2 ** k),
          p.evenOdd ? 'evenodd' : 'nonzero',
        );
      } catch {
        pr = null;
      }
      if (!pr) continue;
      built++;
      const t = pairTurns(pr);
      n += t.n;
      bad += t.bad;
    }
    per.push({ k, built, n, bad });
  }
  ok(
    per.every((r) => r.bad === 0 && r.built === per[1].built && r.n === per[1].n && r.n > 0),
    `no face turns: ${per.map((r) => `2^${r.k}: ${r.bad} of ${r.n} faces in ${r.built} pairs`).join('; ')}`,
  );
}

console.warn = warn;
console.log(fail ? `LB-PAIR-ORIENTATION FAIL (${fail})` : 'LB-PAIR-ORIENTATION PASS');
process.exit(fail ? 1 : 0);
