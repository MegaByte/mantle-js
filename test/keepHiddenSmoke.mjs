// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// keepHiddenSmoke -- content the document marks as not drawn is handled by an explicit, documented mechanism, never dropped silently.
//   * the DEFAULT import drops display:none subtrees, visibility:hidden / collapse leaves, zero-size shapes, zero-width strokes, markers at stroke
//     width 0 and empty groups, COUNTS them in `bundle.dropped`, and warns once (naming keepHidden) when a runtime API could have revealed them;
//   * `keepHidden: true` keeps them as rows that draw nothing, hit nothing and join no fit, cull or silhouette, until an override reveals them
//     (`reveal: true`, on the row or on a group above it); a morph or a timeline treats such a row as one at alpha 0 so it fades in with its
//     geometry; a zero-size shape and a zero-width stroke keep a degenerate row a morph or a width override can grow;
//   * SVG semantics hold in both modes: visibility inherits and a child may turn it back on (it draws even under a hidden parent), display:none
//     is not undone by a child's display, and a display:none subtree is not hit-testable until revealed;
//   * nothing changes for a document that has none of it: the same sections, no `dropped` field, no warning, meta version 2.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import {
  importSvg,
  createBundle,
  createShapeMorph,
  createShapeTimeline,
  createOverrideTable,
  fillHitShape,
  fillHitId,
  fillHits,
} from '../src/index.js';
import { syncKeptRows } from '../src/renderer/bundle.js';
import {
  FS_HIDDEN,
  FS_KEPT_INVISIBLE,
  META_VERSION,
  META_VERSION_PLAIN,
  META_FLAG_HIDDEN,
} from '../src/bundle/layout.js';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok ' + m);
  else {
    failures++;
    console.error('FAIL: ' + m);
  }
};
const warnings = [];
console.warn = (...a) => {
  warnings.push(a.join(' '));
};
const wrap = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${b}</svg>`;
const KEEP = { keepHidden: true };
const flagsOf = (S) => {
  const st = S.metaFloatsPerShape,
    f = new Float32Array(S.meta, 32);
  return S.shapeIds.map((_, r) => Math.round(f[r * st + 27]));
};
const alphaOf = (S, r) => {
  const st = S.metaFloatsPerShape,
    f = new Float32Array(S.meta, 32);
  return [f[r * st + 7], f[r * st + 11], f[r * st + 12]];
};
const idsOf = (S, bit) => S.shapeIds.filter((_, r) => (flagsOf(S)[r] & bit) !== 0);
const fresh = () => makeFakeWebgl2(16, 16).gl;
const idsDrawn = (B) =>
  B.drawList.filter((op) => op.kind === 'fillShape').map((op) => B.shapeIds[op.shapeIdx]);
const A = '<rect id="a" x="1" y="1" width="6" height="6" fill="red"/>';

// 1. The default import drops, counts and warns once; nothing else about the bundle changes.
{
  const body =
    A +
    '<g id="hid" display="none"><rect id="h1" x="8" y="1" width="6" height="6"/><rect id="h2" x="8" y="8" width="6" height="6"/></g>' +
    '<rect id="v" x="1" y="9" width="4" height="4" visibility="hidden"/><rect id="z" width="0" height="4"/><circle id="c" r="0"/><path id="e" d=""/>' +
    '<path id="w" d="M0 0L5 5" stroke="blue" stroke-width="0" fill="none"/><g id="empty"/>';
  warnings.length = 0;
  const S = await importSvg(wrap(body), {});
  check(
    S.shapeIds.join() === 'a_fill' || S.shapeIds.join() === 'a',
    `default: only the visible shape has a row (${S.shapeIds})`,
  );
  const d = S.dropped;
  check(
    d &&
      d.displayNoneSubtrees === 1 &&
      d.displayNoneShapes === 2 &&
      d.hiddenVisibilityLeaves === 1 &&
      d.zeroSizeShapes === 2 &&
      d.emptyGeometry === 1 &&
      d.zeroWidthStrokes === 1 &&
      d.emptyGroups === 1,
    `default: bundle.dropped counts every class (${JSON.stringify(d)})`,
  );
  const w = warnings.filter((m) => /keepHidden/.test(m));
  check(
    w.length === 1 && /display:none subtree/.test(w[0]) && /visibility:hidden leaf/.test(w[0]),
    `default: one warning names keepHidden and the classes (${w.length})`,
  );
  warnings.length = 0;
  const G = createBundle(fresh(), S);
  check(G.dropped && G.dropped.displayNoneSubtrees === 1, 'the report rides on the created bundle');
  // keepHidden: no report of what it kept (empty groups and empty geometry stay counted: there is nothing to keep)
  const K = await importSvg(wrap(body), KEEP);
  check(
    K.dropped &&
      !K.dropped.displayNoneSubtrees &&
      !K.dropped.hiddenVisibilityLeaves &&
      K.dropped.zeroSizeShapes === 2,
    `keepHidden: hidden content is kept, so only the rest is reported (${JSON.stringify(K.dropped)})`,
  );
  check(
    !warnings.some((m) => /keepHidden/.test(m)),
    'keepHidden: no warning (nothing a runtime API could reveal was dropped)',
  );
  // a document with none of it: no field, no warning, version 2
  warnings.length = 0;
  const P = await importSvg(wrap(A), {});
  check(
    P.dropped === undefined && !warnings.length,
    'a plain document: no dropped field, no warning',
  );
  check(
    new DataView(P.meta).getUint32(24, true) === META_VERSION_PLAIN,
    'a plain document: meta version stays ' + META_VERSION_PLAIN,
  );
  check(
    new DataView(K.meta).getUint32(24, true) === META_VERSION &&
      (new DataView(K.meta).getUint32(28, true) & META_FLAG_HIDDEN) !== 0,
    'keepHidden with hidden rows: meta version ' +
      META_VERSION +
      ' with the hidden flag (an older reader would draw them, so it must refuse)',
  );
  const P2 = await importSvg(wrap(A), KEEP);
  check(
    Buffer.compare(Buffer.from(P.meta), Buffer.from(P2.meta)) === 0 &&
      Buffer.compare(Buffer.from(P.curves), Buffer.from(P2.curves)) === 0,
    'keepHidden on a document with nothing hidden: the same bytes',
  );
}

// 2. keepHidden: rows, flags, draw list, fit.
{
  const body =
    A +
    '<g id="hid" display="none"><rect id="h1" x="8" y="1" width="6" height="6" fill="blue"/></g><rect id="v" x="1" y="9" width="4" height="4" visibility="hidden" fill="green"/>';
  const S = await importSvg(wrap(body), KEEP);
  check(
    S.shapeIds.join() === 'a,h1,v' || S.numShapes === 3,
    `keepHidden: three rows (${S.shapeIds})`,
  );
  const hid = idsOf(S, FS_HIDDEN);
  check(
    hid.join() === 'h1,v',
    `keepHidden: the display:none and visibility:hidden rows carry FS_HIDDEN (${hid})`,
  );
  check(
    alphaOf(S, S.shapeIds.indexOf('h1'))[0] === 1,
    'a hidden row keeps its authored paint (alpha 1)',
  );
  const B = createBundle(fresh(), S);
  check(idsDrawn(B).join() === 'a', `the draw list holds only the visible row (${idsDrawn(B)})`);
  check(S.globalBBox.join() === '1,1,6,6', `the fit ignores hidden rows (${S.globalBBox})`);
  const D = await importSvg(wrap(A), {});
  check(
    D.globalBBox.join() === S.globalBBox.join(),
    'the fit equals the document without the hidden content',
  );
}

// 3. SVG semantics, in both modes: visibility inherits and a child turns it back on; display:none is not undone by a child.
{
  const body =
    '<g visibility="hidden"><rect id="a" x="1" y="1" width="3" height="3"/><rect id="b" x="5" y="1" width="3" height="3" visibility="visible"/>' +
    '<g visibility="visible"><rect id="c" x="9" y="1" width="3" height="3"/><rect id="d" x="13" y="1" width="2" height="3" visibility="collapse"/></g></g>' +
    '<g display="none"><rect id="e" x="1" y="9" width="3" height="3" display="inline" visibility="visible"/></g>';
  for (const [name, o] of [
    ['default', {}],
    ['keepHidden', KEEP],
  ]) {
    const S = await importSvg(wrap(body), o);
    const B = createBundle(fresh(), S);
    check(
      idsDrawn(B).join() === 'b,c',
      `${name}: a child with visibility:visible draws under a hidden parent; hidden and collapse leaves and the display:none subtree do not (${idsDrawn(B)})`,
    );
    if (o.keepHidden)
      check(
        idsOf(S, FS_HIDDEN).join() === 'a,d,e',
        `keepHidden: the hidden rows are a, d (visibility), e (display:none, though its own display is inline) (${idsOf(S, FS_HIDDEN)})`,
      );
    else
      check(
        S.dropped.displayNoneSubtrees === 1 && S.dropped.hiddenVisibilityLeaves === 2,
        `default: counted (${JSON.stringify(S.dropped)})`,
      );
  }
}

// 4. An override reveals a hidden row (by id, by index, by a group id); the list returns to lean when it is cleared.
{
  const body =
    A +
    '<g id="grp"><g id="hid" display="none"><rect id="h1" x="8" y="1" width="6" height="6" fill="blue"/><rect id="h2" x="8" y="8" width="6" height="6" fill="green"/></g></g>' +
    '<rect id="v" x="1" y="9" width="4" height="4" visibility="hidden" fill="green"/>';
  const gl = fresh();
  const S = await importSvg(wrap(body), KEEP);
  const B = createBundle(gl, S),
    T = createOverrideTable(gl, B);
  syncKeptRows(B, T);
  check(idsDrawn(B).join() === 'a', 'no override: only the visible row draws');
  check(T.set('h1', { reveal: true }) === true, 'set(id, { reveal: true }) resolves');
  syncKeptRows(B, T);
  check(
    idsDrawn(B).join() === 'a,h1',
    `reveal by id: the row joins the list, the other hidden rows stay out (${idsDrawn(B)})`,
  );
  T.update('h1', { visibility: 0 });
  syncKeptRows(B, T);
  check(idsDrawn(B).join() === 'a', 'a revealed row at visibility 0 is hidden again');
  T.update('h1', { visibility: 1 });
  T.set('v', { reveal: true });
  syncKeptRows(B, T);
  check(
    idsDrawn(B).join() === 'a,h1,v',
    `a visibility:hidden row reveals the same way (${idsDrawn(B)})`,
  );
  T.clear('h1');
  T.clear('v');
  syncKeptRows(B, T);
  check(idsDrawn(B).join() === 'a', 'cleared: back to the lean list');
  check(T.get('h1').reveal === undefined, 'get() reports no reveal once cleared');
  T.set('h1', { reveal: true });
  check(T.get('h1').reveal === true, 'get() reports reveal');
  T.clear('h1');
  // a group id reveals every hidden row under it
  const grp = T.groupIds;
  if (T.set('hid', { reveal: true }) === true) {
    syncKeptRows(B, T);
    check(
      idsDrawn(B).join() === 'a,h1,h2',
      `reveal on a group id reveals every hidden row under it (${idsDrawn(B)})`,
    );
    T.clear('hid');
    syncKeptRows(B, T);
    check(idsDrawn(B).join() === 'a', 'clearing the group returns to the lean list');
  } else
    check(
      false,
      `a group id is a key when the bundle has hit-only or id'd containers (groupIds ${grp})`,
    );
}

// 5. Hit tests: a hidden row hits nothing until revealed.
{
  const body =
    A +
    '<g display="none"><rect id="h1" x="8" y="1" width="6" height="6"/></g><rect id="v" x="1" y="9" width="4" height="4" visibility="hidden"/>' +
    '<rect id="vp" x="9" y="9" width="4" height="4" visibility="hidden" pointer-events="painted"/>';
  const gl = fresh();
  const S = await importSvg(wrap(body), KEEP);
  const B = createBundle(gl, S),
    T = createOverrideTable(gl, B);
  check(
    fillHitId(B, 11, 4) === '' || fillHitId(B, 11, 4) == null,
    'display:none: not hit-testable',
  );
  check(
    fillHitId(B, 3, 11) == null || fillHitId(B, 3, 11) === '',
    'visibility:hidden (pointer-events auto): not hit',
  );
  check(
    fillHitId(B, 11, 11) === 'vp',
    'visibility:hidden with pointer-events:painted: still a target through the hit-only table',
  );
  check(fillHitId(B, 4, 4) === 'a', 'the visible row hits');
  T.set('h1', { reveal: true });
  T.set('v', { reveal: true });
  check(fillHitId(B, 11, 4, { overrides: T }) === 'h1', 'revealed display:none row hits');
  check(fillHitId(B, 3, 11, { overrides: T }) === 'v', 'revealed visibility:hidden row hits');
  T.update('h1', { visibility: 0 });
  check(!fillHitId(B, 11, 4, { overrides: T }), 'revealed at visibility 0: not a target');
  for (const mode of ['coverage', 'outline'])
    check(fillHitShape(B, 11, 4, mode) < 0, `${mode} mode: a hidden row is not hit either`);
}

// A kept row and its hit-only companion occupy one position in the hit stack.
{
  const R = (id, extra = '') => `<rect id="${id}" x="1" y="1" width="6" height="6" ${extra}/>`;
  const bodies = [
    '<g display="none">' + R('h', 'fill="blue"') + '</g>',
    R('dup', 'visibility="hidden" pointer-events="painted"') +
      R('dup', 'visibility="hidden" pointer-events="painted"'),
    '<defs><g id="part">' +
      R('h', 'visibility="hidden" pointer-events="painted"') +
      '</g><g id="nested"><use href="#part"/></g></defs><use href="#nested"/><use href="#nested"/>',
  ];
  for (const body of bodies) {
    const text = wrap(A + body + R('tail', 'fill="transparent"'));
    const shown = text.replace(/display="none"|visibility="hidden"/g, '');
    const gl = fresh(),
      S = await importSvg(text, { ...KEEP, keepInvisibleShapes: false });
    const V = await importSvg(shown, { keepInvisibleShapes: false });
    const B = createBundle(gl, structuredClone(S)),
      C = createBundle(gl, V);
    const T = createOverrideTable(gl, B),
      U = createOverrideTable(gl, C);
    const stack = (b, table) =>
      fillHits(b, 4, 4, { overrides: table }).map((i) =>
        i < b.numShapes ? b.shapeIds[i] : b.hitOnly.shapeIds[b.hitOnly.rows[i - b.numShapes]],
      );
    for (let r = 0; r < S.numShapes; r++) if (flagsOf(S)[r] & FS_HIDDEN) T.set(r, { reveal: true });
    check(
      stack(B, T).join() === stack(C, U).join(),
      'revealed hidden regions preserve document order and distinct source occurrences',
    );
    const r = flagsOf(S).findLastIndex((f) => f & FS_HIDDEN);
    T.set(r, { reveal: true, localPosition: [8, 0], fill: [0, 1, 0, 0] });
    U.set(r, { localPosition: [8, 0], fill: [0, 1, 0, 0] });
    check(
      stack(B, T).join() === stack(C, U).join(),
      'numeric owner overrides move the exact companion, including duplicate IDs and use instances',
    );
    T.dispose();
    U.dispose();
    B.dispose();
    C.dispose();
  }
}

// 6. A hidden opaque row hides nothing: the occlusion cull and the silhouette ignore it.
{
  const body =
    '<rect id="under" x="2" y="2" width="4" height="4" fill="red"/><g display="none"><rect id="big" x="0" y="0" width="16" height="16" fill="blue"/></g><rect id="top" x="9" y="9" width="3" height="3"/>';
  const S = await importSvg(wrap(body), KEEP);
  const B = createBundle(fresh(), S);
  check(
    idsDrawn(B).includes('under'),
    `a hidden opaque row does not cull the rows under it (${idsDrawn(B)})`,
  );
}

// 7. Morph and timeline through a pose that hides a shape: the row pairs, its geometry interpolates, it fades in.
{
  const pose = (hidden, x) =>
    wrap(
      `<rect id="m" x="${x}" y="2" width="4" height="4" fill="red"/>` +
        `<rect id="s" x="${x}" y="8" width="4" height="4" fill="blue" ${hidden ? 'display="none"' : ''}/>`,
    );
  const gl = fresh();
  const SA = await importSvg(pose(true, 1), KEEP),
    SB = await importSvg(pose(false, 9), KEEP);
  const A1 = createBundle(gl, SA),
    B1 = createBundle(gl, SB);
  const m = createShapeMorph(gl, A1, B1, { cpuLerp: true });
  check(
    m.plan.matched.length === 2 && !m.plan.srcOnly.length && !m.plan.dstOnly.length,
    `morph from a display:none pose pairs every row (${m.plan.matched.length} matched)`,
  );
  const stride = m.bundle.metaFloatsPerShape,
    row = (b, id) => b.shapeIds.indexOf(id);
  const rowS = row(m.bundle, 's'),
    mf = m.bundle.metaFloats,
    alt = m.bundle._drawAltMeta;
  // (the paint lerps on the GPU between the morph's own meta, its source pose, and the destination-aligned meta it keeps beside it)
  check(
    mf[rowS * stride + 7] === 0 && alt[rowS * stride + 7] === 1,
    `a hidden source row starts at alpha 0 and ends at the destination's alpha (${mf[rowS * stride + 7]} -> ${alt[rowS * stride + 7]})`,
  );
  check(
    idsDrawn(m.bundle).includes('s'),
    `the morph's draw list includes the row that fades in (${idsDrawn(m.bundle)})`,
  );
  check(
    (mf[rowS * stride + 27] & FS_HIDDEN) === 0,
    'the morph clears FS_HIDDEN (it is a row at alpha 0)',
  );
  // the hue of the hidden end is the other end's: blue fades in as blue
  const o = rowS * stride;
  check(
    mf[o + 4] < 0.1 && mf[o + 6] > 0.9,
    `it fades in as the destination's hue (rgb ${[mf[o + 4], mf[o + 5], mf[o + 6]].map((v) => v.toFixed(2))})`,
  );
  // and to a hidden pose: it fades out
  const m2 = createShapeMorph(gl, createBundle(gl, SB), createBundle(gl, SA), { cpuLerp: true });
  const r2 = row(m2.bundle, 's'),
    mf2 = m2.bundle.metaFloats,
    alt2 = m2.bundle._drawAltMeta;
  check(
    mf2[r2 * stride + 7] === 1 && alt2[r2 * stride + 7] === 0,
    `to a display:none pose: it ends at alpha 0 (${mf2[r2 * stride + 7]} -> ${alt2[r2 * stride + 7]})`,
  );
  // hidden in both poses: stays hidden
  const SC = await importSvg(pose(true, 5), KEEP);
  const m3 = createShapeMorph(gl, createBundle(gl, SA), createBundle(gl, SC), { cpuLerp: true });
  check(
    !idsDrawn(m3.bundle).includes('s') &&
      m3.bundle.metaFloats[row(m3.bundle, 's') * stride + 7] === 0,
    'hidden in both poses: never drawn',
  );
  // a timeline A (hidden) -> B (shown) -> C (hidden): its morphs pair every row, and the row is in the list of each
  const SD = await importSvg(pose(true, 5), KEEP);
  const tl = createShapeTimeline(
    gl,
    [createBundle(gl, SA), createBundle(gl, SB), createBundle(gl, SD)],
    [
      { time: 0, bundleIndex: 0 },
      { time: 1, bundleIndex: 1 },
      { time: 2, bundleIndex: 2 },
    ],
  );
  tl.setTime ? tl.setTime(0.5) : tl.setT(0.5);
  check(
    tl.bundle.shapeIds.includes('s') && idsDrawn(tl.bundle).includes('s'),
    `timeline through a hidden pose: the row is there and drawn while it fades (${idsDrawn(tl.bundle)})`,
  );
  tl.setTime ? tl.setTime(1.5) : tl.setT(1.5);
  check(idsDrawn(tl.bundle).includes('s'), 'timeline: ...and on the way back');
  // the default import cannot do it: the row is absent in the first pose, so it is destination-only (a fade at frozen geometry)
  const DA = await importSvg(pose(true, 1), {}),
    DB = await importSvg(pose(false, 9), {});
  const md = createShapeMorph(gl, createBundle(gl, DA), createBundle(gl, DB), { cpuLerp: true });
  check(
    md.plan.matched.length === 1 && md.plan.dstOnly.length === 1,
    'default: the dropped row is destination-only (what keepHidden avoids)',
  );
  // a hidden source row meets a shown destination: the hit bits follow the destination
  check(
    fillHitId(m.bundle, 3, 10) === 's',
    'a morph from a hidden pose to a shown one answers hits on the row (the destination shows it)',
  );
}

// 8. Zero-size shapes, zero-width strokes and markers at width 0 are dropped and counted in both modes.
{
  const body =
    '<rect width="0" height="4"/><circle r="0"/><path d="M0 0L5 5" stroke="blue" stroke-width="0" fill="none"/>' +
    '<defs><marker id="m" markerWidth="3" markerHeight="3"><circle cx="1" cy="1" r="1"/></marker></defs>' +
    '<path d="M2 4L14 4" stroke="blue" stroke-width="0" fill="none" marker-start="url(#m)" marker-end="url(#m)"/>';
  for (const [name, o] of [
    ['default', {}],
    ['keepHidden', KEEP],
  ]) {
    const d = (await importSvg(wrap(body), o)).dropped;
    check(
      d && d.zeroSizeShapes === 2 && d.zeroWidthStrokes === 2 && d.zeroWidthMarkers === 2,
      `${name}: zero-size shapes, zero-width strokes and markers counted (${JSON.stringify(d)})`,
    );
  }
}

// 9. The wire: hidden rows survive createBundle and the rows count is the document's.
{
  const S = await importSvg(
    wrap('<g display="none"><rect id="h" x="1" y="1" width="4" height="4"/></g>'),
    KEEP,
  );
  check(
    S.numShapes === 1 && S.globalBBox.join() === '0,0,0,0',
    `a document of only hidden content: a row, an empty fit (${S.globalBBox})`,
  );
  const B = createBundle(fresh(), S);
  check(
    B.drawList.length === 0 && B._hiddenRows && B._hiddenRows.length === 1,
    'it draws nothing and knows its hidden rows',
  );
}
// Destination owners use merged morph rows, including destination-only shapes.
{
  const R = (id, x, extra = '') =>
    `<rect id="${id}" x="${x}" y="1" width="4" height="4" ${extra}/>`;
  const hidden = 'visibility="hidden" pointer-events="painted"';
  const gl = fresh(),
    a = await importSvg(wrap(R('a', 1) + R('h', 1, hidden)), KEEP);
  const b = await importSvg(wrap(R('new', 9, hidden) + R('a', 1) + R('h', 1, hidden)), KEEP);
  const m = createShapeMorph(gl, createBundle(gl, a), createBundle(gl, b), { cpuLerp: true });
  check(
    m.plan.matched.length >= 2 && m.plan.dstOnly.length === 1,
    'owner relocation fixture has matched and destination-only rows',
  );
  const names = (table, ids) => Array.from(table.hiddenOwner, (r) => (r < 0 ? null : ids[r]));
  check(
    names(m.bundle.hitOnlyTo, m.bundle.shapeIds).join() === names(b.hitOnly, b.shapeIds).join(),
    'destination hit companions keep their source-element owners after morph row relocation',
  );
  m.dispose();
  const plain = await importSvg(wrap(R('plain', 1)), KEEP);
  check(
    !plain.hitOnly && !Object.keys(plain).some((k) => k.startsWith('_hit')),
    'no-hit import emits no persistent or private owner fields',
  );
}

// Hit-only fill/bbox targets follow their exact stroke owner without losing their region on reveal.
{
  const { createNativeOverrideTable } = await import('../src/fallback/nativeOverrideTable.js');
  const path = (pe) =>
    `<path id="p" d="M1 1H4V4H1Z" fill="none" stroke="blue" stroke-width=".25" visibility="hidden" pointer-events="${pe}"/>`;
  for (const pe of ['all', 'bounding-box'])
    for (const native of [false, true]) {
      const body = (first = 0, second = 0, shown = false) => {
        const p = path(pe),
          firstPath = p.replace('<path ', `<path transform="translate(${first} 0)" `);
        const secondPath = p.replace('<path ', `<path transform="translate(${5 + second} 0)" `);
        return shown
          ? (firstPath + secondPath).replaceAll('visibility="hidden"', '')
          : firstPath + secondPath;
      };
      const gl = fresh(),
        load = async (text) =>
          createBundle(
            gl,
            await importSvg(wrap(text), {
              ...KEEP,
              keepInvisibleShapes: false,
              preserveViewport: true,
            }),
          );
      const b = await load(body()),
        table = native ? createNativeOverrideTable(b) : createOverrideTable(gl, b);
      check(
        b.numShapes === 2 && b.hitOnly.hiddenOwner.every((r) => r >= 0),
        `${pe}: two retained stroke owners have exact fill/bbox targets`,
      );
      const stack = (bundle, overrides) =>
        [2, 7, 12].map((x) =>
          fillHits(bundle, x, 2, { overrides }).map((row) =>
            row < bundle.numShapes
              ? bundle.shapeIds[row]
              : bundle.hitOnly.shapeIds[bundle.hitOnly.rows[row - bundle.numShapes]],
          ),
        );
      try {
        for (const [name, first, second, shown] of [
          ['numeric', 0, 5, false],
          ['reveal', 0, 5, true],
          ['clear', 0, 0, false],
          ['base ID', 5, 0, false],
        ]) {
          table.clearAll();
          if (second) table.set(1, { localPosition: [second, 0] });
          if (first)
            check(
              table.set('p', { localPosition: [first, 0] }),
              `${pe}: base ID resolves first authored stroke`,
            );
          if (shown) for (let r = 0; r < b.numShapes; r++) table.update(r, { reveal: true });
          const packed = table.packedBuffer || table.packedForHit();
          check(
            packed[4] === first && packed[28] === second,
            `${pe}/${name}: actual transform packed`,
          );
          const ref = await load(body(first, second, shown));
          try {
            check(
              JSON.stringify(stack(b, table)) === JSON.stringify(stack(ref, null)),
              `${pe}/${name}/${native ? 'native' : 'GL'}: full hit stack matches authored geometry`,
            );
          } finally {
            ref.dispose();
          }
        }
      } finally {
        table.dispose();
        b.dispose();
      }
    }
}

if (failures) {
  console.error(`keepHiddenSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nkeepHiddenSmoke: explicit no-draw content is dropped with a report, or kept hidden and revealed by overrides, morphs and timelines',
);
