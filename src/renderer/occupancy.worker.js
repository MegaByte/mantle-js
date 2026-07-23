// occupancy.worker.js — off-thread build of the interior-skip occupancy grids
// (Uint8 bit grids) and the GWN tier-3 cells (Float64 wSum/margin). Both are pure
// O(G²·segs) math with no GL/DOM, so they run entirely off the main thread; the
// main thread only writes the returned bits/cells into its curve/band float
// planes and does the texSubImage2D upload. Mirrors lbBuild.worker.js.

import { buildOccupancyGrid } from '../svg/occupancy.js';
import { computeGwnOccupancyCells } from '../svg/textures.js';

self.onmessage = (e) => {
  const { id, occ, tier3 } = e.data || {};
  /** @type {Transferable[]} */
  const transfer = [];
  const occOut = (occ || []).map((p) => {
    let bits = null;
    try { const g = buildOccupancyGrid(p.segs, p.bbox, p.evenOdd, { grid: p.G, minInteriorFrac: 0.15 }); bits = (g && g.bits) || null; }
    catch { bits = null; }
    if (bits) transfer.push(bits.buffer);
    return { base: p.base, G: p.G, bits };
  });
  const tierOut = (tier3 || []).map((p) => {
    let cells = null;
    try { cells = computeGwnOccupancyCells(p.polySegs, p.bbX0, p.bbY0, p.bbW, p.bbH, p.gridW, p.gridH); }
    catch { cells = null; }
    if (cells) transfer.push(cells.buffer);
    return { absTexel: p.absTexel, gridW: p.gridW, gridH: p.gridH, cells };
  });
  const workerSelf = /** @type {{ postMessage: (message: any, transfer: Transferable[]) => void }} */ (/** @type {unknown} */ (self));
  workerSelf.postMessage({ id, occ: occOut, tier3: tierOut }, transfer);
};
