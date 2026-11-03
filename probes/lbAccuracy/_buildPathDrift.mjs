// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _buildPathDrift — the two Loop-Blinn build paths do not build the same mesh.
//
// `lbBuildCore.buildLbShape` (the worker, and the sync fallback where Workers are unavailable) says
// of itself: "Because it is the ONE place the per-shape route (fast-earcut vs CDT vs Slug) is
// decided, the worker and the fallback can never drift. Mirrors the per-shape body of morphDraw.js
// `_ensureLbMeshes`." The main thread's `_ensureLbMeshes` is the OTHER build path, `prepareBundle`
// runs it synchronously, and it does not mirror that body: this is a comment asserting a contract
// nothing implements.
//
// THE DIVERGENCE IS ONE GATE. buildLbShape routes a single-contour CUBIC shape to the CDT
// partition FIRST (`contoursHaveCubic`, added because the partition lands 0.0033 mean coverage
// error against the fast path's 0.0136, out of a quarter the primitives); `_ensureLbMeshes` has no
// such gate and offers every single-contour opaque shape to the earcut fast path first. On tiger
// that is 39 of 304 shapes -- 12.8% -- built as a DIFFERENT MESH depending on which builder ran,
// with 2-3x the vertex count on the main-thread side. Neither declines; both draw.
//
// WHICH ONE THE FRAME GETS IS A RACE. createBundle hands the bundle to the worker; prepareBundle
// builds the whole thing on the main thread; `_applyLbPartial` refuses to publish over a complete
// main-thread set, but `_applyLbResult` -- the worker's FINAL message -- publishes unconditionally
// (morphDraw.js `claimFillMeshes(bundle, MESH_OWNER.LB, packed)`). So an early frame draws the
// main-thread routing and a later one draws the worker's, for the same geometry at the same size.
// `awaitLbReady` waits for full quality, which is why a probe that awaits it measures the WORKER's
// mesh and a probe that does not may measure either.
//
//   node probes/lbAccuracy/_buildPathDrift.mjs [file.svg ...]
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { loadSvg, shapesOf, ROOT } from './_lbRaster.mjs';

console.warn = () => {};
const core = await import('../../src/renderer/lbBuildCore.js');
const LB = await import('../../src/renderer/loopBlinn.js');

/// The per-shape body of morphDraw.js `_ensureLbMeshes`, with its caches, budgets and build gate
/// removed — the ROUTE only, which is the thing that differs.
function mainThreadBuild(contours, transSolid, evenodd) {
  const mfr = evenodd ? 'evenodd' : 'nonzero';
  if (
    !core.contoursAllStraight(contours) ||
    transSolid ||
    contours.length > 1 ||
    core.hasDisjointContours(contours)
  ) {
    // NO `contoursHaveCubic` GATE — this is the divergence.
    if (!transSolid && contours.length === 1) {
      let m = null;
      try {
        m = LB.buildLoopBlinnMesh(contours, true, mfr);
      } catch {
        m = null;
      }
      if (core.fastMeshAccepted(m, contours)) {
        LB.dropDegenerateFaces(m);
        return { pk: LB.packLoopBlinnMesh(m), via: 'fast' };
      }
    }
    let cdt = null;
    try {
      cdt = LB.buildLoopBlinnCDT(contours, { fillRule: mfr, transSolid });
    } catch {
      cdt = null;
    }
    if (core.cdtMeshAccepted(cdt)) {
      LB.dropDegenerateFaces(cdt);
      return { pk: LB.packLoopBlinnMesh(cdt), via: 'cdt' };
    }
    return null;
  }
  let mesh = null;
  try {
    mesh = LB.buildLoopBlinnMesh(contours, true, mfr);
  } catch {
    mesh = null;
  }
  if (mesh && mesh.fallback.length) mesh = null;
  if (!mesh) {
    // ...and a second one: the straight-contour CDT retry, which buildLbShape does not have.
    let c9 = null;
    try {
      c9 = LB.buildLoopBlinnCDT(contours, { fillRule: mfr });
    } catch {
      c9 = null;
    }
    if (core.cdtMeshAccepted(c9) && c9.interior && c9.interior.length) mesh = c9;
  }
  if (!mesh) return null;
  LB.dropDegenerateFaces(mesh);
  return { pk: LB.packLoopBlinnMesh(mesh), via: 'straight' };
}

const hashPk = (pk) => {
  if (!pk || !pk.vertexCount) return 'SLUG';
  let h = 0x811c9dc5 >>> 0;
  const u = new Uint8Array(pk.verts.buffer, pk.verts.byteOffset, pk.vertexCount * 24 * 4);
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return pk.vertexCount + ':' + h.toString(16);
};

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
  nSame = 0,
  nDiff = 0,
  nRouteFlip = 0,
  vW = 0,
  vM = 0;
const byAsset = new Map();
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
  let hits = 0;
  for (const sh of shapes) {
    let w = null,
      m = null;
    try {
      w = core.buildLbShape(sh.contours, sh.transSolid, sh.evenOdd);
    } catch {
      w = null;
    }
    try {
      m = mainThreadBuild(sh.contours, sh.transSolid, sh.evenOdd);
    } catch {
      m = null;
    }
    if (w && w.pk && w.pk.fallback && w.pk.fallback.length) w = null;
    if (!w && !m) continue;
    nShapes++;
    const hw = hashPk(w && w.pk),
      hm = hashPk(m && m.pk);
    if (hw === hm) {
      nSame++;
      continue;
    }
    nDiff++;
    hits++;
    if ((hw === 'SLUG') !== (hm === 'SLUG')) nRouteFlip++;
    vW += (w && w.pk && w.pk.vertexCount) || 0;
    vM += (m && m.pk && m.pk.vertexCount) || 0;
    if (hits <= 6)
      console.log(
        `  ${f.split('/').pop()} #${sh.s}  worker ${hw}  main ${hm}${m ? ' via ' + m.via : ''}`,
      );
  }
  if (hits) byAsset.set(f, hits);
}
console.log(
  `\n  ${nShapes} shapes with a mesh on at least one path: ${nSame} identical, ${nDiff} DIFFER` +
    ` (${((100 * nDiff) / Math.max(1, nShapes)).toFixed(2)}%), of which ${nRouteFlip} differ on whether there is a mesh at all`,
);
console.log(
  `  on the differing shapes the worker packs ${vW} verts and the main thread ${vM}` +
    ` (${(vM / Math.max(1, vW)).toFixed(2)}x)`,
);
for (const [f, n] of [...byAsset].sort((a, b) => b[1] - a[1]).slice(0, 10))
  console.log(`    ${f}: ${n}`);
console.log(`
  THIS IS NOT A PROBE FAULT AND IT IS NOT A TIE-BREAK. Both meshes draw, so the picture depends on
  which builder finished first, for the same geometry at the same size. The gate buildLbShape
  carries is the one whose comment argues for it, so the main-thread body is the stale copy --
  landing that is a ROUTING change and needs the render lane, which is why this probe reports it
  rather than changing it.`);
