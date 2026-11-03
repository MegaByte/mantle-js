// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphHitBitsOneSidedSmoke -- a morph between a bundle that carries hit bits and one that does not (a programmatic or text bundle, which the
// hit test answers by paint) must keep the bit-less side's rows targetable. The merge must not write 0 for them: a row with bits 0 answers nothing.
//   (a) source without a table, destination with one: the source rows answer by their paint;
//   (b) source with a table, destination without: the destination-only rows answer by their paint;
//   (c) both with tables: unchanged (the source's bits, the destination's for destination-only rows).
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createShapeMorph } from '../src/index.js';
import { HIT_FILL, rowHitBits } from '../src/svg/hitBits.js';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok ' + m);
  else {
    failures++;
    console.error('FAIL: ' + m);
  }
};
const gl = makeFakeWebgl2(16, 16).gl;
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${b}</svg>`;
const SA = await importSvg(
  svg(
    '<rect id="a" x="1" y="1" width="6" height="6" fill="red"/><rect id="b" x="8" y="8" width="6" height="6" fill="blue"/>',
  ),
);
const SB = await importSvg(
  svg(
    '<rect id="a" x="3" y="3" width="6" height="6" fill="red"/><rect id="c" x="9" y="1" width="5" height="5" fill="green"/>',
  ),
);
check(SA.hitBits && SB.hitBits, 'importSvg bundles carry hit tables');
const noTable = (S) => {
  const { hitBits, ...rest } = S;
  return rest;
};

{
  // (a)
  const m = createShapeMorph(gl, createBundle(gl, noTable(SA)), createBundle(gl, SB), {
    cpuLerp: true,
  });
  const hb = m.bundle.hitBits;
  check(hb && hb.length >= 2, '(a) the merged bundle has a hit table');
  check(
    hb && (hb[0] & HIT_FILL) !== 0 && (hb[1] & HIT_FILL) !== 0,
    '(a) the table-less source rows answer by their paint (bits ' + (hb && [...hb]) + ')',
  );
}
{
  // (b)
  const m = createShapeMorph(gl, createBundle(gl, SA), createBundle(gl, noTable(SB)), {
    cpuLerp: true,
  });
  const hb = m.bundle.hitBits;
  check(
    hb && hb.length >= 3 && (hb[2] & HIT_FILL) !== 0,
    '(b) the destination-only row of a table-less destination answers by its paint (bits ' +
      (hb && [...hb]) +
      ')',
  );
}
{
  // (c)
  const m = createShapeMorph(gl, createBundle(gl, SA), createBundle(gl, SB), { cpuLerp: true });
  const hb = m.bundle.hitBits;
  check(
    hb && hb[0] === SA.hitBits[0] && hb[1] === SA.hitBits[1] && hb[2] === SB.hitBits[1],
    '(c) both tables: source bits, then the destination bits for its own rows',
  );
}
check(
  rowHitBits({ metaFloatsPerShape: 0 }, 0) === 0,
  'rowHitBits is 0 for a bundle with neither a table nor meta',
);
process.exit(failures ? 1 : 0);
