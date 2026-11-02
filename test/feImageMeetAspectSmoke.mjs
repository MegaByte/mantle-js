// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImageMeetAspectSmoke — feImage's preserveAspectRatio "meet" letterboxes against the filter
// region's own aspect, not a square.
//
// A region fit (an feImage that references an <image> by id) that takes the region as square stretches
// a square image in a 2:1 region across all of it instead of drawing it 1:1 in the middle half, and in a
// 1:2 region letterboxes it the wrong way. So feImageMaps takes the region's width / height
// (the handler passes the region box it fits to, which on this path is the canvas).
//   (1) the maps themselves: where the image's [0,1]² lands in the region, for square, wide and tall
//       images in 1:1, 2:1 and 1:2 regions, and 'none' still stretching;
//   (2) the handler: what primitives/image.js uploads for a 200 x 100 and a 100 x 200 canvas (a
//       square region fit fails this);
//   (3) the pixels, the shipped feImage shader on the CPU in float32 (test/_fragEmu.mjs) over a
//       200 x 100 target with a square left-red / right-blue image: margins transparent, red then
//       blue in the middle half.
// Chrome: test/feImageMeetAspectRenderSmoke.mjs (render lane).
import path from 'path';
import { fileURLToPath } from 'url';
import { feImageMaps, feImage } from '../src/filterGraph/primitives/image.js';
import { hasCxx, buildFragEmu, generatedShader } from './_fragEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b) => Math.abs(a - b) < 1e-9;
/// Where the image's uv 0 and 1 fall in the region's uv, per axis: vUV = (uv - o) / s.
const span = (m) => [
  [(0 - m[2]) / m[0], (1 - m[2]) / m[0]],
  [(0 - m[3]) / m[1], (1 - m[3]) / m[1]],
];
const ID = [1, 1, 0, 0];

// (1)
for (const [name, iw, ih, aspect, par, want] of [
  [
    'square image, 1:1 region',
    4,
    4,
    1,
    1,
    [
      [0, 1],
      [0, 1],
    ],
  ],
  [
    'square image, 2:1 region',
    4,
    4,
    2,
    1,
    [
      [0.25, 0.75],
      [0, 1],
    ],
  ],
  [
    'square image, 1:2 region',
    4,
    4,
    0.5,
    1,
    [
      [0, 1],
      [0.25, 0.75],
    ],
  ],
  [
    '2:1 image, 2:1 region',
    8,
    4,
    2,
    1,
    [
      [0, 1],
      [0, 1],
    ],
  ],
  [
    '4:1 image, 2:1 region',
    16,
    4,
    2,
    1,
    [
      [0, 1],
      [0.25, 0.75],
    ],
  ],
  [
    '1:4 image, 1:2 region',
    4,
    16,
    0.5,
    1,
    [
      [0.25, 0.75],
      [0, 1],
    ],
  ],
  [
    'square image, 2:1 region, none',
    4,
    4,
    2,
    0,
    [
      [0, 1],
      [0, 1],
    ],
  ],
]) {
  const s = span(feImageMaps(ID, par, [0, iw, ih], [16, 16], aspect).img);
  const good = s.every((ax, i) => near(ax[0], want[i][0]) && near(ax[1], want[i][1]));
  ok(
    good,
    `(1) ${name}: the image spans x ${s[0].map((v) => +v.toFixed(4)).join('..')}, y ${s[1].map((v) => +v.toFixed(4)).join('..')} ` +
      `of the region (want x ${want[0].join('..')}, y ${want[1].join('..')})`,
  );
}

// (2) the handler, for a wide and a tall canvas (the region this path fits to)
const run = (w, h) => {
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
    { type: 'feImage', params: { imageId: 1, preserveAR: 1 } },
    [],
    { fbo: {}, size: [w, h] },
    {
      gl,
      w,
      h,
      feImageProg: {},
      feImageU: new Proxy({}, { get: (_t, k) => k }),
      coverVao: {},
      bundle: { imageAtlasTex: {}, imageAtlasRects: [[0, 4, 4]], imageAtlasSize: [4, 4] },
    },
  );
  return u;
};
for (const [w, h, want] of [
  [
    200,
    100,
    [
      [0.25, 0.75],
      [0, 1],
    ],
  ],
  [
    100,
    200,
    [
      [0, 1],
      [0.25, 0.75],
    ],
  ],
]) {
  const m = run(w, h).get('uImgMap');
  const s = m ? span(m) : null;
  ok(
    s && s.every((ax, i) => near(ax[0], want[i][0]) && near(ax[1], want[i][1])),
    `(2) a ${w} x ${h} region: the handler letterboxes a square image to x ${s ? s[0].map((v) => +v.toFixed(4)).join('..') : '?'}, ` +
      `y ${s ? s[1].map((v) => +v.toFixed(4)).join('..') : '?'} (want x ${want[0].join('..')}, y ${want[1].join('..')})`,
  );
}

// (3) the pixels, through the shipped shader
if (!hasCxx()) console.log('  SKIP (3): no C++ compiler for the shader emulator');
else {
  const W = 200,
    H = 100;
  const u = run(W, H);
  const atlas = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      atlas.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 4 + x) * 4);
  const e = buildFragEmu(generatedShader(ROOT, 'feImage.frag.glsl'));
  const frags = [];
  for (const x of [25, 60, 140, 175]) frags.push({ vUV: [(x + 0.5) / W, (50 + 0.5) / H] });
  const out = e.run({
    uniforms: { uImgMap: u.get('uImgMap'), uAtlasMap: u.get('uAtlasMap') },
    textures: {
      uIn: { w: 4, h: 4, data: Float32Array.from(atlas, (v) => v / 255), linear: false },
    },
    frags,
  });
  const px = (i) =>
    Array.from(out.slice(i * e.stride, i * e.stride + 4)).map((v) => Math.round(v * 255));
  const want = [
    [0, 0, 0, 0],
    [255, 0, 0, 255],
    [0, 0, 255, 255],
    [0, 0, 0, 0],
  ];
  const got = [0, 1, 2, 3].map(px);
  ok(
    got.every((g, i) => g.join() === want[i].join()),
    `(3) a square image in a 200 x 100 region, at x 25 / 60 / 140 / 175: ${got.map((g) => '(' + g.join(',') + ')').join(' ')} ` +
      `(want margin, red, blue, margin)`,
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
