// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _decisionSurface.mjs — what the engine selectors decide, over the corpus, at several sizes, on the CPU.
//
//   node probes/engineSelect/_decisionSurface.mjs [--sizes 128,256,512,1024] [--family all|examples|smoke|bench]
//                                                 [--limit N] [--rows N] [--csv PATH] [--noaa]
//
// NO GPU, NO TIMING. Every number here is a DECISION, not a duration: which rows take their
// Loop-Blinn mesh under the default rule and under the on-screen size term, which rows change when the
// draw's fill edges are stroke-covered (the no-AA veto). What any of it is WORTH is a GPU question;
// this says what would move, and why, so a GPU check has something to falsify.
//
// THE SIZE TERM IS NOT IN THE RENDERER, so the `__LB_SIZE_TERM` writes below are no-ops and every
// "sized" column reproduces "default" -- an A/A, kept so the no-AA half still runs. Read nothing
// into a size-term column.
//
// THE TWO ARMS COME FROM ONE SOURCE, read out of `lbShapePolicy.minPx2PerSegFor`. A probe that
// re-implemented it would be a
// second source of truth for the thing being measured, which is how a rule comes to be "validated"
// against a copy of itself.
//
// SIZE MEANS THE CANVAS THE BUNDLE IS FITTED TO. `setViewport` + `drawBundle` fit the CONTENT bbox,
// so a square canvas of N px is "this asset drawn N px across", which is what the renderer does and
// what the sweep sizes mean.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const SIZES = String(arg('sizes', '128,256,512,1024'))
  .split(',')
  .map(Number)
  .filter((v) => v > 0);
const FAMILY = arg('family', 'all');
const LIMIT = +arg('limit', 0) || Infinity;
const ROWS = +arg('rows', 40);
const CSV = arg('csv', null);
const NOAA = has('noaa');
/// --noaa-all: pretend every asset's fill edges are covered. A sensitivity study, not a survey --
/// the real predicate needs the importer's proof, which only a handful of assets carry.
const NOAA_ALL = has('noaa-all');

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
const { buildLbBundle } = await import('../../src/renderer/lbBuildCore.js');
const { lbShapePicks, minPx2PerSegFor, lbShapeMayPick } =
  await import('../../src/renderer/lbShapePolicy.js');
const { shapeSegStats } = await import('../../src/renderer/shapeStats.js');
const { unitPx2 } = await import('../../src/renderer/shapeScale.js');

const SEG_NAME = ['line', 'quad', 'cubic', 'arc'];
const typeStr = (t) => SEG_NAME.filter((_, i) => t & (1 << i)).join('+') || '-';

function corpus() {
  const out = [];
  const add = (dir, tag) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.svg')) continue;
      out.push({ tag, name: `${tag}/${f}`, file: path.join(dir, f) });
    }
  };
  if (FAMILY === 'all' || FAMILY === 'examples') add(path.join(PKG, 'examples'), 'examples');
  if (FAMILY === 'all' || FAMILY === 'bench') add(path.join(PKG, 'examples', '_bench'), 'bench');
  if (FAMILY === 'all' || FAMILY === 'smoke') add(path.join(PKG, 'examples', 'smoke'), 'smoke');
  return out;
}

/// A renderer stub good enough for unitPx2 (viewport fit x |det| of the world matrix) and for the
/// two no-AA predicates.
///
/// `hardAll` models preferNoAa's STATIC half — the importer's `noAaFill` proof that every fill edge
/// is covered by an opaque stroke — and assumes its draw-time half (no overrides, alpha >= 0.996,
/// no recolor, stroke >= 2 device px) holds. Assuming that is the generous reading, which is the
/// right one for a bound. Forcing it on every asset instead (--noaa-all) is a sensitivity study and
/// is labeled as one: only 14 of 363 corpus assets import with the proof.
const rendererAt = (N, hardAll, hardMixed) => ({
  viewportSize: () => [N, N],
  // THE RENDERER'S own aspect-preserving fit, not [1, 1]. With [1, 1] the fit is non-uniform on a
  // non-square bbox, so every px^2 a probe reported would be for a draw the renderer never makes --
  // and the size term is read in exactly those units.
  arScale: (bbox, vw, vh) => {
    const cAR = vw / vh,
      sAR = bbox[2] / bbox[3];
    return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
  },
  draw: {},
  opts: {},
  _lbFillMode: 'auto',
  _preferNoAa: hardAll ? (b) => NOAA_ALL || !!(b && b.noAaFill) : undefined,
  _preferNoAaMixed: hardMixed ? (b) => NOAA_ALL || !!(b && b.noAaMixed) : undefined,
});

/// The same function the policy reads its scale from, through the same stub, AND THE same QUARTER-
/// OCTAVE QUANTIZATION. lbShapePicks buckets the scale so a zoom does not rebuild the stream on
/// every frame, and decides on the bucket's scale, not on the exact one -- up to 9% away. A probe
/// printing the exact px^2 next to the floor shows rows that clear the bar and moved anyway.
function unitPx2At(bundle, N) {
  const k2 = unitPx2(rendererAt(N, false, false), bundle);
  if (!(k2 > 0)) return 0;
  return Math.pow(2, Math.round(Math.log2(k2) * 4) / 4);
}

async function load(entry) {
  const svg = readFileSync(entry.file, 'utf8');
  const sec = await importSvg(svg, { preserveViewport: true });
  if (!(sec.numShapes > 0) || !sec.curveRangesByShape) return null;
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const input = {
    curveFloats: new Float32Array(sec.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: sec.curveRangesByShape,
    numShapes: sec.numShapes,
  };
  const bundle = {
    curveFloats: input.curveFloats,
    curveRangesByShape: input.ranges,
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    numShapes: sec.numShapes,
    segTypeMask: sec.segTypeMask,
    _geomGen: 0,
    globalBBox: sec.globalBBox,
    noAaFill: !!sec.noAaFill,
    noAaMixed: !!sec.noAaMixed,
  };
  return { sec, input, bundle };
}

/// lbShapePicks caches on the bundle; a probe asking the same bundle twice under two rules would be
/// served the first answer. Every call below goes through a fresh view of the same arrays.
const fresh = (b) => ({
  ...b,
  _lbPickCache: null,
  _lbPickKey: 0,
  _shapeStats: b._shapeStats,
  _shapeStatsGen: b._shapeStatsGen,
});

const files = corpus().slice(0, LIMIT === Infinity ? undefined : LIMIT);
if (!files.length) {
  console.error('no corpus SVGs found (examples/, examples/_bench/, examples/smoke/)');
  process.exit(1);
}
console.log(
  `decision surface: ${files.length} assets, sizes ${SIZES.join('/')}${NOAA ? ', no-AA arm' : ''}`,
);

const perSize = new Map(
  SIZES.map((N) => [
    N,
    {
      assets: 0,
      fillRows: 0,
      buildRows: 0,
      pickShipped: 0,
      pickSized: 0,
      toCover: 0,
      toLb: 0,
      routeLost: 0,
      routeGained: 0,
      hardPickShipped: 0,
      hardPickSized: 0,
      hardMoved: 0,
      hardPrimBundles: 0,
      noAaFill: 0,
      noAaMixed: 0,
      hardEligible: 0,
      zeroShip: 0,
      zeroSized: 0,
    },
  ]),
);
const moves = []; // per-row engine changes, for the table
const hardMoves = []; // per-asset no-AA route changes
const lostRoute = []; // assets whose LAST pick goes, so the analytic route declines them
let skipped = 0,
  built = 0;

for (const entry of files) {
  let L = null;
  try {
    L = await load(entry);
  } catch {
    skipped++;
    continue;
  }
  if (!L) {
    skipped++;
    continue;
  }
  let packed;
  try {
    packed = buildLbBundle(L.input).packed;
  } catch {
    skipped++;
    continue;
  }
  built++;
  const { bundle } = L;
  const stats = shapeSegStats(bundle);
  const meta = bundle.metaFloats,
    st = bundle.metaFloatsPerShape | 0,
    n = bundle.numShapes | 0;
  if (!stats || !meta || !st) {
    skipped++;
    continue;
  }
  const bboxOf = (s) => (meta[s * st + 2] - meta[s * st]) * (meta[s * st + 3] - meta[s * st + 1]);
  const isFill = (s) => meta[s * st + 7] > 0;
  const buildRows = (() => {
    let c = 0;
    for (let s = 0; s < n; s++) if (lbShapeMayPick(bundle, s, stats)) c++;
    return c;
  })();
  const fillRows = (() => {
    let c = 0;
    for (let s = 0; s < n; s++) if (isFill(s)) c++;
    return c;
  })();

  for (const N of SIZES) {
    const A = perSize.get(N);
    A.assets++;
    A.fillRows += fillRows;
    A.buildRows += buildRows;
    if (bundle.noAaFill) A.noAaFill++;
    if (bundle.noAaMixed) A.noAaMixed++;
    const k2 = unitPx2At(bundle, N);

    globalThis.__LB_SIZE_TERM = 'off';
    const pShip = lbShapePicks(rendererAt(N, false, false), fresh(bundle), packed);
    globalThis.__LB_SIZE_TERM = 'on';
    const pSize = lbShapePicks(rendererAt(N, false, false), fresh(bundle), packed);

    const cShip = pShip ? pShip.reduce((a, v) => a + v, 0) : 0;
    const cSize = pSize ? pSize.reduce((a, v) => a + v, 0) : 0;
    A.pickShipped += cShip;
    A.pickSized += cSize;
    if (cShip > 0 && cSize === 0) A.routeLost++;
    if (cShip === 0 && cSize > 0) A.routeGained++;
    if (cShip === 0) A.zeroShip++;
    if (cSize === 0) A.zeroSized++;
    // AN ASSET THAT LOSES ITS LAST PICK LOSES THE ROUTE, which is the one movement a render smoke
    // asserting `lbRouted > 0` reads as a failure. Named, not counted: the lane cannot be run here.
    if (cShip > 0 && cSize === 0)
      lostRoute.push({ asset: entry.name, size: N, was: cShip, rows: fillRows });
    for (let s = 0; s < n; s++) {
      const a = pShip ? pShip[s] : 0,
        b = pSize ? pSize[s] : 0;
      if (a === b) continue;
      if (a && !b) A.toCover++;
      else A.toLb++;
      const bbox = bboxOf(s),
        ns = stats.segs[s] || 0;
      moves.push({
        asset: entry.name,
        size: N,
        row: s,
        dir: a ? 'LB→cover' : 'cover→LB',
        types: typeStr(stats.types[s]),
        segs: ns,
        cross: stats.cross[s],
        bboxPx2: bbox * k2,
        px2PerSeg: ns ? (bbox * k2) / ns : 0,
        floor: minPx2PerSegFor(meta, st, s, stats, false, false),
        verts: (packed[s] && packed[s].vertexCount) | 0,
      });
    }

    // NO-AA: the same corpus with the draw's fill edges proven stroke-covered.
    //
    // The default arm is NOT "the same rule with a no-AA flag" — it is the ROUTE-LEVEL veto in
    // _staticRouteWanted, which has two answers for the whole bundle and picks between them on
    // whether SOME row is a recognized primitive: a bundle with one routes and every picked row
    // draws its mesh, a bundle with none declines the route entirely. That is what is modelled
    // here, because it is what the veto does.
    if (NOAA && (NOAA_ALL || bundle.noAaFill)) {
      A.hardEligible++;
      const anyPrim = packed.some((m) => m && m.prim);
      globalThis.__LB_SIZE_TERM = 'off';
      const hShipPicks = lbShapePicks(rendererAt(N, false, false), fresh(bundle), packed);
      globalThis.__LB_SIZE_TERM = 'on';
      const hShip = anyPrim && hShipPicks ? hShipPicks.reduce((x, v) => x + v, 0) : 0;
      const hSizePicks = lbShapePicks(rendererAt(N, true, false), fresh(bundle), packed);
      const hSize = hSizePicks ? hSizePicks.reduce((x, v) => x + v, 0) : 0;
      A.hardPickShipped += hShip;
      A.hardPickSized += hSize;
      if (anyPrim) A.hardPrimBundles++;
      if (hShip !== hSize) {
        A.hardMoved++;
        hardMoves.push({
          asset: entry.name,
          size: N,
          anyPrim,
          from: hShip,
          to: hSize,
          rows: fillRows,
        });
      }
    }
  }
}

console.log(`built ${built} assets, skipped ${skipped}\n`);

// ── SIZE TERM ────────────────────────────────────────────────────────────────────────────────────────
console.log('SIZE TERM  the on-screen size term: rows taking their Loop-Blinn mesh');
console.log(
  '  size | fill rows | buildable | picks default | picks sized |  LB→cover | cover→LB | assets with no pick: default → sized',
);
for (const N of SIZES) {
  const A = perSize.get(N);
  console.log(
    `  ${String(N).padStart(4)} | ${String(A.fillRows).padStart(9)} | ${String(A.buildRows).padStart(9)} ` +
      `| ${String(A.pickShipped).padStart(13)} | ${String(A.pickSized).padStart(11)} ` +
      `| ${String(A.toCover).padStart(9)} | ${String(A.toLb).padStart(8)} | ${String(A.zeroShip).padStart(21)} → ${A.zeroSized} (${A.routeLost} newly)`,
  );
}

const byAsset = new Map();
for (const m of moves) {
  const k = `${m.asset}@${m.size}`;
  const e = byAsset.get(k) || { asset: m.asset, size: m.size, toCover: 0, toLb: 0, worst: null };
  if (m.dir === 'LB→cover') e.toCover++;
  else e.toLb++;
  if (!e.worst || m.bboxPx2 > e.worst.bboxPx2) e.worst = m;
  byAsset.set(k, e);
}
// HOW DECISIVE IS THE TERM ON THE ROWS IT MOVES? A rule whose movers all sit within a few percent
// of its bar is a rule the bar's exact value decides, and this corpus cannot say what that value
// should be -- only a GPU A/B can. A rule whose movers are an order of magnitude below it is saying
// something the constant's exact value does not change.
if (moves.length) {
  const BINS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
  const hist = new Array(BINS.length + 1).fill(0);
  for (const m of moves) {
    const r = m.floor > 0 && Number.isFinite(m.floor) ? m.px2PerSeg / m.floor : 0;
    let i = 0;
    while (i < BINS.length && r > BINS[i]) i++;
    hist[i]++;
  }
  console.log('\n  how far the moved rows sit below the floor (px²/seg as a fraction of it)');
  const lo = ['0', ...BINS.map(String)];
  console.log(
    '  ' +
      BINS.map((b, i) => `≤${b}`)
        .join('  ')
        .padEnd(2) +
      '   >1',
  );
  console.log('  ' + hist.map((h) => String(h)).join('   '));
}

if (lostRoute.length) {
  console.log(
    '\n  assets whose LAST pick goes, so the analytic route declines the bundle entirely',
  );
  for (const m of lostRoute.sort((a, b) => a.size - b.size || b.was - a.was)) {
    console.log(
      `  ${m.asset.padEnd(48).slice(0, 48)} @${String(m.size).padStart(4)}   ${m.was} pick(s) of ${m.rows} fill row(s)`,
    );
  }
} else {
  console.log('\n  no asset loses its last pick at any size measured');
}

const top = [...byAsset.values()]
  .sort((a, b) => b.toCover + b.toLb - (a.toCover + a.toLb))
  .slice(0, ROWS);
if (top.length) {
  console.log('\n  which assets move, and the largest moving row in each');
  console.log(
    '  asset                                        size  →cover  →LB  | row  types       segs  cross   bbox px²   px²/seg   floor',
  );
  for (const e of top) {
    const w = e.worst;
    console.log(
      `  ${e.asset.padEnd(44).slice(0, 44)} ${String(e.size).padStart(4)}  ${String(e.toCover).padStart(6)}  ${String(e.toLb).padStart(3)} ` +
        `| ${String(w.row).padStart(3)}  ${w.types.padEnd(11)} ${String(w.segs).padStart(4)}  ${w.cross.toFixed(2).padStart(5)} ` +
        ` ${w.bboxPx2.toFixed(0).padStart(9)} ${w.px2PerSeg.toFixed(1).padStart(9)} ${(Number.isFinite(w.floor) ? w.floor.toFixed(1) : 'inf').padStart(7)}`,
    );
  }
}

// ── NO-AA ────────────────────────────────────────────────────────────────────────────────────────
if (NOAA) {
  console.log(
    '\nNO-AA  the same corpus with every fill edge proven stroke-covered (preferNoAa true)',
  );
  console.log(
    `  ${NOAA_ALL ? 'SENSITIVITY: the proof FORCED on every asset' : "the assets that carry the importer's noAaFill proof"}`,
  );
  console.log(
    '  size | eligible | rows drawing a mesh, default veto | ...with the per-row floor | moved | holding a primitive',
  );
  for (const N of SIZES) {
    const A = perSize.get(N);
    console.log(
      `  ${String(N).padStart(4)} | ${String(A.hardEligible).padStart(8)} | ${String(A.hardPickShipped).padStart(32)} ` +
        `| ${String(A.hardPickSized).padStart(25)} | ${String(A.hardMoved).padStart(5)} | ${String(A.hardPrimBundles).padStart(18)}`,
    );
  }
  const A0 = perSize.get(SIZES[0]);
  console.log(
    `\n  the population any of this can reach AT ALL: ${A0.noAaFill} of ${A0.assets} assets import with EVERY`,
  );
  console.log(
    `  fill stroke-covered (noAaFill) and ${A0.noAaMixed} with SOME row covered (noAaMixed) -- and none of it`,
  );
  console.log(
    "  is reachable under the default, which gives aacFill no value at all (kernel 'slug').",
  );
  if (hardMoves.length) {
    console.log(
      '\n  asset                                        size  prim?  rows drawing a mesh: default → per-row   fill rows',
    );
    for (const m of hardMoves
      .sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to))
      .slice(0, ROWS)) {
      console.log(
        `  ${m.asset.padEnd(44).slice(0, 44)} ${String(m.size).padStart(4)}  ${(m.anyPrim ? 'yes' : 'no').padStart(5)}  ` +
          `${String(m.from).padStart(37)} → ${String(m.to).padEnd(6)} ${String(m.rows).padStart(9)}`,
      );
    }
  }
}

if (CSV) {
  const head = 'kind,asset,size,row,dir,types,segs,cross,bboxPx2,px2PerSeg,floor,verts\n';
  const rows = moves
    .map(
      (m) =>
        `lb,${m.asset},${m.size},${m.row},${m.dir},${m.types},${m.segs},${m.cross.toFixed(4)},` +
        `${m.bboxPx2.toFixed(3)},${m.px2PerSeg.toFixed(3)},${m.floor},${m.verts}`,
    )
    .join('\n');
  writeFileSync(CSV, head + rows + '\n');
  console.log(`\nwrote ${CSV} (${moves.length} row moves)`);
}
