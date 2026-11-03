// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Experiment: keep the production CPatch decomposition, integrate each closed
// piece, sum its coverage, then paint the original shape once. No flattening.
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import importSvg from '../../src/svg/importer.js';
import * as CB from '../../src/renderer/cpatchBuild.js';
import { curveRangeToContours } from '../../src/geom/lbContour.js';
import { packCPatchShape } from '../../src/renderer/cpatchPack.js';
import * as L from '../../src/bundle/layout.js';
import { splitMonotone } from './monotone.mjs';
import { pathData } from './serialize.mjs';
const [input, output] = process.argv.slice(2),
  loaded = JSON.parse(readFileSync(input)),
  config = loaded.config || loaded;
for (const c of config.cases) {
  if (c.drawOptions && Object.keys(c.drawOptions).some((k) => k !== 'alpha' && k !== 'worldMatrix'))
    throw Error('Piece prototype supports alpha and affine worldMatrix only');
  const M = c.drawOptions?.worldMatrix;
  if (
    M &&
    (M.length !== 9 || M.some((v) => !Number.isFinite(v)) || M[2] !== 0 || M[5] !== 0 || M[8] !== 1)
  )
    throw Error('Piece prototype requires affine worldMatrix');
  if (/<(?:mask|clipPath|filter|image|use)\b/.test(c.svg))
    throw Error('Piece prototype requires flat solid fills');
  const doc = new DOMParser().parseFromString(c.svg, 'image/svg+xml');
  const children = Array.from(doc.documentElement.childNodes).filter((n) => n.nodeType === 1);
  const outer = children.length === 1 && children[0].localName === 'g' ? children[0] : null;
  if (outer?.hasAttribute('opacity')) {
    const alpha = +outer.getAttribute('opacity');
    if (!(alpha >= 0 && alpha <= 1)) throw Error('Group opacity outside [0,1]');
    if (c.pieceGroupAlpha !== undefined && c.pieceGroupAlpha !== alpha)
      throw Error('Conflicting whole-group alpha');
    c.pieceGroupAlpha = alpha;
    outer.removeAttribute('opacity');
  }
  for (const g of Array.from(doc.getElementsByTagName('g')))
    if (
      (g.hasAttribute('opacity') && +g.getAttribute('opacity') !== 1) ||
      /(?:^|;)\s*opacity\s*:/.test(g.getAttribute('style') || '')
    )
      throw Error('Nested/subset group opacity requires another group resolve');
  if (
    doc.documentElement.hasAttribute('opacity') &&
    +doc.documentElement.getAttribute('opacity') !== 1
  )
    throw Error('Root SVG opacity is not supported by this probe');
  const sourceSvg = new XMLSerializer().serializeToString(doc);
  const t = performance.now(),
    b = CB.headlessCPatchBundle(await importSvg(sourceSvg, { preserveViewport: true })),
    cf = CB.cpatchCurvePlane(b);
  c.pieceGroups = [];
  for (let i = 0; i < b.numShapes; i++) {
    const m = b.metaFloats.subarray(i * b.metaFloatsPerShape, (i + 1) * b.metaFloatsPerShape);
    for (const k of [
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
      if (m[L[k]]) throw Error('Unsupported paint ' + k);
    if (!m[L.META_FILL_A]) continue;
    const range = b.curveRangesByShape[i],
      raw = CB.contoursToConverter(curveRangeToContours(cf, range.begin, range.end), null),
      patches = [];
    const packed = packCPatchShape(raw, 0, {
      evenOdd: CB.shapeEvenOdd(b, i),
      onPatches: (ps, holes) => {
        if (holes?.length) throw Error('Unbridged hole constraints are not closed pieces');
        patches.push(...ps);
      },
    });
    if (!packed || packed.unresolved) throw Error('CPatch conversion not complete for shape ' + i);
    const unique = new Set();
    const paths = patches.map((p) => {
      const d = pathData(splitMonotone([p.curves]));
      if (unique.has(d)) throw Error('Duplicate conversion callbacks; refusing ambiguous pieces');
      unique.add(d);
      // Half opacity prevents ordinary opaque-shape culling. The mask resolve
      // multiplies by two before clamping and applying the real paint alpha.
      return `<path fill="white" fill-opacity="0.5" d="${d}"/>`;
    });
    c.pieceGroups.push({
      shape: i,
      pieces: paths.length,
      bbox: Array.from(m.subarray(0, 4)),
      color: [L.META_FILL_R, L.META_FILL_G, L.META_FILL_B, L.META_FILL_A].map((k) => m[k]),
      svg: '<svg xmlns="http://www.w3.org/2000/svg">' + paths.join('') + '</svg>',
    });
  }
  c.piecePreparation = {
    nodeMs: performance.now() - t,
    shapes: c.pieceGroups.length,
    pieces: c.pieceGroups.reduce((s, g) => s + g.pieces, 0),
    scope:
      'Node import, production CPatch conversion, extrema splitting, serialization; browser reimport/upload measured separately',
  };
  c.arms = [
    { name: 'cpatch', engine: 'cpatch' },
    {
      name: 'piecesR16',
      engine: 'aac',
      pieceAtlas: true,
      coverageFormat: 'r16f',
      defines: ['MANTLE_COVERAGE_ACCUMULATION'],
    },
    {
      name: 'piecesR16AA',
      engine: 'aac',
      pieceAtlas: true,
      coverageFormat: 'r16f',
      defines: ['MANTLE_COVERAGE_ACCUMULATION'],
    },
    { name: 'area', engine: 'aac', analyticArea: true },
    { name: 'areaAA', engine: 'aac', analyticArea: true },
  ];
  c.comparisonBase = 'area';
  console.log(c.name, c.piecePreparation);
}
writeFileSync(output, JSON.stringify(config));
