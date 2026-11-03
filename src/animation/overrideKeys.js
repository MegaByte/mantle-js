// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { parseMetaBin } from '../core/metaBin.js';
// overrideKeys.js — what an override table key addresses, shared by the WebGL table (overrides.js) and the native one
// (fallback/nativeOverrideTable.js) so the two resolve a key, and compose a group override, the same way.
//
// A key is one of:
//   - a DRAWN ROW, by index (0 .. numShapes - 1) or by `shapeIds` entry (the first row with that id);
//   - a HIT-only ROW, by index numShapes + k or by its id: a shape that draws nothing but can be a pointer target (the bundle's
//     `hitOnly` table; fillHitShape answers its row as numShapes + k). It has override state like any row, and only the hit
//     queries read it. One that shares an element with a drawn row is that row's COMPANION and follows it: its id is the drawn
//     row's (a stroked path whose fill is `none` under pointer-events: all draws `id_stroke` and has the hit-only fill `id`),
//     or its stroke-row name is (`id_stroke` over a drawn fill `id`); the id then addresses the drawn row. A hit-only row's
//     synthesized id (`shape_N_fill`, numbered by the second import pass) addresses nothing; address it by index or through a group;
//   - a GROUP, by the id of an ancestor element of rows (a `<g id>`, a `<use id>`, a nested `<svg id>`...), when no row has
//     that id. An override on a group is applied over every row under it (drawn and hit-only), outermost group last: a row's
//     effective matrix is G_outer * ... * G_inner * M_row, in em space about the em origin like a row override's own
//     transform; visibilities and tints multiply. Groups come from the bundle's `groupTree` (importSvg keeps it on every bundle with an
//     element that has an id and contains rows; a hit-only table adds its own rows' nodes).

const SYNTHETIC_ID = /^shape_\d+_(fill|stroke)$/;

/// The bundle's hit-only table when overrides address it: not a morph bundle (its rows are the merged poses', the table is a pose's).
export function hitOnlyOfBundle(bundle) {
  const ho = bundle && bundle.hitOnly;
  return ho && ho.rows && ho.rows.length && !bundle._morphBindingAliases ? ho : null;
}

/// A group key is encoded as `-2 - g` by `resolve`; a miss is -1.
export const groupKey = (g) => -2 - g;
export const groupOfKey = (idx) => -2 - idx;

export function createKeySpace(bundle, n) {
  const ho = hitOnlyOfBundle(bundle);
  const parsed =
    !bundle.metaFloats && bundle.meta ? parseMetaBin(bundle.meta, bundle.metaFloatsPerShape) : null;
  const meta = bundle.metaFloats || parsed?.metaFloats;
  const metaStride = bundle.metaFloatsPerShape || parsed?.floatsPerShape;
  const H = ho ? ho.rows.length : 0;
  const ids = bundle.shapeIds || null;
  const idIndex = new Map();
  let anyId = false;
  if (ids)
    for (let i = 0; i < ids.length; i++) {
      const s = ids[i];
      if (s) {
        anyId = true;
        if (!idIndex.has(s)) idIndex.set(s, i);
      }
    }
  let companions = null,
    isCompanion = null;
  for (let k = 0; k < H; k++) {
    const owner = ho.hiddenOwner && ho.hiddenOwner[k];
    if (Number.isInteger(owner) && owner >= 0 && owner < n) {
      if (!companions) {
        companions = new Map();
        isCompanion = new Uint8Array(n + H);
      }
      let list = companions.get(owner);
      if (!list) companions.set(owner, (list = []));
      list.push(n + k);
      isCompanion[n + k] = 1;
      const id = ho.shapeIds && ho.shapeIds[ho.rows[k]];
      if (id && !SYNTHETIC_ID.test(id) && !idIndex.has(id)) {
        const alias = id.endsWith('_stroke')
          ? idIndex.get(id.slice(0, -7))
          : idIndex.get(id + '_stroke');
        idIndex.set(id, alias !== undefined && alias < n ? alias : owner);
        anyId = true;
      }
      continue;
    }
    const id = ho.shapeIds && ho.shapeIds[ho.rows[k]];
    if (!id || SYNTHETIC_ID.test(id)) continue;
    if (owner === -2) {
      if (!idIndex.has(id)) {
        idIndex.set(id, n + k);
        anyId = true;
      }
      continue;
    }
    // The element's drawn row is `id`, or `id_stroke` when only its stroke is drawn (the importer's name for a stroke row); the
    // element id then addresses that row, and the hit-only region follows it.
    let d = idIndex.get(id);
    if (d === undefined) {
      const ds = id.endsWith('_stroke')
        ? idIndex.get(id.slice(0, -7))
        : idIndex.get(id + '_stroke');
      if (ds !== undefined && ds < n) {
        d = ds;
        idIndex.set(id, ds);
      }
    }
    if (d === undefined) {
      idIndex.set(id, n + k);
      anyId = true;
    } else if (d < n) {
      if (!companions) {
        companions = new Map();
        isCompanion = new Uint8Array(n + H);
      }
      let l = companions.get(d);
      if (!l) companions.set(d, (l = []));
      l.push(n + k);
      isCompanion[n + k] = 1;
    }
  }
  const total = n + H;
  // The group tree is the bundle's (every importSvg bundle with an id'd container carries it); a hit-only table adds `rowGroup`, its
  // own rows' nodes. A morph bundle's rows are the merged poses' (morphCore.js merges the trees).
  const tree =
    bundle.groupTree &&
    bundle.groupTree.groupNames &&
    bundle.groupTree.groupNames.length &&
    bundle.groupTree.drawnGroup
      ? bundle.groupTree
      : null;
  const hasGroups = !!(tree && (H === 0 || ho.rowGroup));
  let G = null;
  /// Distinct group names, the rows under each, and the node chain of a row. Built on first use.
  function groups() {
    if (G || !hasGroups) return G;
    const names = tree.groupNames,
      parent = tree.groupParent;
    const gOf = new Map(),
      gnames = [],
      nodeG = new Int32Array(names.length);
    for (let k = 0; k < names.length; k++) {
      let g = gOf.get(names[k]);
      if (g === undefined) {
        g = gnames.length;
        gOf.set(names[k], g);
        gnames.push(names[k]);
      }
      nodeG[k] = g;
    }
    const lists = gnames.map(() => []);
    const rowNode = (r) =>
      r < n ? (r < tree.drawnGroup.length ? tree.drawnGroup[r] : -1) : ho.rowGroup[r - n];
    for (let r = 0; r < total; r++) {
      if (isCompanion && isCompanion[r]) continue;
      for (let k = rowNode(r); k >= 0; k = parent[k]) {
        const l = lists[nodeG[k]];
        if (l[l.length - 1] !== r) l.push(r);
      }
    }
    G = {
      gOf,
      names: gnames,
      nodeG,
      parent,
      rowNode,
      members: lists.map((l) => Int32Array.from(l)),
    };
    return G;
  }
  return {
    ho,
    H,
    total,
    idIndex,
    anyId: anyId || hasGroups,
    companions,
    isCompanion,
    hasGroups,
    groups,
    // Boundary rows place group filters and masks. Group tint/visibility already affects their member paints.
    affineOnly(r) {
      return r < n && !!(meta && meta[r * metaStride + 27] & (64 | 128));
    },
    /// A row index, `-2 - g` for a group, or -1.
    resolve(key) {
      if (typeof key === 'number')
        return Number.isInteger(key) && key >= 0 && key < total ? key : -1;
      if (typeof key !== 'string') return -1;
      const i = idIndex.get(key);
      if (i !== undefined) return i;
      if (hasGroups) {
        const g = groups().gOf.get(key);
        if (g !== undefined) return groupKey(g);
      }
      return -1;
    },
    /// The id of row `idx` (drawn or hit-only), '' when it has none.
    idOf(idx) {
      if (idx < n) return (ids && ids[idx]) || '';
      return (ho && ho.shapeIds && ho.shapeIds[ho.rows[idx - n]]) || '';
    },
    /// The distinct group ids addressable as keys (those no row id shadows).
    groupIds() {
      const g = groups();
      return g ? g.names.filter((nm) => !idIndex.has(nm)) : [];
    },
  };
}

/// v = [m00, m01, m10, m11, tx, ty, visibility, tintR, tintG, tintB, tintA] of a row's own override: apply the active groups over
/// it, innermost first. `getG(g, out)` fills `out` with group g's state and returns true, or returns false when g has no override.
const _gv = new Float64Array(12);
export function composeChain(space, r, v, getG) {
  const G = space.groups();
  if (!G) return v;
  const affineOnly = space.affineOnly(r);
  let seen0 = -1,
    seen1 = -1,
    seen2 = -1;
  for (let k = G.rowNode(r); k >= 0; k = G.parent[k]) {
    const g = G.nodeG[k];
    if (g === seen0 || g === seen1 || g === seen2) continue; // one id repeated up a chain is one group
    seen2 = seen1;
    seen1 = seen0;
    seen0 = g;
    if (!getG(g, _gv)) continue;
    const a = v[0],
      b = v[1],
      c = v[2],
      d = v[3],
      tx = v[4],
      ty = v[5];
    v[0] = _gv[0] * a + _gv[1] * c;
    v[1] = _gv[0] * b + _gv[1] * d;
    v[2] = _gv[2] * a + _gv[3] * c;
    v[3] = _gv[2] * b + _gv[3] * d;
    v[4] = _gv[0] * tx + _gv[1] * ty + _gv[4];
    v[5] = _gv[2] * tx + _gv[3] * ty + _gv[5];
    if (!affineOnly) {
      v[6] *= _gv[6];
      v[7] *= _gv[7];
      v[8] *= _gv[8];
      v[9] *= _gv[9];
      v[10] *= _gv[10];
    }
    if (_gv[11] !== 0) v[11] = 1;
  }
  return v;
}
