// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeWalkShapeSmoke — the stroke walk's shape: where work happens in the band walk and its helpers.
//
// These shape rules change WHERE work happens, never what it computes; probes/_strokeBitCmp.mjs checks that BIT FOR
// BIT on the CPU (every distance, normal, edge record and exact coverage over the seeded stroke cases, plain and
// framed, dashed and not, gates on and off). A text pin cannot prove that; what it holds is the shape, so an edit that
// quietly undoes one fails here.
//
// the quad and cubic loops fetch their control points, run the hull test, and only then the header and the
//       join texel; a line segment free at both ends does not fetch its (all-zero) join texel.
// strokeCapsJoinsDash runs its cap and join rules ONCE, for the end at hand, rather than a start copy and an end copy
//       that mirror each other (a SIMD group with pixels near both ends would run both).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const COV = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
const SM = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
const fnBody = (src, sig) => {
  const i = src.indexOf(sig);
  return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i));
};
const loop = (name, next) =>
  COV.slice(COV.indexOf(`// ---- ${name}`), COV.indexOf(`// ---- ${next}`));

// -------------------------------------------------------------------------------------------------------------------------
for (const [name, next] of [
  ['QUADS', 'CUBICS'],
  ['CUBICS', 'ARCS'],
]) {
  const body = loop(name, next);
  // (the fetches by linear texel index: cFetchL)
  const hull = body.indexOf('strokeHullOutOfReach('),
    hdr = body.indexOf('vec4 hdr = cFetchL(sL);'),
    jn = body.indexOf('vec4 jn = cFetchL(');
  ok(
    hull > 0 && hdr > hull && jn > hull,
    `${name.toLowerCase()}: the header (${hdr}) and join (${jn}) texels are fetched after the hull test (${hull})`,
  );
}
ok(
  /vec4 jn = \(freeStart && freeEnd\) \? vec4\(0\.0\) : cFetchL\(sL \+ 2\);/.test(COV),
  'lines: a segment free at both ends does not fetch its join texel',
);

// -------------------------------------------------------------------------------------------------------------------------
{
  const cjd = fnBody(SM, 'float strokeCapsJoinsDash(');
  ok(
    /if \(t < 1e-4 \|\| t > 1\.0 - 1e-4\) \{\s*bool atS = t < 1e-4;/.test(cjd) &&
      !/if \(t < 1e-4\) \{/.test(cjd) &&
      !/if \(t > 1\.0 - 1e-4\) \{/.test(cjd),
    'one copy of the cap and join rules, for the end at hand',
  );
  ok(
    (cjd.match(/joinStyle == 4/g) || []).length <= 2 &&
      (cjd.match(/if \(joinStyle == 0 && !fits\)/g) || []).length === 1,
    'each join style is written once',
  );
}

console.log(fail ? `STROKE-WALK-SHAPE FAIL (${fail})` : 'STROKE-WALK-SHAPE PASS');
process.exit(fail ? 1 : 0);
