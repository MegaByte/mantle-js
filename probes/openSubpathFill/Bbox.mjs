// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
const ROOT = process.env.MANTLE_ROOT || new URL('../..', import.meta.url).pathname; // the package tree to probe (default: this one)
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(ROOT + '/src/svg/importer.js');
const { parseMetaBin } = await import(ROOT + '/src/renderer/bundle.js');
for (const [label, f] of [
  ['open (FAILS)', '/tmp/openFill_min_open.svg'],
  ['Z (works)', '/tmp/openFill_min_z.svg'],
]) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const st = pm.floatsPerShape,
    m = pm.metaFloats;
  const bb = [m[0], m[1], m[2], m[3]];
  console.log(
    `${label}: meta bbox = [${bb.map((v) => v.toFixed(4)).join(', ')}]  w=${(bb[2] - bb[0]).toFixed(4)} h=${(bb[3] - bb[1]).toFixed(4)} area=${((bb[2] - bb[0]) * (bb[3] - bb[1])).toFixed(3)}`,
  );
  console.log(
    `   globalBBox = [${Array.from(b.globalBBox)
      .map((v) => v.toFixed(4))
      .join(', ')}]`,
  );
}
