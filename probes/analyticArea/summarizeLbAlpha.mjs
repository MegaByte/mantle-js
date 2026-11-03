// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./results/', import.meta.url),
  load = (f) => JSON.parse(readFileSync(new URL(f, root)));
const rows = [],
  failures = [];
for (let i = 0; i < 9; i++) {
  const file = 'gpu-translucent-' + i + '.json',
    data = load(file);
  if (
    !data.finished ||
    /swiftshader|software/i.test(data.device.renderer) ||
    !data.device.timerQuery
  )
    throw new Error('Invalid GPU run ' + file);
  for (const r of data.rows) {
    if (r.glError) throw new Error('GL error');
    const by = Object.fromEntries(r.arms.map((a) => [a.name, a]));
    for (const engine of ['lb', 'cpatch'])
      if (by[engine].imageHash !== by[engine + 'AA'].imageHash)
        throw new Error('A/A image mismatch');
    for (const a of r.arms) {
      if (!a.pin.ledger[a.engine] || !a.rawGpuMs.every((t) => t > 0))
        throw new Error('Wrong kernel/timer');
      const q = a.colorQuality;
      if (!q) throw new Error('Missing RGBA oracle');
      if (q.maxByte > 1) failures.push({ name: r.name, size: r.size, arm: a.name, ...q });
    }
    rows.push({
      name: r.name,
      size: r.size,
      pixels: by.lb.colorQuality.pixels,
      maxByte: Object.fromEntries(
        r.arms.filter((a) => !a.name.endsWith('AA')).map((a) => [a.name, a.colorQuality.maxByte]),
      ),
      file,
    });
  }
}
const reference = load('gpu-translucent-reference.json');
const output = {
  rows,
  pixels: rows.reduce((s, r) => s + r.pixels, 0),
  referencePixels: reference.rows.length,
  areaPasses: rows.every((r) => r.maxByte.areaUnified <= 1),
  failures,
};
writeFileSync(new URL('gpu-lb-alpha-summary.json', root), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ ...output, failures: failures.length }, null, 2));
if (!output.areaPasses) throw new Error('Area candidate exceeded the one-byte RGBA threshold');
