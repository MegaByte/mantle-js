// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzOcclusionRuleAudit — which assets would a fill-rule-blind occlusion cull get WRONG?
//
// A containment test that ignores every shape's fill rule treats every shape as nonzero. So zeroing the
// fill-rule slot (meta 13) in a COPY of the meta reproduces that decision exactly, without changing any
// code, and the difference from the real decision is what a fill-rule-blind cull would cull wrongly.
import { readFileSync } from 'fs';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { computeOccludedShapes } = await import('../src/renderer/occlusionCull.js');
for (const f of process.argv.slice(2)) {
  let sec;
  try {
    sec = await importSvg(readFileSync(f, 'utf8'));
  } catch (e) {
    console.log(`${f.split('/').pop()}: import failed`);
    continue;
  }
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const cv = new Float32Array(sec.curves);
  const ranges = (sec.curveRangesByShape || []).map((r) => ({
    begin: r.begin | 0,
    end: r.end | 0,
  }));
  const MF = m.metaFloats,
    ST = m.floatsPerShape,
    n = m.numShapes;
  let eo = 0;
  for (let i = 0; i < n; i++) if (MF[i * ST + 13] > 0.5) eo++;
  const oldMeta = MF.slice();
  for (let i = 0; i < n; i++) oldMeta[i * ST + 13] = 0;
  const now = computeOccludedShapes(cv, ranges, MF, n, ST, 'full');
  const was = computeOccludedShapes(cv, ranges, oldMeta, n, ST, 'full');
  const wrongly = [...was].filter((i) => !now.has(i)).sort((a, b) => a - b);
  const newly = [...now].filter((i) => !was.has(i));
  console.log(
    `${f.split('/').pop().padEnd(34)} shapes ${String(n).padStart(4)}  even-odd ${String(eo).padStart(3)}  culled old ${String(was.size).padStart(3)} new ${String(now.size).padStart(3)}  ` +
      `WRONGLY CULLED BEFORE ${wrongly.length}${wrongly.length ? ' ' + JSON.stringify(wrongly) : ''}${newly.length ? '  (newly culled ' + newly.length + ')' : ''}`,
  );
}
