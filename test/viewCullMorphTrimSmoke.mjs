// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// viewCullMorphTrimSmoke -- the view-cull trim of the unified fill stream reads each row's box from the bundle's meta, which on a morph is the SOURCE pose's.
// A row that lies outside the canvas at t=0 can move inside it at another t, so a morph draw must not trim. A static draw still trims.
import { visibleTrimSpan } from '../src/renderer/viewCull.js';
import {
  META_BBOX_XMIN,
  META_BBOX_YMIN,
  META_BBOX_XMAX,
  META_BBOX_YMAX,
} from '../src/bundle/layout.js';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok ' + m);
  else {
    failures++;
    console.error('FAIL: ' + m);
  }
};

const STRIDE = 64,
  N = 3;
const meta = new Float32Array(STRIDE * N);
// rows 0..2 in a 100x100 document; row 0 lies far to the left of it (outside the canvas), rows 1 and 2 inside
const boxes = [
  [-500, 10, -480, 30],
  [20, 20, 40, 40],
  [60, 60, 80, 80],
];
boxes.forEach((b, i) => {
  meta[i * STRIDE + META_BBOX_XMIN] = b[0];
  meta[i * STRIDE + META_BBOX_YMIN] = b[1];
  meta[i * STRIDE + META_BBOX_XMAX] = b[2];
  meta[i * STRIDE + META_BBOX_YMAX] = b[3];
});
const bundle = {
  globalBBox: [0, 0, 100, 100],
  metaFloats: meta,
  metaFloatsPerShape: STRIDE,
  numShapes: N,
};
const cache = {
  spanV: new Int32Array([0, 6, 12]),
  spanN: new Int32Array([6, 6, 6]),
  spanS: new Int32Array([0, 1, 2]),
  vertexCount: 18,
};
const R = {
  opts: {},
  draw: { worldM: null, overrides: null },
  viewportSize: () => [100, 100],
  arScale: () => [1, 1],
};

const stat = visibleTrimSpan(R, bundle, cache, false);
check(
  stat && stat.first === 6 && stat.count === 12,
  'a static draw trims the off-canvas leading row: ' + JSON.stringify(stat),
);
check(visibleTrimSpan(R, bundle, cache, true) === null, 'a morph draw does not trim');
check(visibleTrimSpan(R, bundle, cache) !== null, 'the default (no flag) still trims');
process.exit(failures ? 1 : 0);
