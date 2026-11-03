// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _pickFlips — which rows each engine-selection EXPERIMENT switch would move, over the corpus, on the CPU.
//
//   node probes/flags/_pickFlips.mjs [--sizes 256,1024] [--family all|examples|smoke|bench] [--limit N]
//                                       [--dirs dir,dir]   (more corpora, e.g. the local-only _bench art of a main checkout)
//
// NO GPU, NO TIMING. The default per-shape pick carries the on-screen size term (lbShapePolicy LB_MIN_BUNDLE_PX2: a bundle
// whose fill bboxes cover fewer than 512 x 512 device px2 stays on the cover kernel). This lists, against the size-free pick
// (the term off: `__LB_MIN_BUNDLE_PX2 = 0`), how many rows flip engine and on which assets at each size, so the pick change
// is explicit. Arms are test hooks (`__MANTLE_DEBUG__`); the default pick is the base. For the 'release' arm
// the "cover->LB" column below counts the rows the term moves OFF the mesh onto the cover kernel.
//
// Every pick comes from lbShapePolicy.lbShapePicks itself, through a fresh view of the bundle per arm (the pick cache
// is keyed on the rule signature, but a fresh view keeps one arm from serving another).
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const SIZES = String(arg('sizes', '128,256,512,1024'))
  .split(',')
  .map(Number)
  .filter((v) => v > 0);
const FAMILY = arg('family', 'all');
const LIMIT = +arg('limit', 0) || Infinity;
const DIRS = String(arg('dirs', '')).split(',').filter(Boolean);

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
const { buildLbBundle } = await import('../../src/renderer/lbBuildCore.js');
const { lbShapePicks } = await import('../../src/renderer/lbShapePolicy.js');

// The arms: each a set of globals; the default rule is {}. The first is the size-free pick, the others bracket the bar.
const ARMS = [
  ['release (term off)', { __MANTLE_DEBUG__: true, __LB_MIN_BUNDLE_PX2: 0 }],
  ['bar 65536', { __MANTLE_DEBUG__: true, __LB_MIN_BUNDLE_PX2: 65536 }],
  ['bar 1048576', { __MANTLE_DEBUG__: true, __LB_MIN_BUNDLE_PX2: 1048576 }],
];
const KEYS = [...new Set(ARMS.flatMap(([, g]) => Object.keys(g)))];

function corpus() {
  const out = [];
  const add = (dir, tag) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort())
      if (f.endsWith('.svg')) out.push({ name: `${tag}/${f}`, file: path.join(dir, f) });
  };
  if (FAMILY === 'all' || FAMILY === 'examples') add(path.join(PKG, 'examples'), 'examples');
  if (FAMILY === 'all' || FAMILY === 'bench') add(path.join(PKG, 'examples', '_bench'), 'bench');
  if (FAMILY === 'all' || FAMILY === 'smoke') add(path.join(PKG, 'examples', 'smoke'), 'smoke');
  for (const d of DIRS) add(path.resolve(d), path.basename(path.resolve(d)));
  return out;
}
// unitPx2's stub, as _decisionSurface.mjs: the renderer's own aspect-preserving fit on an N x N canvas.
const rendererAt = (N) => ({
  viewportSize: () => [N, N],
  arScale: (bbox, vw, vh) => {
    const cAR = vw / vh,
      sAR = bbox[2] / bbox[3];
    return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
  },
  draw: {},
  opts: {},
  _lbFillMode: 'auto',
});
const fresh = (b) => ({ ...b, _lbPickCache: null, _lbPickKey: 0, _lbMayPickGen: undefined });

const files = corpus().slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`pick flips: ${files.length} assets, sizes ${SIZES.join('/')}, ${ARMS.length} arms`);
const tally = new Map(
  ARMS.map(([name]) => [name, { rows: 0, toLb: 0, toCover: 0, assets: new Map() }]),
);
let built = 0,
  skipped = 0,
  rowsShipped = 0;
for (const entry of files) {
  let sec, packed;
  try {
    sec = await importSvg(readFileSync(entry.file, 'utf8'), { preserveViewport: true });
    if (!(sec.numShapes > 0) || !sec.curveRangesByShape) {
      skipped++;
      continue;
    }
    const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    const input = {
      curveFloats: new Float32Array(sec.curves),
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: sec.numShapes,
    };
    packed = buildLbBundle(input).packed;
    sec._bundle = {
      curveFloats: input.curveFloats,
      curveRangesByShape: input.ranges,
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      numShapes: sec.numShapes,
      segTypeMask: sec.segTypeMask,
      _geomGen: 0,
      globalBBox: sec.globalBBox,
    };
  } catch {
    skipped++;
    continue;
  }
  built++;
  const bundle = sec._bundle;
  for (const N of SIZES) {
    for (const k of KEYS) delete globalThis[k];
    const base = lbShapePicks(rendererAt(N), fresh(bundle), packed);
    rowsShipped += base ? base.reduce((a, v) => a + v, 0) : 0;
    for (const [name, g] of ARMS) {
      for (const k of KEYS) delete globalThis[k];
      Object.assign(globalThis, g);
      const p = lbShapePicks(rendererAt(N), fresh(bundle), packed);
      let moved = 0,
        toLb = 0;
      for (let s = 0; s < bundle.numShapes; s++) {
        const a = base ? base[s] : 0,
          b = p ? p[s] : 0;
        if (a !== b) {
          moved++;
          if (b) toLb++;
        }
      }
      if (moved) {
        const t = tally.get(name);
        t.rows += moved;
        t.toLb += toLb;
        t.toCover += moved - toLb;
        const key = `${entry.name}@${N}`;
        t.assets.set(key, moved);
      }
    }
  }
}
for (const k of KEYS) delete globalThis[k];
console.log(`built ${built}, skipped ${skipped}; default picks summed over sizes: ${rowsShipped}`);
console.log(
  '  arm                              rows moved   cover->LB   LB->cover   assets@size   most-moved',
);
for (const [name] of ARMS) {
  const t = tally.get(name);
  const top = [...t.assets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  console.log(
    `  ${name.padEnd(32)} ${String(t.rows).padStart(10)} ${String(t.toLb).padStart(11)} ${String(t.toCover).padStart(11)} ${String(t.assets.size).padStart(13)}   ${top || '-'}`,
  );
}
