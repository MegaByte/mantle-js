// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importGraph.mjs - the static (and optionally dynamic) module closure of a package entry, without a bundler.
//
// Used by the build-matrix smokes to assert what an entry can and cannot reach. Parses `import ... from`, `export ... from`,
// side-effect `import 'x'` and (when asked) `import('x')` with literal specifiers. Package self-references
// (`@kontek/mantle/...`) resolve through package.json#exports.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));

/** @kontek/mantle[/sub] -> absolute file, or null. */
export function resolveSelf(spec) {
  const exp = pkgJson.exports;
  if (spec === '@kontek/mantle') return path.join(PKG, exp['.'].default);
  if (!spec.startsWith('@kontek/mantle/')) return null;
  const sub = './' + spec.slice('@kontek/mantle/'.length);
  const pick = (v) => (typeof v === 'string' ? v : v.default);
  if (exp[sub]) return path.join(PKG, pick(exp[sub]));
  for (const [k, v] of Object.entries(exp)) {
    if (!k.includes('*')) continue;
    const [pre, post] = k.split('*');
    if (sub.startsWith(pre) && sub.endsWith(post))
      return path.join(PKG, pick(v).replace('*', sub.slice(pre.length, sub.length - post.length)));
  }
  return null;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Literal specifiers a source file imports: { spec, dynamic }. */
export function importsOf(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(
    /(?:^|[;\n}])\s*(?:import|export)\s+(?:[^'"`;()]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  ))
    out.push({ spec: m[1], dynamic: false });
  for (const m of code.matchAll(/[^\w.$]import\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    out.push({ spec: m[1], dynamic: true });
  return out;
}

/**
 * The modules reachable from `entry` (an absolute file, or an '@kontek/mantle/...' specifier).
 * @returns {Map<string, {via: string|null, dynamic: boolean}>} file -> first importer
 */
export function closure(entry, { dynamic = false } = {}) {
  const start = entry.startsWith('@kontek/') ? resolveSelf(entry) : path.resolve(entry);
  const seen = new Map([[start, { via: null, dynamic: false }]]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { spec, dynamic: dyn } of importsOf(src)) {
      if (dyn && !dynamic) continue;
      let target = null;
      if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
      else if (spec.startsWith('@kontek/mantle')) target = resolveSelf(spec);
      if (!target || !target.endsWith('.js') || seen.has(target)) continue;
      seen.set(target, { via: file, dynamic: dyn });
      queue.push(target);
    }
  }
  return seen;
}

/** Importer chain from the entry to `file`, as package-relative paths. */
export function chain(graph, file) {
  const out = [];
  for (let f = file; f; f = graph.get(f)?.via) out.push(path.relative(PKG, f));
  return out.reverse();
}

export const rel = (f) => path.relative(PKG, f);
