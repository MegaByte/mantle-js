// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import importSvg from '../../src/svg/importer.js';
import { preparePolynomialMorph } from './morphPreparation.js';
import { prepareRadialPolynomialMorph } from './morphFanPreparation.js';
import { flatMorphPaintSvg, morphPieceDrawScope } from './morphPaintScope.js';
const [input, output] = process.argv.slice(2),
  loaded = JSON.parse(readFileSync(input)),
  config = loaded.config || loaded;
config.productionShaders = false; // Only piece arms retain positive subbyte float coverage.
for (const c of config.cases) {
  morphPieceDrawScope(c.drawOptions);
  const start = performance.now(),
    a = flatMorphPaintSvg(c.svg),
    b = flatMorphPaintSvg(c.morphSvgDst);
  if (a.alpha !== b.alpha) throw Error('Changing group opacity unsupported');
  const sa = await importSvg(a.svg, { preserveViewport: true }),
    sb = await importSvg(b.svg, { preserveViewport: true }),
    importMs = performance.now() - start;
  const prepared = c.morphPreparationOptions?.radialFan
    ? prepareRadialPolynomialMorph(sa, sb, c.morphPreparationOptions)
    : preparePolynomialMorph(sa, sb, c.morphPreparationOptions);
  c.morphPieceIntervals = prepared.intervals;
  c.pieceGroupAlpha = a.alpha;
  c.morphPreparation = {
    ...prepared.stats,
    importMs,
    totalWithImportMs: performance.now() - start,
  };
  c.morphGpuSmallPlanes = true;
  c.arms = [
    { name: 'rawMorph', engine: 'aac', morph: true },
    { name: 'rawMorphAA', engine: 'aac', morph: true },
    {
      name: 'pieceMorph',
      engine: 'aac',
      morphPieceAtlas: true,
      coverageFormat: 'r16f',
      defines: ['MANTLE_COVERAGE_ACCUMULATION'],
    },
    {
      name: 'pieceMorphAA',
      engine: 'aac',
      morphPieceAtlas: true,
      coverageFormat: 'r16f',
      defines: ['MANTLE_COVERAGE_ACCUMULATION'],
    },
    { name: 'poseAAC', engine: 'aac', pose: true, analyticArea: true },
  ];
  c.comparisonBase = 'poseAAC';
  console.log(c.name, c.morphPreparation);
}
writeFileSync(output, JSON.stringify(config));
