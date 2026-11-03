// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitGroups.js — which id-bearing ancestor elements a row sits in, for group overrides (animation/overrides.js).
//
// The importer keeps, per row, the innermost ancestor element that has an `id`; the ancestors above it are that node's parent
// chain. A bundle with a hit-only table (importer.js) carries this tree in `bundle.hitOnly` as `groupNames` (the id of each
// node), `groupParent` (its parent node, -1 at the top), `drawnGroup` (per drawn row: its innermost node, -1 for none) and
// `rowGroup` (the same per hit-only table row). A bundle without a hit-only table carries none of it.

/// The walk's node for an element with an id: a plain record, so a document pays one small allocation per id'd element.
export function groupNode(parent, name) {
  return { name, parent };
}

/// A growing tree of { name, parent } nodes keyed by identity, flattened to arrays.
export function createGroupTree() {
  return { names: [], parent: [], at: new Map() };
}

/// The flat index of `node` (a walk record or null), adding it and its ancestors on first sight.
export function treeIndexOf(tree, node) {
  if (!node) return -1;
  let k = tree.at.get(node);
  if (k !== undefined) return k;
  const up = treeIndexOf(tree, node.parent);
  k = tree.names.length;
  tree.names.push(node.name);
  tree.parent.push(up);
  tree.at.set(node, k);
  return k;
}

/// The flat index in `into` (a tree with a `byKey` map, created here) of node `k` of another flat tree.
export function mergeNode(into, names, parent, k, memo) {
  if (k < 0) return -1;
  let m = memo.get(k);
  if (m !== undefined) return m;
  const up = mergeNode(into, names, parent, parent[k], memo);
  const key = up + '\u0000' + names[k];
  if (!into.byKey)
    into.byKey = new Map(into.names.map((nm, i) => [into.parent[i] + '\u0000' + nm, i]));
  m = into.byKey.get(key);
  if (m === undefined) {
    m = into.names.length;
    into.names.push(names[k]);
    into.parent.push(up);
    into.byKey.set(key, m);
  }
  memo.set(k, m);
  return m;
}

/// Keeps only the nodes some row in `rowArrays` reaches (a node and its ancestors), renumbered in order; rewrites the arrays.
/// Returns { names, parent } or null when no row is in any node.
export function compactTree(names, parent, rowArrays) {
  const used = new Uint8Array(names.length);
  for (const rows of rowArrays)
    for (let i = 0; i < rows.length; i++) {
      for (let k = rows[i]; k >= 0 && !used[k]; k = parent[k]) used[k] = 1;
    }
  const remap = new Int32Array(names.length).fill(-1);
  const outNames = [],
    outParent = [];
  for (let k = 0; k < names.length; k++) {
    if (!used[k]) continue;
    remap[k] = outNames.length;
    outNames.push(names[k]);
    outParent.push(parent[k] >= 0 ? remap[parent[k]] : -1);
  }
  if (!outNames.length) return null;
  for (const rows of rowArrays)
    for (let i = 0; i < rows.length; i++) if (rows[i] >= 0) rows[i] = remap[rows[i]];
  return { names: outNames, parent: Int32Array.from(outParent) };
}
