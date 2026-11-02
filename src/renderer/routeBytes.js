// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// routeBytes.js -- renderer.estimateRouteBytes(bundles, options): what each fill route holds in memory, per bundle and per ROW, before any draw.
//
// Routes priced (bytes; `transient` is the build-time heap that is released after the build):
//   cover       the curve, band and meta textures every route needs (the cover quads and the point shader read them)
//   aacPoints   cover + the point list the draw uploads: 8 B per point (four 16-bit fields), one point per device pixel of each row's
//               cover box grown by the AA reach, per paint -- the closed form (k*w + 3)(k*h + 3), k = sqrt(device px2 per em2)
//   loopBlinn   cover + the packed mesh: a built mesh's exact vertex bytes (LB_VERT_BYTES x vertexCount), else the projected bytes,
//               LB_ROW_BYTES + LB_PROJECT x the row's curve bytes: a mesh costs about 14 KB per row whatever the row's size. Exact once the mesh is built.
//   cpatch      cover x CPATCH_RATIO (1.18); bundle level only, no per-row model
//   cachedRaster W x H x 4 B for RGBA8 color, plus 4 B/px when cacheKeepDepthStencil retains the bake attachment
//
// A row's cover bytes are its own curve floats (4 B each, unpadded) plus its meta row, plus a share of the band floats by segment count;
// they sum to the bundle's texture total up to row padding. The per-row numbers are what the row gate trades: a row that takes
// points adds ~8 B x its points, a row that takes its mesh adds its vertex bytes.
import { shapeSegStats } from './shapeStats.js';
import { unitPx2 } from './shapeScale.js';
import { LB_VERT_BYTES } from './lbPack.js';
import { unwrapBundle } from '../core/unwrapBundle.js';

export const ROUTE_BYTES = {
  POINT_BYTES: 8,
  LB_ROW_BYTES: 14336,
  LB_PROJECT: 4,
  CPATCH_RATIO: 1.18,
  RASTER_BYTES_PER_PX: 8,
  STRIP_VERT_BYTES: 48,
};
const TEX_W = 4096,
  TEXEL = 16;
const padTex = (floats) => {
  const texels = Math.ceil(floats / 4);
  return Math.max(1, Math.ceil(texels / TEX_W)) * TEX_W * TEXEL;
};

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachRouteBytes(R) {
  /// @param {object|object[]} bundles
  /// @param {{ unitPx2?: number, viewport?: [number, number], perRow?: boolean }} [options]  unitPx2 overrides the current draw's device px2 per em2.
  /// @returns {{ bundles: object[], total: Record<string, number> }}
  function estimateRouteBytes(bundles, options = {}) {
    const list = Array.isArray(bundles) ? bundles : [bundles];
    const total = {
      cover: 0,
      aacPoints: 0,
      loopBlinn: 0,
      cpatch: 0,
      cachedRaster: 0,
      transientLoopBlinn: 0,
    };
    const out = [];
    for (let b of list) {
      b = unwrapBundle(b);
      if (!b) continue;
      const n = b.numShapes | 0,
        st = b.metaFloatsPerShape | 0,
        meta = b.metaFloats;
      const stats = shapeSegStats(b);
      const ranges = b.curveRangesByShape;
      const k2 = options.unitPx2 != null ? +options.unitPx2 : unitPx2(R, b);
      const k = Math.sqrt(Math.max(0, k2));
      const curveBytes = b.curveFloats ? padTex(b.curveFloats.length) : 0;
      const bandBytes = b.bandFloats ? padTex(b.bandFloats.length) : 0;
      const metaBytes = meta ? meta.byteLength : 0;
      const coverTex = curveBytes + bandBytes + metaBytes;
      let segSum = 0;
      if (stats) for (let s = 0; s < n; s++) segSum += stats.segs[s];
      const rowCover = new Float64Array(n),
        rowPoints = new Float64Array(n),
        rowLb = new Float64Array(n),
        rowE = new Float64Array(n);
      let points = 0,
        lbBuilt = 0,
        lbProjected = 0,
        builtRows = 0;
      const meshes = b._lbMeshes;
      for (let s = 0; s < n; s++) {
        const o = s * st;
        const curveF =
          ranges && ranges[s] ? Math.max(0, (ranges[s].end | 0) - (ranges[s].begin | 0)) : 0;
        const segs = stats ? stats.segs[s] : 0;
        rowCover[s] = curveF * 4 + st * 4 + (segSum > 0 ? (bandBytes * segs) / segSum : 0);
        if (meta && st) {
          const w = meta[o + 2] - meta[o],
            h = meta[o + 3] - meta[o + 1];
          rowE[s] = Math.max(w, h) * k;
          const fill = meta[o + 7] > 0,
            stroke = meta[o + 11] > 0 && meta[o + 12] > 0;
          const p =
            (fill ? (k * w + 3) * (k * h + 3) : 0) + (stroke ? (k * w + 3.4) * (k * h + 3.4) : 0);
          rowPoints[s] = p * ROUTE_BYTES.POINT_BYTES;
          points += rowPoints[s];
        }
        const m = meshes && meshes[s];
        if (m && !m.slug && (m.vertexCount | 0) > 0) {
          rowLb[s] = m.vertexCount * LB_VERT_BYTES;
          lbBuilt += rowLb[s];
          builtRows++;
        } else {
          rowLb[s] = ROUTE_BYTES.LB_ROW_BYTES + curveF * 4 * ROUTE_BYTES.LB_PROJECT;
          lbProjected += rowLb[s];
        }
      }
      // the conforming strip covers of the stroke rows ride the cover VBO planes next to the quads (48 B per vertex: 12 floats),
      // resident under every route, so they count for each; one row's share is its vertex count.
      const rowStrip = new Float64Array(n);
      let stripBytes = 0,
        stripVerts = 0,
        stripRows = 0;
      if (b._stripChunks)
        for (const c of b._stripChunks) {
          const v = c._strip.count | 0;
          rowStrip[c._strip.row] = v * ROUTE_BYTES.STRIP_VERT_BYTES;
          stripVerts += v;
          stripRows++;
        }
      stripBytes = stripVerts * ROUTE_BYTES.STRIP_VERT_BYTES;
      const lb = lbBuilt + lbProjected;
      const vp = options.viewport || (R.viewportSize ? R.viewportSize() : null);
      const rasterBytesPerPx =
        R.opts && R.opts.cacheKeepDepthStencil ? ROUTE_BYTES.RASTER_BYTES_PER_PX : 4;
      const raster = vp ? vp[0] * vp[1] * rasterBytesPerPx : 0;
      const r = {
        bundle: b,
        rows: n,
        unitPx2: k2,
        cover: { tex: coverTex, buf: stripBytes },
        aacPoints: { tex: coverTex, buf: points + stripBytes },
        loopBlinn: { tex: coverTex, buf: lb + stripBytes, builtRows, projectedRows: n - builtRows },
        strip: { buf: stripBytes, vertices: stripVerts, rows: stripRows },
        cpatch: { tex: coverTex * ROUTE_BYTES.CPATCH_RATIO, buf: 0, modeled: 'median-ratio' },
        cachedRaster: { tex: raster, buf: 0 },
      };
      if (options.perRow)
        r.perRow = {
          cover: rowCover,
          aacPoints: rowPoints,
          loopBlinn: rowLb,
          strip: rowStrip,
          extentPx: rowE,
        };
      out.push(r);
      total.cover += coverTex + stripBytes;
      total.aacPoints += coverTex + points + stripBytes;
      total.loopBlinn += coverTex + lb + stripBytes;
      total.cpatch += r.cpatch.tex;
      total.cachedRaster += raster;
    }
    return { bundles: out, total };
  }
  R.estimateRouteBytes = estimateRouteBytes;
}
