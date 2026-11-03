// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzWireCost — what the constraint table costs, and which blocks actually read the arc texels.
//
// The block is a UNIFORM stride because the kernel addresses it as `idx * CP_BLOCK_TEXELS` -- a
// shift and a mask. That uniformity is what the two arc texels cost: a line, a hull plane and a
// separator all pay for slots they never read. This prices the difference against a dense side
// table addressed by an index, which is the shape a cheaper version would take.
import { readFileSync, readdirSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape, CP_BLOCK_TEXELS } from '../src/renderer/cpatchPack.js';

const TEXEL = 16; // RGBAFloat
let blocks = 0,
  curveBlocks = 0,
  quadBlocks = 0;
for (const file of process.argv.slice(2)) {
  const s = await importSvg(readFileSync(file, 'utf8'));
  const cf = new Float32Array(s.curves);
  for (const r of s.curveRangesByShape || []) {
    const list = contoursToConverter(
      curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
      null,
    );
    if (!list || !list.length) continue;
    let p = null;
    try {
      p = packCPatchShape(list, 0, {});
    } catch {
      continue;
    }
    if (!p || !p.texels) continue;
    const t = p.texels;
    for (let b = 0; b * CP_BLOCK_TEXELS * 4 < t.length; b++) {
      blocks++;
      const k = t[b * CP_BLOCK_TEXELS * 4 + 3];
      if (k >= 14 || k % 8 === 0) continue; // line, hull plane, separator: no arc
      curveBlocks++;
      if (k % 8 === 1 || k % 8 === 5) quadBlocks++;
    }
  }
}
const mb = (tx) => ((tx * TEXEL) / 1048576).toFixed(3) + ' MB';
const at5 = blocks * 5,
  at7 = blocks * 7,
  side = blocks * 5 + curveBlocks * 2;
console.log(
  `${blocks} blocks, ${curveBlocks} of them curves (${((100 * curveBlocks) / blocks).toFixed(1)}%)` +
    `, ${quadBlocks} of those degree 2`,
);
console.log(`  stride 5 (no arc)          ${String(at5).padStart(7)} texels  ${mb(at5)}`);
console.log(
  `  stride 7 (what ships)      ${String(at7).padStart(7)} texels  ${mb(at7)}   +${((100 * (at7 - at5)) / at5).toFixed(0)}%`,
);
console.log(
  `  stride 5 + dense arc table ${String(side).padStart(7)} texels  ${mb(side)}   +${((100 * (side - at5)) / at5).toFixed(0)}%  (not built)`,
);
