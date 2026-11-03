// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Only library-owned tables guarantee a revision bump for every visual mutation.
const tables = new WeakSet();

/** @template {object} T @param {T} table @returns {T} */
export function markRevisionedOverrideTable(table) {
  tables.add(table);
  return table;
}

/** @param {unknown} table */
export function hasTrackedOverrideRevision(table) {
  return table !== null && typeof table === 'object' && tables.has(table);
}

/// What a row of `table` says, as a key for a result the row feeds: equal for equal rows in any table, 0 for no table. (A table without shapeContentOf keeps its counter, and the
/// caches keep treating its rows as unchanged while the counter stands.)
export function overrideRowKey(table, row) {
  if (!table) return 0;
  return table.shapeContentOf
    ? table.shapeContentOf(row)
    : table.shapeGenOf
      ? table.shapeGenOf(row)
      : 0;
}
/// Two tables that say the same thing. Only for tables that can tell (library tables); no table reads as all identity rows.
export function sameOverrideContent(a, b) {
  if (a === b) return true;
  if ((a && !a.contentKey) || (b && !b.contentKey)) return false;
  return (a ? a.contentKey() : 0) === (b ? b.contentKey() : 0);
}
