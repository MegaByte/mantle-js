// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupIdsEveryBundleSmoke -- the group tree is kept for every bundle, so a group override
// (table.set('G', ...) on the id of a <g>, <use> or nested <svg>) works without a hit-only table.
//
// If importSvg kept `groupNames` / `groupParent` / `drawnGroup` / `rowGroup` only inside `bundle.hitOnly`, table.set('G', ...) would
// return false on any bundle that has no hit-only rows, which is most of them. So:
//   * `bundle.groupTree = { format: 2, groupNames, groupParent, drawnGroup }` rides on the importSvg result and the bundle whenever some
//     row sits under an element with an id; a document without such an element carries NO new field (byte-identical sections);
//   * a bundle that also has hit-only rows adds `hitOnly.rowGroup` (format 2) for its own rows; the tree is stored once;
//   * the GL override table and the native table resolve group ids on every bundle (same keys, same composition);
//   * a morph bundle keeps the source's containers and takes the target's for the rows only it has.
import { createFakeGl } from './_fakeGl.mjs';
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, t = 1e-5) => Math.abs(a - b) <= t;
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const I = await import('../src/index.js');
const { importSvg, createBundle, createOverrideTable, createShapeMorph } = I;
const { createNativeOverrideTable } = await import('../src/fallback/nativeOverrideTable.js');
const gl = createFakeGl({ width: 64, height: 64 }).gl;
console.warn = () => {};

const svg = (body, root = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${root}>${body}</svg>`;
const R = (x, extra = '') =>
  `<rect x="${x}" y="0" width="10" height="10" ${/fill=/.test(extra) ? '' : 'fill="red"'} ${extra}/>`;
const packedRow = (t, r) =>
  Array.from((t.isNative ? t.packedForHit() : t.packedBuffer).subarray(r * 24, r * 24 + 12));

// ---- the data ----------------------------------------------------------------------------------------------------------------------
{
  const s = await importSvg(
    svg(`<g id="G">${R(0, 'id="a"')}${R(20)}<g id="H">${R(40)}</g></g>${R(60, 'id="out"')}`),
  );
  const t = s.groupTree;
  ok(
    !s.hitOnly && t && t.format === 2,
    'a bundle with no hit-only rows carries groupTree (format 2)',
  );
  ok(
    t &&
      t.groupNames.join() === 'G,H' &&
      Array.from(t.groupParent).join() === '-1,0' &&
      Array.from(t.drawnGroup).join() === '0,0,1,-1',
    `names G,H; H inside G; rows a,unnamed in G, the third in H, out in none (${t && t.groupNames}, ${t && Array.from(t.groupParent)}, ${t && Array.from(t.drawnGroup)})`,
  );
  ok(
    !('groupNames' in s) && !('drawnGroup' in s) && !('rowGroup' in s),
    'the three arrays live inside groupTree, not on the sections',
  );
  const bundle = createBundle(gl, s);
  ok(bundle.groupTree === s.groupTree, 'createBundle carries the tree');
}
{
  const none = await importSvg(svg(R(0, 'id="a"') + '<g>' + R(20) + '</g>'));
  ok(
    !('groupTree' in none) && !('hitOnly' in none),
    'a document with no id on a container carries no group field',
  );
  const rowIdOnly = await importSvg(svg(R(0, 'id="a"') + R(20, 'id="b"')));
  ok(!('groupTree' in rowIdOnly), 'ids on leaves are row ids, never groups: still no field');
  const root = await importSvg(svg(R(0), ' id="doc"'));
  ok(
    root.groupTree && root.groupTree.groupNames.join() === 'doc',
    'an id on the root <svg> is a group of every row',
  );
  const emptyG = await importSvg(svg('<g id="E"></g>' + R(0)));
  ok(!('groupTree' in emptyG), "an id'd container with no rows is not a node");
}
{
  const s = await importSvg(
    svg(`<g id="G">${R(0, 'id="a"')}${R(20, 'fill="transparent" id="h"')}</g>`),
    { keepInvisibleShapes: false },
  );
  ok(
    s.hitOnly &&
      s.hitOnly.format === 2 &&
      s.hitOnly.rowGroup &&
      !('groupNames' in s.hitOnly) &&
      s.groupTree.groupNames.join() === 'G',
    'with hit-only rows: the same tree on the bundle, rowGroup in hitOnly (format 2), nothing stored twice',
  );
}

// ---- the tables --------------------------------------------------------------------------------------------------------------------
const gl2 = makeFakeWebgl2(64, 64).gl;
const sections = await importSvg(
  svg(
    `<g id="G">${R(0, 'id="a"')}${R(20)}<g id="H">${R(40)}</g></g>${R(60, 'id="out"')}<defs><g id="T">${R(0, 'id="tr"')}</g></defs><use id="u1" href="#T"/><use id="u2" href="#T" x="30" y="40"/>`,
  ),
);
const bundle = createBundle(gl2, sections);
for (const [label, make] of [
  ['GL', () => createOverrideTable(gl2, bundle)],
  ['native', () => createNativeOverrideTable(sections)],
]) {
  const T = make();
  ok(
    Array.isArray(T.groupIds) && ['G', 'H', 'u1', 'u2'].every((g) => T.groupIds.includes(g)),
    `${label} table: groupIds lists the containers (${T.groupIds})`,
  );
  ok(
    T.set('G', { localPosition: [5, 7] }) === true && T.set('nope', {}) === false,
    `${label} table: set('G') resolves on a bundle with no hit-only rows; a missing id is still false`,
  );
  const moved = [0, 1, 2].map((r) => packedRow(T, r)[4]),
    still = packedRow(T, 3)[4];
  ok(
    moved.every((x) => near(x, 5)) && near(still, 0),
    `${label} table: every row under G moved by 5 (${moved}), the row outside did not (${still})`,
  );
  ok(T.set('H', { localScale: [2, 2] }) === true, `${label} table: a nested container resolves`);
  const h = packedRow(T, 2);
  ok(
    near(h[0], 2) && near(h[3], 2) && near(h[4], 5),
    `${label} table: G * H composes on the row in H (scale ${h[0]},${h[3]} translate ${h[4]})`,
  );
  T.clear('G');
  ok(
    near(packedRow(T, 0)[4], 0) && near(packedRow(T, 2)[0], 2),
    `${label} table: clear('G') restores its rows; H still scales its own`,
  );
  ok(T.set('u2', { localPosition: [3, 0] }) === true, `${label} table: a <use id> resolves`);
  const useRows = Array.from(sections.shapeIds)
    .map((id, i) => [id, i])
    .filter(([id]) => id === 'tr')
    .map(([, i]) => i);
  ok(
    useRows.length >= 2 &&
      near(packedRow(T, useRows[1])[4], 3) &&
      near(packedRow(T, useRows[0])[4], 0),
    `${label} table: only the instance u2 moved (rows ${useRows})`,
  );
}
{
  // A row id shadows a group id, exactly as with hit-only tables.
  const s = await importSvg(svg(`<g id="x">${R(0, 'id="x"')}${R(20)}</g>`));
  const T = createNativeOverrideTable(s);
  ok(
    T.groupIds.length === 0 &&
      T.set('x', { localPosition: [1, 0] }) === true &&
      near(packedRow(T, 1)[4], 0),
    'a row id shadows a group of the same id (set moves the row, not the group)',
  );
}

// ---- a morph keeps the containers ----------------------------------------------------------------------------------------------------
{
  const A = await importSvg(svg(`<g id="G">${R(0, 'id="a"')}</g>`)),
    B = await importSvg(svg(`<g id="G">${R(10, 'id="a"')}</g><g id="K">${R(30, 'id="b"')}</g>`));
  const m = createShapeMorph(gl2, createBundle(gl2, A), createBundle(gl2, B), { cpuLerp: true });
  const t = m.bundle.groupTree;
  ok(
    t && t.groupNames.join() === 'G,K' && Array.from(t.drawnGroup).join() === '0,1',
    `a morph bundle: the source's G holds a, the target-only b is in K (${t && t.groupNames}, ${t && Array.from(t.drawnGroup)})`,
  );
  ok(
    m.overrides.set('K', { visibility: 0.5 }) === true &&
      m.overrides.set('G', { localPosition: [1, 1] }) === true,
    'the morph table resolves G and K',
  );
}

// ---- the fixtures: any document with an id'd container gains the one field, nothing else changes -----------------------------------
{
  const docs = [
    svg(`<g id="G">${R(0)}</g><g id="H">${R(20, 'fill="none" stroke="blue"')}</g>`),
    svg(
      `<svg id="inner" x="10" y="10" width="50" height="50"><rect width="20" height="20"/></svg>`,
    ),
    svg(`<symbol id="s"><rect width="5" height="5"/></symbol><use href="#s" id="i"/>`),
  ];
  for (const d of docs) {
    const s = await importSvg(d);
    const keys = Object.keys(s).filter((k) => k !== 'groupTree');
    ok(
      s.groupTree && keys.every((k) => !/group|Group/.test(k)),
      `an id'd container adds exactly the field groupTree (${s.groupTree ? s.groupTree.groupNames : 'none'})`,
    );
  }
}

if (fail) {
  console.error(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log('\ngroupIdsEveryBundleSmoke PASS');
