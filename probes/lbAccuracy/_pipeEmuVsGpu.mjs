// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _pipeEmuVsGpu — hold the GPU's readback against the whole-LB-pipeline emulator (test/_lbPipeEmu.mjs), pixel by
// pixel, under both derivative conventions. The GPU side comes from `_gpuModelCheck.mjs` run with DUMP=1 (which writes
// probes/_lbPipeOut/gpu_<asset>_<N>.json); this side needs no GPU.
//
// For each dump: the emulator's coverage with FINE and with COARSE derivatives (the only choice a GPU makes that the
// emulator cannot know in advance), and fine with vertices snapped to a 1/256 subpixel grid as a GPU snaps them, each
// compared with the GPU outside the twin's knife-edge set, and the kinds that painted each disagreeing pixel. ANGLE on
// Metal reads fine and snapped: squares 1.5 px's 4-px kind-10 residual is its vertex snap. The convention that reads ~0 is the GPU's; a residual in both is something the GPU
// does that the emulator does not model (vertex snapping, fast-math, a driver's own rasterization rule).
//
//   node probes/lbAccuracy/_pipeEmuVsGpu.mjs [dump.json ...]      (default: every gpu_*.json in probes/_lbPipeOut)
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lbScene, renderScene, compositeAlpha } from '../../test/_lbPipeScene.mjs';
import { shapesOf, viewOf, buildMesh, fragileMask } from './_lbRaster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'probes/_lbPipeOut');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(OUT)
      .filter((f) => /^gpu_.*\.json$/.test(f))
      .map((f) => path.join(OUT, f));
if (!files.length) {
  console.log('no GPU dumps: run  GPU=1 DUMP=1 node probes/lbAccuracy/_gpuModelCheck.mjs  first');
  process.exit(2);
}
console.warn = () => {};
const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
// FRAG=path runs another generated fragment text (the one the GPU ran, when the tree has moved on since the dump).
const FT = readFileSync(
  process.env.FRAG || path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
for (const f of files) {
  const d = JSON.parse(readFileSync(f, 'utf8')),
    N = d.N,
    gpu = d.cov;
  const { shapes, bbox } = await shapesOf(await importSvg(d.svg), { rows: 'fill' });
  const view = viewOf(bbox, N),
    pks = [];
  for (const sh of shapes) {
    const b = await buildMesh(sh);
    if (b) pks.push(b.pk);
  }
  const fr = fragileMask(pks, view, undefined, {});
  const sc = await lbScene(d.svg, { N });
  console.log(`\n${d.name} @ ${N} px (the GPU drew: ${d.drew}); knife-edge set ${fr.n} px`);
  for (const [coarse, snap] of [
    [false, 0],
    [true, 0],
    [false, 256],
  ]) {
    const r = renderScene(sc, VT, FT, [], { coarse, snap });
    const emu = compositeAlpha(r.recs, N);
    // The kinds that painted each pixel, for attribution.
    const ko = r.vert.outOff[r.vert.io.outs.findIndex((o) => o.name === 'vKind')];
    const kindsAt = new Map();
    for (let q = 0; q < r.recs.length / 9; q++) {
      if (r.recs[q * 9 + 7] === 1) continue;
      const k = (r.recs[q * 9 + 2] | 0) * N + (r.recs[q * 9 + 1] | 0),
        t = r.recs[q * 9] | 0;
      const e = sc.entries[sc.entryOfTri[t]];
      const kind =
        e && e.kind === 'cover'
          ? 'cover'
          : String(Math.floor(r.vOut[(t * 3 + 2) * r.vert.outN + ko] + 1e-4));
      (kindsAt.get(k) || kindsAt.set(k, new Set()).get(k)).add(kind);
    }
    let bad = 0,
      max = 0,
      sum = 0,
      at = -1;
    const byKind = {};
    for (let k = 0; k < emu.length; k++) {
      const dd = Math.abs(emu[k] - gpu[k]) * 255;
      sum += dd;
      if (fr.mask[k]) continue;
      if (dd > max) {
        max = dd;
        at = k;
      }
      if (dd > 4) {
        bad++;
        const ks = [...(kindsAt.get(k) || ['none'])].sort().join('+');
        byKind[ks] = (byKind[ks] || 0) + 1;
      }
    }
    console.log(
      `  ${coarse ? 'coarse' : 'fine  '} derivatives${snap ? `, vertices snapped to 1/${snap} px` : ''}: mean ${(sum / emu.length).toFixed(3)}/255; OUTSIDE the knife-edge set ${bad} px off by more than 4/255, max ${max.toFixed(1)}/255` +
        (at >= 0 ? ` at (${at % N},${(at / N) | 0})` : '') +
        (bad ? `; painted by ${JSON.stringify(byKind)}` : ''),
    );
  }
}
