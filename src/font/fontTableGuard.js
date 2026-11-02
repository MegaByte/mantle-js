// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Guard lazy font-table readers. A failed read removes the malformed table,
// rebuilds the reader and retries the call. Layout restarts after a table is
// removed so all stages use the same table set.

import { mantleWarn } from '../core/diagnostics.js';

let _dropCount = 0;

const CONTROL = Symbol('guard control');

/** The reader behind a guard as it stands now, for a caller that answers for what it throws (see `layoutSlots`). */
export function unguarded(guard) {
  return guard[CONTROL].reader();
}

/** The reader behind `reader` if it is a guard, or `reader` itself. */
export function unguardedOr(reader) {
  const c = reader[CONTROL];
  return c ? c.reader() : reader;
}

/** Replace the reader behind a guard with a new one over the directory as it stands, for a caller that abandoned a call into it. */
export function rebuildGuarded(guard) {
  guard[CONTROL].rebuild();
}

/** How many tables have been dropped, on any font. A layout compares it to know whether a table went away underneath it. */
export function tableDropCount() {
  return _dropCount;
}

/**
 * Warn once per font and table. Returns true the first time.
 * @param {object} tables  the font's table directory (parseTtfTables)
 * @param {string} tag     the sfnt tag, as the font spells it
 * @param {any} error      what the read threw, for the message
 * @param {string} effect  what the font does instead
 */
export function noteMalformedTable(tables, tag, error, effect = 'dropped') {
  const seen = tables._malformed || (tables._malformed = new Set());
  if (seen.has(tag)) return false;
  seen.add(tag);
  mantleWarn(
    `[mantle] font table '${tag}' is malformed and is ${effect}: ${error && error.message ? error.message : error}`,
  );
  return true;
}

/** Take a table out of a font's directory for good, so everything that looks at the directory agrees it is absent. */
export function dropTable(tables, tag, keys, error) {
  noteMalformedTable(tables, tag, error);
  for (const key of keys) tables[key] = null;
  _dropCount++;
}

/**
 * The reader `build()` returns, reached so that nothing it throws escapes: see the file comment. The guard's fields, methods and
 * accessors forward. Reader-internal calls stay direct, so the guard costs one call per use from outside.
 * @param {object} tables    the font's table directory
 * @param {string} tag       the sfnt tag to name in the warning
 * @param {string[]} keys    the directory entries the reader reads
 * @param {() => any} build  makes the reader from the directory as it stands, with or without the table
 */
export function guardReader(tables, tag, keys, build) {
  let cur;
  try {
    cur = build();
  } catch (e) {
    dropTable(tables, tag, keys, e);
    cur = build();
  }
  const guard = Object.create(Object.getPrototypeOf(cur));
  const fail = (e) => {
    dropTable(tables, tag, keys, e);
    cur = build();
  };
  guard[CONTROL] = {
    reader: () => cur,
    rebuild: () => {
      try {
        cur = build();
      } catch (e) {
        dropTable(tables, tag, keys, e);
        cur = build();
      }
    },
  };
  // Forwards name the reader's function rather than look it up, and pass a fixed count (no public reader method takes more), so a call
  // costs a call. The reader is not the guard's prototype, which would give every reader a hidden class of its own.
  const forward = (fn) =>
    function (a, b, c, d, e, f) {
      try {
        return fn.call(cur, a, b, c, d, e, f);
      } catch (x) {
        fail(x);
        return fn.call(cur, a, b, c, d, e, f);
      }
    };
  for (const key of Object.keys(cur)) {
    if (typeof cur[key] !== 'function')
      Object.defineProperty(guard, key, {
        configurable: true,
        get() {
          return cur[key];
        },
        set(v) {
          cur[key] = v;
        },
      });
    else
      guard[key] = function (a, b, c, d, e, f) {
        try {
          return cur[key](a, b, c, d, e, f);
        } catch (x) {
          fail(x);
          return cur[key](a, b, c, d, e, f);
        }
      };
  }
  for (
    let p = Object.getPrototypeOf(cur);
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const key of Object.getOwnPropertyNames(p)) {
      if (key === 'constructor' || Object.prototype.hasOwnProperty.call(guard, key)) continue;
      const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(p, key));
      if (typeof d.value === 'function') guard[key] = forward(d.value);
      else if (d.get) {
        const get = d.get;
        Object.defineProperty(guard, key, {
          configurable: true,
          get() {
            try {
              return get.call(cur);
            } catch (x) {
              fail(x);
              return get.call(cur);
            }
          },
        });
      }
    }
  }
  return guard;
}
