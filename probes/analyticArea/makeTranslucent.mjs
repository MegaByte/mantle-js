// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Generate premultiplied RGBA oracles for translucent solid fills. Normalization
// is PER SHAPE: separate paint operations must never be unioned together.
import { mkdirSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { pathToCycles } = await import('../../src/geom/cpatchGraph.js');
import { boundaryArea, point } from './area.mjs';
import { pathData } from './serialize.mjs';
import { splitMonotone } from './monotone.mjs';
const dir = process.argv[2];
if (!dir) throw new Error('makeTranslucent.mjs OUTPUT_DIRECTORY');
mkdirSync(dir, { recursive: true });
const wrap = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${s}</svg>`;
const paths = {
  line: 'M8 15L115 36L97 117L52 90L8 112Z',
  quad: 'M8 15Q65 -10 115 36Q130 80 97 117Q66 70 52 90Q9 131 8 112Z',
  cubic: 'M8 15C52 -4 120 6 115 36C110 62 135 95 97 117C55 118 80 65 52 90C4 142 -6 101 8 15Z',
  arc: 'M12 64A52 31 25 1 1 116 64A52 31 25 1 1 12 64Z',
  ring: 'M12 64A52 44 0 1 1 116 64A52 44 0 1 1 12 64Z M25 64A39 31 0 1 1 103 64A39 31 0 1 1 25 64Z',
  overlap:
    'M14 64A34 34 0 1 1 82 64A34 34 0 1 1 14 64Z M46 64A34 34 0 1 1 114 64A34 34 0 1 1 46 64Z',
};
const arms = [
  { name: 'lb', engine: 'lb' },
  { name: 'lbPrepared', engine: 'lb', monotone: true, defines: ['MANTLE_LB_PREPARED_MONOTONE'] },
  { name: 'cpatch', engine: 'cpatch' },
  { name: 'areaUnified', engine: 'aac', monotone: true, defines: ['MANTLE_AREA_MONOTONE'] },
  { name: 'lbAA', engine: 'lb' },
  { name: 'cpatchAA', engine: 'cpatch' },
];
async function shape(d, eo = false) {
  const sec = await importSvg(wrap(`<path d="${d}"/>`)),
    b = headlessCPatchBundle(sec),
    r = b.curveRangesByShape[0];
  const raw = contoursToConverter(curveRangeToContours(cpatchCurvePlane(b), r.begin, r.end), null),
    cycles = pathToCycles(raw, eo);
  return { d, eo, raw, cycles };
}
const shapes = Object.fromEntries(
  await Promise.all(Object.entries(paths).map(async ([k, d]) => [k, await shape(d, k === 'ring')])),
);
function make(name, parts, size, { opacity = 0.5, group = 1, drawAlpha = 1 } = {}) {
  // Samples cover every low-resolution pixel and stratified boundary and interior
  // points at 512; reference curves remain f64 and analytically integrated.
  const pixels = new Map();
  const add = (x, y) => {
    if (x >= 0 && x < size && y >= 0 && y < size) pixels.set(x + ',' + y, [x, y]);
  };
  if (size <= 32) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) add(x, y);
  else {
    for (const { s } of parts)
      for (const seg of s.raw.flat())
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const p = point(seg, t),
            x = Math.floor((p[0] * size) / 128),
            y = Math.floor((p[1] * size) / 128);
          for (const [dx, dy] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [-1, -1],
          ])
            add(x + dx, y + dy);
        }
    for (let y = 16; y < size; y += 32) for (let x = 16; x < size; x += 32) add(x, y);
  }
  const colors = parts.map((p) => p.color || [1, 0.2, 0.1]),
    colorSamples = [...pixels.values()].map(([x, y]) => {
      let rgba = [0, 0, 0, 0];
      const step = 128 / size;
      for (let i = 0; i < parts.length; i++) {
        const area = boundaryArea(parts[i].s.cycles.flat(), x * step, y * step, step);
        if (area < -0.00001 || area > 1.00001) throw new Error('Bad area ' + area);
        const a = Math.max(0, Math.min(1, area)) * opacity * drawAlpha;
        rgba = rgba.map((v, k) =>
          Math.round(255 * ((k === 3 ? 1 : colors[i][k]) * a + (v / 255) * (1 - a))),
        );
      }
      rgba = rgba.map((v) => Math.round(v * group));
      return { x, y, rgba };
    });
  const svg = (kind) =>
    wrap(
      (group !== 1 ? `<g opacity="${group}">` : '') +
        parts
          .map(({ s }, i) => {
            const d =
              kind === 'raw'
                ? s.d
                : pathData(kind === 'monotone' ? splitMonotone(s.cycles) : s.cycles);
            return `<path fill="rgb(${colors[i].map((v) => v * 100 + '%').join(',')})" fill-opacity="${opacity}" fill-rule="${kind === 'raw' && s.eo ? 'evenodd' : 'nonzero'}" d="${d}"/>`;
          })
          .join('') +
        (group !== 1 ? '</g>' : ''),
    );
  return {
    name,
    size,
    bbox: [0, 0, 128, 128],
    svg: svg('raw'),
    normalized: svg('normalized'),
    monotone: svg('monotone'),
    colorSamples,
    drawOptions: drawAlpha !== 1 ? { alpha: drawAlpha } : undefined,
    reference: {
      opacity,
      group,
      drawAlpha,
      parts: parts.map((p, i) => ({ d: p.s.d, eo: p.s.eo, color: colors[i] })),
    },
    arms,
    comparisonBase: 'areaUnified',
  };
}
const cases = [];
for (const [name, s] of Object.entries(shapes))
  for (const size of [32, 512]) cases.push(make(name + '-alpha50', [{ s }], size));
for (const opacity of [0.25, 0.75])
  cases.push(make('cubic-alpha' + opacity, [{ s: shapes.cubic }], 32, { opacity }));
cases.push(make('cubic-draw-alpha50', [{ s: shapes.cubic }], 32, { opacity: 1, drawAlpha: 0.5 }));
const pair = [
  { s: shapes.cubic, color: [1, 0, 0] },
  { s: shapes.arc, color: [0, 0, 1] },
];
for (const size of [32, 512]) cases.push(make('separate-paints-alpha50', pair, size));
// Group opacity is intentionally different: compose children first, apply once.
cases.push(make('group-alpha50', pair, 32, { opacity: 1, group: 0.5 }));
for (let i = 0; i < cases.length; i += 2) {
  const file = dir + '/translucent-' + i / 2 + '.json';
  writeFileSync(
    file,
    JSON.stringify(
      {
        forceUnified: true,
        defaults: { rounds: 3, batch: 1, repetitions: 1 },
        cases: cases.slice(i, i + 2),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(file);
}
