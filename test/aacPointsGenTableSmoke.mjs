// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsGenTableSmoke -- the generated points (MANTLE_POINTS_GEN) are the point list, point for point.
//
// With aacPointsGen on (the default) the points route uploads no list: it uploads one RGBA32UI texel per (row, paint) -- first point, row | paint << 16,
// grid width, grid origin -- then one block bound per 64 points, and the vertex shader finds point gl_VertexID's entry by a binary search inside
// its block's bounds and its pixel by division (aacPoints.vert.glsl, pointAt). This mirrors pointAt in JS over the table buildTable makes and compares it with the list buildPoints makes, for every point:
//   (a) random drawings (fills, strokes, both) under scales, a mirror, a rotation and a skew, sub-ranges included;
//   (b) a drawing of more than 4096 entries, whose table wraps onto a second texel row;
//   (c) the shader text is the one mirrored (a change to pointAt must change this test), and two mutations of the mirror fail.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { attachAacPointsDraw } from '../src/renderer/aacPointsDraw.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
let seed = 777;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

function drawing(n) {
  const rows = new Uint16Array(n),
    paint = new Uint8Array(n),
    box = new Float64Array(6 * n),
    ext = new Float32Array(2 * n);
  for (let r = 0; r < n; r++) {
    rows[r] = r;
    paint[r] = 1 + Math.floor(rnd() * 3); // a fill, a stroke, or both
    const bw = 0.3 + rnd() * 5,
      bh = 0.3 + rnd() * 5,
      pad = rnd() * 0.4;
    box.set([-pad, -pad, bw + pad, bh + pad, bw, bh], 6 * r);
    ext[2 * r] = bw + 2 * pad;
    ext[2 * r + 1] = bh + 2 * pad;
  }
  return { rows, paint, box, ext };
}

// pointAt, as aacPoints.vert.glsl has it (uint arithmetic; the table is 4096 texels to a row): the block bounds after the E entries (64 points a block,
// four bounds to a texel) narrow the search to the entries of the point's block
const at = (i) => 4 * ((i >> 12) * 4096 + (i & 4095));
const bounds = (T, E, id) => {
  const j = id >> 6,
    q = E + (j >> 2),
    c = j & 3;
  return [T[at(q) + c], c === 3 ? T[at(q + 1)] : T[at(q) + c + 1]];
};
const SHIPPED = (T, E, id) => {
  let [lo, hi] = bounds(T, E, id);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (T[at(mid)] <= id) lo = mid;
    else hi = mid - 1;
  }
  const e = at(lo),
    k = id - T[e],
    w = T[e + 2];
  return [
    T[e + 1] & 0xffff,
    (T[e + 3] & 0xffff) + (k % w),
    (T[e + 3] >>> 16) + Math.floor(k / w),
    T[e + 1] >>> 16,
  ];
};
function compare(h, at = SHIPPED) {
  const { t, W, H } = h.build(),
    list = h.points();
  // (rows are W = min(E, 4096) texels wide: the shader's 4096 stride holds because a narrower table has one row)
  if (W !== 4096 && H !== 1) return { bad: 1, n: 0, where: `a ${W} x ${H} table` };
  const T = t;
  let bad = 0,
    where = '';
  for (let id = 0; id < h.n; id++) {
    const p = at(T, h.e, id);
    for (let c = 0; c < 4; c++)
      if (p[c] !== list[4 * id + c]) {
        if (!bad)
          where = `point ${id}: generated ${p.join(',')} list ${Array.from(list.slice(4 * id, 4 * id + 4)).join(',')}`;
        bad++;
        break;
      }
  }
  return { bad, n: h.n, where, W, H, rows: h.e };
}
const ask = (R, s, J) =>
  R._aacPointsGate.pointsFor(s, J, 1, 1, J[0], J[1], J[2], J[3], Infinity, 1e9);
const maps = (sc) => [
  [sc, 0, 0, sc],
  [-sc, 0, 0, sc],
  [sc * 0.8, sc * 0.6, -sc * 0.6, sc * 0.8],
  [sc, 0.3 * sc, 0, 0.7 * sc],
  [sc * 1.3, 0, 0, -sc * 0.9],
];

{
  // (a) random drawings
  const R = mk({ aacPointsBucket: false });
  let cases = 0,
    points = 0,
    bad = 0,
    where = '',
    allGen = true;
  for (const n of [1, 2, 7, 40, 300])
    for (const sc of [0.3, 1, 3.1, 9])
      for (const J of maps(sc)) {
        const h = ask(R, drawing(n), J);
        if (!h) continue;
        if (!h.gen) allGen = false;
        const r = compare(h);
        cases++;
        points += r.n;
        bad += r.bad;
        if (r.bad && !where) where = `n=${n} J=${J.map((x) => x.toFixed(2))}: ${r.where}`;
      }
  ok(allGen && cases > 50, `(a) the default handle is a generated table (${cases} drawings)`);
  ok(
    bad === 0 && points > 10000,
    `(a) the generated points are the list, point for point (${points} points over ${cases} drawings${bad ? '; ' + where : ''})`,
  );
}
{
  // (b) more than 4096 entries
  const R = mk({ aacPointsBucket: false });
  const s = drawing(3000);
  s.paint.fill(3); // a fill and a stroke on every row: 6000 entries
  const h = ask(R, s, [1.5, 0, 0, 1.5]);
  const r = h ? compare(h) : { bad: 1, n: 0, where: 'no list' };
  ok(
    h && h.e === 6000 && r.W === 4096 && r.H === 2,
    `(b) a 6000-entry table wraps onto a second row (${r.W} x ${r.H})`,
  );
  ok(
    r.bad === 0 && r.n > 0,
    `(b) ... and its ${r.n} generated points are the list${r.bad ? ': ' + r.where : ''}`,
  );
}
{
  // (b) fewer than 4096 entries whose block bounds wrap: the bounds, not the entries, cross onto the second texel row
  const R = mk({ aacPointsBucket: false });
  const s = drawing(2500);
  s.paint.fill(1); // fills only: 2500 entries
  const h = ask(R, s, [4, 0, 0, 4]);
  const r = h ? compare(h) : { bad: 1, n: 0, where: 'no list' };
  ok(
    h && h.e === 2500 && h.e + Math.ceil((Math.ceil(h.n / 64) + 1) / 4) > 4096 && r.H === 2,
    `(b) 2500 entries, ${h && h.n} points: the bounds wrap onto a second row (${r.W} x ${r.H})`,
  );
  ok(
    r.bad === 0 && r.n > 0,
    `(b) ... and its generated points are the list${r.bad ? ': ' + r.where : ''}`,
  );
}
{
  // (c) the shader is the one mirrored; mutations
  const src = readFileSync(path.join(ROOT, 'src/shaders/aacPoints.vert.glsl'), 'utf8');
  const lines = [
    'uvec4 ptTexel(int i) { return texelFetch(uPtTable, ivec2(i & 4095, i >> 12), 0); }',
    'int j = id >> 6, q = uPtEntries + (j >> 2), c = j & 3;',
    'int lo = int(bb[c]), hi = int(c == 3 ? ptTexel(q + 1).x : bb[c + 1]);',
    'if (int(ptTexel(mid).x) <= id) lo = mid; else hi = mid - 1;',
    'uvec4 e = ptTexel(lo);',
    'uint k = uint(id) - e.x, w = e.z;',
    'return uvec4(e.y & 0xffffu, (e.w & 0xffffu) + k % w, (e.w >> 16) + k / w, e.y >> 16);',
  ];
  const js = readFileSync(path.join(ROOT, 'src/renderer/aacPointsDraw.js'), 'utf8');
  ok(
    /const PT_BLOCK = 64;/.test(js),
    '(c) the table builder blocks 64 points, as pointAt reads id >> 6',
  );
  ok(
    lines.every((l) => src.includes(l)),
    '(c) aacPoints.vert.glsl has the pointAt this test mirrors',
  );
  const R = mk({ aacPointsBucket: false });
  const h = ask(R, drawing(60), [2.2, 0, 0, 2.2]);
  const LOWER = (T, E, id) => {
    // the search's first entry at or past id, not the last at or before it
    let lo = 0,
      hi = E - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (T[4 * mid] < id) lo = mid + 1;
      else hi = mid;
    }
    const e = 4 * lo,
      k = id - T[e],
      w = T[e + 2];
    return [
      T[e + 1] & 0xffff,
      (T[e + 3] & 0xffff) + (k % w),
      (T[e + 3] >>> 16) + Math.floor(k / w),
      T[e + 1] >>> 16,
    ];
  };
  const SWAP = (T, E, id) => {
    const p = SHIPPED(T, E, id);
    return [p[0], p[2], p[1], p[3]];
  }; // the grid read column-major
  const NOHI = (T, E, id) => {
    // the block's lower bound alone (no upper bound): a point past its block's first entry lands on the wrong one
    let lo = bounds(T, E, id)[0],
      hi = lo;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (T[at(mid)] <= id) lo = mid;
      else hi = mid - 1;
    }
    const e = at(lo),
      k = id - T[e],
      w = T[e + 2];
    return [
      T[e + 1] & 0xffff,
      (T[e + 3] & 0xffff) + (k % w),
      (T[e + 3] >>> 16) + Math.floor(k / w),
      T[e + 1] >>> 16,
    ];
  };
  ok(
    compare(h, LOWER).bad > 0,
    `(c) mutation: a lower-bound search disagrees with the list (${compare(h, LOWER).bad} points)`,
  );
  ok(
    compare(h, SWAP).bad > 0,
    `(c) mutation: the grid read column-major disagrees with the list (${compare(h, SWAP).bad} points)`,
  );
  ok(
    compare(h, NOHI).bad > 0,
    `(c) mutation: the block's lower bound without its upper bound disagrees with the list (${compare(h, NOHI).bad} points)`,
  );
  const Rl = mk({ aacPointsBucket: false, aacPointsGen: false }),
    hl = ask(Rl, drawing(60), [2.2, 0, 0, 2.2]);
  ok(
    hl && !hl.gen && hl.build().length === 4 * hl.n,
    `(c) aacPointsGen:false keeps the per-point list (${hl && hl.n} points)`,
  );
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
