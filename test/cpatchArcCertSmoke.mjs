// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchArcCertSmoke — a certified Gauss-Newton foot point is never further than the exact solve by more than its slack.
//
// cpArcDistFoot solves a cubic's nearest point exactly (the quintic's descending chain), and on tiger that solve is
// most of the fill's cost. Most fragments do not need it: cpCubicCertFoot takes nine seeds and five Gauss-Newton
// steps, and CERTIFIES the result with the Bernstein form of |B(t) - p|^2 split at the foot -- no point of the arc nearer by
// more than a slack of 2^-11 px -- or hands the query to the chain. The slack is pixel-relative, so the claim holds at every
// scale.
//
// CHECKED through the SHIPPED kernel text in float32 (test/_glslEmu.mjs): on tiger's cubics, its horn arcs (a zero-length
// handle at one end) and arcs built to hold two minima, at points within 1.5 px of each arc drawn 1 to 65536 px long, the
// certified distance exceeds the chain's (or, where the chain is itself off by float32 rounding, the float64 truth) by no
// more than 2^-11 px; and the certificate is taken at all (a query with no slack runs the chain alone).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const CB = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const emu = EMU.buildGlslEmu(ROOT, { cpatch: true });
const f = Math.fround;

// tiger's cubics, every seventh, and its horn arcs
const b = CB.headlessCPatchBundle(
  await importSvg(readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8')),
);
const cf = CB.cpatchCurvePlane(b),
  cub = [],
  horn = [];
for (const r of b.curveRangesByShape) {
  let cs = null;
  try {
    cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
  } catch {
    continue;
  }
  for (const c of cs || [])
    for (const g of c)
      if (g.t === 'cubic' && g.P.length === 4) {
        const P = g.P,
          h =
            (P[0][0] === P[1][0] && P[0][1] === P[1][1]) ||
            (P[2][0] === P[3][0] && P[2][1] === P[3][1]);
        (h ? horn : cub).push(P);
      }
}
const ARCS = [];
cub.forEach((P, i) => {
  if (i % 7 === 0) ARCS.push({ P, tag: 'tiger cubic' });
});
horn.forEach((P, i) => {
  if (i % 3 === 0) ARCS.push({ P, tag: 'tiger horn' });
});
for (const P of [
  [
    [0, 0],
    [100, 0],
    [0, 100],
    [100, 100],
  ],
  [
    [0, 0],
    [120, 100],
    [-20, 100],
    [100, 0],
  ],
  [
    [0, 0],
    [100, 60],
    [0, 60],
    [100, 0.5],
  ],
  [
    [0, 0],
    [0, 0],
    [80, 40],
    [100, 100],
  ],
  [
    [0, 0],
    [60, 90],
    [100, 100],
    [100, 100],
  ],
])
  ARCS.push({ P, tag: 'two minima' });

const ev = (P, t) => {
  const u = 1 - t,
    a = u * u * u,
    c = 3 * u * u * t,
    d = 3 * u * t * t,
    e = t * t * t;
  return [
    a * P[0][0] + c * P[1][0] + d * P[2][0] + e * P[3][0],
    a * P[0][1] + c * P[1][1] + d * P[2][1] + e * P[3][1],
  ];
};
function truth(P, p) {
  const N = 1024,
    d = (t) => {
      const q = ev(P, t);
      return Math.hypot(q[0] - p[0], q[1] - p[1]);
    };
  let m = Infinity;
  const ds = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) ds[i] = d(i / N);
  for (let i = 0; i <= N; i++) {
    if (!(ds[i] <= (i ? ds[i - 1] : Infinity) && ds[i] <= (i < N ? ds[i + 1] : Infinity))) continue;
    let lo = Math.max(0, (i - 1) / N),
      hi = Math.min(1, (i + 1) / N);
    for (let k = 0; k < 60; k++) {
      const m1 = lo + (hi - lo) * 0.382,
        m2 = lo + (hi - lo) * 0.618;
      if (d(m1) < d(m2)) hi = m2;
      else lo = m1;
    }
    m = Math.min(m, d((lo + hi) / 2), ds[i]);
  }
  return m;
}
let seed = 20260928;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const SCALES = [1, 16, 256, 4096, 65536],
  Q = [];
for (const a of ARCS) {
  let L = 0;
  for (let k = 1; k <= 32; k++) {
    const u = ev(a.P, (k - 1) / 32),
      v = ev(a.P, k / 32);
    L += Math.hypot(v[0] - u[0], v[1] - u[1]);
  }
  if (!(L > 0)) continue;
  const O = a.P[0]; // the contour's frame, as the kernel has it
  const P32 = a.P.map((q) => [f(q[0] - O[0]), f(q[1] - O[1])]);
  for (const Lpx of SCALES)
    for (let k = 0; k < 3; k++) {
      const epp = L / Lpx,
        t = rnd(),
        q = ev(P32, t),
        q2 = ev(P32, Math.min(1, t + 1e-4)),
        q1 = ev(P32, Math.max(0, t - 1e-4));
      let dx = q2[0] - q1[0],
        dy = q2[1] - q1[1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const off = (rnd() * 2 - 1) * 1.5 * epp,
        j = (rnd() * 2 - 1) * 0.5 * epp;
      const p = [f(q[0] - dy * off + dx * j), f(q[1] + dx * off + dy * j)];
      Q.push({ P: P32, p, epp, Lpx, tag: a.tag, truth: truth(P32, p) });
    }
}
const query = (slack) =>
  Q.map((q) => ({
    k: EMU.K_CPATCH_ARC,
    GD: [0, 0, 0, 0],
    bb: [q.P[0][0], q.P[0][1], q.P[1][0], q.P[1][1]],
    c: q.p,
    ex: [q.P[2][0], q.P[2][1], q.P[3][0], q.P[3][1], 0, slack ? q.epp : 0],
  }));
const dCert = emu.run(new Float32Array(4), new Float32Array(4 * 7 * 4), query(true));
const dChain = emu.run(new Float32Array(4), new Float32Array(4 * 7 * 4), query(false));
let differ = 0;
for (const Lpx of SCALES) {
  const by = new Map();
  Q.forEach((q, i) => {
    if (q.Lpx !== Lpx) return;
    if (dCert[i] !== dChain[i]) differ++;
    const x = (dCert[i] - q.truth - Math.max(dChain[i] - q.truth, 0)) / q.epp;
    const r = by.get(q.tag) || { n: 0, worst: -Infinity };
    r.n++;
    if (x > r.worst) r.worst = x;
    by.set(q.tag, r);
  });
  const worst = Math.max(...[...by.values()].map((r) => r.worst));
  ok(
    worst <= 2 ** -11,
    `${String(Lpx).padStart(5)} px arcs: the certified distance exceeds the exact solve by at most ${worst.toExponential(1)} px (bar 2^-11) -- ${[...by.entries()].map(([t, r]) => `${t} ${r.n}`).join(', ')}`,
  );
}
ok(
  differ > 0,
  `the certificate is taken: ${differ} of ${Q.length} queries answered by it rather than the chain`,
);
console.log(fail ? `cpatchArcCertSmoke FAIL (${fail})` : 'cpatchArcCertSmoke PASS');
process.exit(fail ? 1 : 0);
