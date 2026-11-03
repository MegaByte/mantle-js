// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aacOverdrawDepth — the covariate a clipped-art AAC A/B has to hold fixed: how deep the blended cover quads
// stack, per pixel and per tile, with no GL.
//
// AAC's blowup is per-OVERDRAW, not per-pixel: a tile GPU shades the fragments of overlapping
// BLENDED primitives in draw order, so N quads stacked in one tile serialize N kernel runs on those
// pixels. The route's own header measures it (roboto text at 64 px ~9 ms against ~0.9 ms at 1024 px
// with 7.4x FEWER kernel calls). Clipped art can reach the same regime by a different road.
// That claim is a REGRESSION on depth, not an A/B on a feature flag, and this is the
// regressor: it rasterizes each drawn fill row's cover quad into a depth accumulator and reports
//
//   painted      pixels any quad covers
//   frags        cover-quad fragments = the kernel runs a fragment route pays
//   depth        frags / painted, and the p99 and max per pixel
//   serial       sum over 16x16 tiles of (tile fragments x tile max depth) / frags -- the
//                serialization proxy: fragments weighted by how deep their own tile stacks
//   segs/frag    the OTHER regressor, and on this corpus the one that moves: how many BAND ENTRIES
//                the pixel's band walk visits, averaged over cover fragments. AAC pays 150-450
//                flops on a curve that touches the cell against Slug's 30-130, so its
//                disadvantage scales with this, not with the fragment count.
//
// It reports the same numbers with a clip applied and with every clip-path attribute stripped, so a
// clipped-vs-unclipped A/B can say whether it moved the regressor it is supposed to hold fixed.
//
//   N=512 node probes/_aacOverdrawDepth.mjs <svg> [svg ...]
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

const N = +(process.env.N || 512);
const TILE = +(process.env.TILE || 16);
const arScale = (bb, vw, vh) => {
  const cAR = vw / vh,
    sAR = bb[2] / bb[3];
  return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
};

/// Depth statistics for one SVG string at N px.
async function depthOf(svg) {
  const b = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    st = pm.floatsPerShape;
  const gbb = b.globalBBox;
  if (!gbb || !(gbb[2] > 0) || !(gbb[3] > 0)) return null;
  const [sx, sy] = arScale(gbb, N, N);
  const toX = (x) => (((x - gbb[0]) / gbb[2]) * 2 - 1) * sx * 0.5 * N + N * 0.5;
  const toY = (y) => (((y - gbb[1]) / gbb[3]) * 2 - 1) * sy * 0.5 * N + N * 0.5;
  // A clip's own geometry gets meta rows of its own (bundle.clipperRows) and they are NOT drawn --
  // the fragment shader samples them from the clipped shape. Counting them reports the clip
  // machinery as overdraw, which is exactly the number this probe exists to get right.
  const clipRows = new Set();
  for (const k in b.clipperRows || {}) {
    const r = b.clipperRows[k];
    for (let i = r[0]; i <= r[1]; i++) clipRows.add(i);
  }
  const band = new Float32Array(b.bands);
  const depth = new Int32Array(N * N);
  let rows = 0,
    frags = 0,
    segVisits = 0;
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * st;
    if (clipRows.has(s)) continue;
    const inked = F[o + 7] > 0 || (F[o + 11] > 0 && F[o + 12] > 0);
    if (!inked) continue;
    rows++;
    const x0 = Math.max(0, Math.floor(toX(F[o]))),
      x1 = Math.min(N - 1, Math.ceil(toX(F[o + 2])));
    const y0 = Math.max(0, Math.floor(toY(F[o + 1]))),
      y1 = Math.min(N - 1, Math.ceil(toY(F[o + 3])));
    if (x1 < x0 || y1 < y0 || (F[o + 19] | 0) < 0) {
      if (x1 >= x0 && y1 >= y0)
        for (let j = y0; j <= y1; j++)
          for (let i = x0; i <= x1; i++) {
            depth[j * N + i]++;
            frags++;
          }
      continue;
    }
    // The band walk this shape's fragments pay, row by row. Band layout, as renderFillHardBand
    // reads it: glyph loc (gl.x, gl.y), bandsY = GD.w + 1, header at 2 texels per band row, and
    // the row's four counts are (line, quad, cubic, arc).
    const glx = F[o + 16] | 0,
      gly = F[o + 17] | 0,
      bandsY = (F[o + 19] | 0) + 1; // META_GLYPH_LOC_X/Y, META_BAND_MAX_Y
    const bx0 = F[o],
      by0 = F[o + 1],
      bx1 = F[o + 2],
      by1 = F[o + 3];
    const eH = by1 - by0 > 0 ? by1 - by0 : bx1 - bx0 > 0 ? bx1 - bx0 : 1;
    const bLoc = (off) => {
      let lx = glx + off,
        ly = gly;
      ly += lx >> 12;
      lx &= 4095;
      return (ly * 4096 + lx) * 4;
    };
    for (let j = y0; j <= y1; j++) {
      const yEm = gbb[1] + ((((j + 0.5) / N) * 2 - 1) / sy + 1) * 0.5 * gbb[3];
      let bi = Math.floor(((yEm - by0) / eH) * bandsY);
      bi = bi < 0 ? 0 : bi > bandsY - 1 ? bandsY - 1 : bi;
      const h = bLoc(bi * 2);
      const nSeg =
        h + 3 < band.length
          ? (band[h] | 0) + (band[h + 1] | 0) + (band[h + 2] | 0) + (band[h + 3] | 0)
          : 0;
      for (let i = x0; i <= x1; i++) {
        depth[j * N + i]++;
        frags++;
        segVisits += nSeg;
      }
    }
  }
  let painted = 0,
    maxD = 0;
  const hist = new Map();
  for (let q = 0; q < N * N; q++) {
    const d = depth[q];
    if (!d) continue;
    painted++;
    if (d > maxD) maxD = d;
    hist.set(d, (hist.get(d) || 0) + 1);
  }
  const sorted = [...hist.entries()].sort((a, c) => a[0] - c[0]);
  let acc = 0,
    p99 = 0;
  for (const [d, n] of sorted) {
    acc += n;
    if (acc >= painted * 0.99) {
      p99 = d;
      break;
    }
  }
  // serialization proxy, per TILE
  let serial = 0;
  const tiles = Math.ceil(N / TILE);
  for (let tj = 0; tj < tiles; tj++)
    for (let ti = 0; ti < tiles; ti++) {
      let tf = 0,
        tm = 0;
      for (let j = tj * TILE; j < Math.min(N, (tj + 1) * TILE); j++)
        for (let i = ti * TILE; i < Math.min(N, (ti + 1) * TILE); i++) {
          const d = depth[j * N + i];
          tf += d;
          if (d > tm) tm = d;
        }
      serial += tf * tm;
    }
  return {
    rows,
    painted,
    frags,
    depth: frags / Math.max(1, painted),
    p99,
    maxD,
    serial: serial / Math.max(1, frags),
    segs: segVisits / Math.max(1, frags),
  };
}

const strip = (s) =>
  s
    .replace(/\sclip-path\s*=\s*"[^"]*"/g, '')
    .replace(/\sclip-path\s*=\s*'[^']*'/g, '')
    .replace(/(^|[;{\s"'])clip-path\s*:\s*[^;}"']+/g, '$1');

for (const f of process.argv.slice(2)) {
  const src = readFileSync(f, 'utf8');
  const a = await depthOf(src);
  const c = await depthOf(strip(src));
  if (!a) {
    console.log(`${path.basename(f)}: no drawable bbox`);
    continue;
  }
  const fmt = (r) =>
    r
      ? `rows ${String(r.rows).padStart(5)}  painted ${String(r.painted).padStart(7)}  frags ${String(r.frags).padStart(9)}  ` +
        `depth ${r.depth.toFixed(2).padStart(6)}  p99 ${String(r.p99).padStart(4)}  max ${String(r.maxD).padStart(4)}  serial ${r.serial.toFixed(1).padStart(7)}  segs/frag ${r.segs.toFixed(2).padStart(7)}`
      : '(none)';
  console.log(`${path.basename(f)} @${N}`);
  console.log(`   as authored   ${fmt(a)}`);
  console.log(`   clip stripped ${fmt(c)}`);
  if (c)
    console.log(
      `   the strip moves depth ${(100 * (c.depth / a.depth - 1)).toFixed(1)}%, fragments ${(100 * (c.frags / a.frags - 1)).toFixed(1)}%, ` +
        `serial ${(100 * (c.serial / a.serial - 1)).toFixed(1)}%, segs/frag ${(100 * (c.segs / a.segs - 1)).toFixed(1)}%`,
    );
}
