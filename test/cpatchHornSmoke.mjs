// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchHornSmoke — a cubic that ends at its own curve's cusp takes the arc's side there.
//
// THE TRAP. A cubic with a zero-length handle at an end (P0 = P1 or P2 = P3, exactly -- tiger has 1,360 such
// ends of 2,823 cubics) ends at a cusp of its own algebraic curve: the extension past the cusp leaves along the same
// tangent on the other side, and near the tip the implicit's sign is the cusp's -- across the arc it need not change,
// and its gradient vanishes at the tip. Read as is, the implicit says inside where the pixel is outside (tiger #20:
// 0.44 painted where the path covers 0.03), and an exact pair of that constraint with a seam on the same curve bounds
// a strip of nothing (0 painted where the path covers 0.49).
//
// THE RULE. The packer flags such an arc (CPK_HORN0/1, and _RIGHT where the patch loop runs clockwise) unless the loop
// goes on through the cusp along the same curve (a notch, where the implicit is right). Within the filter's reach of
// the arc the kernel takes the arc's own side and normal -- at an interior foot, the arc's normal; at the cusp, the
// tangent line through the tip -- and keeps that constraint out of a seam's exact piece. Tiger at 512 px: off by more
// than 32/255 5179 -> 4568 with the rule, by half 65 -> 47 (with the seam companion 3660/42 -> 2982/22); shapes with no
// such arc (star, Roboto, FAR) are untouched.
//
// PINNED through the float32 kernel twin on four horn shapes at 64 and 256 px, against the exact coverage (rows exact
// in x, 32 slices in y): the summed error with the rule is below the same pack with its horn bits stripped on every
// one, by more than 5% on five of the eight, and the result is the same at 2^-10, 1 and 2^10 scale. (Owned seams take
// much of the same error off without the rule -- thorn at 256 px 2.795 -> 1.871 -- so the rule's own share there is 4%.)
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const T = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.warn = () => {};
const E = await import('./_glslEmu.mjs');
if (!E.hasCxx()) {
  console.log('  SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}
const { default: importSvg } = await import('../src/svg/importer.js');
const CB = await import('../src/renderer/cpatchBuild.js');
const { rowSpans } = await import('../src/renderer/cpatchConvert.js');
const { LB_STRIDE } = await import('../src/renderer/cpatchPack.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const emu = E.buildGlslEmu(T, { cpatch: true });
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
/// One shape through the twin: every CPatch cover fragment at N px, the patches OVER-composited, against the exact
/// coverage. `strip` clears the horn bits from every constraint's kind word first -- the same pack without the rule.
async function score(d, N, strip, K = 1) {
  const sd = d.replace(/-?[0-9.]+/g, (v) => String(+v * K));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-10 * K} ${-60 * K} ${120 * K} ${120 * K}"><path fill="#000" d="${sd}"/></svg>`;
  const b = CB.headlessCPatchBundle(await importSvg(svg));
  const cf = CB.cpatchCurvePlane(b);
  const gl = {
    TEXTURE_2D: 1,
    texImage2D(...a) {
      gl.plane = a[8];
    },
    bindTexture() {},
    texParameteri() {},
    texSubImage2D() {},
    deleteTexture() {},
    createTexture() {
      return {};
    },
  };
  CB.buildCPatchBundle(gl, b, { pool: false });
  const m = b._lbMeshes[0];
  if (!m || !m.cpatch) return null;
  const plane = new Float32Array(gl.plane);
  let horns = 0;
  for (let k = 3; k < plane.length; k += 28) {
    const w = plane[k];
    if (w >= 4096) {
      horns++;
      if (strip) plane[k] = w % 4096;
    }
  }
  const r = b.curveRangesByShape[0];
  const curves = [].concat(
    ...CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null),
  );
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of curves)
    for (const q of s.P) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
  const epp = Math.max(x1 - x0, y1 - y0) / N,
    W = Math.ceil((x1 - x0) / epp) + 6,
    H = Math.ceil((y1 - y0) / epp) + 6,
    fx = x0 - 3 * epp,
    fy = y0 - 3 * epp;
  const S = LB_STRIDE,
    qs = [],
    pix = [];
  for (let tri = 0; (tri + 1) * 3 * S <= m.verts.length; tri++) {
    const vs = [0, 1, 2].map((k) => m.verts.subarray((tri * 3 + k) * S, (tri * 3 + k + 1) * S));
    const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]);
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
      Q = o.map((k) => q[k]),
      Wv = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, c, p) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
    const inE = (w, a, c) =>
      w > 0 || (w === 0 && (c[1] - a[1] < 0 || (c[1] === a[1] && c[0] > a[0])));
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - fx) / epp - 0.5)),
      i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - fx) / epp));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - fy) / epp - 0.5)),
      j1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - fy) / epp));
    const f = Wv[2];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = [fx + (i + 0.5) * epp, fy + (j + 0.5) * epp];
        const w0 = edge(Q[1], Q[2], p),
          w1 = edge(Q[2], Q[0], p),
          w2 = edge(Q[0], Q[1], p);
        if (!(inE(w0, Q[1], Q[2]) && inE(w1, Q[2], Q[0]) && inE(w2, Q[0], Q[1]))) continue;
        const tc = [2, 3, 4].map((c) => (w0 * Wv[0][c] + w1 * Wv[1][c] + w2 * Wv[2][c]) / area);
        qs.push({
          k: E.K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [p[0] - f[17], p[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
        });
        pix.push(j * W + i);
      }
  }
  const cov = emu.run(new Float32Array(4), plane, qs);
  const acc = new Map();
  pix.forEach((px, k) =>
    acc.set(px, 1 - (1 - (acc.get(px) ?? 0)) * (1 - Math.max(0, Math.min(1, cov[k])))),
  );
  let off32 = 0,
    half = 0,
    sum = 0;
  const SL = 32;
  for (let j = 0; j < H; j++) {
    const rows = [];
    for (let s = 0; s < SL; s++)
      rows.push(rowSpans(curves, fy + (j + (s + 0.5) / SL) * epp, false));
    for (let i = 0; i < W; i++) {
      const xa = fx + i * epp,
        xb = xa + epp;
      let a = 0;
      for (const sp of rows)
        for (const q of sp) {
          const lo = Math.max(q[0], xa),
            hi = Math.min(q[1], xb);
          if (hi > lo) a += hi - lo;
        }
      const e = a / (epp * SL),
        g = acc.get(j * W + i) ?? 0,
        dd = Math.abs(g - e);
      sum += dd;
      if (dd > 32 / 255) off32++;
      if (dd >= 0.5) half++;
    }
  }
  return { horns, off32, half, sum };
}
const shapes = {
  thorn: 'M0 0 C0 0 60 10 100 50 C80 20 40 -5 0 0 Z',
  hook: 'M0 0 C0 0 30 -40 90 -30 C60 -20 30 -10 0 0 Z',
  leaf: 'M0 0 C0 0 50 -40 100 0 C50 40 0 0 0 0 Z',
  claw: 'M10 40 C40 40 70 20 90 -40 C90 -40 60 0 10 0 Z',
};
let better = 0;
for (const [name, d] of Object.entries(shapes))
  for (const N of [64, 256]) {
    const a = await score(d, N, true),
      b = await score(d, N, false);
    if (b.sum < 0.95 * a.sum) better++;
    ok(
      b.horns > 0 && b.sum <= a.sum + 1e-9,
      `${name} at ${N} px: ${b.horns} horn arc(s); summed error ${b.sum.toFixed(3)} with the rule, ${a.sum.toFixed(3)} without (off >32/255 ${b.off32} / ${a.off32})`,
    );
  }
ok(
  better >= 5,
  `the rule takes more than 5% off the error on ${better} of the eight (bar 5; the hook's is mostly its seams)`,
);
const base = await score(shapes.thorn, 256, false);
for (const K of [1 / 1024, 1024]) {
  const s = await score(shapes.thorn, 256, false, K);
  ok(
    s.off32 === base.off32 && Math.abs(s.sum - base.sum) < 1e-3,
    `thorn at x${K}: off >32/255 ${s.off32}, summed error ${s.sum.toFixed(4)} (at x1: ${base.off32}, ${base.sum.toFixed(4)})`,
  );
}
console.log(fail ? `cpatchHornSmoke FAIL (${fail})` : 'cpatchHornSmoke PASS');
process.exit(fail ? 1 : 0);
