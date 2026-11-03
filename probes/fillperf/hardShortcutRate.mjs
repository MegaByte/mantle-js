// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hardShortcutRate — how many band-hard entries the end-sign shortcuts answer without a solve, per PIXEL, on the CPU.
//
//   node probes/fillperf/hardShortcutRate.mjs [--size 512] a.svg b.svg ...      (default: examples/tiger.svg)
//
// Every pixel center of an N-pixel raster of the drawing inside each fill shape's bbox plus a pixel is walked the way
// renderFillHardBand walks it -- the H stripe list at c.y, break at maxX < c.x, the lane reject -- and each entry
// that reaches its crossing test is classed: a quad or cubic whose control hull lies strictly right of c.x, an arc
// whose whole ellipse clears it by the shader's margin (both answered by the end-sign rule, no solve), a cubic whose
// hull misses the row (no lanes to reject it: legacy, morph and shared structures only), or a solve. Lines are
// counted apart (the line sign form). An estimate of work removed, not a timing.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const si = argv.indexOf('--size');
const N = si >= 0 ? +argv[si + 1] : 512;
const files = argv.filter((a, i) => !(a === '--size' || argv[i - 1] === '--size'));
if (!files.length) files.push(path.join(ROOT, 'examples/tiger.svg'));
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
const M = await import('../../src/bundle/layout.js');
const { fillShapes } = await import('../../test/_glslEmu.mjs');
const TEX_W = 4096,
  f32 = Math.fround;

for (const f of files) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const shapes = fillShapes(b, parseMetaBin, M).filter((sh) => sh.GD[3] >= 1);
  const vb = b.viewBox || [0, 0, 1, 1];
  const px = N / Math.max(vb[2], vb[3]);
  const T = {
    line: 0,
    quadRight: 0,
    quadSolve: 0,
    cubicRight: 0,
    cubicRow: 0,
    cubicSolve: 0,
    arcRight: 0,
    arcSolve: 0,
  };
  let pixels = 0;
  for (const sh of shapes) {
    const g = sh.GD[1] * TEX_W + sh.GD[0],
      bandsY = sh.GD[3] + 1;
    const at = (t, c) => band[(g + t) * 4 + c];
    const bbH =
      sh.bb[3] - sh.bb[1] > 0
        ? sh.bb[3] - sh.bb[1]
        : sh.bb[2] - sh.bb[0] > 0
          ? sh.bb[2] - sh.bb[0]
          : 1;
    const i0 = Math.floor((sh.bb[0] - vb[0]) * px) - 1,
      i1 = Math.ceil((sh.bb[2] - vb[0]) * px) + 1;
    const j0 = Math.floor((sh.bb[1] - vb[1]) * px) - 1,
      j1 = Math.ceil((sh.bb[3] - vb[1]) * px) + 1;
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) {
        const cx = f32(vb[0] + (i + 0.5) / px),
          cy = f32(vb[1] + (j + 0.5) / px);
        pixels++;
        const by = Math.min(bandsY - 1, Math.max(0, Math.floor(((cy - sh.bb[1]) / bbH) * bandsY)));
        const slot = by * 2,
          n = [0, 1, 2, 3].map((c) => at(slot, c) | 0),
          arr = at(slot + 1, 0) | 0;
        const lanes = ((at(slot + 1, 1) | 0) & 1) !== 0;
        for (let t = 0, k = 0; t < 4; t++)
          for (let e = 0; e < n[t]; e++, k++) {
            const o = (g + arr + k) * 4;
            if (band[o + 1] < cx) {
              k += n[t] - e - 1;
              break;
            }
            if (lanes && (f32(band[o + 3] - cy) < 0 || f32(band[o + 2] - cy) >= 0)) continue;
            const L = band[o] | 0,
              C = (q, c) => curve[(L + q) * 4 + c];
            if (t === 0) {
              T.line++;
              continue;
            }
            if (t === 1) {
              Math.min(C(1, 0), C(1, 2), C(2, 0)) - cx > 0 ? T.quadRight++ : T.quadSolve++;
              continue;
            }
            if (t === 2) {
              const ys = [C(1, 1), C(1, 3), C(2, 1), C(2, 3)].map((v) => f32(v - cy));
              if (Math.min(...ys) >= 0 || Math.max(...ys) < 0) {
                T.cubicRow++;
                continue;
              }
              Math.min(C(1, 0), C(1, 2), C(2, 0), C(2, 2)) - cx > 0
                ? T.cubicRight++
                : T.cubicSolve++;
              continue;
            }
            const d1 = [C(1, 0), C(1, 1), C(1, 2), C(1, 3)],
              phi = C(2, 2);
            const lo =
              d1[0] - (Math.abs(Math.cos(phi) * d1[2]) + Math.abs(Math.sin(phi) * d1[3])) - cx;
            lo > 4 * 1.2e-7 * (Math.abs(d1[0]) + Math.abs(d1[2]) + Math.abs(d1[3]))
              ? T.arcRight++
              : T.arcSolve++;
          }
      }
  }
  const per = (k) => (k / pixels).toFixed(3);
  console.log(
    `\n${path.basename(f)} @${N} px: ${shapes.length} fill shapes, ${pixels} shape-pixels; per pixel walk:`,
  );
  console.log(`  lines ${per(T.line)}`);
  console.log(`  quads  right ${per(T.quadRight)}  solve ${per(T.quadSolve)}`);
  console.log(
    `  cubics right ${per(T.cubicRight)}  row-miss ${per(T.cubicRow)}  solve ${per(T.cubicSolve)}`,
  );
  console.log(`  arcs   right ${per(T.arcRight)}  solve ${per(T.arcSolve)}`);
  const sh = T.quadRight + T.cubicRight + T.cubicRow + T.arcRight,
    all = sh + T.quadSolve + T.cubicSolve + T.arcSolve;
  console.log(
    `  curve entries answered without a solve: ${all ? ((100 * sh) / all).toFixed(1) : '0.0'}% of ${per(all)}`,
  );
}
