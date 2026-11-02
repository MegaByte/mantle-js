// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcMorphAuthoredRadiiSmoke -- a native-arc morph interpolates the AUTHORED arc numbers and normalizes the radii (SVG F.6.6) at
// each pose, as SVG path animation does. The importer stores an arc's radii already scaled up to span its chord, so the record
// carries that factor (texel 2's w) and the morph's endpoint form divides it back out. Without it, a pill whose authored
// radius 20 spans an 80-unit chord only at 40 would morph to radius 100 along radii 40..100 instead of 20..100: the pose arc
// 14-116 px off at 512 px. Pins: every pose arc equals the literal interpolation, static records change only in that one float,
// and an arc nobody had to scale carries 0 there.
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
const { arcRecordToCenter } = await import('../src/core/morphCore.js');
const { arcEndpointToCenter, SEG_ARC } = await import('../src/svg/segment.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" d="${d}"/></svg>`;
const A = (p) =>
  `M${p[0]} ${p[1]} A${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]} ${p[8]} L${p[7]} ${p[8] + 30} L${p[0]} ${p[1] + 30} Z`;
const cases = {
  'pill, radius 20 -> 100': [
    [10, 50, 20, 20, 0, 0, 1, 90, 50],
    [10, 50, 100, 100, 0, 0, 1, 90, 50],
  ],
  'both scaled, 30 -> 20': [
    [10, 50, 30, 30, 0, 0, 1, 90, 50],
    [10, 50, 20, 20, 0, 0, 1, 90, 50],
  ],
  'ellipse 60x20 -> 30x20 rotated 30': [
    [10, 50, 60, 20, 0, 0, 1, 90, 50],
    [10, 50, 30, 20, 30, 0, 1, 90, 50],
  ],
  'nothing scaled, 50 -> 100': [
    [10, 50, 50, 50, 0, 0, 1, 90, 50],
    [10, 50, 100, 100, 0, 0, 1, 90, 50],
  ],
};
const pts = (a, n = 200) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const th = a.th0 + ((a.th1 - a.th0) * i) / n,
      cp = Math.cos(a.phi),
      sp = Math.sin(a.phi);
    return [
      a.cx + cp * a.rx * Math.cos(th) - sp * a.ry * Math.sin(th),
      a.cy + sp * a.rx * Math.cos(th) + cp * a.ry * Math.sin(th),
    ];
  });
const hd = (P, Q) =>
  Math.max(...P.map((p) => Math.min(...Q.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))));
for (const [name, [pa, pb]] of Object.entries(cases)) {
  const { gl } = createFakeGl();
  const m = createShapeMorph(
    gl,
    createBundle(gl, await importSvg(svg(A(pa)))),
    createBundle(gl, await importSvg(svg(A(pb)))),
  );
  const ms = m._morphSrc || m.bundle._morphSrc;
  let worst = 0;
  for (const t of [0.25, 0.5, 0.75]) {
    const curve = new Float32Array(ms.srcEpCurveF32.length);
    for (let j = 0; j < curve.length; j++)
      curve[j] = ms.srcEpCurveF32[j] * (1 - t) + ms.dstEpCurveF32[j] * t;
    const off = ms.arcOffsets[0];
    arcRecordToCenter(curve, off);
    const got = {
      cx: curve[off + 4],
      cy: curve[off + 5],
      rx: curve[off + 6],
      ry: curve[off + 7],
      th0: curve[off + 8],
      th1: curve[off + 9],
      phi: curve[off + 10],
    };
    const L = (i) => pa[i] * (1 - t) + pb[i] * t;
    const r = arcEndpointToCenter([L(0), L(1)], L(2), L(3), L(4), pa[5], pa[6], [L(7), L(8)]);
    worst = Math.max(
      worst,
      hd(
        pts(got),
        pts({
          cx: r.cx,
          cy: r.cy,
          rx: r.rx,
          ry: r.ry,
          phi: r.phi,
          th0: r.theta1,
          th1: r.theta1 + r.dtheta,
        }),
      ) * 5.12,
    );
  }
  ok(
    worst < 0.01,
    `${name}: pose arcs match the literal interpolation (worst ${worst.toFixed(4)} px at 512 px)`,
  );
}
// the factor rides texel 2's w; an arc nobody scaled carries 0
{
  const { gl } = createFakeGl();
  const mk = async (d) => {
    const b = createBundle(gl, await importSvg(svg(d)));
    return Object.values(b).filter((v) => v instanceof Float32Array);
  };
  const a = await mk(A(cases['pill, radius 20 -> 100'][0])),
    c = await mk(A(cases['nothing scaled, 50 -> 100'][0]));
  // the header's low 2 bits are the type; the arc's header texel (segType, ...) is followed by (cx, cy, rx, ry) then (th0, th1, phi, factor)
  const arcW = (fs) => {
    for (const f of fs)
      for (let i = 0; i + 12 <= f.length; i += 4)
        if ((f[i] & 3) === SEG_ARC && Math.abs(f[i + 4] - 50) < 1e-3) return f[i + 11];
    return null;
  };
  ok(
    arcW(a) !== null && Math.abs(arcW(a) - 2) < 1e-5,
    `the scaled pill's arc record carries the factor 2 in texel 2's w (got ${arcW(a)})`,
  );
  ok(arcW(c) === 0, `an arc F.6.6 left alone carries 0 (got ${arcW(c)})`);
}
// Arc preparation must preserve authored vertices at every coordinate scale.
const { readFileSync } = await import('node:fs');
const flatCases = JSON.parse(
  readFileSync(new URL('fixtures/lb-zero-radius-morph.json', import.meta.url)),
).cases.filter((c) => c.name.includes('morph'));
for (const c of flatCases) {
  const { gl } = createFakeGl();
  const src = createBundle(gl, await importSvg(c.svg)),
    dst = createBundle(gl, await importSvg(c.morphSvgDst));
  const m = createShapeMorph(gl, src, dst),
    ms = m.bundle._morphSrc;
  for (const off of ms.arcOffsets)
    for (const [raw, ep] of [
      [ms.mergedCurveF32, ms.srcEpCurveF32],
      [ms.dstCurveF32, ms.dstEpCurveF32],
    ]) {
      ok(
        Array.from(ep.subarray(off + 4, off + 8)).every((v, k) => Object.is(v, raw[off + 12 + k])),
        c.name + ': endpoint plane retains stored vertices',
      );
    }
  m.dispose();
  src.dispose();
  dst.dispose();
}
if (fail) {
  console.error(`FAIL arcMorphAuthoredRadiiSmoke: ${fail}`);
  process.exit(1);
}
console.log('arcMorphAuthoredRadiiSmoke PASS');
