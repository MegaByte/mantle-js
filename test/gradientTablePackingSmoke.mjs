// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Production CPU gradient packing; shader sampling belongs to accuracy diagnostics.
import assert from 'node:assert/strict';
import { buildGradientTables, packGradientStops, parseGradients } from '../src/svg/gradient.js';
import { setDiagnostics } from '../src/core/diagnostics.js';
const grad = (stops) => ({
  gtype: 0,
  spread: 0,
  units: 0,
  gradient_transform: [1, 0, 0, 1, 0, 0],
  x1: 0,
  y1: 0,
  x2: 1,
  y2: 0,
  stops,
});
const p = packGradientStops({
  stops: [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 0.3, color: [0, 1, 0, 0.5] },
    { offset: 1, color: [0, 0, 1, 1] },
  ],
});
// 0.3 is not a multiple of 1/255, so its offset takes the 24-bit form (76, 127, 128 = 0.3 to 1/255^3), not the byte 77
assert.deepEqual(
  [...p],
  [255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128, 76, 127, 128, 0, 0, 0, 255, 255, 255, 0, 0, 0],
);
for (const n of [256, 600]) {
  const stops = Array.from({ length: n }, (_, i) => ({
    offset: i / (n - 1),
    color: [i / (n - 1), 0, 0, 1],
  }));
  const t = buildGradientTables([grad(stops)]),
    f = new Float32Array(t.records.buffer, t.records.byteOffset);
  assert.equal(f[11], n === 256 ? -256 : 600);
}
const warnings = [];
setDiagnostics({ onWarn: (message) => warnings.push(String(message)) });
try {
  const stops = Array.from({ length: 70000 }, (_, i) => ({
    offset: i / 69999,
    color: [0, 0, 0, 0.5],
  }));
  assert.equal(packGradientStops({ stops }).length, 65536 * 8);
  assert.ok(warnings.some((w) => /65536/.test(w)));
} finally {
  setDiagnostics({ onWarn: null });
}
const { DOMParser } = await import('@xmldom/xmldom');
for (const unit of ['96px', '1in', '25.4mm', '2.54cm', '72pt', '6pc', '101.6Q']) {
  for (const coordinate of ['default', 'percent', 'absolute', 'radial']) {
    const tag = coordinate === 'radial' ? 'radialGradient' : 'linearGradient';
    const attrs =
      coordinate === 'radial'
        ? `cx="0" cy="0" r="${unit}" fx="0" fy="0"`
        : coordinate === 'absolute'
          ? `x2="${unit}"`
          : coordinate === 'percent'
            ? 'x2="100%"'
            : '';
    const root = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${unit}" height="${unit}"><${tag} id="g" gradientUnits="userSpaceOnUse" ${attrs}/></svg>`,
      'image/svg+xml',
    ).documentElement;
    const g = parseGradients(root).g;
    assert.ok(
      Math.abs((coordinate === 'radial' ? g.r : g.x2) - 96) < 1e-10,
      `${unit} ${coordinate}`,
    );
  }
}
console.log('GRADIENT-TABLE-PACKING PASS');
