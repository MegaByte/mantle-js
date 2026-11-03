// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Test production CPU hit-test coverage against exact disc/box area.
// The ray approximation can miss subpixel discs; the sweep bounds its error
// above that range and checks scale invariance. This is not a GPU proof.
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { bandFillCoverage } = await import('../src/hitTest/bandWinding.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ── the exact reference ───────────────────────────────────────────────────────────────────────
// F(x, y) = area of {u^2 + v^2 <= r^2, 0 <= u <= x, 0 <= v <= y}. Below the arc the box height
// binds; past it the circle does. Both pieces are closed form.
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

// The reference has to be right before anything is measured against it.
{
  const whole = discBox(-9, -9, 9, 9, 3);
  const half = discBox(-9, 0, 9, 9, 3);
  const quarterBox = discBox(0, 0, 1, 1, 1000); // a box wholly inside a huge disc
  ok(
    Math.abs(whole - Math.PI * 9) < 1e-12 &&
      Math.abs(half - Math.PI * 4.5) < 1e-12 &&
      Math.abs(quarterBox - 1) < 1e-12,
    `the exact reference integrates: whole disc ${whole.toFixed(9)} = pi*9, half ${half.toFixed(9)}, ` +
      `an interior box ${quarterBox.toFixed(9)}`,
  );
}

// ── the measurement ───────────────────────────────────────────────────────────────────────────
// One <circle> per case. `scale` is the AUTHORING scale: the same picture in different units, with
// the pixel grid moved to match, so an absolute epsilon anywhere in import or encode shows up as a
// different answer for the same rendered image.
async function sweep(rPx, offPx, scale) {
  const R = rPx / scale;
  const C = 16 * R + offPx / scale; // center, clear of the viewBox edge
  const raw = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${32 * R} ${32 * R}">` +
      `<circle cx="${C}" cy="${C}" r="${R}" fill="#000"/></svg>`,
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
  const Cpx = C * scale,
    pad = Math.ceil(rPx) + 3;
  const k0 = Math.floor(Cpx) - pad,
    k1 = Math.floor(Cpx) + pad;
  let ink = 0,
    exact = 0,
    worst = 0,
    outside = 0;
  for (let jx = k0; jx <= k1; jx++)
    for (let jy = k0; jy <= k1; jy++) {
      const cov = bandFillCoverage(
        bandF,
        curveF,
        gd,
        bb,
        (jx + 0.5) / scale,
        (jy + 0.5) / scale,
        scale,
        scale,
        false,
      );
      if (!(cov >= -1e-9 && cov <= 1 + 1e-9)) outside++;
      ink += cov;
      exact += discBox(jx - Cpx, jy - Cpx, jx + 1 - Cpx, jy + 1 - Cpx, rPx);
      worst = Math.max(
        worst,
        Math.abs(cov - discBox(jx - Cpx, jy - Cpx, jx + 1 - Cpx, jy + 1 - Cpx, rPx)),
      );
    }
  return { ink, exact, worst, outside };
}

const OFFSETS = [0, 0.17, 0.33, 0.5, 0.71]; // the circle center's sub-pixel offset
const RADII = [0.25, 0.35, 0.5, 0.7, 1, 1.5, 2, 4, 8];
const results = new Map();
for (const r of RADII) {
  const rows = [];
  for (const off of OFFSETS) rows.push({ off, ...(await sweep(r, off, 1)) });
  results.set(r, rows);
}
const ratios = (r) => results.get(r).map((q) => q.ink / q.exact);
const show = (r) =>
  `[${ratios(r)
    .map((v) => v.toFixed(3))
    .join(' ')}]`;

// ── (1) coverage is a coverage, at every radius and offset ────────────────────────────────────
let outside = 0;
for (const r of RADII) for (const q of results.get(r)) outside += q.outside;
ok(
  outside === 0,
  `(1) no pixel's coverage leaves [0, 1] over ${RADII.length * OFFSETS.length} ` +
    `radius x offset cases`,
);

// ── (2) the exact area is matched from r = 1 px ───────────────────────────────────────────────
// The ratio reads 0.955..1.060 at r=1 and tighter above; 0.88..1.15 is comfortably outside that
// and comfortably inside "the disc is the wrong size".
for (const r of RADII.filter((v) => v >= 1)) {
  const lo = Math.min(...ratios(r)),
    hi = Math.max(...ratios(r));
  ok(
    lo >= 0.88 && hi <= 1.15,
    `(2) r=${r}px: ink is ${lo.toFixed(3)}..${hi.toFixed(3)} of the exact pi*r^2 over 5 sub-pixel ` +
      `offsets ${show(r)}`,
  );
}
let worstBig = 0;
for (const r of RADII.filter((v) => v >= 1))
  for (const q of results.get(r)) worstBig = Math.max(worstBig, q.worst);
ok(
  worstBig <= 0.15,
  `(2) r >= 1px: the worst SINGLE pixel is ${worstBig.toFixed(3)} from its exact ` +
    `box coverage (bar 0.15)`,
);

// ── (3) a disc wider than a pixel never vanishes ──────────────────────────────────────────────
// This is the check that would fire if a small-radius guard, an absolute epsilon or a clamped
// reach started eating discs a pixel across. The sub-pixel vanishing below is a ray-sampling
// property; it must not reach r = 0.7 px.
for (const r of RADII.filter((v) => v >= 0.7)) {
  const lo = Math.min(...ratios(r));
  ok(
    lo >= 0.5,
    `(3) r=${r}px: every sub-pixel offset paints at least half the exact area ` +
      `(min ${lo.toFixed(3)}) — no offset makes the disc disappear`,
  );
}

// ── (4) the sub-pixel regime, pinned as it is ─────────────────────────────────────────────────
// Below a pixel the answer is allowed to be poor, and is: at some offsets the disc falls between
// the two sample rays and paints nothing, at others it over-paints. What must not change silently
// is how poor. Both directions are bounded.
for (const r of RADII.filter((v) => v < 0.7)) {
  const hi = Math.max(...ratios(r));
  ok(
    hi <= 3.0,
    `(4) r=${r}px (sub-pixel): over-paint is at most ${hi.toFixed(3)}x the exact area ` +
      `${show(r)} — vanishing at some offsets is the known ray-sampling limit`,
  );
}

// ── (5) the same image, authored at three scales, is the same image ───────────────────────────
// The absolute-epsilon gate. A tolerance that is not relative to the coordinates shows up here as
// a different answer for a picture that differs only in its units.
for (const r of [0.35, 0.7, 2]) {
  const base = await sweep(r, 0.33, 1);
  let drift = 0;
  for (const s of [2 ** -10, 2 ** 10]) {
    const q = await sweep(r, 0.33, s);
    drift = Math.max(drift, Math.abs(q.ink - base.ink), Math.abs(q.exact - base.exact));
  }
  ok(
    drift <= 1e-9,
    `(5) r=${r}px: authoring the same picture at 2^-10 and 2^10 units moves the ` +
      `ink by ${drift.toExponential(2)} (bar 1e-9) — no absolute epsilon in the path`,
  );
}

console.log(fail ? `FAIL smallRadiusAaSmoke: ${fail} check(s)` : 'PASS smallRadiusAaSmoke');
process.exit(fail ? 1 : 0);
