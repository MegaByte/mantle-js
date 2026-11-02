// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { importSvg } from '../src/index.js';
import { parseMetaBin } from '../src/renderer/bundle.js';
import { buildMorphBundle } from '../src/renderer/lbMorphCore.js';
import { enginesOfUnifiedDraw } from '../src/renderer/engineLedger.js';
import { FS_GROUP_BEGIN, FS_GROUP_END } from '../src/bundle/layout.js';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const svg = (x) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><g opacity=".63"><path id="body" fill="#c050a0" fill-opacity=".51" d="M${10 + x} 10 L${40 + x} 12 L${38 + x} 40 Z"/></g></svg>`;
const a = await importSvg(svg(0), { preserveViewport: true }),
  b = await importSvg(svg(2), { preserveViewport: true });
const ma = parseMetaBin(a.meta, a.metaFloatsPerShape),
  mb = parseMetaBin(b.meta, b.metaFloatsPerShape);
const input = {
  srcCurve: new Float32Array(a.curves),
  dstCurve: new Float32Array(b.curves),
  srcMeta: ma.metaFloats,
  dstMeta: mb.metaFloats,
  metaStride: ma.floatsPerShape,
  ranges: a.curveRangesByShape,
  numShapes: a.numShapes,
};
assert.equal(a.numShapes, 3);
assert(ma.metaFloats[7] > 0.6, 'group opacity occupies the alpha slot');
assert.equal(Math.floor(ma.metaFloats[27] + 0.5) & FS_GROUP_BEGIN, FS_GROUP_BEGIN);
assert.equal(
  Math.floor(ma.metaFloats[2 * ma.floatsPerShape + 27] + 0.5) & FS_GROUP_END,
  FS_GROUP_END,
);
const result = buildMorphBundle(input);
assert(!result.hasSlug);
assert.equal(result.meshes.length, 3);
assert.equal(result.meshes[0], null);
assert(result.meshes[1].vertexCount > 0);
assert.equal(result.meshes[2], null);
assert.deepEqual(
  enginesOfUnifiedDraw(
    {
      metaFloats: input.srcMeta,
      metaFloatsPerShape: input.metaStride,
      numShapes: 3,
      _lbMeshes: [null, { vertexCount: 3, cpatch: true }, null],
    },
    'slug',
  ),
  ['cpatch'],
  'structural group rows cannot credit a fill kernel that never drew',
);
const ranges = input.ranges.map((r) => ({ ...r }));
ranges[1] = { begin: 0, end: 0 };
assert.equal(
  buildMorphBundle({ ...input, ranges }).hasSlug,
  true,
  'a painted row with no geometry still declines',
);
const mismatched = new Float32Array(input.dstMeta);
mismatched[27] = FS_GROUP_END;
assert.equal(
  buildMorphBundle({ ...input, dstMeta: mismatched }).hasSlug,
  true,
  'incompatible group structure remains conservative',
);
console.log(
  'lbMorphGroupMetadataSmoke PASS: opacity markers preserve row indices and the real translucent mesh; missing paint geometry and mismatched markers still decline',
);
