// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// evenOddCoincidentRenderSmoke -- under even-odd a contour drawn twice adds nothing, so its pair leaves no ink.
//
// The winding integral on the default cover route reads 2c on a pixel the two copies' edge crosses, and folded by even-odd that is a full pixel at c = 1/2 where the coverage is 0: a ring
// round the contour (249/255 at 128 px), in whatever direction and from whatever start the copies run. The reference is Chrome at 8x, box-averaged. A third copy stays, and a shape beside the pair is untouched. Under nonzero a lone contour drawn twice the same way overstated its edge, fold(2c), for the same reason.
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref } from './_chrome8Ref.mjs';

const N = 128;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const eo = (d) => svg(`<path fill="#000" fill-rule="evenodd" d="${d}"/>`);
const CUB = 'M20 64C20 108 108 108 108 64C108 20 20 20 20 64Z',
  CUB_REV = 'M20 64C20 20 108 20 108 64C108 108 20 108 20 64Z',
  CUB_ROT = 'M108 64C108 20 20 20 20 64C20 108 108 108 108 64Z';
const QUAD = 'M20.5 64Q64 10 107.5 64Q64 118 20.5 64Z',
  TRI = 'M20.5 20.5L108 40L60 108Z',
  ARC = 'M24.5 64A40 30 20 0 1 104.5 64A40 30 20 0 1 24.5 64Z',
  SQUARE = 'M50 50H78V78H50Z';
const CASES = [
  ['a cubic contour twice', eo(CUB + CUB)],
  ['the copy reversed', eo(CUB + CUB_REV)],
  ['the copy from another start', eo(CUB + CUB_ROT)],
  ['a quad contour twice', eo(QUAD + QUAD)],
  ['a line contour twice', eo(TRI + TRI)],
  ['an arc contour twice', eo(ARC + ARC)],
  ['a pair and a square inside it', eo(TRI + SQUARE + TRI)],
  ['three copies', eo(CUB + CUB + CUB)],
  ['nonzero: a cubic contour twice', svg(`<path fill="#000" d="${CUB + CUB}"/>`)],
  [
    'nonzero: from another start',
    svg(`<path fill="#000" d="${CUB + 'M108 64C108 20 20 20 20 64C20 108 108 108 108 64Z'}"/>`),
  ],
  [
    'nonzero: the copy reversed, which winds to nothing',
    svg(`<path fill="#000" d="${CUB + CUB_REV}"/>`),
  ],
];
const ref = await openChrome8Ref(launchBrowser);
let failures = 0;
for (const [name, s] of CASES) {
  const { mantle, chrome, drew } = await ref.render(s, { w: N, h: N });
  let off = 0,
    worst = 0;
  for (let i = 0; i < N * N * 4; i += 4) {
    const d = Math.abs(mantle[i + 1] - chrome[i + 1]);
    if (d > worst) worst = d;
    if (d > 24) off++;
  }
  const ok = off === 0;
  console.log(
    `  ${ok ? 'ok' : 'FAIL'} ${name}: ${off} px off Chrome 8x by more than 24/255 (worst ${worst}, drew ${Object.keys(drew).join('+') || 'nothing'})`,
  );
  if (!ok) failures++;
}
await ref.close();
if (failures) {
  console.error(`evenOddCoincidentRenderSmoke: ${failures} of ${CASES.length} failed`);
  process.exit(1);
}
console.log(`evenOddCoincidentRenderSmoke: ${CASES.length} cases match Chrome 8x`);
