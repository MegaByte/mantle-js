// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbConvexArcSmoke — a static build's CONVEX cubic piece carries its arc in a face's chain, as a concave one does.
//
// A hull chain gives a convex piece its CONTROL POLYGON for a chain: on the air side of the arc, so no face cuts ink with
// a chord, but it carries no arc -- every face along the piece clips its pixels against the polygon and over-paints where
// the polygon stands off the arc, and the polygon's four points leave a face at a spike's tip no room for both flanks.
//   (a) a 32-spike star, one cubic a spike, at 256 px: nearly every chain face carries an arc (none with the hull chain,
//       the TEST HOOK `__LB_STATIC_HULL`), and fewer pixels are off the exact box filter by more than 32/255;
//   (b) a convex-cubic onion (probes/lbAccuracy/_convexArcOnion.svg) at 512 px: under half as many pixels off by more than
//       32/255 with the arc chain as with the hull chain.
import { readFileSync } from 'fs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const REF = await import('../probes/lbAccuracy/_lbAaRef.mjs');
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

/// Per listed shape (all when `only` is null) of the drawing, on the drawing's own raster: pixels off the exact box
/// filter by more than 32/255, and the interior faces that carry a chain (sentinel > 1.5) and an arc (> 3.5).
async function audit(svgText, N, hooks, only = null) {
  globalThis.__MANTLE_DEBUG__ = true;
  Object.assign(globalThis, hooks);
  try {
    const bundle = await importSvg(svgText, { preserveViewport: true });
    const { shapes, bbox } = await R.shapesOf(bundle);
    const view = R.viewOf(bbox, N);
    const { rowSpans, contoursToConverter, closed } = await REF.refKit();
    let off = 0,
      faces = 0,
      arcs = 0;
    for (const sh of shapes) {
      if (only && !only.includes(sh.s)) continue;
      const b = await R.buildMesh(sh);
      if (!b) continue;
      const v = b.pk.verts,
        nv = b.pk.vertexCount,
        VF = v.length / nv;
      for (let t = 0; t + 2 < nv; t += 3) {
        if (Math.round(v[(t + 2) * VF + 5]) !== 0) continue;
        const s = v[(t + 2) * VF + 2];
        if (s > 1.5) {
          faces++;
          if (s > 3.5) arcs++;
        }
      }
      const acc = new Float64Array(N * N).fill(1);
      R.rasterMesh(b.pk, view, acc, {});
      const curves = closed(contoursToConverter(sh.contours, null));
      for (let j = 0; j < N; j++) {
        const rc = new Map();
        for (let i = 0; i < N; i++) {
          const d =
            1 - acc[j * N + i] - REF.exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, rc);
          if (Math.abs(d) > 32 / 255) off++;
        }
      }
    }
    return { off, faces, arcs };
  } finally {
    for (const k of Object.keys(hooks)) delete globalThis[k];
    delete globalThis.__MANTLE_DEBUG__;
  }
}

console.log('-- (a) a star of convex cubic spikes carries its arcs');
{
  const P = (r, a) => `${(64 + r * Math.cos(a)).toFixed(4)} ${(64 + r * Math.sin(a)).toFixed(4)}`;
  let d = '';
  for (let i = 0; i < 32; i++) {
    const a0 = (2 * Math.PI * i) / 32,
      a1 = (2 * Math.PI * (i + 1)) / 32,
      am = (a0 + a1) / 2,
      w = (a1 - a0) * 0.35;
    d += (i ? ' ' : 'M' + P(40, a0)) + ` C${P(60, am - w)} ${P(60, am + w)} ${P(40, a1)}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><path d="${d} Z"/></svg>`;
  const hull = await audit(svg, 256, { __LB_STATIC_HULL: true }),
    arc = await audit(svg, 256, {});
  ok(
    hull.arcs === 0 && arc.faces > 50 && arc.arcs * 10 >= arc.faces * 9,
    `${arc.arcs} of ${arc.faces} chain faces carry an arc (${hull.arcs} of ${hull.faces} with the static hull chain)`,
  );
  ok(
    hull.off > 0 && arc.off < hull.off,
    `pixels off the exact box filter by more than 32/255: ${hull.off} -> ${arc.off}`,
  );
}

console.log('-- (b) a convex-cubic onion');
{
  const svg = readFileSync(
    new URL('../probes/lbAccuracy/_convexArcOnion.svg', import.meta.url),
    'utf8',
  );
  const hull = await audit(svg, 512, { __LB_STATIC_HULL: true }),
    arc = await audit(svg, 512, {});
  ok(
    arc.off * 2 < hull.off && arc.arcs > arc.faces / 3,
    `pixels off by more than 32/255: ${hull.off} -> ${arc.off} (${arc.arcs} of ${arc.faces} chain faces carry an arc)`,
  );
}

console.warn = warn;
console.log(fail ? `\n${fail} FAILED` : '\nlbConvexArcSmoke: PASS');
process.exit(fail ? 1 : 0);
