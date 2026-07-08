// vectorEffectSmoke.mjs — verify the SVG importer threads all 4 spec
// `vector-effect` values through to flagsShape correctly. Each value
// is a separate bit so combinations parse as the OR of bits.
//
// Bits per src/svg/importer.js + coverage shader read sites:
//   bit 0  (    1) = non-scaling-stroke
//   bit 10 ( 1024) = non-scaling-size
//   bit 11 ( 2048) = non-rotation
//   bit 12 ( 4096) = fixed-position
//   bit 13 ( 8192) = NoHScale  (Flash LineStyle2 — SWF importer only; no
//                                SVG syntax)
//   bit 14 (16384) = NoVScale  (Flash LineStyle2 — SWF importer only; no
//                                SVG syntax)

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }

const META_STRIDE = 48;
const META_FLAGS  = 27;  // f27 = flagsShape

async function importVE(value) {
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="red" stroke="black" stroke-width="2"${value ? ` vector-effect="${value}"` : ''}/>
</svg>`;
  const sections = await importSvg(svg, {});
  if (!sections || sections.numShapes < 1) {
    fail(`importer produced no shapes for vector-effect="${value || '<none>'}"`);
    return { fill: -1, stroke: -1 };
  }
  const m = new Float32Array(sections.meta, 32);
  // Stroked rect emits 2 meta rows: fill (idx 0) then stroke (idx 1).
  return {
    fill:   Math.floor(m[META_FLAGS] + 0.5),
    stroke: sections.numShapes > 1 ? Math.floor(m[META_STRIDE + META_FLAGS] + 0.5) : 0,
  };
}

// Baseline: no vector-effect → no relevant bits set on either row.
{
  const f = await importVE(null);
  const any = (f.fill | f.stroke) & 0x1C01;
  if (any === 0)
    ok(`baseline: fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)} has no vector-effect bits`);
  else
    fail(`baseline unexpectedly has effect bits: fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)}`);
}

// Each value sets its own bit on the correct row(s):
//   non-scaling-stroke (bit 0)  → STROKE row only
//   non-scaling-size   (bit 10) → BOTH rows (shape-wide)
//   non-rotation       (bit 11) → BOTH rows
//   fixed-position     (bit 12) → BOTH rows
const CASES = [
  ['non-scaling-stroke', 0x1,    'stroke-only', false, true],
  ['non-scaling-size',   0x400,  'shape-wide',  true,  true],
  ['non-rotation',       0x800,  'shape-wide',  true,  true],
  ['fixed-position',     0x1000, 'shape-wide',  true,  true],
];
for (const [value, bit, label, expectFill, expectStroke] of CASES) {
  const f = await importVE(value);
  const okFill   = expectFill   ? (f.fill   & bit) !== 0 : (f.fill   & bit) === 0;
  const okStroke = expectStroke ? (f.stroke & bit) !== 0 : (f.stroke & bit) === 0;
  if (okFill && okStroke)
    ok(`${value} → bit on ${label} row(s) (fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)})`);
  else
    fail(`${value}: fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)} (expected ${label} pattern for bit 0x${bit.toString(16)})`);
}

// Combined: space-separated list. Spec §6.6 allows any subset.
{
  const f = await importVE('non-scaling-size non-rotation');
  if ((f.fill & 0x400) !== 0 && (f.fill & 0x800) !== 0 &&
      (f.stroke & 0x400) !== 0 && (f.stroke & 0x800) !== 0)
    ok(`combined "non-scaling-size non-rotation" sets both bits on both rows (fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)})`);
  else
    fail(`combined sets fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)}`);
}
{
  const f = await importVE('non-scaling-stroke fixed-position');
  if ((f.stroke & 0x1) !== 0 && (f.stroke & 0x1000) !== 0 &&
      (f.fill & 0x1000) !== 0 && (f.fill & 0x1) === 0)
    ok(`combined "non-scaling-stroke fixed-position" — stroke gets both bits, fill gets only fixed-position (fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)})`);
  else
    fail(`combined: fill=0x${f.fill.toString(16)} stroke=0x${f.stroke.toString(16)}`);
}

// Unknown tokens within the list are ignored gracefully.
{
  const f = await importVE('non-rotation unknown-future-mode');
  if ((f.fill & 0x800) !== 0)
    ok(`unknown token ignored; non-rotation still parses (fill=0x${f.fill.toString(16)})`);
  else
    fail(`unknown token broke parsing; fill=0x${f.fill.toString(16)}`);
}

console.log();
console.log(failures === 0 ? 'VECTOR-EFFECT PASS' : `VECTOR-EFFECT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
