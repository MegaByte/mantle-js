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
for (const [label, f] of [
  ['synthetic close', '/tmp/openFill_min_open.svg'],
  ['authored L', '/tmp/openFill_authored_line.svg'],
]) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const c = new Float32Array(b.curves);
  const r = b.curveRangesByShape[0];
  const segs = decodeSegs(c, r.begin, r.end);
  const N = 256,
    vx = 1740,
    vy = 778,
    vw = 28,
    vh = 28;
  let inside = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const ux = vx + ((i + 0.5) * vw) / N,
        uy = vy + ((j + 0.5) * vh) / N;
      if (pointInFill(segs, ux, uy, false, null)) inside++;
    }
  console.log(
    `${label}: decoded ${segs.length} seg(s)  [${segs.map((s) => `t${s.t}${s.f ? 'F' : ''}`).join(' ')}]  CPU inside = ${inside} of ${N * N}`,
  );
}
