// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImageOrientationSmoke — an feImage that references an <image> by id draws it the right way up.
//
// The image atlas is uploaded as decoded, first row first: texture row 0 is the image's TOP. A filter
// pass's vUV runs up the canvas (GL), so a region fit that reads atlas row atlasY + uv.y * atlasH puts
// the image's top row at the BOTTOM of the region: every id-referenced feImage would draw upside down.
// (The placed path for external images reads 1 - uv.y.) So the region fit's atlas map runs the rows
// the other way.
//
// HOW: the real importer builds the atlas from a top-red / bottom-blue image (through a stand-in
// decoder: node has no Image or 2D canvas), the real bundle holds its slot, the real handler uploads
// the maps for a square region, and the SHIPPED feImage shader runs on the CPU in float32
// (test/_fragEmu.mjs) with the atlas exactly as uploaded. A fragment near the top of the region must
// read red, one near the bottom blue; also through a slot that does not start at atlas row 0, and in
// a 2:1 region. Chrome: test/feImageOrientationRenderSmoke.mjs (render lane).
import path from 'path';
import { fileURLToPath } from 'url';
import { createFakeGl } from './_fakeGl.mjs';
import { hasCxx, buildFragEmu, generatedShader } from './_fragEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasCxx()) {
  console.log('SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
// The stand-in decoder: an href names its image, "#top-red" (8 x 8, top half red, bottom half blue)
// or "#green" (8 x 4, all green), decoded to rows TOP FIRST, as a browser's getImageData returns them.
const IMAGES = {
  'top-red': { w: 8, h: 8, px: (x, y) => (y < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]) },
  green: { w: 8, h: 4, px: () => [0, 160, 0, 255] },
};
globalThis.Image = class {
  set src(v) {
    this.spec = IMAGES[String(v).split('#')[1]];
    setTimeout(() => {
      this.naturalWidth = this.spec.w;
      this.naturalHeight = this.spec.h;
      this.onload && this.onload();
    }, 0);
  }
};
globalThis.document = {
  createElement: () => {
    let drawn = null; // the image this canvas was handed
    return {
      getContext: () => ({
        drawImage(img) {
          drawn = img.spec;
        },
        getImageData: (_x, _y, w, h) => {
          const d = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) d.set(drawn.px(x, y), (y * w + x) * 4);
          return { data: d };
        },
      }),
    };
  },
};
const { importSvg, createBundle } = await import('../src/index.js');
const { feImage } = await import('../src/filterGraph/primitives/image.js');
const emu = buildFragEmu(generatedShader(ROOT, 'feImage.frag.glsl'));

async function colors(W, H, withOtherFirst) {
  // An feImage of another image, in a filter parsed first, claims the atlas's first rows, so the
  // slot under test starts lower.
  const first = withOtherFirst
    ? `<image id="g" x="0" y="0" width="${W}" height="${H}" href="data:image/png;base64,AA#green"/>` +
      '<filter id="f0" x="0" y="0" width="100%" height="100%"><feImage href="#g"/></filter>'
    : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${first}` +
    `<image id="img" x="0" y="0" width="${W}" height="${H}" href="data:image/png;base64,AA#top-red"/>` +
    '<filter id="f" x="0" y="0" width="100%" height="100%"><feImage href="#img"/></filter></defs>' +
    `${withOtherFirst ? `<rect width="${W}" height="${H}" filter="url(#f0)"/>` : ''}<rect width="${W}" height="${H}" filter="url(#f)"/></svg>`;
  const sec = await importSvg(svg, { preserveViewport: true });
  const b = createBundle(createFakeGl({ width: W, height: H }).gl, sec);
  const node = (b.filterGraphs || [])
    .filter(Boolean)
    .flatMap((g) => g.nodes)
    .filter((n) => n.type === 'feImage')
    .find((n) => IMAGES['top-red'].h === (n.params.imgH | 0));
  const u = new Map();
  const gl = new Proxy(
    {},
    {
      get: (_t, k) =>
        typeof k === 'string' && k.startsWith('uniform')
          ? (l, ...v) => u.set(l, v.length === 1 ? v[0] : v)
          : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)
            ? 0
            : () => {},
    },
  );
  feImage(
    node,
    [],
    { fbo: {}, size: [W, H] },
    {
      gl,
      w: W,
      h: H,
      feImageProg: {},
      feImageU: new Proxy({}, { get: (_t, k) => k }),
      coverVao: {},
      bundle: b,
    },
  );
  const [aw, ah] = sec.imageAtlasDim;
  const atlas = new Uint8Array(sec.imageAtlas); // uploaded as is: texture row 0 is the first row here
  const slot = b.imageAtlasRects[(node.params.imageId | 0) - 1];
  const out = emu.run({
    uniforms: { uPlaced: 0, uImgMap: u.get('uImgMap'), uAtlasMap: u.get('uAtlasMap') },
    textures: {
      uIn: { w: aw, h: ah, data: Float32Array.from(atlas, (v) => v / 255), linear: false },
    },
    frags: [{ vUV: [0.5, 0.85] }, { vUV: [0.5, 0.15] }],
  }); // vUV.y runs UP the canvas
  const px = (i) =>
    Array.from(out.slice(i * emu.stride, i * emu.stride + 4)).map((v) => Math.round(v * 255));
  return { top: px(0), bottom: px(1), slotY: slot[0] };
}
const name = (c) =>
  c[0] > 200 && c[2] < 50 ? 'red' : c[2] > 200 && c[0] < 50 ? 'blue' : `(${c.join(',')})`;
for (const [W, H, other] of [
  [64, 64, false],
  [64, 64, true],
  [128, 64, false],
]) {
  const r = await colors(W, H, other);
  ok(
    name(r.top) === 'red' && name(r.bottom) === 'blue',
    `a top-red / bottom-blue image in a ${W} x ${H} region, its slot at atlas row ${r.slotY}: ` +
      `near the top ${name(r.top)}, near the bottom ${name(r.bottom)} (want red, blue)`,
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
