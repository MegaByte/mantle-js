// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsPipeParitySmoke — the point route's vertex shader paints what the fill shader paints, pixel for pixel, for
// fills AND strokes.
//
// The point route (renderer/aacPointsDraw.js) draws a small bundle as 1-px points and computes each pixel's color in the
// VERTEX stage (aacPoints.vert.glsl): the exact fill walk, and the fill shader's stroke pass too. Both
// shaders are the generated texts, run on the CPU through test/_lbPipeEmu.mjs: the fill shader as the unified draw runs
// it (every row a cover quad, mantle.vert + rasterizer + mantle.frag with real quad derivatives), and the point shader
// as the route submits it (one point per (row, column, row, paint) of the row's grid). For every row and every pixel the
// fill shader shaded, the fragment's color -- the row's fill, then its stroke over it -- is compared with the point
// colors at that pixel composited the same way (stroke OVER fill).
//
// The two stages do not read the same em: the cover quad interpolates em across a triangle, the point inverts the
// em->pixel affine at the pixel center; nor the same pixel size: the fragment's is fwidth of that interpolated em, the
// point's the affine's own. So the bar is float noise, not bits: a fill within 2e-5 of the fragment on every channel,
// a stroke within 5e-4 (its walk turns those input differences into more: an arc stroke's edge moved 1.4e-4), and no
// channel of either past half an 8-bit level.
//
//   (a) strokes: a line, a quad, a cubic and an arc path; butt, round and square caps; miter, round and bevel joins;
//       a dashed stroke; a stroked circle (the annulus closed form); a stroke under a non-conformal CTM (the
//       stroke-space walk) -- at 2^-20, 1 and 2^20; and a non-scaling stroke at 1;
//   (b) fills: even-odd and nonzero quads and cubics, and an arc, at the same scales;
//   (c) a rotated draw: the fill takes the rotated footprint (MANTLE_ROTATED_MAP) in both stages;
//   and a mutation that must fail: the points' stroke on the ramp edge (uStrokeExactAa 0) against the exact-area one.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { hasLbPipeEmu, buildVert, runVert } = await import('./_lbPipeEmu.mjs');
if (!hasLbPipeEmu()) {
  console.log('SKIP aacPointsPipeParitySmoke: needs a C++17 compiler and clang');
  process.exit(0);
}
const { lbScene, renderScene } = await import('./_lbPipeScene.mjs');
const warn = console.warn;
console.warn = () => {};

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const GEN = path.join(ROOT, 'src/shaders/generated');
const VERT = readFileSync(path.join(GEN, 'mantle.vert.glsl'), 'utf8');
const FRAG = readFileSync(path.join(GEN, 'mantle.frag.glsl'), 'utf8');
// The point shader as the emulator reads a vertex stage: its attribute at location 0 (the renderer binds it there), as
// floats (the emulator has no unsigned vectors; the values are small integers), and no point size (a raster setting).
const PTS = readFileSync(path.join(GEN, 'aacPoints.vert.glsl'), 'utf8')
  .replace(/\bin\s+uvec4\s+aPt\s*;/, 'layout(location = 0) in vec4 aPt;')
  .replace(/aPt\.w\s*==\s*0u/g, 'aPt.w == 0.0')
  .replace(/^\s*gl_PointSize\s*=[^;]*;/m, '');

const STROKES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M4 6 L20 6 L12 16" fill="none" stroke="#204080" stroke-width="2.2" stroke-linejoin="miter" stroke-linecap="butt"/>
  <path d="M26 4 Q34 20 44 6" fill="none" stroke="#a02020" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M48 6 C52 18 58 2 62 14" fill="none" stroke="#207020" stroke-width="1.3" stroke-linecap="square" stroke-linejoin="bevel"/>
  <path d="M6 24 A8 6 20 0 1 22 30" fill="none" stroke="#806020" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M28 22 L60 22 L60 34" fill="none" stroke="#000" stroke-width="1.4" stroke-dasharray="3 2"/>
  <circle cx="40" cy="46" r="7" fill="#e0c040" stroke="#202020" stroke-width="2"/>
  <g transform="matrix(1.6 0 0.9 0.5 0 0)"><path d="M10 110 L24 116 L16 124" fill="none" stroke="#308080" stroke-width="1.5"/></g>
</svg>`;
// A NON-SCALING stroke keeps its width in screen pixels, so its row's padded bbox does not scale with the art: at 2^-20
// it is a million pixels across. It runs at scale 1 only (the route's extent gate declines it elsewhere).
const NONSCALING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M6 40 L22 52 L40 44" fill="none" stroke="#503090" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
</svg>`;
// TAGGED PRIMITIVES: a rect, a round rect, a circle and an ellipse, which the importer tags (primKind 1-3). The
// fill shader takes an axis-aligned rect as the pixel box's overlap and walks the rest (a one-pixel SDF ramp with an
// absolute 1e-6 gradient floor would be 0.045 off the exact walk at scale 1, 0.15 at 2^-20), so every one of them
// must agree with the points (the exact walk) like any other fill, at every scale.
const PRIMS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">
  <rect x="3.3" y="4.4" width="17.3" height="11.7" fill="#2f6fb0"/>
  <rect x="24.2" y="3.1" width="15.6" height="12.9" rx="4.1" ry="4.1" fill="#3aa36a"/>
  <circle cx="50" cy="10" r="7.3" fill="#d0573a"/>
  <ellipse cx="14" cy="24" rx="9.5" ry="4.2" fill="#7d4fb3"/>
  <rect x="30.37" y="20.05" width="8.9" height="0.31" fill="#000"/>
</svg>`;
// CLIPPED ROWS (the point program's clip walk): a clip-path of two children (a union) and one with a nested clip-path, over a fill and a
// stroke: an illustration with 63 rows under clip-paths costs 8x on cover quads what it costs on the points.
const CLIPPED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><defs>
  <clipPath id="a"><path d="M4 4 Q20 -2 36 8 Q22 22 4 14 Z"/><path d="M30 10 L46 6 L44 24 L30 22 Z"/></clipPath>
  <clipPath id="b"><circle cx="50" cy="16" r="9"/></clipPath></defs>
  <rect x="2" y="2" width="44" height="26" fill="#2b4c9a" clip-path="url(#a)"/>
  <path d="M6 24 L60 8" stroke="#a02020" stroke-width="3" fill="none" clip-path="url(#a)"/>
  <circle cx="48" cy="16" r="12" fill="#3aa36a" stroke="#202020" stroke-width="1.5" clip-path="url(#b)"/>
</svg>`;
// GRADIENT ROWS (the point program's gradient sampler): a linear gradient in bounding-box units, a radial one in user units, a reflecting
// one, a gradient STROKE, and a gradient fill under a clip -- the paint rows of a gradient-filled illustration (5.5x slower at 32 px on
// cover quads than on the points).
const GRADS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><defs>
  <linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4d03f"/><stop offset="0.6" stop-color="#d35400"/><stop offset="1" stop-color="#4a235a"/></linearGradient>
  <radialGradient id="r" gradientUnits="userSpaceOnUse" cx="44" cy="12" r="14"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#1b4f72"/></radialGradient>
  <linearGradient id="m" gradientUnits="userSpaceOnUse" x1="4" y1="0" x2="14" y2="0" spreadMethod="reflect"><stop offset="0" stop-color="#27ae60"/><stop offset="1" stop-color="#e74c3c"/></linearGradient>
  <linearGradient id="k" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#e91e63"/></linearGradient>
  <clipPath id="c"><circle cx="20" cy="22" r="8"/></clipPath></defs>
  <path d="M3 3 Q14 -2 24 5 L22 17 Q12 20 3 14 Z" fill="url(#l)"/>
  <path d="M30 4 L58 4 L58 20 L30 20 Z" fill="url(#r)" fill-opacity="0.8"/>
  <rect x="2" y="19" width="30" height="10" fill="url(#m)" clip-path="url(#c)"/>
  <path d="M36 28 L62 24" stroke="url(#k)" stroke-width="3" fill="none"/>
</svg>`;
// MASKED ROWS and PATTERN FILLS (the point program's mask walk and pattern block): a luminance mask of two children, one a gradient, over a
// fill and a stroke; vector patterns -- a tile of a rect, a circle and a stroked line -- plain, under a scaled patternTransform (the
// children's pixel is the pattern-space pixel), and under a rotated one.
const MASKS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><defs>
  <radialGradient id="g" gradientUnits="userSpaceOnUse" cx="24" cy="14" r="14"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#303030"/></radialGradient>
  <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="32"><rect x="0" y="0" width="40" height="32" fill="url(#g)"/><circle cx="48" cy="16" r="9" fill="#bbb"/></mask>
  <mask id="a" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="32" style="mask-type:alpha"><path d="M36 2 L62 2 L50 30 Z" fill="#000" fill-opacity="0.7"/></mask></defs>
  <rect x="2" y="2" width="58" height="28" fill="#d35400" mask="url(#m)"/>
  <path d="M4 28 L60 6" stroke="#1a5276" stroke-width="3" fill="none" mask="url(#m)"/>
  <rect x="34" y="1" width="28" height="30" fill="#117a65" mask="url(#a)"/>
</svg>`;
const patSvg = (xf) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><defs>
  <pattern id="p" patternUnits="userSpaceOnUse" width="8" height="6"${xf ? ` patternTransform="${xf}"` : ''}>
    <rect width="8" height="6" fill="#f5e6b8"/><circle cx="2.5" cy="2.5" r="1.6" fill="#a04000"/><path d="M0 5.5 L8 5.5" stroke="#2874a6" stroke-width="0.8"/></pattern></defs>
  <path d="M3 3 Q30 -4 60 5 L58 28 Q30 34 4 26 Z" fill="url(#p)"/></svg>`;
const FILLS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">
  <path fill-rule="evenodd" fill="#000" d="M2 16 Q10 2 18 16 Q10 30 2 16 Z M6 16 Q10 8 14 16 Q10 24 6 16 Z"/>
  <path fill="#2b4c9a" d="M22 4 C34 2 30 14 40 12 C44 22 30 30 24 26 Z"/>
  <path fill="#b03030" d="M44 16 A8 8 0 1 1 60 16 A8 8 0 1 1 44 16 Z"/>
</svg>`;

/// One scene through both stages: the per-row, per-pixel colors of the fill shader's cover fragments and of the points.
async function compare(
  svg,
  N,
  scale,
  world,
  label,
  pointsExactAa = 1,
  fragText = FRAG,
  pointsDefs = [],
  cm = null,
  ptsText = PTS,
) {
  const sc = await lbScene(svg, {
    N,
    rows: () => 'cover',
    importOpts: { preserveViewport: true },
    world,
  });
  if (cm) {
    sc.uniforms.set('uColorMatrix', cm.m);
    sc.uniforms.set('uColorMatrixOffset', cm.o);
    sc.uniforms.set('uColorMatrixEnabled', 1);
  }
  const S = sc.pm.floatsPerShape,
    M = sc.pm.metaFloats;
  const defs = [];
  if ((sc.sec.flags | 0) & 8) defs.push('MANTLE_AAC_PAIR_BANDS');
  const rotated = !!(world && (world[1] !== 0 || world[3] !== 0));
  if (rotated) defs.push('MANTLE_ROTATED_MAP');
  const cover = renderScene(sc, VERT, fragText, defs);
  // the fill shader's color per (row, pixel)
  const fs = new Map();
  for (let q = 0; q < cover.recs.length / 9; q++) {
    const r = cover.recs,
      o = q * 9,
      e = sc.entries[sc.entryOfTri[r[o] | 0]];
    if (!e) continue;
    const key = e.shapeIdx + ':' + (r[o + 1] | 0) + ':' + (r[o + 2] | 0);
    fs.set(key, r[o + 7] === 1 ? [0, 0, 0, 0] : [r[o + 3], r[o + 4], r[o + 5], r[o + 6]]);
  }
  // the points, as aacPointsDraw.js lists them (pointsFor): each row's region -- its cover geometry, relative to the
  // bbox's low pixel corner, plus 2 px -- its fill before its stroke, offsets biased by 2^15
  const AR = sc.uniforms.get('uCanvasAR'),
    W = world || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const J = [
    (0.5 * N * W[0] * 2 * AR[0]) / sc.gbb[2],
    (0.5 * N * W[1] * 2 * AR[0]) / sc.gbb[2],
    (-0.5 * N * W[3] * 2 * AR[1]) / sc.gbb[3],
    (-0.5 * N * W[4] * 2 * AR[1]) / sc.gbb[3],
  ];
  const cq =
    sc.sec.curveGeom && sc.sec.curveGeom.byteLength ? new Float32Array(sc.sec.curveGeom) : null;
  const byShape = new Map(
    sc.drawList
      .filter((op) => op.kind === 'fillShape' && op.chunk)
      .map((op) => [op.shapeIdx, op.chunk]),
  );
  const list = [];
  const drawn = new Set(
    sc.drawList.filter((op) => op.kind === 'fillShape').map((op) => op.shapeIdx),
  ); // the route lists the DRAWN rows (a clip's children are not)
  let clipped = false,
    graded = false,
    masked = false,
    patterned = false;
  for (let s = 0; s < sc.pm.numShapes; s++) {
    if (!drawn.has(s)) continue;
    if (Math.round(M[s * S + 30]) !== 0) clipped = true;
    if (M[s * S + 28] > 0.5 || M[s * S + 29] > 0.5) graded = true;
    if (Math.round(M[s * S + 31]) > 0) masked = true;
    if (M[s * S + 7] > 0 && Math.round(M[s * S + 43]) === 2) patterned = true;
    const b = s * S,
      fill = M[b + 7] > 0,
      stroke = M[b + 11] > 0 && M[b + 12] > 0;
    if (!fill && !stroke) continue;
    let x0 = M[b],
      y0 = M[b + 1],
      x1 = M[b + 2],
      y1 = M[b + 3];
    const e = byShape.get(s);
    if (cq && e)
      for (let v = e.start | 0; v < (e.start | 0) + (e.count | 0); v++) {
        x0 = Math.min(x0, cq[v * 12]);
        x1 = Math.max(x1, cq[v * 12]);
        y0 = Math.min(y0, cq[v * 12 + 1]);
        y1 = Math.max(y1, cq[v * 12 + 1]);
      }
    const bw = M[b + 2] - M[b],
      bh = M[b + 3] - M[b + 1],
      c = [x0 - M[b], y0 - M[b + 1], x1 - M[b], y1 - M[b + 1]];
    let bx = Infinity,
      by = Infinity,
      cx0 = Infinity,
      cy0 = Infinity,
      cx1 = -Infinity,
      cy1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const u = k & 1 ? bw : 0,
        v = k & 2 ? bh : 0;
      bx = Math.min(bx, J[0] * u + J[2] * v);
      by = Math.min(by, J[1] * u + J[3] * v);
      const cu = c[k & 1 ? 2 : 0],
        cv = c[k & 2 ? 3 : 1],
        CX = J[0] * cu + J[2] * cv,
        CY = J[1] * cu + J[3] * cv;
      cx0 = Math.min(cx0, CX);
      cx1 = Math.max(cx1, CX);
      cy0 = Math.min(cy0, CY);
      cy1 = Math.max(cy1, CY);
    }
    for (const kind of [0, 1]) {
      if (kind === 0 ? !fill : !stroke) continue;
      const Mg = (kind === 0 ? 0.5 : 0.7072) + 1e-3; // the route's margin: half a pixel for a fill, CP_AA_REACH for a stroke
      const i0 = Math.floor(cx0 - bx - 0.5 - Mg),
        j0 = Math.floor(cy0 - by - 0.5 - Mg),
        i1 = Math.floor(cx1 - bx + 0.5 + Mg),
        j1 = Math.floor(cy1 - by + 0.5 + Mg);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 1 << 20)
        throw new Error(`${label}: row ${s}'s region is ${i1 - i0 + 1} x ${j1 - j0 + 1}`);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) list.push(s, i + 32768, j + 32768, kind);
    }
  }
  const nv = list.length / 4,
    A = new Float32Array(nv * 64);
  for (let v = 0; v < nv; v++) {
    for (let l = 0; l < 16; l++) A[v * 64 + l * 4 + 3] = 1;
    for (let c = 0; c < 4; c++) A[v * 64 + c] = list[v * 4 + c];
  }
  const U = new Map(sc.uniforms);
  U.set('uStrokeExactAa', pointsExactAa);
  const pv = buildVert(
    ptsText,
    defs
      .concat(pointsDefs)
      .concat(sc.sec && list.some((x, k) => k % 4 === 3 && x === 1) ? ['MANTLE_POINTS_STROKE'] : [])
      .concat(clipped ? ['MANTLE_POINTS_CLIP'] : [])
      .concat(graded || masked || patterned ? ['MANTLE_POINTS_GRADIENT'] : [])
      .concat(masked ? ['MANTLE_POINTS_MASK'] : [])
      .concat(patterned ? ['MANTLE_POINTS_PATTERN'] : []),
  );
  const out = runVert(pv, sc.textures, U, A, nv);
  const co = pv.outOff[pv.io.outs.findIndex((o) => o.name === 'vColor')];
  const pts = new Map(); // row:x:row -> [fill rgba, stroke rgba]
  for (let v = 0; v < nv; v++) {
    const o = v * pv.outN,
      x = out[o],
      y = out[o + 1];
    const px = Math.floor((x * 0.5 + 0.5) * N),
      wy = Math.floor((y * 0.5 + 0.5) * N);
    const key = list[v * 4] + ':' + px + ':' + (N - 1 - wy);
    const e = pts.get(key) || [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    e[list[v * 4 + 3]] = [out[o + co], out[o + co + 1], out[o + co + 2], out[o + co + 3]];
    pts.set(key, e);
  }
  // compare: the point colors composited stroke OVER fill, against the fragment; discards read as zero on both sides.
  let worst = 0,
    n = 0,
    missing = 0,
    big = 0,
    where = '',
    missAt = '';
  for (const [key, c] of fs) {
    const p = pts.get(key);
    if (!p) {
      if (c[3] >= 1 / 255) {
        missing++;
        if (!missAt) missAt = `${key} (fragment alpha ${c[3].toFixed(4)})`;
      }
      continue;
    }
    const [f, s] = p,
      ka = 1 - s[3];
    let col = [s[0] + f[0] * ka, s[1] + f[1] * ka, s[2] + f[2] * ka, s[3] + f[3] * ka];
    if (col[3] < 1 / 255) col = [0, 0, 0, 0];
    n++;
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(col[k] - c[k]);
      if (d > worst) {
        worst = d;
        where = `${key} ch${k}: points ${col[k].toFixed(6)} fragment ${c[k].toFixed(6)}`;
      }
      if (d > 0.5 / 255) big++;
    }
  }
  return { n, worst, missing, big, where, nv, missAt };
}

for (const [name, svg] of [
  ['(a) strokes', STROKES],
  ['(b) fills', FILLS],
  ['(b) tagged primitives', PRIMS],
  ['(b) clipped rows', CLIPPED],
  ['(b) gradient rows', GRADS],
  ['(b) masked rows', MASKS],
  ['(b) pattern fill', patSvg('')],
  ['(b) pattern fill, scaled transform', patSvg('scale(2.5 1.5)')],
  ['(b) pattern fill, rotated transform', patSvg('rotate(25)')],
]) {
  for (const k of [-20, 0, 20]) {
    const S = 2 ** k;
    // A userSpaceOnUse gradient lives in the user space of the element that references it, which the group's scale() enters
    // (the importer folds the ancestors' CTM into the gradient, so this loop need not scale the coordinates by hand). So the
    // coordinates stay as authored and the image is the same at every k.
    const gscaled = svg;
    const scaled = gscaled
      .replace(
        /viewBox="([^"]+)"/,
        (_, v) =>
          `viewBox="${v
            .split(' ')
            .map((x) => +x * S)
            .join(' ')}"`,
      )
      .replace(/<svg([^>]*)>/, `<svg$1><g transform="scale(${S})">`)
      .replace(/<\/svg>/, '</g></svg>');
    const r = await compare(scaled, 96, S, null, `${name} 2^${k}`);
    const bar =
      name.startsWith('(a)') ||
      name.includes('clipped') ||
      name.includes('gradient') ||
      name.includes('mask') ||
      name.includes('pattern')
        ? 5e-4
        : 2e-5;
    ok(
      r.n > 200 && r.missing === 0 && r.worst <= bar && r.big === 0,
      `${name} at 2^${k} (bar ${bar}): ${r.n} row-pixels (${r.nv} points), worst channel ${r.worst.toExponential(2)}, ${r.big} past half a level, ${r.missing} shaded pixels with no point${r.missing ? ' (' + r.missAt + ')' : ''}${r.worst > 2e-5 ? ' -- ' + r.where : ''}`,
    );
  }
}
{
  const r = await compare(NONSCALING, 96, 1, null, '(a) non-scaling');
  ok(
    r.n > 50 && r.missing === 0 && r.worst <= 5e-4 && r.big === 0,
    `(a) a non-scaling stroke at 1: ${r.n} row-pixels, worst channel ${r.worst.toExponential(2)}, ${r.big} past half a level, ${r.missing} with no point${r.worst > 2e-5 ? ' -- ' + r.where : ''}`,
  );
}
{
  const a = Math.PI / 7,
    c = Math.cos(a) * 0.8,
    s = Math.sin(a) * 0.8;
  const r = await compare(FILLS, 96, 1, [c, s, 0, -s, c, 0, 0, 0, 1], '(c) rotated');
  ok(
    r.n > 200 && r.missing === 0 && r.worst <= 2e-5 && r.big === 0,
    `(c) a rotated draw: ${r.n} row-pixels, worst channel ${r.worst.toExponential(2)}, ${r.big} past half a level, ${r.missing} with no point${r.worst > 2e-5 ? ' -- ' + r.where : ''}`,
  );
}

// TAGGED PRIMITIVES UNDER A ROTATED MAP, AN AXIS SWAP AND A MIRROR: the rect's overlap is exact only where the map is
// axis-aligned; the guard sends every other map to the walk. Mutation: drop the guard, and the rotated rect must disagree.
{
  const a = Math.PI / 7,
    c = Math.cos(a) * 0.8,
    s = Math.sin(a) * 0.8;
  const maps = [
    ['rotated', [c, s, 0, -s, c, 0, 0, 0, 1]],
    ['quarter turn', [0, 0.9, 0, -0.9, 0, 0, 0, 0, 1]],
    ['mirror', [-0.9, 0, 0, 0, 0.9, 0, 0, 0, 1]],
  ];
  for (const [nm, W] of maps) {
    const r = await compare(PRIMS, 96, 1, W, '(c) prims ' + nm);
    ok(
      r.n > 200 && r.missing === 0 && r.worst <= 2e-5 && r.big === 0,
      `(c) tagged primitives under a ${nm} map: ${r.n} row-pixels, worst channel ${r.worst.toExponential(2)}, ${r.big} past half a level, ${r.missing} with no point${r.worst > 2e-5 ? ' -- ' + r.where : ''}`,
    );
  }
  const NOGUARD = FRAG.replace(
    'bool primFast = doFill && ((primKind == 2 && axisMap) || primDeep);',
    'bool primFast = doFill && (primKind == 2 || primDeep);',
  );
  ok(NOGUARD !== FRAG, 'mutation text: the axis-map guard is in the shipped fill shader');
  const r = await compare(PRIMS, 96, 1, maps[0][1], 'mutation', 1, NOGUARD);
  ok(
    r.big > 0,
    `mutation: the rect overlap without the axis-map guard differs from the walk at ${r.big} channels past half a level (worst ${r.worst.toFixed(4)})`,
  );
}

// TYPE OMISSION (the point program compiles out the segment types its bundle lacks): a lines-and-quads bundle through a program
// with the cubic and arc kernels compiled out reads what the fill shader (all four kernels) reads.
{
  const QUADS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><path fill="#000" d="M3 4 Q12 -2 21 4 L21 14 Q12 20 3 14 Z"/><path fill="#2b4c9a" d="M26 5 L40 5 L40 17 L26 17 Z"/><path fill="#b03030" d="M45 4 Q58 2 60 14 Q50 22 44 12 Z"/></svg>`;
  for (const k of [-20, 0, 20]) {
    const S = 2 ** k;
    const scaled = QUADS.replace(
      /viewBox="([^"]+)"/,
      (_, v) =>
        `viewBox="${v
          .split(' ')
          .map((x) => +x * S)
          .join(' ')}"`,
    )
      .replace(/<svg([^>]*)>/, `<svg$1><g transform="scale(${S})">`)
      .replace(/<\/svg>/, '</g></svg>');
    const r = await compare(scaled, 96, S, null, 'omit', 1, FRAG, [
      'MANTLE_NO_CUBIC',
      'MANTLE_NO_ARC',
    ]);
    ok(
      r.n > 100 && r.missing === 0 && r.worst <= 2e-5 && r.big === 0,
      `type omission (no cubic, no arc) at 2^${k}: ${r.n} row-pixels, worst channel ${r.worst.toExponential(2)}, ${r.missing} with no point`,
    );
  }
}

// THE DRAW'S COLORMATRIX: the points apply uColorMatrix * c + uColorMatrixOffset, clamped, to the STRAIGHT paint exactly where the fill shader
// does (after the draw's alpha, before coverage and premultiply), for fills and strokes, opaque and translucent. A diagonal fog matrix with an offset
// (a per-sprite fog: rgb*f + fogColor*(1-f), alpha kept), a general mat4 that mixes channels and alpha and saturates, and the same
// two on a translucent drawing. Mutation: the point shader with the matrix switched off must disagree with the fragments.
{
  const TRANS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">
    <path d="M3 3 L40 3 L40 26 L3 26 Z" fill="#2b4c9a" fill-opacity="0.55" stroke="#a02020" stroke-opacity="0.6" stroke-width="3"/>
    <circle cx="40" cy="16" r="13" fill="#e0c040" fill-opacity="0.5" stroke="#202020" stroke-opacity="0.45" stroke-width="2.2"/>
    <path d="M6 28 Q30 14 60 28" fill="none" stroke="#308080" stroke-opacity="0.7" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const f = 0.4,
    fc = [0.875, 0.737, 0.314];
  const fog = {
    m: [f, 0, 0, 0, 0, f, 0, 0, 0, 0, f, 0, 0, 0, 0, 1],
    o: [fc[0] * (1 - f), fc[1] * (1 - f), fc[2] * (1 - f), 0],
  };
  // column-major; colors mix and blue overshoots; alpha is scaled and takes no color and no offset (a matrix that CREATES alpha out of a
  // transparent paint -- fill="none" -- makes the fill shader paint the shape's interior: the route declines that matrix, see the gate smoke)
  const gen = {
    m: [0.9, 0.2, 0.05, 0, 0.1, 0.7, 0.3, 0, 0.3, 0.25, 1.4, 0, 0.2, 0.1, 0.0, 0.8],
    o: [0.05, -0.1, 0.0, 0],
  };
  const cases = [
    ['diagonal fog + offset', fog],
    ['general mat4', gen],
  ];
  const drawings = [
    ['strokes', STROKES],
    ['fills', FILLS],
    ['translucent fills and strokes', TRANS],
    ['gradient rows', GRADS],
    ['clipped rows', CLIPPED],
  ];
  for (const [cn, cm] of cases)
    for (const [dn, svg] of drawings) {
      const r = await compare(svg, 96, 1, null, `cm ${cn} ${dn}`, 1, FRAG, [], cm);
      const bar = dn === 'fills' ? 2e-5 : 5e-4;
      ok(
        r.n > 100 && r.missing === 0 && r.worst <= bar && r.big === 0,
        `colorMatrix (${cn}) on ${dn}: ${r.n} row-pixels, worst channel ${r.worst.toExponential(2)}, ${r.big} past half a level, ${r.missing} with no point${r.worst > bar ? ' -- ' + r.where : ''}`,
      );
    }
  const OFF = PTS.replace('uColorMatrixEnabled != 0', 'false');
  ok(
    OFF !== PTS || !/uColorMatrixEnabled/.test(PTS) === false,
    'mutation text: the point shader reads uColorMatrixEnabled',
  );
  const rm = await compare(TRANS, 96, 1, null, 'cm mutation', 1, FRAG, [], fog, OFF);
  ok(
    rm.big > 0,
    `mutation: points without the matrix differ from the fragments at ${rm.big} channels past half a level (worst ${rm.worst.toFixed(4)})`,
  );
  // ORDER: a matrix applied AFTER the premultiply (color x coverage) would differ on translucent paint; the shipped order is the fill shader's
  const AFTER = PTS.replace(
    'if (uColorMatrixEnabled != 0) fill = clamp(uColorMatrix * fill + uColorMatrixOffset, 0.0, 1.0);\n',
    '',
  ).replace(
    'vColor = vec4(fill.rgb * fill.a, fill.a) * cov;',
    'vColor = vec4(fill.rgb * fill.a, fill.a) * cov;\n    if (uColorMatrixEnabled != 0) vColor = clamp(uColorMatrix * vColor + uColorMatrixOffset, 0.0, 1.0);',
  );
  ok(AFTER !== PTS, 'mutation text: the matrix moved past the coverage multiply is expressible');
  const ra = await compare(TRANS, 96, 1, null, 'cm order mutation', 1, FRAG, [], fog, AFTER);
  ok(
    ra.big > 0,
    `mutation: the matrix applied after the coverage differs from the fragments at ${ra.big} channels past half a level (worst ${ra.worst.toFixed(4)})`,
  );
}

// NON-VACUITY: the points with the stroke's exact-area edge off (the ramp) against the fragments with it on.
{
  const r = await compare(STROKES, 96, 1, null, 'mutation', 0);
  ok(
    r.big > 0,
    `mutation: points on the ramp edge differ from the fragments at ${r.big} channels past half a level (worst ${r.worst.toFixed(4)})`,
  );
}

console.warn = warn;
if (fail) {
  console.error(`aacPointsPipeParitySmoke FAIL (${fail})`);
  process.exit(1);
}
console.log('aacPointsPipeParitySmoke PASS');
