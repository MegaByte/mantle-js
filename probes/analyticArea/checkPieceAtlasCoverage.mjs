// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independent authored-fill and CPatch-piece areas at GPU atlas readback points.
// This prices neither preparation nor rendering. Keep a coarser convergence check.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const CB = await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { rowSpans } = await import('../../src/renderer/cpatchConvert.js');
const { packPieceAtlas } = await import('./pieceAtlas.js');
const [input, output] = process.argv.slice(2),
  d = JSON.parse(readFileSync(input)),
  rows = [];
const slices = +(process.env.SLICES || 8192);
function curves(b, i, wire = false) {
  const r = b.curveRangesByShape[i];
  return (
    CB.contoursToConverter(
      curveRangeToContours(wire ? b.curveFloats : CB.cpatchCurvePlane(b), r.begin, r.end),
      null,
    )?.flat() || []
  );
}
for (const row of d.rows) {
  const c = d.config.cases.find((c) => c.name === row.name && c.size === row.size);
  const original = CB.headlessCPatchBundle(await importSvg(c.svg, { preserveViewport: true }));
  const atlas = packPieceAtlas(c),
    atlasBundle = CB.headlessCPatchBundle(await importSvg(atlas.svg, { preserveViewport: true }));
  if (atlasBundle.numShapes !== c.pieceGroups.reduce((n, g) => n + g.pieces, 0))
    throw Error('Atlas piece indexing changed');
  const pieces = new Map(),
    [bx, by, bw, bh] = c.bbox,
    step = Math.max(bw, bh) / row.size;
  const area = (cs, eo, x, y, n, cellStep = step) => {
    let sum = 0;
    for (let j = 0; j < n; j++)
      for (const [a, b] of rowSpans(cs, y + ((j + 0.5) * cellStep) / n, eo))
        sum += Math.max(0, Math.min(b, x + cellStep) - Math.max(a, x));
    return sum / (cellStep * n);
  };
  const points = new Map();
  for (const arm of row.arms)
    for (const p of arm.atlasPixels || []) {
      // Fully covered and empty reads cannot explain these small partial errors.
      if (!(p.coverage > 0 && p.coverage < 0.999)) continue;
      const key = [p.x, p.y, p.shape].join(',');
      if (!points.has(key)) points.set(key, { ...p, observed: [] });
      points.get(key).observed.push({ arm: arm.name, coverage: p.coverage });
    }
  for (const p of points.values()) {
    if (!pieces.has(p.shape)) {
      const group = c.pieceGroups.find((g) => g.shape === p.shape),
        b = CB.headlessCPatchBundle(await importSvg(group.svg, { preserveViewport: true }));
      pieces.set(
        p.shape,
        Array.from({ length: b.numShapes }, (_, i) => curves(b, i)),
      );
    }
    const x = bx + bw / 2 + (p.x - row.size / 2) * step,
      y = by + bh / 2 + (p.y - row.size / 2) * step;
    const originalCurves = curves(original, p.shape),
      eo = CB.shapeEvenOdd(original, p.shape);
    const reference = (n) => ({
      original: area(originalCurves, eo, x, y, n),
      pieces: pieces.get(p.shape).reduce((sum, cs) => sum + area(cs, false, x, y, n), 0),
    });
    const fine = reference(slices),
      coarse = reference(slices / 4);
    const first = c.pieceGroups.filter((g) => g.shape < p.shape).reduce((n, g) => n + g.pieces, 0),
      group = atlas.groups.find((g) => g.shape === p.shape);
    const ax = p.x - group.rect[0] + group.atlas[0],
      ay = p.y - group.rect[1] + group.atlas[1];
    const contributions = [];
    for (let i = 0; i < group.pieces; i++) {
      const cs = curves(atlasBundle, first + i, true),
        coverage = area(cs, false, ax, ay, slices, 1);
      if (coverage > 1e-8) contributions.push({ piece: i, coverage, curves: cs });
    }
    const wireAtlas = contributions.reduce((n, p) => n + p.coverage, 0),
      wireAtlasCoarse = Array.from({ length: group.pieces }, (_, i) =>
        area(curves(atlasBundle, first + i, true), false, ax, ay, slices / 4, 1),
      ).reduce((a, b) => a + b, 0);
    rows.push({
      x: p.x,
      y: p.y,
      shape: p.shape,
      atlas: [ax, ay],
      observed: p.observed,
      fine,
      coarse,
      wireAtlas,
      wireAtlasCoarse,
      contributions,
      drift: Math.max(
        Math.abs(fine.original - coarse.original),
        Math.abs(fine.pieces - coarse.pieces),
        Math.abs(wireAtlas - wireAtlasCoarse),
      ),
    });
  }
}
writeFileSync(
  output,
  JSON.stringify(
    {
      slices,
      scope:
        'Raw authored fill and summed closed CPatch pieces; numerical y integration, not a GPU timing model.',
      rows,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(rows, null, 2));
