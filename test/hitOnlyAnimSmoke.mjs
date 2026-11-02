// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitOnlyAnimSmoke — hit-only shapes follow the override table: by id, by index, and through the group they sit in.
//
// A hit-only shape draws nothing but is a pointer target (a transparent hit rectangle, pointer-events:all over fill none). It
// lives in the bundle's static `hitOnly` table. The override table keeps a row for each, after the drawn rows in
// `packedBuffer` (never uploaded), so
//   (a) set / update / clear / get address it by id or by index numShapes + k, and the hit test reads its row;
//   (b) an override on a GROUP id (a <g id>, a <use id>, a nested <svg id>) is applied over every row under it, drawn and
//       hit-only, outermost group last: the effective matrix is G_outer * ... * G_inner * M_row, visibilities and tints multiply.
//
// What this proves (CPU: the real importer, override tables, hit test; the render side is hitOnlyAnimRenderSmoke):
//   1  the bundle: a hit-only table carries group data (format 2); a bundle without one carries no new field and no group id
//   2  the table: row counts, packedBuffer length, textureHeight, upload at the drawn rows, revision / generation
//   3  override by id and by index: translate, scale, rotate, hide, restroke; a hit-only row hidden by an override does not hit,
//      and opacity / tint never matter (paint, not targeting)
//   4  a group override: translate, scale, rotate, hide; non-members stay; nested groups compose in the shaders' order; the group
//      equals the same override set row by row on every member (drawn and hit-only), on a grid of points
//   5  own override under a group: update merges into the row's own, clear restores it, clear of the group restores the rows
//   6  hit-only inside <use> instances, a clip-path moving with its row, a stroke-only element's companion
//   7  70 hit-only rows animated by one group override
//   8  the native-SVG fallback table agrees with the GL one: key resolution, packed rows, hit answers, generation
//   9  a morph and a streaming update of a bundle with hit-only rows warn once; bundles without them do not
import { createFakeGl } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, t = 1e-5) => Math.abs(a - b) <= t;

const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const I = await import('../src/index.js');
const {
  importSvg,
  createBundle,
  createOverrideTable,
  fillHitShape,
  fillHitId,
  fillHits,
  setDiagnostics,
} = I;
const { createNativeOverrideTable } = await import('../src/fallback/nativeOverrideTable.js');
const gl = createFakeGl({ width: 64, height: 64 }).gl;

// A section that throws is a failure, not a crash: on a tree whose table has no hit-only rows the run still counts its checks.
const section = async (name, fn) => {
  console.log(name);
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: threw ${e && e.message}`);
  }
};

const svg = (body, vb = '0 0 200 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb}">${body}</svg>`;
const R = (x, y, w, h, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${extra}/>`;
const fixture = async () =>
  svg(
    '<g id="G">' +
      R(0, 0, 20, 20, 'id="a" fill="red"') + // drawn
      R(30, 0, 20, 20, 'id="h" fill="transparent"') + // hit-only, id
      R(60, 0, 20, 20, 'fill="transparent"') + // hit-only, no id
      '<g id="H">' +
      R(90, 0, 20, 20, 'fill="transparent"') +
      '</g>' + // hit-only, in a nested group
      '</g>' +
      R(150, 0, 10, 10, 'id="out" fill="blue"') + // drawn, outside G
      '<g id="K">' +
      R(120, 50, 20, 20, 'id="kh" fill="transparent"') +
      '</g>',
  );

const load = async (text, opts) => {
  const sections = await importSvg(text, { keepInvisibleShapes: false, ...opts }); // the optimizing mode: a region no row draws is hit-only
  const bundle = createBundle(gl, sections);
  return { sections, bundle, table: createOverrideTable(gl, bundle) };
};
const at = (b, t, x, y) => fillHitShape(b, x, y, { overrides: t });
const idAt = (b, t, x, y) => fillHitId(b, x, y, { overrides: t });

// rows: drawn a=0, out=1; hit-only (document order) h=2, unnamed=3, Hchild=4, kh=5
const F = await load(await fixture());
await section('1 the bundle', async () => {
  const ho = F.sections.hitOnly;
  ok(
    F.sections.numShapes === 2 && ho && ho.rows.length === 4,
    'fixture: two drawn rows, four hit-only rows',
  );
  const gt = F.sections.groupTree;
  ok(
    ho.format === 2 &&
      gt &&
      gt.format === 2 &&
      gt.groupNames.length === 3 &&
      gt.groupNames.includes('G') &&
      gt.groupNames.includes('H') &&
      gt.groupNames.includes('K'),
    'the group tree rides on the bundle (format 2); the hit-only table adds rowGroup',
  );
  ok(
    gt.drawnGroup.length === 2 && gt.drawnGroup[0] >= 0 && gt.drawnGroup[1] === -1,
    'drawn rows: a is in G, out is in none',
  );
  ok(
    ho.rowGroup.length === 4 &&
      gt.groupNames[ho.rowGroup[2]] === 'H' &&
      gt.groupNames[gt.groupParent[ho.rowGroup[2]]] === 'G',
    'the nested hit-only row is in H, whose parent is G',
  );
  ok(
    !('groupNames' in ho) && !('drawnGroup' in ho),
    'the tree is stored once (not again inside the hit-only table)',
  );
  const plain = await importSvg(
    svg(
      R(0, 0, 20, 20, 'id="a" fill="red"') +
        '<g id="Q">' +
        R(30, 0, 20, 20, 'fill="blue"') +
        '</g>',
    ),
  );
  ok(
    !plain.hitOnly &&
      plain.groupTree &&
      plain.groupTree.groupNames.join() === 'Q' &&
      plain.groupTree.drawnGroup.join() === '-1,0',
    'a bundle without hit-only rows carries the tree too (Q holds row 1)',
  );
  const noIds = await importSvg(
    svg(R(0, 0, 20, 20, 'fill="red"') + '<g>' + R(30, 0, 20, 20, 'fill="blue"') + '</g>'),
  );
  ok(
    !('groupTree' in noIds) && !('drawnGroup' in noIds) && !('groupNames' in noIds),
    'a bundle with no id on a container carries no group field',
  );
  const keys = Object.keys(plain).join();
  ok(!/_hit(Groups|Needed|RowAt|Pos)/.test(keys), 'no private pass field leaks into the sections');
});

await section('2 the table', async () => {
  const T = F.table;
  ok(
    T.numShapes === 2 && T.numHitOnly === 4,
    'numShapes counts drawn rows, numHitOnly the hit-only ones',
  );
  ok(T.packedBuffer.length === 6 * 24, 'packedBuffer holds drawn rows then hit-only rows');
  ok(T.textureHeight === 2, 'the texture is the drawn rows');
  ok(
    JSON.stringify(T.groupIds.slice().sort()) === JSON.stringify(['G', 'H', 'K']),
    'groupIds lists the addressable groups',
  );
  T.uploadIfDirty(); // the first upload always runs
  const rev = T.revision,
    gen = T.generation;
  T.set('h', { localPosition: [5, 5] });
  ok(
    T.revision === rev && T.generation === gen,
    'a change to a hit-only row alone bumps neither revision nor generation (nothing is drawn differently)',
  );
  T.uploadIfDirty();
  ok(T.generation === gen, 'and uploads nothing');
  T.set('a', { localPosition: [1, 1] });
  ok(T.revision === rev + 1, 'a change to a drawn row bumps the revision');
  T.uploadIfDirty();
  ok(T.generation === gen + 1, 'and the upload');
  T.clearAll();
  ok(
    T.packedBuffer[2 * 24 + 4] === 0 && T.packedBuffer[2 * 24] === 1,
    'clearAll resets the hit-only rows',
  );
});

await section('3 overrides by id and index', async () => {
  const T = createOverrideTable(gl, F.bundle),
    b = F.bundle;
  ok(
    at(b, T, 40, 10) === 2 && idAt(b, T, 40, 10) === 'h',
    'authored: the hit-only row h answers at its place',
  );
  T.set('h', { localPosition: [0, 50] });
  ok(
    at(b, T, 40, 10) === -1 && at(b, T, 40, 60) === 2 && idAt(b, T, 40, 60) === 'h',
    'set by id moves it',
  );
  ok(
    T.get('h').localPosition[1] === 50 &&
      T.get(2).localPosition[1] === 50 &&
      T.get('h').shapeId === 'h',
    'get reads it back, by id and by index',
  );
  T.set(2, { localScale: [2, 1] });
  ok(
    at(b, T, 85, 10) === 2 && at(b, T, 55, 10) === -1,
    'set by index (numShapes + k) scales it about the origin: x 60..100',
  );
  T.set('h', { localRotation: Math.PI / 2 });
  ok(at(b, T, -10, 40) === 2 && at(b, T, 40, 10) === -1, 'rotate 90 degrees: (x, y) -> (-y, x)');
  T.set('h', { visibility: 0 });
  ok(
    at(b, T, -10, 40) === -1 && at(b, T, 40, 10) === -1,
    'visibility 0 hides it (as it hides a drawn row)',
  );
  T.set('h', { visibility: 0.3, tint: [1, 1, 1, 0], fill: [0, 0, 0, 0] });
  ok(
    at(b, T, 40, 10) === 2,
    'partial visibility, a tint alpha of 0 and an absolute transparent fill are paint: it still hits',
  );
  T.update('h', { visibility: 1 });
  T.update('h', { localPosition: [100, 0] });
  ok(at(b, T, 140, 10) === 2, 'update merges: the position moved it again');
  T.clear('h');
  ok(
    at(b, T, 40, 10) === 2 && T.packedBuffer[2 * 24 + 4] === 0,
    'clear restores the authored place',
  );
  ok(
    T.set('nope', {}) === false &&
      T.set(99, {}) === false &&
      T.set(6, {}) === false &&
      T.set(5, {}) === true,
    'keys: unknown id, index past the hit-only rows, index of the last row',
  );
  T.set(5, { localPosition: [0, -50] });
  ok(
    at(b, T, 130, 60) === -1 && at(b, T, 130, 10) === 5,
    'the last hit-only row (kh) is addressable by index',
  );
  // hits in a stack: all of them, front to back
  ok(
    JSON.stringify(fillHits(b, 40, 10, { overrides: T })) === '[2]',
    'fillHits reports the moved hit-only row',
  );
});

await section('4 group overrides', async () => {
  const b = F.bundle;
  const T = createOverrideTable(gl, b);
  T.set('G', { localPosition: [100, 0] });
  ok(at(b, T, 10, 10) === -1 && at(b, T, 110, 10) === 0, 'G translated: its drawn row moved');
  ok(
    at(b, T, 140, 10) === 2 && at(b, T, 40, 10) === -1,
    'G translated: its hit-only row h moved with it',
  );
  ok(
    at(b, T, 170, 10) === 3 && at(b, T, 200, 10) === 4 && at(b, T, 60, 10) === -1,
    'G translated: the unnamed and the nested hit-only rows moved',
  );
  ok(at(b, T, 155, 5) === 1 && at(b, T, 130, 60) === 5, 'rows outside G stay: out and kh');
  ok(
    T.get('G').localPosition[0] === 100 && T.get('a').localPosition[0] === 0,
    'get(group) is the group record; get(row) stays the row own',
  );
  const eff = T.getEffective('a');
  ok(
    eff.localPosition[0] === 100 && eff.matrix && eff.matrix[4] === 100,
    'getEffective is the row as drawn',
  );
  ok(
    T.hasAny && T.activeIndices().join() === '0',
    'the drawn member of an active group counts as overridden',
  );
  const rev = T.revision;
  T.clear('G');
  ok(
    at(b, T, 10, 10) === 0 &&
      at(b, T, 40, 10) === 2 &&
      !T.hasAny &&
      T.activeIndices().length === 0 &&
      T.revision > rev,
    'clear(group): every member back at its place, nothing overridden',
  );
  T.set('G', { localScale: [2, 3] });
  ok(
    at(b, T, 80, 50) === 2 &&
      at(b, T, 45, 10) === -1 &&
      at(b, T, 150, 50) === 3 &&
      at(b, T, 200, 20) === 4,
    'G scaled (2, 3) about the origin',
  );
  T.set('G', { localRotation: Math.PI / 2 });
  ok(
    at(b, T, -10, 40) === 2 && at(b, T, -10, 70) === 3 && at(b, T, -10, 10) === 0,
    'G rotated 90 degrees',
  );
  T.set('G', { visibility: 0 });
  ok(
    at(b, T, 10, 10) === -1 &&
      at(b, T, 40, 10) === -1 &&
      at(b, T, 70, 10) === -1 &&
      at(b, T, 100, 10) === -1 &&
      at(b, T, 155, 5) === 1,
    'G hidden: its drawn and hit-only rows stop answering, others do not',
  );
  T.set('G', { visibility: 0.4, tint: [1, 0, 0, 0] });
  ok(
    at(b, T, 40, 10) === 2 && at(b, T, 10, 10) === 0,
    'G at partial visibility and a transparent tint still answers',
  );
  ok(
    T.packedBuffer[6] === 0.4 || near(T.packedBuffer[6], 0.4),
    'visibility multiplies into the packed row',
  );
  T.clearAll();

  // nested: H inside G; G translate then H scale: the H child maps through H first, then G
  T.set('G', { localPosition: [10, 0] });
  T.set('H', { localScale: [2, 2] });
  ok(
    at(b, T, 200, 20) === 4 &&
      at(b, T, 100, 10) === -1 &&
      at(b, T, 229, 39) === 4 &&
      at(b, T, 231, 20) === -1,
    'nested: G(H(row)): x -> 2x + 10',
  );
  ok(
    (at(b, T, 40 + 10, 10) === 2 && at(b, T, 20 + 10, 10) === 0) || at(b, T, 25, 10) === 0,
    'rows only in G take only G',
  );
  const p = T.packedBuffer;
  ok(
    near(p[4 * 24], 2) && near(p[4 * 24 + 3], 2) && near(p[4 * 24 + 4], 10),
    'the nested row packs [2 0 0 2 | 10 0]',
  );
  T.set('H', { localRotation: Math.PI / 2 });
  T.set('G', { localScale: [1, 3] }); // G = scale(1, 3), H = rotate 90: the row maps (x, y) -> G(H(x, y)) = (-y, 3x)
  ok(
    at(b, T, -10, 300) === 4 && at(b, T, 110, 10) === -1,
    'nested: G scale (1, 3) over H rotate 90 degrees: (x, y) -> (-y, 3x)',
  );
  T.clearAll();

  // the group is the same as the override set on every member row, drawn and hit-only
  const members = [0, 2, 3, 4];
  const spec = { localPosition: [37, 11], localRotation: 0.6, localScale: [1.4, 0.8] };
  const g = createOverrideTable(gl, b),
    rows = createOverrideTable(gl, b);
  g.set('G', spec);
  for (const r of members) rows.set(r, spec);
  let same = true;
  for (const r of members)
    for (let k = 0; k < 12; k++)
      if (!near(g.packedBuffer[r * 24 + k], rows.packedBuffer[r * 24 + k])) same = false;
  ok(same, 'the group packs exactly the rows a per-row override would');
  let agree = 0,
    cells = 0;
  for (let y = -60; y <= 160; y += 4)
    for (let x = -60; x <= 260; x += 4) {
      cells++;
      if (at(b, g, x, y) === at(b, rows, x, y)) agree++;
    }
  ok(agree === cells, `hit answers agree with per-row overrides on ${cells} points`);

  // a drawn child and a hit-only sibling move together: the drawn pixel's row and the hit-only row share the matrix
  const q = g.packedBuffer;
  ok(
    [0, 1, 2, 3, 4, 5].every((k) => near(q[0 * 24 + k], q[2 * 24 + k])) &&
      [0, 1, 2, 3, 4, 5].every((k) => near(q[0 * 24 + k], q[4 * 24 + k])),
    'a drawn child and a hit-only sibling compose to the same matrix',
  );
});

await section('5 own override under a group', async () => {
  const b = F.bundle,
    T = createOverrideTable(gl, b);
  T.set('h', { localPosition: [0, 50] });
  T.set('G', { localPosition: [100, 0] });
  ok(
    at(b, T, 145, 60) === 2 && at(b, T, 45, 60) === -1,
    'the row own override composes under the group: G(own(row))',
  );
  T.update('h', { localPosition: [0, 70] });
  ok(
    at(b, T, 145, 80) === 2 && T.get('h').localPosition[1] === 70,
    'update while covered merges into the row own override',
  );
  T.set('G', { localPosition: [0, 0], localScale: [1, 1] });
  ok(at(b, T, 40, 80) === 2, 'the group changed: recomposed from the row own override');
  T.clear('G');
  ok(
    at(b, T, 40, 80) === 2 && T.get('h').localPosition[1] === 70,
    'clear(group): the row keeps its own override',
  );
  T.clear('h');
  ok(
    at(b, T, 40, 10) === 2 && T.activeIndices().length === 0,
    'clear(row) after the group is gone',
  );
  T.set('G', { localPosition: [100, 0] });
  T.clear('h');
  ok(at(b, T, 140, 10) === 2, 'clear(row) while covered keeps the group applied');
  T.clearAll();
  ok(
    at(b, T, 40, 10) === 2 && at(b, T, 140, 10) === -1 && T.get('G').localPosition[0] === 0,
    'clearAll drops the group too',
  );
  // a group id that is also a row id is the row
  const sec = await importSvg(
    svg(
      '<g id="x">' +
        R(0, 0, 20, 20, 'fill="red"') +
        R(30, 0, 20, 20, 'id="x" fill="transparent"') +
        '</g>',
    ),
    { keepInvisibleShapes: false },
  );
  const T2 = createOverrideTable(gl, createBundle(gl, sec));
  ok(
    T2.groupIds.length === 0 &&
      T2.set('x', { localPosition: [1, 0] }) &&
      T2.get('x').localPosition[0] === 1,
    'an id that names a row is the row, not the group',
  );
  // absolute paint on a group is ignored, once, loudly
  const warns = [];
  setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
  T.set('G', { fill: [1, 0, 0, 1], localPosition: [3, 0] });
  T.update('G', { strokeWidth: 4 });
  setDiagnostics({ onWarn: null });
  ok(
    warns.length === 1 && /group override/.test(warns[0]),
    'fill / stroke / strokeWidth on a group warn once',
  );
  ok(
    T.packedBuffer[0 * 24 + 7] === 0 && T.get('G').fill === undefined,
    'and set nothing on its rows',
  );
});

await section('6 <use>, clip-path, stroke-only', async () => {
  const U = await load(
    svg(
      '<defs><g id="T">' +
        R(0, 0, 20, 20, 'id="r" fill="transparent"') +
        '</g></defs><use id="u1" href="#T" x="50"/><use id="u2" href="#T" x="100"/>',
    ),
  );
  const b = U.bundle,
    T = U.table;
  ok(
    T.numHitOnly === 2 && at(b, T, 60, 10) === 0 && at(b, T, 110, 10) === 1,
    '<use> instances: two hit-only rows',
  );
  T.set('u1', { localPosition: [0, 40] });
  ok(
    at(b, T, 60, 10) === -1 && at(b, T, 60, 50) === 0 && at(b, T, 110, 10) === 1,
    'an override on <use id> moves its instance only',
  );
  T.clear('u1');
  T.set('T', { localPosition: [0, 40] });
  ok(
    at(b, T, 60, 50) === 0 && at(b, T, 110, 50) === 1,
    'an override on the referenced group moves every instance',
  );
  T.clearAll();
  T.set('r', { localPosition: [0, 40] });
  ok(at(b, T, 60, 50) === 0 && at(b, T, 110, 10) === 1, 'the repeated id r is the first instance');

  const C = await load(
    svg(
      '<defs><clipPath id="cp">' +
        R(0, 0, 10, 20) +
        '</clipPath></defs><g id="G">' +
        R(0, 0, 20, 20, 'id="r" fill="transparent" clip-path="url(#cp)"') +
        '</g>',
    ),
  );
  C.table.set('G', { localPosition: [100, 0] });
  ok(
    C.sections.numShapes === 1 &&
      at(C.bundle, C.table, 105, 10) === 1 &&
      at(C.bundle, C.table, 115, 10) === -1 &&
      at(C.bundle, C.table, 5, 10) === -1,
    'a clip-path moves with its hit-only row',
  );
  C.table.set('G', { localScale: [2, 1] });
  ok(
    at(C.bundle, C.table, 15, 10) === 1 && at(C.bundle, C.table, 25, 10) === -1,
    'and scales with it',
  );

  const S = await load(
    svg(
      '<g id="P">' +
        R(
          10,
          10,
          40,
          40,
          'id="c" fill="none" stroke="blue" stroke-width="4" pointer-events="all"',
        ) +
        '</g>',
    ),
  );
  ok(
    S.sections.shapeIds[0] === 'c_stroke' && S.table.numHitOnly === 1,
    'a stroke-only element: drawn row c_stroke, hit-only fill region c',
  );
  ok(
    at(S.bundle, S.table, 30, 30) === 1 && at(S.bundle, S.table, 10, 30) === 0,
    'the interior is the hit-only region, the ring the drawn stroke',
  );
  S.table.set('c', { localPosition: [100, 0] });
  ok(
    at(S.bundle, S.table, 130, 30) === 1 &&
      at(S.bundle, S.table, 110, 30) === 0 &&
      at(S.bundle, S.table, 30, 30) === -1,
    'the element id moves both: the hit-only region follows its drawn stroke row',
  );
  ok(
    S.table.get('c').localPosition[0] === 100 && S.table.get('c_stroke').localPosition[0] === 100,
    'c addresses the drawn stroke row',
  );
});

await section('6b ties, symbol, mask, stroke width', async () => {
  const b = F.bundle,
    T = createOverrideTable(gl, b);
  // the set is closed under an override: a point exactly on the edge of a moved, scaled or rotated target hits
  T.set('h', { localPosition: [0, 40] });
  ok(
    at(b, T, 30, 50) === 2 &&
      at(b, T, 50, 50) === 2 &&
      at(b, T, 50.001, 50) === -1 &&
      at(b, T, 40, 40) === 2 &&
      at(b, T, 40, 60) === 2 &&
      at(b, T, 40, 60.001) === -1,
    'moved: all four edges are inside (ties are inclusive)',
  );
  T.set('h', { localRotation: Math.PI / 2 });
  ok(
    at(b, T, 0, 40) === 2 &&
      at(b, T, -20, 40) === 2 &&
      at(b, T, -20.001, 40) === -1 &&
      at(b, T, 0.001, 40) === -1,
    'rotated 90 degrees: the edge points hit',
  );
  T.set('h', { localScale: [2, 2] });
  ok(
    at(b, T, 70, 40) === 2 &&
      at(b, T, 100, 40) === 2 &&
      at(b, T, 100.001, 40) === -1 &&
      at(b, T, 70, 40.001) === -1,
    'scaled: the edge points hit',
  );
  T.set('h', { localScale: [0, 1] });
  ok(
    !fillHits(b, 0, 10, { overrides: T }).includes(2) &&
      !fillHits(b, 40, 10, { overrides: T }).includes(2),
    'a collapsed scale answers nothing (a singular matrix has no preimage)',
  );

  // <symbol> instance: the <use> id is a group
  const Y = await load(
    svg(
      '<defs><symbol id="S" viewBox="0 0 10 10">' +
        R(0, 0, 10, 10, 'id="r" fill="transparent"') +
        '</symbol></defs><use id="u" href="#S" x="10" y="10" width="40" height="40"/>',
    ),
  );
  const before = at(Y.bundle, Y.table, 30, 30);
  Y.table.set('u', { localPosition: [100, 0] });
  ok(
    Y.table.groupIds.includes('u') &&
      before >= 0 &&
      at(Y.bundle, Y.table, 30, 30) === -1 &&
      at(Y.bundle, Y.table, 130, 30) === before,
    'a <symbol> instance moves with its <use id>',
  );

  // a mask never changes a target (Auto ignores masks), moved or not
  const K = await load(
    svg(
      '<defs><mask id="m">' +
        R(0, 0, 10, 10, 'fill="white"') +
        '</mask></defs><g id="G">' +
        R(0, 0, 40, 40, 'fill="transparent" mask="url(#m)"') +
        '</g>',
    ),
  );
  ok(at(K.bundle, K.table, 30, 30) >= 0, 'masked hit-only: hits where the mask is zero');
  K.table.set('G', { localPosition: [100, 0] });
  ok(
    at(K.bundle, K.table, 130, 30) >= 0 && at(K.bundle, K.table, 30, 30) === -1,
    'and moved with its group',
  );

  // an absolute stroke width reaches a hit-only stroke region
  const W = await load(
    svg(
      '<g id="G"><path id="p" d="M10 50 H60" fill="none" stroke="red" stroke-width="0" pointer-events="stroke"/></g>',
    ),
  );
  ok(
    W.sections.hitOnly === undefined || W.table.numHitOnly === 0,
    'a zero-width stroke is no target (nothing to address)',
  );
  const V = await load(
    svg(
      '<g id="G"><path id="p" d="M10 50 H60" fill="none" stroke="transparent" stroke-width="4" pointer-events="stroke"/></g>',
    ),
  );
  ok(
    V.table.numHitOnly === 1 &&
      at(V.bundle, V.table, 30, 51) === 0 &&
      at(V.bundle, V.table, 30, 54) === -1,
    'a transparent stroke is a hit-only stroke band',
  );
  ok(V.sections.hitOnly.shapeIds[0] === 'p_stroke', 'its id is the stroke row name');
  V.table.set('p_stroke', { strokeWidth: 12 });
  ok(
    at(V.bundle, V.table, 30, 54) === 0 && at(V.bundle, V.table, 30, 57) === -1,
    'an absolute stroke width widens the hit-only band',
  );
  V.table.set('G', { localPosition: [0, 20] });
  ok(
    at(V.bundle, V.table, 30, 76) === 0 &&
      at(V.bundle, V.table, 30, 76.001) === -1 &&
      at(V.bundle, V.table, 30, 64) === 0 &&
      at(V.bundle, V.table, 30, 63.999) === -1,
    'and the band moves with its group: y 64..76',
  );
  ok(
    at(V.bundle, V.table, 30, 70) === 0 && at(V.bundle, V.table, 30, 50) === -1,
    'moved: the band is at y 70, not 50',
  );
  // a drawn fill with a transparent hit-only stroke: the hit-only row is the element's companion
  const Z = await load(
    svg(
      '<path id="x" d="M10 10 H60 V40 H10 Z" fill="red" stroke="transparent" stroke-width="8" pointer-events="all"/>',
    ),
  );
  ok(
    Z.sections.numShapes === 1 &&
      Z.table.numHitOnly === 1 &&
      Z.sections.hitOnly.shapeIds[0] === 'x_stroke',
    'a drawn fill and a hit-only stroke band: x and x_stroke',
  );
  Z.table.set('x_stroke', { localPosition: [100, 0] });
  ok(
    Z.table.get('x').localPosition[0] === 100 &&
      at(Z.bundle, Z.table, 130, 25) === 0 &&
      at(Z.bundle, Z.table, 164, 25) === 1 &&
      at(Z.bundle, Z.table, 64, 25) === -1,
    'the stroke band id addresses the element: the fill and the band move together',
  );
});

await section('7 seventy hit-only rows', async () => {
  let body = '<g id="grid">' + R(0, 0, 4, 4, 'id="mark" fill="red"');
  for (let i = 0; i < 70; i++)
    body += R((i % 10) * 12, 12 + Math.floor(i / 10) * 12, 10, 10, 'fill="transparent"');
  body += '</g>';
  const M = await load(svg(body, '0 0 1000 200'));
  const b = M.bundle,
    T = M.table;
  ok(T.numHitOnly === 70 && T.packedBuffer.length === 71 * 24, 'seventy hit-only rows');
  const centers = [];
  for (let i = 0; i < 70; i++) centers.push([(i % 10) * 12 + 5, 12 + Math.floor(i / 10) * 12 + 5]);
  ok(
    centers.every(([x, y], i) => at(b, T, x, y) === 1 + i),
    'authored: each answers at its place',
  );
  T.set('grid', { localPosition: [500, 0], localScale: [1, 1] });
  ok(
    centers.every(([x, y], i) => at(b, T, x + 500, y) === 1 + i && at(b, T, x, y) === -1),
    'one group override moved all seventy',
  );
  T.set('grid', { localPosition: [0, 0], localScale: [2, 2] });
  ok(
    centers.every(([x, y], i) => at(b, T, 2 * x, 2 * y) === 1 + i),
    'and scaled them',
  );
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 2000; k++) T.set('grid', { localPosition: [k % 7, 0] });
  const us = Number(process.hrtime.bigint() - t0) / 2000 / 1000;
  ok(us < 200, `group set over 71 rows: ${us.toFixed(1)} us per set`);
});

await section('8 the native table agrees with the GL one', async () => {
  const b = F.bundle;
  const gT = createOverrideTable(gl, b),
    nT = createNativeOverrideTable(b);
  const ops = [
    (t) => t.set('h', { localPosition: [0, 50] }),
    (t) => t.set('G', { localPosition: [100, 0], localScale: [1.5, 1] }),
    (t) => t.update('H', { localRotation: 0.4 }),
    (t) => t.set(3, { visibility: 0 }),
    (t) => t.update('a', { strokeWidth: 3 }),
    (t) => t.clear('h'),
    (t) => t.set('K', { localPosition: [-120, -50], visibility: 0.5 }),
    (t) => t.clear('G'),
    (t) => t.set(5, { localScale: [0.5, 0.5] }),
  ];
  const packedOf = (t) => (t.isNative ? t.packedForHit() : t.packedBuffer);
  let step = 0;
  for (const op of ops) {
    step++;
    const r1 = op(gT),
      r2 = op(nT);
    const A = packedOf(gT),
      B = packedOf(nT);
    let rowsOk = A.length === B.length;
    for (let r = 0; rowsOk && r < A.length / 24; r++)
      for (const k of [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11])
        if (!near(A[r * 24 + k], B[r * 24 + k])) {
          rowsOk = false;
          console.log('   row', r, 'float', k, A[r * 24 + k], B[r * 24 + k]);
        }
    ok(r1 === r2 && rowsOk, `op ${step}: same result and the same packed rows`);
    let agree = 0,
      cells = 0;
    for (let y = -60; y <= 160; y += 10)
      for (let x = -160; x <= 260; x += 10) {
        cells++;
        if (at(b, gT, x, y) === at(b, nT, x, y)) agree++;
      }
    ok(agree === cells, `op ${step}: hit answers agree on ${cells} points`);
  }
  // the native path draws and hit-tests the importer's sections directly (no createBundle): same answers as the bundle with the GL table
  nT.clearAll();
  gT.clearAll();
  for (const op of [
    (t) => t.set('G', { localPosition: [100, 0] }),
    (t) => t.set('h', { localPosition: [0, 50] }),
    (t) => t.update('K', { localRotation: 0.3 }),
  ]) {
    op(gT);
    op(nT);
  }
  let nativeAgree = 0,
    nativeCells = 0;
  for (let y = -60; y <= 160; y += 10)
    for (let x = -160; x <= 260; x += 10) {
      nativeCells++;
      if (fillHitShape(F.sections, x, y, { overrides: nT }) === at(b, gT, x, y)) nativeAgree++;
    }
  ok(
    nativeAgree === nativeCells,
    `the native path (sections + native table) answers like the bundle with the GL table on ${nativeCells} points`,
  );
  const g0 = nT.generation,
    h0 = nT.hitGeneration;
  nT.set('h', { localPosition: [1, 1] });
  ok(
    nT.generation === g0 && nT.hitGeneration > h0,
    'a hit-only change does not make the scene re-apply (generation), the hit view still sees it',
  );
  nT.set('G', { localPosition: [1, 1] });
  ok(nT.generation > g0, 'a group with drawn members does');
  nT.clearAll();
  nT.set('G', { localRotation: 0.5, localScale: [1, 2] });
  nT.set('a', { localRotation: -0.2, localScale: [3, 1] });
  const e = nT.getEffective('a'),
    ge = createOverrideTable(gl, b);
  ge.set('G', { localRotation: 0.5, localScale: [1, 2] });
  ge.set('a', { localRotation: -0.2, localScale: [3, 1] });
  const ee = ge.getEffective('a');
  ok(
    e.matrix.every((v, k) => near(v, ee.matrix[k])) && nT.activeIndices().join() === '0',
    'getEffective: the exact composed affine (it shears), the same on both tables',
  );
  ok(
    nT.numHitOnly === 4 && nT.groupIds.length === 3,
    'numHitOnly and groupIds on the native table',
  );
});

await section('9 static poses warn once', async () => {
  const warns = [];
  setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
  const A = await load(
    svg(R(10, 10, 20, 20, 'id="s" fill="red"') + R(10, 60, 20, 20, 'fill="transparent"')),
  );
  const B = await load(
    svg(R(60, 10, 20, 20, 'id="s" fill="red"') + R(60, 60, 20, 20, 'fill="transparent"')),
  );
  I.createShapeMorph(gl, A.bundle, B.bundle);
  I.createShapeMorph(gl, A.bundle, B.bundle);
  const morphWarns = warns.filter((w) => /hit-only/.test(w));
  ok(
    morphWarns.length === 2 && /createShapeMorph/.test(morphWarns[0]),
    'a morph of bundles with hit-only shapes warns once per bundle (source and destination)',
  );
  const P = await load(svg(R(10, 10, 20, 20, 'id="s" fill="red"')));
  const before = warns.length;
  I.createShapeMorph(gl, P.bundle, P.bundle);
  ok(warns.length === before, 'a morph of bundles without them is silent');
  const sline = (p) => p.map((q, i) => I.mkLine(q, p[(i + 1) % p.length]));
  const quad = [
    [10, 10],
    [30, 10],
    [30, 30],
    [10, 30],
  ];
  const Q = await load(
    svg(R(10, 10, 20, 20, 'id="s" fill="red"') + R(10, 60, 20, 20, 'fill="transparent"')),
  );
  I.updateBundleGeometry(gl, Q.bundle, [sline(quad)]);
  I.updateBundleGeometry(gl, Q.bundle, [sline(quad)]);
  ok(
    warns.filter((w) => /updateBundleGeometry/.test(w)).length === 1,
    'a streaming update warns once per bundle',
  );
  setDiagnostics({ onWarn: null });
});

if (fail) {
  console.log(`\nFAIL ${fail}`);
  process.exit(1);
}
console.log('\nPASS hitOnlyAnimSmoke');
