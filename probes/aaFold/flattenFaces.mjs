// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// flattenFaces.mjs -- paint conflation (b): how many disjoint visible faces does a layered drawing flatten into? Raster estimate (no
// arrangement is built): paint every fill in order at N x N point samples, label each pixel with the SET of paints covering it
// (the stack) and with its TOP paint, and count 4-connected components of each label. Faces by stack = an upper bound on faces
// with distinct final paint; faces by top paint = a lower bound. Also the face-boundary length (px) against the paints' own.
//   node probes/aaFold/flattenFaces.mjs --assets a.svg,b.svg --size 2048
import { readFileSync } from 'fs';
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
const CB = await import(path.join(TREE, 'src/renderer/cpatchBuild.js'));
const { curveRangeToContours } = await import(path.join(TREE, 'src/geom/lbContour.js'));
const { flatten } = await import('./aacFoldModel.mjs');
const N = +flag('size', 1024);
for (const file of flag('assets').split(',')) {
  const sc = await importSvg(readFileSync(file, 'utf8'), { preserveViewport: true });
  const b = CB.headlessCPatchBundle(sc),
    cf = CB.cpatchCurvePlane(b);
  const meta = new Float32Array(sc.meta.buffer ? sc.meta.buffer : sc.meta);
  const gb = sc.globalBBox,
    ext = Math.max(gb[2] - gb[0], gb[3] - gb[1]),
    epp = ext / N,
    x0 = gb[0] - (ext - (gb[2] - gb[0])) / 2,
    y0 = gb[1] - (ext - (gb[3] - gb[1])) / 2;
  const top = new Int32Array(N * N).fill(-1),
    stack = new Float64Array(N * N); // stack: order-independent hash of covering paints
  let paints = 0,
    segs = 0;
  for (let s = 0; s < b.curveRangesByShape.length; s++) {
    if (/_stroke$/.test(sc.shapeIds[s] || '')) continue;
    if (!(meta[s * 48 + 4 + 11] > 0)) continue;
    const r = b.curveRangesByShape[s],
      cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
    if (!cs.length) continue;
    const eo = CB.shapeEvenOdd(b, s),
      sg = flatten(cs);
    paints++;
    segs += cs.reduce((a, c) => a + c.length, 0);
    let yy0 = 1e30,
      yy1 = -1e30;
    for (const [p, q] of sg)
      for (const v of [p, q]) {
        yy0 = Math.min(yy0, v[1]);
        yy1 = Math.max(yy1, v[1]);
      }
    const j0 = Math.max(0, Math.floor((yy0 - y0) / epp)),
      j1 = Math.min(N - 1, Math.ceil((yy1 - y0) / epp));
    const h = Math.sin(s * 12.9898) * 43758.5453;
    const hv = h - Math.floor(h);
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) * epp,
        xs = [];
      for (const [p, q] of sg)
        if (p[1] <= y !== q[1] <= y)
          xs.push([p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]), q[1] > p[1] ? 1 : -1]);
      if (!xs.length) continue;
      xs.sort((u, v) => u[0] - v[0]);
      let k = 0,
        w = 0,
        c = 0;
      for (let i = 0; i < N; i++) {
        const xx = x0 + (i + 0.5) * epp;
        while (k < xs.length && xs[k][0] <= xx) {
          w += xs[k][1];
          c++;
          k++;
        }
        if (eo ? c & 1 : w !== 0) {
          top[j * N + i] = s;
          stack[j * N + i] += hv;
        }
      }
    }
  }
  const comps = (lab) => {
    const seen = new Uint8Array(N * N);
    let n = 0,
      bnd = 0;
    const st = [];
    for (let p = 0; p < N * N; p++) {
      if (seen[p]) continue;
      n++;
      seen[p] = 1;
      st.push(p);
      const L = lab(p);
      while (st.length) {
        const q = st.pop(),
          qx = q % N,
          qy = (q / N) | 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = qx + dx,
            ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const m = ny * N + nx;
          if (lab(m) === L) {
            if (!seen[m]) {
              seen[m] = 1;
              st.push(m);
            }
          } else bnd++;
        }
      }
    }
    return { n, bnd: bnd / 2 };
  };
  const cs1 = comps((p) => stack[p]),
    ct = comps((p) => top[p]);
  console.log(
    `${path.basename(file)} @${N}: fill paints ${paints}, authored segments ${segs}; faces by stack ${cs1.n} (face-boundary length ${cs1.bnd} px), by top paint ${ct.n} (${ct.bnd} px)`,
  );
}
