// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitNonScalingDashSmoke -- a non-scaling stroke's dashes keep their screen length under whatever maps the row to the screen.
//
// The renderer measures them in strokeDashScale, 0.5 * (ePx.x + ePx.y) of the row's own frame (mantle.frag.glsl), and the hit test takes the width AND the dashes from the same
// differentials. Dashes taken from the world matrix alone would let an override's scale, and a turned world matrix, move the dash gate away from the drawn dashes: under an override
// of 2 the band would answer 20 on / 20 off along a line drawn 10 on / 10 off. Every query is a point in canvas units on the stroke's center line, against the pattern worked out by hand.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { importSvg, fillHits } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M0 100H200" fill="none" stroke="#000" stroke-width="10" stroke-dasharray="10 10" vector-effect="non-scaling-stroke"/></svg>';
const b = await importSvg(svg, { preserveViewport: true });
const on = (x) => ((x % 20) + 20) % 20 < 10;
const table = (sx) => {
  const ov = new Float32Array(24 * b.numShapes);
  for (let i = 0; i < b.numShapes; i++) {
    const o = i * 24;
    ov[o] = sx;
    ov[o + 3] = sx;
    ov[o + 6] = 1;
    ov[o + 8] = 1;
    ov[o + 9] = 1;
    ov[o + 10] = 1;
    ov[o + 11] = 1;
  }
  return ov;
};
const sweep = (query, pixelOn) => {
  let bad = 0;
  for (let k = 0; k < 40; k++) {
    const x = k * 2.5 + 1.25;
    if (query(x).length > 0 !== pixelOn(x)) bad++;
  }
  return bad;
};
console.log('(control) no override, no world matrix: 10 on, 10 off');
ok(sweep((x) => fillHits(b, x, 100), on) === 0, 'the pattern as authored');
console.log(
  "(override) a row scaled 2: the row's line is at y 200, and its dashes stay 10 screen units",
);
{
  const ov = table(2);
  const bad = sweep((x) => fillHits(b, x, 200, { overrides: ov }), on);
  ok(bad === 0, `the hit band matches the drawn dashes (${bad} of 40 samples differ)`);
}
console.log('(override) a row scaled 1/2: the same, the other way');
{
  const ov = table(0.5);
  const bad = sweep((x) => fillHits(b, x, 50, { overrides: ov }), on);
  ok(bad === 0, `the hit band matches the drawn dashes (${bad} of 40 samples differ)`);
}
console.log('(world) a world scale of 2: the path-length unit follows it, as it did');
{
  const w = new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 1]);
  const bad = sweep((x) => fillHits(b, x, 200, { worldMatrix: w }), on);
  ok(bad === 0, `the hit band matches the drawn dashes (${bad} of 40 samples differ)`);
}
console.log(
  "(world) a turned world matrix: ePx is |cos| + |sin| per unit, and the dash unit is the width's",
);
{
  const c = Math.SQRT1_2,
    w = new Float32Array([c, c, 0, -c, c, 0, 0, 0, 1]);
  // The line's point at path distance s is canvas (s - 100) * c, (s + 100) * c. The drawn cycle is 20 * sqrt(2) in that path distance.
  const cycle = 20 * Math.SQRT2;
  let bad = 0;
  for (let k = 1; k < 40; k++) {
    const s = (k * cycle) / 8 + cycle / 16;
    const drawn = s % cycle < cycle / 2;
    if (fillHits(b, (s - 100) * c, (s + 100) * c, { worldMatrix: w }).length > 0 !== drawn) bad++;
  }
  ok(bad === 0, `the hit band matches the drawn dashes (${bad} of 39 samples differ)`);
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
