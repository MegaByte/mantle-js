// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Print the group rows (begin) of SVGs: opacity, clip id, mask id, filter, blend.
import { readFileSync } from 'fs';
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
console.warn = () => {};
for (const f of process.argv.slice(2)) {
  const b = await importSvg(readFileSync(f, 'utf8'), {});
  const st = b.metaFloatsPerShape,
    mf = parseMetaBin(b.meta, st).metaFloats;
  console.log('FILE', f);
  for (let r = 0; r < mf.length / st; r++) {
    const o = r * st,
      fl = Math.round(mf[o + 27]);
    if (process.env.ALL)
      console.log(' row', r, 'flags', fl, 'clip', mf[o + 30], 'mask', mf[o + 31]);
    if (fl & 64 && !(fl & 256))
      console.log(
        ' begin row',
        r,
        'opacity',
        mf[o + 7],
        'clip',
        mf[o + 30],
        'mask',
        mf[o + 31],
        'filter',
        mf[o + 32],
        'blend',
        mf[o + 33],
      );
  }
}
