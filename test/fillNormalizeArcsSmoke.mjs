// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillNormalizeArcsSmoke -- coverage-only fill normalization for paints that carry NATIVE ARCS (native-arc extension).
// Raw AAC and Slug fold the integral of the signed winding, which is the filled area only where the paint's boundaries never
// nest or sit together in one pixel. For lines, quadratics and cubics the importer already keeps just the boundaries where the fill
// state changes and orients them; this pins the same for arcs (exact area moments, the quarter-turn control-triangle separation
// proof, closed-form ray crossings, whole-ellipse nesting for tangent contact). Pinned here:
//   * every fixture the certificate can prove is normalized, every one it cannot (crossing, touching at a vertex, opposite
//     windings that are already a hole) is left alone;
//   * SOUNDNESS against an independent oracle (probes/analyticArea/arcFill.mjs): the mean signed winding of the normalized list is
//     the exact filled area of the authored paint, pixel by pixel, for the fixtures and for randomized concentric families;
//   * the decision and the orientation pattern are identical from 2^-20 to 2^20 and at an offset (relative epsilons only);
//   * the import keeps the authored curve records, strokes both outlines, keeps the kernel set, and a morph restores the authored
//     bands (the shape pairs on curve counts exactly as before);
//   * arcs with a degenerate radius (the importer's chord) and a full turn in one record stay correct.
import path from 'path';
import { fileURLToPath } from 'url';
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const { createFakeGl } = await import('./_fakeGl.mjs');
const { createShapeMorph } = await import('../src/animation/shapeMorph.js');
const { createBundle } = await import('../src/renderer/bundle.js');
const { META_GLYPH_LOC_X, META_GLYPH_LOC_Y } = await import('../src/bundle/layout.js');
const { normalizedFillSegs } = await import('../src/svg/fillNormalize.js');
const { mkArc } = await import('../src/svg/segment.js');
const { mkLine } = await import('../src/primitives/seg.js');
const { fixtures, svgOf, segsOf, fixtureOf, referenceArea, circle, ellipse, roundRect, pie } =
  await import('../probes/analyticArea/arcFill.mjs');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const sig = (out) =>
  out
    ? out
        .map(
          (g) =>
            g.type + (g.is_fill_only ? 'c' : '') + (g.type === 3 ? (g.sweep_flag ? '+' : '-') : ''),
        )
        .join('')
    : 'null';
const evenOdd = (f) => f.rule === 'evenodd';

// 1. decisions
for (const f of fixtures) {
  const out = normalizedFillSegs(segsOf(f), evenOdd(f));
  ok(
    (out !== null) === (f.expect === 'fix'),
    `${f.name}: ${f.expect === 'fix' ? 'normalized' : 'left as authored'}`,
  );
}
// 2. soundness: the mean signed winding of the normalized list is the exact filled area of the authored paint
const worst = (f, out) => {
  const want = referenceArea(f, 32, 128),
    got = referenceArea({ ...fixtureOf(out, f.rule), rule: 'nonzero' }, 32, 128, 'winding');
  let w = 0;
  for (let i = 0; i < want.length; i++) w = Math.max(w, Math.abs(Math.abs(got[i]) - want[i]));
  return w;
};
for (const f of fixtures) {
  const out = normalizedFillSegs(segsOf(f), evenOdd(f));
  if (!out) continue;
  const w = worst(f, out);
  ok(
    w < 2e-3,
    `${f.name}: normalized winding equals the exact area (max ${w.toExponential(1)} of a pixel)`,
  );
}
// The randomized families' reference polygon: arcs flattened at 4096 points a turn, as the probe's reference flattens them at 100,000 (seconds for this loop).
// At 4096 a chord strays at most 3e-6 px from an arc of radius 11 px, against a bar of 2e-3, and the authored and the normalized sides are flattened alike.
const D2R = Math.PI / 180;
const pointOn = (a, deg) => {
  const t = deg * D2R,
    p = a.phi * D2R,
    c = Math.cos(t),
    s = Math.sin(t);
  return [
    a.cx + Math.cos(p) * a.rx * c - Math.sin(p) * a.ry * s,
    a.cy + Math.sin(p) * a.rx * c + Math.cos(p) * a.ry * s,
  ];
};
const polygonOf = (f, perTurn = 4096) => ({
  ...f,
  contours: f.contours.map((c) => {
    const out = [];
    for (const s of c) {
      if (s.L) {
        out.push(s);
        continue;
      }
      const a = s.A,
        n = Math.max(8, Math.ceil((Math.abs(a.a1 - a.a0) / 360) * perTurn));
      for (let i = 0; i < n; i++) out.push({ L: pointOn(a, a.a0 + ((a.a1 - a.a0) * i) / n) });
      out.push({ L: pointOn(a, a.a1) });
    }
    out.start = c.start || (c[0].L ? out[out.length - 1].L : pointOn(c[0].A, c[0].A.a0));
    return out;
  }),
});
const worstPolygon = (f, out) => {
  const want = referenceArea(polygonOf(f), 32, 128),
    got = referenceArea(
      { ...polygonOf(fixtureOf(out, f.rule)), rule: 'nonzero' },
      32,
      128,
      'winding',
    );
  let w = 0;
  for (let i = 0; i < want.length; i++) w = Math.max(w, Math.abs(Math.abs(got[i]) - want[i]));
  return w;
};
let seed = 20261012;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const ri = (a, b) => a + (b - a) * rnd();
let accepted = 0,
  unsound = 0;
for (let t = 0; t < 140; t++) {
  const n = 2 + Math.floor(rnd() * 3),
    cx = ri(12, 20),
    cy = ri(12, 20),
    R = ri(6, 11),
    ph = ri(0, 180),
    e = ri(0.5, 1),
    rev0 = rnd() < 0.3,
    kind = Math.floor(rnd() * 3),
    cs = [];
  for (let i = 0; i < n; i++) {
    const s = 1 - i * ri(0.02, 0.12),
      rev = rnd() < 0.25 ? !rev0 : rev0,
      a0 = ri(0, 360);
    cs.push(
      kind === 0
        ? circle(cx, cy, R * s, rev, a0)
        : kind === 1
          ? ellipse(cx, cy, R * s, R * e * s, ph, rev, a0)
          : roundRect(cx - R * s, cy - R * e * s, 2 * R * s, 2 * R * e * s, R * s * 0.4, rev),
    );
  }
  for (const rule of ['nonzero', 'evenodd']) {
    const f = { rule, contours: cs },
      out = normalizedFillSegs(segsOf(f), rule === 'evenodd');
    if (!out) {
      unsound += 0;
      continue;
    }
    accepted++;
    if (worstPolygon(f, out) >= 2e-3) unsound++;
  }
}
ok(
  accepted > 150 && unsound === 0,
  `${accepted} randomized concentric families normalized, ${unsound} unsound`,
);
// 3. scale and offset: same decision and orientation pattern from 2^-20 to 2^20
const xf = (f, k, ox, oy) => {
  const s = 2 ** k,
    P = (p) => [(p[0] + ox) * s, (p[1] + oy) * s];
  return {
    ...f,
    contours: f.contours.map((c) => {
      const d = c.map((g) =>
        g.L
          ? { L: P(g.L) }
          : {
              A: {
                ...g.A,
                cx: (g.A.cx + ox) * s,
                cy: (g.A.cy + oy) * s,
                rx: g.A.rx * s,
                ry: g.A.ry * s,
              },
            },
      );
      if (c.start) d.start = P(c.start);
      return d;
    }),
  };
};
let drift = 0;
for (const f of fixtures) {
  const base = sig(normalizedFillSegs(segsOf(f), evenOdd(f)));
  for (const k of [-20, -10, 0, 10, 20])
    for (const [ox, oy] of [
      [0, 0],
      [3000, -2000],
    ])
      if (sig(normalizedFillSegs(segsOf(xf(f, k, ox, oy)), evenOdd(f))) !== base) {
        drift++;
        console.log('  drift', f.name, k, ox);
      }
}
ok(
  drift === 0,
  `${fixtures.length} fixtures decide identically at 2^-20, 2^-10, 1, 2^10, 2^20 and at an offset`,
);
// 4. the importer: authored records, stroke, kernel set, morph
const { gl } = createFakeGl();
const rg = (s) => s.curveRangesByShape[0],
  strokeLen = (s) => {
    let t = 0;
    for (let i = 0; i < s.shapeIds.length; i++)
      if (/_stroke$/.test(s.shapeIds[i]))
        t += s.curveRangesByShape[i].end - s.curveRangesByShape[i].begin;
    return t;
  };
const region = (b) => {
  const m = b.metaFloats,
    f = b.bandFloats,
    at = (m[META_GLYPH_LOC_Y] * 4096 + m[META_GLYPH_LOC_X]) * 4,
    n = f[at] + f[at + 1] + f[at + 2] + f[at + 3];
  return { at, data: f.slice(at, at + 4 * (4 + 2 * n)) };
};
for (const name of [
  'nested-circles-same-nz',
  'thin-ring-ellipses-eo',
  'rounded-rect-frame-eo',
  'tangent-circles-eo',
  'tangent-diagonal-nz',
]) {
  const f = fixtures.find((x) => x.name === name),
    source = svgOf(f, 'stroke="#000" stroke-width=".1"');
  const a = await importSvg(source),
    n = await importSvg(source, { normalizeFill: false });
  ok(
    a.authoredBandsByShape?.some(Boolean) && !n.authoredBandsByShape,
    `${name}: coverage normalized only when enabled`,
  );
  ok(
    same(
      new Float32Array(a.curves).slice(rg(a).begin, rg(a).end),
      new Float32Array(n.curves).slice(rg(n).begin, rg(n).end),
    ),
    `${name}: authored curve records byte-identical`,
  );
  ok(
    strokeLen(a) > 0 && strokeLen(a) === strokeLen(n),
    `${name}: the stroke still has every outline`,
  );
  ok(a.segTypeMask === n.segTypeMask, `${name}: curve-type flags retained`);
  const ma = createShapeMorph(gl, createBundle(gl, a), createBundle(gl, a)),
    mn = createShapeMorph(gl, createBundle(gl, n), createBundle(gl, n));
  ok(
    ma.bundle.segTypeMask === mn.bundle.segTypeMask &&
      same(region(ma.bundle).data, region(mn.bundle).data),
    `${name}: a morph restores the authored bands and kernel set`,
  );
}
// 5. declines that must stay declines (not provable here): a crossing, contact at a vertex or along a line, a pie sharing its apex
const dec = (name, f) =>
  ok(normalizedFillSegs(segsOf(f), evenOdd(f)) === null, `declines: ${name}`);
dec('crossing circles (nonzero)', {
  rule: 'nonzero',
  contours: [circle(14, 16, 8), circle(18, 16, 8)],
});
dec('identical circles (repeated contour)', {
  rule: 'nonzero',
  contours: [circle(16, 16, 8), circle(16, 16, 8)],
});
dec('a circle poking out of another by 1e-3', {
  rule: 'nonzero',
  contours: [circle(16, 16, 12), circle(15.6, 16, 11.601)],
});
dec('pie inside a pie sharing the apex and the radii', {
  rule: 'nonzero',
  contours: [pie(16, 16, 12, 0, 270), pie(16, 16, 6, 0, 270)],
});
dec('a circle tangent to a flat edge', {
  rule: 'nonzero',
  contours: [roundRect(4, 4, 24, 24, 5), circle(16, 8, 4)],
});
// 6. degenerate radius (the importer's chord) and a full turn in one record
const tri = (x, y, s) => [
  mkLine([x, y], [x + s, y]),
  mkLine([x + s, y], [x, y + s]),
  mkLine([x, y + s], [x, y]),
  mkLine([x, y], [x, y], true),
];
const chordArc = (p, q) =>
  mkArc(
    (p[0] + q[0]) / 2,
    (p[1] + q[1]) / 2,
    Math.hypot(q[0] - p[0], q[1] - p[1]) / 2,
    0,
    Math.PI,
    2 * Math.PI,
    Math.atan2(q[1] - p[1], q[0] - p[0]),
    0,
    1,
    p,
    q,
  );
const withChord = [
  chordArc([4, 4], [28, 4]),
  mkLine([28, 4], [28, 28]),
  mkLine([28, 28], [4, 28]),
  mkLine([4, 28], [4, 4]),
  mkLine([4, 4], [4, 4], true),
  ...circle2(16, 16, 5),
];
function circle2(cx, cy, r) {
  return [
    mkArc(cx, cy, r, r, 0, 2 * Math.PI, 0, 1, 1, [cx + r, cy], [cx + r, cy]),
    mkLine([cx + r, cy], [cx + r, cy], true),
  ];
}
const chordOut = normalizedFillSegs(withChord, false);
ok(
  chordOut !== null && sig(chordOut).includes('3'),
  'a degenerate-radius arc (a chord) beside a full-turn arc record: circle inside is normalized, the chord arc is kept',
);
if (chordOut) {
  const f = {
    rule: 'nonzero',
    contours: [
      (() => {
        const c = [{ L: [28, 4] }, { L: [28, 28] }, { L: [4, 28] }, { L: [4, 4] }];
        c.start = [4, 4];
        return c;
      })(),
      circle(16, 16, 5),
    ],
  };
  ok(worst(f, chordOut) < 2e-3, 'its normalized winding equals the exact area');
}
if (fail) {
  console.error(`FAIL fillNormalizeArcsSmoke: ${fail}`);
  process.exit(1);
}
console.log('fillNormalizeArcsSmoke PASS');
