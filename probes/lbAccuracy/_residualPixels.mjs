// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _residualPixels — attribute a GPU-vs-emulator residual pixel by pixel (e.g. squares 1.5 px, 4 px off under both
// derivative conventions, max 41.1/255, all painted by kind 10). For each pixel off by more than 4/255 outside the
// knife-edge set: the GPU's coverage, the emulator's composite and every fragment behind it (shape, triangle, kind,
// coverage or discard), the exact coverage of each shape there, and whether the pixel moves when the emulator snaps
// vertices to a 1/256 or 1/16 subpixel grid as a GPU does.
//
//   node probes/lbAccuracy/_residualPixels.mjs gpu_<asset>_<N>.json
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lbScene, renderScene, compositeAlpha } from '../../test/_lbPipeScene.mjs';
import { shapesOf, viewOf, buildMesh, fragileMask } from './_lbRaster.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};
const d = JSON.parse(readFileSync(process.argv[2], 'utf8')),
  N = d.N,
  gpu = d.cov;
const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const bundle = await importSvg(d.svg);
const { shapes, bbox } = await shapesOf(bundle, { rows: 'fill' });
const view = viewOf(bbox, N),
  pks = [];
for (const sh of shapes) {
  const b = await buildMesh(sh);
  if (b) pks.push(b.pk);
}
const fr = fragileMask(pks, view, undefined, {});
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const FT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const sc = await lbScene(d.svg, { N });
const runs = {};
for (const snap of [0, 256, 16]) {
  const r = renderScene(sc, VT, FT, [], { snap });
  runs[snap] = { r, cov: compositeAlpha(r.recs, N) };
}
const base = runs[0];
const ko = base.r.vert.outOff[base.r.vert.io.outs.findIndex((o) => o.name === 'vKind')];
const { rowSpans, contoursToConverter, closed } = await refKit();
const exactOf = (s, i, j) => {
  const sh = shapes.find((x) => x.s === s);
  return sh
    ? exactCov(
        rowSpans,
        closed(contoursToConverter(sh.contours, null)),
        i,
        j,
        view,
        64,
        sh.evenOdd,
        new Map(),
      )
    : NaN;
};
console.log(`${d.name} @ ${N} px: knife-edge set ${fr.n} px`);
for (const snap of [0, 256, 16]) {
  let bad = 0,
    max = 0;
  for (let k = 0; k < gpu.length; k++) {
    if (fr.mask[k]) continue;
    const e = Math.abs(runs[snap].cov[k] - gpu[k]) * 255;
    if (e > 4) bad++;
    if (e > max) max = e;
  }
  console.log(
    `  emulator${snap ? ` snapped to 1/${snap} px` : ' (no snap)'}: ${bad} px off the GPU by more than 4/255 outside the knife-edge set, max ${max.toFixed(1)}/255`,
  );
}
for (let k = 0; k < gpu.length; k++) {
  if (fr.mask[k]) continue;
  const e = Math.abs(base.cov[k] - gpu[k]) * 255;
  if (e <= 4) continue;
  const i = k % N,
    j = (k / N) | 0;
  console.log(
    `\n  pixel (${i},${j}): GPU ${(gpu[k] * 255).toFixed(1)}  emulator ${(base.cov[k] * 255).toFixed(1)}  snapped 1/256 ${(runs[256].cov[k] * 255).toFixed(1)}  1/16 ${(runs[16].cov[k] * 255).toFixed(1)}`,
  );
  const seen = new Set();
  for (let q = 0; q < base.r.recs.length / 9; q++) {
    const R = base.r.recs;
    if ((R[q * 9 + 1] | 0) !== i || (R[q * 9 + 2] | 0) !== j) continue;
    const t = R[q * 9] | 0,
      en = sc.entries[sc.entryOfTri[t]],
      kind = Math.round(base.r.vOut[(t * 3 + 2) * base.r.vert.outN + ko] * 4) / 4;
    seen.add(en.shapeIdx);
    console.log(
      `    shape ${en.shapeIdx} tri ${(t * 3 - en.vStart) / 3} kind ${kind}: ${R[q * 9 + 7] ? 'discard' : (R[q * 9 + 6] * 255).toFixed(1)}`,
    );
  }
  for (const s of seen)
    console.log(`    exact coverage of shape ${s}: ${(exactOf(s, i, j) * 255).toFixed(1)}`);
}
