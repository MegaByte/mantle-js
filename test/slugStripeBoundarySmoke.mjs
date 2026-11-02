// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugStripeBoundarySmoke — a ray lying exactly on a band stripe boundary finds every crossing.
//
// THE HAZARD. A walker takes its stripe as (c - bb) / size * bands, in float32 from the META box; the encoder forms the
// boundaries in float64 from the box it is handed. The two disagree by a few float32 ulps of the box, so if the encoder
// listed a segment only where its extent reached a boundary, a ray exactly ON one -- a row or column through a vertex,
// where the box divides evenly -- would go to a stripe whose list lacks the segment that counts the crossing there (the
// shared-endpoint rule gives it to one side only). noAaStrokeCover__grid_N_8_0's circles are quads meeting at their top,
// bottom, left and right points, and the center column and row of each fall on boundaries: the vertical ray would lose
// both crossings, the winding read 0 inside the circle, and at a few pixels Slug read 0 where the pixel is wholly inside
// -- at every scale; the hard band kernel 0 along the center row.
//
// The encoder lists every segment within 64 float32 ulps of a stripe (of the box's coordinates and size: relative,
// the same at any scale; src/svg/textures.js bandPadX/Y).
//
// The kernels run from the shipped text in float32 (test/_glslEmu.mjs), on the importer's bands, against the exact box
// coverage (probes/fillperf/cellCoverage.mjs) and the exact inside test (src/hitTest/fillCoverage.js pointInFill):
// (a) every circle's center column and center row, at 3 px and 48 px a circle, at 2^-20, 1 and 2^20: Slug within 0.125 of
//     the exact coverage, the hard kernel the exact answer at the pixel center;
// (b) structurally, every segment with an end on a boundary (the shader's own float32 stripe coordinate an integer there)
//     is listed in both stripes that meet there, H and V.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const importSvg = (await import('../src/svg/importer.js')).default;
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');
const { cellCoverage } = await import('../probes/fillperf/cellCoverage.mjs');
const f = Math.fround;

const RAW = readFileSync(path.join(ROOT, 'examples/smoke/noAaStrokeCover__grid_N_8_0.svg'), 'utf8');
const wrap = (S) =>
  S === 1
    ? RAW
    : RAW.replace(/viewBox="0 0 512 512"/, `viewBox="0 0 ${512 * S} ${512 * S}"`)
        .replace(/(<svg\b[^>]*>)/, `$1<g transform="scale(${S})">`)
        .replace(/<\/svg>\s*$/, '</g></svg>');
const emu = EMU.buildGlslEmu(ROOT, {
  defines: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_HARD'],
});

// ---- (a) the center columns and rows -----------------------------------------------------------------------------------
for (const S of [2 ** -20, 1, 2 ** 20]) {
  const b = await importSvg(wrap(S), { preserveViewport: true });
  const band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const shapes = EMU.fillShapes(b, parseMetaBin, M).filter((sh) => sh.GD[3] >= 1);
  const qs = [],
    ref = [];
  for (const sh of shapes) {
    const segs = decodeSegs(curve, sh.range.begin, sh.range.end);
    const cx = (sh.bb[0] + sh.bb[2]) / 2,
      cy = (sh.bb[1] + sh.bb[3]) / 2,
      ext = sh.bb[2] - sh.bb[0];
    for (const e of [ext / 3, ext / 48])
      for (let k = 1; k < 24; k++) {
        const o = (k / 24 - 0.5) * (ext - 2 * e) + 0.013 * e; // across the shape, off every vertex row
        for (const c of [
          [f(cx), f(cy + o)],
          [f(cx + o), f(cy)],
        ]) {
          for (const k2 of [EMU.K_SLUG, EMU.K_HARD])
            qs.push({ k: k2, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [f(e), f(e)] });
          ref.push({
            cov: cellCoverage(segs, c, [f(e), f(e)], sh.eo),
            inside: pointInFill(segs, c[0], c[1], sh.eo) ? 1 : 0,
          });
        }
      }
  }
  const out = emu.run(band, curve, qs);
  let sBad = 0,
    sMax = 0,
    hBad = 0,
    first = '';
  ref.forEach((r, i) => {
    const s = out[2 * i],
      h = out[2 * i + 1],
      d = Math.abs(s - r.cov);
    sMax = Math.max(sMax, d);
    if (d > 0.125) {
      sBad++;
      if (!first)
        first = ` -- first (${qs[2 * i].c}) slug ${s.toFixed(3)}, exact ${r.cov.toFixed(3)}`;
    }
    if (h !== r.inside) hBad++;
  });
  ok(
    ref.length > 1000 && sBad === 0 && hBad === 0,
    `(a) at 2^${Math.log2(S)}: ${ref.length} pixels on the circles' center columns and rows: Slug ${sBad} off the exact coverage by over 0.125 (worst ${sMax.toFixed(3)}), the hard kernel ${hBad} off the exact inside test${first}`,
  );
}

// ---- (b) every segment ending on a boundary is listed on both sides of it ----------------------------------------------
{
  const b = await importSvg(RAW, { preserveViewport: true });
  const band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const shapes = EMU.fillShapes(b, parseMetaBin, M).filter((sh) => sh.GD[3] >= 1);
  let checked = 0,
    missing = 0,
    first = '';
  for (const sh of shapes) {
    const [gx, gy, mx, my] = sh.GD,
      bandsX = mx + 1,
      bandsY = my + 1,
      g = gy * 4096 + gx;
    const bb = sh.bb.map(f),
      w = f(bb[2] - bb[0]),
      hgt = f(bb[3] - bb[1]);
    const list = (slot) => {
      const n = [0, 1, 2, 3].map((c) => band[(g + slot) * 4 + c] | 0),
        arr = band[(g + slot + 1) * 4] | 0,
        out = new Set();
      for (let k = 0; k < n[0] + n[1] + n[2] + n[3]; k++) out.add(band[(g + arr + k) * 4] | 0);
      return out;
    };
    // the pair bands' H lists cover stripes {b, b+1}: a boundary k is inside list k-1's pair, and list k starts at it
    const hList = (k) => list(k * 2),
      vList = (k) => list((bandsY + k) * 2);
    // every segment any list holds, its ends read from its record (a line's texel 1 holds both; a quad's and a cubic's
    // start in texel 1 and end in texel 2; an arc stores its ends in texel 3)
    const locs = new Set();
    for (let k = 0; k < bandsY; k++) for (const l of hList(k)) locs.add(l);
    for (let k = 0; k < bandsX; k++) for (const l of vList(k)) locs.add(l);
    for (const loc of locs) {
      const ty = curve[loc * 4] & 3,
        t = (j, c) => curve[(loc + j) * 4 + c];
      const ends =
        ty === 0
          ? [
              [t(1, 0), t(1, 1)],
              [t(1, 2), t(1, 3)],
            ]
          : ty === 1
            ? [
                [t(1, 0), t(1, 1)],
                [t(2, 0), t(2, 1)],
              ]
            : ty === 2
              ? [
                  [t(1, 0), t(1, 1)],
                  [t(2, 2), t(2, 3)],
                ]
              : [
                  [t(3, 0), t(3, 1)],
                  [t(3, 2), t(3, 3)],
                ];
      for (const p of ends) {
        const ux = f(f(f(p[0] - bb[0]) / w) * bandsX),
          uy = f(f(f(p[1] - bb[1]) / hgt) * bandsY);
        for (const [u, n, L, ax] of [
          [ux, bandsX, vList, 'V'],
          [uy, bandsY, hList, 'H'],
        ]) {
          if (!(Number.isInteger(u) && u > 0 && u < n)) continue;
          checked++;
          for (const k of [u - 1, u])
            if (!L(k).has(loc)) {
              missing++;
              if (!first)
                first = ` -- first a ${['line', 'quad', 'cubic', 'arc'][ty]} ending at (${p}), not in ${ax} stripe ${k}`;
            }
        }
      }
    }
  }
  ok(
    checked > 50 && missing === 0,
    `(b) ${checked} segment ends on a stripe boundary: ${missing} missing from a stripe that meets there${first}`,
  );
}
console.log(fail ? `SLUG-STRIPE-BOUNDARY FAIL (${fail})` : 'SLUG-STRIPE-BOUNDARY PASS');
process.exit(fail ? 1 : 0);
