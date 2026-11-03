// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// atlasDedupeSmoke -- the same raster embedded by several elements decodes once and shares ONE atlas region.
// (Without that, every <image> element packs its own copy, so 20 uses of one 512 px picture make a 10240 px tall atlas.)
// A decode stub stands in for the browser: href "data:image/png;base64,W{w}H{h}K{k}" is a w x h bitmap filled with byte k.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
let decodes = 0;
globalThis.Image = class {
  set src(v) {
    this._s = v;
    const m = /W(\d+)H(\d+)(?:K(\d+))?/.exec(v || '');
    decodes++;
    this._k = m && m[3] ? +m[3] : 200;
    setTimeout(() => {
      if (!m) {
        this.onerror && this.onerror();
        return;
      }
      this.naturalWidth = +m[1];
      this.naturalHeight = +m[2];
      this.onload && this.onload();
    }, 0);
  }
  get src() {
    return this._s;
  }
};
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => {
      let k = 200;
      return {
        drawImage(img) {
          k = img._k;
        },
        getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(k) }),
      };
    },
  }),
};
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const warn = console.warn;
console.warn = () => {};
const IMG = (w, h, k = 200) => `data:image/png;base64,W${w}H${h}K${k}`;
const doc = (body, vb = '0 0 100 8') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb}">${body}</svg>`;
const imp = async (body, o = {}) => {
  decodes = 0;
  return importSvg(doc(body), { preserveViewport: true, ...o });
};
/// The atlasSlot (texel 10: y, w, h, flags) of every drawn row that has an image.
const slots = (b) => {
  const st = b.metaFloatsPerShape,
    mf = parseMetaBin(b.meta, st).metaFloats,
    out = [];
  for (let r = 0; r < mf.length / st; r++) {
    const o = r * st;
    if (Math.round(mf[o + 27]) & (64 | 128 | 256)) continue;
    out.push(Array.from(mf.slice(o + 40, o + 44)));
  }
  return out;
};

console.log('one href, many elements: one decode, one region');
{
  const els = (n, href) =>
    [...Array(n)]
      .map((_, i) => `<image x="${i * 4}" width="4" height="4" href="${href}"/>`)
      .join('');
  const one = await imp(els(1, IMG(64, 64)));
  const twenty = await imp(els(20, IMG(64, 64)));
  check(decodes === 1, `20 elements decode once (${decodes} decodes)`);
  check(
    JSON.stringify(twenty.imageAtlasDim) === JSON.stringify(one.imageAtlasDim) &&
      twenty.imageAtlasDim[1] === 64,
    `the atlas is one picture tall (${JSON.stringify(twenty.imageAtlasDim)})`,
  );
  check(twenty.imageAtlasRects.length === 1, 'one atlas rect');
  const s = slots(twenty);
  check(
    s.length === 20 && s.every((t) => t[0] === s[0][0] && t[1] === 64 && t[2] === 64),
    'all 20 rows point at the same region',
  );
  check(
    twenty.imageAtlas.byteLength === one.imageAtlas.byteLength,
    `the atlas bytes are the single picture's (${twenty.imageAtlas.byteLength})`,
  );
}
console.log('different pictures stay different');
{
  const b = await imp(
    `<image width="4" height="4" href="${IMG(64, 64, 10)}"/><image x="5" width="4" height="4" href="${IMG(64, 64, 20)}"/><image x="10" width="4" height="4" href="${IMG(32, 16, 10)}"/>`,
  );
  check(
    b.imageAtlasRects.length === 3 && b.imageAtlasDim[1] === 64 + 64 + 16,
    `three hrefs, three regions (${JSON.stringify(b.imageAtlasDim)})`,
  );
  const s = slots(b);
  check(new Set(s.map((t) => t[0])).size === 3, 'three distinct atlas offsets');
  const px = new Uint8Array(b.imageAtlas);
  check(px[0] === 10 && px[64 * 64 * 4] === 20, 'each region holds its own pixels');
}
console.log('mixed: repeated and single pictures');
{
  const A = IMG(40, 10, 5),
    B = IMG(40, 20, 6);
  const b = await imp(
    `<image width="4" height="4" href="${A}"/><image x="5" width="4" height="4" href="${B}"/><image x="10" width="4" height="4" href="${A}"/><image x="15" width="4" height="4" href="${B}"/>`,
  );
  check(
    decodes === 2 && b.imageAtlasDim[1] === 30 && b.imageAtlasRects.length === 2,
    `two pictures, two decodes, atlas ${JSON.stringify(b.imageAtlasDim)}`,
  );
  const s = slots(b);
  check(
    s[0][0] === s[2][0] && s[1][0] === s[3][0] && s[0][0] !== s[1][0],
    'alternating uses map to two regions',
  );
}
console.log('per-row state stays per row');
{
  const A = IMG(16, 16);
  const b = await imp(
    `<image width="4" height="4" href="${A}" style="image-rendering:pixelated"/><image x="5" width="4" height="4" href="${A}"/>`,
  );
  const s = slots(b);
  check(
    s.length === 2 && s[0][0] === s[1][0] && (s[0][3] & 4) === 4 && (s[1][3] & 4) === 0,
    'image-rendering: pixelated is a flag of its row, not of the shared region',
  );
}
console.log('no repeated picture: nothing moves');
{
  const b = await imp(
    `<image width="4" height="4" href="${IMG(8, 8, 1)}"/><image x="5" width="4" height="4" href="${IMG(8, 8, 2)}"/>`,
  );
  check(
    b.imageAtlasRects.length === 2 && b.imageAtlasDim[1] === 16,
    'distinct images keep the stacked layout',
  );
}
console.warn = warn;
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('atlasDedupeSmoke: all passed');
