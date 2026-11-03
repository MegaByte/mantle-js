// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Imported pattern and mask image rows preserve scalar opacity.
// Shader output is checked by physical render tests.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
// A raster <image> is decoded through Image + a 2D canvas, which node lacks: a stand-in that "decodes"
// any href to an opaque 4 x 4 bitmap is enough to reach the importer's image leaf.
globalThis.Image = class {
  set src(_v) {
    setTimeout(() => {
      this.naturalWidth = 4;
      this.naturalHeight = 4;
      this.onload && this.onload();
    }, 0);
  }
};
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      drawImage() {},
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
    }),
  }),
};
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the importer: a child image row's paint carries its opacity ----------------------------------
{
  const IMG = 'data:image/png;base64,iVBORw0KGgo=';
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>
      <pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><image width="10" height="10" href="${IMG}" opacity="50%"/></pattern>
      <mask id="m"><image width="100" height="100" href="${IMG}" opacity="calc(20% + 20%)"/></mask>
    </defs>
    <rect width="50" height="50" fill="url(#p)"/>
    <rect x="50" width="50" height="50" fill="#000" mask="url(#m)"/></svg>`,
    { preserveViewport: true },
  );
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    alphas = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (F[o + M.META_IMAGE_ID] > 0 && F[o + 4] === 1 && F[o + 5] === 1 && F[o + 6] === 1)
      alphas.push(+F[o + 7].toFixed(4));
  }
  alphas.sort();
  ok(
    alphas.length === 2 && alphas[0] === 0.4 && alphas[1] === 0.5,
    `the pattern child and the mask child store their image paint as (1,1,1,opacity): alphas ${alphas.join(', ')}, want 0.4 and 0.5`,
  );
}

console.log(fail ? `childImageOpacitySmoke FAIL (${fail})` : 'childImageOpacitySmoke PASS');
process.exit(fail ? 1 : 0);
