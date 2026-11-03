// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStraightChainSmoke — a boundary interior face with no line row paints a flat 1.0, and on a
// many-sided straight outline that is most of the boundary.
//
// `lbCoverage`'s INTERIOR branch ends `else return 1.0`: a face that touches the outline but
// carries neither a line row nor a chain paints SOLID over a pixel the path only partly covers.
// On a 500-gon at 512 px that is 1008 of 2032 edge pixels at 44.83/255, all over-paint and 99.9%
// of the asset's antialiasing error, against EDGE_STRIP's 0.04/255 on the same drawing.
//
// THE ROW IS MISSING BECAUSE OF THE SPAN: the side test passes on all 3442 rowless
// boundary faces, and what fails is `lineFits`' requirement that all three vertices lie inside ONE
// edge's extent — at 500 sides an edge is 3.2 px and the faces span two to four of them (median
// 0.50 edge lengths of slack needed, worst 3.97). A half-plane cannot describe a boundary that
// turns four times across a face, so no relaxation of the span test helps; the analytic chain
// can, and `chainBoxCov` is exact for it.
//
// So lbPartition gives the chain route to pure-straight shapes too, not only to shapes with
// `hulls.length || cubicRecs.length` (a pure-straight shape has neither). On the GPU that leaves
// tiger and the OBB fixtures identical and takes lbPartialAdoption's antialiasing error to a
// handful of pixels.
//
// THERE IS NO COARSE-CORNER PENALTY: the chain kernel is exact at corners
// (test/lbChainPieceWalkSmoke.mjs), and on the whole synthetic set the chain is better or level in
// MEAN on every shape; a missed reflex joint takes its sector.
//
// This pins the mechanism: the rowless faces exist on the mesh a single straight contour ships
// (section 1), the partition gives every straight outline a chain (3, 4), and that chain is right
// on the fixtures it moved (5).
import { fileURLToPath } from 'url';
import path from 'path';
import { decodeVert, LBK } from '../probes/lbAccuracy/_lbKernel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const warn = console.warn;
console.warn = () => {};
const LB = await import('../src/renderer/loopBlinn.js');
const { shapesOf, viewOf, buildMesh } = await import('../probes/lbAccuracy/_lbRaster.mjs');
const { default: importSvg } = await import('../src/svg/importer.js');

const S = 100,
  CANVAS = 512;
const ngon = (n) => {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    d +=
      (i ? 'L ' : 'M ') +
      (S / 2 + S * 0.45 * Math.cos(a)).toFixed(6) +
      ' ' +
      (S / 2 + S * 0.45 * Math.sin(a)).toFixed(6) +
      ' ';
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
    `<path d="${d}Z" fill="#000"/></svg>`
  );
};
const RECT =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
  '<path d="M 12 20 L 88 20 L 88 74 L 12 74 Z" fill="#000"/></svg>';

/// The shape, its contours and the view the whole drawing is rendered at.
async function shapeOf(svg) {
  const bundle = await importSvg(svg);
  const { shapes, bbox } = await shapesOf(bundle);
  return { sh: shapes[0], view: viewOf(bbox, CANVAS) };
}
const cdt = (sh) => {
  try {
    const m = LB.buildLoopBlinnCDT(sh.contours, { fillRule: sh.evenOdd ? 'evenodd' : 'nonzero' });
    if (!m || m.fallback.length) return null;
    LB.dropDegenerateFaces(m);
    return LB.packLoopBlinnMesh(m);
  } catch {
    return null;
  }
};
/// Interior faces by row kind, and how many BARE-SOLID ones sit within 1 px of the outline.
function faceCensus(pk, sh, view) {
  const c = { solid: 0, line: 0, chain: 0, conic: 0, bareNearOutline: 0 };
  const pts = [];
  for (const q of sh.contours) for (const sg of q) if (sg.p1) pts.push(sg.p1);
  const segs = [];
  for (let i = 0; i < pts.length; i++) segs.push([pts[i], pts[(i + 1) % pts.length]]);
  const distPx = (p) => {
    let best = Infinity;
    for (const [A, B] of segs) {
      const dx = B[0] - A[0],
        dy = B[1] - A[1],
        L2 = dx * dx + dy * dy || 1e-30;
      const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2));
      best = Math.min(best, Math.hypot(p[0] - (A[0] + t * dx), p[1] - (A[1] + t * dy)));
    }
    return best / view.basePx;
  };
  for (let t = 0; t + 2 < pk.vertexCount; t += 3) {
    const a = decodeVert(pk.verts, t + 2);
    if (a.kind !== LBK.INTERIOR) continue;
    let kind;
    if (a.tc[0] > 2.5) kind = 'conic';
    else if (a.tc[0] > 1.5) kind = 'chain';
    else if (a.C3[0] * a.C3[0] + a.C3[1] * a.C3[1] > 1e-9) kind = 'line';
    else kind = 'solid';
    c[kind]++;
    if (kind !== 'solid') continue;
    const P = [0, 1, 2].map((q) => decodeVert(pk.verts, t + q).pos);
    let d = Infinity;
    for (const p of P) d = Math.min(d, distPx(p));
    for (let i = 0; i < 3; i++)
      d = Math.min(
        d,
        distPx([(P[i][0] + P[(i + 1) % 3][0]) / 2, (P[i][1] + P[(i + 1) % 3][1]) / 2]),
      );
    if (d <= 1.0) c.bareNearOutline++;
  }
  return c;
}

// ── 1. THE DEFECT, on the mesh that ships ────────────────────────────────────────────────────
{
  const { sh, view } = await shapeOf(ngon(200));
  const built = await buildMesh(sh); // a single straight contour ships the earcut mesh
  ok(!!built, '200-gon: the shipping build produces a mesh');
  if (built) {
    const c = faceCensus(built.pk, sh, view);
    ok(c.chain === 0, `200-gon: the shipping mesh carries NO chain rows (${c.chain})`);
    ok(
      c.bareNearOutline > 500,
      `200-gon: ${c.bareNearOutline} interior faces sit within 1 px of the outline with no row at all ` +
        `— every one paints a flat 1.0 (solid ${c.solid}, line ${c.line})`,
    );
  }
}

// ── 3. the partition gives a straight outline's every boundary face a chain ──────────────────
// (The line-row route this replaced left 1413 of the 200-gon's boundary faces rowless and packed
// 7644 vertices where the chain packs 2262.)
{
  const { sh, view } = await shapeOf(ngon(200));
  const pk = cdt(sh);
  ok(!!pk, '200-gon: the partition builds');
  if (pk) {
    const c = faceCensus(pk, sh, view);
    ok(c.chain > 0, `200-gon: the partition carries ${c.chain} chain faces`);
    ok(
      c.bareNearOutline === 0,
      `200-gon: NO rowless face is left within a pixel of the outline (${c.bareNearOutline})`,
    );
    ok(
      c.solid === 0 && c.line === 0,
      `200-gon: every interior face is a chain (solid ${c.solid}, line ${c.line})`,
    );
  }
}

// ── 4. ...a RECT too: the route is not shape-gated ─────────────────────────────────────────────
{
  const { sh, view } = await shapeOf(RECT);
  const pk = cdt(sh);
  if (pk) {
    const c = faceCensus(pk, sh, view);
    ok(c.chain > 0 && c.line === 0, `rect: chains (${c.chain}), no line rows`);
  } else ok(false, 'rect: the partition builds');
}

// -- 5. THE CHAIN IS RIGHT WHERE A STRAIGHT OUTLINE NEEDS IT, on the fixtures it moved ---------------
// Scored in the CPU draw model (probes/lbAccuracy/_lbRaster: the packed mesh through the kernel twin)
// against the path's exact coverage (_lbAaRef), at 512 px on the whole drawing's raster:
//   (a) glslEmuFidelity #5, a rect inside a same-WOUND rect under nonzero -- a solid rect: the inner
//       rect's edges are invisible (ink both sides) and must not bound a chain; if they did, fully
//       covered pixels would read ~0.9.
//   (b) lbDiagonalFrameParity #0, a chamfered frame: a face's chain 2 can reach the inner chamfer from
//       a face whose centroid stands on the wrong side of that edge's line and reverse it (the corner
//       pixel would read 0.21 where the path covers 0.94), so a line's ink side is read off the fill.
//   (c) engineSelectionTerms' star: no fully covered pixel below 0.99 (the missed-joint sector,
//       lbChainPieceWalkSmoke, closes a 2 px hole).
{
  const { loadSvg, rasterMesh } = await import('../probes/lbAccuracy/_lbRaster.mjs');
  const { refKit, exactCov } = await import('../probes/lbAccuracy/_lbAaRef.mjs');
  const kit = await refKit();
  const score = async (file, shape) => {
    const bundle = await loadSvg(file);
    const { shapes, bbox } = await shapesOf(bundle);
    const view = viewOf(bbox, CANVAS),
      sh = shapes.find((x) => x.s === shape);
    const built = await buildMesh(sh);
    if (!built) return null;
    const acc = new Float64Array(CANVAS * CANVAS).fill(1);
    rasterMesh(built.pk, view, acc, {}, null, null, null);
    const curves = kit.closed(kit.contoursToConverter(sh.contours, null));
    let holes = 0,
      worstEdge = 0,
      aaErr = 0;
    const rc = new Map();
    for (let j = 0; j < CANVAS; j++) {
      rc.clear();
      for (let i = 0; i < CANVAS; i++) {
        const ex = exactCov(kit.rowSpans, curves, i, j, view, 64, sh.evenOdd, rc),
          mo = 1 - acc[j * CANVAS + i];
        if (ex >= 1 - 1e-6 && mo < 0.99) holes++;
        else if (ex > 1e-6 && ex < 1 - 1e-6) {
          worstEdge = Math.max(worstEdge, Math.abs(mo - ex));
          aaErr += Math.abs(mo - ex);
        }
      }
    }
    return { holes, worstEdge, aaErr };
  };
  const a = await score('examples/smoke/glslEmuFidelity__SVG.svg', 5);
  ok(
    a && a.holes === 0,
    `(a) glslEmuFidelity #5: no fully covered pixel below 0.99 (${a ? a.holes : 'no mesh'})`,
  );
  const b = await score('examples/smoke/lbDiagonalFrameParity__SVG.svg', 0);
  ok(
    b && b.worstEdge < 0.1,
    `(b) lbDiagonalFrameParity #0: worst edge pixel off by ${b ? b.worstEdge.toFixed(3) : 'no mesh'}`,
  );
  const c = await score('examples/smoke/engineSelectionTerms__svgOf_STAR.svg', 0);
  ok(
    c && c.holes === 0,
    `(c) the star: no fully covered pixel below 0.99 (${c ? c.holes : 'no mesh'})`,
  );
  // (d) lbPartialAdoption's six ten-point stars (cubics that are lines). On the line-row route each
  // would read 63-65 px^2 of edge error with a worst pixel 0.50-0.74 off.
  const stars = [];
  for (let s2 = 0; s2 < 6; s2++)
    stars.push(await score('examples/smoke/lbPartialAdoption__svg.svg', s2));
  const worstAa = Math.max(...stars.map((r) => (r ? r.aaErr : Infinity))),
    worstPx = Math.max(...stars.map((r) => (r ? r.worstEdge : Infinity)));
  ok(
    worstAa < 5 && worstPx < 0.4 && stars.every((r) => r && r.holes === 0),
    `(d) lbPartialAdoption: every star's edge error under 5 px^2 (worst ${worstAa.toFixed(2)}), worst pixel ${worstPx.toFixed(3)} off, no hole`,
  );
}

console.warn = warn;
console.log(fail ? `LB-STRAIGHT-CHAIN FAIL (${fail})` : 'LB-STRAIGHT-CHAIN OK');
process.exit(fail ? 1 : 0);
