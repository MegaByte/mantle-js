// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitTieMemoSmoke -- a query's answer does not depend on the query before it.
//
// A point within the tie band of a fill's edge hits (hitTest.js TIE POLICY). A large shape remembers its last answer for the clear radius around that query, and that radius must stop
// short of the tie band of the nearest edge: otherwise, after a miss 2e-5 of the extent away, a point in the band misses where the same point on a fresh bundle hits.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, fillHitShape } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
// A U of 60 segments (the winding tree and the memo run from 48): the notch's floor is the edge y = 60, x 40..60, empty above it.
let d = 'M0 0L40 0L40 60';
for (let i = 1; i <= 56; i++) d += `L${40 + (20 * i) / 56} 60`;
d += 'L60 0L100 0L100 100L0 100Z';
const asset = () =>
  importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 120 120"><path d="${d}" fill="#000"/></svg>`,
    { preserveViewport: true },
  );
const X = 50.17,
  TIE = 1e-4 * 0.9,
  FAR = 2e-3;
const fresh = await asset();
ok(
  fillHitShape(fresh, X, 30) === -1 && fillHitShape(fresh, X, 80) === 0,
  '(control) the notch misses and the body hits',
);
const once = await asset();
ok(fillHitShape(once, X, 60 - TIE) === 0, 'a point in the tie band hits on a fresh bundle');
const after = await asset();
ok(fillHitShape(after, X, 60 - FAR) === -1, '(control) a point past the tie band misses');
ok(fillHitShape(after, X, 60 - TIE) === 0, 'and the point in the band still hits after it');
ok(fillHitShape(after, X, 60 - FAR) === -1, '(control) the miss still answers');
ok(fillHitShape(after, X + 1e-4, 60 - FAR) === -1, '(control) so does a query the memo serves');
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
