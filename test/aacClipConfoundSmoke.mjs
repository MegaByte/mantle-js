// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacClipConfoundSmoke — the clip-confound question answered as far as it can be without a GPU, and the A/B
// the answer implies.
//
// Given "clipped art costs AAC 4.6-5.5x Slug", is that the CLIP or the OVERDRAW DEPTH clipped art
// also has? Three things settle it here, with no GL.
//
// (1) THE CLIP RUNS THE same KERNEL IN both ARMS. mantle.frag.glsl samples every clip child with
//     `renderFill` — Slug's walker — and never with `renderFillAAC`. MANTLE_AAC swaps the kernel for
//     the SHAPE'S own fill, and for its pattern and mask children too (childFill: an AAC
//     program's mask does not take Slug's sub-pixel error), but not for a clip child. A cost both
//     arms pay identically pushes an aac/slug RATIO toward 1, so the clip's own work cannot be what
//     lifts it.
//
// (2) A CLIP DOES NOT CHANGE THE OVERDRAW AT ALL. The clip is a per-fragment test: the clipped
//     shape keeps its own meta bbox and its own cover quad, and the clip's geometry gets meta rows
//     of its own that are never drawn (`bundle.clipperRows`). So stripping a clip moves the
//     cover-quad fragment count, the mean depth, the tile-serialization proxy and the band-walk
//     length by exactly ZERO — shown here on a disc stack, and by probes/_aacOverdrawDepth.mjs on
//     clipped corpus assets (0.0% on all four). "Clipped vs unclipped, same asset" therefore HOLDS
//     the overdraw regressor fixed, and is a clean isolation of the clip.
//
//     The trap that makes it look otherwise: count the clip's own carrier rows as cover quads and
//     the same two assets report -22.9% and -48.1% fragments. They are not drawn.
//
// (3) OVERDRAW DOES NOT EXPLAIN THE NUMBER ANYWAY. At 256 px tiger has 3.7x the cover fragments,
//     2.5x the depth and 1.9x the tile serialization of the worst clipped corpus asset, and a shorter
//     band walk (4.42 entries per fragment against 5.49) — and reads 1.83x aac/slug where that asset
//     reads 4.13x. Per AAC cover fragment the excess is 2.1 ns on tiger and 76 ns on that asset.
//
// SO THE A/B IS NOT "CLIPPED VS UNCLIPPED". Every clipPath cell in the corpus behind that ratio
// also carries mask, gradient, paint-server fill and group opacity — `clipPath with no
// mask/opacity/filter` is ZERO cells, and `mask with no clipPath` is ZERO cells — so that corpus
// cannot identify the clip at all. (Nor does its worst cell reach 4.6x: 4.13x at 256, 2.07x at 512,
// 1.31x at 1024.) The arms have to turn ONE feature off at a time, which (2) says is safe because
// none of them moves the overdraw:
//
//   A0 as authored   A1 -clip   A2 -mask   A3 -group opacity   A4 gradients to solid   A5 all off
//
// each arm in its own PROCESS, an A/A pair first, REPEAT=16 FRAMES=8, at 256/512/1024, the engine
// pinned with setFillEngine and `debugStats.drawnFillVariantKey` read back, and
// probes/_aacOverdrawDepth.mjs reported per arm so the invariance is on the table with the times.
//
// EXPECTED: A1 barely moves the ratio — the clip is Slug in both arms and the overdraw is unchanged
// — while A2 and A3 move it a lot, because a mask and a group opacity are what force per-shape
// draws and RT round trips, and AAC's cost there is per DRAW, not per fragment. A1 collapsing the
// ratio to A5's would mean the clip is the cause and (1) is wrong about where its cost lands.
//
//   (a) the clip children are sampled with renderFill in the shipped fragment shader, and the pattern and mask
//       children with childFill, which is renderFillAAC in an AAC program;
//   (b) a clip leaves the drawn shapes' cover quads and depth untouched;
//   (c) the clip's carrier rows are the trap, and they are identifiable (bundle.clipperRows).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- (a) which kernel a clip child runs ----------------------------------------------------------
{
  // ...and the clip walk mantle.frag splices in (@@CLIP_WALK@@, _clipWalk.glsl: evalClipCoverageAtRow, evalClipCoverage;
  // shared with maskBake.frag)
  const FRAG =
    readFileSync(path.join(ROOT, 'src/shaders/mantle.frag.glsl'), 'utf8') +
    '\n' +
    readFileSync(path.join(ROOT, 'src/shaders/_clipWalk.glsl'), 'utf8');
  // Every coverage call the CLIP / MASK blocks make: the fill's own calls name the shape's bbox,
  // a clip or mask child's name its own band descriptor (cGD / mGD).
  // Five: each clip's single- and multi-row branches are one loop and the pattern child's five
  // tile/neighbor walks one ordered loop (one site each): evalClipCoverageAtRow,
  // evalClipCoverage (main's clip, and a mask child's), the single-fill mask, the inline mask walk and the
  // pattern child. The bound only
  // keeps the count below from passing vacuously.
  // the childFill definitions (a rotated-map program's and an axis-aligned one's) and childMap, which are not call sites
  const hStart = FRAG.indexOf('#define PATTERN_CHILD_PIXEL cMx, cMy'),
    hEnd = FRAG.indexOf('\n}\n#endif\n', FRAG.indexOf('#define PATTERN_CHILD_PIXEL cInvPx'));
  const helper = FRAG.slice(hStart, hEnd);
  // The sub-pixel pattern tile's walk (patternRowsAt, compiled out by MANTLE_NO_PATTERN_MEAN) is a second copy of the pattern child's loop, compiled in
  // only where a tile may be finer than a pixel: it has the same one child site, counted on its own below.
  const mStart = FRAG.indexOf(
      '#if !defined(MANTLE_NO_PATTERN_MEAN) && !defined(MANTLE_NO_PATTERN)',
    ),
    mEnd = FRAG.indexOf('\n  return acc;\n}', mStart);
  const meanWalk = mStart >= 0 && mEnd > mStart ? FRAG.slice(mStart, mEnd) : '';
  const outside = (FRAG.slice(0, hStart) + FRAG.slice(hEnd)).replace(meanWalk, ''); // the helper's own body is not a call site
  const meanCalls = meanWalk.match(/childFill\([^;]*?\bcGD\b[^;]*?\)/g) || [];
  ok(
    meanCalls.length === 1 && /^childFill\(\w+, PATTERN_CHILD_PIXEL,/.test(meanCalls[0]),
    `(a) ...the sub-pixel pattern tile's walk has ${meanCalls.length} child site, on the pattern-space pixel like the main one`,
  );
  const childCalls = outside.match(/(renderFill\w*|childFill)\([^;]*?\b(cGD|mGD)\b[^;]*?\)/g) || [];
  ok(
    childCalls.length >= 5,
    `(a) the fragment shader samples clip, pattern and mask children at ${childCalls.length} call sites`,
  );
  const clipCalls = childCalls.filter((c) => /^renderFill\w*\(/.test(c)),
    viaChild = childCalls.filter((c) => /^childFill\(/.test(c));
  const notSlug = clipCalls.filter((c) => /renderFillAAC|renderFillHardBand|renderFillGWN/.test(c));
  // A clip child scaled by an override takes the pixel of its own frame, the same call in every program, so the arms still pay the same.
  ok(
    clipCalls.length === 2 &&
      notSlug.length === 0 &&
      clipCalls.every((c) => /^renderFill\(localCoord, transformClipPx\(px, cRow\),/.test(c)),
    `(a) ...the ${clipCalls.length} clip-child calls call renderFill (Slug) on the child's own pixel; none calls the AAC, band-hard or GWN kernel (${notSlug.length}) — a clip costs the aac arm and the slug arm the SAME, so it cannot lift their ratio`,
  );
  const [rot, flat] = helper.split('#else\n#define PATTERN_CHILD_PIXEL cInvPx');
  // A pattern child's pixel is the pattern-space pixel, PATTERN_CHILD_PIXEL: the same kernel on the pixel as it measures in the tile's units. A mask
  // child's is the draw's own taken to the child's frame, one site per program form: through the map in a rotated-map program (childMap), as a
  // footprint in the others (transformClipPx).
  const site = (re) => viaChild.filter((c) => re.test(c)).length;
  const maskFrames = ['firstRow', 'cRow'].every((row) => {
    const local = row === 'firstRow' ? 'm' : 'c';
    return (
      new RegExp(
        `#ifdef MANTLE_ROTATED_MAP\\s*vec2 ${local}Mx = slMx, ${local}My = slMy;\\s*childMap\\(${row}, ${local}Mx, ${local}My\\);\\s*\\w+ = childFill\\(${local}Local, ${local}Mx, ${local}My,`,
      ).test(FRAG) &&
      site(new RegExp(`^childFill\\(${local}Local, ${local}Mx, ${local}My,`)) === 1 &&
      site(new RegExp(`^childFill\\(${local}Local, transformClipPx\\(invPx, ${row}\\),`)) === 1
    );
  });
  ok(
    hStart > 0 &&
      hEnd > hStart &&
      viaChild.length === 5 &&
      site(/^childFill\(\w+, PATTERN_CHILD_PIXEL,/) === 1 &&
      maskFrames &&
      /#define PATTERN_CHILD_PIXEL cMx, cMy/.test(rot) &&
      /#define PATTERN_CHILD_PIXEL cInvPx/.test(helper) &&
      /#ifdef MANTLE_AAC\s*return renderFillAACM\(c, mx, my,/.test(rot) &&
      /#else\s*return renderFillM\(c, mx, my,/.test(rot) &&
      /#ifdef MANTLE_AAC\s*return renderFillAAC\(c, invPx,/.test(flat) &&
      /#else\s*return renderFill\(c, invPx,/.test(flat),
    `(a) ...and the ${viaChild.length} pattern and mask child calls take the program's own AA kernel on its own pixel (childFill: AAC under MANTLE_AAC, else Slug; through the map in a rotated-map program)`,
  );
  ok(
    /MANTLE_AAC[\s\S]{0,400}renderFillAACM?\(emCoord/.test(FRAG), // renderFillAACM: the same kernel through the map
    "(a) ...while MANTLE_AAC swaps the kernel for the shape's own fill only",
  );
}

// ---- the overdraw regressor, from importSvg's own meta ----------------------------------------------
const N = 256;
const arScale = (bb, vw, vh) => {
  const cAR = vw / vh,
    sAR = bb[2] / bb[3];
  return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
};
async function cover(svg, countClipRows) {
  const b = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    st = pm.floatsPerShape;
  const clipRows = new Set();
  for (const k in b.clipperRows || {}) {
    const r = b.clipperRows[k];
    for (let i = r[0]; i <= r[1]; i++) clipRows.add(i);
  }
  const gbb = b.globalBBox;
  const [sx, sy] = arScale(gbb, N, N);
  const toX = (x) => (((x - gbb[0]) / gbb[2]) * 2 - 1) * sx * 0.5 * N + N * 0.5;
  const toY = (y) => (((y - gbb[1]) / gbb[3]) * 2 - 1) * sy * 0.5 * N + N * 0.5;
  const depth = new Int32Array(N * N);
  let frags = 0,
    rows = 0;
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * st;
    if (!countClipRows && clipRows.has(s)) continue;
    if (!(F[o + 7] > 0 || (F[o + 11] > 0 && F[o + 12] > 0))) continue;
    rows++;
    const x0 = Math.max(0, Math.floor(toX(F[o]))),
      x1 = Math.min(N - 1, Math.ceil(toX(F[o + 2])));
    const y0 = Math.max(0, Math.floor(toY(F[o + 1]))),
      y1 = Math.min(N - 1, Math.ceil(toY(F[o + 3])));
    if (x1 < x0 || y1 < y0) continue;
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        depth[j * N + i]++;
        frags++;
      }
  }
  let painted = 0,
    maxD = 0;
  for (let q = 0; q < N * N; q++) {
    const d = depth[q];
    if (d) {
      painted++;
      if (d > maxD) maxD = d;
    }
  }
  return {
    rows,
    frags,
    painted,
    maxD,
    depth: frags / Math.max(1, painted),
    clipRows: clipRows.size,
  };
}

// Twelve overlapping discs, so the stack has real depth, and a clip that keeps the middle third.
const discs = (() => {
  let d = '';
  for (let k = 0; k < 12; k++)
    d += `<circle cx="${40 + (k % 4) * 27}" cy="${40 + ((k / 4) | 0) * 27}" r="25"/>`;
  return d;
})();
const wrap = (clipDef, clipAttr) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
  `<defs>${clipDef}</defs><g fill="#3a6ea5"${clipAttr}>${discs}</g></svg>`;
const AUTHORED = wrap(
  '<clipPath id="c"><rect x="40" y="0" width="60" height="160"/></clipPath>',
  ' clip-path="url(#c)"',
);
const STRIPPED = wrap('', '');

const A = await cover(AUTHORED, false),
  S = await cover(STRIPPED, false);

// ---- (b) the clip leaves the overdraw exactly where it was --------------------------------------------
ok(
  A.rows === S.rows && A.frags === S.frags && A.painted === S.painted && A.maxD === S.maxD,
  `(b) the clip changes NOTHING a fragment route pays: ${A.rows} drawn rows, ${A.frags} cover fragments, ${A.painted} painted pixels, ` +
    `mean depth ${A.depth.toFixed(2)}, max ${A.maxD} — identical clipped and unclipped, so a clipped-vs-unclipped A/B holds the overdraw fixed`,
);

// ---- (c) the trap ---------------------------------------------------------------------------------------
{
  const Aw = await cover(AUTHORED, true);
  ok(
    A.clipRows > 0 && Aw.frags > A.frags,
    `(c) the clip's own ${A.clipRows} carrier row(s) are identifiable (bundle.clipperRows) and are NOT drawn; counting them adds ` +
      `${Aw.frags - A.frags} phantom cover fragments (+${(100 * (Aw.frags / A.frags - 1)).toFixed(1)}%) and is what makes the clip look like overdraw`,
  );
}

console.log(fail ? `aacClipConfoundSmoke FAIL (${fail})` : 'aacClipConfoundSmoke PASS');
process.exit(fail ? 1 : 0);
