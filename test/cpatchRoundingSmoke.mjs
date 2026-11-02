// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchRoundingSmoke -- CPatch's decomposition must not read rounding (and the cost cliff it fed).
//
// Tiger's corner cubics carry a zero end handle (P2 = P3), so the curve's end is a cusp of its implicit and a double root of any
// line through it; consecutive slices of one cubic lie on one algebraic curve; nearly straight cubics have implicits whose values
// along a neighbour are rounding. Each of these is a predicate that can read the sign of the last bit, so that a copy of the art
// perturbed by 1e-14 relative decomposes differently. Pinned here:
//   1. a near-double end root is not polished into a false root mid-curve (the ear chord at a zero handle: t = 0.88, where the
//      curve is a third of a unit off the line, refused an ear);
//   2. a line through a curve's end and its coincident handle has its end root factored out exactly, on any copy; a closed-form
//      root that is not a root is replaced by the subdivision's answer; a line-curve crossing is one node of the arrangement;
//   3. tiger shape 145 (185 curves; examples/tiger.svg, a fetched fixture) converts to nearly the same cell count on every copy
//      perturbed by 1e-14 and 1e-9 (shared points kept shared): 277..283 (298..344 with rounding-read predicates).
// The conversion runs in a child with a time cap, so a tree that falls into a repair search fails instead of hanging the lane.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { example, optionalAsset } from './_assets.mjs';

const TIGER = example('tiger.svg');
if (process.argv[2] !== '--child') {
  const { bezRoots01, bezEval, affRootsOnSeg } = await import('../src/geom/cpatchImplicit.js');
  // 1. the composition of the ear chord with the corner cubic, as the perturbed copy computed it: a double root at t = 1
  //    split by -2.8e-14 into a pair 3e-8 apart. Every root reported must be a root.
  for (const A of [
    [2.0434339192176765, 8.261941457553604, -2.842170943040401e-14, -2.842170943040401e-14],
    [2.0434339192177333, 8.26194145755656, 2.842170943040401e-14, 2.842170943040401e-14],
  ]) {
    const mag = A.reduce((s, v) => s + Math.abs(v), 0);
    for (const t of bezRoots01(A))
      assert(
        t > 1 - 1e-5 || Math.abs(bezEval(A, t)) <= 1e-9 * mag,
        'a reported root is a root: t=' + t + ' f=' + bezEval(A, t),
      );
  }
  // 2. the chord itself, on both copies: its only crossing with the corner cubic is the shared end.
  for (const [a, b, P] of [
    [
      [171.00725827074996, 199.51803189999998],
      [168.88848271074994, 148.66741845999996],
      [
        [171.36038753074996, 158.908167],
        [177.71671421074996, 162.08633033999996],
        [168.88848271074994, 148.66741845999996],
        [168.88848271074994, 148.66741845999996],
      ],
    ],
    [
      [171.0072582707511, 199.5180318999997],
      [168.88848271075142, 148.66741845999897],
      [
        [171.36038753075144, 158.90816700000173],
        [177.71671421074848, 162.08633034000115],
        [168.88848271075142, 148.66741845999897],
        [168.88848271075142, 148.66741845999897],
      ],
    ],
  ])
    for (const scale of [2 ** -20, 1, 2 ** 20]) {
      const s = (p) => [p[0] * scale, p[1] * scale];
      const A = s(a),
        B = s(b),
        dx = B[0] - A[0],
        dy = B[1] - A[1],
        L = Math.hypot(dx, dy);
      const h = [-dy / L, dx / L, -((-dy / L) * A[0] + (dx / L) * A[1])];
      for (const t of affRootsOnSeg(h, { t: 'cubic', P: P.map(s) }))
        assert(
          t > 1 - 1e-5,
          'the chord crosses the corner cubic only at their shared end, t=' + t + ' scale ' + scale,
        );
    }
  // 2b. a cubic with a zero first handle (A0 = A1) and its one root at t = 0.5, as a copy of tiger shape 58 perturbed by 1e-9 puts
  //     it to a winding ray: Cardano's double-root branch can report t = 0 (f = -6.4 there) and lose the root. So the closed form's
  //     answers are certified, and the hull subdivision answers when they fail.
  {
    const A = [-6.356326676167782, -6.356326676167782, 2.1187755458780657, 19.068980067036705];
    const r = bezRoots01(A);
    assert(r.length === 1 && Math.abs(r[0] - 0.5) < 1e-9, 'the one root is t = 0.5: ' + r);
  }
  // 2c. the two pieces cut at a line-curve crossing end at ONE node: cut parameters rounded to 1e-7 before slicing would put
  //     each piece's end up to 1e-6 of the coordinates off the crossing, two nodes where the cycle walk needs one
  //     (tiger shape 58 would paint nothing on a perturbed copy).
  {
    const { flattenGraph } = await import('../src/geom/cpatchGraph.js');
    for (const k of [2 ** -20, 1, 2 ** 20])
      for (const o of [0, 300]) {
        const q = (x, y) => [x * k + o * k, y * k + o * k];
        const c = [
          { t: 'cubic', P: [q(0, 0), q(37.3, -11.1), q(-17.9, 41.7), q(23.3, 33.7)] },
          { t: 'line', P: [q(23.3, 33.7), q(0, 0)] },
        ];
        const g = flattenGraph([c], null, null);
        assert.equal(
          g.nodes.length,
          3,
          'a figure-eight has its two ends and one crossing as nodes (scale ' +
            k +
            ', offset ' +
            o +
            ')',
        );
      }
  }
  // Static slices must pack the source representation conversion validates.
  // Morph pieces retain their separately frozen conditioning.
  {
    const { segSlice, segNorm, segImplicitPacked } = await import('../src/geom/cpatchImplicit.js');
    for (const scale of [2 ** -20, 1, 2 ** 20]) {
      const P = [
        [0, 0],
        [1, 3],
        [4, -2],
        [6, 1],
      ].map((p) => p.map((v) => v * scale));
      for (const bez of [false, true]) {
        const source = { t: 'cubic', P, _bez: bez },
          slice = segSlice(source, 0.25, 0.75);
        const packed = segImplicitPacked(source);
        assert(packed, 'the source cubic packs');
        assert.deepEqual(
          segImplicitPacked(slice),
          packed,
          'static slices retain the source coefficients and form',
        );
        slice.nrm = segNorm(slice);
        assert.notDeepEqual(
          segImplicitPacked(slice),
          packed,
          'frozen morph pieces retain their own conditioning',
        );
      }
    }
  }
  // 3. the tiger shape, in a capped child
  if (!optionalAsset(TIGER)) {
    console.log('cpatchRoundingSmoke: roots PASS');
    process.exit(0);
  }
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(
    r.status,
    0,
    'the perturbed copies convert (child exit ' +
      r.status +
      ', signal ' +
      r.signal +
      '): ' +
      (r.stderr || '').slice(0, 300),
  );
  const rows = JSON.parse(r.stdout.trim().split('\n').pop());
  const st = rows.pop();
  assert.equal(
    st[1][0],
    0,
    'no packed patch carries a seam a rounding long (tiger shapes 132, 145; authored and perturbed copies)',
  );
  for (const [rel, cells, pairs] of rows) {
    const lo = Math.min(...cells),
      hi = Math.max(...cells);
    assert(
      cells.every((c) => c > 0),
      'every copy converts at ' + rel + ': ' + cells,
    );
    assert(
      hi - lo <= 8,
      'cell counts agree across copies perturbed by ' + rel + ': ' + cells.join(', '),
    );
    assert(
      Math.max(...pairs) <= 80000,
      'no copy falls into a repair search at ' + rel + ': pair tests ' + pairs.join(', '),
    );
  }
  console.log(
    'cpatchRoundingSmoke PASS: no false root at a zero-handle end; tiger shape 145 cells ' +
      rows.map(([rel, c]) => rel + ': ' + c.join('/')).join('; '),
  );
} else {
  const { readFileSync } = await import('node:fs');
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { curveRangeToContours } = await import('../src/geom/lbContour.js');
  const { mkLine, mkQuad, mkCubic } = await import('../src/primitives/seg.js');
  const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
  const { convertContour, cpStats, cpStatsReset } =
    await import('../src/renderer/cpatchConvert.js');
  const sec = await importSvg(readFileSync(TIGER, 'utf8'));
  const range = sec.curveRangesByShape[145];
  const raw = curveRangeToContours(new Float64Array(sec.curves64), range.begin, range.end).map(
    (q) => q.map((s) => [s.type, ...[s.p1, s.p2, s.p3, s.p4].slice(0, s.type + 2).flat()]),
  );
  const pt = (a, i) => [a[i], a[i + 1]];
  const rows = [];
  for (const rel of [1e-14, 1e-9]) {
    const cells = [],
      pairs = [];
    for (let seed = 0; seed < 5; seed++) {
      // A path number is perturbed once: a point two segments share stays one value.
      let x = seed || 1;
      const rnd = () => {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        return (x >>> 0) / 4294967296;
      };
      const seen = new Map();
      const P = (p) => {
        const k = p[0] + ',' + p[1];
        if (!seen.has(k))
          seen.set(
            k,
            p.map((v) => v * (1 + (seed ? rel * (2 * rnd() - 1) : 0))),
          );
        return seen.get(k);
      };
      const contours = raw.map((q) =>
        q.map((s) => {
          const t = s[0],
            a = s.slice(1);
          return t === 0
            ? mkLine(P(pt(a, 0)), P(pt(a, 2)))
            : t === 1
              ? mkQuad(P(pt(a, 0)), P(pt(a, 2)), P(pt(a, 4)))
              : mkCubic(P(pt(a, 0)), P(pt(a, 2)), P(pt(a, 4)), P(pt(a, 6)));
        }),
      );
      const cs = contoursToConverter(contours, null);
      cpStatsReset();
      const out = convertContour(cs[0], { maxCurves: 8 });
      cells.push(out ? out.patches.length : 0);
      pairs.push(cpStats.pairs);
    }
    rows.push([rel, cells, pairs]);
  }
  // 4. no packed patch carries a seam a rounding long: its implicit's normal is noise, a half-space through the patch at a
  //    random angle and a crack of unpainted pixels (splitPartialSeams; shape 132 on the authored tiger and shape 145 on a
  //    copy perturbed by 2.5e-9 are such cases).
  const B = await import('../src/renderer/cpatchBuild.js');
  const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
  const svg0 = readFileSync(TIGER, 'utf8');
  let s = 103;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const rel = 10 ** (-9 + 0.4);
  const svg1 = svg0.replace(
    /\sd="([^"]*)"/g,
    (m, d) =>
      ' d="' +
      d.replace(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, (x) =>
        String(+x * (1 + rel * (2 * rnd() - 1))),
      ) +
      '"',
  );
  let stubs = 0;
  for (const text of [svg0, svg1]) {
    const sec2 = await importSvg(text),
      bundle = B.headlessCPatchBundle(sec2),
      cf = B.cpatchCurvePlane(bundle);
    for (const S of [132, 145]) {
      const r2 = bundle.curveRangesByShape[S],
        cs = B.contoursToConverter(curveRangeToContours(cf, r2.begin, r2.end), null);
      const pats = [];
      packCPatchShape(cs, 0, {
        evenOdd: B.shapeEvenOdd(bundle, S),
        pool: false,
        onPatches: (a) => {
          for (const p of a) pats.push(p);
        },
      });
      for (const p of pats) {
        const b = p.bbox,
          ext = Math.max(b[2] - b[0], b[3] - b[1]);
        for (const c of p.curves)
          if (
            c.t === 'line' &&
            Math.hypot(c.P[1][0] - c.P[0][0], c.P[1][1] - c.P[0][1]) < 1e-9 * ext
          )
            stubs++;
      }
    }
  }
  rows.push(['stubs', [stubs], [0]]);
  console.log(JSON.stringify(rows));
}
