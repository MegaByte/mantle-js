// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeStripFoldSmoke -- a stroke row whose strip FOLDS (a bend tighter than the half-width, a cusp, a near-reversal, a
// miter tip past the section bound) still gets a strip, and that strip holds the whole stroke.
//
// svg/strokeStrip.js covers the runs it cannot cover with conforming quads by convex PATCHES (the run's hull plus its
// joins' miter tips or clip corners, grown by the reach). This checks, on the CPU and with no renderer:
//   * every FOLD case builds a strip (not a single quad) with at least one patch, flagged overlapping (so it
//     draws only under the depth claim), and a case with no fold builds no patch;
//   * COVERAGE: every sample of the TRUE stroke -- discs of radius halfW along each segment, square caps, and the miter
//     wedge (to the tip, or the clip line of a miter-clip join) at every real join that miters -- lies inside a strip
//     triangle (before the vertex stage's AA dilation, which only grows it);
//   * SCALE: the same path scaled by 2^-20 and 2^20 builds the same triangles (relative to the scale) and patches.
import { parsePathD } from '../src/svg/path.js';
import { buildStrokeStrip } from '../src/svg/strokeStrip.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../src/svg/segment.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const ok = (m) => console.log('ok ' + m);

const evalSeg = (s, t) => {
  if (s.type === SEG_LINE)
    return [s.p1[0] + (s.p2[0] - s.p1[0]) * t, s.p1[1] + (s.p2[1] - s.p1[1]) * t];
  if (s.type === SEG_QUAD) {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * s.p1[k] + 2 * u * t * s.p2[k] + t * t * s.p3[k]);
  }
  if (s.type === SEG_CUBIC) {
    const u = 1 - t;
    return [0, 1].map(
      (k) =>
        u * u * u * s.p1[k] +
        3 * u * u * t * s.p2[k] +
        3 * u * t * t * s.p3[k] +
        t * t * t * s.p4[k],
    );
  }
  const th = s.theta_start + (s.theta_end - s.theta_start) * t,
    cp = Math.cos(s.phi || 0),
    sp = Math.sin(s.phi || 0);
  const ex = s.rx * Math.cos(th),
    ey = s.ry * Math.sin(th);
  return [s.cx + ex * cp - ey * sp, s.cy + ex * sp + ey * cp];
};
const tan = (s, end) => {
  const e = 1e-7,
    a = evalSeg(s, end ? 1 - e : 0),
    b = evalSeg(s, end ? 1 : e);
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    l = Math.hypot(dx, dy);
  return l > 0 ? [dx / l, dy / l] : null;
};
const segLen = (s) => {
  let L = 0,
    p = evalSeg(s, 0);
  for (let i = 1; i <= 256; i++) {
    const q = evalSeg(s, i / 256);
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
    p = q;
  }
  return L;
};

/** samples of the true stroke region (halfW discs, square caps, miter wedges) */
function strokeSamples(segs, h, join, cap, ml) {
  const out = [],
    R = 0.999 * h;
  const dirs = 24;
  // subpaths, and the butt ends whose half-plane past the end the stroke does not reach
  const subs = [];
  let cur = null;
  for (const s of segs) {
    if (!cur || s.subStart) {
      cur = [];
      subs.push(cur);
    }
    cur.push(s);
  }
  // the shader cuts an end segment's tube by its butt plane (the intersection with the half-space behind it); a sample of
  // that segment on or past the plane is not stroke
  const cut = new Map();
  for (const sub of subs) {
    const a0 = evalSeg(sub[0], 0),
      z = evalSeg(sub[sub.length - 1], 1);
    const closed =
      Math.hypot(a0[0] - z[0], a0[1] - z[1]) <=
      1e-9 * Math.max(1, Math.abs(a0[0]), Math.abs(a0[1]));
    if (!closed && cap === 0) {
      const d0 = tan(sub[0], false),
        d1 = tan(sub[sub.length - 1], true);
      const add = (s, c) => {
        if (!cut.has(s)) cut.set(s, []);
        cut.get(s).push(c);
      };
      if (d0) add(sub[0], [a0, [-d0[0], -d0[1]]]);
      if (d1) add(sub[sub.length - 1], [z, d1]);
    }
  }
  const pastButt = (s, q) =>
    (cut.get(s) || []).some(([P, t]) => (q[0] - P[0]) * t[0] + (q[1] - P[1]) * t[1] > -1e-6 * h);
  for (const s of segs) {
    const n = Math.min(20000, Math.max(8, Math.ceil(segLen(s) / (0.05 * h))));
    for (let i = 0; i <= n; i++) {
      const c = evalSeg(s, i / n);
      if (!pastButt(s, c)) out.push(c);
      for (let k = 0; k < dirs; k++) {
        const a = (2 * Math.PI * k) / dirs;
        for (const r of [0.5 * R, R]) {
          const q = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
          if (!pastButt(s, q)) out.push(q);
        }
      }
    }
  }
  // joins between consecutive segments of a subpath, plus the closing join of a closed subpath
  for (const sub of subs) {
    const pairs = [];
    for (let i = 0; i + 1 < sub.length; i++) pairs.push([sub[i], sub[i + 1]]);
    const a0 = evalSeg(sub[0], 0),
      z = evalSeg(sub[sub.length - 1], 1);
    const closed =
      Math.hypot(a0[0] - z[0], a0[1] - z[1]) <=
      1e-9 * Math.max(1, Math.abs(a0[0]), Math.abs(a0[1]));
    if (closed) pairs.push([sub[sub.length - 1], sub[0]]);
    if (join === 0 || join === 3)
      for (const [p, q] of pairs) {
        const d1 = tan(p, true),
          d2 = tan(q, false),
          P = evalSeg(p, 1);
        if (!d1 || !d2) continue;
        const cosT = d1[0] * d2[0] + d1[1] * d2[1];
        if (!(1 + cosT > 1e-9)) continue;
        const ratio = 1 / Math.sqrt((1 + cosT) / 2),
          sOut = d1[0] * d2[1] - d1[1] * d2[0] > 0 ? -1 : 1;
        const n1 = [-d1[1] * sOut, d1[0] * sOut],
          n2 = [-d2[1] * sOut, d2[0] * sOut];
        const bx = n1[0] + n2[0],
          by = n1[1] + n2[1],
          bl = Math.hypot(bx, by),
          b = [bx / bl, by / bl];
        const fits = ratio <= ml;
        if (!fits && join === 0) continue;
        const A = [P[0] + R * n1[0], P[1] + R * n1[1]],
          B = [P[0] + R * n2[0], P[1] + R * n2[1]],
          T = [P[0] + b[0] * R * ratio, P[1] + b[1] * R * ratio];
        const clip = fits ? Infinity : R * ml;
        for (let i = 0; i <= 20; i++)
          for (let j = 0; i + j <= 20; j++) {
            const u = i / 20,
              v = j / 20,
              w = 1 - u - v;
            const x = [P[0] * w + A[0] * u + T[0] * v * 0 + B[0] * 0, 0];
            // the kite P, A, T, B as two triangles (P A T) and (P T B)
            for (const [X, Y] of [
              [A, T],
              [T, B],
            ]) {
              const q = [P[0] * w + X[0] * u + Y[0] * v, P[1] * w + X[1] * u + Y[1] * v];
              if ((q[0] - P[0]) * b[0] + (q[1] - P[1]) * b[1] <= clip) out.push(q);
            }
            void x;
          }
      }
    if (!closed)
      for (const [s, end, cp] of [
        [sub[0], false, cap],
        [sub[sub.length - 1], true, cap],
      ]) {
        if (cp !== 2) continue; // round caps are the disc above; butt has none
        const d = tan(s, end),
          P = evalSeg(s, end ? 1 : 0);
        if (!d) continue;
        const t = end ? d : [-d[0], -d[1]],
          nn = [-t[1], t[0]];
        for (let i = 0; i <= 10; i++)
          for (let j = -10; j <= 10; j++)
            out.push([
              P[0] + (t[0] * R * i) / 10 + (nn[0] * R * j) / 10,
              P[1] + (t[1] * R * i) / 10 + (nn[1] * R * j) / 10,
            ]);
      }
  }
  return out;
}

/** how many samples fall outside every strip triangle (12 floats per vertex, x y at 0 1) */
function uncovered(verts, samples, scale) {
  const tris = [];
  for (let i = 0; i + 35 < verts.length + 0 || i + 36 <= verts.length; i += 36)
    tris.push([
      [verts[i], verts[i + 1]],
      [verts[i + 12], verts[i + 13]],
      [verts[i + 24], verts[i + 25]],
    ]);
  // a uniform grid over the triangles' boxes
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const t of tris)
    for (const p of t) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  const G = 64,
    cw = (x1 - x0) / G || 1,
    ch = (y1 - y0) / G || 1,
    cells = Array.from({ length: G * G }, () => []);
  tris.forEach((t, k) => {
    const bx0 = Math.max(0, Math.floor((Math.min(t[0][0], t[1][0], t[2][0]) - x0) / cw)),
      bx1 = Math.min(G - 1, Math.floor((Math.max(t[0][0], t[1][0], t[2][0]) - x0) / cw));
    const by0 = Math.max(0, Math.floor((Math.min(t[0][1], t[1][1], t[2][1]) - y0) / ch)),
      by1 = Math.min(G - 1, Math.floor((Math.max(t[0][1], t[1][1], t[2][1]) - y0) / ch));
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) cells[y * G + x].push(k);
  });
  const eps = 1e-9 * scale;
  const inTri = (t, p) => {
    const c = (a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const e0 = c(t[0], t[1]),
      e1 = c(t[1], t[2]),
      e2 = c(t[2], t[0]);
    const l = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]) * eps;
    return (
      (e0 >= -l(t[0], t[1]) && e1 >= -l(t[1], t[2]) && e2 >= -l(t[2], t[0])) ||
      (e0 <= l(t[0], t[1]) && e1 <= l(t[1], t[2]) && e2 <= l(t[2], t[0]))
    );
  };
  let miss = 0;
  const where = [];
  for (const p of samples) {
    const cx = Math.floor((p[0] - x0) / cw),
      cy = Math.floor((p[1] - y0) / ch);
    const hit =
      cx >= 0 && cy >= 0 && cx < G && cy < G && cells[cy * G + cx].some((k) => inTri(tris[k], p));
    const hitEdge = !hit && [[cx, cy]].some(() => tris.some((t) => inTri(t, p)));
    if (!hit && !hitEdge) {
      miss++;
      if (where.length < 4) where.push(p.map((v) => +(v / scale).toFixed(3)));
    }
  }
  return { miss, where, tris: tris.length };
}

const scaleSegs = (segs, k) =>
  segs.map((s) => {
    const o = { ...s };
    for (const key of ['p1', 'p2', 'p3', 'p4']) if (s[key]) o[key] = [s[key][0] * k, s[key][1] * k];
    if (s.type === SEG_ARC) {
      o.cx = s.cx * k;
      o.cy = s.cy * k;
      o.rx = s.rx * k;
      o.ry = s.ry * k;
    }
    return o;
  });

// [name, d, stroke width, join (0 miter 1 round 2 bevel 3 miter-clip), cap (0 butt 1 round 2 square), miter limit, expect fold patches?]
const CASES = [
  ['tight cubic loop, round', 'M 20 80 C 120 0 0 0 100 80', 30, 1, 1, 4, true],
  ['cubic cusp, butt', 'M 0 0 C 100 100 0 100 100 0', 12, 1, 0, 4, true],
  ['cubic cusp, square caps', 'M 0 0 C 100 100 0 100 100 0', 12, 2, 2, 4, true],
  ['near-reversal polyline, miter limit 30', 'M 0 0 L 200 10 L 0 20', 4, 0, 0, 30, true],
  ['near-reversal polyline, miter (bevels)', 'M 0 0 L 200 10 L 0 20', 4, 0, 1, 4, true],
  ['near-reversal polyline, miter-clip', 'M 0 0 L 200 10 L 0 20 L 200 30', 4, 3, 0, 3, true],
  ['curve-curve miter join', 'M 0 0 Q 50 -60 100 0 Q 40 60 0 100', 10, 0, 0, 10, null],
  [
    'small closed arc circle, wide',
    'M 45 50 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 Z',
    24,
    1,
    0,
    4,
    true,
  ],
  ['zigzag hairline-ish', 'M 0 0 L 10 40 L 20 0 L 30 40 L 40 0 L 50 40 L 60 0', 3, 0, 0, 4, null],
  ['tight quad turn, bevel', 'M 0 0 Q 100 5 0 10 L 0 50', 8, 2, 1, 4, true],
  [
    'straight miter polyline within its limit (no patch)',
    'M8 22 L25 8 L40 22 L55 10 L70 24 L88 12',
    6,
    0,
    0,
    10,
    false,
  ],
  ['gentle cubic (no fold)', 'M 0 0 C 100 0 200 100 300 100', 4, 1, 1, 4, false],
  [
    'q_cubic row 3',
    'M 398 414.84 C 336.48 457.06 197.12 143.63 29.35 482.65 C 59.77 127.39 64.56 354.72 229.62 21.69',
    11.97,
    1,
    1,
    4,
    null,
  ],
  [
    'q_cubic row 5',
    'M 227.07 441.91 C 349.03 104 142.47 184.1 133.15 80.92 C 227.81 307.6 302.53 242.17 424.55 455.87 C 81.79 483.86 424.9 104.66 265.4 83.67',
    8.83,
    1,
    1,
    4,
    null,
  ],
];
let folded = 0;
for (const [name, d, w, join, cap, ml, expectFold] of CASES) {
  const segs0 = parsePathD(d);
  const ref = buildStrokeStrip(segs0, {
    halfW: w / 2,
    joinStyle: join,
    capStyle: cap,
    miterLimit: ml,
    boxArea: 0,
    tolDiag: 0.004,
  });
  if (!ref) {
    fail(`${name}: no strip`);
    continue;
  }
  if (expectFold === true && !(ref.patches > 0))
    fail(`${name}: expected a fold patch, got ${ref.patches}`);
  if (expectFold === false && ref.patches !== 0)
    fail(`${name}: a path with no fold built ${ref.patches} patch(es)`);
  if (ref.patches > 0 && !ref.overlap)
    fail(`${name}: a patched strip must be flagged overlapping (depth claim only)`);
  if (ref.patches > 0) folded++;
  let worst = 0;
  for (const k of [1, 2 ** -20, 2 ** 20]) {
    const segs = k === 1 ? segs0 : scaleSegs(segs0, k);
    const st =
      k === 1
        ? ref
        : buildStrokeStrip(segs, {
            halfW: (w / 2) * k,
            joinStyle: join,
            capStyle: cap,
            miterLimit: ml,
            boxArea: 0,
            tolDiag: 0.004,
          });
    if (!st) {
      fail(`${name} @${k}: no strip`);
      continue;
    }
    if (st.patches !== ref.patches || st.verts.length !== ref.verts.length) {
      fail(
        `${name} @${k}: ${st.patches} patches / ${st.verts.length / 12} verts vs ${ref.patches} / ${ref.verts.length / 12} at scale 1`,
      );
      continue;
    }
    for (let i = 0; i < st.verts.length; i += 12)
      worst = Math.max(
        worst,
        Math.abs(st.verts[i] / k - ref.verts[i]) / (w / 2),
        Math.abs(st.verts[i + 1] / k - ref.verts[i + 1]) / (w / 2),
      );
    const samples = strokeSamples(segs, (w / 2) * k, join, cap, ml);
    const u = uncovered(st.verts, samples, k);
    if (u.miss)
      fail(
        `${name} @${k}: ${u.miss} of ${samples.length} stroke samples outside the strip (first at ${JSON.stringify(u.where)})`,
      );
    else if (k === 1)
      ok(
        `${name}: ${samples.length} stroke samples inside ${u.tris} triangles, ${st.patches} patch(es), overlap ${st.overlap}`,
      );
  }
  if (worst > 1e-9)
    fail(`${name}: scaled builds differ from scale 1 by ${worst.toExponential(2)} half-widths`);
}
// FUZZ: random lines, quads, cubics and arcs at random widths, joins, caps and miter limits (seeded); coverage at scale 1
let seed = 20261015;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
const pt = () => `${(rnd() * 100).toFixed(2)} ${(rnd() * 100).toFixed(2)}`;
let fuzzPatched = 0,
  fuzzBuilt = 0;
const FUZZ = 160;
for (let f = 0; f < FUZZ; f++) {
  let d = 'M ' + pt();
  const ns = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < ns; i++) {
    const t = rnd();
    d +=
      t < 0.25
        ? ' L ' + pt()
        : t < 0.5
          ? ' Q ' + pt() + ' ' + pt()
          : t < 0.85
            ? ' C ' + pt() + ' ' + pt() + ' ' + pt()
            : ` A ${(5 + rnd() * 40).toFixed(1)} ${(5 + rnd() * 40).toFixed(1)} ${(rnd() * 90).toFixed(0)} ${rnd() < 0.5 ? 1 : 0} ${rnd() < 0.5 ? 1 : 0} ${pt()}`;
  }
  if (rnd() < 0.2) d += ' Z';
  const w = 1 + rnd() * 30,
    join = [0, 1, 2, 3][Math.floor(rnd() * 4)],
    cap = Math.floor(rnd() * 3),
    ml = [1.5, 4, 20][Math.floor(rnd() * 3)];
  const segs = parsePathD(d);
  const st = buildStrokeStrip(segs, {
    halfW: w / 2,
    joinStyle: join,
    capStyle: cap,
    miterLimit: ml,
    boxArea: 0,
    tolDiag: 0.004,
  });
  if (!st) continue;
  fuzzBuilt++;
  if (st.patches > 0) {
    fuzzPatched++;
    if (!st.overlap) fail(`fuzz ${f}: patched but not overlapping`);
  }
  const u = uncovered(st.verts, strokeSamples(segs, w / 2, join, cap, ml), 1);
  if (u.miss)
    fail(
      `fuzz ${f} (${d}, w ${w.toFixed(2)}, join ${join}, cap ${cap}, ml ${ml}): ${u.miss} samples outside the strip, first ${JSON.stringify(u.where)}`,
    );
}
if (fuzzBuilt < FUZZ * 0.9) fail(`fuzz: only ${fuzzBuilt} of ${FUZZ} paths built a strip`);
ok(
  `fuzz: ${fuzzBuilt} of ${FUZZ} random paths built a strip (${fuzzPatched} with patches), every stroke sample covered`,
);
if (folded < 6) fail(`only ${folded} cases built fold patches: the smoke proves little`);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  `\nstrokeStripFoldSmoke: fold and miter-tip rows strip with patches that hold the whole stroke (${CASES.length} cases, ${folded} patched, scales 2^-20..2^20)`,
);
