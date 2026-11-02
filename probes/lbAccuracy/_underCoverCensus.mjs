// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _underCoverCensus — which shipping LB meshes cover less than half the shape they are for.
//
// `meshUnderCovers` (src/renderer/lbBuildCore.js) exists because buildLoopBlinnMesh can return a
// mesh covering almost none of its shape while reporting no fallback: the fragment shader only ever
// SUBTRACTS coverage, so nothing downstream can recover the missing paint. It rejects only when a
// deliberate OVER-estimate of paintable area is under half the true area, so a passing mesh can
// never have been wrongly rejected.
//
// IT IS only ASKED ON THE FAST-MESH PATH. `fastMeshAccepted` calls it; the CDT / partition-carve
// branch beneath it -- in both build paths, lbBuildCore.buildLbShape and morphDraw._ensureLbMeshes
// -- accepts on `!cdt.fallback.length` alone. This counts what that lets through.
//
//   node probes/lbAccuracy/_underCoverCensus.mjs [file.svg ...]
// With no files it takes examples/*.svg, examples/_bench/*.svg, examples/smoke/*.svg and, when it
// is present, the tiger.
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { loadSvg, shapesOf, buildMesh, ROOT } from './_lbRaster.mjs';

console.warn = () => {};
const { meshUnderCovers } = await import('../../src/renderer/lbBuildCore.js');

let files = process.argv.slice(2);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
  const tiger = '../MantleSamples/Assets/Mantle/tiger.svg';
  if (existsSync(path.resolve(ROOT, tiger))) files.push(tiger);
}

let nShapes = 0,
  nBuilt = 0,
  nUnder = 0,
  nAssets = 0;
const byRoute = {};
for (const f of files) {
  let bundle = null;
  try {
    bundle = await loadSvg(f);
  } catch {
    continue;
  }
  let shapes = [];
  try {
    ({ shapes } = await shapesOf(bundle));
  } catch {
    continue;
  }
  if (!shapes.length) continue;
  nAssets++;
  let hits = 0;
  for (const sh of shapes) {
    nShapes++;
    let built = null;
    try {
      built = await buildMesh(sh);
    } catch {
      built = null;
    }
    if (!built) continue;
    nBuilt++;
    let uc = false;
    try {
      uc = !!meshUnderCovers(built.raw, sh.contours);
    } catch {
      uc = false;
    }
    if (!uc) continue;
    nUnder++;
    hits++;
    const r = built.raw._route || '?';
    byRoute[r] = (byRoute[r] || 0) + 1;
    console.log(
      `  ${f} #${sh.s}  route ${r}  verts ${built.pk.vertexCount}  ` +
        `interiorTris ${(built.raw.interior || []).length / 6}  cubics ${(built.raw.cubics || []).length}  quads ${(built.raw.quads || []).length}`,
    );
  }
  if (hits) console.log(`${f}: ${hits} under-covering`);
}
console.log(`\n${nAssets} assets, ${nShapes} shapes, ${nBuilt} built, ${nUnder} under-covering`);
for (const k of Object.keys(byRoute).sort()) console.log(`  route ${k}: ${byRoute[k]}`);
