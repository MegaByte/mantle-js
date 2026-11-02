// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphJoinTangentScaleSmoke — a morph's rebuilt join tangents are the importer's, at any scale.
//
// A stroked shape morph recomputes its join texels from the lerped geometry every frame (core/morphCore.js
// rebuildJoinTangents), and they must mean what the importer's did (svg/textures.js segTangentAt): the join planes are
// built from both sides. The importer judges a handle directionless against the segment's own control-point span (1e-9
// of it) and a tangent against its coordinates' rounding (64 ulps); a rebuild with absolute tests (1e-9 for a handle,
// 1e-12 for a tangent) would, at 2^-20, take the chord in the morph and the handle at import for a quad or cubic handle
// under ~1e-3 of a unit, and the join would turn by up to the angle between them.
//
// (a) every end of a set of records -- lines, quads and cubics with handles from a hair to a whole span, a coincident
//     first control point, and arcs -- at 2^-40, 2^-20, 1, 2^20 and 2^40: the rebuilt tangent equals segTangentAt's on
//     the same float32 values (to float64 rounding);
// (b) with each absolute test put back, (a) fails at the small scales.
import path from 'path';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const { segTangentAt } = await import('../src/svg/textures.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } = await import('../src/svg/segment.js');
const f = Math.fround;

/// records in the morph's layout: [hdr(4)] then the type's texels (center-form arc: (cx cy rx ry) (th0 th1 phi _) (p1 p4)),
/// each the segment it stands for (float32 values), and its record offset
function records(S) {
  const out = [],
    buf = [];
  const push = (type, vals, seg) => {
    const off = buf.length;
    buf.push(type, 0, 0, 0, ...vals.map(f));
    while (buf.length % 4) buf.push(0);
    buf.push(0, 0, 0, 0);
    out.push({ off, type, seg });
  };
  const P = (x, y) => [f(x * S), f(y * S)];
  const L = (a, b) => push(0, [...a, ...b], { type: SEG_LINE, p1: a, p2: b });
  const Q = (a, c, b) => push(1, [...a, ...c, ...b, 0, 0], { type: SEG_QUAD, p1: a, p2: c, p3: b });
  const C = (a, b, c, d) =>
    push(2, [...a, ...b, ...c, ...d], { type: SEG_CUBIC, p1: a, p2: b, p3: c, p4: d });
  L(P(1, 2), P(9, 5));
  for (const h of [1e-8, 1e-6, 1e-4, 1e-2, 0.5]) {
    Q(P(0, 0), P(10 * h, 7 * h), P(10, 3));
    Q(P(0, 0), P(10 - 7 * h, 3 + 10 * h), P(10, 3));
    C(P(0, 0), P(10 * h, 7 * h), P(8, 6), P(10, 3));
    C(P(0, 0), P(0, 0), P(10 * h, -6 * h), P(10, 3)); // p2 == p1, then a short second handle
    C(P(0, 0), P(3, 4), P(10 - 6 * h, 3 - 9 * h), P(10, 3));
  }
  for (const [rx, ry, th0, th1, phi] of [
    [5, 3, 0.3, 2.1, 0.4],
    [4, 4, -1, 1.5, 0],
  ]) {
    const cx = f(2 * S),
      cy = f(1 * S),
      R = [f(rx * S), f(ry * S)],
      T = [f(th0), f(th1), f(phi)];
    const ev = (th) => [
      cx + R[0] * Math.cos(T[2]) * Math.cos(th) - R[1] * Math.sin(T[2]) * Math.sin(th),
      cy + R[0] * Math.sin(T[2]) * Math.cos(th) + R[1] * Math.cos(T[2]) * Math.sin(th),
    ];
    push(3, [cx, cy, ...R, ...T, 0, ...ev(T[0]), ...ev(T[1])], {
      type: SEG_ARC,
      cx,
      cy,
      rx: R[0],
      ry: R[1],
      theta_start: T[0],
      theta_end: T[1],
      phi: T[2],
    });
  }
  return { out, buf: new Float64Array(buf) };
}
/// every end's rebuilt tangent against segTangentAt, through the module at `mod`
async function check(mod) {
  const { rebuildJoinTangents } = await import(mod);
  const res = [];
  for (const e of [-40, -20, 0, 20, 40]) {
    const S = 2 ** e,
      { out, buf } = records(S);
    let n = 0,
      bad = 0,
      worst = 0;
    for (const r of out)
      for (const atStart of [true, false]) {
        const b = Float64Array.from(buf),
          j = 0; // a scratch join slot in the first header
        rebuildJoinTangents(
          b,
          Int32Array.from(atStart ? [j, 0, -1, 0, r.off, r.type] : [j, 0, r.off, r.type, -1, 0]),
        );
        const got = atStart ? [b[j + 2], b[j + 3]] : [b[j], b[j + 1]],
          want = segTangentAt(r.seg, atStart);
        const d = Math.hypot(got[0] - want[0], got[1] - want[1]);
        n++;
        worst = Math.max(worst, d);
        if (!(d < 1e-6)) bad++;
      }
    res.push({ e, n, bad, worst });
  }
  return res;
}
for (const r of await check('../src/core/morphCore.js'))
  ok(
    r.bad === 0,
    `(a) at 2^${r.e}: ${r.n} record ends, ${r.bad} whose rebuilt tangent is not the importer's (worst ${r.worst.toExponential(1)})`,
  );

// (b) the absolute tests, in a copy of src/
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'morphjt-'));
  try {
    cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
    const file = path.join(tmp, 'src/core/morphCore.js');
    let t = readFileSync(file, 'utf8');
    const from =
      'if (!(Math.hypot(dx, dy) > 1e-9 * _recSpan([p1x, p2x, p3x], [p1y, p2y, p3y]))) {\n      dx = p3x - p1x;\n      dy = p3y - p1y;\n    }';
    const from2 = 'const span = 1e-9 * _recSpan([p1x, p2x, p3x, p4x], [p1y, p2y, p3y, p4y]);';
    const ok1 = t.includes(from) && t.includes(from2);
    t = t
      .replace(from, '    if (Math.hypot(dx, dy) < 1e-9) { dx = p3x - p1x; dy = p3y - p1y; }')
      .replace(from2, '    const span = 1e-9;');
    writeFileSync(file, t);
    const res = await check(pathToFileURL(file).href);
    const small = res.filter((r) => r.e < 0 && r.bad > 0);
    ok(
      ok1 && small.length > 0,
      `(b) the absolute 1e-9 restored: ${res.map((r) => `2^${r.e} ${r.bad}`).join(', ')} ends off the importer's`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(fail ? `MORPH-JOIN-TANGENT-SCALE FAIL (${fail})` : 'MORPH-JOIN-TANGENT-SCALE PASS');
process.exit(fail ? 1 : 0);
