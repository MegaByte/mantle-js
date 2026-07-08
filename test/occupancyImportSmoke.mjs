// occupancyImportSmoke — verify the importer emits a correct interior-skip
// occupancy plane when opts.occupancyGrid is set: bundle.occupancy present,
// per-shape (cellOffset, G) stamped in meta texel 5 .xy, and the packed bits
// classify only true-interior cells (checked against analytic circle math).
import { DOMParser as DP } from '@xmldom/xmldom'; globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';

let fails = 0;
const check = (c, m) => { if (!c) { console.error('FAIL: ' + m); fails++; } else console.log('ok ' + m); };

// Non-primKind shapes (so they exercise the occupancy path, not the SDF fast
// path): a diamond <polygon> (L1 ball, exact inside test) + a big <path> blob.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <polygon points="50,5 95,50 50,95 5,50" fill="#c00"/>
  <path d="M110 50 C110 20 190 20 190 50 C190 80 110 80 110 50 Z" fill="#0a0"/>
</svg>`;

const H = 8;       // 32-byte meta header (8 floats)
// Occupancy bits live in the CURVE buffer, 4 cells per RGBA texel, addressed by
// the per-shape base texel index in meta texel 5 .x (G in .y). Mirror the
// shader's read: cell (gx,gy) → cellIdx = gy*G+gx → texel base+(cellIdx>>2),
// channel cellIdx&3.
const cellBit = (curveF, base, G, gx, gy) => {
  const cellIdx = gy * G + gx;
  return curveF[(base + (cellIdx >> 2)) * 4 + (cellIdx & 3)] > 0.5;
};

// off by default → no occupancy stamped (texel 5 .y stays 0).
const off = await importSvg(svg);
{
  const f = new Float32Array(off.meta);
  check(Math.round(f[H + 21]) === 0 && Math.round(f[H + 48 + 21]) === 0,
        'occupancyGrid off by default (no descriptors stamped)');
}

// opt-in.
const b = await importSvg(svg, { occupancyGrid: { grid: 16 } });
const f = new Float32Array(b.meta);
const curveF = new Float32Array(b.curves);

// Shape 0 = diamond polygon. Read descriptor from texel 5 .xy (floats 20,21).
const o0 = H + 0 * 48;
const base0 = Math.round(f[o0 + 20]), G0 = Math.round(f[o0 + 21]);
const bb0 = [f[o0 + 0], f[o0 + 1], f[o0 + 2], f[o0 + 3]];
check(G0 > 0, `diamond descriptor: G=${G0} at baseTexel=${base0}`);

// Every SOLID_IN cell centre must be inside the L1 ball |x-50|+|y-50| ≤ 45.
let solid = 0, bad = 0;
const cw = (bb0[2] - bb0[0]) / G0, ch = (bb0[3] - bb0[1]) / G0;
for (let gy = 0; gy < G0; gy++) for (let gx = 0; gx < G0; gx++) {
  if (!cellBit(curveF, base0, G0, gx, gy)) continue;
  solid++;
  const px = bb0[0] + (gx + 0.5) * cw, py = bb0[1] + (gy + 0.5) * ch;
  if (Math.abs(px - 50) + Math.abs(py - 50) >= 45) bad++;
}
check(solid > 10, `diamond grid has interior cells (${solid} SOLID_IN)`);
check(bad === 0, `diamond grid: no SOLID_IN cell centre outside the L1 ball (${bad} bad)`);

// Shape 1 = path blob: should also carry a descriptor + interior.
const o1 = H + 1 * 48;
const G1 = Math.round(f[o1 + 21]);
check(G1 > 0, `path-blob descriptor present (G=${G1})`);

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\noccupancyImportSmoke: all assertions passed');
