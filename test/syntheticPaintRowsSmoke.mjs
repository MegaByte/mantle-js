// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// syntheticPaintRowsSmoke -- the tracked, hand-written fixtures under test/fixtures/paint carry the paint row types the renderer
// has to cover (gradient, mask and clip, vector pattern, filter, blend) on curved geometry, so the smoke lanes never depend on
// proprietary or painted art. Each file is imported and its feature inventory must name the row type it exists for, with
// curves in it (quadratic, cubic or arc) so the analytic engines have something to draw.
import path from 'path';
import { fileURLToPath } from 'url';
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { readFileSync } = await import('fs');
const { default: importSvg } = await import('../src/svg/importer.js');
const { inspect, Features } = await import('../src/bundle/featureSet.js');
let bad = 0;
const ok = (c, m) => {
  if (!c) {
    bad++;
    console.error('FAIL', m);
  } else console.log('  ok', m);
};
const want = {
  gradient_rows: [['Gradients', 'GradientLinear', 'GradientRadial']],
  mask_rows: [['Masks', 'Clips']],
  pattern_rows: [['VectorPattern']],
  filter_rows: [['Filters', 'FilterBlur', 'FilterColorMatrix']],
  blend_rows: [['BlendNonNormal']],
};
for (const [name, [names]] of Object.entries(want)) {
  const sc = await importSvg(
    readFileSync(path.join(TREE, 'test/fixtures/paint', name + '.svg'), 'utf8'),
    { preserveViewport: true },
  );
  const f = inspect(sc);
  for (const n of names) ok((f & Features[n]) !== 0n, `${name}: ${n}`);
  ok(
    sc.numShapes >= 2 && (sc.segTypeMask & 0b1110) !== 0,
    `${name}: ${sc.numShapes} shapes with curved segments (mask ${sc.segTypeMask})`,
  );
}
if (bad) process.exit(1);
console.log('syntheticPaintRowsSmoke ok');
