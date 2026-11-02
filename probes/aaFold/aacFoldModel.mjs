// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacFoldModel.mjs -- raw AAC's fill rule inside a pixel. AAC integrates the signed winding over the
// pixel cell exactly and folds that integral with the fill rule: coverage = fold(mean winding). That is the exact area only
// where every boundary in the pixel separates the same two winding levels; where two boundaries of one path cross or nest
// inside one pixel, the fold of the integral is not the integral of the fold. Its CPU model is therefore just the fold of the
// supersampled MEAN WINDING, against the supersampled MEAN FILL STATE on the same samples -- the two share their samples, so
// their difference is the fill-rule discrepancy alone (no sampling noise at pixels with one winding level).
//
//   node probes/aaFold/aacFoldModel.mjs --assets a.svg[,b.svg] --sizes 32,512 [--list N] [--ss 16]
//   prints, per asset and size: shapes whose path has more than one contour, pixels off by > 1 byte / > 8 bytes, max byte.
import { readFileSync } from 'fs';
import path from 'path';
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const TREE = path.resolve(
  flag('tree', path.join(path.dirname(new URL(import.meta.url).pathname), '../..')),
);
if (typeof DOMParser === 'undefined') {
  const x = await import(path.join(TREE, '../node_modules/@xmldom/xmldom/lib/index.js'));
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const src = (p) => import(path.join(TREE, p));
const { default: importSvg } = await src('src/svg/importer.js');
const CB = await src('src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await src('src/geom/lbContour.js');
const { segPt } = await src('src/geom/cpatchImplicit.js');
const SS = +flag('ss', 16),
  LIST = +flag('list', 0),
  DROP = argv.includes('--drop');
const { droppedContourIndices } = await src('src/svg/fillNormalize.js');
export function flatten(cs) {
  const segs = [];
  for (const c of cs) {
    const a0 = c[0].P[0],
      z = c[c.length - 1].P[c[c.length - 1].P.length - 1];
    for (const g of a0[0] === z[0] && a0[1] === z[1] ? c : [...c, { t: 'line', P: [z, a0] }]) {
      const n = g.P.length === 2 ? 1 : 64;
      let prev = g.P[0];
      for (let k = 1; k <= n; k++) {
        const q = k === n ? g.P[g.P.length - 1] : segPt(g, k / n);
        segs.push([prev, q]);
        prev = q;
      }
    }
  }
  return segs;
}
// exact fill-state coverage E and the AAC model M = fold(mean winding), per pixel
export function eAndM(segs, evenOdd, x0, y0, epp, W, H, ss = SS) {
  const E = new Float64Array(W * H),
    Wm = new Float64Array(W * H),
    C = new Float64Array(W * H);
  for (let j = 0; j < H; j++)
    for (let sy = 0; sy < ss; sy++) {
      const y = y0 + (j + (sy + 0.5) / ss) * epp,
        xs = [];
      for (const [a, c] of segs)
        if (a[1] <= y !== c[1] <= y)
          xs.push([a[0] + ((y - a[1]) / (c[1] - a[1])) * (c[0] - a[0]), c[1] > a[1] ? 1 : -1]);
      if (!xs.length) continue;
      xs.sort((p, q) => p[0] - q[0]);
      for (let i = 0; i < W; i++)
        for (let sx = 0; sx < ss; sx++) {
          const x = x0 + (i + (sx + 0.5) / ss) * epp;
          let w = 0,
            c = 0;
          for (const [cx, dw] of xs) {
            if (cx > x) {
              w += dw;
              c++;
            }
          }
          if (evenOdd ? c & 1 : w !== 0) E[j * W + i]++;
          Wm[j * W + i] += w;
        }
    }
  const n = ss * ss,
    M = new Float64Array(W * H);
  for (let k = 0; k < E.length; k++) {
    E[k] /= n;
    const w = Wm[k] / n;
    // aacFold: nonzero = min(|w|, 1); even-odd = the triangle wave of |w|
    if (evenOdd) {
      const a = Math.abs(w) % 2;
      M[k] = a > 1 ? 2 - a : a;
    } else M[k] = Math.min(Math.abs(w), 1);
  }
  return { E, M };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  for (const file of flag('assets').split(',')) {
    const svg = readFileSync(file, 'utf8');
    const b = CB.headlessCPatchBundle(await importSvg(svg, { preserveViewport: true }));
    const cf = CB.cpatchCurvePlane(b);
    let dropped = 0;
    const shapes = [];
    let X0 = Infinity,
      Y0 = Infinity,
      X1 = -Infinity,
      Y1 = -Infinity;
    for (let s = 0; s < b.curveRangesByShape.length; s++) {
      const r = b.curveRangesByShape[s];
      const cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
      if (!cs.length) continue;
      let csUse = cs;
      if (DROP) {
        const d = droppedContourIndices(
          cs.map((c) =>
            c.map((g) => ({ type: g.t === 'line' ? 0 : 9, p1: g.P[0], p2: g.P[g.P.length - 1] })),
          ),
          CB.shapeEvenOdd(b, s),
        );
        if (d) {
          csUse = cs.filter((_, i) => !d.has(i));
          dropped++;
        }
      }
      for (const c of cs)
        for (const g of c)
          for (const q of g.P) {
            X0 = Math.min(X0, q[0]);
            X1 = Math.max(X1, q[0]);
            Y0 = Math.min(Y0, q[1]);
            Y1 = Math.max(Y1, q[1]);
          }
      shapes.push({ s, cs: csUse, eo: CB.shapeEvenOdd(b, s) });
    }
    for (const N of flag('sizes', '32').split(',').map(Number)) {
      let ext = Math.max(X1 - X0, Y1 - Y0),
        epp = ext / N,
        W = Math.ceil((X1 - X0) / epp) + 8,
        H = Math.ceil((Y1 - Y0) / epp) + 8,
        x0 = X0 - 4 * epp,
        y0 = Y0 - 4 * epp;
      if (flag('vb')) {
        const [vx, vy, vw] = flag('vb').split(',').map(Number);
        epp = vw / N;
        x0 = vx;
        y0 = vy;
        W = H = N;
      } // the authored viewBox mapped to N px, as the GPU controls draw it
      let n1 = 0,
        n8 = 0,
        mx = 0,
        multi = 0,
        hit = 0;
      const list = [];
      for (const sh of shapes) {
        if (sh.cs.length < 2) continue;
        multi++;
        const { E, M } = eAndM(flatten(sh.cs), sh.eo, x0, y0, epp, W, H);
        let any = false;
        for (let k = 0; k < E.length; k++) {
          const d = Math.abs(E[k] - M[k]) * 255;
          if (d > 1) {
            n1++;
            any = true;
            if (d > 8) n8++;
            if (d > mx) mx = d;
            if (list.length < LIST)
              list.push(
                `  shape ${sh.s} px(${k % W},${(k / W) | 0}) E ${E[k].toFixed(3)} M ${M[k].toFixed(3)} err ${d.toFixed(1)}`,
              );
          }
        }
        if (any) hit++;
      }
      console.log(
        `${path.basename(file)} @${N}: shapes ${shapes.length} (multi-contour ${multi}, with error ${hit})  px>1B ${n1}  px>8B ${n8}  max ${mx.toFixed(1)}B`,
      );
      if (DROP) console.log(`   shapes with a contained contour dropped: ${dropped}`);
      for (const l of list) console.log(l);
    }
  }
}
