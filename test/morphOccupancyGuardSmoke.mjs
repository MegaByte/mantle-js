// morphOccupancyGuardSmoke — a shape-morph bundle MUST disable interior-skip
// occupancy: the grid bits are packed in the curve buffer, which setT() lerps +
// re-uploads per frame (cells can't be interpolated between poses → garbage).
// composeMorphSections forces hasOccupancy=false; this locks that invariant.
import { DOMParser as DP } from '@xmldom/xmldom'; globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { buildMorphPlan, composeMorphSections } from '../src/core/morphCore.js';

// gl-free bundle adapter: expose the fields composeMorphSections reads
// (extractCurveFloats also accepts the raw .curves).
function asBundle(b) {
  return {
    ...b,
    metaFloats: new Float32Array(b.meta, 32),   // strip the 32-byte header
    curveFloats: new Float32Array(b.curves),
    shapeIds: b.shapeIds || [],
  };
}

const mk = (cx) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <path id="blob" d="M${cx} 50 C${cx} 18 ${cx+90} 18 ${cx+90} 50 C${cx+90} 82 ${cx} 82 ${cx} 50 Z" fill="#0a0"/></svg>`;

let fails = 0;
const src = asBundle(await importSvg(mk(8),  { occupancyGrid: { grid: 16 } }));
const dst = asBundle(await importSvg(mk(40), { occupancyGrid: { grid: 16 } }));

if (!src.hasOccupancy)
  console.error('WARN: src.hasOccupancy false — gate did not trigger; the check below is vacuous');
else
  console.log('ok src imported WITH occupancy (hasOccupancy=true) — non-vacuous');

const plan = buildMorphPlan(src, dst);
const morph = composeMorphSections(src, dst, plan);
if (morph.hasOccupancy !== false) { console.error('FAIL: morph hasOccupancy must be false, got', morph.hasOccupancy); fails++; }
else console.log('ok morph bundle forces hasOccupancy=false (grid cannot survive the per-T curve lerp)');

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nmorphOccupancyGuardSmoke: passed');
