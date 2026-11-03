// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// objectBoundingBoxGradientSmoke — an objectBoundingBox GRADIENT turns, skews and flips WITH the element it
// paints.
//
// WHAT THE SPEC SAYS. SVG 1.1 §13.2.2: under gradientUnits="objectBoundingBox" the gradient's coordinate system
// "is established using the bounding box of the element to which the gradient is applied ... and then applying
// the transform specified by attribute gradientTransform". §7.11 says what that box is -- "the tightest fitting
// rectangle aligned with the axes of the APPLICABLE ELEMENT'S USER COORDINATE SYSTEM", the element's own
// transform excluded from it -- and that the user agent "inserts a supplemental transformation matrix into the
// nested transformation stack", [(maxx-minx) 0 0 (maxy-miny) minx miny]. NESTED: the element's CTM applies on
// top. The element a gradient is applied to is the LEAF being painted, never an ancestor -- `fill` resolves per
// painted element, so `<g fill="url(#g)">` gives each child its own box. So the full chain from a document point
// to the gradient's own coordinates is
//     inv(gradientTransform) x inv([w 0 0 h minx miny]) x inv(CTM).
//
// THE TRAP. _paintSample.glsl sampleGradient normalizes the fragment through `shapeBB`, the meta row's
// bbox, which is the DOCUMENT-space axis-aligned box of the already-transformed geometry. That box equals
// CTM x [w 0 0 h minx miny] only when the CTM's linear part is a POSITIVE DIAGONAL. Under a rotation the
// document AABB of a turned shape is bigger than the shape and stays axis-aligned, so the gradient would not
// turn with it (a 40x20 rect under rotate(30) has a 44.6x37.3 document box, and the ramp would run along the
// page's x); under a reflection the box is right but the unit square's +x runs backwards, so the ramp would
// come out mirrored.
//
// THE PLACEMENT. Not a new meta texel: the bundle already carries a full 2x3 per gradient -- the record's
// inverse-gradientTransform, which the shader applies immediately after the normalization -- so the supplemental
// matrix composes into THAT and the record's units flag flips to userSpaceOnUse. One extra 16-float record per
// distinct (gradient, placement) pair, no wire change, no shader change, and no extra per-fragment fetch in the
// seven places sampleGradient is called from. A positive-diagonal FILL keeps the shader's own arithmetic under an
// exact test, so nothing that is already right moves.
//
// STROKES: a STROKE row's meta bbox is halfW/miter-padded (§7.11: the box is "without the stroke"), so stroke
// gradients take the supplemental matrix, which is built from the path-tight own box
// (test/objectBoundingBoxStrokeGradientSmoke.mjs). Part (c) pins the rotated stroke case.
//
// No GPU. Six readings:
//   (a) the gradient PARAMETER t at sample points, through a faithful JS model of sampleGradient, against the
//       spec chain above -- for no transform, rotate, skew, reflect, a translated rotate, a group transform and
//       an authored gradientTransform;
//   (b) the same for a RADIAL gradient (a different projection off the same coordinates);
//   (c) the same for a STROKE gradient under a rotation;
//   (d) the guard: a positive-diagonal carrier mints NO instance and keeps units=objectBoundingBox;
//   (e) the demo asset this file derives, four cells of the same rect;
//   (f) and the same t at 2^-20 and 2^20.
//
// Mutation, required to FAIL: return null unconditionally from bundleFinalize's _obbGradSup.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const VB = [-100, -100, 200, 200];
const rowsOf = (b) => new Float32Array(b.meta, 32);
const gradsOf = (b) => new Float32Array(b.gradients);
const LAYER = 0x100;
const drawnRows = (m) => [...Array(m.length / 48).keys()].filter((r) => !(m[r * 48 + 27] & LAYER));

// --- 2x3 affine helpers, SVG [a b c d e f] order -------------------------------------------------
const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const inv = (M) => {
  const det = M[0] * M[3] - M[1] * M[2];
  const ia = M[3] / det,
    ib = -M[1] / det,
    ic = -M[2] / det,
    id = M[0] / det;
  return [ia, ib, ic, id, -(ia * M[4] + ic * M[5]), -(ib * M[4] + id * M[5])];
};
const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1],
  A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3],
  A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4],
  A[1] * B[4] + A[3] * B[5] + A[5],
];
const ROT = (deg) => {
  const t = (deg * Math.PI) / 180,
    c = Math.cos(t),
    s = Math.sin(t);
  return [c, s, -s, c, 0, 0];
};
const SKEWX = (deg) => [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
const TRANS = (x, y) => [1, 0, 0, 1, x, y];
const SCALE = (x, y) => [x, 0, 0, y, 0, 0];

// --- the shader, ported -------------------------------------------------------------------------
/// _paintSample.glsl sampleGradient, steps 1 and 2: the fragment's position in the gradient's own
/// coordinates. `g` is the 16-float record, `bb` the meta row's bbox (the shader's `shapeBB`).
function gposEngine(g, bb, p) {
  let gx = p[0],
    gy = p[1];
  if (g[2] > 0.5) {
    // unitsFlag: objectBoundingBox
    gx = (p[0] - bb[0]) / Math.max(bb[2] - bb[0], 1e-6);
    gy = (p[1] - bb[1]) / Math.max(bb[3] - bb[1], 1e-6);
  }
  return [g[4] * gx + g[6] * gy + g[8], g[5] * gx + g[7] * gy + g[9]];
}
/// ...and the same position as the spec builds it: back through the element's CTM, normalized by the element's
/// own box, then through the authored gradientTransform's inverse.
function gposSpec(gT, C, box, p) {
  const [qx, qy] = apply(inv(C), p[0], p[1]);
  const u = (qx - box[0]) / (box[2] - box[0]),
    v = (qy - box[1]) / (box[3] - box[1]);
  return apply(inv(gT), u, v);
}
/// Step 3, shared by both: the gradient parameter. Slots 12..15 (+3) are the authored axis params and are the
/// same floats whichever way the position was reached.
function tOf(g, gpos) {
  if ((g[0] | 0) === 0) {
    const dx = g[14] - g[12],
      dy = g[15] - g[13];
    const dd = Math.max(dx * dx + dy * dy, 1e-12);
    return ((gpos[0] - g[12]) * dx + (gpos[1] - g[13]) * dy) / dd;
  }
  const cx = g[12],
    cy = g[13],
    r = g[14],
    fx = cx + g[15] * r,
    fy = cy + g[3] * r;
  const dx = gpos[0] - fx,
    dy = gpos[1] - fy,
    cfx = cx - fx,
    cfy = cy - fy;
  const A = dx * dx + dy * dy,
    B = 2 * (cfx * dx + cfy * dy),
    C = cfx * cfx + cfy * cfy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return NaN;
  return 1 / ((B + Math.sqrt(disc)) / (2 * A));
}

// --- fixtures -------------------------------------------------------------------------------------
const LIN = (extra = '') =>
  `<linearGradient id="g" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0"${extra}>` +
  '<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>';
const RAD =
  `<radialGradient id="g" gradientUnits="objectBoundingBox" cx="0.5" cy="0.5" r="0.5" fx="0.25" fy="0.5">` +
  '<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>';
const doc = (body, defs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB.join(' ')}"><defs>${defs}</defs>${body}</svg>`;
// The same 40 x 20 rect at the origin every time, so its own-SPACE box is [0, 0, 40, 20] in every case.
const EL_BOX = [0, 0, 40, 20];
const RECT = (xf, paint) =>
  `<rect x="0" y="0" width="40" height="20"${xf ? ` transform="${xf}"` : ''} ${paint}/>`;

// THE DEMO ASSET, checked in (e) and derived by scripts/genSmokeAssets.mjs to
// examples/smoke/objectBoundingBoxGradient__OBB_GRADIENT_DEMO.svg, which is what a GPU check renders. Four
// cells, each the same 40 x 20 rect filled with the same objectBoundingBox ramp running along the box's own +x,
// dark at x=0 and bright at x=1, with a hairline outline so the rect's own edges are visible. The ramp must run
// along each rect's own long axis: up-and-right in the rotated cell, sheared in the skewed one, and right-to-
// left in the reflected one. Without the placement all four ramps would run left-to-right across the page.
const GRAD_CELLS = [
  ['', 40],
  ['rotate(30)', 150],
  ['skewX(30)', 260],
  ['scale(-1 1)', 390],
];
const OBB_GRADIENT_DEMO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 160">
<defs><linearGradient id="gd" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#101418"/><stop offset="1" stop-color="#f05a28"/></linearGradient></defs>
<rect x="0" y="0" width="440" height="160" fill="#20262e"/>
${GRAD_CELLS.map(
  ([xf, x]) =>
    `<g transform="translate(${x} 70)${xf ? ' ' + xf : ''}">` +
    '<rect x="0" y="0" width="40" height="20" fill="url(#gd)" stroke="#ffffff" stroke-width="0.5"/></g>',
).join('\n')}
</svg>`;

// ------------------------------------------------------------------------------------------------
// (a) the gradient parameter, against the spec chain. Sample points are given in the ELEMENT's own space and
//     mapped to the document by the same carrier the spec chain unmaps them with, so the two readings meet only
//     if the bundle placed the gradient where the spec puts it.
console.log(
  '(a) the gradient parameter t, against inv(gradientTransform) x inv(supplemental) x inv(CTM)',
);
const SAMPLES = [
  [5, 5],
  [20, 10],
  [35, 15],
  [1, 19],
  [39, 1],
  [10, 2],
];
const CASES = [
  ['no transform', '', [1, 0, 0, 1, 0, 0], ''],
  ['rotate(30)', 'rotate(30)', ROT(30), ''],
  ['rotate(90)', 'rotate(90)', ROT(90), ''],
  ['skewX(30)', 'skewX(30)', SKEWX(30), ''],
  ['scale(-1 1)', 'scale(-1 1)', SCALE(-1, 1), ''],
  ['translate + rotate', 'translate(12 -7) rotate(40)', mul(TRANS(12, -7), ROT(40)), ''],
  ['scale(2 0.5) rotate(25)', 'scale(2 0.5) rotate(25)', mul(SCALE(2, 0.5), ROT(25)), ''],
  // ...and with an authored gradientTransform, which composes INSIDE the supplemental matrix.
  [
    'rotate(30) + gradientTransform',
    'rotate(30)',
    ROT(30),
    ' gradientTransform="rotate(20) scale(2 1)"',
  ],
];
for (const [label, xf, C, gtAttr] of CASES) {
  const gT = gtAttr ? mul(ROT(20), SCALE(2, 1)) : [1, 0, 0, 1, 0, 0];
  const b = await importSvg(doc(RECT(xf, 'fill="url(#g)"'), LIN(gtAttr)), {
    preserveViewport: true,
  });
  const m = rowsOf(b),
    G = gradsOf(b),
    r = drawnRows(m)[0];
  const gid = m[r * 48 + 28] | 0;
  const g = G.slice((gid - 1) * 16, gid * 16);
  const bb = Array.from(m.slice(r * 48, r * 48 + 4));
  let worst = 0,
    worstAt = '';
  for (const [ex, ey] of SAMPLES) {
    const p = apply(C, ex, ey);
    const got = tOf(g, gposEngine(g, bb, p)),
      want = tOf(g, gposSpec(gT, C, EL_BOX, p));
    if (Math.abs(got - want) > worst) {
      worst = Math.abs(got - want);
      worstAt = `(${ex}, ${ey}) t ${got.toFixed(5)}, want ${want.toFixed(5)}`;
    }
  }
  ok(
    gid > 0 && worst < 2e-4,
    `${label}: t matches the spec at every sample (worst ${worst.toExponential(2)}${worst >= 2e-4 ? ' -- ' + worstAt : ''})`,
  );
}

// ------------------------------------------------------------------------------------------------
// (b) a RADIAL gradient: the same coordinates, a different projection, and a focal point OFF center so a
//     mirrored or unturned box shows up rather than canceling by symmetry.
console.log('(b) a radial gradient, focal off center');
for (const [label, xf, C] of [
  ['rotate(30)', 'rotate(30)', ROT(30)],
  ['scale(-1 1)', 'scale(-1 1)', SCALE(-1, 1)],
]) {
  const b = await importSvg(doc(RECT(xf, 'fill="url(#g)"'), RAD), { preserveViewport: true });
  const m = rowsOf(b),
    G = gradsOf(b),
    r = drawnRows(m)[0];
  const gid = m[r * 48 + 28] | 0;
  const g = G.slice((gid - 1) * 16, gid * 16);
  const bb = Array.from(m.slice(r * 48, r * 48 + 4));
  let worst = 0;
  for (const [ex, ey] of SAMPLES) {
    const p = apply(C, ex, ey);
    const got = tOf(g, gposEngine(g, bb, p)),
      want = tOf(g, gposSpec([1, 0, 0, 1, 0, 0], C, EL_BOX, p));
    worst = Math.max(worst, Math.abs(got - want));
  }
  ok(
    gid > 0 && worst < 2e-4,
    `${label}: radial t matches the spec (worst ${worst.toExponential(2)})`,
  );
}

// ------------------------------------------------------------------------------------------------
// (c) a STROKE gradient. Its meta row's bbox is halfW/miter-padded, which is exactly the box §7.11 says the
//     gradient must NOT use ("without the stroke"), so the supplemental matrix has to carry the path-tight own
//     box for the reading to land.
console.log('(c) a stroke gradient under a rotation');
{
  const b = await importSvg(
    doc(RECT('rotate(30)', 'fill="none" stroke="url(#g)" stroke-width="6"'), LIN()),
    { preserveViewport: true },
  );
  const m = rowsOf(b),
    G = gradsOf(b);
  const rows = drawnRows(m).filter((r) => (m[r * 48 + 29] | 0) > 0);
  const r = rows[0];
  const gid = r == null ? 0 : m[r * 48 + 29] | 0;
  const g = gid ? G.slice((gid - 1) * 16, gid * 16) : null;
  const bb = r == null ? null : Array.from(m.slice(r * 48, r * 48 + 4));
  let worst = 0;
  if (g)
    for (const [ex, ey] of SAMPLES) {
      const p = apply(ROT(30), ex, ey);
      worst = Math.max(
        worst,
        Math.abs(
          tOf(g, gposEngine(g, bb, p)) - tOf(g, gposSpec([1, 0, 0, 1, 0, 0], ROT(30), EL_BOX, p)),
        ),
      );
    }
  ok(
    !!g && worst < 2e-4,
    `stroke row ${r}: t matches the spec through the PATH-TIGHT box (worst ${worst.toExponential(2)})`,
  );
}

// ------------------------------------------------------------------------------------------------
// (d) nothing that is already right moves: a carrier whose linear part is a positive diagonal keeps the
//     document-AABB arithmetic, so the table stays one row and the record stays objectBoundingBox.
console.log('(d) a positive-diagonal carrier mints no instance');
for (const [label, xf] of [
  ['none', ''],
  ['translate(20 5)', 'translate(20 5)'],
  ['scale(3 2)', 'scale(3 2)'],
  ['translate + scale', 'translate(-30 10) scale(1.5 4)'],
]) {
  const b = await importSvg(doc(RECT(xf, 'fill="url(#g)"'), LIN()), { preserveViewport: true });
  const m = rowsOf(b),
    G = gradsOf(b);
  ok(
    G.length === 16 && G[2] === 1 && (m[drawnRows(m)[0] * 48 + 28] | 0) === 1,
    `${label}: 1 gradient row, units objectBoundingBox, shape on row 1 (got ${G.length / 16} rows, units ${G[2]})`,
  );
}

// ------------------------------------------------------------------------------------------------
// (e) one asset a human (or a GPU) can look at: four cells, each the same rect under the same ramp. Read here
//     the way (a) reads: the ramp direction in each cell must be the cell's own +x.
console.log("(e) the demo asset: the ramp runs along each rect's own +x");
{
  const b = await importSvg(OBB_GRADIENT_DEMO, { preserveViewport: true });
  const m = rowsOf(b),
    G = gradsOf(b);
  const rows = drawnRows(m).filter((r) => (m[r * 48 + 28] | 0) > 0);
  const bad = [];
  GRAD_CELLS.forEach(([xf, x], k) => {
    const L =
      xf === 'rotate(30)'
        ? ROT(30)
        : xf === 'skewX(30)'
          ? SKEWX(30)
          : xf
            ? SCALE(-1, 1)
            : [1, 0, 0, 1, 0, 0];
    const C = mul(TRANS(x, 70), L);
    const r = rows[k];
    if (r == null) {
      bad.push(`cell ${k}: no gradient row`);
      return;
    }
    const gid = m[r * 48 + 28] | 0,
      g = G.slice((gid - 1) * 16, gid * 16);
    const bb = Array.from(m.slice(r * 48, r * 48 + 4));
    for (const [ex, ey] of SAMPLES) {
      const p = apply(C, ex, ey);
      const got = tOf(g, gposEngine(g, bb, p)),
        want = tOf(g, gposSpec([1, 0, 0, 1, 0, 0], C, EL_BOX, p));
      if (Math.abs(got - want) > 2e-4) {
        bad.push(`cell ${k} ${xf || 'plain'}: t ${got.toFixed(4)} want ${want.toFixed(4)}`);
        break;
      }
    }
  });
  ok(
    rows.length === GRAD_CELLS.length && bad.length === 0,
    `${rows.length} gradient-filled cells, each ramp along its own +x${bad.length ? ' -- ' + bad.join('; ') : ''}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (f) and the same gradient at every size. t is a RATIO, so it is the same number at 2^-20 and 2^20 -- not the
//     same number times the ratio, which is what makes it a sharper check than a bbox comparison.
console.log('(f) the same t at 2^-20 and 2^20');
{
  const at = async (S) => {
    const raw = doc(RECT('rotate(30)', 'fill="url(#g)"'), LIN());
    const open = raw.match(/<svg\b[^>]*>/)[0];
    const svg =
      open.replace(/viewBox="[^"]+"/, `viewBox="${VB.map((v) => v * S).join(' ')}"`) +
      `<g transform="scale(${S})">` +
      raw.slice(open.length, raw.lastIndexOf('</svg>')) +
      '</g></svg>';
    const b = await importSvg(svg, { preserveViewport: true });
    const m = rowsOf(b),
      G = gradsOf(b),
      r = drawnRows(m)[0];
    const gid = m[r * 48 + 28] | 0,
      g = G.slice((gid - 1) * 16, gid * 16);
    const bb = Array.from(m.slice(r * 48, r * 48 + 4));
    return SAMPLES.map(([ex, ey]) => {
      const p = apply(mul(SCALE(S, S), ROT(30)), ex, ey);
      return tOf(g, gposEngine(g, bb, p));
    });
  };
  const t1 = await at(1);
  for (const e of [-20, 20]) {
    const ts = await at(2 ** e);
    let worst = 0;
    for (let i = 0; i < t1.length; i++) worst = Math.max(worst, Math.abs(ts[i] - t1[i]));
    ok(
      worst < 1e-4,
      `2^${e}: t is the scale-1 t at every sample (worst ${worst.toExponential(2)})`,
    );
  }
}

console.log(
  fail ? `objectBoundingBoxGradientSmoke FAIL (${fail})` : 'objectBoundingBoxGradientSmoke PASS',
);
process.exit(fail ? 1 : 0);
