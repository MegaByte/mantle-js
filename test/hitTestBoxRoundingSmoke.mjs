// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitTestBoxRoundingSmoke: a point inside a fill just under a curve's apex hits, though the row's float32 box rounds below that apex.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SVG = (d, k) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-10 * k} ${-10 * k} ${120 * k} ${120 * k}"><path fill="#000" d="${d}"/></svg>`;
const yAt = (t) => {
  const u = 1 - t;
  return 3 * u * u * t * 100 + 3 * u * t * t * 80;
};
const xAt = (t) => {
  const u = 1 - t;
  return 3 * u * u * t * 10 + 3 * u * t * t * 90 + t * t * t * 100;
};
let lo = 0,
  hi = 1;
for (let i = 0; i < 200; i++) {
  const a = lo + (hi - lo) / 3,
    b = hi - (hi - lo) / 3;
  if (yAt(a) < yAt(b)) lo = a;
  else hi = b;
}
const tApex = (lo + hi) / 2,
  yApex = yAt(tApex),
  xApex = xAt(tApex);
for (const k of [1, 1024, 1 / 1024]) {
  const b = await importSvg(SVG(`M0 0C${10 * k} ${100 * k} ${90 * k} ${80 * k} ${100 * k} 0Z`, k));
  for (const del of [1e-6, 1e-7, 1e-8]) {
    ok(
      fillHitShape(b, xApex * k, (yApex - del) * k) >= 0,
      `scale ${k}: ${del} under the apex, Auto`,
    );
    ok(
      fillHitShape(b, xApex * k, (yApex - del) * k, HitMode.Coverage) >= 0,
      `scale ${k}: ${del} under the apex, Coverage`,
    );
  }
  ok(fillHitShape(b, xApex * k, (yApex + 1) * k) < 0, `scale ${k}: a whole unit above it misses`);
}
console.log(fail ? `FAIL (${fail})` : 'PASS');
process.exit(fail ? 1 : 0);
