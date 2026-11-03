// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterOverrideTablesSmoke -- one bundle drawn with two override tables: a filter result or a mask bake re-evaluates when the rows that feed it really differ, and only then.
//
// Keyed on a row's write counter, the caches would serve the second of two tables that each wrote a row once (they agree on the counter) the first table's filter result and mask.
// So the key compares a digest of the row's values. CPU, recording GL stand-in: which draw evaluated what.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const { createOverrideTable } = await import('../src/animation/overrides.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const BLUR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter></defs><path d="M30 30 L50 30 L50 50 Z" fill="#d33" filter="url(#b)"/><rect x="60" y="60" width="10" height="10" fill="#333"/></svg>';
const GRAPH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="b"><feGaussianBlur stdDeviation="3"/><feOffset dx="4"/></filter></defs><path d="M30 30 L50 30 L50 50 Z" fill="#d33" filter="url(#b)"/><rect x="60" y="60" width="10" height="10" fill="#333"/></svg>';
const MASK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><mask id="m"><rect x="10" y="10" width="40" height="40" fill="#fff"/><rect x="20" y="20" width="10" height="10" fill="#000"/></mask></defs><rect width="100" height="100" fill="#28f" mask="url(#m)"/></svg>';
const GROUP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="b"><feGaussianBlur stdDeviation="3"/><feOffset dx="4"/></filter></defs><g id="g" filter="url(#b)"><path id="k" d="M30 30 L50 30 L50 50 Z" fill="#d33"/><rect id="l" x="60" y="60" width="10" height="10" fill="#333"/></g></svg>';

const PATTERN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter><pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse"><rect id="pr" width="10" height="10" fill="#0a0"/><circle id="pc" cx="15" cy="15" r="3" fill="#00a"/></pattern></defs><path d="M30 30 L70 30 L70 70 Z" fill="url(#p)" filter="url(#b)"/></svg>';

const rig = async (svg, opts = {}) => {
  const F = createFakeGl({ width: 256, height: 256 }),
    gp = F.gl.getParameter.bind(F.gl);
  F.gl.getParameter = (p) =>
    p === F.gl.MAX_TEXTURE_SIZE || p === F.gl.MAX_RENDERBUFFER_SIZE
      ? 16384
      : p === F.gl.MAX_VIEWPORT_DIMS
        ? new Int32Array([16384, 16384])
        : gp(p); // (the stand-in answers no limits, and a filter frame reads them)
  const R = createRenderer(F.gl, taggedShaderSources(), opts);
  R.setViewport(256, 256);
  const bundle = createBundle(F.gl, await importSvg(svg, { preserveViewport: true }));
  const bakes = () =>
    F.log.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('maskBakeFrag')).length;
  const evals = () => R.debugStats.filterEvalCount | 0;
  const frame = (t) => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(bundle, t === undefined ? {} : { overrides: t });
    R.endFrame();
  };
  return { F, R, bundle, bakes, evals, frame, table: () => createOverrideTable(F.gl, bundle) };
};

for (const [name, svg, count, rows] of [
  ['single-kind blur', BLUR, 'evals', [0]],
  ['filter graph', GRAPH, 'evals', [0]],
  ['mask children', MASK, 'bakes', [1, 2]],
]) {
  const h = await rig(svg),
    n = h[count];
  const A = h.table(),
    B = h.table(),
    Same = h.table(),
    Far = h.table();
  for (const r of rows) {
    A.set(r, { localPosition: [-0.2, 0] });
    B.set(r, { localPosition: [0.2, 0] });
    Same.set(r, { localPosition: [-0.2, 0] });
    Far.set(r, { localPosition: [-0.2, 0] });
    Far.set(r, { localPosition: [-0.2, 0] });
  }
  ok(
    A.shapeGenOf(rows[0]) === B.shapeGenOf(rows[0]),
    `${name}: the premise, two tables whose counters agree`,
  );
  ok(
    A.shapeContentOf?.(rows[0]) !== B.shapeContentOf?.(rows[0]) &&
      A.shapeContentOf?.(rows[0]) === Same.shapeContentOf?.(rows[0]),
    `${name}: the rows' digests tell them apart, and equal rows agree`,
  );
  h.frame(A);
  const e0 = n();
  ok(e0 >= 1, `${name}: the first table evaluates`);
  h.frame(A);
  ok(n() === e0, `${name}: the same table again, nothing evaluates`);
  h.frame(B);
  const e1 = n();
  ok(
    e1 > e0,
    `${name}: a table whose row differs evaluates (+${e1 - e0}) instead of being served the other's result`,
  );
  h.frame(A);
  const e2 = n();
  ok(e2 > e1, `${name}: and back (+${e2 - e1}): the slot holds the last table's result`);
  h.frame(Same);
  ok(n() === e2, `${name}: another table with equal rows and equal counters evaluates nothing`);
  h.frame(Far);
  ok(n() === e2, `${name}: another table with equal rows and other counters evaluates nothing`);
  A.set(rows[0], { localPosition: [-0.2, 0] });
  h.frame(A);
  ok(n() === e2, `${name}: a write of the value the row already has evaluates nothing`);
  h.R.dispose();
}

// A table that moves nothing that feeds the result is the same draw as no table, and as another such table.
{
  const h = await rig(BLUR),
    I = h.table(),
    J = h.table();
  J.set(1, { localPosition: [0.1, 0] }); // the other row
  h.frame();
  const e0 = h.evals();
  h.frame(I);
  ok(h.evals() === e0, 'a table of identity rows is no table');
  h.frame(J);
  ok(h.evals() === e0, "a table that moves another row does not touch this row's result");
  J.set(0, { localPosition: [0.1, 0] });
  J.clear(0);
  h.frame(J);
  ok(h.evals() === e0, 'a row set and cleared reads as identity again');
  J.set(0, { tint: [1, 0, 0, 1] });
  h.frame(J);
  ok(h.evals() === e0 + 1, 'a tint is part of the row: it evaluates');
  J.packedBuffer[8] = 0.5;
  J.markDirty();
  h.frame(J);
  ok(h.evals() === e0 + 2, 'a direct buffer write with markDirty evaluates');
  h.R.dispose();
}

// A filtered group's key holds the table: two tables that say the same are one; any other difference evaluates.
{
  const h = await rig(GROUP, { groupFilterCache: true }),
    A = h.table(),
    B = h.table(),
    Same = h.table();
  A.set('k', { localPosition: [-0.1, 0] });
  B.set('k', { localPosition: [0.1, 0] });
  Same.set('k', { localPosition: [-0.1, 0] });
  const n = () => h.R.debugStats.filterEvalCount | 0;
  h.frame(A);
  h.frame(A);
  const e0 = n();
  h.frame(B);
  const e1 = n();
  ok(e1 > e0, `filtered group: a table whose child row differs evaluates (+${e1 - e0})`);
  h.frame(A);
  const e2 = n();
  ok(e2 > e1, 'filtered group: and back');
  h.frame(Same);
  ok(n() === e2, 'filtered group: another table that says the same evaluates nothing');
  h.R.dispose();
}

// A vector-pattern fill's tile rows are read by the fill shader: they feed the filter result as the row itself does.
{
  const h = await rig(PATTERN),
    A = h.table(),
    B = h.table(),
    Same = h.table();
  const child = 'pc',
    move = (t, x) => t.set(child, { localPosition: [x, 0] });
  move(A, -0.1);
  move(B, 0.1);
  move(Same, -0.1);
  h.frame(A);
  h.frame(A);
  const e0 = h.evals();
  h.frame(B);
  const e1 = h.evals();
  ok(e1 > e0, `a filtered pattern fill: a table whose tile row differs evaluates (+${e1 - e0})`);
  h.frame(Same);
  const e2 = h.evals();
  ok(e2 > e1, "and another table with the first one's rows evaluates back");
  h.frame(A);
  ok(h.evals() === e2, 'and an equal table after it evaluates nothing');
  move(A, 0.3);
  h.frame(A);
  ok(h.evals() > e2, 'one table: moving a tile row evaluates');
  h.R.dispose();
}

// The filter-frame decision is remembered per row: it reads the row too. A table that moves the shape across the canvas edge frames it; one that does not, does not.
{
  const h = await rig(BLUR),
    Past = h.table(),
    Inside = h.table();
  const [x, , w] = h.bundle.globalBBox,
    span = w; // (em per viewBox width)
  Past.set(0, { localPosition: [x + 0.65 * span, 0] });
  Inside.set(0, { localPosition: [x + 0.02 * span, 0] });
  const widest = (t) => {
    const n0 = h.F.log.length;
    h.frame(t);
    return Math.max(
      ...h.F.log
        .slice(n0)
        .filter((e) => e.op === 'draw' && e.vp)
        .map((e) => e.vp[2]),
    );
  };
  const w1 = widest(Past),
    w2 = widest(Inside);
  ok(w1 > 256, `a table that takes the shape past the edge gets a filter frame (${w1} px wide)`);
  ok(w2 === 256, `the other table on the same bundle does not (${w2} px wide)`);
  h.R.dispose();
}

console.log(fail ? `filterOverrideTablesSmoke: ${fail} FAILED` : 'filterOverrideTablesSmoke: PASS');
process.exit(fail ? 1 : 0);
