// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importerScaleInvariantSmoke — the SVG importer builds the same bundle, up to scale, at every size.
//
// THE PROPERTY. Wrapping a drawing in scale(S), with the viewBox scaled to match, must scale every
// coordinate, length and area in the bundle and change nothing else. With S a power of two, and an
// origin offset that is a power of two times S, every add, multiply, divide and sqrt the importer does is
// exact, so the bundle at S is the bundle at 2 float for float: each float equal, or times the ratio, its
// inverse or its square (to a couple of float32 ulps, and to 1e-13 in the float64 plane, where Math.log in
// the quad arc length is not exactly covariant). A float that is neither is a decision taken against a
// constant.
//
// One case per defect, each at 2^-20 and 2^20, with and without the offset, against 2:
//   arcs          a native arc under scale(2^-20) stays an arc (transform.js: |det| > 1e-12 absolute)
//   rotatedConic  a rotated ellipse keeps its rotation at 2^20 (transform.js: |Qp01| > 1e-18, floors 1e-30)
//   cubicApex     a cubic whose leading coefficient cancels keeps its tight bbox at 2^20 (bbox.js)
//   radiusFix     an arc whose radii SVG enlarges, mid-contour, gains no closing line at 2^20: its end is rebuilt
//                 through acos, 1.4e-6 off at scale 1 (bbox.js splitSubpathsWithCloseInto: a jump over 1e-4)
//   shortLine     a stroke through a 1e-7 line keeps that line's direction at 2^-20 (textures.js: under 1e-12)
//   arcsJoin      an arcs join keeps its arc's curvature at 2^-20 (textures.js: radius cubed under 1e-12)
//   dashedQuads   dashes keep their start distances along small quads at 2^-20 (textures.js: A < 1e-12, arg)
//   thinOBB       a rotated fill 1e-4 across keeps its oriented cover at 2^-20 (mesh.js: covariance under 1e-20)
//   rotatedApex   a rotated arch (a quad drawn as a cubic) keeps its oriented cover at 2^20 (mesh.js: the
//                 extremum root canceled when the cubic coefficient is a rounding residue)
//   roundRectScale  a rounded rect under a 1.02e-4 non-uniform scale is not a round-rect SDF at 2^-20
//                 (importWalkShapes.js: the scale test floored at 1e-6)
//   openStroke    an open stroked fill is not read as closed at 2^-20 (bundleFinalize.js hasClosedSubpaths)
//   strokeEnds    two stroked subpaths keep their caps at 2^-20 (textures.js: ends paired within 1e-5)
//   zeroHandle    a stroke's joins keep their tangents at 2^-20 (textures.js: derivative under 1e-9)
//   clipChild     an objectBoundingBox clip keeps its child at 2^-20 (bundleFinalize.js: bbox under 1e-6)
//   patternTurn   a rotated pattern keeps its inverse at 2^-20 (bundleFinalize.js: |det| > 1e-12)
//   tinyCover     a fill 0.05 across keeps its cover quad at 2^-20 (mesh.js: extent over 1e-7)
//   rotatedRect   a rotated rect is not tagged a rect SDF at 2^-20 (importWalkShapes.js: |ctm[1]| < 1e-6)
//   patternGrid   _pattern.svg's children build no occupancy grid at 2^-20 (bundleFinalize.js: the gate compared
//                 their pattern-space area against a document union that took their tile in)
// and a silhouette (computeSilhouette) whose union joints all stay joins at 2, 2^-20 and 2^20 (textures.js:
// ends paired within an absolute 1e-5 would cap them, and a relative 1e-7 is under what the union resolves),
// and clip and mask rows in the user space of the element that references them: placed at scale 1 on a
// translated rect, a scaled group (own and inherited), a group with a rotated child (not rotated), a <use>, a mask,
// an intersection under two transforms, one clip under two transforms; every tracked asset with a clipPath, mask or
// pattern at 2^-20 and 2^20 with and without the offset, row by row by the space the row lives in (drawn, clip and
// mask rows x R; pattern children equal, carriers' inverse pattern matrix / R); and through a CPU model of the shader's
// sampling: coverage times the clip's at the same point) the clipped and masked half-diamonds at every size and the
// translated-rect clip against the same drawing written in place,
// and a pattern child whose occupancy grid follows its drawn area (patternTransform scale(2) and scale(0.5)) at
// 1, 2^-20 and 2^20,
// and, directly: segsToPathD round-trips a path 2^-20 across (segment.js: coordinates rounded to 1e-4);
// cubicCuspT finds the same cusp and reversal at 1, 2^-44, 2^-20 and 2^20 (cubicCusp.js: absolute floors and
// a canceling root); a quad's and an arc's tight bbox at 2^-42 keep their extrema (bbox.js: absolute 1e-12);
// two unmarked squares get two closing lines at every size (splitSubpathsWithCloseInto); roundCorners rounds
// every corner of a hexagon at 2^-20 and 2^20 (modifiers.js: 1e-9); buildGradientTables inverts
// gradientTransform="scale(2^-20)" (gradient.js: |det| < 1e-12 would fall back to identity; the wrapper cannot
// reach it, the transform is the gradient's own); and pickBandsXY counts the same band-crossing segments
// for a shape under 1e-6 across (buildContext.js: its extent floored at 1e-6).
//
// Not covered here, and why: vector-effect non-scaling strokes differ by design; the band box floor at 1e-6
// is shared with the shader (_coverage.glsl) and the CPU model (bandWinding.js) and must move with them.
import { readFileSync } from 'fs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { segsToPathD, mkLine, mkCubic } = await import('../src/svg/segment.js');
const { parsePathD } = await import('../src/svg/path.js');
const { cubicCuspT } = await import('../src/svg/cubicCusp.js');
const { pickBandsXY } = await import('../src/svg/buildContext.js');
const { parseGradients, buildGradientTables } = await import('../src/svg/gradient.js');

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

const svgDoc = (vb, body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
const CASES = {
  arcs: svgDoc(
    '0 0 64 64',
    '<path d="M10 30 A20 12 30 0 1 50 30 A20 12 30 0 1 10 30 Z" fill="#345"/>',
  ),
  rotatedConic: svgDoc(
    '0 0 4000 4000',
    '<ellipse cx="2000" cy="2000" rx="1500" ry="900" transform="rotate(30 2000 2000)" fill="#345"/>',
  ),
  cubicApex: svgDoc(
    '0 0 64 64',
    '<path d="M0.3 0.3 C13.7 40.1 46.6 40.1 60.4 0.3 Z" fill="#345"/>',
  ),
  radiusFix: svgDoc(
    '0 0 64 64',
    '<path d="M46.04547119140625 62.92547607421875 A24.675945670859267 10.060991133258364 7 0 0 2.78350830078125 4.496522903442383 L2.78350830078125 60 Z" fill="#345"/>',
  ),
  shortLine: svgDoc(
    '0 0 64 64',
    '<path d="M4 4 L30 4 L30.0000001 4 L30 30" fill="none" stroke="#000" stroke-width="2"/>',
  ),
  arcsJoin: svgDoc(
    '0 0 64 64',
    '<path d="M10 40 A20 20 0 0 1 50 40 L50 60" fill="none" stroke="#000" stroke-width="3" stroke-linejoin="arcs"/>',
  ),
  dashedQuads: svgDoc(
    '0 0 64 64',
    '<path d="M4 4 Q4.25 4.5 4.5 4 Q4.75 3.5 5 4 L40 4 L40 10" fill="none" stroke="#000" stroke-width="0.2" stroke-dasharray="3 1"/>',
  ),
  thinOBB: svgDoc(
    '0 0 64 64',
    '<path d="M10 10 L10.0001 10 L10.00012 10.00001 L10.00002 10.00001 Z" transform="rotate(30 10 10)" fill="#345"/><path d="M20 20 L50 20 L50 50 Z" fill="#345"/>',
  ),
  rotatedApex: svgDoc(
    '0 0 128 128',
    '<path d="M0.3 0.3 C13.7 40.1 46.6 40.1 99 0.3 Z" transform="rotate(30 50 20)" fill="#345"/>',
  ),
  roundRectScale: svgDoc(
    '0 0 64 64',
    '<rect x="10" y="10" width="40" height="20" rx="4" transform="scale(1 1.000102)" fill="#345"/>',
  ),
  openStroke: svgDoc(
    '0 0 64 64',
    '<path d="M4 4 L40 4 L40 40" fill="#c33" stroke="#000" stroke-width="2"/>',
  ),
  strokeEnds: svgDoc(
    '0 0 64 64',
    '<path d="M4 4 L30 4 M30 4.000003 L30 30" fill="none" stroke="#000" stroke-width="2"/>',
  ),
  zeroHandle: svgDoc(
    '0 0 64 64',
    '<path d="M4 30 C10 10 28 10 34 30 C34 30.000001 50 50 60 30" fill="none" stroke="#000" stroke-width="3" stroke-linejoin="miter"/>',
  ),
  clipChild: svgDoc(
    '0 0 64 64',
    '<g clip-path="url(#c)"><rect x="8" y="8" width="40" height="40" fill="#345"/></g>',
    '<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0.2" y="0.2" width="0.01" height="0.6"/></clipPath>',
  ),
  patternTurn: svgDoc(
    '0 0 64 64',
    '<rect x="4" y="4" width="56" height="56" fill="url(#p)"/>',
    '<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="4" height="4" fill="#c33"/></pattern>',
  ),
  tinyCover: svgDoc(
    '0 0 64 64',
    '<path d="M10 10 L10.05 10 L10.05 10.05 Z" fill="#345"/><path d="M20 20 L50 20 L50 50 Z" fill="#345"/>',
  ),
  rotatedRect: svgDoc(
    '0 0 64 64',
    '<rect x="20" y="20" width="20" height="10" transform="rotate(30 30 25)" fill="#345"/>',
  ),
  patternGrid: svgDoc(
    '0 0 200 200',
    '<rect x="10" y="10" width="80" height="80" fill="url(#dots)"/><rect x="100" y="10" width="80" height="80" fill="url(#stripes)"/><circle cx="100" cy="150" r="40" fill="url(#dots)"/>',
    '<pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#ccc"/><circle cx="10" cy="10" r="6" fill="#c33"/></pattern>' +
      '<pattern id="stripes" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#fff"/><line x1="0" y1="0" x2="10" y2="10" stroke="#33c" stroke-width="2"/></pattern>',
  ),
};

const OFF = 16384;
// A VIEWPORT PERCENTAGE IS NOT COVARIANT UNDER THE WRAPPER. SVG 1.1 §7.10 takes it of the viewport's size in the
// ROOT's user units (the scaled viewBox, S times the drawing's), and the length is then used in the user space of
// the element under scale(S): S squared in the document. The one such length the corpus has is a userSpaceOnUse
// mask's region (x/y/width/height, -10%/-10%/120%/120% when unstated; morphMaskRoute's masks), which the importer
// applies as a clip. So wrap() writes those as the lengths they are at the drawing's own size, and the wrapped
// document is the same drawing scaled.
function absMaskRegions(raw, vb) {
  return raw.replace(/<mask\b[^>]*>/g, (tag) => {
    if (!/maskUnits\s*=\s*["']\s*userSpaceOnUse\s*["']/.test(tag)) return tag;
    let t = tag;
    for (const [name, pct, vp] of [
      ['x', -10, vb[2]],
      ['y', -10, vb[3]],
      ['width', 120, vb[2]],
      ['height', 120, vb[3]],
    ]) {
      const re = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`),
        m = t.match(re);
      const v = m ? m[1].trim() : `${pct}%`;
      if (!v.endsWith('%')) continue;
      const abs = (parseFloat(v) / 100) * vp;
      t = m ? t.replace(re, ` ${name}="${abs}"`) : t.replace(/^<mask\b/, `<mask ${name}="${abs}"`);
    }
    return t;
  });
}
function wrap(raw, S, off) {
  const m = raw.match(/<svg\b[^>]*>/),
    vb = m[0]
      .match(/viewBox="([^"]+)"/)[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
  const T = off ? OFF * S : 0;
  const open = m[0].replace(
    /viewBox="[^"]+"/,
    `viewBox="${[vb[0] * S + T, vb[1] * S + T, vb[2] * S, vb[3] * S].join(' ')}"`,
  );
  const i0 = raw.indexOf(m[0]) + m[0].length,
    i1 = raw.lastIndexOf('</svg>');
  return (
    open +
    `<g transform="${off ? `translate(${T} ${T}) ` : ''}scale(${S})">` +
    absMaskRegions(raw.slice(i0, i1), vb) +
    '</g></svg>'
  );
}
const SECTIONS = [
  'curves',
  'curves64',
  'bands',
  'meta',
  'solid',
  'curveGeom',
  'gradients',
  'gradientStops',
  'dashes',
  'strokeMesh',
  'clipMesh',
  'maskMesh',
];
// Cases under 1e-6 across at 2^-20 fall under the band box floor the importer shares with the shader and
// the port; their band tables and band descriptors (meta 16..19) are not compared.
const UNDER_BAND_FLOOR = new Set(['clipChild', 'tinyCover', 'thinOBB']);
function differences(a, b, R, skipBands) {
  const rows = [];
  for (const k of [
    'numShapes',
    'flags',
    'segTypeMask',
    'totalSegments',
    'noAaFill',
    'noAaMixed',
    'noAaTree',
    'gwnTree',
    'extFlags',
  ])
    if (a[k] !== b[k]) rows.push(`${k} ${a[k]} -> ${b[k]}`);
  if (
    JSON.stringify((a.curveRangesByShape || []).map((r) => r && [r.begin, r.end])) !==
    JSON.stringify((b.curveRangesByShape || []).map((r) => r && [r.begin, r.end]))
  )
    rows.push('curve ranges');
  for (const k of SECTIONS) {
    if (skipBands && k === 'bands') continue;
    const x = a[k],
      y = b[k];
    if (!(x instanceof ArrayBuffer) && !(y instanceof ArrayBuffer)) continue;
    if (
      !(x instanceof ArrayBuffer) ||
      !(y instanceof ArrayBuffer) ||
      x.byteLength !== y.byteLength
    ) {
      rows.push(`${k} size ${x && x.byteLength} -> ${y && y.byteLength}`);
      continue;
    }
    const f64 = k === 'curves64';
    const u = f64 ? new Float64Array(x) : new Float32Array(x.slice(0, x.byteLength & ~3)),
      v = f64 ? new Float64Array(y) : new Float32Array(y.slice(0, y.byteLength & ~3));
    let bad = 0;
    for (let i = 0; i < u.length; i++) {
      const p = u[i],
        q = v[i];
      if (p === q || (p !== p && q !== q)) continue;
      if (skipBands && k === 'meta' && i >= 8 && (i - 8) % 48 >= 16 && (i - 8) % 48 <= 19) continue;
      const tol = f64 ? 1e-13 * Math.abs(q) : 2.5e-7 * Math.abs(q);
      if ([p * R, p / R, p * R * R, p / (R * R)].some((w) => Math.abs(q - w) <= tol)) continue;
      bad++;
    }
    if (bad) rows.push(`${k}: ${bad} floats`);
  }
  return rows;
}
console.log('bundles at 2^-20 and 2^20, with and without an offset, against scale 2');
for (const [name, svg] of Object.entries(CASES)) {
  const bad = [];
  for (const off of [false, true]) {
    const base = await importSvg(wrap(svg, 2, off), { preserveViewport: true });
    for (const e of [-20, 20]) {
      const S = 2 ** e,
        rows = differences(
          base,
          await importSvg(wrap(svg, S, off), { preserveViewport: true }),
          S / 2,
          UNDER_BAND_FLOOR.has(name),
        );
      if (rows.length) bad.push(`2^${e}${off ? '+offset' : ''}: ${rows.slice(0, 3).join(', ')}`);
    }
  }
  check(
    bad.length === 0,
    `${name}: the same bundle up to scale${bad.length ? ' -- ' + bad.slice(0, 2).join('; ') : ''}`,
  );
}

console.log('clip and mask rows in the user space of the element that references them');
{
  // A userSpaceOnUse <clipPath> or <mask> is in the user space of the element referencing it, that element's own
  // transform included (CSS Masking 1). The fill shader samples a clip row, and the mask bake draws a mask row, at the
  // drawn fragment's own document coordinate, so the rows must be stored in document space. A drain that walks such
  // a def at the identity would store the clip below on <rect transform="translate(30 30)"> at [0, 10]^2 and clip the
  // rect away. (The float-for-float check above cannot see it: identity-walked rows come out as equal floats at
  // every scale, so placement is checked here directly.)
  const { readdirSync } = await import('fs');
  const { bandFillCoverage } = await import('../src/hitTest/bandWinding.js');
  const rowsOf = (b) => new Float32Array(b.meta, 32);
  const bboxOf = (m, r) => Array.from(m.slice(r * 48, r * 48 + 4));
  // The rows a drawn row's clip or mask reads: the lone row, or the BEGIN..END span (clip bits 11/12, mask 9/10).
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
  const maskRows = (m, r) =>
    m[r * 48 + 31] > 0 ? span(m, m[r * 48 + 31] - 1, 1 << 9, 1 << 10) : [];
  const drawnRows = (m) =>
    [...Array(m.length / 48).keys()].filter((r) => !(m[r * 48 + 27] & 0x100));
  const svg100 = (body, defs) => svgDoc('0 0 100 100', body, defs);
  const C10 = '<clipPath id="c"><rect x="0" y="0" width="10" height="10"/></clipPath>';
  const M10 = '<mask id="m"><rect x="0" y="0" width="10" height="10" fill="#fff"/></mask>';
  const R40 = '<rect width="40" height="40" fill="#345"/>';
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
  // [label, svg, [[kind, expected bbox]...]] for the first drawn row: 'clip' and 'mask' read its first clip or mask
  // row, 'nested' that clip row's own clip (an intersection's outer half).
  const PLACED = [
    [
      'a clip on a translated rect',
      svg100(
        '<rect width="40" height="40" transform="translate(30 30)" clip-path="url(#c)" fill="#345"/>',
        C10,
      ),
      [['clip', [30, 30, 40, 40]]],
    ],
    [
      'a clip on a scaled group',
      svg100(`<g transform="scale(2)" clip-path="url(#c)">${R40}</g>`, C10),
      [['clip', [0, 0, 20, 20]]],
    ],
    [
      'a clip inherited inside a scaled group',
      svg100(`<g transform="scale(2)"><g clip-path="url(#c)">${R40}</g></g>`, C10),
      [['clip', [0, 0, 20, 20]]],
    ],
    [
      'a clip on a group whose child is rotated (the clip is not)',
      svg100(
        '<g clip-path="url(#c)"><rect width="40" height="40" transform="rotate(45 20 20)" fill="#345"/></g>',
        C10,
      ),
      [['clip', [0, 0, 10, 10]]],
    ],
    [
      'a clip on <use x="5" transform="translate(10 0)">',
      svg100(
        '<use href="#r" x="5" transform="translate(10 0)" clip-path="url(#c)"/>',
        C10 + '<rect id="r" width="40" height="40" fill="#345"/>',
      ),
      [['clip', [15, 0, 25, 10]]],
    ],
    [
      'a mask on a scaled group',
      svg100(`<g transform="scale(2)" mask="url(#m)">${R40}</g>`, M10),
      [['mask', [0, 0, 20, 20]]],
    ],
    [
      'a mask on a translated rect',
      svg100(
        '<rect width="40" height="40" transform="translate(30 30)" mask="url(#m)" fill="#345"/>',
        M10,
      ),
      [['mask', [30, 30, 40, 40]]],
    ],
    [
      'an intersection of clips under two transforms',
      svg100(
        '<g transform="translate(10 0)" clip-path="url(#a)"><g transform="scale(2)" clip-path="url(#b)"><rect width="100" height="100" fill="#345"/></g></g>',
        '<clipPath id="a"><rect width="50" height="50"/></clipPath><clipPath id="b"><rect width="20" height="20"/></clipPath>',
      ),
      [
        ['clip', [10, 0, 50, 40]],
        ['nested', [10, 0, 60, 50]],
      ],
    ],
  ];
  for (const [label, svg, wants] of PLACED) {
    const b = await importSvg(svg, { preserveViewport: true }),
      m = rowsOf(b),
      r = drawnRows(m)[0];
    const got = wants.map(([kind]) => {
      if (kind === 'nested') {
        const c = clipRows(m, r)[0];
        const q = c == null ? undefined : clipRows(m, c)[0];
        return q == null ? null : bboxOf(m, q);
      }
      const rows = kind === 'mask' ? maskRows(m, r) : clipRows(m, r);
      return rows.length ? bboxOf(m, rows[0]) : null;
    });
    check(
      wants.every(([, want], i) => got[i] && same(got[i], want)),
      `${label}: ${wants.map(([kind, want], i) => `${kind} row [${got[i] ? got[i].join(',') : 'none'}], want [${want.join(',')}]`).join('; ')}`,
    );
  }
  {
    // One clip under two transforms is two entries, and clipperRows still knows it by its id.
    const b = await importSvg(
      svg100(
        '<rect width="40" height="40" clip-path="url(#c)" fill="#345"/><rect width="40" height="40" transform="translate(50 50)" clip-path="url(#c)" fill="#543"/>',
        C10,
      ),
      { preserveViewport: true },
    );
    const m = rowsOf(b),
      boxes = drawnRows(m).map((r) =>
        clipRows(m, r).length ? bboxOf(m, clipRows(m, r)[0]).join(',') : 'none',
      );
    check(
      boxes.join(' | ') === '0,0,10,10 | 50,50,60,60' && Array.isArray(b.clipperRows.c),
      `one clip referenced at the identity and under translate(50 50): rows [${boxes.join('] [')}], clipperRows.c ${JSON.stringify(b.clipperRows.c)}`,
    );
  }

  // Every tracked asset with a <clipPath>, <mask> or <pattern>, at 2^-20 and 2^20, with and without the offset, against
  // 2. Each row's bbox is expected by the space it lives in: a drawn row, and the clip and mask rows it reads, in
  // document space (x R); a pattern's children, and the clip and mask rows they read, in the pattern's space (equal),
  // placed at draw time by the carrier's inverse pattern matrix (texel 5, x 1/R) about a tile origin and size in
  // pattern space (texel 9, equal).
  const spaces = (m) => {
    const n = m.length / 48,
      space = new Array(n).fill(null),
      kind = new Array(n).fill('drawn');
    const work = drawnRows(m);
    for (const r of work) space[r] = 'doc';
    while (work.length) {
      const r = work.pop();
      const give = (q, sp, k) => {
        if (q >= 0 && q < n && space[q] === null) {
          space[q] = sp;
          kind[q] = k;
          work.push(q);
        }
      };
      for (const q of clipRows(m, r)) give(q, space[r], 'clip');
      for (const q of maskRows(m, r)) give(q, space[r], 'mask');
      if (m[r * 48 + 43] === 2 && m[r * 48 + 40] > 0)
        for (let q = m[r * 48 + 40] - 1; q <= m[r * 48 + 41] - 1; q++) give(q, 'tile', 'pattern');
    }
    return { space, kind };
  };
  const ROOT = new URL('../examples/', import.meta.url);
  const assets = [
    ...readdirSync(ROOT).filter((f) => f.endsWith('.svg')),
    ...readdirSync(new URL('smoke/', ROOT))
      .filter((f) => f.endsWith('.svg'))
      .map((f) => 'smoke/' + f),
  ]
    .filter(
      (f) =>
        f !== 'tiger.svg' &&
        /<clipPath|<mask|<pattern/.test(readFileSync(new URL(f, ROOT), 'utf8')),
    )
    .sort();
  const tally = { drawn: 0, clip: 0, mask: 0, pattern: 0, carrier: 0 },
    bad = [];
  for (const f of assets) {
    const raw = readFileSync(new URL(f, ROOT), 'utf8');
    for (const off of [false, true]) {
      const base = await importSvg(wrap(raw, 2, off), { preserveViewport: true }),
        mb = rowsOf(base),
        { space, kind } = spaces(mb);
      for (const e of [-20, 20]) {
        const S = 2 ** e,
          R = S / 2,
          ms = rowsOf(await importSvg(wrap(raw, S, off), { preserveViewport: true }));
        if (ms.length !== mb.length) {
          bad.push(`${f} 2^${e}: ${mb.length / 48} rows -> ${ms.length / 48}`);
          continue;
        }
        for (let r = 0; r < mb.length / 48; r++) {
          if (!space[r]) continue;
          const k = r * 48,
            f1 = space[r] === 'doc' ? R : 1;
          const ok = [0, 1, 2, 3].every((i) => ms[k + i] === mb[k + i] * f1);
          const carrier = mb[k + 43] === 2 && mb[k + 40] > 0;
          const okCarrier =
            !carrier ||
            ([20, 21, 22, 23].every(
              (i) => Math.abs(ms[k + i] - mb[k + i] / R) <= 2.5e-7 * Math.abs(ms[k + i]),
            ) &&
              [36, 37, 38, 39].every(
                (i) => Math.abs(ms[k + i] - mb[k + i]) <= 2.5e-7 * Math.abs(mb[k + i]),
              ));
          if (e === -20 && !off) {
            tally[kind[r]]++;
            if (carrier) tally.carrier++;
          }
          if (!ok || !okCarrier)
            bad.push(
              `${f} 2^${e}${off ? '+offset' : ''} row ${r} (${kind[r]}, ${space[r]}): [${Array.from(mb.slice(k, k + 4)).join(',')}] -> [${Array.from(ms.slice(k, k + 4)).join(',')}]`,
            );
        }
      }
    }
  }
  check(
    bad.length === 0,
    `${assets.length} assets: ${tally.drawn} drawn, ${tally.clip} clip and ${tally.mask} mask rows scale by R; ${tally.pattern} pattern-space rows are equal and ${tally.carrier} carriers' inverse pattern matrices scale by 1/R; at 2^-20 and 2^20, with and without the offset${bad.length ? ` -- ${bad.length} rows off: ` + bad.slice(0, 3).join('; ') : ''}`,
  );

  // What the shader draws, through the CPU port: each drawn fill row's coverage times its clip's and mask's coverage
  // (the union over their rows), all sampled at the same document point, on a 64 x 64 grid. The clipped and masked
  // half-diamonds cover the same pixels at every size, and the translated-rect clip covers the pixels of the same
  // drawing written without a transform.
  const covered = (b, vb, S) => {
    const m = rowsOf(b),
      bands = new Float32Array(b.bands),
      curves = new Float32Array(b.curves),
      N = 64,
      ppe = N / (vb[2] * S);
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
    const set = new Set();
    for (const r of drawnRows(m)) {
      if (!(m[r * 48 + 7] > 0)) continue;
      const layers = [clipRows(m, r), maskRows(m, r)].filter((rows) => rows.length);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const x = (vb[0] + ((i + 0.5) * vb[2]) / N) * S,
            y = (vb[1] + ((j + 0.5) * vb[3]) / N) * S;
          let c = cov(r, x, y);
          for (const rows of layers) c *= Math.max(...rows.map((q) => cov(q, x, y)));
          if (c >= 0.5) set.add(j * N + i);
        }
    }
    return set;
  };
  const sameSet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
  for (const f of ['lbClipParity__SVG.svg', 'lbMaskParity__SVG.svg']) {
    const raw = readFileSync(new URL('smoke/' + f, ROOT), 'utf8');
    const ref = covered(await importSvg(raw, { preserveViewport: true }), [0, 0, 100, 100], 1);
    const got = [];
    for (const e of [-20, 20])
      got.push(
        covered(
          await importSvg(wrap(raw, 2 ** e, false), { preserveViewport: true }),
          [0, 0, 100, 100],
          2 ** e,
        ),
      );
    check(
      ref.size > 0 && got.every((g) => sameSet(g, ref)),
      `${f} through the port covers the same pixels at 2^-20 and 2^20 as at 1: ${ref.size} at 1, ${got.map((g) => `${g.size}${sameSet(g, ref) ? '' : ' (not the same)'}`).join(' and ')}`,
    );
  }
  {
    const moved = covered(
      await importSvg(
        svg100(
          '<rect width="40" height="40" transform="translate(30 30)" clip-path="url(#c)" fill="#345"/>',
          C10,
        ),
        { preserveViewport: true },
      ),
      [0, 0, 100, 100],
      1,
    );
    const plain = covered(
      await importSvg(
        svg100(
          '<rect x="30" y="30" width="40" height="40" clip-path="url(#d)" fill="#345"/>',
          '<clipPath id="d"><rect x="30" y="30" width="10" height="10"/></clipPath>',
        ),
        { preserveViewport: true },
      ),
      [0, 0, 100, 100],
      1,
    );
    check(
      plain.size > 0 && sameSet(moved, plain),
      `a clip on <rect transform="translate(30 30)"> through the port covers the pixels of the drawing written in place: ${moved.size}${sameSet(moved, plain) ? '' : ' (not the same)'} and ${plain.size}`,
    );
  }
}

console.log("a pattern child's occupancy grid follows its drawn area");
{
  // The occupancy gate builds a grid for a shape covering 2% of the drawing. A pattern's children are stored in the
  // pattern's space, so their area is carried into document units through the pattern matrix, and the drawing is the
  // union of the drawn shapes. It compared their stored area against a union that took them in too: under
  // patternTransform scale(0.5) a 30 x 30 child drawn 15 x 15 (0.56% of 200 x 200) got a grid, and under a scaled
  // ancestor the tile outweighed the drawing (patternGrid above, _pattern.svg: every child got one at 2^-20).
  const grids = async (patTf, S) => {
    const doc = svgDoc(
      '0 0 200 200',
      '<rect x="0" y="0" width="200" height="200" fill="url(#p)"/>',
      `<pattern id="p" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="${patTf}"><path d="M0 0 H30 V30 H0 Z" fill="#c33"/></pattern>`,
    );
    const b = await importSvg(wrap(doc, S, false), {
      preserveViewport: true,
      occupancyGrid: { grid: 8 },
    });
    const m = new Float32Array(b.meta, 32),
      rows = [];
    for (let r = 0; r < m.length / 48; r++)
      if (m[r * 48 + 27] & 0x100 && m[r * 48 + 21] > 0) rows.push(r);
    return rows.length;
  };
  for (const [tf, want, drawn] of [
    ['scale(2)', 1, '60 x 60, 9%'],
    ['scale(0.5)', 0, '15 x 15, 0.56%'],
  ]) {
    const got = await Promise.all([1, 2 ** -20, 2 ** 20].map((S) => grids(tf, S)));
    check(
      got.every((g) => g === want),
      `a 30 x 30 child under patternTransform ${tf} (drawn ${drawn}) has ${want ? 'a grid' : 'no grid'} at 1, 2^-20 and 2^20: ${got.join(' ')}`,
    );
  }
}

console.log('silhouette stroke ends at every size');
{
  // The union ends one piece at a crossing solved on one curve and starts the next at the same crossing
  // solved on the other, up to 1.35e-7 of the coordinates apart here. Every one of those is a join, at every
  // size: an absolute 1e-5 pairing would put a cap at every spike tip from scale 2, and a relative 1e-7 of
  // the coordinates is under what the union resolves.
  const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
  const raw = readFileSync(
    new URL('../examples/smoke/aacBandLevels__SVG.svg', import.meta.url),
    'utf8',
  );
  const ends = [];
  for (const e of [1, -20, 20]) {
    const b = await importSvg(wrap(raw, 2 ** e, false), {
      preserveViewport: true,
      computeSilhouette: true,
    });
    const r = b.curveRangesByShape[0],
      joinStyle = new Float32Array(b.meta, 32)[25] | 0;
    const segs = decodeSegs(new Float32Array(b.curves), r.begin, r.end, joinStyle);
    ends.push({
      n: segs.length,
      free: segs.reduce((k, s) => k + s.freeS + s.freeE, 0),
      flags: segs.map((s) => `${+s.freeS}${+s.freeE}`).join(''),
    });
  }
  check(
    ends.every((x) => x.n > 0 && x.free === 0 && x.flags === ends[0].flags),
    `every end of the silhouette of a spiked star is a join at 2, 2^-20 and 2^20: ${ends.map((x) => `${x.n} segments, ${x.free} free ends`).join(' | ')}`,
  );
}

console.log('segsToPathD and cubicCuspT at every size');
{
  const shape = [
    mkLine([10, 10], [30, 10]),
    mkCubic([30, 10], [40, 10], [40, 30], [30, 30]),
    mkLine([30, 30], [10, 10]),
  ];
  let worst = 0,
    structure = true;
  for (const e of [1, -20, 20]) {
    const S = 2 ** e,
      d = segsToPathD(
        shape.map((s) =>
          s.type === 0
            ? mkLine(
                s.p1.map((v) => v * S),
                s.p2.map((v) => v * S),
              )
            : mkCubic(...[s.p1, s.p2, s.p3, s.p4].map((p) => p.map((v) => v * S))),
        ),
      );
    const back = parsePathD(d);
    if (back.length !== 3) structure = false; // three segments; Z lands on the start
    back.slice(0, 3).forEach((s, i) => {
      for (const k of ['p1', 'p2', 'p3', 'p4'])
        if (s[k] && shape[i][k])
          worst = Math.max(
            worst,
            Math.abs(s[k][0] / S - shape[i][k][0]),
            Math.abs(s[k][1] / S - shape[i][k][1]),
          );
    });
  }
  check(
    structure && worst <= 1e-4 * 30,
    `a path round-trips through its d string at 2, 2^-20 and 2^20, to 1e-4 of its size (worst ${(worst / 30).toExponential(1)} of it)`,
  );
  // a cusp at t = 0.5, and a cubic that runs back along its own line (its derivative is linear, a cusp at 0.25)
  for (const [name, P, want] of [
    [
      'a cusp',
      [
        [0, 0],
        [40, 30],
        [0, 30],
        [40, 0],
      ],
      0.5,
    ],
    [
      'a reversal',
      [
        [0.1, 0.3],
        [-0.9, -1.7],
        [0.1, 0.3],
        [3.1, 6.3],
      ],
      0.25,
    ],
  ]) {
    const ts = [1, 2 ** -44, 2 ** -20, 2 ** 20].map((S) =>
      cubicCuspT({
        p1: P[0].map((v) => v * S),
        p2: P[1].map((v) => v * S),
        p3: P[2].map((v) => v * S),
        p4: P[3].map((v) => v * S),
      }),
    );
    check(
      ts.every((t) => Math.abs(t - want) < 1e-6),
      `cubicCuspT finds ${name} at 1, 2^-44, 2^-20 and 2^20: ${ts.map((t) => t.toFixed(6)).join(' ')}`,
    );
  }
}

console.log('tight bboxes and subpath closes, directly');
{
  const { curveTightBboxQuad, arcTightBbox, splitSubpathsWithCloseInto } =
    await import('../src/svg/bbox.js');
  const { mkArc } = await import('../src/svg/segment.js');
  const scaled = (b, S) => b.map((v) => v / S);
  const q = (S) => scaled(curveTightBboxQuad([0, 0], [S, 2 * S], [2 * S, 0]), S);
  const a = (S) => scaled(arcTightBbox(mkArc(0, 0, S, S, 0.25, 2.5, 0, 0, 1)), S);
  const qs = [1, 2 ** -42].map(q),
    as = [1, 2 ** -42].map(a);
  check(
    JSON.stringify(qs[0]) === JSON.stringify(qs[1]),
    `a quad's tight bbox at 2^-42 is the one at 1: ${qs.map((b) => b.join(',')).join(' | ')}`,
  );
  check(
    as.every((b) => Math.abs(b[3] - 1) < 1e-12),
    `an arc's tight bbox at 2^-42 reaches its top: ${as.map((b) => b.join(',')).join(' | ')}`,
  );
  // two unmarked squares a unit apart (a list built without authored subpath starts)
  const squares = (S) =>
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
      [2, 0],
    ].reduce(
      (out, p, i, all) =>
        i > 0 && i !== 5
          ? out.concat([
              mkLine(
                all[i - 1].map((v) => v * S),
                p.map((v) => v * S),
              ),
            ])
          : out,
      [],
    );
  const closes = [1, 2 ** -20, 2 ** 20].map((S) => {
    const out = [];
    splitSubpathsWithCloseInto(squares(S), out);
    return out.filter((g) => g.is_fill_only).length;
  });
  check(
    closes.every((n) => n === 2),
    `two unmarked squares get two closing lines at 1, 2^-20 and 2^20: ${closes.join(' ')}`,
  );
}

console.log('roundCorners (svg/modifiers.js, the Lottie roundness modifier) at every size');
{
  const { roundCorners } = await import('../src/svg/modifiers.js');
  // a hexagon whose last vertex is rebuilt through cos/sin: at 1e8 it misses the first by 2.4e-8, past an
  // absolute 1e-9 closure test, which would leave the last corner sharp
  const hex = (S) => {
    const v = [0, 1, 2, 3, 4, 5, 6].map((i) => [
      100 * S * Math.cos((i * Math.PI) / 3),
      100 * S * Math.sin((i * Math.PI) / 3),
    ]);
    return v.slice(0, 6).map((p, i) => mkLine(p, v[i + 1]));
  };
  const shape = (S) =>
    roundCorners(hex(S), 10 * S)
      .map((g) => g.type)
      .join('');
  const got = [2, 2 ** -20, 2 ** 20].map(shape);
  check(
    got.every((g) => g === got[0]),
    `every corner of a closed hexagon rounds at 2, 2^-20 and 2^20: ${got.join(' | ')}`,
  );
}

console.log('buildGradientTables at every size');
{
  const inv = (S) => {
    const root = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="10" y2="0" gradientTransform="scale(${S})"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></svg>`,
      'image/svg+xml',
    ).documentElement;
    const rec = new Float32Array(buildGradientTables([parseGradients(root).g]).records.buffer);
    return [rec[4], rec[7]];
  };
  const got = [2, 2 ** -20, 2 ** 20].map((S) => [S, inv(S)]);
  check(
    got.every(([S, [a, d]]) => a === Math.fround(1 / S) && d === Math.fround(1 / S)),
    `gradientTransform scale(S) inverts to 1/S at 2, 2^-20 and 2^20: ${got.map(([, v]) => v.join('/')).join(' ')}`,
  );
}

console.log('pickBandsXY at every size');
{
  // a shape 0.9 wide: at 2^-20 under a 1e-6 floor, with a segment whose x span is 0.005 of the width
  const segs = [
    mkLine([10, 10], [10.9, 10]),
    mkLine([10.9, 10], [10.9, 40]),
    mkLine([10.9, 40], [10.905, 41]),
    mkLine([10.905, 41], [10, 41]),
    mkLine([10, 41], [10, 10]),
  ];
  const at = (S) =>
    pickBandsXY(
      segs.map((g) =>
        mkLine(
          g.p1.map((v) => v * S),
          g.p2.map((v) => v * S),
        ),
      ),
      [10 * S, 10 * S, 10.905 * S, 41 * S],
    );
  const ref = JSON.stringify(at(2)),
    got = [2 ** -20, 2 ** 20].map((S) => JSON.stringify(at(S)));
  check(
    got.every((g) => g === ref),
    `band counts ${ref} at 2, ${got.join(' ')} at 2^-20 and 2^20`,
  );
}

console.warn = _warn;
if (fail) {
  console.error(`IMPORTER SCALE-INVARIANT FAIL (${fail})`);
  process.exit(1);
}
console.log('IMPORTER SCALE-INVARIANT PASS');
