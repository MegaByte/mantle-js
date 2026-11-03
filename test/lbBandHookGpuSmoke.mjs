// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBandHookGpuSmoke -- Loop-Blinn's curve band on a rational quad that turns past a right angle, on a physical GPU, against Chrome's
// own SVG engine at 8x box-averaged (the project's AA reference) and against the Slug cover kernel drawn the same way.
//
// The drawing is a 6-arc 80:1 ellipse sliver (a cylinder cap from real art): each tip arc turns about 160 degrees in a fraction of
// its length. A band that cuts behind an end's normal line drops single-pixel fringe columns along such an arc's flank in runs, pixels
// more than 64/255 too light where Slug reads none. So the band's end tests apply on their own side of the normal line at the arc point
// whose normal bisects the end normals, and a rational piece's hull is the hull's alone (otherwise a plain elliptical arc's partial
// pixels read their own coverage twice, the band's and the hull's).
//
//   LBH_DUMP=dir   write each cell's Loop-Blinn | Chrome 8x | Slug as PNGs.
import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref } from './_chrome8Ref.mjs';

const SLIVER =
  'M1.137 -1.723A0.800 0.010 270.000 0 1 1.146 -1.323A0.800 0.010 270.000 0 1 1.146 -0.523A0.800 0.010 270.000 0 1 1.137 -0.123' +
  'A0.800 0.010 270.000 0 1 1.128 -0.523A0.800 0.010 270.000 0 1 1.128 -1.323A0.800 0.010 270.000 0 1 1.137 -1.723L1.137 -1.723Z';
// The view box is square: Chrome's image is stretched to the canvas, Mantle's fit keeps the aspect, and the two agree only on a square.
const SLIVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3.2031329774563906 ${-5.273327324521942 - (9.613519001801487 - 8.567706403873396) / 2} 9.613519001801487 9.613519001801487"><path d="${SLIVER}" fill="#000"/></svg>`;
// A plain elliptical arc (a rational quad band over its hull): the same defect family's other half.
const BUMP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M 10 60 L 20 60 A 30 25 20 0 1 70 55 L 90 60 L 90 90 L 10 90 Z" fill="#000"/></svg>';
const CELLS = [
  { id: 'sliver512', svg: SLIVER_SVG, N: 512, holes: true },
  { id: 'sliver2048', svg: SLIVER_SVG, N: 2048, holes: true },
  { id: 'bump256', svg: BUMP_SVG, N: 256, over: true },
];

const pngOf = (w, h, rgba) => {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      len = Buffer.alloc(4),
      c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
const alphaPng = (w, h, a) => {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = 255 - a[i * 4 + 3];
    o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v;
    o[i * 4 + 3] = 255;
  }
  return pngOf(w, h, o);
};

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const ref = await openChrome8Ref(launchBrowser);
try {
  for (const c of CELLS) {
    const lb = await ref.render(c.svg, { w: c.N, h: c.N, route: 'lb', ground: 'clear' });
    const slug = await ref.render(c.svg, { w: c.N, h: c.N, route: 'none', ground: 'clear' });
    if (!(lb.drew.lb > 0))
      fail(`${c.id}: not drawn by the Loop-Blinn route (${JSON.stringify(lb.drew)})`);
    // under = Chrome's alpha over Mantle's (ink missing); over = the reverse; counted past 64/255, as the box-averaged AA reference is exact to a few bytes.
    const count = (m, ch) => {
      let under = 0,
        over = 0,
        worstU = 0,
        worstO = 0;
      for (let i = 3; i < m.length; i += 4) {
        const d = ch[i] - m[i];
        if (d > 64) under++;
        if (-d > 64) over++;
        if (d > worstU) worstU = d;
        if (-d > worstO) worstO = -d;
      }
      return { under, over, worstU, worstO };
    };
    const l = count(lb.mantle, lb.chrome),
      s = count(slug.mantle, slug.chrome);
    console.log(
      `${c.id}: Loop-Blinn too light ${l.under} (worst ${l.worstU}) too dark ${l.over} (worst ${l.worstO}); Slug too light ${s.under} (worst ${s.worstU}) too dark ${s.over} (worst ${s.worstO})`,
    );
    if (process.env.LBH_DUMP) {
      mkdirSync(process.env.LBH_DUMP, { recursive: true });
      writeFileSync(`${process.env.LBH_DUMP}/${c.id}-lb.png`, alphaPng(c.N, c.N, lb.mantle));
      writeFileSync(`${process.env.LBH_DUMP}/${c.id}-chrome.png`, alphaPng(c.N, c.N, lb.chrome));
      writeFileSync(`${process.env.LBH_DUMP}/${c.id}-slug.png`, alphaPng(c.N, c.N, slug.mantle));
    }
    if (c.holes && l.under > s.under)
      fail(
        `${c.id}: ${l.under} pixels more than 64/255 too light under Loop-Blinn (Slug ${s.under})`,
      );
    if (c.over && l.over > s.over)
      fail(`${c.id}: ${l.over} pixels more than 64/255 too dark under Loop-Blinn (Slug ${s.over})`);
  }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (failures) {
  console.error(`lbBandHookGpuSmoke FAIL (${failures})`);
  process.exit(1);
}
console.log('lbBandHookGpuSmoke PASS');
