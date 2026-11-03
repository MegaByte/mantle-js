// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcFootAngleSignedZeroSmoke -- the shader text of the signed-zero guard in arcFootAngle.
// The foot of an arc's closest point can be exactly on an ellipse axis with a NEGATIVE sign (foot = sgn * fo, fo.x = 0 gives -0.0), and the
// GPU's atan(y, -0.0) does not return -pi/2 for a negative y. arcFootAngle therefore reads a foot on the y axis as exactly +-pi/2 by the sign
// of its y, with no atan and no epsilon. This pins that line in the source and in every assembled program that carries the arc loop; the render
// behavior is pinned by strokeFootSignedZeroGpuSmoke.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? 'ok' : 'FAIL'}: ${m}`);
  if (!c) fail++;
};
const GUARD =
  /float t = fx == 0\.0 \? \(fy == 0\.0 \? 0\.0 : \(fy < 0\.0 \? -0\.25 \* TWO_PI : 0\.25 \* TWO_PI\)\) : atan\(fy, fx\);/;
const src = fs.readFileSync(path.join(ROOT, 'src/shaders/_arcMath.glsl'), 'utf8');
ok(
  GUARD.test(src),
  '_arcMath.glsl: arcFootAngle reads an exactly-zero x as +-pi/2 by the sign of y',
);
ok(
  !/float t = atan\(foot\.y \* radii\.x, foot\.x \* radii\.y\);/.test(src),
  '_arcMath.glsl: the unguarded atan(foot.y * rx, foot.x * ry) is gone',
);
for (const f of [
  'mantle.frag.glsl',
  'aacPoints.vert.glsl',
  'splitStroke.frag.glsl',
  'maskBake.frag.glsl',
]) {
  const g = fs.readFileSync(path.join(ROOT, 'src/shaders/generated', f), 'utf8');
  const has = /arcFootAngle\(/.test(g);
  if (has) ok(GUARD.test(g), f + ': the assembled program carries the guard');
}
if (fail) {
  console.error(`arcFootAngleSignedZeroSmoke: ${fail} failure(s)`);
  process.exit(1);
}
console.log('arcFootAngleSignedZeroSmoke: arcFootAngle is signed-zero safe');
