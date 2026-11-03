// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamCostAB — the lightweight stream's per-frame CPU cost, as an in-process ABBA across source trees.
//
// Each ARM is a checkout -- a directory holding js.kontek.mantle/src and js.kontek.mantle/test, e.g.
// `git archive <rev> js.kontek.mantle/src js.kontek.mantle/test | tar -x -C <dir>` -- and all
// arms load in ONE process and run interleaved (ABBA over REPS), so machine load and clock drift hit every
// arm alike -- a cross-run comparison on this machine drifts far more than the effects measured here. Pass
// the same tree twice for the A/A floor. Per arm: median ms per frame of updateBundleGeometry
// {lightweight:true} and of the draw that follows (the unified stream rebuild and upload, on
// test/_fakeGl.mjs, so CPU only).
//
//   node probes/lbBuildPaths/streamCostAB.mjs roads <treeA> <treeB> [<treeA again> ...]   FRAMES=60 REPS=6
//   scenes: roads -- 24 perspective road bands (quad edges, one side concave), all moving every frame
//           cdt   -- a concave C, two disjoint blobs, a cubic blob, warping
//
// Measured on this machine (under load, A/A floor 4%): roads 0.41 ms with a fast-builder stream, 5.14-5.37 with the
// static route's correct build.
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
console.warn = () => {};
const [scene, ...dirs] = process.argv.slice(2);
const FR = +(process.env.FRAMES || 60),
  REPS = +(process.env.REPS || 6);
const arms = [];
for (const d of dirs) {
  const J = d + '/js.kontek.mantle';
  const { createFakeGl, taggedShaderSources } = await import(J + '/test/_fakeGl.mjs');
  const M = await import(J + '/src/index.js'),
    { mkQuad, mkLine, mkCubic } = await import(J + '/src/primitives/seg.js');
  const gl = createFakeGl({ width: 256, height: 256 }).gl;
  const R = M.createRenderer(gl, taggedShaderSources(), {});
  if (R.ready) await R.ready;
  R.setViewport(256, 256);
  const Q = mkQuad,
    L = mkLine,
    C = mkCubic,
    straightQ = (a, b) => Q(a, a, b),
    quadEdge = (n, m, f) => Q(n, [2 * m[0] - (n[0] + f[0]) / 2, 2 * m[1] - (n[1] + f[1]) / 2], f);
  const band = (nL, mL, fL, nR, mR, fR) => [
    quadEdge(nL, mL, fL),
    straightQ(fL, fR),
    quadEdge(fR, mR, nR),
    straightQ(nR, nL),
  ];
  const mk = (yN, yF, rwN, rwF, sway) => {
    const yM = (yN + yF) / 2,
      rwM = (rwN + rwF) / 2,
      cx = 100;
    return band(
      [cx - rwN, yN],
      [cx + sway - rwM, yM],
      [cx - rwF, yF],
      [cx + rwN, yN],
      [cx + sway + rwM, yM],
      [cx + rwF, yF],
    );
  };
  const blob = (cx, cy, r, k) => [
    Q([cx - r, cy], [cx - r, cy - r - k], [cx, cy - r]),
    Q([cx, cy - r], [cx + r + k, cy - r], [cx + r, cy]),
    Q([cx + r, cy], [cx + r, cy + r + k], [cx, cy + r]),
    Q([cx, cy + r], [cx - r - k, cy + r], [cx - r, cy]),
  ];
  const gen =
    scene === 'roads'
      ? (t) => {
          const s = [];
          for (let k = 0; k < 24; k++) {
            const yN = 190 - k * 7 - t * 0.3,
              yF = yN - 7;
            s.push(mk(yN, yF, 70 - k * 2.5, 68 - k * 2.5, 10 * Math.sin(0.07 * t + k * 0.3)));
          }
          return s;
        }
      : (t) => {
          const w = 3 * Math.sin(t * 0.1),
            v = 2 * Math.cos(0.13 * t);
          return [
            [
              Q([20, 20 + v], [70 + w, 10], [120, 20]),
              L([120, 20], [120, 40]),
              Q([120, 40], [70 - w, 25 + v], [20, 40]),
              L([20, 40], [20, 20 + v]),
            ],
            [...blob(40 + w, 90, 15, 4), ...blob(95, 90 + v, 12, 3)],
            [
              C([150, 60], [150 + w, 20], [210, 20], [210, 60]),
              C([210, 60], [210, 110 + v], [150, 95], [150, 60]),
            ],
          ];
        };
  const b = M.createBundle(
    gl,
    M.buildStreamableSections(
      gen(0).map((segs) => ({ segs, fill: [0.3, 0.3, 0.3, 1] })),
      [0, 0, 220, 220],
      { lightweight: true },
    ),
  );
  let t = 0;
  const run = () => {
    let tu = 0,
      td = 0;
    for (let i = 0; i < FR; i++) {
      const s = gen(t++);
      const t0 = performance.now();
      M.updateBundleGeometry(gl, b, s, { lightweight: true });
      const t1 = performance.now();
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b, {});
      R.endFrame();
      td += performance.now() - t1;
      tu += t1 - t0;
    }
    return { u: tu / FR, d: td / FR };
  };
  run();
  run(); // warm
  arms.push({ name: d.split('/').pop(), run, u: [], d: [] });
}
const order = [];
for (let r = 0; r < REPS; r++) order.push(...(r % 2 ? arms.slice().reverse() : arms));
for (const a of order) {
  const m = a.run();
  a.u.push(m.u);
  a.d.push(m.d);
}
const med = (xs) => {
  const s = xs.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
};
const base = arms[0];
for (const a of arms)
  console.log(
    `${scene} ${a.name.padEnd(6)} update ${med(a.u).toFixed(3)} ms/frame (min ${Math.min(...a.u).toFixed(3)})   draw ${med(a.d).toFixed(3)} ms/frame   update ratio vs ${base.name} ${(med(a.u) / med(base.u)).toFixed(3)}`,
  );
process.exit(0);
