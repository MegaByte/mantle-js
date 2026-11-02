// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independently check worst RGBA pixels against the ORIGINAL raw SVG fill rule,
// using y-slice integration rather than arranged-boundary analytic integrals.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { rowSpans } = await import('../../src/renderer/cpatchConvert.js');
const [output, ...inputs] = process.argv.slice(2),
  rows = [],
  slices = 8192;
for (const input of inputs) {
  const data = JSON.parse(readFileSync(input));
  if (!data.finished) throw new Error('Incomplete run ' + input);
  for (const row of data.rows) {
    const c = data.config.cases.find((c) => c.name === row.name && c.size === row.size),
      ref = c.reference;
    const parts = await Promise.all(
      ref.parts.map(async (p) => {
        const sec = await importSvg(
            `<svg xmlns="http://www.w3.org/2000/svg"><path d="${p.d}"/></svg>`,
          ),
          b = headlessCPatchBundle(sec),
          r = b.curveRangesByShape[0];
        return {
          ...p,
          raw: contoursToConverter(
            curveRangeToContours(cpatchCurvePlane(b), r.begin, r.end),
            null,
          ).flat(),
        };
      }),
    );
    const pixels = new Map();
    for (const a of row.arms) {
      const p = a.colorQuality?.worst;
      if (!p) continue;
      const key = p.x + ',' + p.y,
        obj = pixels.get(key) || { x: p.x, y: p.y, analytic: p.rgba, observed: [] };
      obj.observed.push({ arm: a.name, rgba: p.actual });
      pixels.set(key, obj);
    }
    for (const p of pixels.values()) {
      const step = 128 / row.size,
        x = p.x * step,
        y = p.y * step;
      const calc = (n) => {
        let rgba = [0, 0, 0, 0];
        for (const part of parts) {
          let area = 0;
          for (let j = 0; j < n; j++)
            for (const [lo, hi] of rowSpans(part.raw, y + ((j + 0.5) * step) / n, part.eo))
              area += Math.max(0, Math.min(hi, x + step) - Math.max(lo, x));
          const a = Math.max(0, Math.min(1, area / (step * n))) * ref.opacity * ref.drawAlpha;
          rgba = rgba.map((v, k) =>
            Math.round(255 * ((k === 3 ? 1 : part.color[k]) * a + (v / 255) * (1 - a))),
          );
        }
        return rgba.map((v) => Math.round(v * ref.group));
      };
      const raw = calc(slices),
        coarse = calc(slices / 4),
        delta = Math.max(...raw.map((v, k) => Math.abs(v - p.analytic[k]))),
        drift = Math.max(...raw.map((v, k) => Math.abs(v - coarse[k])));
      if (delta > 1 || drift > 1)
        throw new Error('Reference mismatch ' + JSON.stringify({ name: row.name, p, raw, coarse }));
      rows.push({
        name: row.name,
        size: row.size,
        ...p,
        rawReference: raw,
        coarseReference: coarse,
        delta,
        drift,
      });
    }
  }
}
writeFileSync(output, JSON.stringify({ slices, rows }, null, 2) + '\n');
console.log(
  JSON.stringify({
    pixels: rows.length,
    maxDelta: Math.max(...rows.map((r) => r.delta)),
    maxDrift: Math.max(...rows.map((r) => r.drift)),
  }),
);
