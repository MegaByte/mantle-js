// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzSeamPatchCensus — how many patches are bounded ENTIRELY by seams. Such a patch has nothing
// that can ramp: every constraint is a hard step, so it paints a flat 1.0 at any pixel whose
// center it contains, and the outline bound exists to give it the one thing it cannot see. The
// bound measures identically whether it is given to every patch or only to these (over0.3 159 and
// mean 0.0066 either way), so the outline rows on all the others are paid for and unused.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '../MantleSamples/Assets/Mantle/tiger.svg',
      ...readdirSync(path.join(ROOT, '../fixtures/svg'))
        .filter((f) => f.endsWith('.svg'))
        .map((f) => '../fixtures/svg/' + f),
    ];
let tP = 0,
  tSeam = 0,
  tFiles = 0;
for (const f of files) {
  let sec;
  try {
    sec = await importSvg(
      readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
        .replace(/stroke-width\s*=\s*"[^"]*"/g, ''),
      { preserveViewport: true },
    );
  } catch {
    continue;
  }
  const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
  const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  let fP = 0,
    fS = 0;
  for (let s = 0; s < meta.numShapes; s++) {
    const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
    if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
    let cs = null;
    try {
      cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
    } catch {
      continue;
    }
    if (!cs || !cs.length) continue;
    const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
    const ps = [];
    try {
      packCPatchShape(cs, 0, { evenOdd, onPatches: (a) => ps.push(...a) });
    } catch {
      continue;
    }
    for (const p of ps) {
      fP++;
      let allSeam = true;
      for (const sg of p.curves || [])
        if (!(sg && sg.cut)) {
          allSeam = false;
          break;
        }
      if (allSeam && (p.curves || []).length) fS++;
    }
  }
  if (!fP) continue;
  tFiles++;
  tP += fP;
  tSeam += fS;
  if (process.env.PER_FILE)
    console.log(
      `  ${path.basename(f).padEnd(28)} ${String(fS).padStart(5)} / ${String(fP).padStart(5)} (${((100 * fS) / fP).toFixed(1)}%)`,
    );
}
console.log(
  `${tFiles} files: ${tSeam} of ${tP} patches are all-seam (${((100 * tSeam) / Math.max(1, tP)).toFixed(1)}%)`,
);
console.log(
  `  outline rows are currently packed for ALL ${tP}; only these ${tSeam} change any pixel.`,
);
