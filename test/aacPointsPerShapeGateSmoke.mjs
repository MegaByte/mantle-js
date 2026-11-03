// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsPerShapeGateSmoke — the AAC point route's size gate reads each SHAPE, not a box no
// bundle contains.
//
// THE TRAP. Keeping `max(width)` and `max(height)` over the whole draw and handing the gate that
// PAIR (instead of each shape, as `shapesFor` does) reports, for a run of wide-flat bars and one
// tall-thin stem, a box as wide as the
// bars and as tall as the stem — a shape the bundle does not contain. Unrotated the two agree,
// because max_i max(ex*w_i, ey*h_i) is the same number either way. Under a worldMatrix ROTATION
// they do not: the extent mixes both axes (|m00*ex|*w + |m01*ey|*h), the synthetic box is strictly
// the larger of the two, and the route would decline draws whose every shape is small.
//
// WHAT this DOES NOT COVER. "One big shape, or one stroke, in an illustration disqualifies every
// small shape in it" is NOT this. It is the
// DRAW: the route paints every drawn shape as points from one instanced call, so a bundle can only
// take it whole. A per-shape choice needs a draw that carries point grids and cover quads together
// in document order, which is what the unified stream is for. The shape-vs-box error is the part of
// the gate that can be made per shape without a mixed draw, and it is pinned here.
//
//   (a) the rule itself, on the two arrangements that separate the readings, at 8 rotations;
//   (b) the shipped renderer exposes it and it is the per-shape maximum, not the synthetic box;
//   (c) an imported bundle of small wide and small tall shapes: the box reading exceeds the 8 px
//       gate under rotation while every shape's own extent is under it.
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { attachAacPointsDraw } = await import('../src/renderer/aacPointsDraw.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- (b) the shipped rule, lifted off a renderer stub ------------------------------------------------
// attachAacPointsDraw only reads R.gl lazily (inside programFor / draw), so a stub is enough to take
// the function it installs. No GL, no browser.
const R = /** @type {any} */ ({ gl: null, opts: {}, _pendingShaders: [], _pendingPrograms: [] });
attachAacPointsDraw(R);
const maxExt = R._aacPointsMaxShapeExtentPx;
ok(typeof maxExt === 'function', '(b) the route exposes its per-shape extent rule');
// A missing rule must read as a FAIL, not a stack trace: a crashed smoke prints no FAIL line.
if (typeof maxExt !== 'function') {
  console.log('aacPointsPerShapeGateSmoke FAIL (1) — nothing else can run');
  process.exit(1);
}

/// The PAIRED reading: max width and max height, from shapes that need not be the same shape.
function boxExtent(ext, ex, ey, m00, m10, m01, m11) {
  let w = 0,
    h = 0;
  for (let i = 0; i + 1 < ext.length; i += 2) {
    w = Math.max(w, ext[i]);
    h = Math.max(h, ext[i + 1]);
  }
  return Math.max(
    Math.abs(m00 * ex) * w + Math.abs(m01 * ey) * h,
    Math.abs(m10 * ex) * w + Math.abs(m11 * ey) * h,
  );
}

// ---- (a) the two arrangements ------------------------------------------------------------------------
{
  // A wide-flat shape and a tall-thin one, both small: 6 x 1 and 1 x 6 em, at 1 px per em.
  const ext = new Float32Array([6, 1, 1, 6]);
  let worstGap = 0,
    rotWhereGap = -1,
    unrotatedAgree = true;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 8,
      c = Math.cos(a),
      s2 = Math.sin(a);
    const mine = maxExt(ext, 1, 1, c, s2, -s2, c);
    const box = boxExtent(ext, 1, 1, c, s2, -s2, c);
    if (k === 0 && Math.abs(mine - box) > 1e-9) unrotatedAgree = false;
    const gap = box - mine;
    if (gap > worstGap) {
      worstGap = gap;
      rotWhereGap = k;
    }
  }
  ok(
    unrotatedAgree,
    '(a) unrotated the two readings agree, which is why this never showed on a plain draw',
  );
  ok(
    worstGap > 1.0,
    `(a) rotated they do not: the synthetic box over-reads the largest shape by up to ${worstGap.toFixed(3)} px (at ${(rotWhereGap * 22.5).toFixed(1)} degrees) on a 6x1 plus a 1x6`,
  );
  // the number that decides the route
  const a45 = Math.PI / 4,
    c45 = Math.cos(a45),
    s45 = Math.sin(a45);
  const mine45 = maxExt(ext, 1, 1, c45, s45, -s45, c45),
    box45 = boxExtent(ext, 1, 1, c45, s45, -s45, c45);
  ok(
    mine45 <= 8 && box45 > 8,
    `(a) at 45 degrees every shape is ${mine45.toFixed(3)} px across and the box says ${box45.toFixed(3)} — the gate is 8, so the paired reading would decline a draw whose every shape qualifies`,
  );
}

// ---- (c) the same thing through an imported bundle ----------------------------------------------------
{
  // 6 x 1 bars and 1 x 6 stems, laid out in a 64 em box drawn at 64 px: 1 px per em.
  let d = '';
  for (let i = 0; i < 6; i++)
    d += `<rect x="${4 + i * 10}" y="6" width="6" height="1"/><rect x="${4 + i * 10}" y="20" width="1" height="6"/>`;
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="#000">${d}</g></svg>`,
    { preserveViewport: true },
  );
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    st = pm.floatsPerShape;
  const ext = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * st;
    if (!(F[o + 7] > 0)) continue;
    ext.push(F[o + 2] - F[o], F[o + 3] - F[o + 1]);
  }
  const E = new Float32Array(ext);
  ok(E.length === 24, `(c) the bundle carries ${E.length / 2} inked fill shapes`);
  const gbb = b.globalBBox,
    N = 64;
  const cAR = 1,
    sAR = gbb[2] / gbb[3];
  const [sx, sy] = sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
  const ex = (N * sx) / gbb[2],
    ey = (N * sy) / gbb[3];
  const a = Math.PI / 4,
    c = Math.cos(a),
    s2 = Math.sin(a);
  const mine = maxExt(E, ex, ey, c, s2, -s2, c),
    box = boxExtent(E, ex, ey, c, s2, -s2, c);
  ok(
    mine <= 8 && box > 8,
    `(c) at 64 px under a 45-degree worldMatrix: largest SHAPE ${mine.toFixed(3)} px, synthetic box ${box.toFixed(3)} px, gate 8 — the route takes this draw, which the paired reading declines`,
  );
  ok(
    Math.abs(maxExt(E, ex, ey, 1, 0, 0, 1) - boxExtent(E, ex, ey, 1, 0, 0, 1)) < 1e-9,
    '(c) ...and with no rotation the two are the same number, so no unrotated draw changes route',
  );
}

console.log(fail ? `aacPointsPerShapeGateSmoke FAIL (${fail})` : 'aacPointsPerShapeGateSmoke PASS');
process.exit(fail ? 1 : 0);
