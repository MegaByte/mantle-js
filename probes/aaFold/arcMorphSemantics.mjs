// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcMorphSemantics.mjs -- the pose of a native-arc morph against literal interpolation of the AUTHORED arc parameters.
// SVG path animation (Chrome's SMIL/CSS d: interpolation) interpolates an arc command's own numbers -- rx, ry, x-axis-rotation and
// the end point -- and normalizes the radii (F.6.6) at each pose. The importer stores the arc's radii ALREADY normalized
// (arcEndpointToCenter), so the morph's endpoint-form lerp starts from them. They differ whenever an endpoint's authored radii
// were too small to span its chord. Reported: how far apart the two pose arcs are, in pixels at the stated viewport size.
//
//   node probes/aaFold/arcMorphSemantics.mjs [--px 512]
import path from 'path';
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const TREE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const x = await import(path.join(TREE, '../node_modules/@xmldom/xmldom/lib/index.js'));
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
console.warn = () => {};
const { default: importSvg } = await import(path.join(TREE, 'src/svg/importer.js'));
const { createFakeGl } = await import(path.join(TREE, 'test/_fakeGl.mjs'));
const { createShapeMorph } = await import(path.join(TREE, 'src/animation/shapeMorph.js'));
const { createBundle } = await import(path.join(TREE, 'src/renderer/bundle.js'));
const { arcRecordToCenter } = await import(path.join(TREE, 'src/core/morphCore.js'));
const { arcEndpointToCenter } = await import(path.join(TREE, 'src/svg/segment.js'));
const PX = +flag('px', 512);
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" d="${d}"/></svg>`;
// one arc each: M x1 y1 A rx ry rot large sweep x2 y2 (then a closing line so the shape is a region)
const A = (p) =>
  `M${p[0]} ${p[1]} A${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]} ${p[8]} L${p[7]} ${p[8] + 30} L${p[0]} ${p[1] + 30} Z`;
const cases = {
  'pill: r 20 (scaled, s=2) -> r 100': [
    [10, 50, 20, 20, 0, 0, 1, 90, 50],
    [10, 50, 100, 100, 0, 0, 1, 90, 50],
  ],
  'both scaled: r 30 -> r 20': [
    [10, 50, 30, 30, 0, 0, 1, 90, 50],
    [10, 50, 20, 20, 0, 0, 1, 90, 50],
  ],
  'ellipse 60x20 rot 0 -> 30x20 rot 30': [
    [10, 50, 60, 20, 0, 0, 1, 90, 50],
    [10, 50, 30, 20, 30, 0, 1, 90, 50],
  ],
  'no scaling (control): r 50 -> r 100': [
    [10, 50, 50, 50, 0, 0, 1, 90, 50],
    [10, 50, 100, 100, 0, 0, 1, 90, 50],
  ],
};
function poseArc(m, t) {
  const ms = m._morphSrc || (m.bundle && m.bundle._morphSrc);
  const srcC = ms.srcEpCurveF32,
    dstC = ms.dstEpCurveF32,
    curve = new Float32Array(srcC.length);
  for (let j = 0; j < srcC.length; j++) curve[j] = srcC[j] * (1 - t) + dstC[j] * t;
  const off = ms.arcOffsets[0];
  arcRecordToCenter(curve, off);
  return {
    cx: curve[off + 4],
    cy: curve[off + 5],
    rx: curve[off + 6],
    ry: curve[off + 7],
    th0: curve[off + 8],
    th1: curve[off + 9],
    phi: curve[off + 10],
  };
}
const pts = (a, n = 400) =>
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
  const row = [];
  for (const t of [0.25, 0.5, 0.75]) {
    const got = poseArc(m, t);
    // literal: lerp the authored numbers, normalize at the pose
    const L = (i) => pa[i] * (1 - t) + pb[i] * t;
    const ref = arcEndpointToCenter([L(0), L(1)], L(2), L(3), L(4), pa[5], pa[6], [L(7), L(8)]);
    const r = {
      cx: ref.cx,
      cy: ref.cy,
      rx: ref.rx,
      ry: ref.ry,
      phi: ref.phi,
      th0: ref.theta1,
      th1: ref.theta1 + ref.dtheta,
    };
    row.push(`t=${t}: ${((hd(pts(got), pts(r)) * PX) / 100).toFixed(2)} px`);
  }
  console.log(name.padEnd(40), row.join('  '));
}
