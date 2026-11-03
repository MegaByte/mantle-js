// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBandInsideSmoke — a curve band cedes a pixel to the interior when its CENTER IS INSIDE THE FILL, decided
// by an inside test, not by a coverage threshold.
//
// Pieces precede the interior in the stream (lbPack's depth-carve order), so under the depth claim (translucent fills,
// morphs) the first surviving fragment of a shape owns its pixel. A coverage-threshold gate (discard a band fragment with
// c12 < 0.12 whose center is on an end neighbor's fill side) is wrong both ways: at a CONVEX end that center is outside
// the fill and the gate throws away real exterior coverage, while at a REFLEX end it lets a band fragment of 0.12 or
// more keep a center that IS inside, and take the pixel from the interior with its own partial coverage. Through the
// whole-LB-pipeline emulator (test/_lbPipeEmu.mjs), on seeded random stars whose edges are
// lines or quads (reflex and convex line-curve corners at every angle), at 256 px:
//   (a) a reflex end's center-inside pixel (shape 25 at (176,238), exact 225.2/255): the band discards there, and the
//       CLAIM composite reads the interior's coverage (not the band's own 96.5);
//   (b) a convex end's pixel a threshold gate zeroes (shape 7 at (15,63), exact 25.8/255): the band paints it, to 2/255;
//   (c) over the whole drawing, every band fragment discarded as inside has its center inside the fill -- except at
//       shape 11's tip, where the quad leaves the corner on the EXTERIOR side of its own incoming line and crosses back
//       over it: a self-intersecting outline, which no two-boundary corner model describes (one fragment).
// SKIPs (exit 77) without a C++ compiler and clang.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';
import { lbScene, renderScene } from './_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbBandInsideSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();
const warn = console.warn;
console.warn = () => {};
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
let FT = readFileSync(
  process.env.BAND_INSIDE_FRAG || path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
// Mark the inside test's discards (bit 0) so (c) can find them; a shader text without the inside test has no such line and marks nothing.
const HINGE = 'dot(rA, uA12) >= 0.0) discard;';
const marked = FT.split(HINGE).length === 2;
if (marked)
  FT = FT.replace(HINGE, 'dot(rA, uA12) >= 0.0 && LBPIPE_FLAG(0)) discard;').replace(
    'dot(rB, uB12) >= 0.0) discard;',
    'dot(rB, uB12) >= 0.0 && LBPIPE_FLAG(0)) discard;',
  );

// 25 seeded stars (probes/_lbPipeOut's reflexStars): 5-10 points, each edge a line or a quad with a random bulge.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let body =
  '<rect x="0" y="0" width="0.02" height="0.02"/><rect x="99.98" y="99.98" width="0.02" height="0.02"/>';
for (let gy = 0; gy < 5; gy++)
  for (let gx = 0; gx < 5; gx++) {
    const cx = 10 + gx * 20,
      cy = 10 + gy * 20,
      n = 5 + Math.floor(rnd() * 6),
      pts = [];
    for (let k = 0; k < 2 * n; k++) {
      const a = (k / (2 * n)) * 2 * Math.PI + rnd() * 0.2,
        r = k % 2 ? 3 + rnd() * 3 : 7 + rnd() * 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    let d = `M${pts[0][0].toFixed(3)} ${pts[0][1].toFixed(3)}`;
    for (let k = 1; k <= pts.length; k++) {
      const p = pts[k % pts.length],
        q = pts[k - 1];
      if (rnd() < 0.5) d += ` L${p[0].toFixed(3)} ${p[1].toFixed(3)}`;
      else {
        const mx = (p[0] + q[0]) / 2,
          my = (p[1] + q[1]) / 2,
          ex = p[0] - q[0],
          ey = p[1] - q[1],
          o = (rnd() - 0.5) * 0.9;
        d += ` Q${(mx - ey * o).toFixed(3)} ${(my + ex * o).toFixed(3)} ${p[0].toFixed(3)} ${p[1].toFixed(3)}`;
      }
    }
    body += `<path d="${d} Z" fill="#000"/>`;
  }
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const N = 256;
const sc = await lbScene(svg, { N });
const r = renderScene(sc, VT, FT);
const R = r.recs,
  ko = r.vert.outOff[r.vert.io.outs.findIndex((o) => o.name === 'vKind')];
const kindOf = (t) => Math.floor(r.vOut[(t * 3 + 2) * r.vert.outN + ko] + 1e-4);
const at = (s, x, y) => {
  // the shape's fragments at a pixel, in primitive order
  const out = [];
  for (let q = 0; q < R.length / 9; q++)
    if (
      (R[q * 9 + 1] | 0) === x &&
      (R[q * 9 + 2] | 0) === y &&
      sc.entries[sc.entryOfTri[R[q * 9] | 0]].shapeIdx === s
    )
      out.push({
        kind: kindOf(R[q * 9] | 0),
        disc: R[q * 9 + 7] === 1,
        a: Math.min(1, Math.max(0, R[q * 9 + 6])),
        flags: R[q * 9 + 8] | 0,
      });
  return out;
};
const claim = (fs) => {
  const f = fs.find((x) => !x.disc);
  return f ? f.a : 0;
};
const over = (fs) => 1 - fs.reduce((o, f) => o * (f.disc ? 1 : 1 - f.a), 1);
{
  const fs = at(25, 176, 238),
    band = fs.filter((f) => f.kind === 12);
  ok(
    band.length > 0 && band.every((f) => f.disc) && claim(fs) * 255 > 200,
    `(a) reflex end, center inside: the band cedes (${band.length} band fragment(s), ${band.filter((f) => f.disc).length} discarded) and the claim reads ${(claim(fs) * 255).toFixed(1)}/255 against an exact 225.2`,
  );
}
{
  const fs = at(7, 15, 63);
  ok(
    Math.abs(over(fs) * 255 - 25.8) <= 2,
    `(b) convex end a threshold gate zeroes: ${(over(fs) * 255).toFixed(1)}/255 against an exact 25.8`,
  );
}
{
  const { refKit } = await import('../probes/lbAccuracy/_lbAaRef.mjs');
  const { rowSpans, contoursToConverter, closed } = await refKit();
  const { shapesOf, viewOf } = await import('../probes/lbAccuracy/_lbRaster.mjs');
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { shapes, bbox } = await shapesOf(await importSvg(svg), { rows: 'fill' });
  const view = viewOf(bbox, N);
  let n = 0,
    bad = 0,
    tip = 0;
  for (let q = 0; q < R.length / 9; q++) {
    if (!((R[q * 9 + 8] | 0) & 1)) continue;
    n++;
    const s = sc.entries[sc.entryOfTri[R[q * 9] | 0]].shapeIdx,
      sh = shapes.find((x) => x.s === s);
    const emY = view.oy + ((R[q * 9 + 2] | 0) + 0.5) * view.basePx,
      emX = view.ox + ((R[q * 9 + 1] | 0) + 0.5) * view.basePx;
    const inside = rowSpans(closed(contoursToConverter(sh.contours, null)), emY, sh.evenOdd).some(
      (p) => p[0] <= emX && emX <= p[1],
    );
    if (!inside) {
      if (s === 11) tip++;
      else bad++;
    }
  }
  ok(
    marked && n > 0 && bad === 0 && tip <= 1,
    `(c) the inside test discards ${n} band fragment(s): center inside the fill but ${bad} (+ ${tip} at shape 11's self-crossing tip)`,
  );
}
console.warn = warn;
console.log(
  fail
    ? `lbBandInsideSmoke FAIL (${fail})`
    : `lbBandInsideSmoke: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
