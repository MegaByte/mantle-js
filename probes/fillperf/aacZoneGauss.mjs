// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacZoneGauss — write a PROBE copy of an assembled fill shader whose AAC zone integral is taken on the zone itself
// (3-point Gauss-Legendre on [a, b], exact for the degree-5 integrand x(t) y'(t)) in place of the difference of the
// power-basis antiderivative at the zone's ends. Not a proposal: a control. The antiderivative's terms grow as the
// square of the segment's span in pixels and cancel to the zone's O(1) value in float32, so its rounding (up to
// ~2e-3 at scale 1 on the corpus, and growing as P^2 under a zoom: probes/fillperf/aacZoom.mjs) swamps anything the
// clip root moves. With this integral in both texts, kernelIdentity --exact isolates what a root change did.
// For texts that do not integrate each zone this way already (the package text does).
//   node probes/fillperf/aacZoneGauss.mjs in.frag.glsl out.frag.glsl
//   node probes/fillperf/kernelIdentity.mjs --base oldG.glsl --cand newG.glsl --kernels aac,aacStripe --exact
import { readFileSync, writeFileSync } from 'fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.log('usage: node probes/fillperf/aacZoneGauss.mjs in.frag.glsl out.frag.glsl');
  process.exit(1);
}
let g = readFileSync(src, 'utf8');
const fn = `float aacGaussZone(vec4 CX, vec4 CY, float a, float b) {
  float h = b - a, m = 0.5 * (a + b), d = 0.3872983346207417 * h;
  float t0 = m - d, t2 = m + d;
  float i0 = evalC(CX, t0) * ((3.0 * CY.x * t0 + 2.0 * CY.y) * t0 + CY.z);
  float i1 = evalC(CX, m) * ((3.0 * CY.x * m + 2.0 * CY.y) * m + CY.z);
  float i2 = evalC(CX, t2) * ((3.0 * CY.x * t2 + 2.0 * CY.y) * t2 + CY.z);
  return h * ((5.0 / 18.0) * (i0 + i2) + (8.0 / 18.0) * i1);
}
`;
const anchor =
  'float aacZoneI2(vec4 CX, vec4 CY, vec3 F0, vec3 F1, float a, float b, float ya, float yb, float q0, float q1) {';
const ret = 'return aacAnti(F0, F1, b) - aacAnti(F0, F1, a);';
if (g.split(anchor).length !== 2) throw new Error('aacZoneGauss: aacZoneI2 moved');
if (g.split(ret).length !== 3)
  throw new Error(`aacZoneGauss: expected the two zone returns, found ${g.split(ret).length - 1}`);
g = g
  .replace(anchor, fn + anchor)
  .split(ret)
  .join('return aacGaussZone(CX, CY, a, b);');
writeFileSync(dst, g);
console.log(`wrote ${dst}: the zone integral by 3-point Gauss on the zone (2 sites)`);
