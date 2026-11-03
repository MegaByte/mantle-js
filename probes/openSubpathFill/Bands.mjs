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
  ['3-seg (works)', '/tmp/openFill_authored_line.svg'],
]) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const bands = new Float32Array(b.bands);
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const st = pm.floatsPerShape;
  const glyphLoc = pm.metaFloats[0 * st + 16]; // meta texel 4 .x = band index
  console.log(`\n${label}: bandFloats=${bands.length} glyphLoc=${glyphLoc}`);
  const base = (glyphLoc | 0) * 4;
  const h0 = base,
    nL = bands[h0],
    nQ = bands[h0 + 1],
    nC = bands[h0 + 2],
    nA = bands[h0 + 3];
  const arrIdx = bands[h0 + 4];
  console.log(`  header: nLine=${nL} nQuad=${nQ} nCubic=${nC} nArc=${nA}  arrIdx=${arrIdx}`);
  const eBase = (glyphLoc + (arrIdx | 0)) * 4;
  for (let k = 0; k < nL + nQ + nC + nA + 1; k++) {
    const o = eBase + k * 4;
    if (o + 3 >= bands.length) {
      console.log('   (past end)');
      break;
    }
    const kind = k < nL ? 'LINE' : k < nL + nQ ? 'QUAD' : k < nL + nQ + nC ? 'CUBIC' : 'ARC';
    console.log(
      `   entry[${k}] ${kind.padEnd(5)} loc=${bands[o]} brk=${bands[o + 1].toFixed(3)} far=${bands[o + 2].toFixed(3)}`,
    );
  }
}
