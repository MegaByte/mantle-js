// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImageExternalRenderSmoke — an <feImage href="data:image/png;base64,…"> draws its raster where Chrome
// does: fitted by preserveAspectRatio into the primitive subregion and clipped to it, with the
// subregion in either primitiveUnits and defaulting to the filter region. The reference is Chrome's
// rendering of the same SVG (test/_chromeRef.mjs), on white.
//
// An feImage that resolved "#id" only would leave an untyped node in the graph for an external href, and
// the filter would draw nothing Chrome draws. feImageExternalSmoke pins the import, the placement math and the pixel mapping
// in node; this is the pixels. The image is 8x8 in four 4x4 quadrants (red, green / blue, yellow), and
// every point read is a quadrant's middle, where any resampling filter returns the quadrant's color.
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { openChromeRef, rgbaAt } from './_chromeRef.mjs';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

// A minimal RGBA PNG encoder (one IDAT, filter 0 on every row).
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      px(x, y).forEach((v, k) => {
        raw[y * (w * 4 + 1) + 1 + x * 4 + k] = v;
      });
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
const Q = {
  tl: [255, 0, 0, 255],
  tr: [0, 160, 0, 255],
  bl: [0, 0, 255, 255],
  br: [255, 200, 0, 255],
};
const IMG = png(8, 8, (x, y) => (y < 4 ? (x < 4 ? Q.tl : Q.tr) : x < 4 ? Q.bl : Q.br));
const WHITE = [255, 255, 255, 255];

const W = 240,
  H = 120;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
  // A: no subregion -> the filter region (the rect's box), meet: a 50x50 image centered in 100x50.
  `<filter id="a" x="0" y="0" width="1" height="1"><feImage href="${IMG}"/></filter>` +
  // B: a userSpaceOnUse subregion far from the filtered shape, stretched (none).
  `<filter id="b" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
  `<feImage href="${IMG}" x="130" y="10" width="100" height="40" preserveAspectRatio="none"/></filter>` +
  // C: xMaxYMax slice into 60x30: the image is 60x60 at y 50..110; only its bottom half (y 80..110) shows.
  `<filter id="c" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
  `<feImage href="${IMG}" x="10" y="80" width="60" height="30" preserveAspectRatio="xMaxYMax slice"/></filter>` +
  // D: objectBoundingBox primitive units: the right half of the rect's box, stretched.
  `<filter id="d" primitiveUnits="objectBoundingBox"><feImage href="${IMG}" x="0.5" y="0" width="0.5" height="1" preserveAspectRatio="none"/></filter>` +
  `</defs>` +
  `<rect x="10" y="10" width="100" height="50" fill="#000" filter="url(#a)"/>` +
  `<rect x="220" y="100" width="10" height="10" fill="#000" filter="url(#b)"/>` +
  `<rect x="100" y="100" width="10" height="10" fill="#000" filter="url(#c)"/>` +
  `<rect x="130" y="60" width="100" height="56" fill="#000" filter="url(#d)"/>` +
  `</svg>`;

const PTS = [
  [47, 22, Q.tl, 'A: region fit, top-left quadrant'],
  [72, 22, Q.tr, 'A: top-right'],
  [47, 47, Q.bl, 'A: bottom-left'],
  [72, 47, Q.br, 'A: bottom-right'],
  [20, 35, WHITE, 'A: letterbox (transparent)'],
  [155, 20, Q.tl, 'B: userSpaceOnUse subregion, stretched, top-left'],
  [205, 20, Q.tr, 'B: top-right'],
  [155, 40, Q.bl, 'B: bottom-left'],
  [205, 40, Q.br, 'B: bottom-right'],
  [25, 95, Q.bl, 'C: slice, the visible bottom-left'],
  [55, 95, Q.br, 'C: the visible bottom-right'],
  [25, 70, WHITE, 'C: the image above its subregion (clipped)'],
  [192, 74, Q.tl, 'D: objectBoundingBox subregion, top-left'],
  [218, 74, Q.tr, 'D: top-right'],
  [192, 102, Q.bl, 'D: bottom-left'],
  [218, 102, Q.br, 'D: bottom-right'],
  [150, 88, WHITE, "D: the box's left half (outside the subregion)"],
];

const ref = await openChromeRef(launchBrowser);
try {
  const { mantle, chrome } = await ref.render(svg, { w: W, h: H, ground: 'white' });
  for (const [x, y, want, what] of PTS) {
    const m = rgbaAt(mantle, W, x, y),
      c = rgbaAt(chrome, W, x, y);
    const d = Math.max(...m.map((v, i) => Math.abs(v - c[i])));
    const dw = Math.max(...c.map((v, i) => Math.abs(v - want[i])));
    const msg = `${what} (${x},${y}): mantle rgba(${m.join(',')}) chrome rgba(${c.join(',')})`;
    if (dw > 4)
      fail(msg + ` — the reference itself is not rgba(${want.join(',')}); the case is mis-set`);
    else if (d <= 4) ok(msg);
    else fail(msg + ` — off by ${d}/255`);
  }
  for (const e of ref.pageErrors) fail('page: ' + e);
} catch (e) {
  fail('setup: ' + e.message);
}
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfeImageExternalRenderSmoke: an external feImage is fitted into its subregion and clipped to it, as Chrome does',
);
