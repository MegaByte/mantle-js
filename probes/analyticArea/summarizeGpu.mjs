// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (name) =>
  JSON.parse(readFileSync(new URL('results/' + name + '.json', import.meta.url)));
const files = [
  'gpu-real-unified-0',
  'gpu-real-unified-1',
  'gpu-real-unified-2',
  'gpu-real-unified-3',
  'gpu-unified-check',
  'gpu-mono-0',
  'gpu-mono-1',
  'gpu-mono-2',
  'gpu-mono-tiger',
  'gpu-tiger-normalized',
  'gpu-overlap-unified',
  'gpu-scene-train',
];
const rows = [];
let areaPixels = 0,
  maxAreaError = 0;
for (const file of files) {
  const d = read(file);
  assert.match(d.device.renderer, /Apple M2 Pro/);
  assert.equal(d.device.timerQuery, true);
  for (const r of d.rows) {
    assert.equal(r.glError, 0);
    const cp = r.arms.find((a) => a.name === 'cpatch'),
      aa = r.arms.find((a) => a.name === 'cpatchAA'),
      area = r.arms.find((a) => a.name === 'areaUnified');
    if (aa) assert.equal(cp.imageHash, aa.imageHash, 'CPatch A/A image mismatch: ' + file);
    const areaAA = r.arms.find((a) => a.name === 'areaAA');
    if (areaAA) assert.equal(area.imageHash, areaAA.imageHash, 'Area A/A image mismatch: ' + file);
    const classic = r.arms.find((a) => a.name === 'areaClassic');
    if (classic)
      assert.equal(area.imageHash, classic.imageHash, 'Unified/classic coverage mismatch');
    for (const a of r.arms) {
      assert(a.rawGpuMs.every((t) => Number.isFinite(t) && t > 0));
      if (a.name === 'areaUnified' || a.name === 'monotone') {
        assert(a.pin.defines.includes('MANTLE_AAC'));
        assert(a.pin.defines.includes('MANTLE_LB_FILL'));
        if (a.quality)
          assert(
            a.quality.maxError <= 1 / 255 + 1e-6,
            'Area sample exceeds 1 byte: ' + file + ' ' + r.name,
          );
      }
    }
    if (file.startsWith('gpu-real-unified') && area?.quality) {
      areaPixels += area.quality.pixels;
      maxAreaError = Math.max(maxAreaError, area.quality.maxError);
    }
    rows.push({
      file,
      name: r.name,
      size: r.size,
      repetitions: r.repetitions,
      cpatchControlDrift: aa ? Math.abs(aa.medianGpuMs / cp.medianGpuMs - 1) : null,
      arms: r.arms.map((a) => ({
        name: a.name,
        gpuMs: a.medianGpuMs,
        wallMs: a.medianMs,
        maxError: a.quality?.maxError,
        versusCP: cp.medianGpuMs / a.medianGpuMs,
      })),
    });
  }
}
const ref = read('gpu-reference');
assert(ref.maxDelta <= 0.0001);
assert(ref.maxReferenceDrift <= 0.0003);
const scene = read('gpu-scene-reference');
for (const p of scene.rows) {
  assert(p.driftBytes <= 1);
  for (const o of p.observed) {
    assert(Math.abs(o.areaByte - p.referenceBytes[o.channel]) <= 1);
    if (o.arm === 'monotone') assert(Math.abs(o.actualByte - p.referenceBytes[o.channel]) <= 1);
  }
}
const report = {
  device: read('gpu-mono-tiger').device,
  areaPixels,
  maxAreaError,
  referencePixels: ref.rows.length,
  referenceMaxDelta: ref.maxDelta,
  sceneReferencePixels: scene.rows.length,
  rows,
};
writeFileSync(
  new URL('results/gpu-summary.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log({
  validatedRows: rows.length,
  areaPixels,
  maxAreaError,
  referencePixels: ref.rows.length,
  sceneReferencePixels: scene.rows.length,
});
