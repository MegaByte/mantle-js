// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSkirtReachSmoke — every pixel the shape reaches is reached by some CPatch cover (the skirt part).
//
// A patch's cover is its hull plus a skirt: a quad per outline edge, pushed out by the filter's reach, so the AA band
// outside the edge has fragments to paint. The quad's outer corners are the miter points of neighbouring offset lines,
// capped at 1.05 reach so a shallow corner does not balloon. AGAINST A SEAM AT A SHARP CORNER that cap starves the
// band: the exact miter point runs far out along the seam line, capped it lies nearly along the edge, and the quad
// tapers from the full reach at the far end to almost nothing at the corner -- pixel centers a fraction of a pixel
// outside the edge, which the shape covers by up to a fifth, would get no fragment from anyone (the star below: 89 of
// them at 512 px; tiger 912). So there the corner squares off: the edge's own normal times its reach.
//
// PINNED on the star (sharp spikes, seams at their tips), at 256 and 512 px: the pixels whose exact coverage exceeds
// 32/255 and that no CPatch cover triangle reaches -- 0 (89 at 512 px with the capped miter). No GPU: the covers are rasterized as the
// vertex stage dilates them (top-left rule), the coverage is 12x12 samples of the shape's own fill.
import { readFileSync } from 'fs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const CB = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { LB_STRIDE } = await import('../src/renderer/cpatchPack.js');
const { segPt } = await import('../src/geom/cpatchImplicit.js');

const svg = readFileSync(
  new URL('../examples/smoke/engineDeclineIsolation__STAR.svg', import.meta.url),
  'utf8',
);
const b = CB.headlessCPatchBundle(await importSvg(svg));
const cf = CB.cpatchCurvePlane(b);
const gl = {
  TEXTURE_2D: 1,
  texImage2D() {},
  bindTexture() {},
  texParameteri() {},
  texSubImage2D() {},
  deleteTexture() {},
  createTexture() {
    return {};
  },
};
CB.buildCPatchBundle(gl, b, { pool: false });
const shapes = [];
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
b.curveRangesByShape.forEach((r, s) => {
  const m = (b._lbMeshes || [])[s];
  if (!m || !m.cpatch) return;
  const cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
  shapes.push({ m, cs, eo: CB.shapeEvenOdd(b, s) });
  for (const c of cs)
    for (const g of c)
      for (const q of g.P) {
        x0 = Math.min(x0, q[0]);
        x1 = Math.max(x1, q[0]);
        y0 = Math.min(y0, q[1]);
        y1 = Math.max(y1, q[1]);
      }
});
ok(shapes.length > 0, `the star packs as CPatch (${shapes.length} shape)`);

function reached(m, epp, fx0, fy0, W, H) {
  const hit = new Set(),
    S = LB_STRIDE,
    v = m.verts;
  for (let tri = 0; (tri + 1) * 3 * S <= v.length; tri++) {
    const q = [0, 1, 2].map((k) => {
      const o = (tri * 3 + k) * S;
      return [v[o] + v[o + 17] + v[o + 2] * 1.5 * epp, v[o + 1] + v[o + 18] + v[o + 3] * 1.5 * epp];
    });
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const Q = area > 0 ? q : [q[0], q[2], q[1]];
    const edge = (a, c, p) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
    const inE = (w, a, c) =>
      w > 0 || (w === 0 && (c[1] - a[1] < 0 || (c[1] === a[1] && c[0] > a[0])));
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - fx0) / epp - 0.5)),
      i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - fx0) / epp));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - fy0) / epp - 0.5)),
      j1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - fy0) / epp));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = [fx0 + (i + 0.5) * epp, fy0 + (j + 0.5) * epp];
        if (
          inE(edge(Q[1], Q[2], p), Q[1], Q[2]) &&
          inE(edge(Q[2], Q[0], p), Q[2], Q[0]) &&
          inE(edge(Q[0], Q[1], p), Q[0], Q[1])
        )
          hit.add(j * W + i);
      }
  }
  return hit;
}
function exact(cs, eo, epp, fx0, fy0, W, H, SS = 12) {
  const segs = [];
  for (const c of cs) {
    const a = c[0].P[0],
      z = c[c.length - 1].P[c[c.length - 1].P.length - 1];
    const cc = a[0] === z[0] && a[1] === z[1] ? c : [...c, { t: 'line', P: [z, a] }];
    for (const g of cc) {
      const n = g.t === 'line' ? 1 : 64;
      let prev = g.P[0];
      for (let k = 1; k <= n; k++) {
        const q = k === n ? g.P[g.P.length - 1] : segPt(g, k / n);
        segs.push([prev, q]);
        prev = q;
      }
    }
  }
  const out = new Map();
  for (let j = 0; j < H; j++)
    for (let sy = 0; sy < SS; sy++) {
      const y = fy0 + (j + (sy + 0.5) / SS) * epp,
        xs = [];
      for (const [a, c] of segs)
        if (a[1] <= y !== c[1] <= y)
          xs.push([a[0] + ((y - a[1]) / (c[1] - a[1])) * (c[0] - a[0]), c[1] > a[1] ? 1 : -1]);
      if (!xs.length) continue;
      xs.sort((u, v) => u[0] - v[0]);
      let w = 0,
        k = 0;
      for (let i = 0; i < W; i++)
        for (let sx = 0; sx < SS; sx++) {
          const x = fx0 + (i + (sx + 0.5) / SS) * epp;
          while (k < xs.length && xs[k][0] <= x) w += xs[k++][1];
          if (eo ? w & 1 : w !== 0) out.set(j * W + i, (out.get(j * W + i) || 0) + 1 / (SS * SS));
        }
      w = 0;
      k = 0;
    }
  return out;
}
for (const N of [256, 512]) {
  const epp = Math.max(x1 - x0, y1 - y0) / N,
    W = Math.ceil((x1 - x0) / epp) + 8,
    H = Math.ceil((y1 - y0) / epp) + 8;
  const fx0 = x0 - 4 * epp,
    fy0 = y0 - 4 * epp;
  let missed = 0,
    inked = 0;
  for (const sh of shapes) {
    const hit = reached(sh.m, epp, fx0, fy0, W, H),
      ex = exact(sh.cs, sh.eo, epp, fx0, fy0, W, H);
    for (const [px, e] of ex) {
      if (e <= 32 / 255) continue;
      inked++;
      if (!hit.has(px)) missed++;
    }
  }
  ok(
    inked > 1000 && missed === 0,
    `at ${N} px every pixel the star covers past 32/255 has a cover fragment (${missed} of ${inked} have none)`,
  );
}
console.log(fail ? `cpatchSkirtReachSmoke FAIL (${fail})` : 'cpatchSkirtReachSmoke PASS');
process.exit(fail ? 1 : 0);
