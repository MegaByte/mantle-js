// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchDataSize — how big is baked CPatch data next to the SVG it came from?
//
// Decides whether OFFLINE PRE-BAKING is viable: conversion is ~9ms/contour, and if
// the baked form is small enough to ship, load-time conversion stops mattering at
// all. If it is far larger than the source, pre-baking trades a build cost for a
// download cost and may be the worse deal.
//
// Two planes: the curve texels (4 RGBA32F per curve) and the LB vertex stream
// (stride 24 floats). Both are reported, because they scale with different things —
// texels with CURVES, vertices with the grid split's CELLS.
import { readFileSync } from 'fs';
import { gzipSync, brotliCompressSync } from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePathD } from '../src/svg/path.js';
import { cubicInflections, cubicLoopCuts, splitCubic } from '../src/geom/lbCubicMath.js';
import { packCPatchContour } from '../src/renderer/cpatchPack.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function contoursOf(txt, limit = 1e9) {
  const ds = [...txt.matchAll(/\sd\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const out = [];
  for (const d of ds) {
    let segs;
    try {
      segs = parsePathD(d);
    } catch {
      continue;
    }
    let cur = null;
    const flush = () => {
      if (cur && cur.length >= 2) out.push(cur);
      cur = null;
    };
    for (const s of segs) {
      if (s.subStart) flush();
      if (!cur) cur = [];
      if (s.type === 0 && s.p2) cur.push({ t: 'line', P: [s.p1, s.p2] });
      else if (s.type === 1 && s.p3) cur.push({ t: 'quad', P: [s.p1, s.p2, s.p3] });
      else if (s.type === 2 && s.p4) cur.push({ t: 'cubic', P: [s.p1, s.p2, s.p3, s.p4] });
    }
    flush();
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

const FILES = (process.env.FILES || 'examples/tiger.svg').split(',');
const LIMIT = +(process.env.LIMIT || 80);
const GRIDS = (process.env.GRIDS || '4,2,1').split(',').map(Number);

console.log(`\nbaked CPatch size vs source SVG   (grid split drives the vertex stream)\n`);
console.log('  asset                     grid |   svg KB | texel KB |  vert KB | total KB | x svg');
for (const rel of FILES) {
  let txt;
  try {
    txt = readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8');
  } catch {
    console.log(`  ${rel}: unreadable`);
    continue;
  }
  const svgKB = Buffer.byteLength(txt) / 1024;
  const cs = contoursOf(txt, LIMIT);
  for (const g of GRIDS) {
    let tex = 0,
      vert = 0,
      n = 0,
      curves = 0;
    const texParts = [],
      vertParts = [];
    const uniq = new Set();
    let inst = 0;
    for (const c of cs) {
      let m = null;
      try {
        m = packCPatchContour(c, 0, { grid: g });
      } catch {}
      if (!m) continue;
      n++;
      tex += m.texels.length;
      vert += m.verts.length;
      curves += c.length;
      texParts.push(m.texels);
      vertParts.push(m.verts);
      // DUPLICATION: the grid split re-emits a curve's four coefficient texels into
      // every cell that touches it. Counting distinct coefficient tuples says how
      // much a shared curve pool + per-cell index list would save.
      for (let t = 0; t < m.texels.length; t += 16) {
        let k = '';
        for (let q = 0; q < 16; q++) k += m.texels[t + q] + ',';
        uniq.add(k);
        inst++;
      }
    }
    const texBuf = new Float32Array(tex);
    {
      let o = 0;
      for (const t of texParts) {
        texBuf.set(t, o);
        o += t.length;
      }
    }
    const vertBuf = new Float32Array(vert);
    {
      let o = 0;
      for (const v of vertParts) {
        vertBuf.set(v, o);
        o += v.length;
      }
    }
    const texKB = (tex * 4) / 1024,
      vertKB = (vert * 4) / 1024;
    // TIGHT form: the CPatch kind reads pos.xy, kind, sign, first, count — 6 of the
    // 24 floats a shared-stride LB vertex carries. The rest is zero padding that
    // exists so one buffer serves every kind, and it is 3/4 of the stream.
    const tightKB = ((vert / 24) * 6 * 4) / 1024;
    // What actually ships is COMPRESSED, and float planes with this much structure
    // (repeated coefficients per cell, zero padding) compress hard.
    const gz = (buf) => gzipSync(buf, { level: 9 }).length / 1024;
    const br = (buf) => brotliCompressSync(buf).length / 1024;
    const blob = Buffer.concat([
      Buffer.from(texBuf.buffer, 0, tex * 4),
      Buffer.from(vertBuf.buffer, 0, vert * 4),
    ]);
    const svgGz = gz(Buffer.from(txt)),
      svgBr = br(Buffer.from(txt));
    console.log(
      `  ${path.basename(rel).padEnd(25)} ${String(g).padStart(4)} | ${svgKB.toFixed(1).padStart(8)} | ${texKB.toFixed(1).padStart(8)} | ${vertKB.toFixed(1).padStart(8)} | ${(texKB + vertKB).toFixed(1).padStart(8)} | ${((texKB + vertKB) / svgKB).toFixed(1).padStart(5)}x`,
    );
    console.log(
      `  ${''.padEnd(25)}      |   gzip ${gz(blob).toFixed(0)}KB · brotli ${br(blob).toFixed(0)}KB   vs svg gzip ${svgGz.toFixed(0)}KB/brotli ${svgBr.toFixed(0)}KB  ->  ${(br(blob) / svgBr).toFixed(1)}x compressed`,
    );
    console.log(
      `  ${''.padEnd(25)}      |   tight verts would be ${tightKB.toFixed(0)}KB (from ${vertKB.toFixed(0)}KB), total ${(texKB + tightKB).toFixed(0)}KB = ${((texKB + tightKB) / svgKB).toFixed(1)}x raw`,
    );
    // A shared curve pool costs one 4-texel record per DISTINCT curve, plus a
    // uint16 index per (cell, curve) reference.
    const poolKB = (uniq.size * 16 * 4) / 1024,
      idxKB = (inst * 2) / 1024;
    const compactKB = poolKB + idxKB + tightKB;
    console.log(
      `  ${''.padEnd(25)}      |   curve texels: ${inst} emitted, ${uniq.size} distinct (${(inst / Math.max(uniq.size, 1)).toFixed(1)}x duplicated by the grid)`,
    );
    console.log(
      `  ${''.padEnd(25)}      |   COMPACT (pool ${poolKB.toFixed(0)}KB + idx ${idxKB.toFixed(0)}KB + tight verts ${tightKB.toFixed(0)}KB) = ${compactKB.toFixed(0)}KB — ${((texKB + vertKB) / compactKB).toFixed(1)}x smaller, ${(compactKB / svgKB).toFixed(1)}x svg`,
    );
  }
  console.log(`  (${cs.length} contours sampled)`);
}
console.log('\nvertices are stride-24 FLOATS — most of the stream is zero padding the');
console.log('CPatch kind never reads, which is the first thing to attack if this ships.');
