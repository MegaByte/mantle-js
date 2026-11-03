// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
const ROOT = process.env.MANTLE_ROOT || new URL('../..', import.meta.url).pathname; // the package tree to probe (default: this one)
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(ROOT + '/src/svg/importer.js');
const { decodeSegs } = await import(ROOT + '/src/hitTest/curveGeom.js');
const { pointInFill } = await import(ROOT + '/src/hitTest/fillCoverage.js');
const b = await importSvg(readFileSync('/tmp/openFill_min_open.svg', 'utf8'), {
  preserveViewport: true,
});
const c = new Float32Array(b.curves);
const r = b.curveRangesByShape[0];
const segs = decodeSegs(c, r.begin, r.end);
const N = 512,
  vx = 1740,
  vy = 778,
  vw = 28,
  vh = 28;
const count = (ss) => {
  let n = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const ux = vx + ((i + 0.5) * vw) / N,
        uy = vy + ((j + 0.5) * vh) / N;
      if (pointInFill(ss, ux, uy, false, null)) n++;
    }
  return n;
};
const all = count(segs),
  dropLast = count(segs.slice(0, -1));
const tot = N * N;
console.log(`segments: ${segs.length}`);
console.log(
  `  ALL segments      : ${all} px = ${((100 * all) / tot).toFixed(3)}%   (true area = 10.35%)`,
);
console.log(`  LAST one DROPPED  : ${dropLast} px = ${((100 * dropLast) / tot).toFixed(3)}%`);
console.log(`  ratio dropped/all : ${(dropLast / all).toFixed(4)}`);
console.log(
  `\n  compare: the over-filled Slug render's ink ratio to the reference at 1024 is 80,628 / 61,286 = 1.3156`,
);
