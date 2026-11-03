// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cffFixedOperandSmoke — a Type 2 charstring operand encoded with byte 255 is a 16.16 FIXED number.
//
// The Type 2 charstring format (Adobe TN #5177, "Charstring Number Encoding") gives byte 255 four more bytes: a
// two's-complement 32-bit integer scaled by 1/65536. The interpreter pushed only the signed high 16 bits, so every
// fractional operand lost its fraction -- a point at (1.5, 2.25) landed on (1, 2). Hinted and converted CFF fonts use
// the fixed form for exactly the coordinates that are not integers.
//
// No GPU: runs a standalone charstring through CharStringInterp and looks for the exact points among the emitted
// segments (the interpreter reverses contour order, so the check is membership, not position).
import { CharStringInterp } from '../../src/font/formats/charStringInterp.js';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL', msg);
};
const ok = (msg) => console.log(`  ok   ${msg}`);

// Operands: small ints as one byte (v + 139), everything else as the 16.16 form (255 + int32).
function enc(...items) {
  const out = [];
  for (const it of items) {
    if (typeof it === 'object' && it.op !== undefined) {
      out.push(it.op);
      continue;
    }
    if (Number.isInteger(it) && it >= -107 && it <= 107) {
      out.push(it + 139);
      continue;
    }
    const v = Math.round(it * 65536) | 0;
    out.push(255, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  return new Uint8Array(out);
}
const RMOVETO = { op: 21 },
  RLINETO = { op: 5 },
  ENDCHAR = { op: 14 };

function points(bytes) {
  const segs = new CharStringInterp(bytes, 0, -1, 0, 0).run(0, bytes.length) || [];
  const pts = [];
  for (const s of segs) for (const k of ['p1', 'p2', 'p3', 'p4']) if (s[k]) pts.push(s[k]);
  return pts;
}
const has = (pts, x, y) =>
  pts.some((p) => Math.abs(p[0] - x) <= 1e-9 && Math.abs(p[1] - y) <= 1e-9);

{
  // rmoveto (1.5, 2.25); rlineto (10, 0); rlineto (0, 10); endchar
  const pts = points(enc(1.5, 2.25, RMOVETO, 10, 0, RLINETO, 0, 10, RLINETO, ENDCHAR));
  if (!has(pts, 1.5, 2.25))
    fail(`16.16 rmoveto: no point at (1.5, 2.25); got ${JSON.stringify(pts)}`);
  else ok('16.16 operands keep their fraction: the contour starts at (1.5, 2.25)');
  if (!has(pts, 11.5, 12.25))
    fail(
      `16.16 start carried through relative moves: no point at (11.5, 12.25); got ${JSON.stringify(pts)}`,
    );
  else ok('relative operators build on the fractional start: (11.5, 12.25)');
}
{
  // A negative fixed operand: rmoveto (-0.5, 3); rlineto (4, 0.75); endchar
  const pts = points(enc(-0.5, 3, RMOVETO, 4, 0.75, RLINETO, 0, 5, RLINETO, ENDCHAR));
  if (!has(pts, -0.5, 3) || !has(pts, 3.5, 3.75))
    fail(`negative 16.16 operand: want (-0.5, 3) and (3.5, 3.75); got ${JSON.stringify(pts)}`);
  else ok("negative 16.16 operands decode as two's complement: (-0.5, 3) -> (3.5, 3.75)");
}

console.log(failures ? `\nCFF-FIXED-OPERAND FAIL (${failures})` : '\nCFF-FIXED-OPERAND PASS');
process.exit(failures ? 1 : 0);
