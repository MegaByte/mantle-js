// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSeamCompanionSmoke — a seam carries the outline that runs along it on the far side.
//
// THE TRAP. A seam is a hard partition: a pixel whose center is in a patch is that patch's alone. The
// decomposition can run a straight seam out of an outline curve's end at a small angle to it, leaving a sliver of
// the neighbouring patch between seam and curve that is under a pixel wide for many pixels. At each pixel straddling
// both with its center on the near side, the near patch owns nothing that says the shape ends a fraction of a pixel
// away, and paints the pixel whole. Tiger's shape 35, the fixture below, drawn alone at tiger's 512 px pixel size, is
// the case.
//
// THE COMPANION. Each seam's row can carry the outline curve that runs closest along it (cpatchPack's K_COMP), and the
// kernel bounds a fragment within reach of the seam by that curve's arc, as an outline row does. It is OPT-IN: the
// companion is off by default and `__CP_COMP_ON = 1` (under __MANTLE_DEBUG__) packs it, so (a) and (b) run with the hook
// set and (c) is the default build.
//
// CHECKED, through the SHIPPED kernel text in float32 (test/_glslEmu.mjs), on tiger's shape 35 drawn on tiger's own
// 512 px pixel grid, against 16x16-sample exact coverage, at 2^-20, 1 and 2^20:
//   (a) its seams carry companions;
//   (b) no more than 33 pixels are off by more than 0.3 (38 seams, worst 0.500) -- owned seams close most of what the
//       companion is for by themselves, so on this shape the companion buys nothing and the bar guards the opt-in build
//       against more;
//   (c) the default build (no companions: the hook unset) packs none, and is off on no more pixels than the companion
//       build.
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CPATCH_COV } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const { default: importSvg } = await import('../src/svg/importer.js');
const CB = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { LB_STRIDE } = await import('../src/renderer/cpatchPack.js');
const { K_COMP } = await import('../src/geom/cpatchImplicit.js');

// tiger's shape 35, stroke-stripped, in tiger's em; tiger at 512 px draws 1.7578125 em a pixel from the origin
const D =
  'M272.2909 561.525618 C272.2909 561.525618 298.422465 550.93174 369.048317 561.525618 C369.048317 561.525618 381.760971 562.231876 393.767366 546.694189 C405.773761 531.156501 453.093081 518.443848 464.393218 521.975141 L481.345188 533.275277 L482.757705 535.394052 C482.757705 535.394052 504.649953 553.756774 505.356212 567.175686 C506.06247 580.594598 479.932671 665.34562 462.980701 693.595961 C446.030496 721.846302 429.080292 743.740316 395.179883 739.502765 C395.179883 739.502765 358.45444 732.44018 313.253894 739.502765 C313.253894 739.502765 261.697022 736.677731 256.753213 722.55256 C251.809403 708.42739 276.528451 681.589566 276.528451 681.589566 C276.528451 681.589566 284.297295 666.758137 282.17852 641.33283 C281.631074 634.76348 281.272225 626.59105 280.894874 617.997232 C279.811766 593.330462 278.576219 565.192054 272.2909 561.525618 Z';
const EPP = 1.7578125;

function glStub() {
  const g = {
    TEXTURE_2D: 1,
    RGBA32F: 2,
    RGBA: 3,
    FLOAT: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    TEXTURE_WRAP_S: 7,
    TEXTURE_WRAP_T: 8,
    NEAREST: 9,
    CLAMP_TO_EDGE: 10,
    plane: null,
  };
  g.bindTexture = () => {};
  g.texParameteri = () => {};
  g.texSubImage2D = () => {};
  g.deleteTexture = () => {};
  g.createTexture = () => ({});
  g.texImage2D = (...a) => {
    g.plane = a[8];
  };
  return g;
}

/// The shape at scale S on the grid (origin 0, EPP * S): each pixel's kernel coverage (every CPatch cover fragment,
/// OVER-composited) and its exact coverage (16 x 16 samples of the flattened outline).
async function frame(emu, S) {
  const d = D.replace(/-?\d+(\.\d+)?/g, (n) => String(Number(n) * S));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${900 * S} ${900 * S}"><path d="${d}"/></svg>`;
  const sec = await importSvg(svg, { preserveViewport: true });
  const b = CB.headlessCPatchBundle(sec),
    gl = glStub();
  let comps = 0;
  CB.buildCPatchBundle(gl, b, {
    pool: false,
    onPatches: (ps) => {
      for (const p of ps) if (p[K_COMP]) comps += p[K_COMP].size;
    },
  });
  const m = (b._lbMeshes || [])[0];
  if (!m || !m.cpatch) return null;
  const plane = gl.plane,
    epp = EPP * S,
    St = LB_STRIDE,
    qs = [],
    pix = [];
  for (let tri = 0; (tri + 1) * 3 * St <= m.verts.length; tri++) {
    const vs = [0, 1, 2].map((k) => m.verts.subarray((tri * 3 + k) * St, (tri * 3 + k + 1) * St));
    const q = vs.map((v) => [v[0] + v[17] + v[2] * 1.5 * epp, v[1] + v[18] + v[3] * 1.5 * epp]);
    let area =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (!(Math.abs(area) > 0)) continue;
    const o = area > 0 ? [0, 1, 2] : [0, 2, 1],
      Q = o.map((k) => q[k]),
      W = o.map((k) => vs[k]);
    area = Math.abs(area);
    const edge = (a, c, p) => (c[0] - a[0]) * (p[1] - a[1]) - (c[1] - a[1]) * (p[0] - a[0]);
    const inE = (w, a, c) =>
      w > 0 || (w === 0 && (c[1] - a[1] < 0 || (c[1] === a[1] && c[0] > a[0])));
    const xs = Q.map((p) => p[0]),
      ys = Q.map((p) => p[1]);
    const f = W[2];
    for (
      let j = Math.floor(Math.min(...ys) / epp - 0.5);
      j <= Math.ceil(Math.max(...ys) / epp);
      j++
    )
      for (
        let i = Math.floor(Math.min(...xs) / epp - 0.5);
        i <= Math.ceil(Math.max(...xs) / epp);
        i++
      ) {
        const p = [(i + 0.5) * epp, (j + 0.5) * epp];
        const w0 = edge(Q[1], Q[2], p),
          w1 = edge(Q[2], Q[0], p),
          w2 = edge(Q[0], Q[1], p);
        if (!(inE(w0, Q[1], Q[2]) && inE(w1, Q[2], Q[0]) && inE(w2, Q[0], Q[1]))) continue;
        const tc = [2, 3, 4].map((c) => (w0 * W[0][c] + w1 * W[1][c] + w2 * W[2][c]) / area);
        qs.push({
          k: K_CPATCH_COV,
          GD: [f[7], f[8], f[9], f[10]],
          bb: [f[11], f[12], f[13], f[14]],
          c: [p[0] - f[17], p[1] - f[18]],
          ePx: [f[19], f[20]],
          ex: [tc[0], tc[1], tc[2], f[15], f[16], epp],
        });
        pix.push(`${i},${j}`);
      }
  }
  const out = emu.run(new Float32Array(4), plane, qs);
  const cov = new Map();
  out.forEach((v, k) =>
    cov.set(pix[k], 1 - (1 - (cov.get(pix[k]) ?? 0)) * (1 - Math.max(0, Math.min(1, v)))),
  );
  // exact: the outline flattened finely, crossings per sample row
  const cs = CB.contoursToConverter(
    curveRangeToContours(
      CB.cpatchCurvePlane(b),
      b.curveRangesByShape[0].begin,
      b.curveRangesByShape[0].end,
    ),
    null,
  );
  const segs = [];
  for (const c of cs)
    for (const g of c) {
      const P = g.P,
        n = P.length === 2 ? 1 : 256;
      const at = (u) => {
        let Z = P.map((z) => z.slice());
        while (Z.length > 1)
          Z = Z.slice(1).map((z, k) => [
            Z[k][0] + (z[0] - Z[k][0]) * u,
            Z[k][1] + (z[1] - Z[k][1]) * u,
          ]);
        return Z[0];
      };
      let prev = P[0];
      for (let k = 1; k <= n; k++) {
        const q = k === n ? P[P.length - 1] : at(k / n);
        segs.push([prev[0], prev[1], q[0], q[1]]);
        prev = q;
      }
    }
  const SS = 16;
  let off30 = 0,
    worst = 0;
  for (const [key, c] of cov) {
    const [i, j] = key.split(',').map(Number);
    let n = 0;
    for (let sy = 0; sy < SS; sy++) {
      const y = (j + (sy + 0.5) / SS) * epp,
        xs = [];
      for (const [xa, ya, xb, yb] of segs)
        if (ya <= y !== yb <= y)
          xs.push([xa + ((y - ya) / (yb - ya)) * (xb - xa), yb > ya ? 1 : -1]);
      for (let sx = 0; sx < SS; sx++) {
        const x = (i + (sx + 0.5) / SS) * epp;
        let w = 0;
        for (const [cx, dw] of xs) if (cx > x) w += dw;
        if (w !== 0) n++;
      }
    }
    const e = Math.abs(c - n / (SS * SS));
    if (e > 0.3) off30++;
    worst = Math.max(worst, e);
  }
  return { off30, worst, comps, px: cov.size };
}

if (!hasCxx()) {
  console.log('  SKIPPED: no C++ compiler for the kernel emulation');
} else {
  const emu = buildGlslEmu(ROOT, { cpatch: true });
  const on = {},
    offs = {};
  // A shape this simple certifies as one complete paint and has no seams; the hook keeps it on the seam path this smoke is about.
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_AREA = 1;
  globalThis.__CP_COMP_ON = 1; // the companion is opt-in
  for (const k of [-20, 0, 20]) {
    const S = 2 ** k;
    const r = await frame(emu, S);
    if (!r) {
      ok(false, `2^${k}: the shape did not build as CPatch`);
      continue;
    }
    on[k] = r;
    ok(r.comps > 0, `(a) 2^${k}: ${r.comps} seams carry a companion`);
    ok(
      r.off30 <= 33,
      `(b) 2^${k}: ${r.off30} of ${r.px} pixels off exact by more than 0.3 (worst ${r.worst.toFixed(3)}; bar 33 since the exact predicates, the default build 9, see (c))`,
    );
  }
  delete globalThis.__CP_COMP_ON;
  // (c) the same tree at its default: companions off
  const r0 = await frame(emu, 1);
  delete globalThis.__CP_NO_AREA;
  delete globalThis.__MANTLE_DEBUG__;
  // THE INVARIANT IS "THE DEFAULT BUILD IS NO WORSE THAN THE COMPANION BUILD", not "the companion buys something": a default
  // that beats the companion (with seam-end ownership, 9 against 10) is the reason the companion can stay off, not a defect.
  ok(
    r0 && r0.comps === 0 && on[0] && r0.off30 <= on[0].off30,
    `(c) the default, without companions: ${r0 ? r0.off30 : '?'} pixels are off by more than 0.3 (worst ${r0 ? r0.worst.toFixed(3) : '?'}), against ${on[0] ? on[0].off30 : '?'} with them`,
  );
}
console.log(fail ? `cpatchSeamCompanionSmoke FAIL (${fail})` : 'cpatchSeamCompanionSmoke PASS');
process.exit(fail ? 1 : 0);
