// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeSubpathTouchSmoke -- two authored subpaths that merely touch get butt caps, not a join.
//
// The stroke builder paired segment ends by point coincidence across the whole shape (textures.js, "last matching wins"), so
// `M a L b M b L c` would stroke as ONE polyline with a round/miter join at b; in the SVG model each subpath ends in its own cap. Three
// width-6 micro subpaths would put a radius-3 round blob at their shared corner (about 20 gray pixels at 128 px where Chrome has none),
// and a relative 4e-7 perturbation, which moves the ends out of pointsMeet, would make the blob vanish: the picture would flip on input noise.
//
// Assertions, at 1, 2^-20 and 2^20 with and without a far origin, read from the curve plane (record header: type|bits, freeStart,
// freeEnd, startDist):
//   1. `M a L b M b L c`: the first record's end and the second's start are FREE (caps), as with a gap between them;
//   2. `M a L b L c`: one subpath still joins (end and start not free), so the join itself is intact;
//   3. a Z-closed triangle still joins at its closing corner, and two touching Z-closed triangles each stay closed;
//   4. an OPEN subpath that ends where it began (`M a L b L c L a`, no Z) keeps caps at both ends (Chrome: no join), while the same with
//      Z joins all round -- an outline path of that form would otherwise draw a round blob at its corner;
//   5. the plane for the touching pair has the same free flags as the same pair with the second subpath moved off by 1e-3.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const _warn = console.warn;
console.warn = () => {};

// the (freeStart, freeEnd) of every stroke record, in order
async function flags(d, S, off) {
  const T = off ? 16384 * S : 0;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[T, T, 40 * S, 40 * S].join(' ')}"><g transform="translate(${T} ${T}) scale(${S})">` +
    `<path d="${d}" fill="none" stroke="#000" stroke-width="6"/></g></svg>`;
  const sec = await importSvg(svg, { preserveViewport: true });
  // layout: one reserved texel, then per line record [header][p1 p2][join tangents] = 12 floats
  const f = new Float32Array(sec.curves),
    out = [];
  for (
    let i = 4;
    i + 11 < f.length &&
    (f[i] & 3) === 0 &&
    (f[i + 1] === 0 || f[i + 1] === 1) &&
    (f[i + 2] === 0 || f[i + 2] === 1);
    i += 12
  )
    out.push([f[i + 1], f[i + 2]]);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const off of [false, true])
  for (const e of [0, -20, 20]) {
    const tag = `2^${e}${off ? '+origin' : ''}`;
    const touch = await flags('M5 5 L20 5 M20 5 L20 20', 2 ** e, off);
    const apart = await flags('M5 5 L20 5 M20.001 5 L20 20', 2 ** e, off);
    check(
      touch.length >= 2 && touch[0][1] === 1 && touch[1][0] === 1,
      `${tag}: touching subpaths: end and start free (caps) ${JSON.stringify(touch)}`,
    );
    check(
      same(
        touch.map((x) => x),
        apart.map((x) => x),
      ),
      `${tag}: the same flags as the pair moved apart`,
    );
    const one = await flags('M5 5 L20 5 L20 20', 2 ** e, off);
    check(one.length >= 2 && one[0][1] === 0 && one[1][0] === 0, `${tag}: one subpath still joins`);
    const tri = await flags('M5 5 L20 5 L20 20 Z', 2 ** e, off);
    check(
      tri.length === 3 && tri.every((x) => x[0] === 0 && x[1] === 0),
      `${tag}: a closed triangle joins all round`,
    );
    const open = await flags('M5 5 L20 5 L20 20 L5 5', 2 ** e, off);
    check(
      open.length === 3 &&
        open[0][0] === 1 &&
        open[2][1] === 1 &&
        open[0][1] === 0 &&
        open[1][1] === 0,
      `${tag}: an open subpath ending at its start keeps both caps ${JSON.stringify(open)}`,
    );
    const closedZ = await flags('M5 5 L20 5 L20 20 L5 5 Z', 2 ** e, off);
    check(
      closedZ.length === 3 && closedZ.every((x) => x[0] === 0 && x[1] === 0),
      `${tag}: the same with Z joins all round`,
    );
  }
console.warn = _warn;
if (failures) {
  console.log(`strokeSubpathTouchSmoke FAIL: ${failures}`);
  process.exit(1);
}
console.log('strokeSubpathTouchSmoke PASS');
