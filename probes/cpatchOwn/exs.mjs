// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// exs.mjs -- exact coverage of a tree's CPatch kernel (float32 twin, test/_glslEmu.mjs), shape by shape: every CPatch cover triangle
// rasterized as the vertex stage dilates it, run through the kernel, OVER-composited per shape, against 12x12-sample exact
// coverage in the shape's fill rule. Prints per asset and size: pixels off by more than 32/255, off by half or more, fragments.
//   node probes/cpatchOwn/exs.mjs [--tree T] --assets file.svg[,..] --sizes 32,128 [--list N] [--xf rot:deg]
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
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const src = (p) => import(path.join(TREE, p));
const { default: importSvg } = await src('src/svg/importer.js');
const CB = await src('src/renderer/cpatchBuild.js');
const { LB_STRIDE } = await src('src/renderer/cpatchPack.js');
const { curveRangeToContours } = await src('src/geom/lbContour.js');
const { segPt } = await src('src/geom/cpatchImplicit.js');
const { buildGlslEmu, K_CPATCH_COV, K_CPATCH_CURVE } = await src('test/_glslEmu.mjs');
const AT = flag('at') ? flag('at').split(',').map(Number) : null; // --at shape,x,y: per-constraint answers of every fragment there
if (argv.includes('--noarea')) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_AREA = 1;
}
if (argv.includes('--nocont')) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_CONT = 1;
}
if (argv.includes('--comp')) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_COMP_ON = 1;
}
const emu = buildGlslEmu(TREE, {
  cpatch: true,
  defines: argv.includes('--comp') ? ['MANTLE_CPATCH_COMP'] : [],
});
const LIST = +flag('list', 0);
const gl = {
  TEXTURE_2D: 1,
  RGBA32F: 2,
  RGBA: 3,
  FLOAT: 4,
  TEXTURE_MIN_FILTER: 5,
  TEXTURE_MAG_FILTER: 6,
  NEAREST: 7,
  TEXTURE_WRAP_S: 8,
  TEXTURE_WRAP_T: 9,
  CLAMP_TO_EDGE: 10,
  plane: null,
  bindTexture() {},
  texParameteri() {},
  texSubImage2D() {},
  deleteTexture() {},
  createTexture() {
    return {};
  },
};
gl.texImage2D = (...a) => {
  gl.plane = a[8];
};
function paint(m, plane, epp, x0, y0, W, H) {
  const S = LB_STRIDE,
    verts = m.verts,
    qs = [],
    owners = [];
  for (let tri = 0; (tri + 1) * 3 * S <= verts.length; tri++) {
    const vs = [0, 1, 2].map((k) => verts.subarray((tri * 3 + k) * S, (tri * 3 + k + 1) * S));
    const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]);
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
      Q = o.map((k) => q[k]),
      V = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const tl = (a, b) => b[1] - a[1] < 0 || (b[1] === a[1] && b[0] > a[0]);
    const inE = (w, a, b) => w > 0 || (w === 0 && tl(a, b));
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / epp - 0.5)),
      i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - x0) / epp));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / epp - 0.5)),
      j1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - y0) / epp));
    const f = V[2];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = [x0 + (i + 0.5) * epp, y0 + (j + 0.5) * epp];
        const w0 = edge(Q[1], Q[2], p),
          w1 = edge(Q[2], Q[0], p),
          w2 = edge(Q[0], Q[1], p);
        if (!(inE(w0, Q[1], Q[2]) && inE(w1, Q[2], Q[0]) && inE(w2, Q[0], Q[1]))) continue;
        const tc = [2, 3, 4].map((c) => (w0 * V[0][c] + w1 * V[1][c] + w2 * V[2][c]) / area);
        qs.push({
          k: K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [p[0] - f[17], p[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
        });
        owners.push(j * W + i);
      }
  }
  const got = qs.length ? emu.run(new Float32Array(4), plane, qs) : [];
  if (AT && AT[0] === m.__shape)
    for (let k = 0; k < got.length; k++)
      if (owners[k] === AT[2] * W + AT[1]) {
        const q = qs[k],
          first = Math.round(q.ePx[0]),
          n = Math.round(q.ePx[1]),
          cq = [];
        for (let i = 0; i < n; i++)
          for (let w = 0; w < 9; w++)
            cq.push({
              k: K_CPATCH_CURVE,
              GD: [w, first + i, 0, 0],
              bb: [0, 0, 0, 0],
              c: q.c,
              ex: [0, 0, 0, 0, 0, epp],
            });
        const r = emu.run(new Float32Array(4), plane, cq);
        console.log(
          `  FRAG run ${first} n ${n} cov ${got[k].toFixed(4)} tc ${q.ex.slice(0, 3).map((v) => +v.toFixed(3))} p ${q.c.map((v) => +v.toFixed(3))} world ${[q.c[0] + m.verts[17], q.c[1] + m.verts[18]].map((v) => +v.toFixed(3))} epp ${+epp.toFixed(4)}`,
        );
        for (let i = 0; i < n; i++) {
          const v = r.subarray(i * 9, i * 9 + 9);
          console.log(
            `    c${i} kind ${plane[(first + i) * 28 + 3]} cov ${v[0].toFixed(3)} soft ${v[1].toFixed(3)} near ${v[2]} sd ${v[3].toFixed(3)} n (${v[4].toFixed(2)},${v[5].toFixed(2)}) cut ${v[6]} hull ${v[7]}`,
          );
        }
      }
  const img = new Float64Array(W * H).fill(1);
  for (let k = 0; k < got.length; k++) img[owners[k]] *= 1 - Math.max(0, Math.min(1, got[k]));
  for (let k = 0; k < img.length; k++) img[k] = 1 - img[k];
  return { img, frags: qs.length };
}
function flatten(cs) {
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
function exact(segs, evenOdd, x0, y0, epp, W, H) {
  const SS = 12,
    out = new Float64Array(W * H);
  for (let j = 0; j < H; j++)
    for (let sy = 0; sy < SS; sy++) {
      const y = y0 + (j + (sy + 0.5) / SS) * epp,
        xs = [];
      for (const [a, c] of segs)
        if (a[1] <= y !== c[1] <= y)
          xs.push([a[0] + ((y - a[1]) / (c[1] - a[1])) * (c[0] - a[0]), c[1] > a[1] ? 1 : -1]);
      if (!xs.length) continue;
      xs.sort((p, q) => p[0] - q[0]);
      for (let i = 0; i < W; i++)
        for (let sx = 0; sx < SS; sx++) {
          const x = x0 + (i + (sx + 0.5) / SS) * epp;
          let w = 0,
            c = 0;
          for (const [cx, dw] of xs) {
            if (cx > x) {
              w += dw;
              c++;
            }
          }
          if (evenOdd ? c & 1 : w !== 0) out[j * W + i]++;
        }
    }
  for (let k = 0; k < out.length; k++) out[k] /= SS * SS;
  return out;
}
for (const file of flag('assets').split(',')) {
  const svg = readFileSync(file, 'utf8');
  const b = CB.headlessCPatchBundle(await importSvg(svg, { preserveViewport: true }));
  const cf = CB.cpatchCurvePlane(b);
  b.curveTex = {};
  if (!CB.buildCPatchBundle(gl, b, { pool: false })) {
    console.log(`${file}: CPatch built nothing: ${b._cpatchBail}`);
    continue;
  }
  const plane = gl.plane;
  // content bbox over all shapes
  const shapes = [];
  let X0 = Infinity,
    Y0 = Infinity,
    X1 = -Infinity,
    Y1 = -Infinity;
  for (let s = 0; s < b.curveRangesByShape.length; s++) {
    const r = b.curveRangesByShape[s],
      m = b._lbMeshes[s];
    if (!m || !m.vertexCount) continue;
    const cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
    for (const c of cs)
      for (const g of c)
        for (const q of g.P) {
          X0 = Math.min(X0, q[0]);
          X1 = Math.max(X1, q[0]);
          Y0 = Math.min(Y0, q[1]);
          Y1 = Math.max(Y1, q[1]);
        }
    m.__shape = s;
    shapes.push({ s, m, cs });
  }
  for (const N of flag('sizes', '128').split(',').map(Number)) {
    const ext = Math.max(X1 - X0, Y1 - Y0),
      epp = ext / N,
      W = Math.ceil((X1 - X0) / epp) + 8,
      H = Math.ceil((Y1 - Y0) / epp) + 8,
      x0 = X0 - 4 * epp,
      y0 = Y0 - 4 * epp;
    let off = 0,
      half = 0,
      frags = 0;
    const list = [];
    for (const sh of shapes) {
      const { img, frags: f } = paint(sh.m, plane, epp, x0, y0, W, H);
      frags += f;
      const ex = exact(flatten(sh.cs), CB.shapeEvenOdd(b, sh.s), x0, y0, epp, W, H);
      for (let k = 0; k < img.length; k++) {
        const d = Math.abs(img[k] - ex[k]);
        if (d > 32 / 255) {
          off++;
          if (d >= 0.5) half++;
          if (list.length < LIST && (!argv.includes('--half') || d >= 0.5))
            list.push(
              `  shape ${sh.s} px (${k % W},${Math.floor(k / W)}) got ${img[k].toFixed(3)} exact ${ex[k].toFixed(3)}`,
            );
        }
      }
    }
    console.log(
      `${path.basename(file)} @${N}: off>32/255 ${off}  off>=0.5 ${half}  frags ${frags}`,
    );
    for (const l of list) console.log(l);
  }
}
