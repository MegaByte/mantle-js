// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Would the opaque depth prepass engage on real art? Recompute its plan gates
// (MIN_CELLS 512, MIN_OVERLAP 1.35) straight from an imported bundle.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { DOMParser } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
import { importSvg } from '../src/index.js';
import { isPlainOpaque } from '../src/renderer/occlusionCull.js';

const OCC_BASE = 20,
  OCC_GRID = 21,
  VE = 1024 | 2048 | 4096;
const MIN_CELLS = 512,
  OVERLAP_GRID = 64,
  MIN_OVERLAP = 1.35;

function gate(bundle) {
  const meta = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape | 0;
  const curves = bundle.curveFloats,
    n = bundle.numShapes | 0,
    gbb = bundle.globalBBox;
  if (!meta || !curves || !gbb || !stride || !n) return { cells: 0, overlap: 0, engage: false };
  const grid = new Uint8Array(OVERLAP_GRID * OVERLAP_GRID);
  let cells = 0,
    totalArea = 0,
    nOpaque = 0,
    nGrid = 0;
  for (let s = 0; s < n; s++) {
    if (!isPlainOpaque(meta, stride, s)) continue;
    nOpaque++;
    const o = s * stride;
    if ((Math.floor(meta[o + 27] + 0.5) & VE) !== 0) continue;
    const base = Math.floor(meta[o + OCC_BASE] + 0.5),
      G = Math.floor(meta[o + OCC_GRID] + 0.5);
    if (!(base > 0 && G > 0)) continue;
    nGrid++;
    const x0 = meta[o],
      y0 = meta[o + 1],
      x1 = meta[o + 2],
      y1 = meta[o + 3];
    const cw = (x1 - x0) / G,
      ch = (y1 - y0) / G;
    if (!(cw > 0 && ch > 0)) continue;
    for (let gy = 0; gy < G; gy++)
      for (let gx = 0; gx < G; gx++) {
        const idx = gy * G + gx;
        if (!(curves[(base + (idx >> 2)) * 4 + (idx & 3)] > 0.5)) continue;
        cells++;
        totalArea += cw * ch;
        const ax = x0 + gx * cw,
          ay = y0 + gy * ch;
        let ix0 = Math.max(0, Math.min(63, Math.floor(((ax - gbb[0]) / gbb[2]) * 64)));
        let iy0 = Math.max(0, Math.min(63, Math.floor(((ay - gbb[1]) / gbb[3]) * 64)));
        let ix1 = Math.max(0, Math.min(63, Math.floor(((ax + cw - gbb[0]) / gbb[2]) * 64)));
        let iy1 = Math.max(0, Math.min(63, Math.floor(((ay + ch - gbb[1]) / gbb[3]) * 64)));
        for (let iy = iy0; iy <= iy1; iy++)
          for (let ix = ix0; ix <= ix1; ix++) grid[iy * 64 + ix] = 1;
      }
  }
  let occ = 0;
  for (let i = 0; i < grid.length; i++) occ += grid[i];
  const unionArea = occ * ((gbb[2] * gbb[3]) / grid.length);
  const overlap = unionArea > 0 ? totalArea / unionArea : 0;
  return { cells, overlap, nOpaque, nGrid, engage: cells >= MIN_CELLS && overlap >= MIN_OVERLAP };
}

const files = process.argv.slice(2);
for (const f of files) {
  try {
    const a = await importSvg(readFileSync(f, 'utf8'), { occupancyGrid: {} });
    // The packed sections carry an 8-float header ahead of the rows.
    const hdr = (buf, n, stride) => new Float32Array(buf, (buf.byteLength / 4 - n * stride) * 4);
    const b = {
      metaFloats: hdr(a.meta, a.numShapes, a.metaFloatsPerShape),
      curveFloats: new Float32Array(a.curves),
      metaFloatsPerShape: a.metaFloatsPerShape,
      numShapes: a.numShapes,
      globalBBox: a.globalBBox,
      hasOccupancy: a.hasOccupancy,
    };
    const g = gate(b);
    console.log(
      `${path.basename(f).padEnd(34)} shapes=${String(b.numShapes).padStart(4)} ` +
        `cells=${String(g.cells).padStart(6)} overlap=${g.overlap.toFixed(2).padStart(5)} ` +
        `opaque=${g.nOpaque} withGrid=${g.nGrid} occ=${b.hasOccupancy} ` +
        (g.engage ? 'ENGAGE' : 'skip'),
    );
  } catch (e) {
    console.log(`${path.basename(f)}  ERROR ${e.message}`);
  }
}
