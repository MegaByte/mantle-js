// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// skipRate — how many band entries the ray-lane reject takes off each fill walk, per PIXEL, on the CPU.
//
//   node probes/rayLanes/skipRate.mjs [--size 512] a.svg b.svg ...      (default: examples/tiger.svg)
//
// Every pixel center of an N-pixel raster of the drawing (its viewBox fitted, aspect kept) inside each fill
// shape's bbox plus a pixel -- roughly its cover quad -- is walked the way each kernel walks it, and the entries
// that pass the break are counted, with the ones the lanes reject:
//   Slug H / V   hitTest/bandWinding.js, the shader's port, with its own counters;
//   band-hard    the H stripe list at c.y, break at maxX < c.x, rejected by rayLaneMiss;
//   AAC          the pair list of the cell's top stripe, break at maxX * px < c.x * px - 0.5, rejected by
//                aacLaneMiss over the whole cell -- the one-walk case, which is every pixel where a stripe pair
//                is taller than a pixel; the pixels that straddle more (walked per stripe, or through a level)
//                are counted apart and not modelled.
// An estimate of work removed, not a timing: a rejected entry skips its control fetch and all its math, but
// the fraction of frame time that is depends on the kernel and the GPU (time it with probes/shaderArmAB.mjs
// and probes/rayLanes/noRayReject.arms.json).
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
const { bandFillCoverage } = await import('../../src/hitTest/bandWinding.js');
const { fillShapes } = await import('../../test/_glslEmu.mjs');
const TEX_W = 4096;

for (const f of files) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const shapes = fillShapes(b, parseMetaBin, M).filter((sh) => sh.GD[3] >= 1);
  const vb = b.viewBox || [0, 0, 1, 1];
  const px = N / Math.max(vb[2], vb[3]); // pixels per em
  const slug = {
    test: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    skip: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  };
  const hard = { test: 0, skip: 0 },
    aac = { test: 0, skip: 0, pixels: 0, straddle: 0 };
  let pixels = 0;
  for (const sh of shapes) {
    const g = sh.GD[1] * TEX_W + sh.GD[0],
      bandsY = sh.GD[3] + 1;
    const at = (t, c) => band[(g + t) * 4 + c];
    const lanes = ((at(1, 1) | 0) & 1) !== 0;
    const bbH =
      sh.bb[3] - sh.bb[1] > 0
        ? sh.bb[3] - sh.bb[1]
        : sh.bb[2] - sh.bb[0] > 0
          ? sh.bb[2] - sh.bb[0]
          : 1;
    const pair = (b.flags & 8) !== 0;
    const i0 = Math.floor((sh.bb[0] - vb[0]) * px) - 1,
      i1 = Math.ceil((sh.bb[2] - vb[0]) * px) + 1;
    const j0 = Math.floor((sh.bb[1] - vb[1]) * px) - 1,
      j1 = Math.ceil((sh.bb[3] - vb[1]) * px) + 1;
    // a band list's entries past the break, and how many a reject takes
    const walk = (slot, brk, miss, acc) => {
      const n = [0, 1, 2, 3].map((c) => at(slot, c) | 0),
        arr = at(slot + 1, 0) | 0;
      for (let t = 0, k = 0; t < 4; t++)
        for (let i = 0; i < n[t]; i++, k++) {
          const e = (g + arr + k) * 4;
          if (brk(band[e + 1])) {
            k += n[t] - i - 1;
            break;
          }
          acc.test++;
          if (lanes && miss(band[e + 2], band[e + 3])) acc.skip++;
        }
    };
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) {
        const cx = vb[0] + (i + 0.5) / px,
          cy = vb[1] + (j + 0.5) / px;
        pixels++;
        bandFillCoverage(band, curve, sh.GD, sh.bb, cx, cy, px, px, sh.eo, { stats: slug });
        const by = Math.min(bandsY - 1, Math.max(0, Math.floor(((cy - sh.bb[1]) / bbH) * bandsY)));
        walk(
          by * 2,
          (brk) => brk < cx,
          (z, w) => w - cy < 0 || z - cy >= 0,
          hard,
        );
        // AAC: the cell [cy - hy, cy + hy]; one pair walk when it lies inside stripes {b0, b0 + 1}
        const hy = 0.5 / px,
          b0 = Math.min(bandsY - 1, Math.max(0, Math.floor(((cy - hy - sh.bb[1]) / bbH) * bandsY)));
        const b1 = Math.min(
          bandsY - 1,
          Math.max(0, Math.floor(((cy + hy - sh.bb[1]) / bbH) * bandsY)),
        );
        if (pair ? b1 > b0 + 1 : b1 !== b0) {
          aac.straddle++;
          continue;
        }
        aac.pixels++;
        walk(
          b0 * 2,
          (brk) => brk * px < cx * px - 0.5,
          (z, w) => {
            const a = (z - cy) * px + 0.5,
              c = (w - cy) * px + 0.5;
            return Math.max(a, c) < -(2 ** -20) || Math.min(a, c) > 1 + 2 ** -20;
          },
          aac,
        );
      }
  }
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const per = (k, n) => (n ? (k / n).toFixed(2) : '0');
  const line = (name, t, k, n) =>
    console.log(
      `  ${name.padEnd(10)} ${per(t, n).padStart(6)} entries/walk past the break, ${per(k, n).padStart(6)} rejected (${t ? ((100 * k) / t).toFixed(1) : '0.0'}%)`,
    );
  console.log(
    `\n${path.basename(f)} @${N} px: ${shapes.length} fill shapes, ${pixels} shape-pixels${b.flags & 8 ? ', pair bands' : ''}`,
  );
  line('Slug H', sum(slug.test[0]), sum(slug.skip[0]), pixels);
  line('Slug V', sum(slug.test[1]), sum(slug.skip[1]), pixels);
  for (let t = 0; t < 4; t++)
    if (slug.test[0][t] + slug.test[1][t])
      console.log(
        `    ${['line', 'quad', 'cubic', 'arc'][t].padEnd(6)} H ${per(slug.skip[0][t], pixels)}/${per(slug.test[0][t], pixels)}   V ${per(slug.skip[1][t], pixels)}/${per(slug.test[1][t], pixels)} per walk`,
      );
  line('band-hard', hard.test, hard.skip, pixels);
  line('AAC', aac.test, aac.skip, aac.pixels);
  console.log(`  (AAC: ${aac.pixels} one-walk pixels modelled, ${aac.straddle} straddling not)`);
}
