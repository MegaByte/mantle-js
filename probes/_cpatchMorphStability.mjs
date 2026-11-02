// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchMorphStability — CAN a CPatch shape be morphed at all?
//
// Loop-Blinn morphs by building ONE mesh holding src+dst control points and
// lerping them in the vertex shader, recomputing klmn per frame. That only works
// because the two poses produce the same mesh structure. CPatch's equivalent
// demands the same thing of the CONVERTER: two poses of a shape must decompose
// into the same patches, in the same order, or there is nothing to pair and no
// amount of shader work fixes it.
//
// Converting per frame is not the fallback: even pooled it is ~1.4ms per contour,
// so a 60fps budget is gone by the second contour.
//
// So this measures structure, not speed: convert pose A and pose B of the same
// contour and compare patch count, per-patch curve count, and per-curve type. It
// sweeps the morph parameter because instability may only appear partway.
import { convertContour } from '../src/renderer/cpatchConvert.js';

const K = 6;
// Two poses of one blob: same topology, different control points — what a morph
// pair actually is.
function blob(t, R0 = 40, R1 = 62, phase = 0) {
  const R = R0 + (R1 - R0) * t,
    cx = 100,
    cy = 100;
  const P = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K + phase * t),
    cy + R * Math.sin((2 * Math.PI * j) / K + phase * t),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const bow = 0.3 + 0.14 * t; // the curvature changes too, not just scale
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    out.push({
      t: 'cubic',
      P: [
        A,
        [A[0] + (mx - A[0]) * 0.66, A[1] + (my - A[1]) * 0.66],
        [B[0] + (mx - B[0]) * 0.66, B[1] + (my - B[1]) * 0.66],
        B,
      ],
    });
  }
  return out;
}
// convertContour returns { patches, stats }.
const sig = (res) => {
  const patches = res && res.patches;
  return !patches
    ? null
    : patches
        .map((p) => {
          const cs = p.curves || p.impls || [];
          return cs.length + ':' + cs.map((c) => c.t || (c.impl && c.impl.k) || '?').join(',');
        })
        .join(' | ');
};

let fail = 0;

// ---- FOLLOW MODE: does replaying the src's decision tape make the dst match? ----
{
  const OPT = { maxCurves: 8, tolPx: 0.05 };
  let derivedMatch = 0,
    followedMatch = 0,
    followedNull = 0,
    n = 0;
  for (const phase of [0, 0.35]) {
    const tape = [];
    const src = convertContour(blob(0, 40, 62, phase), { ...OPT, record: tape });
    const srcSig = sig(src);
    for (let i = 1; i <= 10; i++) {
      const t = i / 10,
        dstCurves = blob(t, 40, 62, phase);
      n++;
      let d = null;
      try {
        d = convertContour(dstCurves, OPT);
      } catch {}
      if (sig(d) === srcSig) derivedMatch++;
      let f = null;
      try {
        f = convertContour(dstCurves, { ...OPT, follow: tape });
      } catch {}
      if (!f) {
        followedNull++;
        continue;
      }
      if (sig(f) === srcSig) followedMatch++;
    }
  }
  console.log('\n  pairing the dst to its src (' + n + ' poses over 2 shapes)');
  console.log('    decomposition DERIVED per pose : ' + derivedMatch + '/' + n + ' match the src');
  console.log(
    '    src TAPE replayed on the dst   : ' +
      followedMatch +
      '/' +
      n +
      ' match the src' +
      (followedNull ? '  (' + followedNull + ' refused the tape)' : ''),
  );
  if (followedMatch + followedNull !== n) {
    console.log('    WARNING: a followed run neither matched nor refused — it diverged SILENTLY.');
    fail++;
  }
}

const rows = [];
for (const phase of [0, 0.35]) {
  const ref = convertContour(blob(0, 40, 62, phase), { maxCurves: 8, tolPx: 0.05 });
  const refSig = sig(ref);
  let stable = 0,
    total = 0,
    firstBreak = null;
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    let got = null;
    try {
      got = convertContour(blob(t, 40, 62, phase), { maxCurves: 8, tolPx: 0.05 });
    } catch {
      got = null;
    }
    total++;
    const s = sig(got);
    if (s && s === refSig) stable++;
    else if (firstBreak === null)
      firstBreak = {
        t,
        n: got && got.patches ? got.patches.length : 0,
        refN: ref && ref.patches ? ref.patches.length : 0,
      };
  }
  rows.push({
    phase,
    refN: ref && ref.patches ? ref.patches.length : 0,
    stable,
    total,
    firstBreak,
  });
}
console.log('\nCPatch STRUCTURAL STABILITY across a morph parameter\n');
console.log('  phase | ref patches | poses matching ref structure | first divergence');
for (const r of rows) {
  const fb = r.firstBreak
    ? `t=${r.firstBreak.t.toFixed(1)} → ${r.firstBreak.n} patches (ref ${r.firstBreak.refN})`
    : '—';
  console.log(
    `  ${String(r.phase).padEnd(5)} | ${String(r.refN).padStart(11)} | ${String(r.stable + '/' + r.total).padStart(28)} | ${fb}`,
  );
  if (r.stable !== r.total) fail++;
}
// Show WHAT differs: count vs per-patch curve counts vs types decides whether a
// forced decomposition is even possible.
{
  const a = convertContour(blob(0, 40, 62, 0), { maxCurves: 8, tolPx: 0.05 });
  const b = convertContour(blob(0.3, 40, 62, 0), { maxCurves: 8, tolPx: 0.05 });
  const detail = (r) => (r.patches || []).map((p) => (p.curves || p.impls || []).length).join(',');
  const types = (r) =>
    (r.patches || [])
      .map((p) => (p.curves || p.impls || []).map((c) => c.t || '?').join(''))
      .join(' ');
  console.log(
    '\n  t=0.0  patches ' + (a.patches || []).length + '  curves/patch [' + detail(a) + ']',
  );
  console.log('         types  ' + types(a));
  console.log(
    '  t=0.3  patches ' + (b.patches || []).length + '  curves/patch [' + detail(b) + ']',
  );
  console.log('         types  ' + types(b));
}
console.log(
  fail
    ? '\nUNSTABLE — poses decompose differently, so src/dst patches cannot be paired.\n' +
        'A CPatch morph needs a decomposition FORCED to match, not one derived per pose.'
    : '\nSTABLE — poses share a decomposition, so a src/dst patch pairing is well-defined.',
);
