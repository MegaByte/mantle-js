// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
const ROOT = process.env.MANTLE_ROOT || new URL('../..', import.meta.url).pathname; // the package tree to probe (default: this one)
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { parsePathD } = await import(ROOT + '/src/svg/path.js');
const { splitSubpathsWithCloseInto } = await import(ROOT + '/src/svg/bbox.js');
const D_OPEN = 'M 1723.8 784.1 C 1724.2 799.9 1742.0 799.2 1742.0 799.2';
for (const [label, d] of [
  ['OPEN', D_OPEN],
  ['Z', D_OPEN + ' Z'],
]) {
  const segs = parsePathD(d);
  const out = [];
  splitSubpathsWithCloseInto(segs, out);
  console.log(`${label}: parsed ${segs.length} seg(s) -> closed ${out.length}`);
  for (const s of out) {
    const p1 = s.p1,
      pl = s.p4 || s.p3 || s.p2;
    console.log(
      `   type=${s.type} synth=${!!s.synth} ${JSON.stringify(p1)} -> ${JSON.stringify(pl)}`,
    );
  }
}
