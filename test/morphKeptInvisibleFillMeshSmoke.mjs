// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Kept invisible fills can use prepared morph geometry when an override reveals them.
// One-sided visible fills remain eligible; stroke-only rows need no fill mesh.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import { buildMorphBundle } from '../src/renderer/lbMorphCore.js';

let failures = 0;
const check = (c, m) => {
  if (c) console.log('ok ' + m);
  else {
    failures++;
    console.error('FAIL: ' + m);
  }
};
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;
const tri = (pts, paint) => `<path id="a" d="M${pts[0]} L${pts[1]} L${pts[2]} Z" ${paint}/>`;
const build = async (A, B) => {
  const a = await importSvg(A, { preserveViewport: true }),
    d = await importSvg(B, { preserveViewport: true });
  const pa = parseMetaBin(a.meta, a.metaFloatsPerShape),
    pd = parseMetaBin(d.meta, d.metaFloatsPerShape);
  return buildMorphBundle({
    srcCurve: new Float32Array(a.curves),
    dstCurve: new Float32Array(d.curves),
    srcMeta: pa.metaFloats,
    dstMeta: pd.metaFloats,
    metaStride: pa.floatsPerShape,
    ranges: a.curveRangesByShape,
    numShapes: a.numShapes,
  });
};
const P0 = ['4,4', '28,6', '16,28'],
  P1 = ['6,26', '26,24', '16,4'];
{
  const r = await build(
    svg(tri(P0, 'fill="red" fill-opacity="0"')),
    svg(tri(P1, 'fill="red" fill-opacity="0"')),
  );
  check(
    r.meshes.length === 1 && !!r.meshes[0],
    'alpha 0 at both ends: the fill row has a pair mesh',
  );
}
{
  const r = await build(svg(tri(P0, 'fill="red" fill-opacity="0"')), svg(tri(P1, 'fill="red"')));
  check(!!r.meshes[0], 'alpha 0 at one end: still meshed (control)');
}
{
  const r = await build(
    svg(tri(P0, 'fill="none" stroke="blue" stroke-width="2"')),
    svg(tri(P1, 'fill="none" stroke="blue" stroke-width="2"')),
  );
  check(
    r.meshes.every((m) => !m),
    'a stroke-only morph row gets no fill mesh',
  );
}
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('\nmorphKeptInvisibleFillMeshSmoke: passed');
