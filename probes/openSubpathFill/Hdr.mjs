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
for (const [label, f] of [
  ['synthetic close', '/tmp/openFill_min_open.svg'],
  ['authored L', '/tmp/openFill_authored_line.svg'],
]) {
  const b = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
  const c = new Float32Array(b.curves);
  const r = b.curveRangesByShape[0];
  console.log(`\n${label}: shape0 curves [${r.begin},${r.end})`);
  // each record: header texel (4 floats) then the geometry texels
  let i = r.begin;
  while (i < r.end) {
    const h = [c[i], c[i + 1], c[i + 2], c[i + 3]];
    const t = (h[0] | 0) & 3,
      fo = ((h[0] | 0) & 4) !== 0,
      ss = ((h[0] | 0) & 8) !== 0;
    const texels = t === 0 ? 2 : t === 1 ? 3 : 4; // line=hdr+1, quad=hdr+2, cubic=hdr+3
    console.log(
      `  hdr=${h[0]} type=${t} fillOnly=${fo} subStart=${ss} freeStart=${h[1]} freeEnd=${h[2]}`,
    );
    i += texels * 4;
  }
}
