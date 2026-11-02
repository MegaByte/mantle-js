// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cullRetireDocumentUnitsSmoke -- an override that moves an occluder retires the occlusion cull in a document of any units.
//
// The scan for "can this table change what covers what" must not compare the row's translation with an absolute 1e-4 in the document's own units. In a document 4e-4 units wide that is a quarter
// of the canvas: the occluder moves 90 of 400 px, the cull stays, and the row it had hidden stays missing where it now shows. The same document at any other scale retires (correct at any scale).
// CPU (test/_fakeGl.mjs): the bundle's draw list.
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
for (const [vb, u] of [
  ['0 0 400 400', 1],
  ['0 0 0.0004 0.0004', 1e-6],
  ['0 0 400000 400000', 1000],
]) {
  console.log(`(viewBox ${vb})`);
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><rect x="${100 * u}" y="${100 * u}" width="${50 * u}" height="${50 * u}" fill="#c33"/><rect x="${50 * u}" y="${50 * u}" width="${200 * u}" height="${200 * u}" fill="#3c3"/></svg>`;
  const F = createFakeGl({ width: 400, height: 400 }),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(400, 400);
  const b = createBundle(gl, await importSvg(SVG, { preserveViewport: true }));
  const rows = () => b.drawList.filter((o) => o.kind === 'fillShape').length;
  for (let i = 0; i < 2000 && b._occlusionCullPending; i++)
    await new Promise((r) => setTimeout(r, 5));
  ok(rows() === 1, `the premise: the covered row is culled (${rows()} drawn)`);
  const t = createOverrideTable(gl, b);
  t.set(b.numShapes - 1, { localPosition: [90 * u, 0] });
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, { overrides: t });
  R.endFrame();
  ok(
    b._cullRetired === true && rows() === 2,
    `moving the occluder 90 px brings it back (${rows()} drawn)`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
