// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _kernelEmuCost.mjs — Slug vs AAC as cover kernels, on the CPU: accuracy against the exact area and work per fragment.
//
//   node probes/engineSelect/_kernelEmuCost.mjs [--sizes 128,512,2048] [--assets tiger,text,lbMemBudget,<bench name>...]
//                                               [--q 60000] [--reps 3]
//
// NO GPU. Both kernels are the PACKAGE shader text compiled to float32 C++ (test/_glslEmu.mjs): renderFill (Slug) and
// renderFillAAC (with MANTLE_AAC_PAIR_BANDS where the bundle's bands are paired), run over the same fragments -- every fill row drawn as its cover quad, the pixels of
// its bbox dilated by one, at a canvas the asset is fitted to (setViewport + drawBundle fit the content box). When a
// size holds more fragments than --q, a uniform random subset of them is taken, the same one for every arm.
//
//   accuracy   against the exact box coverage of the path (probes/lbAccuracy/_lbAaRef: exact spans in x, 64 slices in
//              y), computed where either kernel answers a partial value or the two disagree; a pixel both call 0 or
//              both call 1 is taken as settled. mean |err| over the EDGE pixels (exact strictly between 0 and 1), in
//              /255; max, and the count past 0.5/255, 8/255 and 64/255, over every pixel.
//   work       texel fetches per fragment (band texture, curve texture), the emulator's own counters; and CPU
//              ns/fragment of the -O2 float32 emulator, timed INSIDE it around the query loop (buildGlslEmu `timed`:
//              timing run() from node timed the spawn and the job file and swung 2x between identical arms), over a
//              set repeated to >= 300k fragments, the query-decode baseline (a query that returns at once)
//              subtracted, min of --reps. A CPU nanosecond is not a GPU one -- a texel fetch costs the CPU an array
//              read, and a CPU has no occupancy to lose -- so read the fetch counts beside it, and the ratio between
//              arms rather than either number.
//   both       each row takes AAC when its device px^2 clears aacTypeFloor for its own segment types (the per-row
//              form of the package threshold), else Slug: what one program holding both kernels would shade. Its
//              PRESENCE cost -- the registers and size of carrying both -- is invisible here; that is the GPU's number.
//
// What this cannot say: the GPU time. It says which kernel does less work per fragment and which is more accurate, per
// asset and size, so the GPU's timing of `kernel:'slug'` against `kernel:'aac'` (_kernelDefaultAB) can be read as
// work plus presence.
import { readFileSync, existsSync } from 'fs';
import { benchNames, BENCH_UNSET } from '../../test/_assets.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const SIZES = arg('--sizes', '128,512,2048').split(',').map(Number);
const WANT = arg('--assets', ['tiger', 'text', 'lbMemBudget', ...benchNames()].join(',')).split(
  ',',
);
if (!process.argv.includes('--assets') && !benchNames().length) console.log(BENCH_UNSET);
const Q = +arg('--q', 60000),
  REPS = +arg('--reps', 3);
const TEXT = 'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow.';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const E = await import('../../test/_glslEmu.mjs');
if (!E.hasCxx()) {
  console.log('no C++ compiler: nothing to run');
  process.exit(2);
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
const M = await import('../../src/bundle/layout.js');
const { shapeSegStats } = await import('../../src/renderer/shapeStats.js');
const { aacTypeFloor } = await import('../../src/renderer/coverKernelPolicy.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { refKit, exactCov } = await import('../lbAccuracy/_lbAaRef.mjs');
const kit = await refKit();

async function load(name) {
  if (name === 'text') {
    const { MantleFontAsset } = await import('../../src/index.js');
    const { buildTextSections } = await import('../../src/textBundle.js');
    const f = path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
    if (!existsSync(f)) return null;
    const font = new MantleFontAsset(new Uint8Array(readFileSync(f)));
    await font.ready;
    const t = await buildTextSections(font, TEXT, { fill: [0, 0, 0, 1], fontSize: 32 }, false);
    // the section dict carries no numShapes or globalBBox of its own; createBundle takes them from the run
    const pm = parseMetaBin(t.sections.meta, t.sections.metaFloatsPerShape);
    return { ...t.sections, globalBBox: t.bundleSrc.globalBBox, numShapes: pm.numShapes };
  }
  const file =
    {
      tiger: 'examples/tiger.svg',
      lbMemBudget: 'examples/smoke/lbMemBudget__SVG.svg',
      ...Object.fromEntries(benchNames().map((n) => [n, `examples/_bench/${n}.svg`])),
    }[name] || name;
  const p = path.join(ROOT, file);
  return existsSync(p) ? importSvg(readFileSync(p, 'utf8'), { preserveViewport: true }) : null;
}

// MANTLE_AAC_PAIR_BANDS exactly where the renderer compiles it: a bundle built with paired H bands
// (BUNDLE_FLAG_PAIR_BANDS, the SVG importer's default). A text run's glyph bands are not paired, and reading them
// as pairs is wrong by up to 0.3 of a pixel.
const EMUS = new Map();
function emusFor(pair) {
  if (!EMUS.has(pair)) {
    const d = pair ? ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'] : ['MANTLE_AAC'];
    EMUS.set(pair, {
      emu: E.buildGlslEmu(ROOT, { defines: d }),
      emuT: E.buildGlslEmu(ROOT, { defines: d, timed: true }),
      emuBand: E.buildGlslEmu(ROOT, { defines: d, fetchCount: 'band' }),
      emuCurve: E.buildGlslEmu(ROOT, { defines: d, fetchCount: 'curve' }),
    });
  }
  return EMUS.get(pair);
}
const prng = (seed) => () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) / 16777216;
};

console.log(
  `kernel cost on the CPU emulator — fragments per cell capped at ${Q}, time min of ${REPS}`,
);
console.log(
  '  asset        size  frags   arm   |  edge mean/255  max/255  >0.5  >8  >64  (edge px) |  band   curve  ns/frag',
);
for (const name of WANT) {
  const b = await load(name);
  if (!b) {
    console.log(`  ${name}: absent`);
    continue;
  }
  const shapes = E.fillShapes(b, parseMetaBin, M);
  const stats = shapeSegStats(b);
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const { emu, emuT, emuBand, emuCurve } = emusFor(((b.flags | 0) & 8) !== 0);
  const g = b.globalBBox;
  const gw = g[2],
    gh = g[3];
  for (const N of SIZES) {
    const basePx = Math.max(gw, gh) / N;
    const ox = g[0] + gw / 2 - (N / 2) * basePx,
      oy = g[1] + gh / 2 - (N / 2) * basePx;
    const view = {
      N,
      basePx,
      ox,
      oy,
      emX: (i) => ox + (i + 0.5) * basePx,
      emY: (j) => oy + (j + 0.5) * basePx,
    };
    // every fill row's cover pixels
    const rows = [];
    let total = 0;
    for (const sh of shapes) {
      const i0 = Math.floor((sh.bb[0] - ox) / basePx) - 1,
        i1 = Math.ceil((sh.bb[2] - ox) / basePx) + 1;
      const j0 = Math.floor((sh.bb[1] - oy) / basePx) - 1,
        j1 = Math.ceil((sh.bb[3] - oy) / basePx) + 1;
      const n = Math.max(0, i1 - i0) * Math.max(0, j1 - j0);
      const areaPx = Math.max(0, (sh.bb[2] - sh.bb[0]) * (sh.bb[3] - sh.bb[1])) / (basePx * basePx);
      const types = (stats && stats.types[sh.s]) || b.segTypeMask | 0 || 0xf;
      rows.push({ sh, i0, i1, j0, j1, n, aac: areaPx >= aacTypeFloor(types) });
      total += n;
    }
    const p = Math.min(1, Q / Math.max(1, total)),
      rnd = prng(N * 7919 + name.length);
    const qs = [],
      who = [];
    rows.forEach((r, ri) => {
      for (let j = r.j0; j < r.j1; j++)
        for (let i = r.i0; i < r.i1; i++) {
          if (p < 1 && rnd() >= p) continue;
          qs.push({
            GD: r.sh.GD,
            bb: r.sh.bb,
            eo: r.sh.eo,
            c: [view.emX(i), view.emY(j)],
            ePx: [basePx, basePx],
          });
          who.push([ri, i, j]);
        }
    });
    if (!qs.length) continue;
    const run = (e, k) =>
      e.run(
        band,
        curve,
        qs.map((q, n) => ({ ...q, k: typeof k === 'function' ? k(n) : k })),
      );
    const bothK = (n) => (rows[who[n][0]].aac ? E.K_AAC : E.K_SLUG);
    const sl = run(emu, E.K_SLUG),
      ac = run(emu, E.K_AAC);
    const fb = [run(emuBand, E.K_SLUG), run(emuBand, E.K_AAC)],
      fc = [run(emuCurve, E.K_SLUG), run(emuCurve, E.K_AAC)];
    // TIMED ON A REPEATED SET (>= 300k fragments), inside the emulator; ns/fragment divides by the repeated count.
    const rep = Math.max(1, Math.ceil(300000 / qs.length));
    const qsT = [];
    for (let r = 0; r < rep; r++) for (let q = 0; q < qs.length; q++) qsT.push(q);
    const timeOf = (k) => {
      const job = qsT.map((q) => ({ ...qs[q], k: typeof k === 'function' ? k(q) : k }));
      let best = Infinity;
      for (let r = 0; r < REPS; r++) best = Math.min(best, emuT.run(band, curve, job).ns * 1e-6);
      return best / rep;
    };
    const tBase = timeOf(E.K_INVPX),
      tS = timeOf(E.K_SLUG),
      tA = timeOf(E.K_AAC),
      tB = timeOf(bothK);
    // the exact reference where it can matter
    const ref = new Float64Array(qs.length).fill(NaN);
    const curvesOf = new Map(),
      caches = new Map();
    for (let q = 0; q < qs.length; q++) {
      const s = sl[q],
        a = ac[q];
      const settled = (s === 0 && a === 0) || (s === 1 && a === 1);
      if (settled) {
        ref[q] = s;
        continue;
      }
      const [ri, i, j] = who[q],
        r = rows[ri];
      let cv = curvesOf.get(ri);
      if (!cv) {
        const cs = curveRangeToContours(curve, r.sh.range.begin, r.sh.range.end);
        cv = cs ? kit.closed(kit.contoursToConverter(cs, null)) : [];
        curvesOf.set(ri, cv);
      }
      let cache = caches.get(ri);
      if (!cache) caches.set(ri, (cache = new Map()));
      ref[q] = cv.length ? exactCov(kit.rowSpans, cv, i, j, view, 64, r.sh.eo, cache) : NaN;
    }
    // mean over EDGE pixels (0 < exact < 1); the tallies over every pixel (a wrong settled pixel counts)
    const acc = (pick) => {
      let n = 0,
        e = 0,
        mx = 0,
        c1 = 0,
        c8 = 0,
        c64 = 0,
        nb = 0,
        nc = 0;
      for (let q = 0; q < qs.length; q++) {
        const useA = pick(who[q][0]);
        const v = useA ? ac[q] : sl[q];
        nb += (useA ? fb[1] : fb[0])[q];
        nc += (useA ? fc[1] : fc[0])[q];
        if (!Number.isFinite(ref[q])) continue;
        const d = Math.abs(v - ref[q]) * 255;
        if (ref[q] > 1e-6 && ref[q] < 1 - 1e-6) {
          n++;
          e += d;
        }
        if (d > mx) mx = d;
        if (d > 0.5) c1++;
        if (d > 8) c8++;
        if (d > 64) c64++;
      }
      return {
        n,
        mean: e / Math.max(1, n),
        mx,
        c1,
        c8,
        c64,
        band: nb / qs.length,
        curve: nc / qs.length,
      };
    };
    const arms = [
      ['slug', () => false, tS - tBase],
      ['aac', () => true, tA - tBase],
      ['both', (ri) => rows[ri].aac, tB - tBase],
    ];
    const nAac = rows.filter((r) => r.aac).length;
    if (process.env.DUMP) {
      const bad = [];
      for (let q = 0; q < qs.length; q++)
        if (Number.isFinite(ref[q]) && Math.abs(ac[q] - ref[q]) * 255 > 64) bad.push(q);
      const byRow = {};
      for (const q of bad) byRow[who[q][0]] = (byRow[who[q][0]] || 0) + 1;
      console.log('    AAC >64 by row:', JSON.stringify(byRow));
      for (const q of bad.slice(0, 6)) {
        const [ri, i, j] = who[q];
        console.log(
          `    row ${ri} (shape ${rows[ri].sh.s}, eo ${rows[ri].sh.eo}) px ${i},${j}: exact ${ref[q].toFixed(3)} aac ${ac[q].toFixed(3)} slug ${sl[q].toFixed(3)}`,
        );
      }
    }
    for (const [arm, pick, t] of arms) {
      const a = acc(pick);
      const ns = (t * 1e6) / qs.length;
      console.log(
        `  ${name.padEnd(12)}${String(N).padStart(5)} ${String(qs.length).padStart(6)}  ${arm.padEnd(5)} | ` +
          `${a.mean.toFixed(3).padStart(8)} ${a.mx.toFixed(1).padStart(8)} ${String(a.c1).padStart(5)} ${String(a.c8).padStart(3)} ${String(a.c64).padStart(4)}  ` +
          `(${String(a.n).padStart(6)})`.padEnd(12) +
          `| ${a.band.toFixed(1).padStart(5)} ${a.curve.toFixed(1).padStart(7)} ${ns.toFixed(0).padStart(7)}` +
          (arm === 'both' ? `   [${nAac} of ${rows.length} rows AAC]` : ''),
      );
    }
  }
}
