import { readFileSync } from 'fs'; import path from 'path';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP; globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/renderer/lbContour.js');
const { buildLoopBlinnMesh } = await import('../src/renderer/lbFastMesh.js');
const { meshUnderCovers } = await import('../src/renderer/lbBuildCore.js');
let n = 0, fired = 0; const hits = [];
for (const f of process.env.LIST.split(',').filter(Boolean)) {
  let b; try { b = await importSvg(readFileSync(f, 'utf8')); } catch { continue; }
  const cf = new Float32Array(b.curves);
  for (let s = 0; s < b.numShapes; s++) {
    const r = b.curveRangesByShape[s]; if (!r || r.end <= r.begin) continue;
    let cs; try { cs = curveRangeToContours(cf, r.begin, r.end); } catch { continue; }
    if (!cs) continue;
    let m; try { m = buildLoopBlinnMesh(cs, true); } catch { continue; }
    if (!m) continue;
    n++;
    if (meshUnderCovers(m, cs)) { fired++; if (hits.length < 10) hits.push(`${path.basename(f)} s${s}`); }
  }
}
console.log(`  meshes checked: ${n}   meshUnderCovers FIRED: ${fired}`);
for (const h of hits) console.log('    ' + h);
