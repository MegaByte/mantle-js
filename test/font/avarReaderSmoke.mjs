// avarReaderSmoke.mjs — avar axis value remap.

import { AvarTable } from '../../src/font/variations/avarReader.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// Build a synthesized avar table for 1 axis with a non-linear map:
//   (-1, -1), (0, 0), (0.5, 0.8), (1, 1)
//   → values between 0 and 1 remap so 0.5 user → 0.8 normalized.
function buildAvar(segments) {
  // Header: major(2) minor(2) reserved(2) axisCount(2)
  // Per axis: positionMapCount(2) + entries (4 bytes each).
  let totalLen = 8;
  for (const seg of segments) totalLen += 2 + seg.length * 4;
  const buf = new ArrayBuffer(totalLen);
  const dv = new DataView(buf);
  const b = new Uint8Array(buf);
  dv.setUint16(0, 1, false);          // major
  dv.setUint16(2, 0, false);          // minor
  dv.setUint16(4, 0, false);          // reserved
  dv.setUint16(6, segments.length, false);
  let p = 8;
  for (const seg of segments) {
    dv.setUint16(p, seg.length, false); p += 2;
    for (const [from, to] of seg) {
      dv.setInt16(p, Math.round(from * 16384), false); p += 2;
      dv.setInt16(p, Math.round(to   * 16384), false); p += 2;
    }
  }
  return { bytes: b, view: dv, avar: [0, totalLen] };
}

// ----- T1: identity map → input passes through ------------------------
{
  const tables = buildAvar([[[-1, -1], [0, 0], [1, 1]]]);
  const a = new AvarTable(tables);
  if (!a.hasAvar) fail('T1 hasAvar false');
  else {
    const r = a.remapAxis(0, 0.5);
    if (Math.abs(r - 0.5) > 1e-3) fail(`T1 identity remap returned ${r}, expected 0.5`);
    else ok(`T1 identity map: 0.5 → ${r.toFixed(3)}`);
  }
}

// ----- T2: non-linear map applies tent function ----------------------
{
  // Map (-1,-1), (0,0), (0.5,0.8), (1,1). At input 0.5, output 0.8.
  // At 0.25 (halfway between 0 and 0.5), linear interp = 0.4.
  const tables = buildAvar([[[-1, -1], [0, 0], [0.5, 0.8], [1, 1]]]);
  const a = new AvarTable(tables);
  const r1 = a.remapAxis(0, 0.5);
  const r2 = a.remapAxis(0, 0.25);
  if (Math.abs(r1 - 0.8) > 0.001) fail(`T2 0.5 → ${r1}, expected 0.8`);
  else if (Math.abs(r2 - 0.4) > 0.001) fail(`T2 0.25 → ${r2}, expected 0.4`);
  else ok(`T2 non-linear: 0.5 → ${r1.toFixed(3)}, 0.25 → ${r2.toFixed(3)}`);
}

// ----- T3: out-of-range clamps to segment endpoints ------------------
{
  const tables = buildAvar([[[-1, -1], [0, 0], [1, 1]]]);
  const a = new AvarTable(tables);
  const rLo = a.remapAxis(0, -5);
  const rHi = a.remapAxis(0,  5);
  if (rLo !== -1 || rHi !== 1)
    fail(`T3 out-of-range: ${rLo} / ${rHi}, expected -1 / 1`);
  else ok(`T3 out-of-range clamps to segment endpoints`);
}

// ----- T4: missing table returns hasAvar=false -----------------------
{
  const a = new AvarTable({ bytes: new Uint8Array(0), view: null });
  if (a.hasAvar) fail('T4 hasAvar true on empty');
  else if (a.remapAxis(0, 0.5) !== 0.5) fail('T4 remap should passthrough on empty');
  else ok('T4 no avar: hasAvar=false, remap passes through');
}

console.log();
console.log(failures === 0 ? 'AVAR-READER PASS' : `AVAR-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
