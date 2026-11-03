// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// handleKeptRowsSmoke -- a mount brings a kept row back as drawBundle does.
//
// An override that gives a row kept at alpha 0 ink, or reveal on a keepHidden row, puts the row back into the draw list, as drawBundle and drawBundleInstanced do. A mount is
// documented as taking drawBundle's options, so it must do the same, or it paints nothing for the row. CPU, driver-model stand-in.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const M = await import('../src/index.js');
const { createRenderer, createBundle, importSvg } = M;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const rig = async (opts = {}, W = createPendingGl({ linkMs: 1, pipelineMs: 1 })) => {
  const R = createRenderer(W.gl, taggedShaderSources(), { aacFill: 'auto', ...opts });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 5);
  await R.ready;
  R.setViewport(256, 256);
  return { W, R, gl: W.gl };
};
const bundleOf = async (gl, s, o = { preserveViewport: true }) =>
  createBundle(gl, await importSvg(s, o));
const { gl, R } = await rig();
const rows = (b) => b.drawList.map((o) => o.shapeIdx).join();
console.log('(kept) a kept row given ink');
{
  const S = svg(
    '<rect x="10" y="10" width="20" height="20" fill="#c00"/><rect x="60" y="60" width="20" height="20" fill="#0c0" fill-opacity="0"/>',
  );
  const b1 = await bundleOf(gl, S),
    b2 = await bundleOf(gl, S);
  ok(rows(b1) === '0', `the premise: the draw list leaves the kept row out (${rows(b1)})`);
  const t1 = M.createOverrideTable(gl, b1),
    t2 = M.createOverrideTable(gl, b2);
  t1.update(1, { fill: [0, 0.8, 0, 1] });
  t2.update(1, { fill: [0, 0.8, 0, 1] });
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b1, { overrides: t1 });
  const h = R.createBundleHandle(b2);
  h.draw({ overrides: t2 });
  R.endFrame();
  ok(rows(b1) === '0,1' && rows(b2) === '0,1', `drawBundle ${rows(b1)}, handle.draw ${rows(b2)}`);
}
console.log('(reveal) a keepHidden row revealed');
{
  const S = svg(
    '<rect id="vis" x="10" y="10" width="20" height="20" fill="#c00"/><rect id="hid" x="60" y="60" width="20" height="20" fill="#0c0" display="none"/>',
  );
  const O = { preserveViewport: true, keepHidden: true };
  const b1 = await bundleOf(gl, S, O),
    b2 = await bundleOf(gl, S, O);
  const row = Array.from(b1.shapeIds || []).indexOf('hid');
  const t1 = M.createOverrideTable(gl, b1),
    t2 = M.createOverrideTable(gl, b2);
  t1.update(row, { reveal: true });
  t2.update(row, { reveal: true });
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b1, { overrides: t1 });
  const h = R.createBundleHandle(b2);
  h.draw({ overrides: t2 });
  R.endFrame();
  ok(rows(b2) === rows(b1), `drawBundle ${rows(b1)}, handle.draw ${rows(b2)}`);
}
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
