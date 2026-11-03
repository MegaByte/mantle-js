// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbAaAudit — per shape, how far the Loop-Blinn kernel's own coverage stands from the exact box
// filter, with the error split by local feature width and the jaggies counted on both axes.
//
// No GPU. The coverage comes from the CPU twin of the kernel (_lbKernel.mjs) fed the package's
// packed mesh, so a number here is the shader's arithmetic, not a re-derivation of what it ought
// to compute. The truth comes from the path itself (_lbAaRef.mjs), so "LB is worse than Slug" can
// be turned into "LB's term X is wrong by Y at pixel Z".
//
// PER SHAPE, SOLO. A composited frame hides an over-covering shape under the next one's ink,
// so every shape is measured alone against its own exact
// coverage, on the raster the whole drawing would be rendered at.
//
// AA AND FILL ARE SEPARATE QUESTIONS and a single total cannot answer either. A pixel the path
// covers PARTIALLY is an antialiasing question; a
// pixel it covers fully or not at all is a fill question, and one under-covering mesh buries every
// AA number under it. So:
//
//   aaErr  sum |model - exact| over pixels with 0 < exact < 1, in px^2, with aaMean / aaMax over
//          that set -- the edge-AA instrument
//   miss   sum (1 - model) over pixels the path covers FULLY   (paint that is absent)
//   stray  sum model over pixels the path does not cover at all (paint that should not be there)
//   err    aaErr + miss + stray, the whole departure
//   fine   aaErr split by the narrowest span covering the pixel: <1px / 1-2px / 2-4px / >4px
//   jaggy  pixels whose signed error spikes past 0.25 against both neighbours on an axis, in the
//          same direction, counted on x and y (vertical spikes are invisible to an x-only count)
//
//   node probes/lbAccuracy/_lbAaAudit.mjs OUT.json [file.svg[#shape] ...]
//   CANVAS=512 SLICES=64 PAD=2 ROWS=15 REF=ref.json OPT='{"kappaScale":0}' FIT=hull
//   node probes/lbAccuracy/_lbAaAudit.mjs --diff A.json B.json
//
// ── READING IT ────────────────────────────────────────────────────────────────────────────────
// FIT=hull fits the CONTROL-POINT HULL instead of the box the renderer fits (on tiger basePx 3.67199
// against the shader's 3.51563, a 4.4% scale error plus a 21.8 em shift), and
// OPT='{"noArcMoment":true}' drops the twin's arc moment; together they reproduce numbers taken
// under that model, so a comparison against them is a measurement rather than an assertion.
//
// ROWS THAT DRAW NO FILL ARE SCORED SEPARATELY. Every number compares a shape's mesh against ITS
// PATH'S FILL, and 72 of tiger's 298 built shapes have fill alpha ZERO -- `fill="none"` with a
// stroke, which is most of a stroked drawing. Their `miss` is paint that was never going to be
// there. Split at 512 px:
//
//     rows with no fill   72 shapes   AA 753.72 px^2   miss 917.19 over 903 px   stray 31.33
//     the PICTURE        226 shapes   AA 2295.50 px^2  miss  89.72 over   4 px   stray 30.74
//
// BY DOMINANT PAINTER the order is UNPAINTED > CUBIC_BEZ > INTERIOR_chain >> EDGE_STRIP, with
// EDGE_STRIP the smallest by two orders of magnitude — it is the control, the one kind whose
// exterior push (0.8 px) exceeds CP_AA_REACH, and the curve kinds' 0.25 px still leaves a pixel
// 0.25-0.707 px outside a curved outline with no painter.
//
// THE RING SWEEP moves the RING AND THE FENCE TOGETHER — a wider ring past a 0.25 px fence is
// fenced off.
//
//   tiger at 512, OPT='{"klmRing":R,"bezRing":R,"bezFence":R}'      AA err     UNPAINTED  jaggy  stray
//     R = 0.25 (the default)                                       3052.615     1187.62   1675   62.07
//     R = 0.5                                                      2901.669      714.21   1922  105.66
//     R = 0.7072 (CP_AA_REACH)                                     2963.663      700.85   2099  222.18
//
// So 0.5 buys -4.94% of the AA error, and 0.7072 is worse than 0.5 with stray 3.58x and jaggies
// 1675 -> 2099.
import { readFileSync, writeFileSync } from 'fs';
import { loadSvg, shapesOf, viewOf, buildMesh, rasterMesh } from './_lbRaster.mjs';
import { refKit, exactCov, featureWidthPx, loadCache, saveCache } from './_lbAaRef.mjs';

if (process.argv[2] === '--diff') {
  const A = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const B = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  const key = (r) => r.file + '#' + r.shape;
  const m = new Map(A.rows.map((r) => [key(r), r]));
  let dErr = 0,
    dOver = 0,
    dUnder = 0,
    dJ = 0,
    worse = 0,
    better = 0,
    same = 0,
    declined = 0;
  let off32A = 0,
    off32B = 0,
    lostA = 0,
    lostB = 0;
  const rows = [];
  for (const b of B.rows) {
    const a = m.get(key(b));
    if (!a) continue;
    // A DECLINED shape has no err/over/under — it has a `declined` flag and nothing else. Summing
    // it would turn every total below into NaN, so a whole diff would read as no information at all
    // while the per-row table beside it was correct. Declines are reported on their own line.
    if (!Number.isFinite(a.err) || !Number.isFinite(b.err)) {
      declined++;
      continue;
    }
    const d = b.err - a.err;
    dErr += d;
    dOver += b.over - a.over;
    dUnder += b.under - a.under;
    dJ += b.jaggy - a.jaggy;
    off32A += a.off32 || 0;
    off32B += b.off32 || 0;
    lostA += a.lostIn || 0;
    lostB += b.lostIn || 0;
    if (d > 1e-9) {
      worse++;
      rows.push([d, a, b]);
    } else if (d < -1e-9) {
      better++;
      rows.push([d, a, b]);
    } else same++;
  }
  rows.sort((x, y) => y[0] - x[0]);
  const lim = +(process.env.ROWS || 15);
  console.log('  delta err    err A -> B          worst A -> B     jaggy   shape');
  for (const [d, a, b] of rows.slice(0, lim).concat(rows.slice(-lim).filter((r) => r[0] < 0)))
    console.log(
      `  ${(d >= 0 ? '+' : '') + d.toFixed(3).padStart(9)}  ${a.err.toFixed(2).padStart(8)} -> ${b.err.toFixed(2).padEnd(8)}  ` +
        `${a.worst.toFixed(3)} -> ${b.worst.toFixed(3)}  ${String(a.jaggy).padStart(4)} -> ${String(b.jaggy).padEnd(4)}  ${b.file.split('/').pop()} #${b.shape}`,
    );
  console.log(
    `\n  ${B.rows.length} shapes; ${worse} worse, ${better} better, ${same} unchanged, ${declined} declined in one arm or both`,
  );
  console.log(
    `  total err ${(dErr >= 0 ? '+' : '') + dErr.toFixed(3)} px^2 (over ${(dOver >= 0 ? '+' : '') + dOver.toFixed(3)}, under ${(dUnder >= 0 ? '+' : '') + dUnder.toFixed(3)}), jaggy ${(dJ >= 0 ? '+' : '') + dJ}`,
  );
  console.log(
    `  off >32/255 ${off32A} -> ${off32B} px, lost inside the fill ${lostA} -> ${lostB} px`,
  );
  process.exit(0);
}

const out = process.argv[2];
if (!out) {
  console.error('usage: _lbAaAudit.mjs OUT.json [file.svg[#shape] ...] | --diff A.json B.json');
  process.exit(2);
}
const CANVAS = +(process.env.CANVAS || 512);
const SLICES = +(process.env.SLICES || 64);
const PAD = +(process.env.PAD || 2);
const OPT = process.env.OPT ? JSON.parse(process.env.OPT) : {};
// BUILD sets globalThis flags the MESH BUILDER reads (__LB_HULL_TOL, __LB_TWO_ARCS, ...), so an arm
// can move the geometry as well as the kernel. The builder runs in this process, so they reach it.
const BUILD = process.env.BUILD ? JSON.parse(process.env.BUILD) : null;
// The builder's tunables are test hooks, read only under __MANTLE_DEBUG__: a BUILD arm opens the gate.
if (BUILD) {
  globalThis.__MANTLE_DEBUG__ = true;
  for (const k of Object.keys(BUILD)) globalThis[k] = BUILD[k];
}
const REFFILE = process.env.REF || '';
const refCache = loadCache(REFFILE);
let refDirty = false;
const _w = console.warn;
console.warn = () => {};

const targets = new Map();
for (const arg of process.argv.slice(3)) {
  const [f, s] = arg.split('#');
  if (!targets.has(f)) targets.set(f, []);
  if (s != null) targets.get(f).push(+s);
}
if (!targets.size) targets.set('examples/tiger.svg', []);

const FINE = [1, 2, 4, Infinity];
const rows = [];
for (const [file, want] of targets) {
  const bundle = await loadSvg(file);
  // FIT=hull fits the control-hull box instead (see shapesOf); the default is the box the
  // renderer actually fits, which is the bundle's globalBBox.
  const { shapes, bbox } = await shapesOf(bundle, { fit: process.env.FIT });
  const view = viewOf(bbox, CANVAS);
  const { rowSpans, contoursToConverter, closed } = await refKit();
  for (const sh of shapes) {
    if (want.length && !want.includes(sh.s)) continue;
    const built = await buildMesh(sh);
    if (!built) {
      rows.push({ file, shape: sh.s, declined: true });
      continue;
    }
    const cv = contoursToConverter(sh.contours, null);
    if (!cv) continue;
    const curves = closed(cv);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const sg of curves)
      for (const p of sg.P) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    const i0 = Math.max(0, Math.floor((x0 - view.ox) / view.basePx) - PAD);
    const i1 = Math.min(CANVAS - 1, Math.ceil((x1 - view.ox) / view.basePx) + PAD);
    const j0 = Math.max(0, Math.floor((y0 - view.oy) / view.basePx) - PAD);
    const j1 = Math.min(CANVAS - 1, Math.ceil((y1 - view.oy) / view.basePx) + PAD);
    if (i1 < i0 || j1 < j0) continue;
    const acc = new Float64Array(CANVAS * CANVAS).fill(1);
    const kindAcc = new Int32Array(CANVAS * CANVAS);
    const domAcc = new Int32Array(CANVAS * CANVAS).fill(-1);
    const domCov = new Float64Array(CANVAS * CANVAS);
    const stat = rasterMesh(built.pk, view, acc, OPT, kindAcc, domAcc, domCov);
    const W = i1 - i0 + 1,
      H = j1 - j0 + 1;
    const rk = `${file}#${sh.s}|${CANVAS}|${SLICES}|${PAD}`;
    let ref = refCache[rk];
    const have = Array.isArray(ref) && ref.length === W * H;
    if (!have) {
      ref = new Array(W * H);
      refDirty = true;
    }
    const sgn = new Float64Array(W * H);
    const wid = new Float64Array(W * H);
    let err = 0,
      over = 0,
      under = 0,
      worst = 0,
      npx = 0,
      worstAt = null;
    let aaErr = 0,
      aaN = 0,
      aaMax = 0,
      aaMaxAt = null,
      miss = 0,
      stray = 0,
      missN = 0,
      strayN = 0;
    let ink = 0,
      inkRef = 0; // total darkness, for the net-ink metric
    const fineErr = [0, 0, 0, 0],
      fineN = [0, 0, 0, 0],
      fineMax = [0, 0, 0, 0];
    const byKindErr = {},
      byKindN = {},
      byKindSgn = {};
    const rowCache = new Map();
    // THE MORPH PROBE'S TWO COUNTS, on the static build: pixels off exact by more than 32/255, and of those the ones
    // that lost ink at a pixel whose CENTER is inside the fill (test/_lbMorphDrawEmu.mjs scoreExact's `lostIn`).
    const T32 = 32 / 255;
    let off32 = 0,
      over32 = 0,
      lostIn = 0;
    let ri = 0;
    for (let j = j0; j <= j1; j++) {
      rowCache.clear();
      const cRow = rowSpans(curves, view.oy + (j + 0.5) * view.basePx, sh.evenOdd);
      for (let i = i0; i <= i1; i++, ri++) {
        const ex = have
          ? ref[ri]
          : (ref[ri] = exactCov(rowSpans, curves, i, j, view, SLICES, sh.evenOdd, rowCache));
        const mo = 1 - acc[j * CANVAS + i];
        const d = mo - ex;
        sgn[ri] = d;
        if (Math.abs(d) > T32) {
          off32++;
          if (d > 0) over32++;
          else {
            const cx = view.ox + (i + 0.5) * view.basePx;
            if (cRow.some((q) => cx >= q[0] && cx < q[1])) lostIn++;
          }
        }
        const w = featureWidthPx(rowSpans, curves, i, j, view, sh.evenOdd);
        wid[ri] = w;
        npx++;
        ink += mo;
        inkRef += ex;
        const EPS = 1e-6;
        const edge = ex > EPS && ex < 1 - EPS;
        if (edge) {
          aaN++;
          aaErr += Math.abs(d);
          const dk = domAcc[j * CANVAS + i];
          byKindErr[dk + 1] = (byKindErr[dk + 1] || 0) + Math.abs(d);
          byKindSgn[dk + 1] = (byKindSgn[dk + 1] || 0) + d;
          byKindN[dk + 1] = (byKindN[dk + 1] || 0) + 1;
          if (Math.abs(d) > aaMax) {
            aaMax = Math.abs(d);
            aaMaxAt = [i, j, ex, mo, kindAcc[j * CANVAS + i]];
          }
          let b = 0;
          while (b < 3 && w > FINE[b]) b++;
          fineErr[b] += Math.abs(d);
          fineN[b]++;
          if (Math.abs(d) > fineMax[b]) fineMax[b] = Math.abs(d);
        } else if (ex >= 1 - EPS) {
          if (mo < 1) {
            miss += 1 - mo;
            if (1 - mo > 0.5) missN++;
          }
        } else if (mo > 0) {
          stray += mo;
          if (mo > 0.5) strayN++;
        }
        if (d === 0) continue;
        err += Math.abs(d);
        if (d > 0) over += d;
        else under -= d;
        if (Math.abs(d) > worst) {
          worst = Math.abs(d);
          worstAt = [i, j, ex, mo, kindAcc[j * CANVAS + i]];
        }
      }
    }
    // JAGGY on both axes: a signed spike against both neighbours, same direction, > 0.25.
    let jaggy = 0,
      jaggyX = 0,
      jaggyY = 0;
    const at = (i, j) => sgn[(j - j0) * W + (i - i0)];
    for (let j = j0 + 1; j < j1; j++)
      for (let i = i0 + 1; i < i1; i++) {
        const c = at(i, j);
        const hx =
          (c - at(i - 1, j) > 0.25 && c - at(i + 1, j) > 0.25) ||
          (at(i - 1, j) - c > 0.25 && at(i + 1, j) - c > 0.25);
        const hy =
          (c - at(i, j - 1) > 0.25 && c - at(i, j + 1) > 0.25) ||
          (at(i, j - 1) - c > 0.25 && at(i, j + 1) - c > 0.25);
        if (hx) jaggyX++;
        if (hy) jaggyY++;
        if (hx || hy) jaggy++;
      }
    if (!have && REFFILE) refCache[rk] = ref;
    rows.push({
      file,
      shape: sh.s,
      verts: built.pk.vertexCount,
      kindMask: built.pk.kindMask,
      noFill: !!sh.noFill,
      px: npx,
      err,
      over,
      under,
      worst,
      worstAt,
      jaggy,
      jaggyX,
      jaggyY,
      off32,
      over32,
      lostIn,
      aaErr,
      aaN,
      aaMax,
      aaMaxAt,
      miss,
      missN,
      stray,
      strayN,
      ink,
      inkRef,
      byKindErr,
      byKindN,
      byKindSgn,
      fineErr,
      fineN,
      fineMax,
      frags: stat.frags,
      discards: stat.discards,
    });
  }
  console.error(`${file}: ${rows.length} shapes`);
}
console.warn = _w;
const live = rows.filter((r) => !r.declined);
const SORT = process.env.SORT || 'aaErr';
live.sort((a, b) => b[SORT] - a[SORT]);
const T = live.reduce((t, r) => t + r.err, 0);
const J = live.reduce((t, r) => t + r.jaggy, 0);
const AE = live.reduce((t, r) => t + r.aaErr, 0),
  AN = live.reduce((t, r) => t + r.aaN, 0);
const MI = live.reduce((t, r) => t + r.miss, 0),
  ST = live.reduce((t, r) => t + r.stray, 0);
console.log('   aaErr px2   aaMean    aaMax     miss    stray  jaggy  verts  shape');
for (const r of live.slice(0, +(process.env.ROWS || 15)))
  console.log(
    `  ${r.aaErr.toFixed(3).padStart(10)}  ${(r.aaErr / Math.max(1, r.aaN)).toFixed(4)}  ${r.aaMax.toFixed(3).padStart(7)}  ${r.miss.toFixed(2).padStart(7)}  ${r.stray.toFixed(2).padStart(7)}  ${String(r.jaggy).padStart(5)}  ${String(r.verts).padStart(5)}  ${r.file.split('/').pop()} #${r.shape}`,
  );
const fe = [0, 0, 0, 0],
  fn = [0, 0, 0, 0],
  fm = [0, 0, 0, 0];
for (const r of live)
  for (let b = 0; b < 4; b++) {
    fe[b] += r.fineErr[b];
    fn[b] += r.fineN[b];
    fm[b] = Math.max(fm[b], r.fineMax[b]);
  }
console.log(
  `  FINE  <1px n=${fn[0]} mean ${(fe[0] / Math.max(1, fn[0])).toFixed(4)} max ${fm[0].toFixed(3)} | 1-2px n=${fn[1]} mean ${(fe[1] / Math.max(1, fn[1])).toFixed(4)} max ${fm[1].toFixed(3)}` +
    ` | 2-4px n=${fn[2]} mean ${(fe[2] / Math.max(1, fn[2])).toFixed(4)} max ${fm[2].toFixed(3)} | >4px n=${fn[3]} mean ${(fe[3] / Math.max(1, fn[3])).toFixed(4)} max ${fm[3].toFixed(3)}`,
);
const KN = {
  0: 'INTERIOR_solid',
  21: 'INTERIOR_chain',
  22: 'INTERIOR_conic',
  20: 'INTERIOR_line',
  2: 'CUBIC',
  4: 'CUBIC_BEZ',
  5: 'ARC',
  7: 'DISC',
  10: 'EDGE_STRIP',
  12: 'CURVE_BAND',
  13: 'CHAIN_STRIP',
  '-1': 'UNPAINTED',
};
const bkE = {},
  bkN = {},
  bkS = {};
for (const r of live)
  for (const k of Object.keys(r.byKindErr || {})) {
    bkE[k] = (bkE[k] || 0) + r.byKindErr[k];
    bkN[k] = (bkN[k] || 0) + r.byKindN[k];
    bkS[k] = (bkS[k] || 0) + ((r.byKindSgn || {})[k] || 0);
  }
console.log('  BY DOMINANT PAINTER (edge pixels):');
for (const k of Object.keys(bkE).sort((a, b) => bkE[b] - bkE[a]))
  console.log(
    `    ${(KN[k - 1] || 'kind' + (k - 1)).padEnd(15)} n=${String(bkN[k]).padStart(6)}  err ${bkE[k].toFixed(2).padStart(9)} px^2  mean ${(bkE[k] / bkN[k]).toFixed(4)} (${((bkE[k] / bkN[k]) * 255).toFixed(2)}/255)  signed ${(bkS[k] >= 0 ? '+' : '') + bkS[k].toFixed(2)}`,
  );
const IK = live.reduce((t, r) => t + r.ink, 0),
  IR = live.reduce((t, r) => t + r.inkRef, 0);
console.log(
  `  INK TOTAL  model ${IK.toFixed(2)} px^2 vs exact ${IR.toFixed(2)} px^2  net ${(IK >= IR ? '+' : '') + ((IK / Math.max(IR, 1e-9) - 1) * 100).toFixed(2)}%`,
);
console.log(
  `  AA  ${AN} edge px, err ${AE.toFixed(3)} px^2, mean ${(AE / Math.max(1, AN)).toFixed(5)} (${((AE / Math.max(1, AN)) * 255).toFixed(3)}/255)`,
);
console.log(
  `  FILL  miss ${MI.toFixed(2)} px^2 over ${live.reduce((t, r) => t + r.missN, 0)} whole px, stray ${ST.toFixed(2)} px^2 over ${live.reduce((t, r) => t + r.strayN, 0)} whole px`,
);
// ── THE ROWS THAT DRAW NO FILL ────────────────────────────────────────────────────────────────
// Every number above scores a shape's mesh against ITS PATH'S FILL. A row whose fill alpha is ZERO
// -- `fill="none"`, which is 78 of tiger's 304 shapes -- never paints that fill, so its `miss` is
// paint that was never going to be there and its AA error is on an edge nothing draws. Reported
// separately rather than subtracted, because the mesh is still built and still costs vertices;
// what it is not is a picture. (On tiger, nearly all of the apparent "missing fill" is this.)
{
  const nf = live.filter((r) => r.noFill),
    fl = live.filter((r) => !r.noFill);
  const S = (a, k) => a.reduce((t, r) => t + (r[k] || 0), 0);
  if (nf.length) {
    console.log(
      `  OF WHICH, ROWS WITH NO FILL (alpha 0): ${nf.length} of ${live.length} shapes` +
        ` — AA ${S(nf, 'aaErr').toFixed(2)} px^2, miss ${S(nf, 'miss').toFixed(2)} over ${S(nf, 'missN')} px,` +
        ` stray ${S(nf, 'stray').toFixed(2)}; none of it is painted`,
    );
    console.log(
      `  SO THE PICTURE IS: ${fl.length} filled shapes — AA ${S(fl, 'aaErr').toFixed(2)} px^2 over ${S(fl, 'aaN')} edge px` +
        ` (${((S(fl, 'aaErr') / Math.max(1, S(fl, 'aaN'))) * 255).toFixed(3)}/255), miss ${S(fl, 'miss').toFixed(2)} over ${S(fl, 'missN')} px,` +
        ` stray ${S(fl, 'stray').toFixed(2)} over ${S(fl, 'strayN')} px`,
    );
  }
}
console.log(
  `  OFF >32/255  ${live.reduce((t, r) => t + (r.off32 || 0), 0)} px (over ${live.reduce((t, r) => t + (r.over32 || 0), 0)}), ` +
    `lost inside the fill ${live.reduce((t, r) => t + (r.lostIn || 0), 0)} px`,
);
console.log(
  `  ${live.length} shapes (${rows.length - live.length} declined), total err ${T.toFixed(3)} px^2, jaggy ${J} (CANVAS=${CANVAS}, SLICES=${SLICES})`,
);
writeFileSync(out, JSON.stringify({ canvas: CANVAS, slices: SLICES, opt: OPT, rows }));
if (REFFILE && refDirty) saveCache(REFFILE, refCache);
