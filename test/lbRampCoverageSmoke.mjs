// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRampCoverageSmoke — a CPU coverage model of two things the LB mesh promises about its own ink:
// no face is handed a ramp that erases it, and a circle sector's fan still holds the band it hides.
//
// WHY A MODEL AND NOT A RENDER. Both properties are decided away from the boundary, where the kernel's
// answer is 0 or 1 and nothing interpolates, so they can be read off the packed vertex stream exactly --
// no GPU, no sampling. What the model needs from the shaders is only their contract:
//
//   INTERIOR, line mode (_lbCoverage.glsl): cov = slugCov(dot(cCen, em) - cScale), and slugCov's own
//   comment states f > 0 is OUTSIDE the fill. So a face's area lying more than half a pixel past its own
//   line paints nothing. A second line (aC0, type in aC0.w) or a third (aTC.xyz, type in aC3.w) can save
//   it only as a UNION (type < 0); an intersection (type > 0) only takes ink away. Ink left over that no
//   other interior face covers is a hole over winding-1 interior -- the crotch-diamond the fill-side
//   invariant in lbInteriorSplit.js exists to prevent. It is measured here as DARK AREA.
//
//   DISC (_lbVertexSetup.glsl): a sector fan's vertices are pushed LB_DISC_PUSH = 2 px radially from the
//   disc center (the center vertex does not move), so the polygon the rasterizer sees is bigger than the
//   packed one by a pixel-sized amount the builder cannot know. The fan has to enclose the disc's AA band,
//   r + the CP_AA_REACH 0.7072 px filter reach, and its tightest point is the outer chord's midpoint.
//
// THE CASES. aacBandLevels #1 is the fill-side one: 11 faces of 256 units^2, each with one vertex ON its
// line (under one float32 ulp) and the other two 4 units past it, which a tolerance gap would leave attached
// to a line that reads ~0 over the whole face -- thousands of px^2 of dark ink at 512 px. The sector cases are the corpus's rounded-rect corners and lbLensParity's arcs.
import { readFileSync } from 'fs';
import { PKG_ROOT, have, missingHint, noteSkip } from './_assets.mjs';
import path from 'node:path';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours, emitCircleSector } = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { LB_VERT_FLOATS: FL } = await import('../src/renderer/lbPack.js');

const DISC_PUSH = 2; // LB_DISC_PUSH, _lbVertexSetup.glsl
const AA_REACH = 0.7072; // CP_AA_REACH, the filter's reach in pixels
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

const areaOf = (P) => {
  let a = 0;
  for (let i = 0; i < P.length; i++) {
    const q = P[(i + 1) % P.length];
    a += P[i][0] * q[1] - q[0] * P[i][1];
  }
  return Math.abs(a) * 0.5;
};
// the part of a polygon on the >= h side of a line
const clipHalf = (P, n, c, h) => {
  const out = [],
    f = (p) => n[0] * p[0] + n[1] * p[1] - c - h;
  for (let i = 0; i < P.length; i++) {
    const A = P[i],
      B = P[(i + 1) % P.length],
      fa = f(A),
      fb = f(B);
    if (fa >= 0) out.push(A);
    if (fa >= 0 !== fb >= 0) {
      const u = fa / (fa - fb);
      out.push([A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])]);
    }
  }
  return out;
};
const inTri = (p, a, b, c) => {
  const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (!(Math.abs(d) > 0)) return false;
  const w1 = ((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) / d;
  const w2 = ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / d;
  return w1 >= -1e-9 && w2 >= -1e-9 && 1 - w1 - w2 >= -1e-9;
};

async function shapesOf(file) {
  const b = await importSvg(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  const meta = b.meta && b.meta.byteLength > 32 ? new Float32Array(b.meta, 32) : null;
  const mst = b.metaFloatsPerShape,
    cf = new Float32Array(b.curves),
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const r = b.curveRangesByShape[s];
    if (!r || r.end <= r.begin || !meta) continue;
    const bb = s * mst;
    const transSolid =
      meta[bb + 7] < 0.996 &&
      Math.floor(meta[bb + 28] + 0.5) === 0 &&
      (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
    let built = null;
    try {
      built = buildLbShape(
        curveRangeToContours(cf, r.begin, r.end),
        transSolid,
        !!(meta[bb + 13] > 0.5),
      );
    } catch {
      continue;
    }
    if (built && built.pk && built.pk.vertexCount)
      out.push({ s, V: built.pk.verts, N: built.pk.vertexCount });
  }
  return out;
}

// ── the fill-side invariant, as area ──────────────────────────────────────────────────────────────────
// Per shape: the ink of LINE-mode INTERIOR faces lying more than half a pixel past their own line, with
// the union partners' half-planes taken out, that no other interior face paints.
function darkInk({ V, N }, pxPerUnit) {
  const half = 0.5 / pxPerUnit;
  const face = (z) => ({
    P: [0, 1, 2].map((k) => [V[z + k * FL], V[z + k * FL + 1]]),
    chain: V[z + 2] > 1.5,
    L: [V[z + 19], V[z + 20]],
    c: V[z + 21],
    L2: [V[z + 7], V[z + 8]],
    c2: V[z + 9],
    T2: V[z + 10],
    L3: [V[z + 2], V[z + 3]],
    c3: V[z + 4],
    T3: V[z + 22],
  });
  const live = (n) => n[0] * n[0] + n[1] * n[1] > 1e-9;
  const paints = (f, p) => {
    if (f.chain || !live(f.L)) return true; // its own outline, or bare solid
    if (f.L[0] * p[0] + f.L[1] * p[1] - f.c < -half) return true;
    if (f.T2 < -0.5 && live(f.L2) && f.L2[0] * p[0] + f.L2[1] * p[1] - f.c2 < -half) return true;
    return f.T3 < -0.5 && live(f.L3) && f.L3[0] * p[0] + f.L3[1] * p[1] - f.c3 < -half;
  };
  const faces = [];
  for (let z = 0; z + 3 * FL <= N * FL; z += 3 * FL)
    if (Math.abs(V[z + 5]) < 0.3) faces.push(face(z));
  let dark = 0,
    n = 0,
    ext = 0;
  for (const f of faces) {
    for (const p of f.P) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
    if (f.chain || !live(f.L)) continue;
    let e = clipHalf(f.P, f.L, f.c, half);
    if (e.length >= 3 && f.T2 < -0.5 && live(f.L2)) e = clipHalf(e, f.L2, f.c2, -half);
    if (e.length >= 3 && f.T3 < -0.5 && live(f.L3)) e = clipHalf(e, f.L3, f.c3, -half);
    if (e.length < 3) continue;
    const a = areaOf(e);
    if (!(a > 0)) continue;
    const cen = [
      e.reduce((s, p) => s + p[0], 0) / e.length,
      e.reduce((s, p) => s + p[1], 0) / e.length,
    ];
    if (faces.some((g) => g !== f && inTri(cen, g.P[0], g.P[1], g.P[2]) && paints(g, cen)))
      continue;
    dark += a;
    n++;
  }
  return { dark, n, ext };
}

console.log('lbRampCoverageSmoke');
console.log(' the fill-side invariant: no interior face is left attached to a line that erases it');
for (const file of [
  'examples/smoke/aacBandLevels__SVG.svg',
  'examples/tiger.svg',
  'examples/smoke/lbMemBudget__SVG.svg',
]) {
  // The two examples/smoke cases are in-tree and carry the fill-side case (aacBandLevels #1); tiger.svg is the
  // fetched, hash-pinned detail corpus (npm run fetch:fixtures).
  if (!have(path.join(PKG_ROOT, file))) {
    noteSkip(missingHint(path.join(PKG_ROOT, file)));
    continue;
  }
  let worst = null,
    tot = 0;
  for (const sh of await shapesOf(file)) {
    const d = darkInk(sh, 1.28);
    tot += d.dark;
    // A face may still touch its line within the tolerance the builder judges by (four float32 ulps of the
    // coordinates), so the bar is that residue, not zero: an ulp-deep sliver of a face cannot paint.
    const bar = 1e-6 * d.ext * d.ext;
    if (d.dark > bar && (!worst || d.dark > worst.d.dark)) worst = { sh, d, bar };
  }
  check(
    !worst,
    `${file.split('/').pop()}: ${tot.toFixed(4)} units^2 of ink attached to a line that reads 0` +
      (worst
        ? ` -- shape #${worst.sh.s} alone has ${worst.d.dark.toFixed(1)} over ${worst.d.n} faces (bar ${worst.bar.toFixed(4)})`
        : ''),
  );
}

// ── a circle sector's fan holds the AA band at every zoom ──────────────────────────────────────────────
console.log(' a sector fan encloses the disc band after the DISC vertex push, at every zoom');
const fanMargin = ({ V, N }, pxPerUnit) => {
  const push = DISC_PUSH / pxPerUnit,
    reach = AA_REACH / pxPerUnit;
  let min = Infinity,
    tris = 0;
  for (let z = 0; z + 3 * FL <= N * FL; z += 3 * FL) {
    if (Math.abs(V[z + 5] - 7) > 0.3) continue; // LBK.DISC
    const C = [V[z + 19], V[z + 20]],
      r = V[z + 21];
    if (!(r > 0)) continue;
    const d0 = [0, 1, 2].map((k) => Math.hypot(V[z + k * FL] - C[0], V[z + k * FL + 1] - C[1]));
    if (Math.min(...d0) > 1e-4 * r) continue; // a fan has a vertex ON the center
    tris++;
    const P = [0, 1, 2].map((k) => {
      const p = [V[z + k * FL], V[z + k * FL + 1]],
        d = [p[0] - C[0], p[1] - C[1]],
        L = Math.hypot(d[0], d[1]);
      return L < 1e-9 ? p : [p[0] + (d[0] / L) * push, p[1] + (d[1] / L) * push];
    });
    const ci = d0.indexOf(Math.min(...d0)),
      [i, j] = [0, 1, 2].filter((k) => k !== ci);
    const M = [(P[i][0] + P[j][0]) / 2, (P[i][1] + P[j][1]) / 2]; // the outer chord's midpoint: the tightest point
    min = Math.min(min, (Math.hypot(M[0] - C[0], M[1] - C[1]) - r - reach) * pxPerUnit);
  }
  return { min, tris };
};
for (const [file, s] of [
  ['examples/smoke/lbLensParity__SVG.svg', 0],
  ['examples/smoke/nineSliceFilter__PLAIN.svg', 0],
  ['examples/smoke/groupRect__SCENE.svg', 9],
]) {
  const sh = (await shapesOf(file)).find((q) => q.s === s);
  if (!sh) {
    check(false, `${file.split('/').pop()} #${s}: no mesh`);
    continue;
  }
  const rows = [0.02, 0.16, 1.28, 10.24].map((px) => [px, fanMargin(sh, px)]);
  const tris = rows[0][1].tris;
  check(
    tris > 0 && rows.every(([, m]) => m.min > 0),
    `${file.split('/').pop()} #${s}: ${tris} fan triangles clear the band by ` +
      rows.map(([px, m]) => `${m.min.toFixed(2)}px @${px}`).join(', '),
  );
}

// The fan is a similarity of its disc — the property the world-unit pad broke. Same arc, two sizes.
{
  const fan = (s) => {
    const q = [];
    emitCircleSector(q, { cx: 0, cy: 0, r: s }, [s, 0], [0, s], 1);
    return q;
  };
  const a = fan(1),
    b = fan(2 ** -20);
  const same =
    a.length === b.length &&
    a.every((t, i) => Array.from(t.tri).every((v, k) => v * 2 ** -20 === b[i].tri[k]));
  check(
    same,
    `emitCircleSector's fan at 2^-20 is the fan at 1, scaled (${a.length} triangles; ` +
      `outer vertex ${a[0].tri[2].toFixed(6)} vs ${(b[0].tri[2] * 2 ** 20).toFixed(6)})`,
  );
}

console.warn = _warn;
if (fail) {
  console.log(`FAIL lbRampCoverageSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS lbRampCoverageSmoke');
