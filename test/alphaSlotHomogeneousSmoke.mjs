// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// alphaSlotHomogeneousSmoke -- the slot offset of a faded instance goes through the matrix's w.
//
// A world matrix is homogeneous: the vertex stage draws at (m * p).xy / (m * p).z. A slot's offset is a translation of the clip position; added to the last column alone it would move the copy by
// offset / w: under w = 2, half way to its slot, so the composite would read the wrong texels. A matrix and its multiple are one transform; with perspective, the copy lands off its slot by an amount that varies across it.
// CPU (test/_fakeGl.mjs): the instance matrices the draw uploads, applied to points. In pixels: groupTargetsRenderSmoke.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="4" y="4" width="28" height="28" fill="#e04020"/><rect x="16" y="16" width="28" height="28" fill="#2040c0"/></svg>';
const INST_FLOATS = 18;
const base = (i) => [0.45, 0, 0, 0, 0.45, 0, -0.75 + 0.5 * (i % 4), 0.75 - 0.5 * ((i / 4) | 0), 1];
async function uploaded(matrixOf) {
  const F = createFakeGl({ width: 128, height: 128 }),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(128, 128);
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const b = createBundle(gl, await importSvg(SVG, { preserveViewport: true }));
  const insts = Array.from({ length: 16 }, (_, i) => ({
    worldMatrix: new Float32Array(matrixOf(i)),
    alpha: 0.5,
  }));
  // the instance uploads of a frame, one per atlas block, in order (the composite's upload is 12 floats per instance and does not divide)
  let seen = [];
  const bs = gl.bufferSubData.bind(gl);
  gl.bufferSubData = (t, o, d, ...r) => {
    if (d instanceof Float32Array && d.length && d.length % INST_FLOATS === 0) seen.push(...d);
    return bs(t, o, d, ...r);
  };
  for (let i = 0; i < 2; i++) {
    seen = [];
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(b, insts);
    R.endFrame();
  }
  const slots = R.debugStats.alphaSlotBatches;
  R.dispose();
  return { seen, slots };
}
const at = (m, k, x, y) => {
  const o = k * INST_FLOATS,
    w = m[o + 2] * x + m[o + 5] * y + m[o + 8];
  return [(m[o] * x + m[o + 3] * y + m[o + 6]) / w, (m[o + 1] * x + m[o + 4] * y + m[o + 7]) / w];
};
const POINTS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
  [0, 0],
];
const one = await uploaded(base);
ok(
  one.slots > 0 && one.seen.length === 16 * INST_FLOATS,
  `the premise: the slot path ran (${one.slots} batches, ${one.seen.length / INST_FLOATS} instances)`,
);
for (const [name, mul] of [
  ['2', 2],
  ['0.25', 0.25],
]) {
  const r = await uploaded((i) => base(i).map((v) => v * mul));
  ok(
    r.slots > 0 && r.seen.length === one.seen.length,
    `w = ${name}: the premise: the slot path ran`,
  );
  let worst = 0;
  for (let k = 0; k < 16; k++)
    for (const [x, y] of POINTS) {
      const a = at(one.seen, k, x, y),
        b = at(r.seen, k, x, y);
      worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
  ok(
    worst < 1e-5,
    `w = ${name}: every instance lands where w = 1 lands, to ${worst.toFixed(7)} clip units`,
  );
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
