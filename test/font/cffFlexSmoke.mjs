// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies the Type 2 flex operators (flex / flex1 / hflex / hflex1) in
// CharStringInterp, plus legacy endchar `seac` detection.
//
// Synthesizes minimal charstring byte programs, runs them through
// CharStringInterp, and asserts the emitted curve control points. The
// interpreter reverses contour order to match TrueType winding, so the
// emitted seg order is reversed and each cubic's points are flipped; the
// forward outline is reconstructed from the reversed segs to compare.

import { CharStringInterp } from '../../src/font/formats/charStringInterp.js';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL', msg);
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- charstring byte encoder ----------------------------------------
// Operands: small ints via single byte (v+139 for -107..107); larger
// ints via the 28 + int16 form. Operators: raw bytes; two-byte ops are
// [12, low].
function enc(...items) {
  const out = [];
  for (const it of items) {
    if (typeof it === 'object' && it.op !== undefined) {
      if (it.op > 0xff) {
        out.push(12, it.op & 0xff);
      } else out.push(it.op);
    } else {
      const v = it | 0;
      if (v >= -107 && v <= 107) out.push(v + 139);
      else {
        out.push(28, (v >> 8) & 0xff, v & 0xff);
      } // int16
    }
  }
  return new Uint8Array(out);
}
const OP = (op) => ({ op });

// Run a standalone charstring (no subrs).
function runCS(bytes) {
  const interp = new CharStringInterp(bytes, 0, -1, 0, 0);
  const segs = interp.run(0, bytes.length);
  return { segs: segs || [], seac: interp._seac };
}

// Reconstruct the forward (pre-reversal) cubic control polylines from the
// reversed seg list. Each cubic seg after reversal is mkCubic(p4,p3,p2,p1)
// of the original; we just un-flip to recover the authored curve points.
function forwardCubics(segs) {
  const cubics = segs.filter((s) => s.type === 2 /* SEG_CUBIC */);
  // Reversal flips both order and per-seg point order. Undo order, then
  // undo per-seg flip → authored sequence.
  return cubics
    .slice()
    .reverse()
    .map((s) => ({
      p1: s.p4,
      c1: s.p3,
      c2: s.p2,
      p2: s.p1,
    }));
}

function expectCubic(label, got, p1, c1, c2, p2) {
  const eq = (g, e) => approx(g[0], e[0]) && approx(g[1], e[1]);
  if (!eq(got.p1, p1) || !eq(got.c1, c1) || !eq(got.c2, c2) || !eq(got.p2, p2)) {
    fail(
      `${label}\n   got  p1=${JSON.stringify(got.p1)} c1=${JSON.stringify(got.c1)} c2=${JSON.stringify(got.c2)} p2=${JSON.stringify(got.p2)}` +
        `\n   want p1=${JSON.stringify(p1)} c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)} p2=${JSON.stringify(p2)}`,
    );
  } else {
    console.log(`  ok   ${label}`);
  }
}

// =====================================================================
// hflex: dx1 dx2 dy2 dx3 dx4 dx5 dx6
//   start at (100, 200) via rmoveto.
//   curve1 ctrl deltas: (10,0)(20,30)(15,0)
//   curve2 ctrl deltas: (15,0)(20,-30)(10,0)
// =====================================================================
{
  const cs = enc(
    100,
    200,
    OP(0x15), // rmoveto -> pen (100,200)
    10,
    20,
    30,
    15,
    15,
    20,
    10, // hflex operands
    OP(0x0c22),
    OP(0x0e), // endchar
  );
  const { segs } = runCS(cs);
  const cu = forwardCubics(segs);
  if (cu.length !== 2) fail(`hflex: expected 2 cubics, got ${cu.length}`);
  else {
    // Pen starts (100,200).
    // c1: p1=(100,200) c1=(110,200) c2=(130,230) end=(145,230)
    expectCubic('hflex curve1', cu[0], [100, 200], [110, 200], [130, 230], [145, 230]);
    // c2: p1=(145,230) c1=(160,230) c2=(180,200) end=(190,200)
    expectCubic('hflex curve2', cu[1], [145, 230], [160, 230], [180, 200], [190, 200]);
  }
}

// =====================================================================
// flex1: dx1 dy1 dx2 dy2 dx3 dy3 dx4 dy4 dx5 dy5 d6
//   dominant axis is x (sum dx > sum dy) -> dx6=d6, dy6=-(sum dy).
//   start (0,0).
//   deltas: (10,5)(20,10)(15,0)(15,0)(20,-10)  d6=10
//   sum dx = 10+20+15+15+20 = 80 ; sum dy = 5+10+0+0-10 = 5 -> x dominant
//   so dx6 = 10, dy6 = -5.
// =====================================================================
{
  const cs = enc(0, 0, OP(0x15), 10, 5, 20, 10, 15, 0, 15, 0, 20, -10, 10, OP(0x0c25), OP(0x0e));
  const { segs } = runCS(cs);
  const cu = forwardCubics(segs);
  if (cu.length !== 2) fail(`flex1: expected 2 cubics, got ${cu.length}`);
  else {
    // c1: p1=(0,0) c1=(10,5) c2=(30,15) end=(45,15)
    expectCubic('flex1 curve1', cu[0], [0, 0], [10, 5], [30, 15], [45, 15]);
    // c2: p1=(45,15) c1=(60,15) c2=(80,5) end=(80+10,5-5)=(90,0)
    expectCubic('flex1 curve2', cu[1], [45, 15], [60, 15], [80, 5], [90, 0]);
  }
}

// =====================================================================
// hflex1: dx1 dy1 dx2 dy2 dx3 dx4 dx5 dy5 dx6
//   dy6 = -(dy1+dy2+dy5). start (0,0).
//   deltas: (10,5)(20,10)(15)(15)(20,8)(10)
//   dy6 = -(5+10+8) = -23.
// =====================================================================
{
  const cs = enc(0, 0, OP(0x15), 10, 5, 20, 10, 15, 15, 20, 8, 10, OP(0x0c24), OP(0x0e));
  const { segs } = runCS(cs);
  const cu = forwardCubics(segs);
  if (cu.length !== 2) fail(`hflex1: expected 2 cubics, got ${cu.length}`);
  else {
    // c1: p1=(0,0) c1=(10,5) c2=(30,15) end=(45,15)
    expectCubic('hflex1 curve1', cu[0], [0, 0], [10, 5], [30, 15], [45, 15]);
    // c2: p1=(45,15) c1=(60,15) c2=(80,23) end=(90, 23-23)=(90,0)
    expectCubic('hflex1 curve2', cu[1], [45, 15], [60, 15], [80, 23], [90, 0]);
  }
}

// =====================================================================
// flex (12 35): full deltas + trailing flex-depth operand (ignored).
//   start (0,0). c1:(10,0)(20,30)(15,0) c2:(15,0)(20,-30)(10,0) fd=50
// =====================================================================
{
  const cs = enc(
    0,
    0,
    OP(0x15),
    10,
    0,
    20,
    30,
    15,
    0,
    15,
    0,
    20,
    -30,
    10,
    0,
    50,
    OP(0x0c23),
    OP(0x0e),
  );
  const { segs } = runCS(cs);
  const cu = forwardCubics(segs);
  if (cu.length !== 2) fail(`flex: expected 2 cubics, got ${cu.length}`);
  else {
    expectCubic('flex curve1', cu[0], [0, 0], [10, 0], [30, 30], [45, 30]);
    expectCubic('flex curve2', cu[1], [45, 30], [60, 30], [80, 0], [90, 0]);
  }
}

// =====================================================================
// endchar seac detection: a base contour then `adx ady bchar achar
// endchar`. We assert _seac is recorded (composition itself is a
// documented reader-level limitation).
// =====================================================================
{
  const cs = enc(
    0,
    0,
    OP(0x15), // rmoveto
    10,
    0,
    0,
    10,
    -10,
    0,
    OP(0x08), // rrcurveto (one curve -> gives _gotWidth=true via move)
    40,
    50,
    65,
    18, // adx=40 ady=50 bchar=65('A') achar=18
    OP(0x0e), // endchar (seac form)
  );
  const { seac } = runCS(cs);
  if (!seac) fail('seac: endchar 4-arg form not recorded');
  else if (seac.adx !== 40 || seac.ady !== 50 || seac.bchar !== 65 || seac.achar !== 18)
    fail(`seac: wrong values ${JSON.stringify(seac)}`);
  else console.log('  ok   endchar seac recorded adx=40 ady=50 bchar=65 achar=18');
}

console.log();
console.log(failures === 0 ? 'CFF-FLEX PASS' : `CFF-FLEX FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
