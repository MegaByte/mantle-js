// earcutDeviationSmoke.mjs — validate our earcut port with the area-based
// `deviation()` metric (mapbox/earcut 3.x): the relative difference between the
// input polygon area and the emitted triangle area. 0 ⇒ the triangulation exactly
// tiles the polygon. This is the cheap self-check earcut 3.x added; it catches the
// "wrong wedges" mis-threading class (overlaps/gaps) that our robust CDT path was
// built to avoid. This test (a) proves our port is area-correct across a battery of
// shapes incl. holes, and (b) proves deviation is non-vacuous by flagging a
// deliberately corrupted triangulation.
import { earcut, deviation } from '../src/renderer/lbEarcut.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const ring = (cx, cy, r, n, ph = 0) => Array.from({ length: n }, (_, i) => {
  const a = ph + i / n * Math.PI * 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});

// name → { coords, holeStarts }
const cases = {
  square: { coords: [[0, 0], [10, 0], [10, 10], [0, 10]], holeStarts: null },
  'L-shape': { coords: [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]], holeStarts: null },
  'concave-star': { coords: (() => { const p = []; for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2, r = i % 2 ? 4 : 10; p.push([20 + r * Math.cos(a), 20 + r * Math.sin(a)]); } return p; })(), holeStarts: null },
  circle64: { coords: ring(0, 0, 12, 64), holeStarts: null },
  'square-hole': { coords: [[0, 0], [30, 0], [30, 30], [0, 30], [10, 10], [10, 20], [20, 20], [20, 10]], holeStarts: [4] },
  annulus: { coords: [...ring(0, 0, 20, 24), ...ring(0, 0, 10, 24).reverse()], holeStarts: [24] },
};

let worst = 0;
for (const [name, { coords, holeStarts }] of Object.entries(cases)) {
  const tris = earcut(coords, holeStarts);
  const dev = deviation(coords, holeStarts, tris);
  worst = Math.max(worst, dev);
  dev < 1e-9
    ? ok(`${name}: ${tris.length / 3} tris, deviation ${dev.toExponential(2)} (exact tiling)`)
    : fail(`${name}: deviation ${dev.toExponential(2)} — triangulation does NOT tile the polygon`);
}
console.log(`   worst deviation across ${Object.keys(cases).length} shapes = ${worst.toExponential(2)}`);

// Non-vacuous: a corrupted triangle set (a dropped + a duplicated triangle) must
// produce a large deviation — proving the metric actually detects mis-tiling.
{
  const coords = cases.square.coords;
  const good = earcut(coords, null);            // 2 tris, exact
  const bad = good.slice(0, 3);                  // keep ONE triangle → half the area missing
  const devBad = deviation(coords, null, bad);
  devBad > 0.4 ? ok(`corrupted (half-dropped) triangulation → deviation ${devBad.toFixed(2)} (detected)`)
              : fail(`deviation failed to flag a half-dropped triangulation (${devBad})`);
}

console.log(failures ? `\nEARCUT-DEVIATION FAIL (${failures})` : `\nEARCUT-DEVIATION PASS`);
process.exit(failures ? 1 : 0);
