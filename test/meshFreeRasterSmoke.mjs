// meshFreeRasterSmoke.mjs — the production CPU rasterizer (meshFreeRaster.js), the
// exact CPU twin of the GPU fragment shader. Validates all curve types (line, quad,
// rational-quad = exact conic, cubic) against supersampled ground truth on a holed "O",
// and that coverageAt (per-pixel) reproduces rasterCoverage (whole grid).
import { rasterCoverage, coverageAt, prepareSegments } from '../src/renderer/meshFreeRaster.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const evAt = (s, t) => { const u = 1 - t; if (s.type === 'cubic') return [u * u * u * s.P0[0] + 3 * u * u * t * s.P1[0] + 3 * u * t * t * s.P2[0] + t * t * t * s.P3[0], u * u * u * s.P0[1] + 3 * u * u * t * s.P1[1] + 3 * u * t * t * s.P2[1] + t * t * t * s.P3[1]]; if (s.type === 'rquad') { const w = s.w, b0 = u * u, b1 = 2 * u * t * w, b2 = t * t, d = b0 + b1 + b2; return [(b0 * s.P0[0] + b1 * s.P1[0] + b2 * s.P2[0]) / d, (b0 * s.P0[1] + b1 * s.P1[1] + b2 * s.P2[1]) / d]; } if (s.type === 'quad') return [u * u * s.P0[0] + 2 * u * t * s.P1[0] + t * t * s.P2[0], u * u * s.P0[1] + 2 * u * t * s.P1[1] + t * t * s.P2[1]]; return [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1])]; };
function groundTruth(segs, W, H, N, eo) {
  const pl = segs.map((s) => { const a = []; for (let k = 0; k <= 64; k++) a.push(evAt(s, k / 64)); return a; });
  const inside = (px, py) => { let w = 0; for (const p of pl) for (let i = 0; i + 1 < p.length; i++) { const A = p[i], B = p[i + 1]; if (A[1] <= py) { if (B[1] > py && (B[0] - A[0]) * (py - A[1]) - (px - A[0]) * (B[1] - A[1]) > 0) w++; } else { if (B[1] <= py && (B[0] - A[0]) * (py - A[1]) - (px - A[0]) * (B[1] - A[1]) < 0) w--; } } return eo ? (w & 1) === 1 : w !== 0; };
  const g = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let c = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (inside(x + (i + 0.5) / N, y + (j + 0.5) / N)) c++; g[y * W + x] = c / (N * N); } return g;
}
const cmp = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

const W = 48, H = 48, cx = 24, cy = 24, K = 0.5522847498, Wt = 0.70710678;
const on = (r, ccw) => ccw ? [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]] : [[cx + r, cy], [cx, cy - r], [cx - r, cy], [cx, cy + r]];
const rings = {
  line: (r, ccw) => on(r, ccw).map((a, i) => ({ type: 'line', a, b: on(r, ccw)[(i + 1) % 4] })),
  quad: (r, ccw) => { const O = on(r, ccw), ct = ccw ? [[cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r], [cx + r, cy - r]] : [[cx + r, cy - r], [cx - r, cy - r], [cx - r, cy + r], [cx + r, cy + r]]; return O.map((a, i) => ({ type: 'quad', P0: a, P1: ct[i], P2: O[(i + 1) % 4] })); },
  rquad: (r, ccw) => rings.quad(r, ccw).map((s) => ({ type: 'rquad', w: Wt, P0: s.P0, P1: s.P1, P2: s.P2 })),
  cubic: (r, ccw) => { const O = on(r, ccw), tan = ccw ? [[0, r], [-r, 0], [0, -r], [r, 0]] : [[0, -r], [-r, 0], [0, r], [r, 0]]; return O.map((a, i) => { const b = O[(i + 1) % 4]; return { type: 'cubic', P0: a, P1: [a[0] + tan[i][0] * K, a[1] + tan[i][1] * K], P2: [b[0] - tan[(i + 1) % 4][0] * K, b[1] - tan[(i + 1) % 4][1] * K], P3: b }; }); },
};

for (const [name, mk] of Object.entries(rings)) {
  const segs = [...mk(18, true), ...mk(10, false)];
  const cov = rasterCoverage(segs, W, H, false);
  const gt = groundTruth(segs, W, H, 16, false);
  const d = cmp(cov, gt);
  const hole = cov[24 * W + 24], ring = cov[24 * W + (24 + 14)];
  d < 0.06 && hole < 0.02 && ring > 0.98
    ? ok(`${name}: mesh-free raster matches ground truth (max ${d.toFixed(3)}), hole=${hole.toFixed(3)} ring=${ring.toFixed(3)}`)
    : fail(`${name}: max ${d.toFixed(3)} hole ${hole.toFixed(3)} ring ${ring.toFixed(3)}`);
}

// coverageAt (per-pixel, the fragment logic) ≡ rasterCoverage (grid)
{
  const segs = [...rings.cubic(18, true), ...rings.cubic(10, false)];
  const mono = prepareSegments(segs);
  const grid = rasterCoverage(segs, W, H, false);
  let d = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d = Math.max(d, Math.abs(coverageAt(mono, x, y, false) - grid[y * W + x]));
  d < 1e-6 ? ok(`coverageAt (fragment) ≡ rasterCoverage (grid), diff ${d.toExponential(1)} (float summation order)`) : fail(`fragment ≢ grid: ${d}`);
}

console.log(failures ? `\nMESH-FREE-RASTER FAIL (${failures})` : `\nMESH-FREE-RASTER PASS`);
process.exit(failures ? 1 : 0);
