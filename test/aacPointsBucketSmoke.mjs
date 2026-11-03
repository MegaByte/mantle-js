// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsBucketSmoke -- the point route's BUCKETED LISTS. A drawing asked with a different map each frame (an animated, depth-scaled
// sprite) is listed from the map scaled up to the next power of 1.25, so the list survives every frame the scale stays in its bucket. Pinned:
//   (a) the bucketed list is a SUPERSET of the exact one (same row, column, row, paint entries, plus extra points that carry no coverage): under
//       growing and shrinking scale, a mirror, a rotation and a skew, so the pixels cannot differ;
//   (b) it is REUSED (the same array) while the scale stays in its bucket, and rebuilt when it leaves it: far fewer builds than frames;
//   (c) a STATIC drawing (one map) keeps the exact list, byte for byte as before; option aacPointsBucket:false keeps it exact for an animated one;
//   (d) the GATE decides on the exact counts: the answer (list or null) is the same with bucketing on and off at every budget.
import { attachAacPointsDraw } from '../src/renderer/aacPointsDraw.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const mk = (opts) => {
  const R = { gl: null, opts: opts || {}, _pendingShaders: [], _pendingPrograms: [] };
  attachAacPointsDraw(R);
  return R;
};
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

// a synthetic drawing: n rows of random em boxes. box = cover low/high (relative to the bbox's low corner, covering it) + the bbox size, per row.
function drawing(n) {
  const rows = new Uint16Array(n),
    paint = new Uint8Array(n),
    box = new Float64Array(6 * n),
    ext = new Float32Array(2 * n);
  for (let r = 0; r < n; r++) {
    rows[r] = r;
    paint[r] = 1 + (r % 3 === 0 ? 2 : 0); // fill, and a stroke on every third row
    const bw = 0.5 + rnd() * 6,
      bh = 0.5 + rnd() * 6,
      pad = rnd() * 0.4;
    box.set([-pad, -pad, bw + pad, bh + pad, bw, bh], 6 * r);
    ext[2 * r] = bw + 2 * pad;
    ext[2 * r + 1] = bh + 2 * pad;
  }
  return { rows, paint, box, ext };
}
const entries = (pts) => {
  const set = new Set();
  for (let k = 0; k < pts.length; k += 4)
    set.add(pts[k] + ':' + pts[k + 1] + ':' + pts[k + 2] + ':' + pts[k + 3]);
  return set;
};
const maps = (sc) => [
  [sc, 0, 0, sc],
  [-sc, 0, 0, sc],
  [sc * 0.8, sc * 0.6, -sc * 0.6, sc * 0.8],
  [sc, 0.3 * sc, 0, 0.7 * sc],
  [sc * 1.3, 0, 0, -sc * 0.9],
];
const ask = (R, s, J) =>
  R._aacPointsGate.pointsFor(s, J, 1, 1, J[0], J[1], J[2], J[3], Infinity, 1e9); // a list HANDLE (reuse is its identity)
const pts = (h) => h && h.points(); // ... and its points
const gateOf = (R) => R._aacPointsGate;

{
  // (a) superset
  const Rb = mk({}),
    Re = mk({ aacPointsBucket: false });
  let allSuper = true,
    extraMax = 0,
    n = 0;
  for (const sc of [0.4, 1, 2.7, 6, 11])
    for (const J of maps(sc)) {
      const s1 = drawing(12),
        s2 = { ...s1 };
      s1.animated = true; // as noteMap marks it after its first change of map
      const eb = pts(ask(Rb, s1, J)),
        ee = pts(ask(Re, s2, J));
      const sb = entries(eb),
        se = entries(ee);
      for (const e of se)
        if (!sb.has(e)) {
          allSuper = false;
          break;
        }
      extraMax = Math.max(extraMax, eb.length / ee.length);
      n++;
    }
  ok(
    allSuper,
    `(a) the bucketed list contains every exact entry across ${n} maps (scales 0.4..11, mirror, rotation, skew, flip)`,
  );
  ok(
    extraMax <= 1.25 * 1.25 * 1.05,
    `(a) the bucketed list is at most ${extraMax.toFixed(3)}x the exact one's points (bound 1.25^2)`,
  );
}
{
  // (b) reuse across a bucket, rebuild beyond it
  const R = mk({});
  const s = drawing(60);
  s.animated = true;
  let builds = 0,
    prev = null,
    frames = 0;
  for (let sc = 3; sc <= 60; sc *= 1.01) {
    const l = ask(R, s, [sc, 0, 0, sc]);
    if (l !== prev) builds++;
    prev = l;
    frames++;
  }
  const buckets = Math.ceil(Math.log(60 / 3) / Math.log(1.25)) + 1;
  ok(
    builds <= buckets + 1 && builds < frames / 5,
    `(b) ${frames} frames of a growing sprite built ${builds} lists (about one per 1.25x step, ${buckets} steps)`,
  );
}
{
  // (b2) one bundle mounted at several depths (parallax scenery): the asks alternate between maps, and every bucket's list is kept
  const R = mk({});
  const s = drawing(60);
  s.animated = true;
  const bases = [3, 5.2, 9, 14, 22];
  const seen = new Set();
  let builds = 0,
    frames = 0;
  for (let f = 0; f < 40; f++)
    for (const b of bases) {
      const sc = b * (1 + 0.004 * f);
      const l = ask(R, s, [sc, 0, 0, sc]);
      if (!seen.has(l)) {
        seen.add(l);
        builds++;
      }
      frames++;
    }
  ok(
    builds <= 12 && builds < frames / 10,
    `(b2) ${frames} asks over 5 interleaved depths built ${builds} lists`,
  );
}
{
  // (c) static keeps the exact list; the option keeps it exact for an animated one
  const R = mk({}),
    Re = mk({ aacPointsBucket: false });
  const fresh = () => {
    seed = 777;
    return drawing(30);
  };
  const J = [5, 0, 0, 5];
  const a = pts(ask(R, fresh(), J)),
    b = pts(ask(Re, fresh(), J));
  const s3 = fresh();
  s3.animated = true;
  const c = pts(ask(Re, s3, J));
  ok(
    a.length === b.length && a.every((v, i) => v === b[i]),
    '(c) a static drawing lists exactly what it always listed',
  );
  ok(c.length === b.length, '(c) aacPointsBucket:false keeps an animated drawing exact');
}
{
  // (d) the gate answers from the exact counts
  const R = mk({}),
    Re = mk({ aacPointsBucket: false });
  let same = true,
    flips = 0,
    total = 0;
  for (const sc of [1.5, 3, 5])
    for (const budget of [2000, 8000, 20000, 60000, 200000, 600000]) {
      seed = 99;
      const s1 = drawing(50),
        s2 = drawing(50);
      s1.animated = true;
      const J = [sc, 0, 0, sc];
      const x = R._aacPointsGate.pointsFor(s1, J, 1, 1, sc, 0, 0, sc, Infinity, budget),
        y = Re._aacPointsGate.pointsFor(s2, J, 1, 1, sc, 0, 0, sc, Infinity, budget);
      if ((x === null) !== (y === null)) same = false;
      total++;
      if (y === null) flips++;
    }
  ok(
    same && flips > 0 && flips < total,
    `(d) the gate's answer is the same with bucketing on and off at every budget (${flips} of ${total} declined: both sides of the threshold are exercised)`,
  );
}
{
  // Animated axis-aligned draws reuse the conservative grid without rebuilding exact grids that cannot change the decision.
  const was = globalThis.__MANTLE_DEBUG__;
  globalThis.__MANTLE_DEBUG__ = true;
  try {
    const R = mk({});
    seed = 127;
    const s = drawing(24);
    s.animated = true;
    let first = null,
      same = true;
    for (let i = 0; i < 60; i++) {
      const sc = 3.01 + i * 0.0001,
        pts = ask(R, s, [sc, 0, 0, sc]);
      first ??= pts;
      same &&= pts === first;
    }
    ok(!!first && same, '(e) sixty animated maps within one bucket reuse one point list');
    ok(
      R._aacPointsStats.geoms === 1,
      `(e) cached acceptance builds one conservative grid, not sixty redundant exact grids (${R._aacPointsStats.geoms})`,
    );
  } finally {
    globalThis.__MANTLE_DEBUG__ = was;
  }
}
if (fail) {
  console.error(`aacPointsBucketSmoke FAIL (${fail})`);
  process.exit(1);
}
console.log('aacPointsBucketSmoke PASS');
