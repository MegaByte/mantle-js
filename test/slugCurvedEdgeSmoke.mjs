// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugCurvedEdgeSmoke — the default fill kernel's edge coverage against the exact box coverage.
//
// A two-ray coverage estimate errs on the pixels between its rays (corner pixels, then the chord's lens) on curved and straight
// edges alike, and no model built on two rays can see what lies between them, so renderFill is the exact walk itself (AAC's).
// Measured against the exact f64 box coverage (probes/fillperf/cellCoverage.mjs) over every pixel the boundary
// crosses (0 < exact < 1); the kernel side is the SHIPPED shader text in float32 (test/_glslEmu.mjs), the default
// program's (renderFill, no MANTLE_AAC) beside AAC's.
//   (a) straight edges at any angle are exact: every boundary pixel of a 45-degree diamond and a tilted quad farther
//       than 1.5 px from a vertex reads the exact coverage to 1e-5, at 8-128 px (a two-ray estimate is 0.02-0.08 off at
//       the corner pixels);
//   (b) on the disc, the bowl and the S (each P px across), the default kernel's mean error is under 1e-5 at every size
//       from 8 to 128 px, as AAC's is (a two-ray estimate reads 1e-3 to 4e-2 at 8 px);
//   (c) the ink: at one to three pixels a glyph the default kernel's total ink is within 0.1% of the exact area (a two-ray
//       estimate is tens of percent off at glyph size), and at 64 px within 0.01%.
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_SLUG, K_AAC } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP slugCurvedEdgeSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { cellCoverage } = await import('../probes/fillperf/cellCoverage.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const ARMS = {
  slug: { defs: [], k: K_SLUG },
  aac: { defs: ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'], k: K_AAC },
};
for (const a of Object.values(ARMS)) a.emu = buildGlslEmu(ROOT, { defines: a.defs });

const wrap = (d, eo) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path ${eo ? 'fill-rule="evenodd" ' : ''}d="${d}" fill="#000"/></svg>`;
const CURVED = {
  bowl: wrap('M 500 180 a 260 320 0 1 0 0.1 0 Z M 500 330 a 140 170 0 1 1 -0.1 0 Z', true),
  disc: wrap('M 500 180 a 320 320 0 1 0 0.1 0 Z'),
  ess: wrap(
    'M 700 300 C 700 150 300 150 300 330 C 300 470 700 470 700 640 C 700 830 300 830 300 680 L 380 660 C 400 740 620 740 620 640 C 620 540 240 540 240 340 C 240 110 760 110 760 300 Z',
  ),
};
const STRAIGHT = {
  diamond: [
    [500, 150],
    [850, 500],
    [500, 850],
    [150, 500],
  ],
  tilt: [
    [500, 150],
    [830, 400],
    [580, 820],
    [170, 560],
  ],
};

const loaded = new Map();
async function load(svg) {
  if (loaded.has(svg)) return loaded.get(svg);
  const b = await importSvg(svg, { preserveViewport: true });
  const shapes = fillShapes(b, parseMetaBin, M),
    curve = new Float32Array(b.curves);
  for (const sh of shapes) sh.segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  const r = { shapes, band: new Float32Array(b.bands), curve };
  loaded.set(svg, r);
  return r;
}
/// Every pixel of the drawing P px across (its larger extent; the grid on its box's corner): each arm's value and the
/// exact coverage. `keep(c, px)` picks the pixels.
async function measure(svg, P, keep = null) {
  const { shapes, band, curve } = await load(svg);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of shapes) {
    x0 = Math.min(x0, s.bb[0]);
    y0 = Math.min(y0, s.bb[1]);
    x1 = Math.max(x1, s.bb[2]);
    y1 = Math.max(y1, s.bb[3]);
  }
  const px = Math.max(x1 - x0, y1 - y0) / P,
    rows = [];
  let inkRef = 0;
  const ink = { slug: 0, aac: 0 };
  for (const sh of shapes) {
    const i0 = Math.floor((sh.bb[0] - x0) / px) - 2,
      i1 = Math.ceil((sh.bb[2] - x0) / px) + 2;
    const j0 = Math.floor((sh.bb[1] - y0) / px) - 2,
      j1 = Math.ceil((sh.bb[3] - y0) / px) + 2;
    const qs = [],
      ex = [];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = [x0 + (i + 0.5) * px, y0 + (j + 0.5) * px];
        const e = cellCoverage(sh.segs, c, [px, px], sh.eo);
        inkRef += e;
        qs.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [px, px] });
        ex.push(e);
      }
    const out = {};
    for (const [k, a] of Object.entries(ARMS))
      out[k] = a.emu.run(
        band,
        curve,
        qs.map((q) => ({ ...q, k: a.k })),
      );
    for (let m = 0; m < qs.length; m++) {
      for (const k of Object.keys(ARMS)) ink[k] += Math.min(1, Math.max(0, out[k][m]));
      if (ex[m] > 1e-9 && ex[m] < 1 - 1e-9 && (!keep || keep(qs[m].c, px)))
        rows.push({ ex: ex[m], slug: out.slug[m], aac: out.aac[m] });
    }
  }
  const mean = (k) => rows.reduce((s, r) => s + Math.abs(r[k] - r.ex), 0) / rows.length;
  const max = (k) => rows.reduce((s, r) => Math.max(s, Math.abs(r[k] - r.ex)), 0);
  return {
    n: rows.length,
    slug: mean('slug'),
    aac: mean('aac'),
    slugMax: max('slug'),
    inkPct: { slug: 100 * (ink.slug / inkRef - 1), aac: 100 * (ink.aac / inkRef - 1) },
  };
}
const SIZES = [8, 16, 32, 64, 128];

// ---- (a) straight edges ------------------------------------------------------------------------------------------
{
  let n = 0,
    worst = 0,
    where = '';
  for (const [name, pts] of Object.entries(STRAIGHT)) {
    const svg = wrap('M ' + pts.map((p) => p.join(' ')).join(' L ') + ' Z');
    for (const P of SIZES) {
      // farther than 1.5 px from every vertex: a vertex is two edges, which no two-crossing model is
      const r = await measure(svg, P, (c, px) =>
        pts.every((v) => Math.hypot(v[0] - c[0], v[1] - c[1]) > 1.5 * px),
      );
      n += r.n;
      if (r.slugMax > worst) {
        worst = r.slugMax;
        where = `${name}@${P}`;
      }
    }
  }
  ok(
    n > 1000 && worst < 1e-5,
    `(a) straight edges at 45 degrees and tilted are exact at 8-128 px: ${n} boundary pixels off the vertices, worst |slug - exact| ${worst.toExponential(1)}${where ? ` (${where})` : ''}`,
  );
}

// ---- (b) curved edges --------------------------------------------------------------------------------------------
{
  const rows = [];
  for (const [name, svg] of Object.entries(CURVED))
    for (const P of SIZES) rows.push({ name, P, ...(await measure(svg, P)) });
  console.log('     mean |err| against the exact box coverage (slug / aac):');
  for (const name of Object.keys(CURVED))
    console.log(
      `       ${name.padEnd(5)} ` +
        rows
          .filter((r) => r.name === name)
          .map((r) => `@${r.P} ${r.slug.toExponential(1)} / ${r.aac.toExponential(1)}`)
          .join('   '),
    );
  const at = (name, P) => rows.find((r) => r.name === name && r.P === P);
  ok(
    rows.every((r) => r.slug < 1e-5),
    `(b) the default kernel's mean error is under 1e-5 on all three at 8-128 px (worst ${Math.max(...rows.map((r) => r.slug)).toExponential(1)})`,
  );
  ok(
    rows.every((r) => r.aac < 1e-5),
    `(b) ...as AAC's is (worst ${Math.max(...rows.map((r) => r.aac)).toExponential(1)}): its zone integrals no longer lose P^2 * 2^-24`,
  );
}

// ---- (c) the ink -------------------------------------------------------------------------------------------------
{
  const small = [],
    big = [];
  for (const [name, svg] of Object.entries(CURVED)) {
    for (const P of [1, 2, 3]) small.push({ name, P, ...(await measure(svg, P)) });
    big.push({ name, P: 64, ...(await measure(svg, 64)) });
  }
  const worstSlug = Math.max(...small.map((r) => Math.abs(r.inkPct.slug)));
  const worstAac = Math.max(...small.map((r) => Math.abs(r.inkPct.aac)));
  ok(
    worstSlug < 0.1 && worstAac < 0.1,
    `(c) at one to three pixels a glyph, the default kernel's ink is within ${worstSlug.toFixed(3)}% of the exact area (AAC's ${worstAac.toFixed(3)}%)`,
  );
  ok(
    big.every((r) => Math.abs(r.inkPct.slug) < 0.01),
    `(c) at 64 px a glyph it is within ` +
      `${Math.max(...big.map((r) => Math.abs(r.inkPct.slug))).toFixed(4)}%`,
  );
}

console.log(fail ? `slugCurvedEdgeSmoke FAIL (${fail})` : 'slugCurvedEdgeSmoke PASS');
process.exit(fail ? 1 : 0);
