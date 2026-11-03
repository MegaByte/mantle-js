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
  ['2-seg (FAILS)', '/tmp/openFill_min_open.svg'],
  ['3-seg Z (works)', '/tmp/openFill_min_z.svg'],
]) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const bands = new Float32Array(b.bands);
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const gl0 = pm.metaFloats[0 * pm.floatsPerShape + 16] | 0;
  console.log(`\n${label}: glyphLoc=${gl0} bandFloats=${bands.length}`);
  // walk header slots until they stop looking like (n,n,n,n)+(arrIdx,..) pairs
  for (let slot = 0; slot < 8; slot++) {
    const o = (gl0 + slot * 2) * 4;
    if (o + 7 >= bands.length) break;
    const n = [bands[o], bands[o + 1], bands[o + 2], bands[o + 3]];
    const arr = bands[o + 4];
    const tot = n[0] + n[1] + n[2] + n[3];
    if (!(tot > 0) || tot > 64) break;
    console.log(
      `  band[${slot}] counts=(L${n[0]} Q${n[1]} C${n[2]} A${n[3]}) total=${tot} arrIdx=${arr}`,
    );
  }
}
