// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Check complete-artwork disagreement pixels against the original raw fill rule.
// This is sparse validation, not a full-image oracle. Per-shape area is numerically
// integrated before ordinary source-over composition in original paint order.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { rowSpans } = await import('../../src/renderer/cpatchConvert.js');
const L = await import('../../src/bundle/layout.js');
const [input, output] = process.argv.slice(2),
  data = JSON.parse(readFileSync(input)),
  rows = [];
const slices = +(process.env.SLICES || 8192);
for (const row of data.rows) {
  const c = data.config.cases.find((c) => c.size === row.size && c.name === row.name);
  if (!c) throw Error('No matching reference case ' + row.name);
  const sec = await importSvg(c.referenceSvg || c.svg),
    b = headlessCPatchBundle(sec),
    cf = cpatchCurvePlane(b);
  const shapes = b.curveRangesByShape.map((r, i) => {
    const m = b.metaFloats.subarray(i * b.metaFloatsPerShape, (i + 1) * b.metaFloatsPerShape);
    for (const key of [
      'META_STROKE_A',
      'META_FILL_GRAD',
      'META_CLIP_ID',
      'META_MASK_ID',
      'META_FILTER_ID',
      'META_BLEND_MODE',
      'META_ISOLATION',
      'META_IMAGE_ID',
      'META_COLR_GRAPH',
    ])
      if (m[L[key]]) throw new Error('Unsupported ' + key + ' on shape ' + i);
    return {
      raw: contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null)?.flat() || [],
      color: Array.from(m.subarray(L.META_FILL_R, L.META_FILL_A + 1)),
      bb: Array.from(m.subarray(0, 4)),
      eo: shapeEvenOdd(b, i),
    };
  });
  const [bx, by, bw, bh] = c.bbox,
    step = Math.max(bw, bh) / row.size;
  const pixels = new Map();
  for (const d of row.comparisons || []) {
    const points = d.overOne ?? (d.worst ? [d.worst] : []);
    for (const q of points) {
      const key = q.x + ',' + q.y,
        p = pixels.get(key) || { x: q.x, y: q.y, observed: [] };
      p.observed.push({
        arm: d.arm,
        ...(q.baseRGBA
          ? { areaBytes: q.baseRGBA, actualBytes: q.actualRGBA }
          : { channel: q.channel, areaByte: q.base, actualByte: q.actual }),
      });
      pixels.set(key, p);
    }
  }
  for (const [x, y] of c.referencePixels || []) {
    const key = x + ',' + y,
      p = pixels.get(key) || { x, y, observed: [] };
    for (const arm of row.arms) {
      const at = ((row.size - 1 - y) * row.size + x) * 4;
      const actualBytes = arm.rgba
        ? arm.rgba.slice(at, at + 4)
        : arm.referencePixels?.find((p) => p.x === x && p.y === y)?.rgba;
      if (!actualBytes) throw Error('Requested reference pixels need captured GPU RGBA');
      p.observed.push({ arm: arm.name, actualBytes });
    }
    pixels.set(key, p);
  }
  for (const p of pixels.values()) {
    const x = bx + bw / 2 + (p.x - row.size / 2) * step,
      y = by + bh / 2 + (p.y - row.size / 2) * step;
    const compose = (n) => {
      let rgba = [0, 0, 0, 0];
      for (const s of shapes) {
        if (
          !s.color[3] ||
          s.bb[2] <= x ||
          s.bb[0] >= x + step ||
          s.bb[3] <= y ||
          s.bb[1] >= y + step
        )
          continue;
        let area = 0;
        for (let j = 0; j < n; j++)
          for (const [a, z] of rowSpans(s.raw, y + ((j + 0.5) * step) / n, s.eo))
            area += Math.max(0, Math.min(z, x + step) - Math.max(a, x));
        const alpha = Math.max(0, Math.min(1, area / (step * n))) * s.color[3];
        rgba = rgba.map(
          (v, k) => Math.round(255 * ((k === 3 ? 1 : s.color[k]) * alpha + v * (1 - alpha))) / 255,
        );
      }
      return rgba.map((v) => Math.round(255 * v * (c.pieceGroupAlpha ?? 1)));
    };
    const referenceBytes = compose(slices),
      coarse = compose(slices / 4);
    rows.push({
      name: row.name,
      size: row.size,
      ...p,
      referenceBytes,
      coarseBytes: coarse,
      driftBytes: Math.max(...referenceBytes.map((v, k) => Math.abs(v - coarse[k]))),
    });
  }
}
writeFileSync(
  output,
  JSON.stringify(
    {
      slices,
      scope:
        'Captured full-image disagreement pixels; rounded per-shape source-over; raw fill-rule y integration. Sparse validation, not a full-image oracle.',
      rows,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify(
    {
      pixels: rows.length,
      maxDriftBytes: Math.max(0, ...rows.map((r) => r.driftBytes)),
      arms: [...new Set(rows.flatMap((r) => r.observed.map((o) => o.arm)))].map((arm) => ({
        arm,
        maxErrorBytes: Math.max(
          0,
          ...rows.flatMap((r) =>
            r.observed
              .filter((o) => o.arm === arm)
              .map((o) =>
                o.actualBytes
                  ? Math.max(...o.actualBytes.map((v, k) => Math.abs(v - r.referenceBytes[k])))
                  : Math.abs(o.actualByte - r.referenceBytes[o.channel]),
              ),
          ),
        ),
      })),
    },
    null,
    2,
  ),
);
