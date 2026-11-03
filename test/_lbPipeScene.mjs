// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Software shader diagnostics over production scene data.
import { buildVert, runVert, buildFrag, runRaster } from './_lbPipeEmu.mjs';
import { attrsOf } from './_lbSceneData.mjs';
export { lbScene, arScale, attrsOf } from './_lbSceneData.mjs';

/// Run the scene through the generated vert + frag texts. `defines` are added to the fill variant's
/// (MANTLE_LB_FILL, and the layout's). opts: coarse (derivative convention, see _lbPipeEmu), kinds (only rasterize
/// triangles whose provoking vertex is one of these LB kinds -- a band-only run is ~50x cheaper; the records keep the
/// scene's own triangle numbers), contract (both stages fused, see _glslEmu.mjs fpFlags), alu (each record's flags slot
/// counts the fragment's float operations instead, see _lbPipeEmu's ALU COUNTING), scissor ([x0, row0, x1, row1], top-down,
/// inclusive: shade only that rectangle), tie ('bottomright': the other raster tie convention, see _lbPipeEmu). Returns
/// { recs, counts, entryOfTri,
/// vOut, vert }.
export function renderScene(
  sc,
  vertText,
  fragText,
  defines = [],
  { coarse = false, kinds = null, snap = 0, contract, alu = false, scissor = null, tie } = {},
) {
  const defs = ['MANTLE_LB_FILL', ...sc.stream.defs, ...defines];
  const st = sc.stream;
  const attrs = attrsOf(st.verts, st.vc, st.stride, st.attribs);
  const vert = buildVert(vertText, defs, contract === undefined ? {} : { contract }),
    vOut = runVert(vert, sc.textures, sc.uniforms, attrs, st.vc);
  const nTri = (st.vc / 3) | 0,
    keep = [];
  const ko = vert.outOff[vert.io.outs.findIndex((o) => o.name === 'vKind')];
  for (let t = 0; t < nTri; t++) {
    if (
      kinds &&
      !(ko != null && kinds.includes(Math.floor(vOut[(t * 3 + 2) * vert.outN + ko] + 1e-4)))
    )
      continue;
    keep.push(t);
  }
  const tris = new Int32Array(keep.length * 3);
  keep.forEach((t, k) => {
    tris[k * 3] = t * 3;
    tris[k * 3 + 1] = t * 3 + 1;
    tris[k * 3 + 2] = t * 3 + 2;
  });
  const frag = buildFrag(fragText, defs, {
    coarse,
    snap,
    alu,
    tie,
    ...(contract === undefined ? {} : { contract }),
  });
  const r = runRaster(frag, vert, vOut, tris, sc.textures, sc.uniforms, sc.N, sc.N, scissor);
  for (let q = 0; q < r.recs.length / 9; q++) r.recs[q * 9] = keep[r.recs[q * 9] | 0];
  return { recs: r.recs, counts: r.counts, entryOfTri: sc.entryOfTri, vOut, vert };
}

/// OVER-composite the alpha of every fragment that did not discard: 1 - prod(1 - a), the no-claim opaque path.
/// `keep(tri)` selects fragments. Returns a Float64Array N*N of coverage, rows top-down.
export function compositeAlpha(recs, N, keep) {
  const open = new Float64Array(N * N).fill(1);
  for (let i = 0; i < recs.length / 9; i++) {
    if (recs[i * 9 + 7] === 1) continue;
    if (keep && !keep(recs[i * 9] | 0)) continue;
    const a = Math.min(1, Math.max(0, recs[i * 9 + 6]));
    const k = (recs[i * 9 + 2] | 0) * N + (recs[i * 9 + 1] | 0);
    open[k] *= 1 - a;
  }
  for (let k = 0; k < open.length; k++) open[k] = 1 - open[k];
  return open;
}
