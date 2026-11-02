// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// objectBoundingBoxTransformSmoke — an objectBoundingBox clip or mask turns, skews and flips WITH the element
// that references it.
//
// WHAT THE SPEC SAYS. SVG 1.1 §7.11: "The bounding box is the tightest fitting rectangle aligned with the axes of
// the APPLICABLE ELEMENT'S USER COORDINATE SYSTEM that entirely encloses the applicable element and its
// descendants", computed exclusive of the element's own transform; the user agent then "inserts a supplemental
// transformation matrix into the nested transformation stack", [(maxx-minx) 0 0 (maxy-miny) minx miny]. NESTED —
// so the element's CTM, its own transform included, applies on top of it. CSS Masking 1 repeats it for clip-path:
// the coordinate system "has its origin at the top left corner of the bounding box of the element to which the
// clipping path applies to and the same width and height of this bounding box".
//
// THE TRAP. The referencing shape's DOCUMENT-SPACE axis-aligned box with [w 0 0 h x0 y0] over it as the whole
// matrix is the product only when the carrier's linear part is a positive diagonal. Under a rotation the
// document AABB of a turned shape is larger than the shape and stays axis-aligned, so the clip would not turn: a
// 40x20 rect under rotate(90) with a `width="0.5"` clip would keep the left half of the AABB, [-20, 0, -10, 40],
// where the rect's own left half lands at [-20, 0, 0, 20]. Under a reflection the box is right but the unit
// square's +x runs the wrong way, so an asymmetric clip would land mirrored.
//
// RELATED, and covered elsewhere:
//   - objectBoundingBox GRADIENTS. _paintSample.glsl sampleGradient maps emCoord through `shapeBB`, the meta
//     row's texel-0 bbox, which is the document-space AABB, and a single AABB cannot express the turned box;
//     so the gradient record carries a matrix instead (test/objectBoundingBoxGradientSmoke.mjs).
//   - objectBoundingBox FILTER REGIONS. bundleFinalize resolves a group filter's fractional region against the
//     same document-space AABB (shapeBbRaw) and stores an axis-aligned root-space rect.
// Not affected: <pattern>, which takes the referencing shape's box in its own user space
// (importWalkShapes.js `userBbox`, taken before the transform) and composes patternMatrix = ctm x patternTransform.
//
// No GPU. Four independent readings:
//   (a) the clip / mask row's own bbox, against the corners of the element-space clip mapped by hand;
//   (b) what actually gets DRAWN, through a CPU model of the fill kernel (hitTest/bandWinding): fill coverage
//       times the clip's at the same document point must be 1 inside the region the spec puts it and 0 outside;
//   (c) the same statement over the demo asset this file derives (four transforms in one drawing);
//   (d) and all of it at 2^-20 and 2^20, where every row must be the scale-1 row times the ratio.
//
// Mutation, required to FAIL: `ctm = [w, 0, 0, h, refBb[0], refBb[1]]` over _bindingBb.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { bandFillCoverage } = await import('../src/hitTest/bandWinding.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const fmt = (a) => (a ? '[' + a.map((v) => +v.toFixed(3)).join(', ') + ']' : 'none');

const VB = [-100, -100, 200, 200];
const CLIP = (x, w) =>
  `<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="${x}" y="0" width="${w}" height="1"/></clipPath>`;
const MASK = (x, w) =>
  `<mask id="m" maskContentUnits="objectBoundingBox"><rect x="${x}" y="0" width="${w}" height="1" fill="#ffffff"/></mask>`;
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB.join(' ')}"><defs>${defs}</defs>${body}</svg>`;

const rowsOf = (b) => new Float32Array(b.meta, 32);
const bboxOf = (m, r) => Array.from(m.slice(r * 48, r * 48 + 4));
const LAYER = 0x100;
const drawnRows = (m) => [...Array(m.length / 48).keys()].filter((r) => !(m[r * 48 + 27] & LAYER));
const span = (m, first, beginBit, endBit) => {
  if (!(m[first * 48 + 27] & beginBit)) return [first];
  const out = [];
  for (let q = first; q < m.length / 48; q++) {
    out.push(q);
    if (m[q * 48 + 27] & endBit) break;
  }
  return out;
};
const clipRows = (m, r) =>
  m[r * 48 + 30] > 0 ? span(m, m[r * 48 + 30] - 1, 1 << 11, 1 << 12) : [];
const maskRows = (m, r) => (m[r * 48 + 31] > 0 ? span(m, m[r * 48 + 31] - 1, 1 << 9, 1 << 10) : []);

// The element-space clip rect [x0, y0, x1, y1] mapped through `M` = [a b c d e f], as an AABB.
const mapBox = (M, bb) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [px, py] of [
    [bb[0], bb[1]],
    [bb[2], bb[1]],
    [bb[2], bb[3]],
    [bb[0], bb[3]],
  ]) {
    const qx = M[0] * px + M[2] * py + M[4],
      qy = M[1] * px + M[3] * py + M[5];
    x0 = Math.min(x0, qx);
    y0 = Math.min(y0, qy);
    x1 = Math.max(x1, qx);
    y1 = Math.max(y1, qy);
  }
  return [x0, y0, x1, y1];
};
const ROT = (deg) => {
  const t = (deg * Math.PI) / 180,
    c = Math.cos(t),
    s = Math.sin(t);
  return [c, s, -s, c, 0, 0];
};
const SKEWX = (deg) => [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];

// THE DEMO ASSET, checked in (c) below and derived by scripts/genSmokeAssets.mjs to
// examples/smoke/objectBoundingBoxTransform__OBB_TRANSFORM_DEMO.svg, which is what a GPU check renders. Four
// cells, each the same 40 x 20 rect: pale in full, solid where an objectBoundingBox clip of its middle half
// keeps it. The solid band must be centered in every pale rect and turn, skew and flip with it. Declared up here
// because genSmokeAssets evaluates the module's declarations in order and stops at the first throw.
// The flip cell uses an OFF-CENTER clip (cd2): a band symmetric about the rect's middle lands in the same place
// under scale(-1 1) either way, so only an asymmetric one shows which way the unit square's +x runs.
const CELLS = [
  ['', 40, 'cd', [10, 0, 30, 20]],
  ['rotate(30)', 140, 'cd', [10, 0, 30, 20]],
  ['skewX(30)', 240, 'cd', [10, 0, 30, 20]],
  ['scale(-1 1)', 360, 'cd2', [4, 0, 20, 20]],
];
const OBB_TRANSFORM_DEMO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 160">
<defs><clipPath id="cd" clipPathUnits="objectBoundingBox"><rect x="0.25" y="0" width="0.5" height="1"/></clipPath>
<clipPath id="cd2" clipPathUnits="objectBoundingBox"><rect x="0.1" y="0" width="0.4" height="1"/></clipPath></defs>
<rect x="0" y="0" width="420" height="160" fill="#101418"/>
${CELLS.map(
  ([xf, x, cid]) =>
    `<g transform="translate(${x} 60)${xf ? ' ' + xf : ''}">` +
    `<rect x="0" y="0" width="40" height="20" fill="#3a4654"/>` +
    `<rect x="0" y="0" width="40" height="20" fill="#f05a28" clip-path="url(#${cid})"/></g>`,
).join('\n')}
</svg>`;

// ------------------------------------------------------------------------------------------------
// (a) the clip / mask row's own box. The rect is 40 x 20 at the origin, so a `x=X width=W` fraction is the
//     element-space rect [40X, 0, 40(X+W), 20]; the row must be that rect through the element's transform.
console.log('(a) the placed row, against the element-space rect mapped by hand');
const RECT = (xf) =>
  `<rect x="0" y="0" width="40" height="20"${xf ? ` transform="${xf}"` : ''} fill="#345"`;
const PLACED = [
  [
    'no transform',
    doc(RECT('') + ' clip-path="url(#c)"/>', CLIP(0, 0.5)),
    null,
    [0, 0, 20, 20],
    'clip',
  ],
  [
    'rotate(90)',
    doc(RECT('rotate(90)') + ' clip-path="url(#c)"/>', CLIP(0, 0.5)),
    ROT(90),
    [0, 0, 20, 20],
    'clip',
  ],
  [
    'rotate(30)',
    doc(RECT('rotate(30)') + ' clip-path="url(#c)"/>', CLIP(0, 0.5)),
    ROT(30),
    [0, 0, 20, 20],
    'clip',
  ],
  [
    'skewX(30)',
    doc(RECT('skewX(30)') + ' clip-path="url(#c)"/>', CLIP(0.25, 0.5)),
    SKEWX(30),
    [10, 0, 30, 20],
    'clip',
  ],
  [
    'scale(-1 1)',
    doc(RECT('scale(-1 1)') + ' clip-path="url(#c)"/>', CLIP(0, 0.5)),
    [-1, 0, 0, 1, 0, 0],
    [0, 0, 20, 20],
    'clip',
  ],
  [
    'a group carrying the clip',
    doc(`<g transform="rotate(30)" clip-path="url(#c)">${RECT('')}/></g>`, CLIP(0, 0.5)),
    ROT(30),
    [0, 0, 20, 20],
    'clip',
  ],
  [
    '<use> carrying the clip',
    doc(
      `<use href="#r" transform="rotate(30)" clip-path="url(#c)"/>`,
      CLIP(0, 0.5) + `${RECT('')} id="r"/>`,
    ),
    ROT(30),
    [0, 0, 20, 20],
    'clip',
  ],
  [
    'a mask under rotate(30)',
    doc(RECT('rotate(30)') + ' mask="url(#m)"/>', MASK(0, 0.5)),
    ROT(30),
    [0, 0, 20, 20],
    'mask',
  ],
];
for (const [label, svg, M, elBox, kind] of PLACED) {
  const b = await importSvg(svg, { preserveViewport: true });
  const m = rowsOf(b),
    r = drawnRows(m)[0];
  const rows = kind === 'mask' ? maskRows(m, r) : clipRows(m, r);
  const got = rows.length ? bboxOf(m, rows[0]) : null;
  const want = M ? mapBox(M, elBox) : elBox;
  ok(
    !!got && got.every((v, i) => Math.abs(v - want[i]) <= 1e-3),
    `${label}: ${kind} row ${fmt(got)}, want ${fmt(want)}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (b) what actually gets DRAWN, through a CPU model of the fill kernel: fill coverage times the clip's (or the
//     mask's) at the same document point. The visible region is the element-space rect [10, 0, 30, 20] — the
//     middle half of a 40 x 20 rect, strictly inside it left and right — carried by the element's transform, so
//     the oracle is a point-in-rect test after mapping the sample back through that transform. A MARGIN of 3.5
//     element units (over 1.5 px at this grid, for every transform here) leaves the antialiased band out: inside
//     it, coverage must be 1; outside, 0. The band is what a coincident-edge comparison against a
//     hand-written twin cannot judge, since there the clip's ramp multiplies the fill's.
console.log('(b) the drawn region, through the CPU fill kernel, against the spec placement');
const MARGIN = 3.5;
function sample(b, M, EL, N = 96) {
  const m = rowsOf(b),
    bands = new Float32Array(b.bands),
    curves = new Float32Array(b.curves);
  const ppe = N / VB[2];
  const cov = (r, x, y) => {
    const o = r * 48;
    if (x < m[o] || x > m[o + 2] || y < m[o + 1] || y > m[o + 3]) return 0;
    return bandFillCoverage(
      bands,
      curves,
      [m[o + 16], m[o + 17], m[o + 18], m[o + 19]],
      [m[o], m[o + 1], m[o + 2], m[o + 3]],
      x,
      y,
      ppe,
      ppe,
      m[o + 13] > 0.5,
    );
  };
  const det = M[0] * M[3] - M[1] * M[2];
  const back = (x, y) => {
    const px = x - M[4],
      py = y - M[5];
    return [(M[3] * px - M[2] * py) / det, (-M[1] * px + M[0] * py) / det];
  };
  let nIn = 0,
    nOut = 0,
    badIn = 0,
    badOut = 0,
    worst = '';
  for (const r of drawnRows(m)) {
    if (!(m[r * 48 + 7] > 0)) continue;
    const layers = [clipRows(m, r), maskRows(m, r)].filter((rows) => rows.length);
    if (!layers.length) continue;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = VB[0] + ((i + 0.5) * VB[2]) / N,
          y = VB[1] + ((j + 0.5) * VB[3]) / N;
        const [u, v] = back(x, y);
        const inside =
          u >= EL[0] + MARGIN && u <= EL[2] - MARGIN && v >= EL[1] + MARGIN && v <= EL[3] - MARGIN;
        const outside =
          u <= EL[0] - MARGIN || u >= EL[2] + MARGIN || v <= EL[1] - MARGIN || v >= EL[3] + MARGIN;
        if (!inside && !outside) continue;
        let c = cov(r, x, y);
        for (const rows of layers) c *= Math.max(...rows.map((q) => cov(q, x, y)));
        if (inside) {
          nIn++;
          if (!(c > 0.99)) {
            badIn++;
            if (!worst) worst = `inside (${u.toFixed(1)}, ${v.toFixed(1)}) reads ${c.toFixed(3)}`;
          }
        } else {
          nOut++;
          if (!(c < 0.01)) {
            badOut++;
            if (!worst) worst = `outside (${u.toFixed(1)}, ${v.toFixed(1)}) reads ${c.toFixed(3)}`;
          }
        }
      }
  }
  return { nIn, nOut, badIn, badOut, worst };
}
const DRAWN = [
  [
    'rotate(30)',
    doc(RECT('rotate(30)') + ' clip-path="url(#c)"/>', CLIP(0.25, 0.5)),
    ROT(30),
    [10, 0, 30, 20],
  ],
  [
    'rotate(90)',
    doc(RECT('rotate(90)') + ' clip-path="url(#c)"/>', CLIP(0.25, 0.5)),
    ROT(90),
    [10, 0, 30, 20],
  ],
  [
    'skewX(30)',
    doc(RECT('skewX(30)') + ' clip-path="url(#c)"/>', CLIP(0.25, 0.5)),
    SKEWX(30),
    [10, 0, 30, 20],
  ],
  // OFF-CENTER for the reflection: a band symmetric about the rect's middle lands in the same place either way,
  // because the document box and the element box then agree; only an asymmetric one shows the flipped +x.
  [
    'scale(-1 1)',
    doc(RECT('scale(-1 1)') + ' clip-path="url(#c)"/>', CLIP(0.1, 0.4)),
    [-1, 0, 0, 1, 0, 0],
    [4, 0, 20, 20],
  ],
  [
    'a mask under rotate(30)',
    doc(RECT('rotate(30)') + ' mask="url(#m)"/>', MASK(0.25, 0.5)),
    ROT(30),
    [10, 0, 30, 20],
  ],
];
for (const [label, svg, M, EL] of DRAWN) {
  const s = sample(await importSvg(svg, { preserveViewport: true }), M, EL);
  ok(
    s.nIn > 20 && s.nOut > 500 && s.badIn === 0 && s.badOut === 0,
    `${label}: ${s.nIn} px inside all read 1 (${s.badIn} do not), ${s.nOut} px outside all read 0 (${s.badOut} do not)${s.worst ? '; ' + s.worst : ''}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (c) one asset a human (or a GPU) can look at: four cells, each the same 40 x 20 rect, pale in full and solid
//     where an objectBoundingBox clip of the middle half keeps it. The solid band must sit in the middle of each
//     pale rect, turned and skewed with it. Without the supplemental matrix the band would be axis-aligned and off-center in cells 2-4.
//     Derived to examples/smoke/objectBoundingBoxTransform__OBB_TRANSFORM_DEMO.svg by scripts/genSmokeAssets.mjs.
console.log('(c) the demo asset: the solid band is the middle half of each pale rect');
{
  const b = await importSvg(OBB_TRANSFORM_DEMO, { preserveViewport: true });
  const m = rowsOf(b),
    rows = drawnRows(m).filter((r) => clipRows(m, r).length);
  const bad = [];
  CELLS.forEach(([xf, x, , elBox], k) => {
    const T = [1, 0, 0, 1, x, 60];
    const L =
      xf === 'rotate(30)'
        ? ROT(30)
        : xf === 'skewX(30)'
          ? SKEWX(30)
          : xf
            ? [-1, 0, 0, 1, 0, 0]
            : [1, 0, 0, 1, 0, 0];
    const M = [
      T[0] * L[0] + T[2] * L[1],
      T[1] * L[0] + T[3] * L[1],
      T[0] * L[2] + T[2] * L[3],
      T[1] * L[2] + T[3] * L[3],
      T[0] * L[4] + T[2] * L[5] + T[4],
      T[1] * L[4] + T[3] * L[5] + T[5],
    ];
    const want = mapBox(M, elBox);
    const got = rows[k] == null ? null : bboxOf(m, clipRows(m, rows[k])[0]);
    if (!got || !got.every((v, i) => Math.abs(v - want[i]) <= 1e-3))
      bad.push(`cell ${k} ${xf || 'plain'}: ${fmt(got)} want ${fmt(want)}`);
  });
  ok(
    rows.length === CELLS.length && bad.length === 0,
    `${rows.length} clipped cells, each clip row the middle half of its own rect${bad.length ? ' -- ' + bad.join('; ') : ''}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (d) and the placement is the same drawing at every size.
console.log('(d) the same placement at 2^-20 and 2^20');
{
  const wrap = (raw, S) => {
    const m = raw.match(/<svg\b[^>]*>/);
    const open = m[0].replace(/viewBox="[^"]+"/, `viewBox="${VB.map((v) => v * S).join(' ')}"`);
    const i0 = raw.indexOf(m[0]) + m[0].length,
      i1 = raw.lastIndexOf('</svg>');
    return open + `<g transform="scale(${S})">` + raw.slice(i0, i1) + '</g></svg>';
  };
  for (const [label, svg, , , kind] of PLACED.slice(1)) {
    const bad = [];
    const m1 = rowsOf(await importSvg(wrap(svg, 1), { preserveViewport: true }));
    for (const e of [-20, 20]) {
      const S = 2 ** e,
        ms = rowsOf(await importSvg(wrap(svg, S), { preserveViewport: true }));
      if (ms.length !== m1.length) {
        bad.push(`2^${e}: ${m1.length / 48} rows -> ${ms.length / 48}`);
        continue;
      }
      for (let r = 0; r < m1.length / 48; r++) {
        for (let i = 0; i < 4; i++)
          if (ms[r * 48 + i] !== m1[r * 48 + i] * S) {
            bad.push(`2^${e} row ${r}: ${fmt(bboxOf(m1, r))} x ${S} != ${fmt(bboxOf(ms, r))}`);
            r = m1.length;
            break;
          }
      }
    }
    ok(
      bad.length === 0,
      `${label} (${kind}): every row scales by the ratio${bad.length ? ' -- ' + bad[0] : ''}`,
    );
  }
}

console.log(
  fail ? `objectBoundingBoxTransformSmoke FAIL (${fail})` : 'objectBoundingBoxTransformSmoke PASS',
);
process.exit(fail ? 1 : 0);
