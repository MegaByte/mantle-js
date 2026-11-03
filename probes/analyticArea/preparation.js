// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Browser-main-thread timing of the package importer. Prepared static AAC
// (importSvg({analyticArea:true}), areaMonotone, MANTLE_AREA_MONOTONE) is
// not a package route. This probe does not restore or require it.
import { importSvg, createBundle } from '../../src/index.js';
const now = () => performance.now();
export async function measurePreparation(gl, r, config) {
  r.__setProbeUnified(false);
  r.setFillEngine({ route: 'none', kernel: 'aac' });
  const rows = [];
  for (const input of config.inputs) {
    const samples = [];
    for (let round = 0; round < (config.rounds || 7); round++) {
      const start = now(),
        rec = { round, candidate: false, preparedAac: 'not-shipped' };
      let t = now();
      const sections = await importSvg(input.svg, { preserveViewport: true });
      rec.importMs = now() - t;
      if (sections.areaMonotone) throw Error('Prepared AAC is not part of this release');
      t = now();
      const bundle = createBundle(gl, sections);
      if (input.bbox) bundle.globalBBox = input.bbox.slice();
      r.prepareBundle(bundle);
      rec.uploadSubmitMs = now() - t;
      rec.totalCpuWallMs = now() - start;
      t = now();
      if (!(await window.__gpuFence(gl, 10000))) throw Error('Upload fence failed');
      rec.uploadFenceMs = now() - t;
      rec.readyMs = now() - start;
      if (bundle._fillMeshOwner) throw Error('Unexpected mesh build ' + bundle._fillMeshOwner);
      rec.curveBytes = bundle.curveFloats?.byteLength || 0;
      bundle.dispose();
      samples.push(rec);
      await window.__gpuIdle(1);
    }
    rows.push({ name: input.name, samples });
    console.log('probe: preparation ' + input.name);
  }
  return {
    scope:
      'Browser main thread. Package importer only; prepared AAC is not a package route. Fresh bundles; first round retained as cold input sample',
    preparedAac: 'measured and not shipped',
    rows,
  };
}
