// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnRetracedPieceSmoke — GWN+SDF paints no coverage ramp across a piece traced back along itself.
//
// WHY. A per-contour ink side takes a contour's winding step as one: crossing it moves the winding by exactly one. A
// piece traced back along itself -- the closing line of an open `M a L b` fill (a zero-area shape, what a pattern child
// can be), a spike drawn out and back, two contours sharing an edge in opposite directions -- is crossed twice and the
// steps cancel, so both of its sides carry one winding. Read as a boundary, it gets the single-plane ramp painted across
// it: up to 0.50 on a zero-area fill whose exact coverage is 0, and a seam down a shared edge inside solid ink.
//
// SO each piece's ink side is read from the exact winding a hair to each side of it (textures.js; at t = 1/2, and at
// 1/4 and 3/4 where another curve can cross it): a retraced piece has the same winding on both sides, so it is not a
// boundary (sigma 0: its winding is counted, no ramp is painted).
//
// The kernel runs from the shipped text in float32 (test/_glslEmu.mjs, MANTLE_GWN + MANTLE_GWN_SDF, importSvg with the
// run tree), against the exact box coverage (probes/fillperf/cellCoverage.mjs), at 2^-20, 1 and 2^20:
// (a) an open `M a L b` fill, horizontal and slanted, and a spike out and back: every pixel along it reads 0 -- to the
//     float32 rounding of the exact pass, which takes the pixels its two coincident pieces both reach (3.5e-6, the same
//     at every scale);
// (b) two squares sharing an edge in opposite directions (nonzero): the pixels straddling the shared edge read 1;
// (c) a shape with no retraced piece is untouched: a ring and a star read the exact coverage within the kernel's own
//     error;
// (d) two different curves sharing their ends -- lenses of quads, arcs and cubics -- are not a retrace: they keep their
//     ramps (a match on the ends and the chord midpoint would take them for one, moving the lenses' mean error from
//     0.00044 to 0.0101).
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
const { cellCoverage } = await import('../probes/fillperf/cellCoverage.mjs');
const emu = EMU.buildGlslEmu(ROOT, { defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] });
const f = Math.fround;

/// Every pixel of a 64 px raster of the drawing over a shape's box and two pixels: the kernel's answer and the exact one.
async function run(body, S) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${64 * S} ${64 * S}"><g transform="scale(${S})">${body}</g></svg>`;
  const b = await importSvg(svg, { preserveViewport: true, gwnTree: true });
  const band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const shapes = EMU.fillShapes(b, parseMetaBin, M).filter((sh) => sh.tree);
  const qs = [],
    ex = [],
    e = f(S);
  for (const sh of shapes) {
    const segs = decodeSegs(curve, sh.range.begin, sh.range.end);
    for (let y = Math.floor(sh.bb[1] / S) - 2; y <= Math.ceil(sh.bb[3] / S) + 2; y++)
      for (let x = Math.floor(sh.bb[0] / S) - 2; x <= Math.ceil(sh.bb[2] / S) + 2; x++) {
        const c = [f((x + 0.5) * S), f((y + 0.5) * S)];
        qs.push({ k: EMU.K_GWN, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [e, e] });
        ex.push(cellCoverage(segs, c, [e, e], sh.eo));
      }
  }
  return { got: emu.run(band, curve, qs), ex, n: shapes.length };
}

for (const S of [2 ** -20, 1, 2 ** 20]) {
  const tag = `2^${Math.log2(S)}`;
  // ---- (a) zero-area fills ----
  {
    let n = 0,
      worst = 0,
      exMax = 0,
      shapes = 0;
    for (const body of [
      '<path d="M8 20.5 L56 20.5"/>',
      '<path d="M8.3 12.1 L51.7 49.9"/>',
      '<path d="M10 40 L40 10 L10 40"/>',
    ]) {
      const r = await run(body, S);
      shapes += r.n;
      for (let i = 0; i < r.got.length; i++) {
        n++;
        worst = Math.max(worst, r.got[i]);
        exMax = Math.max(exMax, Math.abs(r.ex[i]));
      }
    }
    ok(
      shapes === 3 && n > 300 && worst < 1e-5 && exMax < 1e-9,
      `(a) at ${tag}: open "M a L b" fills and a spike, ${n} pixels: the kernel reads up to ${worst.toExponential(2)} (exact ${exMax.toExponential(1)})`,
    );
  }
  // ---- (b) a shared edge inside solid ink ----
  {
    const r = await run('<path d="M10.3 10.3 H32 V50.1 H10.3 Z M32 10.3 H53.7 V50.1 H32 Z"/>', S);
    let seam = 0,
      n = 0;
    for (let i = 0; i < r.got.length; i++)
      if (r.ex[i] === 1) {
        n++;
        if (r.got[i] < 1 - 1 / 510) seam++;
      }
    ok(
      n > 500 && seam === 0,
      `(b) at ${tag}: two squares sharing an edge, ${n} wholly inside pixels: ${seam} read under 1`,
    );
  }
  // ---- (c) untouched shapes ----
  {
    let n = 0,
      err = 0,
      worst = 0;
    for (const body of [
      '<path fill-rule="evenodd" d="M4 32 A28 28 0 1 1 60 32 A28 28 0 1 1 4 32 Z M16 32 A16 12 30 1 0 48 32 A16 12 30 1 0 16 32 Z"/>',
      '<path d="M32 4 L39 24 L60 24 L43 37 L50 58 L32 45 L14 58 L21 37 L4 24 L25 24 Z"/>',
    ]) {
      const r = await run(body, S);
      for (let i = 0; i < r.got.length; i++) {
        const d = Math.abs(r.got[i] - r.ex[i]);
        n++;
        err += d;
        worst = Math.max(worst, d);
      }
    }
    ok(
      n > 3000 && worst < 0.2 && err / n < 0.01,
      `(c) at ${tag}: a ring and a star, ${n} pixels: mean |err| ${(err / n).toFixed(5)}, worst ${worst.toFixed(3)}`,
    );
  }
  // ---- (d) two DIFFERENT curves sharing their ends are not a retrace ----
  // (the first match compared ends and the CHORD midpoint, which a lens's two quads share: its whole ink lost its ramp)
  {
    let n = 0,
      err = 0,
      worst = 0;
    for (const body of [
      '<path d="M8 32 Q32 8 56 32 Q32 56 8 32 Z"/>',
      '<path d="M8 32 A30 22 0 0 1 56 32 A30 22 0 0 1 8 32 Z"/>',
      '<path d="M8 32 C20 10 44 10 56 32 C44 54 20 54 8 32 Z"/>',
      '<path fill-rule="evenodd" d="M8 32 Q32 8 56 32 Q32 56 8 32 Z M20 32 Q32 22 44 32 Q32 42 20 32 Z"/>',
    ]) {
      const r = await run(body, S);
      for (let i = 0; i < r.got.length; i++) {
        const d = Math.abs(r.got[i] - r.ex[i]);
        n++;
        err += d;
        worst = Math.max(worst, d);
      }
    }
    // The bar is the MEAN: the kernel's corner model reads a lens's tips up to 0.417 off either way, while a
    // chord-midpoint match would move the mean from 0.00044 to 0.0101.
    ok(
      n > 3000 && err / n < 0.002,
      `(d) at ${tag}: lenses of quads, arcs and cubics, and a holed lens, ${n} pixels: mean |err| ${(err / n).toFixed(5)} (bar 0.002), worst ${worst.toFixed(3)}`,
    );
  }
}
console.log(fail ? `GWN-RETRACED-PIECE FAIL (${fail})` : 'GWN-RETRACED-PIECE PASS');
process.exit(fail ? 1 : 0);
