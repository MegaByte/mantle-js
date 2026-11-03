// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphBandPlaneSizeSmoke -- a morph pair's merged BAND PLANE is sized by the data it holds, not by one texture row per shape.
//
// concatBandPlanes (matched shapes) and appendDstOnlyBands (dst-only shapes) must not start every rewritten band region on a fresh 4096-texel row with another
// row reserved per shape: that is 65,536 bytes each for a region of about 200, and a 5,000-shape pair would allocate, copy and upload a 323 MB plane for about
// 2 MB of data. The band walk carries across rows (bLoc / bFetchL), so a region
// needs no row of its own. This pins the size: with 300 matched and 100 dst-only shapes the plane must stay within the source plane plus 512 bytes per
// rewritten shape plus one row, where a row per shape would need 400 rows (26 MB).
import { createFakeGl } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createShapeMorph } = await import('../src/index.js');

const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${body}</svg>`;
const blob = (i, dx) => {
  const x = (i % 20) * 48 + 4 + dx,
    y = Math.floor(i / 20) * 48 + 4;
  return `<path id="s${i}" fill="#${(0x203040 + i * 77).toString(16).slice(-6)}" d="M${x + 20} ${y} C${x + 36} ${y} ${x + 40} ${y + 16} ${x + 40} ${y + 20} C${x + 40} ${y + 36} ${x + 24} ${y + 40} ${x + 20} ${y + 40} C${x + 4} ${y + 40} ${x} ${y + 24} ${x} ${y + 20} C${x} ${y + 4} ${x + 16} ${y} ${x + 20} ${y}Z"/>`;
};
const N = 300,
  M = 100;
const A = Array.from({ length: N }, (_, i) => blob(i, 0)).join('');
const B = Array.from({ length: N + M }, (_, i) => blob(i, 3)).join('');
const F = createFakeGl({ width: 64, height: 64 });
const ba = createBundle(F.gl, await importSvg(doc(A))),
  bb = createBundle(F.gl, await importSvg(doc(B)));
const m = createShapeMorph(F.gl, ba, bb);
m.setT(0.5);
const plane = m.bundle.bandFloats.byteLength,
  src = ba.bandFloats.byteLength;
const bound = src + (N + M) * 512 + 65536 * 4; // one row of slack for the final round-up, and the source rounding
console.log(
  `  band plane ${plane} bytes (source plane ${src}, bound ${bound}; a row per shape needs about ${(N + M) * 65536})`,
);
ok(plane <= bound, `the merged band plane is packed: ${plane} <= ${bound}`);
ok(m.bundle.numShapes === N + M, `the morph carries all ${N + M} shapes (${m.bundle.numShapes})`);
console.log(fail ? `\nmorphBandPlaneSizeSmoke: FAIL (${fail})` : '\nmorphBandPlaneSizeSmoke: PASS');
process.exit(fail ? 1 : 0);
