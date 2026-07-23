// cdtSelfIntersectFillSmoke.mjs — G4 wiring: self-CROSSING straight outlines
// (bowtie, pentagram) render via the LB CDT partition (crossing constraints split
// at their intersection) instead of the Slug fallback, and fill the CORRECT region.
// Verifies shape (not just area) by comparing mesh coverage to the analytic
// even-odd / nonzero fill of the contour at a sample grid.
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { mkLine } from '../src/primitives/seg.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

// point inside any interior triangle of the mesh?
function inMesh(m, px, py) {
  const I = m.interior;
  for (let i = 0; i < I.length; i += 6) {
    const ax = I[i], ay = I[i + 1], bx = I[i + 2], by = I[i + 3], cx = I[i + 4], cy = I[i + 5];
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
}
// analytic winding of a polyline contour at (px,py)
function winding(poly, px, py) {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (a[1] <= py) { if (b[1] > py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) > 0) w++; }
    else { if (b[1] <= py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) < 0) w--; }
  }
  return w;
}
const insideBy = (poly, px, py, rule) => rule === 'evenodd' ? (winding(poly, px, py) & 1) === 1 : winding(poly, px, py) !== 0;

function checkShape(name, contour, polyline, rule, bbox) {
  const m = buildLoopBlinnCDT([contour], { fillRule: rule });
  if (!m || !m.interior || !m.interior.length || m.fallback.length) { fail(`${name} (${rule}): no LB mesh (would fall to Slug)`); return; }
  const [x0, y0, x1, y1] = bbox;
  let mismatch = 0, tested = 0;
  const N = 40;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const px = x0 + (i + 0.5) / N * (x1 - x0), py = y0 + (j + 0.5) / N * (y1 - y0);
    const truth = insideBy(polyline, px, py, rule);
    const got = inMesh(m, px, py);
    tested++;
    if (truth !== got) mismatch++;
  }
  const rate = mismatch / tested;
  // allow a thin boundary band of disagreement (sample points landing on edges);
  // a WRONG-SHAPE fill (the pre-fix bug) mismatches ~25-50% of interior samples.
  rate < 0.05 ? ok(`${name} (${rule}): LB mesh matches ${rule} fill (${(rate * 100).toFixed(1)}% boundary mismatch, ${m.interior.length / 6} tris)`)
             : fail(`${name} (${rule}): mesh fill WRONG — ${(rate * 100).toFixed(1)}% of samples disagree with ${rule} ground truth`);
}

// BOWTIE (hourglass): edges (0,0)-(4,4) and (4,0)-(0,4) cross at (2,2).
const bowPl = [[0, 0], [4, 4], [4, 0], [0, 4]];
checkShape('bowtie', [mkLine([0, 0], [4, 4]), mkLine([4, 4], [4, 0]), mkLine([4, 0], [0, 4]), mkLine([0, 4], [0, 0])], bowPl, 'evenodd', [0, 0, 4, 4]);
checkShape('bowtie', [mkLine([0, 0], [4, 4]), mkLine([4, 4], [4, 0]), mkLine([4, 0], [0, 4]), mkLine([0, 4], [0, 0])], bowPl, 'nonzero', [0, 0, 4, 4]);

// PENTAGRAM: 5-point star as one self-intersecting contour.
const sp = []; for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 4 * Math.PI / 5; sp.push([50 + 40 * Math.cos(a), 50 + 40 * Math.sin(a)]); }
const pentaC = [mkLine(sp[0], sp[1]), mkLine(sp[1], sp[2]), mkLine(sp[2], sp[3]), mkLine(sp[3], sp[4]), mkLine(sp[4], sp[0])];
checkShape('pentagram', pentaC, sp, 'evenodd', [10, 10, 90, 90]);
checkShape('pentagram', pentaC, sp, 'nonzero', [10, 10, 90, 90]);

console.log(failures ? `\nCDT-SELFINTERSECT-FILL FAIL (${failures})` : `\nCDT-SELFINTERSECT-FILL PASS`);
process.exit(failures ? 1 : 0);
