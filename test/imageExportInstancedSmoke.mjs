// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// imageExportInstancedSmoke: frame export sees every image a frame drew, and a DOM source keeps its own size.
//
// 1. drawImageInstanced records its draws as drawImage does; recording nothing, an exported frame would lose those images with no note and no count.
// 2. drawImage records the caller's arrays by value: by reference, a caller reusing one matrix or rect for every draw would export each at the last placement.
// 3. createImage sizes the upload from the source's natural size, not an element's width and height (its layout size): an <img> laid out at half its natural
//    size would keep half a srcRect's mapping and draw at the wrong default size, and a video, whose width is 0 until laid out, would give no image.
// CPU: the frame log and the export (node, stand-in GL), and the uniforms of the draw.
const { mkRenderer, exportDetail, els } = await import('./_exportHarness.mjs');
const warn = console.warn;
console.warn = () => {};
let fails = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('PASS', name);
  else {
    fails++;
    console.log('FAIL', name, detail ?? '');
  }
};

const { F, R, gl } = await mkRenderer(100, 100);
const img = R.createImage({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });

class HTMLImageElement {
  constructor(a) {
    Object.assign(this, a);
  }
}
const pic = new HTMLImageElement({
  nodeType: 1,
  tagName: 'IMG',
  src: 'data:image/png;base64,AAAA',
  width: 2,
  height: 2,
});
const images = (svg) =>
  els(svg, 'image').map((e) => {
    const x = e.getAttribute('x'),
      t = e.getAttribute('transform');
    return `${x} ${e.getAttribute('width')} ${t || ''}`.trim();
  });

R.beginFrame([0, 0, 0, 0]);
const inst = [
  { dstRect: [0, 0, 10, 10], tint: [1, 0, 0, 1] },
  { dstRect: [20, 0, 10, 10], alpha: 0.5 },
  { dstRect: [40, 0, 10, 10] },
];
check('the instanced draw drew', R.drawImageInstanced(pic, inst, { blendMode: 1 }) === 3);
R.endFrame();
const ex = await exportDetail(R);
const inSvg = images(ex.svg);
check(
  'the export holds one image per instance',
  ex.drawn === 3 && inSvg.length === 3,
  JSON.stringify({ drawn: ex.drawn, skipped: ex.skipped, inSvg }),
);
check('each at its own place', new Set(inSvg).size === 3, JSON.stringify(inSvg));
R.beginFrame([0, 0, 0, 0]);
R.drawImageInstanced(img, [{ dstRect: [0, 0, 1, 1] }, { dstRect: [2, 0, 1, 1] }]);
R.endFrame();
const gpu = await exportDetail(R);
check(
  'a GPU handle reads as skipped, per instance, with its note',
  gpu.skipped === 2 && gpu.notes.length > 0,
  JSON.stringify({ d: gpu.drawn, s: gpu.skipped }),
);

// A reused matrix and rect.
R.beginFrame([0, 0, 0, 0]);
const dst = [0, 0, 10, 10],
  wm = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
for (let i = 0; i < 3; i++) {
  dst[0] = i * 20;
  wm[6] = i;
  R.drawImage(pic, { dstRect: dst, worldMatrix: wm });
}
R.endFrame();
const reused = images((await exportDetail(R)).svg);
check(
  'each draw keeps its own placement',
  reused.length === 3 && new Set(reused).size === 3,
  JSON.stringify(reused),
);

// A DOM source's size is its upload's.
class HTMLVideoElement {
  constructor(a) {
    Object.assign(this, a);
  }
}
const laid = R.createImage(
  new HTMLImageElement({ width: 50, height: 25, naturalWidth: 100, naturalHeight: 50 }),
);
check(
  'an image laid out at half size has its natural size',
  laid && laid.width === 100 && laid.height === 50,
  laid && [laid.width, laid.height],
);
const video = R.createImage(
  new HTMLVideoElement({ width: 0, height: 0, videoWidth: 64, videoHeight: 32 }),
);
check(
  'a video has its own size',
  video && video.width === 64 && video.height === 32,
  video && [video.width, video.height],
);
class ImageBitmap {
  constructor(a) {
    Object.assign(this, a);
  }
}
const bmp = R.createImage(new ImageBitmap({ width: 8, height: 4 }));
check('a bitmap keeps its width and height', bmp && bmp.width === 8 && bmp.height === 4);
R.beginFrame([0, 0, 0, 0]);
R.drawImage(laid, { srcRect: [50, 0, 50, 50] });
const draw = F.log.filter((e) => e.op === 'draw').at(-1);
const uv = draw && draw.uni && draw.uni.uSrcRect;
check(
  'a srcRect in pixels maps by the natural size',
  uv && Math.abs(uv[0] - 0.5) < 1e-6 && Math.abs(uv[2] - 0.5) < 1e-6,
  JSON.stringify(uv),
);
R.endFrame();
console.warn = warn;
if (fails) {
  console.log(`imageExportInstancedSmoke: ${fails} FAILED`);
  process.exit(1);
}
console.log('imageExportInstancedSmoke PASS');
process.exit(0);
