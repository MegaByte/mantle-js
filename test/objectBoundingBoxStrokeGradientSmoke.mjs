// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// objectBoundingBoxStrokeGradientSmoke — an objectBoundingBox gradient on a STROKE binds to the
// geometry box WITHOUT the stroke (SVG 1.1 §7.11), on every carrier.
//
// A rotated or skewed carrier is placed by minting a gradient record whose
// inverse-gradientTransform carries `carrierCTM x [w 0 0 h minx miny]` for the element's own
// path-tight box, and a positive-diagonal FILL carrier keeps the shader's own arithmetic under an
// exact test: there the shader's own normalization through the meta row's document-space AABB IS
// that matrix, so nothing that is right can move by a rounding.
//
// That reasoning holds for a FILL row and fails for a STROKE row. The two are separate meta rows
// with different boxes (bundleFinalize.js: `bboxFill` is path-tight, `bboxMeta` is path + halfW),
// and the padded one is exactly the box §7.11 says the gradient must NOT use. So a positive-
// diagonal STROKE carrier mints its record too, or it would be wrong in a way a rotated one is not.
//
// What this pins, on the same shape under four carriers:
//   * every stroke gradient reference lands on a record with units = userSpaceOnUse and a
//     supplemental matrix, never on the shared objectBoundingBox row;
//   * that matrix maps the unit square onto the PATH-TIGHT box in document space, which for the
//     axis-aligned carrier is checkable in closed form and is strictly smaller than the stroke
//     row's own bbox;
//   * the FILL gradient on the axis-aligned carrier still takes the shared row — the exact test
//     that keeps already-correct bundles from moving is not what this loosens.
import { strict as assert } from 'assert';
import { parseMetaBin } from '../src/renderer/bundle.js';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

// One 40 x 20 rect at (0,0) in its own space, stroked 4 wide with an objectBoundingBox ramp, under
// four carriers. The stroke row's bbox is the path box grown by halfW IN DOCUMENT SPACE, which the
// carrier scales, so the padding is not 2 on every carrier and the test below never assumes it is.
const W = 40,
  H = 20,
  SW = 4;
// `pathBox` is the rect's PATH-TIGHT box in DOCUMENT space — what §7.11's supplemental matrix must
// map the unit square onto. It is written out rather than derived from the stroke row's own bbox,
// because the carrier scales halfW too: under scale(2 1.5) the row is padded by 4 in x and 3 in y,
// and an expectation of "the row's box minus halfW" would be wrong in exactly the way this smoke is
// meant to catch.
const CARRIERS = [
  { name: 'identity', t: 'translate(40 70)', diag: true, pathBox: [40, 70, 80, 90] },
  { name: 'scale', t: 'translate(150 70) scale(2 1.5)', diag: true, pathBox: [150, 70, 230, 100] },
  { name: 'rotate', t: 'translate(260 70) rotate(30)', diag: false },
  { name: 'reflect', t: 'translate(390 70) scale(-1 1)', diag: false },
];
const SVG =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 160">' +
  '<defs><linearGradient id="gd" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0">' +
  '<stop offset="0" stop-color="#101418"/><stop offset="1" stop-color="#f05a28"/>' +
  '</linearGradient></defs>' +
  CARRIERS.map(
    (c) =>
      `<g transform="${c.t}"><rect x="0" y="0" width="${W}" height="${H}"` +
      ` fill="url(#gd)" stroke="url(#gd)" stroke-width="${SW}"/></g>`,
  ).join('') +
  '</svg>';

const b = await importSvg(SVG, { preserveViewport: true });
const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
const st = pm.floatsPerShape,
  M = pm.metaFloats;
const G = new Float32Array(b.gradients);
const GRAD_STRIDE = 16,
  UNITS = 2,
  INV = 4; // gradient record layout
const F_FILL_GRAD = 28,
  F_STROKE_GRAD = 29; // meta row floats

// Rows that reference a gradient, in emission order; fill and stroke are separate rows.
const rows = [];
for (let s = 0; s < pm.numShapes; s++) {
  const f = M[s * st + F_FILL_GRAD] | 0,
    k = M[s * st + F_STROKE_GRAD] | 0;
  if (f > 0) rows.push({ s, gid: f, kind: 'fill' });
  if (k > 0) rows.push({ s, gid: k, kind: 'stroke' });
}
const fills = rows.filter((r) => r.kind === 'fill');
const strokes = rows.filter((r) => r.kind === 'stroke');
if (fills.length !== CARRIERS.length || strokes.length !== CARRIERS.length) {
  fail(
    `expected ${CARRIERS.length} fill rows and ${CARRIERS.length} stroke rows, got ` +
      `${fills.length} / ${strokes.length}`,
  );
} else {
  ok(`${fills.length} fill rows and ${strokes.length} stroke rows reference a gradient`);
}

const unitsOf = (gid) => G[(gid - 1) * GRAD_STRIDE + UNITS];
const invOf = (gid) =>
  Array.from(G.slice((gid - 1) * GRAD_STRIDE + INV, (gid - 1) * GRAD_STRIDE + INV + 6));
const bboxOf = (s) => Array.from(M.slice(s * st, s * st + 4));

// --- 1. no stroke gradient may sit on the shared objectBoundingBox row ---------------------------
for (let i = 0; i < strokes.length && i < CARRIERS.length; i++) {
  const r = strokes[i],
    c = CARRIERS[i];
  const u = unitsOf(r.gid);
  if (u === 0) ok(`stroke on the ${c.name} carrier is on its own record ${r.gid} (units 0)`);
  else {
    fail(
      `stroke on the ${c.name} carrier is on record ${r.gid} with units ${u} — it normalizes` +
        " through the stroke row's halfW-padded bbox, which §7.11 excludes",
    );
  }
}

// --- 2. the supplemental matrix must map the unit square onto the PATH-TIGHT box -----------------
// The inverse-gradientTransform slot holds inv(gradientTransform) x inv(supplemental); with no
// gradientTransform on the element it is inv(supplemental) alone, so inverting it back gives the
// supplemental matrix. For the axis-aligned carriers that matrix is diagonal and checkable in
// closed form: it must map (0,0) -> the path box's min corner and (1,1) -> its max corner, and
// that box must be strictly SMALLER than the stroke row's own bbox on every side.
const inv2x3 = (m) => {
  const [a, bq, c, d, e, f] = m;
  const det = a * d - bq * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -bq / det, -c / det, a / det, (c * f - d * e) / det, (bq * e - a * f) / det];
};
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const near = (x, y, eps = 1e-3) => Math.abs(x - y) <= eps;

for (let i = 0; i < strokes.length && i < CARRIERS.length; i++) {
  const r = strokes[i],
    c = CARRIERS[i];
  if (unitsOf(r.gid) !== 0) continue; // already reported above
  const S = inv2x3(invOf(r.gid));
  if (!S) {
    fail(`${c.name}: the stroke record's inverse matrix is singular`);
    continue;
  }
  const p0 = apply(S, 0, 0),
    p1 = apply(S, 1, 1);
  const bb = bboxOf(r.s); // the STROKE row's box: path + halfW, scaled
  // Under a rotation the path-tight box in DOCUMENT space is not an axis-aligned rect the unit
  // square's corners land on, so only the axis-aligned carriers are checked in closed form here.
  // The others are covered by the units test above and by objectBoundingBoxGradientSmoke.
  if (!c.diag) {
    ok(`${c.name}: units 0 with a non-diagonal matrix (closed form is the rotated smoke's)`);
    continue;
  }
  const want0 = [c.pathBox[0], c.pathBox[1]],
    want1 = [c.pathBox[2], c.pathBox[3]];
  const got = `(${p0.map((v) => v.toFixed(2))}) .. (${p1.map((v) => v.toFixed(2))})`;
  const wanted = `(${want0.map((v) => v.toFixed(2))}) .. (${want1.map((v) => v.toFixed(2))})`;
  if (
    !near(p0[0], want0[0]) ||
    !near(p0[1], want0[1]) ||
    !near(p1[0], want1[0]) ||
    !near(p1[1], want1[1])
  ) {
    fail(`${c.name}: the unit square maps onto ${got}, want the path-tight box ${wanted}`);
    continue;
  }
  // …and the box the shared-row arithmetic would use must be strictly bigger, or this carrier
  // proves nothing: a stroke row whose bbox already equalled the path box would pass either way.
  const pads = [want0[0] - bb[0], want0[1] - bb[1], bb[2] - want1[0], bb[3] - want1[1]];
  if (pads.every((v) => v > 1e-6)) {
    ok(
      `${c.name}: the unit square maps onto the path-tight box ${wanted}; the stroke row's own box` +
        ` is bigger on every side by [${pads.map((v) => v.toFixed(2))}]`,
    );
  } else {
    fail(
      `${c.name}: the stroke row's bbox is not padded ([${pads.map((v) => v.toFixed(2))}]), so this` +
        ' carrier cannot tell the two normalizations apart',
    );
  }
}

// --- 3. the fill row on a positive-diagonal carrier must NOT have moved --------------------------
// This is the exact test the fill placement relies on. If minting for strokes also minted for these fills, every
// already-correct bundle would gain a gradient row for nothing.
const sharedFills = fills.filter((r, i) => CARRIERS[i] && CARRIERS[i].diag && unitsOf(r.gid) === 1);
const diagFills = CARRIERS.filter((c) => c.diag).length;
if (sharedFills.length === diagFills) {
  ok(`${diagFills} positive-diagonal FILL rows still take the shared objectBoundingBox record`);
} else {
  fail(
    `${sharedFills.length} of ${diagFills} positive-diagonal fill rows kept the shared record —` +
      ' the exact test that protects already-correct bundles has been loosened',
  );
}

// --- 4. a stroke-less shape must mint nothing extra ----------------------------------------------
{
  const plain = await importSvg(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"' +
      ' viewBox="0 0 100 100"><defs><linearGradient id="g" gradientUnits="objectBoundingBox"' +
      ' x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000"/>' +
      '<stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
      '<rect x="10" y="10" width="40" height="20" fill="url(#g)"/></svg>',
    { preserveViewport: true },
  );
  const n = new Float32Array(plain.gradients).length / GRAD_STRIDE;
  assert.equal(n, 1, 'an unstroked objectBoundingBox fill should need exactly one gradient record');
  ok('an unstroked objectBoundingBox fill still needs exactly one gradient record');
}

// Zero local extents remain invalid after rotation and stroke expansion.
for (const kind of ['linearGradient', 'radialGradient']) {
  for (const transform of ['', 'rotate(30 32 32)', 'skewX(20)']) {
    for (const [d, empty] of [
      ['M8 32H56', true],
      ['M32 8V56', true],
      ['M8 8L56 56', false],
    ]) {
      for (const units of ['objectBoundingBox', 'userSpaceOnUse']) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>
          <${kind} id="base" gradientUnits="${units}"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></${kind}>
          <${kind} id="g" href="#base"/></defs><g stroke="url(#g)" fill="none" stroke-width="8">
          <path d="${d}" transform="${transform}"/></g></svg>`;
        const section = await importSvg(svg, { preserveViewport: true, keepInvisibleShapes: true });
        const meta = parseMetaBin(section.meta, section.metaFloatsPerShape);
        let painted = false;
        for (let row = 0; row < meta.numShapes; row++) {
          const at = row * meta.floatsPerShape;
          if (!(meta.metaFloats[at + 27] & 256) && meta.metaFloats[at + 11] > 0) painted = true;
        }
        assert.equal(
          painted,
          !(empty && units === 'objectBoundingBox'),
          `${kind} ${units} ${d} ${transform}`,
        );
      }
    }
  }
}
ok('inherited linear/radial paints validate the unpadded local box under rotation and skew');

if (failures) {
  console.error(`OBB-STROKE-GRADIENT FAIL (${failures})`);
  process.exit(1);
}
console.log('\nOBB-STROKE-GRADIENT PASS');
