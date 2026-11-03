// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// miterGridStress.mjs — does the band the shader picks through the META bbox list the segments a
// miter spike needs? (CPU, band-walk emulator.) An encoder that bins a miter row's bands through the
// miter-padded bbox leaves 170 and 140 unpainted on the rising sawtooth rows.
//
//   node probes/strokeCapJoin/miterGridStress.mjs
//
// Many-toothed zigzags make many bands; sharp teeth under a large limit make long spikes, the case
// where the encoder's stripes and the shader's stripes are displaced the most ((limit - 1) * halfW).
import { svgInside, polySegs } from '../../test/_strokeShapeRef.mjs';
import { makeStrokeEmu, strokeRowsOf } from '../../test/_strokeBandEmu.mjs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const JOINS = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];
let total = 0,
  bad = 0;
// rise > 0: a rising sawtooth, so the teeth (and their vertical spikes) sit at every height of the
// band grid instead of only at its top and bottom, where the band index clamps.
for (const [teeth, amp, pitch, hw, L, join, rot, rise] of [
  [40, 200, 12, 6, 10, 0, 0, 0],
  [40, 200, 12, 6, 10, 0, 90, 0],
  [60, 300, 8, 4, 20, 0, 30, 0],
  [40, 200, 12, 6, 10, 3, 0, 0],
  [40, 200, 12, 6, 10, 3, 90, 0],
  [60, 300, 8, 4, 20, 4, 30, 0],
  [80, 60, 6, 6, 10, 0, 0, 40],
  [80, 60, 6, 6, 20, 0, 0, 40],
  [120, 40, 4, 3, 40, 0, 0, 30],
  [80, 60, 6, 6, 10, 3, 0, 40],
  [120, 40, 4, 3, 40, 4, 0, 30],
]) {
  const P = [];
  const c = Math.cos((rot * Math.PI) / 180),
    s = Math.sin((rot * Math.PI) / 180);
  for (let k = 0; k <= teeth; k++) {
    const x = k * pitch,
      y = (k % 2) * amp + Math.floor(k / 2) * rise;
    P.push([x * c - y * s, x * s + y * c]);
  }
  const d = 'M ' + P.map((p) => `${p[0].toFixed(4)} ${p[1].toFixed(4)}`).join(' L ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1000 -1000 3000 3000"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="butt" stroke-linejoin="${JOINS[join]}" stroke-miterlimit="${L}"/></svg>`;
  const b = await importSvg(svg);
  const emu = makeStrokeEmu(b, strokeRowsOf(b)[0], { gates: true });
  // the miter-padded box (path + miterLimit * halfW): an encoder that bins through it is indexed
  // correctly through it (0 misses), and on the shipped encoder indexing through it is the
  // mismatch in reverse
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const p of P) {
    bx0 = Math.min(bx0, p[0]);
    by0 = Math.min(by0, p[1]);
    bx1 = Math.max(bx1, p[0]);
    by1 = Math.max(by1, p[1]);
  }
  const gp = join === 0 ? hw * L : hw;
  const emuEnc = makeStrokeEmu(b, strokeRowsOf(b)[0], {
    gates: true,
    bandBBox: [bx0 - gp, by0 - gp, bx1 + gp, by1 + gp],
  });
  let missEnc = 0;
  const Pf = P.map((p) => [Math.fround(p[0]), Math.fround(p[1])]);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of P) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const R = hw * Math.sqrt(L * L + 1) + 2;
  let n = 0,
    miss = 0;
  for (let py = Math.floor(y0 - R); py <= y1 + R; py++)
    for (let px = Math.floor(x0 - R); px <= x1 + R; px++) {
      const q = [px + 0.5, py + 0.5];
      if (!svgInside(q, Pf, false, hw, 0, join, L)) continue;
      const e = 1e-3;
      if (
        [
          [e, 0],
          [-e, 0],
          [0, e],
          [0, -e],
        ].some(([dx, dy]) => !svgInside([q[0] + dx, q[1] + dy], Pf, false, hw, 0, join, L))
      )
        continue;
      n++;
      const r = emu.eval(q);
      if (!(r.inQuad && r.minD <= hw)) miss++;
      const r2 = emuEnc.eval(q);
      if (!(r2.inQuad && r2.minD <= hw)) missEnc++;
    }
  const meta = new Float32Array(b.meta, 32);
  console.log(
    `${JOINS[join].padEnd(10)} teeth ${teeth} rot ${rot} rise ${rise} limit ${L}: bands ${meta[19] + 1}, ${miss} of ${n} inside centers unpainted (${missEnc} if indexed through path + limit * halfW)`,
  );
  total += n;
  bad += miss;
}
console.log(`total ${bad} of ${total} unpainted`);
