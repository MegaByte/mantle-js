// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacHalfTurnArcSmoke — whole ellipses and circles inside a pixel are their true area.
// The emulator's side of what aacColdKernelGpuSmoke checks on a physical GPU with the lean arc kernel: a 0.31 x 0.16 ellipse inside its
// pixel must draw its area (0.153), not 0.12.
//
// The lean arc kernel (one pass over doubly monotone pieces) finds the zone's turn from the unit vectors at its ends with an atan. A
// piece can be a full HALF turn -- every SVG circle and ellipse is two of them -- and then cross = 0: atan answers +pi or -pi by
// rounding, the segment term (dth - sin dth) flips sign, and the coverage is wrong unless the kernel resolves the half turn: on a
// physical GPU a 0.31 x 0.16 ellipse, wholly inside its pixel, would draw 0.12 against 0.153 (3.9 bytes at 0.51 opacity).
//
// Ellipses and circles whose area is the exact answer (wholly inside one pixel, area pi * rx * ry), at many sizes and positions, tilted
// and not, at 2^-20, 1 and 2^20; and the same shapes straddling the pixel's edge against the f64 exact box coverage.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_AAC } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP aacHalfTurnArcSmoke: no C++ compiler');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { boxCoverage } = await import('../src/hitTest/fillCoverage.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const DEFS = ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'];
const GEN = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const DEFS_ONLY = 0;
let emu = buildGlslEmu(ROOT, { defines: DEFS });

const ell = (cx, cy, rx, ry, rot) =>
  `M${cx + rx},${cy} A${rx},${ry} ${rot} 0 1 ${cx - rx},${cy} A${rx},${ry} ${rot} 0 1 ${cx + rx},${cy}Z`;
// A hand-scaled path (the flags and the rotation are not coordinates)
function scaledPath(cx, cy, rx, ry, rot, S) {
  return ell(cx * S, cy * S, rx * S, ry * S, rot);
}
async function coverageAt(cx, cy, rx, ry, rot, S, px, py) {
  const d = scaledPath(cx, cy, rx, ry, rot, S);
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${64 * S} ${64 * S}"><path d="${d}" fill="#000"/></svg>`,
    { preserveViewport: true },
  );
  const sh = fillShapes(b, parseMetaBin, M)[0],
    curve = new Float32Array(b.curves),
    band = new Float32Array(b.bands);
  const segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  const c = [(px + 0.5) * S, (py + 0.5) * S],
    ePx = [S, S];
  const got = emu.run(band, curve, [{ k: K_AAC, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx }])[0];
  return { got, exact: boxCoverage(segs, c[0], c[1], S, S, sh.eo) };
}
async function sweep() {
  let worst = 0,
    n = 0,
    where = '';
  for (const S of [2 ** -20, 1, 2 ** 20]) {
    for (const [rx, ry, rot] of [
      [0.25, 0.125, 0],
      [0.3125, 0.15625, 0],
      [0.4, 0.4, 0],
      [0.45, 0.2, 30],
      [0.1, 0.35, 75],
      [0.2, 0.2, 0],
      [0.05, 0.02, 10],
    ]) {
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.4, 0.55],
        [0.5, 0.45],
      ]) {
        const cx = 32 + fx,
          cy = 32 + fy;
        const { got, exact } = await coverageAt(cx, cy, rx, ry, rot, S, 32, 32);
        const d = Math.abs(got - exact);
        n++;
        if (d > worst) {
          worst = d;
          where = `2^${Math.log2(S)} r(${rx},${ry}) rot ${rot} at (${fx},${fy}): ${got} vs exact ${exact}`;
        }
      }
    }
  }
  return { worst, n, where };
}
const good = await sweep();
ok(
  good.worst < 1e-4,
  `${good.n} ellipses and circles inside or across one pixel, half-turn arcs, at 2^-20, 1 and 2^20: worst ${good.worst.toExponential(2)} off the exact box coverage${good.worst >= 1e-4 ? ' -- ' + good.where : ''}`,
);
if (fail) {
  console.error(`aacHalfTurnArcSmoke FAIL (${fail})`);
  process.exit(1);
}
console.log('aacHalfTurnArcSmoke PASS');
