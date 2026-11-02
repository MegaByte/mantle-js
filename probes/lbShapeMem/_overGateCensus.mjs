// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _overGateCensus — the shapes a 4000-curve-float complexity gate would turn away, what they cost,
// and what they render as. The renderer has no such gate.
//
// Such a gate is a proxy for build TIME. This prices the proxy: for every asset in the tree it counts
// the shapes over the bar, then for each one reports the build time, the vertex count, the
// packed bytes and the whole-bundle verdict. The two things worth reading off it are that neither
// time nor bytes is monotone in the float count, and that every one of these shapes builds.
//
// Usage:  node probes/lbShapeMem/_overGateCensus.mjs [--build]   (--build is the default; --census
//         only counts, for a tree whose monsters are too slow to build in a probe)
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';

globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const REPO = path.resolve(PKG, '..');
const { default: importSvg } = await import(PKG + '/src/svg/importer.js');
const { buildLbBundle, lbMeshCensus } = await import(PKG + '/src/renderer/lbBuildCore.js');
const { parseMetaBin } = await import(PKG + '/src/core/metaBin.js');

const OLD_GATE = 4000; // the curve-float bar a complexity gate would apply
const doBuild = !process.argv.includes('--census');

const dirs = [
  path.join(REPO, 'MantleSamples/Assets/Mantle'),
  path.join(PKG, 'examples/smoke'),
  path.join(PKG, 'examples'),
];
const files = [];
for (const d of dirs) {
  let ents = [];
  try {
    ents = readdirSync(d);
  } catch {
    continue;
  }
  for (const e of ents) if (e.endsWith('.svg')) files.push(path.join(d, e));
}

let assets = 0,
  shapes = 0;
const over = [];
for (const f of files) {
  let sec;
  try {
    sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  } catch {
    continue;
  }
  assets++;
  const rs = sec.curveRangesByShape || [];
  for (let s = 0; s < (sec.numShapes | 0); s++) {
    const r = rs[s];
    if (!r || r.end <= r.begin) continue;
    shapes++;
    if (r.end - r.begin > OLD_GATE)
      over.push({ file: f, s, n: r.end - r.begin, numShapes: sec.numShapes | 0 });
  }
}
over.sort((a, b) => b.n - a.n);
console.log(
  `${assets} assets, ${shapes} shapes with geometry; ${over.length} over the removed ${OLD_GATE}-float gate`,
);

for (const row of over) {
  if (!doBuild) {
    console.log(`  ${String(row.n).padStart(7)}  ${path.basename(row.file)} #${row.s}`);
    continue;
  }
  const sec = await importSvg(readFileSync(row.file, 'utf8'), { preserveViewport: true });
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const t0 = Date.now();
  const res = buildLbBundle({
    curveFloats: new Float32Array(sec.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: sec.curveRangesByShape,
    numShapes: sec.numShapes,
  });
  const ms = Date.now() - t0;
  const pk = res.packed[row.s];
  const c = lbMeshCensus({ numShapes: sec.numShapes, _lbMeshes: res.packed, _lbSlugWhy: res.why });
  console.log(
    `  ${String(row.n).padStart(7)} floats  ${path.basename(row.file)} #${row.s}` +
      `  bundle build ${ms}ms  ` +
      (pk && !pk.slug && (pk.vertexCount | 0) > 0
        ? `verts ${pk.vertexCount} packed ${pk.verts.byteLength}B`
        : 'NO MESH') +
      `  census ${JSON.stringify(c)}`,
  );
}
