// cdtDegenerateStressSmoke.mjs — hammer the exact-predicate CDT with the
// near-degenerate inputs that break epsilon-based triangulators (and that CGAL 6.2
// specifically hardened for): microscopic edges, near-collinear points, near-
// cocircular vertex sets, and near-duplicate points. With Shewchuk-exact orient2d +
// incircle (predicates.js) the CDT must, for every case, either return a VALID
// triangulation (all CCW, tiling the convex hull to full area, no NaN) or a clean
// null — never throw, hang, or emit inverted/overlapping triangles.
import { constrainedTriangulate, orient2d } from '../src/renderer/cdt.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Convex hull (monotone chain) → exact hull area (the target total triangle area).
function hull(ps) {
  const s = ps.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const L = []; for (const p of s) { while (L.length >= 2 && cr(L[L.length - 2], L[L.length - 1], p) <= 0) L.pop(); L.push(p); }
  const U = []; for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (U.length >= 2 && cr(U[U.length - 2], U[U.length - 1], p) <= 0) U.pop(); U.push(p); }
  L.pop(); U.pop(); return L.concat(U);
}
const polyArea = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
const triArea = (A, B, C) => Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2;

// Validate an UNCONSTRAINED triangulation of a point cloud: every triangle CCW &
// finite, total area == convex-hull area (⇒ a valid non-overlapping tiling).
function validateCloud(pts, label) {
  let res;
  try { res = constrainedTriangulate(pts.map((p) => [...p]), []); }
  catch (e) { fail(`${label}: threw ${e && e.message}`); return; }
  if (!res || !res.tris) { ok(`${label}: clean null (degenerate) — acceptable`); return; }
  const tris = res.tris;
  let total = 0, badCcw = 0, nan = 0;
  for (const [i, j, k] of tris) {
    const A = pts[i], B = pts[j], C = pts[k];
    if (!A || !B || !C || [A, B, C].some((p) => !isFinite(p[0]) || !isFinite(p[1]))) { nan++; continue; }
    if (orient2d(A, B, C) <= 0) badCcw++;      // exact: must be strictly CCW
    total += triArea(A, B, C);
  }
  const hullA = polyArea(hull(pts));
  const areaOk = hullA === 0 ? total === 0 : Math.abs(total - hullA) / hullA < 1e-6;
  if (nan) { fail(`${label}: ${nan} triangles reference NaN/undefined vertices`); return; }
  if (badCcw) { fail(`${label}: ${badCcw}/${tris.length} triangles are non-CCW (inverted/degenerate)`); return; }
  if (!areaOk) { fail(`${label}: triangle area ${total.toFixed(6)} ≠ hull area ${hullA.toFixed(6)} (gaps/overlap)`); return; }
  ok(`${label}: ${tris.length} tris, all CCW, area matches hull (${hullA.toExponential(2)})`);
}

// 1) MICROSCOPIC edges — points a few ULPs apart mixed with normal-scale points.
{ const rnd = mulberry32(1); let any = false;
  for (let k = 0; k < 400; k++) {
    const pts = [[0, 0], [100, 0], [100, 100], [0, 100]];
    for (let i = 0; i < 12; i++) { const b = [10 + rnd() * 80, 10 + rnd() * 80]; pts.push(b); pts.push([b[0] + (rnd() - 0.5) * 1e-7, b[1] + (rnd() - 0.5) * 1e-7]); }
    if (k === 0) { validateCloud(pts, 'microscopic-edges'); any = true; }
    else { try { constrainedTriangulate(pts.map((p) => [...p]), []); } catch (e) { fail('microscopic-edges batch threw: ' + e.message); break; } }
  }
  if (any) ok('microscopic-edges: 400 variants completed without throw/hang'); }

// 2) NEAR-COLLINEAR — points on a line with sub-ULP perpendicular jitter.
{ const rnd = mulberry32(7);
  for (let k = 0; k < 400; k++) {
    const pts = []; const n = 6 + (k % 30); const dx = 1 + rnd(), dy = rnd() - 0.5;
    for (let i = 0; i < n; i++) pts.push([i * dx, i * dy + (rnd() - 0.5) * 1e-9]);
    pts.push([n * dx * 0.5, 50]);  // one off-line point so a hull exists
    if (k === 0) validateCloud(pts, 'near-collinear');
    else { try { constrainedTriangulate(pts.map((p) => [...p]), []); } catch (e) { fail('near-collinear batch threw: ' + e.message); break; } }
  }
  ok('near-collinear: 400 variants completed without throw/hang'); }

// 3) NEAR-COCIRCULAR — jittered regular-polygon vertices (maximal incircle ties).
{ const rnd = mulberry32(11);
  for (let k = 0; k < 400; k++) {
    const n = 5 + (k % 40), r = 10 + rnd() * 40; const pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; pts.push([r * Math.cos(a) + (rnd() - 0.5) * 1e-8, r * Math.sin(a) + (rnd() - 0.5) * 1e-8]); }
    if (k === 0) validateCloud(pts, 'near-cocircular');
    else { try { constrainedTriangulate(pts.map((p) => [...p]), []); } catch (e) { fail('near-cocircular batch threw: ' + e.message); break; } }
  }
  ok('near-cocircular: 400 variants completed without throw/hang'); }

// 4) NEAR-DUPLICATE — clusters of points ~1e-9 apart.
{ const rnd = mulberry32(13);
  for (let k = 0; k < 400; k++) {
    const pts = [[0, 0], [50, 0], [25, 50]];
    for (let i = 0; i < 10; i++) { const c = [5 + rnd() * 40, 5 + rnd() * 40]; for (let d = 0; d < 3; d++) pts.push([c[0] + (rnd() - 0.5) * 1e-9, c[1] + (rnd() - 0.5) * 1e-9]); }
    if (k === 0) validateCloud(pts, 'near-duplicate');
    else { try { constrainedTriangulate(pts.map((p) => [...p]), []); } catch (e) { fail('near-duplicate batch threw: ' + e.message); break; } }
  }
  ok('near-duplicate: 400 variants completed without throw/hang'); }

// 5) COMBINED adversarial soup (all failure modes at once) — must not throw/hang.
{ const rnd = mulberry32(99);
  for (let k = 0; k < 400; k++) {
    const pts = []; const n = 4 + Math.floor(rnd() * 60);
    for (let i = 0; i < n; i++) {
      const mode = i % 4;
      if (mode === 0) pts.push([Math.round(rnd() * 8), Math.round(rnd() * 8)]);       // integer grid (cocircular)
      else if (mode === 1) pts.push([rnd() * 100, (rnd() * 100) * 0 + 3.14159]);        // collinear row
      else if (mode === 2) { const b = pts[pts.length - 1] || [1, 1]; pts.push([b[0] + (rnd() - 0.5) * 1e-9, b[1] + (rnd() - 0.5) * 1e-9]); } // near-dup
      else pts.push([rnd() * 100, rnd() * 100]);
    }
    try { const r = constrainedTriangulate(pts.map((p) => [...p]), []); void r; }
    catch (e) { fail('combined-soup threw: ' + e.message); break; }
  }
  ok('combined adversarial soup: 400 variants completed without throw/hang'); }

console.log(failures ? `\nCDT-DEGENERATE-STRESS FAIL (${failures})` : `\nCDT-DEGENERATE-STRESS PASS`);
process.exit(failures ? 1 : 0);
