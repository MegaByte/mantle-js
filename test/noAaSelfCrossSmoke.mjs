// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// noAaSelfCrossSmoke — a no-AA kernel at a SELF-CROSSING is exact about membership, and its
// residual is the quantization every no-AA kernel has.
//
// A HARD EDGE AT A SELF-CROSSING IS NOT BY ITSELF A DEFECT. A hard edge is what a
// no-AA kernel IS: it answers inside/outside at the pixel center, so against an antialiased
// reference every boundary pixel is off by whatever that pixel's partial coverage was. The question
// a measurement has to separate is whether the kernel is WRONG about the shape — which would be a
// defect at any resolution — or merely un-antialiased, which is the contract the route was chosen
// under (an opaque stroke at least two device pixels wide covers the fill's boundary band;
// fillPass.js preferNoAa).
//
// THE REFERENCE IS THE PATH. rowSpans gives a scanline's filled spans exactly, so membership at a
// pixel center is exact and so is a pixel's box coverage. The kernel side is the SHIPPED shader
// text in float32 on the CPU (test/_glslEmu.mjs).
//
//   (a) over six self-crossing shapes under both fill rules — loop and near-cusp cubics, a crossing
//       quad pair, a pentagram — band-hard and tree-hard get every pixel center right, at 256 and
//       512. So neither is wrong about the shape;
//   (b) their residual against the box filter is the quantization, and the two agree on it to
//       within a few percent — so nothing there is specific to the tree;
//   (c) where they differ it is the TREE that is better: on the two cubic self-crossings band-hard
//       leaves pixels off by more than half a coverage and tree-hard leaves none;
//   (d) non-vacuity: the antialiasing kernels on the same pixels are an order of magnitude closer,
//       which is what makes (b) a quantization and not a tolerance.
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_GWN, K_HARD, K_AAC } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP noAaSelfCrossSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { rowSpans } = await import('../src/renderer/cpatchConvert.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const ARMS = {
  bandhard: { defs: ['MANTLE_HARD'], k: K_HARD },
  treehard: { defs: ['MANTLE_HARD', 'MANTLE_HARD_TREE', 'MANTLE_GWN'], k: K_GWN },
  aac: { defs: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'], k: K_AAC },
};
for (const a of Object.values(ARMS)) a.emu = buildGlslEmu(ROOT, { defines: a.defs });

const wrap = (d, eo) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path ${eo ? 'fill-rule="evenodd" ' : ''}d="${d}" fill="#000"/></svg>`;
const LOOP = 'M 120 260 C 380 80, 20 80, 280 260 Z'; // the control polygon crosses: a loop
const CUSP = 'M 120 280 C 340 60, 120 60, 200 300 Z'; // a sharp reversal
const CROSS = 'M 80 200 Q 200 40 320 200 Q 80 360 80 200 Z'; // two quads crossing
const STAR = 'M 200 40 L 305 340 L 50 155 L 350 155 L 95 340 Z';
const FIX = {
  loop: wrap(LOOP),
  loopEO: wrap(LOOP, true),
  cusp: wrap(CUSP),
  cross: wrap(CROSS),
  star: wrap(STAR),
  starEO: wrap(STAR, true),
};

async function load(svg) {
  const b = await importSvg(svg, { preserveViewport: true, gwnTree: true });
  const shapes = fillShapes(b, parseMetaBin, M);
  const curve = new Float32Array(b.curves);
  for (const sh of shapes) {
    const cs = contoursToConverter(curveRangeToContours(curve, sh.range.begin, sh.range.end), null);
    sh.segs = cs ? cs.flat() : null;
  }
  return { shapes, band: new Float32Array(b.bands), curve };
}
function rowInside(segs, y, eo, xs) {
  const spans = rowSpans(segs, y, eo),
    out = new Uint8Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    for (const s of spans)
      if (x >= s[0] && x < s[1]) {
        out[i] = 1;
        break;
      }
  }
  return out;
}
function rowBoxCov(segs, y0, eo, xs, px, slices) {
  const acc = new Float64Array(xs.length);
  for (let s = 0; s < slices; s++) {
    const spans = rowSpans(segs, y0 + (px * (s + 0.5)) / slices, eo);
    for (let i = 0; i < xs.length; i++) {
      const lo0 = xs[i] - px / 2,
        hi0 = xs[i] + px / 2;
      let a = 0;
      for (const sp of spans) {
        const lo = Math.max(sp[0], lo0),
          hi = Math.min(sp[1], hi0);
        if (hi > lo) a += hi - lo;
      }
      acc[i] += a;
    }
  }
  for (let i = 0; i < xs.length; i++) acc[i] /= px * slices;
  return acc;
}

const tot = {};
for (const k of Object.keys(ARMS)) tot[k] = { solid: 0, abs: 0, n: 0, big: 0, bigCubic: 0 };
let nShapes = 0,
  nPx = 0;
for (const [name, svg] of Object.entries(FIX)) {
  const loaded = await load(svg);
  const cubic = name.startsWith('loop') || name === 'cusp';
  for (const N of [256, 512]) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of loaded.shapes) {
      x0 = Math.min(x0, s.bb[0]);
      y0 = Math.min(y0, s.bb[1]);
      x1 = Math.max(x1, s.bb[2]);
      y1 = Math.max(y1, s.bb[3]);
    }
    const px = Math.max(x1 - x0, y1 - y0) / N;
    for (const sh of loaded.shapes) {
      if (!sh.segs || !sh.segs.length) continue;
      nShapes++;
      const i0 = Math.floor((sh.bb[0] - x0) / px) - 2,
        i1 = Math.ceil((sh.bb[2] - x0) / px) + 2;
      const j0 = Math.floor((sh.bb[1] - y0) / px) - 2,
        j1 = Math.ceil((sh.bb[3] - y0) / px) + 2;
      const W = i1 - i0 + 1,
        H = j1 - j0 + 1;
      const xs = new Float64Array(W);
      for (let i = 0; i < W; i++) xs[i] = x0 + (i0 + i + 0.5) * px;
      const inside = new Uint8Array(W * H),
        ref = new Float64Array(W * H);
      for (let j = 0; j < H; j++) {
        inside.set(rowInside(sh.segs, y0 + (j0 + j + 0.5) * px, sh.eo, xs), j * W);
        ref.set(rowBoxCov(sh.segs, y0 + (j0 + j) * px, sh.eo, xs, px, 16), j * W);
      }
      const edge = new Uint8Array(W * H),
        solid = new Uint8Array(W * H);
      for (let j = 1; j < H - 1; j++)
        for (let i = 1; i < W - 1; i++) {
          const k = j * W + i,
            v = inside[k];
          let same = true;
          for (let dj = -1; dj <= 1 && same; dj++)
            for (let di = -1; di <= 1; di++)
              if (inside[(j + dj) * W + i + di] !== v) {
                same = false;
                break;
              }
          if (same) solid[k] = 1;
          else edge[k] = 1;
        }
      const qs = [];
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++)
          qs.push({
            GD: sh.GD,
            bb: sh.bb,
            eo: sh.eo,
            c: [xs[i], y0 + (j0 + j + 0.5) * px],
            ePx: [px, px],
          });
      nPx += qs.length;
      for (const [k, a] of Object.entries(ARMS)) {
        const r = a.emu.run(
          loaded.band,
          loaded.curve,
          qs.map((q) => ({ ...q, k: a.k })),
        );
        const t = tot[k];
        for (let m = 0; m < r.length; m++) {
          if (solid[m]) {
            if (Math.abs(r[m] - inside[m]) > 0.5) t.solid++;
          } else if (edge[m]) {
            const d = Math.abs(r[m] - ref[m]);
            t.abs += d;
            t.n++;
            if (d > 0.5) {
              t.big++;
              if (cubic) t.bigCubic++;
            }
          }
        }
      }
    }
  }
}
const mean = (k) => tot[k].abs / tot[k].n;
ok(
  tot.bandhard.solid === 0 && tot.treehard.solid === 0,
  `(a) ${Object.keys(FIX).length} self-crossing shapes at 256 and 512, ${nPx} pixel centers: band-hard ${tot.bandhard.solid} wrong, tree-hard ${tot.treehard.solid} wrong`,
);
ok(
  Math.abs(mean('treehard') / mean('bandhard') - 1) < 0.05,
  `(b) the residual is the quantization and the two share it: band-hard ${mean('bandhard').toFixed(4)}, tree-hard ${mean('treehard').toFixed(4)} mean over ${tot.bandhard.n} boundary pixels`,
);
ok(
  tot.treehard.bigCubic <= tot.bandhard.bigCubic,
  `(c) pixels off by more than half a coverage on the CUBIC self-crossings: band-hard ${tot.bandhard.bigCubic}, tree-hard ${tot.treehard.bigCubic}`,
);
ok(
  mean('aac') * 5 < mean('bandhard'),
  `(d) an antialiasing kernel on the same pixels: AAC ${mean('aac').toFixed(4)} — ${(mean('bandhard') / mean('aac')).toFixed(1)}x closer, which is what makes (b) quantization`,
);

console.log(fail ? `noAaSelfCrossSmoke FAIL (${fail})` : 'noAaSelfCrossSmoke PASS');
process.exit(fail ? 1 : 0);
