// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcSeamTouchSmoke.mjs — a ray through a closed contour's SEAM must count it exactly once, whichever side the seam is on.
//
// A circle/ellipse is one arc whose two ends are the same point. Once <circle> starts at (cx + rx, cy) (as SVG 2
// says) that point is the circle's RIGHT extremum, and the V ray of the pixel whose center IS that point is tangent to the
// outline there: it meets the arc in two crossings at the one point, on the first and the last monotone piece, with opposite
// signs. arcRayCrossings drops such a TOUCHING pair for the AA walkers (the count is the same, but the ramp weight of a
// tangent ray says nothing about the pixel) -- yet it looked for the pair only across an extremum INSIDE the sweep, so with
// the extremum at both ends the pair stayed and the pixel read 0.250 where its exact box coverage is 0.46-0.50 (the pixel
// right of the circle, center ray through the seam: r = 1, 2, 4, 8 at a half-pixel offset, smallRadiusAaSmoke).
//
// Two layers, both without a tolerance on the rule:
//   (1) arcRayCrossings itself: both ends exactly on the facing extremum -> the touching pair is dropped, at any scale
//       (2^-20..2^20), for every direction the seam can face, and a lone crossing (an arc that ends there) still counts.
//   (2) the band walker against the exact pixel-box area, for the single-arc primitives (<circle>, <ellipse>) with a
//       pixel center exactly on the seam, and for the same disc authored as two half-turn arcs from +x, -x, top and bottom
//       (the touch split across two arcs, canceled as an exactly coincident opposite-sign pair of crossings).
//
// CPU twin of the shader rule (src/hitTest/bandWinding.js); the GLSL is _coverage.glsl's arcRayCrossings, same edit.

import path from 'path';
import { fileURLToPath } from 'url';
import { arcRayCrossings, bandFillCoverage } from '../src/hitTest/bandWinding.js';
import { hasCxx, buildGlslEmu, fillShapes, K_SLUG, K_AAC, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const TWO_PI = 2 * Math.PI;

// ── (1) the rule ──────────────────────────────────────────────────────────────────────────────
// V ray (x = cxq) through a full circle starting at (cx + r, cy): A = r, B = 0, C = -(cx - cxq).
// u(th) = r cos th - C; the ends are the seam, u = 0 exactly when cxq = cx + r.
const live = (cr) => cr.filter((q) => q[0]).length;
for (const s of [2 ** -20, 1, 3, 2 ** 20]) {
  const r = s;
  // ray tangent AT the seam, the seam on the right (th = 0 = 2pi): touching pair dropped
  const seamR = arcRayCrossings(0, TWO_PI, 1, r, 0, r, 0, 0, true);
  ok(
    live(seamR) === 0,
    `(1) scale ${s}: V ray through a RIGHT seam (both ends on the facing extremum) -> no crossing kept [${seamR.map((q) => q[0])}]`,
  );
  // the same ray without the AA drop (band-hard): both kept, they cancel in the count
  const hard = arcRayCrossings(0, TWO_PI, 1, r, 0, r, 0, 0, false);
  ok(
    live(hard) === 2 &&
      hard
        .map((q) => q[0])
        .sort()
        .join() === '0,1,2',
    `(1) scale ${s}: band-hard keeps the pair (codes 1 and 2 cancel in the count)`,
  );
  // the seam on the LEFT facing the ray (C = -r): the ray x = cx - r, ends at th = pi
  const seamL = arcRayCrossings(-Math.PI, Math.PI, 1, r, 0, -r, 0, 0, true);
  ok(
    live(seamL) === 0,
    `(1) scale ${s}: V ray through a LEFT seam -> no crossing kept [${seamL.map((q) => q[0])}]`,
  );
  // a ray THROUGH the middle of the circle: the two crossings stay (one up, one down)
  const mid = arcRayCrossings(0, TWO_PI, 1, r, 0, 0, r, r, true);
  ok(
    live(mid) === 2,
    `(1) scale ${s}: a ray through the circle's middle still has its two crossings [${mid.map((q) => q[0])}]`,
  );
  // an arc that ENDS on the extremum (half circle): the lone crossing near it still counts
  const half = arcRayCrossings(0, Math.PI, 1, r, 0, r, 0, -2 * r, true);
  ok(
    live(half) === 1,
    `(1) scale ${s}: a half arc ending on the facing extremum is not mistaken for a closed seam`,
  );
}

// ── (2) the walker against the exact area ─────────────────────────────────────────────────────
const F = (x, y, r) => {
  const a = Math.min(Math.max(x, 0), r),
    b = Math.min(Math.max(y, 0), r);
  if (a * a + b * b <= r * r) return a * b;
  const xa = Math.min(a, Math.sqrt(Math.max(r * r - b * b, 0)));
  const I = (t) =>
    0.5 * (t * Math.sqrt(Math.max(r * r - t * t, 0)) + r * r * Math.asin(Math.min(1, t / r)));
  return xa * b + (I(a) - I(xa));
};
const S = (x, y, r) => Math.sign(x) * Math.sign(y) * F(Math.abs(x), Math.abs(y), r);
const discBox = (x0, y0, x1, y1, r) => S(x1, y1, r) - S(x0, y1, r) - S(x1, y0, r) + S(x0, y0, r);
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

async function sweep(markup, W, exactOf, lo, hi) {
  const raw = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">${markup}</svg>`,
  );
  const MF = parseMetaBin(raw.meta, raw.metaFloatsPerShape).metaFloats;
  const gd = [
    MF[M.META_GLYPH_LOC_X],
    MF[M.META_GLYPH_LOC_Y],
    MF[M.META_BAND_MAX_X],
    MF[M.META_BAND_MAX_Y],
  ];
  const bb = [
    MF[M.META_BBOX_XMIN],
    MF[M.META_BBOX_YMIN],
    MF[M.META_BBOX_XMAX],
    MF[M.META_BBOX_YMAX],
  ];
  const bandF = new Float32Array(raw.bands),
    curveF = new Float32Array(raw.curves);
  let worst = 0,
    at = null;
  for (let jx = lo; jx <= hi; jx++)
    for (let jy = lo; jy <= hi; jy++) {
      const cov = bandFillCoverage(bandF, curveF, gd, bb, jx + 0.5, jy + 0.5, 1, 1, false);
      const e = Math.abs(cov - exactOf(jx, jy));
      if (e > worst) {
        worst = e;
        at = [jx, jy, cov, exactOf(jx, jy)];
      }
    }
  return { worst, at, raw };
}

// the shipped shader text, run in float32 on the CPU (test/_glslEmu.mjs): Slug's walker and AAC share arcRayCrossings
const EMUS = hasCxx()
  ? [
      ['Slug shader', buildGlslEmu(ROOT, { defines: [] }), K_SLUG],
      ['AAC shader', buildGlslEmu(ROOT, { defines: AAC_HARD }), K_AAC],
    ]
  : [];
if (!EMUS.length)
  console.log(
    '  note: no C++ compiler -- the shader twins are not run here (the CPU twin above is)',
  );
const emuWorst = (emu, k, raw, exactOf, lo, hi) => {
  const f = fillShapes(raw, parseMetaBin, M)[0],
    qs = [],
    cell = [];
  for (let jx = lo; jx <= hi; jx++)
    for (let jy = lo; jy <= hi; jy++) {
      qs.push({ k, GD: f.GD, bb: f.bb, eo: f.eo, c: [jx + 0.5, jy + 0.5], ePx: [1, 1] });
      cell.push([jx, jy]);
    }
  const out = emu.run(new Float32Array(raw.bands), new Float32Array(raw.curves), qs);
  let worst = 0,
    at = null;
  cell.forEach(([jx, jy], i) => {
    const e = Math.abs(out[i] - exactOf(jx, jy));
    if (e > worst) {
      worst = e;
      at = [jx, jy, out[i], exactOf(jx, jy)];
    }
  });
  return { worst, at };
};
const BAR = 0.15; // the single-pixel bar smallRadiusAaSmoke gives r >= 1
for (const R of [1, 2, 4, 8])
  for (const off of [0, 0.5]) {
    const W = 32 * R,
      C = 16 * R + off,
      r = R;
    const lo = Math.floor(C) - r - 3,
      hi = Math.floor(C) + r + 3;
    const exact = (jx, jy) => discBox(jx - C, jy - C, jx + 1 - C, jy + 1 - C, r);
    const arc2 = (sx, sy, ex, ey) =>
      `<path d="M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex} ${ey} A ${r} ${r} 0 0 1 ${sx} ${sy} Z" fill="#000"/>`;
    const cases = {
      circle: `<circle cx="${C}" cy="${C}" r="${r}" fill="#000"/>`,
      ellipse: `<ellipse cx="${C}" cy="${C}" rx="${r}" ry="${r}" fill="#000"/>`,
      'path from +x': arc2(C + r, C, C - r, C),
      'path from -x': arc2(C - r, C, C + r, C),
      'path from top': arc2(C, C - r, C, C + r),
      'path from bottom': arc2(C, C + r, C, C - r),
    };
    for (const [name, markup] of Object.entries(cases)) {
      const q = await sweep(markup, W, exact, lo, hi);
      const msg =
        `r=${r} offset ${off} ${name}: worst pixel ${q.worst.toFixed(3)} from the exact area (bar ${BAR})` +
        (q.worst > BAR
          ? ` at pixel (${q.at[0] - Math.floor(C)}, ${q.at[1] - Math.floor(C)}) read ${q.at[2].toFixed(3)}, exact ${q.at[3].toFixed(3)}`
          : '');
      // the single-arc primitives pin the within-arc touch; the two-arc PATHS are the cross-segment form of the same touch (two arcs
      // sharing the extremum vertex, one crossing each): the walker cancels the coincident opposite-sign pair
      ok(q.worst <= BAR, `(2) ${msg}`);
      for (const [label, emu, k] of EMUS) {
        const e = emuWorst(emu, k, q.raw, exact, lo, hi);
        ok(
          e.worst <= BAR,
          `(3) ${label}: r=${r} offset ${off} ${name}: worst pixel ${e.worst.toFixed(3)} (bar ${BAR})` +
            (e.worst > BAR
              ? ` at pixel (${e.at[0] - Math.floor(C)}, ${e.at[1] - Math.floor(C)}) read ${e.at[2].toFixed(3)}, exact ${e.at[3].toFixed(3)}`
              : ''),
        );
      }
    }
    // a rect whose corners sit on pixel centers (the V and H rays both pass through vertices)
    const x0 = Math.floor(C) + 0.5 - r,
      y0 = x0,
      w = 2 * r + 1,
      h = 2 * r + 1;
    const exactRect = (jx, jy) => overlap(jx, jx + 1, x0, x0 + w) * overlap(jy, jy + 1, y0, y0 + h);
    const q = await sweep(
      `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#000"/>`,
      W,
      exactRect,
      lo,
      hi,
    );
    // NOT asserted: a LINE vertex on both rays reads 0.25 off in this twin (a pixel whose center is a rect corner reads 0 or 0.5
    // for an exact 0.25): the Slug walker's two-ray estimate, which the shipped AAC kernel does not share.
    console.log(
      `  info (2) r=${r} offset ${off} rect with corners on pixel centers: worst pixel ${q.worst.toFixed(3)} (twin only)`,
    );
  }

// (4) the same two-arc discs authored at 2^-20 and 2^20 units (the pixel grid scaled with them): the cancel is an exact float
// comparison of two crossings' offsets, so it holds at every coordinate scale
for (const k of [2 ** -20, 2 ** 20]) {
  const r = 4,
    off = 0.5,
    W = 32 * r,
    C = 16 * r + off,
    lo = Math.floor(C) - r - 3,
    hi = Math.floor(C) + r + 3;
  const exact = (jx, jy) => discBox(jx - C, jy - C, jx + 1 - C, jy + 1 - C, r);
  const arc2 = (sx, sy, ex, ey) =>
    `<path d="M ${sx * k} ${sy * k} A ${r * k} ${r * k} 0 0 1 ${ex * k} ${ey * k} A ${r * k} ${r * k} 0 0 1 ${sx * k} ${sy * k} Z" fill="#000"/>`;
  for (const [name, markup] of Object.entries({
    '+x': arc2(C + r, C, C - r, C),
    '-x': arc2(C - r, C, C + r, C),
    top: arc2(C, C - r, C, C + r),
    bottom: arc2(C, C + r, C, C - r),
  })) {
    const raw = await importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * k} ${W * k}">${markup}</svg>`,
    );
    const MF = parseMetaBin(raw.meta, raw.metaFloatsPerShape).metaFloats;
    const gd = [
      MF[M.META_GLYPH_LOC_X],
      MF[M.META_GLYPH_LOC_Y],
      MF[M.META_BAND_MAX_X],
      MF[M.META_BAND_MAX_Y],
    ];
    const bb = [
      MF[M.META_BBOX_XMIN],
      MF[M.META_BBOX_YMIN],
      MF[M.META_BBOX_XMAX],
      MF[M.META_BBOX_YMAX],
    ];
    const bandF = new Float32Array(raw.bands),
      curveF = new Float32Array(raw.curves);
    let worst = 0;
    for (let jx = lo; jx <= hi; jx++)
      for (let jy = lo; jy <= hi; jy++)
        worst = Math.max(
          worst,
          Math.abs(
            bandFillCoverage(
              bandF,
              curveF,
              gd,
              bb,
              (jx + 0.5) * k,
              (jy + 0.5) * k,
              1 / k,
              1 / k,
              false,
            ) - exact(jx, jy),
          ),
        );
    ok(
      worst <= BAR,
      `(4) two arcs from ${name} authored at 2^${Math.log2(k)} units: worst pixel ${worst.toFixed(3)} (bar ${BAR})`,
    );
  }
}

if (fail) {
  console.error(`arcSeamTouchSmoke: ${fail} failure(s)`);
  process.exit(1);
}
console.log('arcSeamTouchSmoke: PASS');
