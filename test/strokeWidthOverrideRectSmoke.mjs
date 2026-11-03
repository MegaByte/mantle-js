// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeWidthOverrideRectSmoke -- a stroke-width override widens the box a group's composite is bounded by.
//
// An override's strokeWidth replaces the row's in the vertex stage, and the cover grows with it; a row's painted box computed from the authored width would let a group composited through that
// box cut the wider stroke at the authored one. The box is also what a merged run, an atlas slot, a filter target and the overlap test of a faded draw use. In pixels: groupTargetsRenderSmoke.
// CPU (test/_fakeGl.mjs): the rect the accumulator is cleared to and read from.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg, createOverrideTable } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${b}</svg>`;
const S = (x, y, c, w = 4) =>
  `<rect x="${x}" y="${y}" width="40" height="40" fill="none" stroke="${c}" stroke-width="${w}"/>`;
const RUN = doc(
  `<g opacity="0.5">${S(80, 80, '#c00000')}</g><g opacity="0.5">${S(250, 250, '#00c000')}</g><g opacity="0.5">${S(80, 250, '#0000c0')}</g>`,
);
const ONE = doc(`<g opacity="0.5">${S(80, 80, '#c00000')}${S(90, 90, '#00c000')}</g>`);
// the wide stroke's outer edge is 30 px past the path: x and y from 50 to 150, top-left
const covers = (r) =>
  !!r && r[0] <= 50 && r[0] + r[2] >= 150 && r[1] <= 400 - 150 && r[1] + r[3] >= 400 - 50;
for (const [name, source] of [
  ['a merged run of groups', RUN],
  ['one group', ONE],
]) {
  console.log(`(${name})`);
  const F = createFakeGl({ width: 400, height: 400 }),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(400, 400);
  const b = createBundle(gl, await importSvg(source, { preserveViewport: true }));
  const t = createOverrideTable(gl, b);
  const row = b.drawList.find((o) => o.kind === 'fillShape').shapeIdx;
  const rect = () => {
    const n0 = F.log.length;
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { overrides: t });
    R.endFrame();
    const c = F.log.slice(n0).filter((e) => e.op === 'clear' && e.fbo !== null && e.sc);
    return c.length ? c[0].sc : null;
  };
  const r0 = rect();
  ok(
    !!r0 && !covers(r0),
    `the premise: the authored stroke is bounded tighter than the wide one (${r0})`,
  );
  t.set(row, { strokeWidth: 60 });
  const r1 = rect();
  ok(covers(r1), `the wide stroke is inside the rect (${r1})`);
  t.set(row, null);
  const r2 = rect();
  ok(String(r2) === String(r0), `back to the authored width, back to the authored rect (${r2})`);
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
