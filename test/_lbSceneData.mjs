// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Build CPU scene streams, attributes, textures and uniforms without executing shaders.
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(path.join(ROOT, p));

export const arScale = (bb, vw, vh) => {
  const cAR = vw / vh,
    sAR = bb[2] / bb[3];
  return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
};
const tex = (w, h, l, data) => ({ w, h, l, data });

/// Build the scene. opts: N (canvas px, square), layout 'curvetex' (the renderer's default) | 'wide', world (a
/// 3x3 column-major uWorldM or null), rows (a predicate (s, isStroke) -> 'lb' | 'cover' | 'skip' overriding the route's
/// rule, for experiments), lb (a prebuilt { packed } to use instead of buildLbBundle's), morph ({ svg, t }: the MORPH
/// stream from this drawing to `svg` at global t -- the pair meshes lbMorphCore.buildMorphBundle builds, the active
/// segment and local t as unifiedFillDraw's morphSeg picks them, MANTLE_LB_MORPH and uMorphT; a shape whose active
/// segment's local t differs from the first one's is left out, since uMorphT is one uniform per run, and counted in
/// `morphSkipped`), importOpts (importSvg's options, e.g. { preserveViewport: true } for the fit a GPU probe's page uses).
export async function lbScene(svgText, opts = {}) {
  const N = opts.N || 512,
    layout = opts.layout || 'curvetex';
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await imp('src/svg/importer.js');
  const { parseMetaBin, buildDrawList } = await imp('src/renderer/bundle.js');
  const { buildLbBundle } = await imp('src/renderer/lbBuildCore.js');
  const CQ = await imp('src/renderer/coverQuadChunks.js');
  const { isStrokeRow } = await imp('src/renderer/engineLedger.js');
  const UV = await imp('src/renderer/unifiedFillVerts.js');
  const sec = await importSvg(svgText, opts.importOpts || {});
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const M = pm.metaFloats,
    S = pm.floatsPerShape,
    NS = pm.numShapes;
  let lb,
    morphT = null,
    morphSkipped = 0;
  if (opts.morph) {
    const { buildMorphBundle } = await imp('src/renderer/lbMorphCore.js');
    const B = await importSvg(opts.morph.svg),
      pb = parseMetaBin(B.meta, B.metaFloatsPerShape);
    const res = buildMorphBundle({
      srcCurve: new Float32Array(sec.curves),
      dstCurve: new Float32Array(B.curves),
      srcMeta: M,
      dstMeta: pb.metaFloats,
      metaStride: S,
      ranges: sec.curveRangesByShape,
      numShapes: sec.numShapes,
    });
    if (!res || !res.meshes)
      throw new Error('lbScene: the morph pair did not build (whole-bundle Slug)');
    const t = opts.morph.t;
    lb = {
      packed: res.meshes.map((m) => {
        if (!m) return null;
        let vbo = m.vbo,
          lt = t;
        if (m.segments && m.segments.length) {
          let sg = m.segments[m.segments.length - 1];
          for (const g of m.segments)
            if (t <= g.tHi) {
              sg = g;
              break;
            }
          const span = sg.tHiB - sg.tLoB;
          lt = span > 1e-9 ? (t - sg.tLoB) / span : 0;
          vbo = sg.vbo;
        }
        if (morphT === null) morphT = lt;
        if (lt !== morphT) {
          morphSkipped++;
          return null;
        }
        return { verts: vbo, vertexCount: m.vertexCount };
      }),
    };
  } else
    lb =
      opts.lb ||
      buildLbBundle({
        curveFloats: new Float32Array(sec.curves),
        metaFloats: M,
        metaFloatsPerShape: S,
        ranges: sec.curveRangesByShape,
        numShapes: sec.numShapes,
      });
  const morph = !!opts.morph;
  // Cover quads, as createBundle builds them.
  const coverQuadFloats =
    sec.curveGeom && sec.curveGeom.byteLength ? new Float32Array(sec.curveGeom) : null;
  const chunks = CQ.parseCoverQuadChunks(coverQuadFloats, sec.flags);
  const gid = CQ.buildGidToShapeIdx(M, NS, S);
  const sidx = coverQuadFloats ? CQ.buildShapeIdxFloats(coverQuadFloats, chunks, gid) : null;
  const stripped = coverQuadFloats
    ? CQ.buildStrippedCoverQuad(coverQuadFloats, chunks, sidx)
    : null;
  const chunkByShape = new Array(NS);
  for (const c of chunks) {
    const si = gid.get(c.gid);
    if (si !== undefined) chunkByShape[si] = c;
  }
  const drawList = buildDrawList(M, NS, S, chunkByShape, null, null);
  const entries = [];
  for (const op of drawList) {
    if (op.kind !== 'fillShape') continue;
    const s = op.shapeIdx,
      stroke = isStrokeRow(M, S, s),
      pk = lb.packed[s];
    const hasMesh = !!(pk && !pk.slug && pk.vertexCount > 0);
    let route = stroke || !hasMesh ? 'cover' : 'lb';
    if (opts.rows) route = opts.rows(s, stroke, hasMesh) || route;
    if (route === 'skip') continue;
    if (route === 'lb' && hasMesh)
      entries.push({ kind: 'lb', verts: pk.verts, vertexCount: pk.vertexCount, shapeIdx: s });
    else if (op.chunk && (op.chunk.count | 0) > 0) {
      const start = op.chunk.vboStart != null ? op.chunk.vboStart : op.chunk.start;
      entries.push({
        kind: 'cover',
        srcVert: start | 0,
        count: op.chunk.count | 0,
        shapeIdx: s,
        coverKid: ((M[s * S + 27] | 0) >> 15) & 3,
      });
    }
  }
  const built = UV.buildUnifiedFillVerts(
    entries,
    stripped ? stripped.verts : new Float32Array(0),
    stripped ? stripped.shapeIdx : new Float32Array(0),
    morph,
  );
  // Textures, as fillPass binds them (the meta plane 12 texels wide, one row per shape).
  const meta = new Float32Array(Math.max(1, NS) * 48);
  for (let s = 0; s < NS; s++) meta.set(M.subarray(s * S, s * S + Math.min(S, 48)), s * 48);
  const T = [],
    idx = {};
  const add = (t) => {
    T.push(t);
    return T.length - 1;
  };
  const curve = new Float32Array(sec.curves),
    band = new Float32Array(sec.bands);
  idx.uCurveData = add(tex(4096, Math.max(1, Math.ceil(curve.length / 16384)), 1, curve));
  idx.uBandData = add(tex(4096, Math.max(1, Math.ceil(band.length / 16384)), 1, band));
  idx.uMetaTex = add(tex(12, Math.max(1, NS), 1, meta));
  if (sec.gradients && sec.gradients.byteLength) {
    const g = new Float32Array(sec.gradients);
    idx.uGradientTex = add(tex(4, g.length / 16, 1, g));
  }
  if (sec.gradientStops && sec.gradientStops.byteLength) {
    const by = new Uint8Array(sec.gradientStops),
      fl = new Float32Array(by.length);
    for (let i = 0; i < by.length; i++) fl[i] = Math.fround(by[i] / 255);
    const tx = fl.length / 4;
    idx.uGradientStops = add(
      tx <= 2048 ? tex(tx, 1, 1, fl) : tex(2048, Math.ceil(tx / 2048), 1, fl),
    );
  }
  if (sec.dashes && sec.dashes.byteLength) {
    const d = new Float32Array(sec.dashes);
    idx.uDashTex = add(tex(16, d.length / 64, 1, d));
  }
  if (sec.filterTab && sec.filterTab.byteLength) {
    const d = new Float32Array(sec.filterTab);
    idx.uFilterTex = add(tex(6, d.length / 24, 1, d));
  }
  idx.uOverrideTex = add(tex(6, Math.max(1, NS), 1, new Float32Array(Math.max(1, NS) * 24)));
  idx.uMaskRowToLayerTex = add(
    tex(1, Math.max(1, NS), 1, new Float32Array(Math.max(1, NS) * 4).fill(-1)),
  );
  const gbb = pm.globalBBox;
  const U = new Map(
    Object.entries({
      uGlobalBBox: gbb,
      uCanvasAR: arScale(gbb, N, N),
      uViewportSize: [N, N],
      uNumShapes: Math.max(1, NS),
      uShapeIdxOverride: -1,
      uHasEmCoord: 0,
      uHasOverrides: 0,
      uDrawAlpha: 1,
      uHasWorldM: opts.world ? 1 : 0,
      uCoverAaReach: 0,
      uWorldM: opts.world || [1, 0, 0, 0, 1, 0, 0, 0, 1],
      uStrokeExactAa: 1,
      uStrokeGates: 1,
      uHasOccupancy: 0,
      uFragOrigin: [0, 0],
      uHasOffscreenMask: 0,
      uExtClipMode: 0,
      uChannelLerpEnabled: 0,
      uColorMatrixEnabled: 0,
      uPaletteEnabled: 0,
      uImageAtlasSize: [1, 1],
    }),
  );
  for (const [k, v] of Object.entries(idx)) U.set(k, v);
  let stream;
  const mdefs = morph ? ['MANTLE_LB_MORPH'] : [];
  if (morph) U.set('uMorphT', morphT === null ? 0 : morphT);
  // Match the renderer's wide-layout fallback when the curve-block index overflows.
  const narrow =
    layout === 'wide' ? null : UV.buildCurveTexStream(built.verts, built.vertexCount, morph);
  if (layout === 'wide' || !narrow)
    stream = {
      defs: mdefs,
      verts: built.verts,
      vc: built.vertexCount,
      stride: morph ? UV.UNIFIED_MORPH_STRIDE : UV.UNIFIED_STRIDE,
      attribs: morph ? [...UV.UNIFIED_ATTRIBS, ...UV.UNIFIED_MORPH_ATTRIBS] : UV.UNIFIED_ATTRIBS,
    };
  else {
    const nar = narrow;
    U.set('uCurveCoefTex', add(tex(nar.coefW, nar.coefH, 1, nar.coefData)));
    U.set('uCurveCoefW', nar.coefW);
    stream = nar.idx32
      ? {
          defs: ['MANTLE_LB_CURVE_TEX', ...mdefs],
          verts: nar.verts,
          vc: nar.vertexCount,
          stride: morph ? UV.UC32_MORPH_STRIDE : UV.UC32_STRIDE,
          attribs: morph ? [...UV.UC32_ATTRIBS, ...UV.UC32_MORPH_ATTRIBS] : UV.UC32_ATTRIBS,
        }
      : {
          defs: ['MANTLE_LB_CURVE_TEX', ...mdefs],
          verts: nar.verts,
          vc: nar.vertexCount,
          stride: morph ? UV.UC_MORPH_STRIDE : UV.UC_STRIDE,
          attribs: morph ? [...UV.UC_ATTRIBS, ...UV.UC_MORPH_ATTRIBS] : UV.UC_ATTRIBS,
        };
  }
  // Which entry each triangle belongs to.
  const entryOfTri = new Int32Array((stream.vc / 3) | 0).fill(-1);
  entries.forEach((e, k) => {
    for (let v = e.vStart; v < e.vStart + e.vCount; v += 3) entryOfTri[(v / 3) | 0] = k;
  });
  return {
    sec,
    pm,
    lb,
    N,
    gbb,
    textures: T,
    uniforms: U,
    entries,
    stream,
    entryOfTri,
    drawList,
    morphT,
    morphSkipped,
  };
}

/// Per-vertex attribute block (16 locations x 4) from a stream and its attribute table.
export function attrsOf(verts, vc, strideFloats, table) {
  const A = new Float32Array(vc * 64);
  for (let v = 0; v < vc; v++) for (let l = 0; l < 16; l++) A[v * 64 + l * 4 + 3] = 1;
  const u16 = new Uint16Array(verts.buffer, verts.byteOffset, verts.byteLength / 2);
  const u32 = new Uint32Array(verts.buffer, verts.byteOffset, verts.byteLength / 4);
  for (const [loc, size, off, type] of table)
    for (let v = 0; v < vc; v++)
      for (let c = 0; c < size; c++) {
        A[v * 64 + loc * 4 + c] =
          type === 'ushort'
            ? u16[(v * strideFloats * 4 + off) / 2 + c]
            : type === 'uint'
              ? u32[v * strideFloats + off / 4 + c]
              : verts[v * strideFloats + off / 4 + c];
      }
  return A;
}
