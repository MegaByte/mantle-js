// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A Node builtin module, reached without a static or analyzable import.
//
// Browsers decompress with DecompressionStream and fetch their shaders, so Node's zlib and fs are only the Node
// path (and the path for engines without brotli streams). A literal `import('zlib')` is a hard "cannot resolve"
// error in esbuild and webpack 5 browser builds even though the browser never runs it. This module resolves the
// builtin at run time:
//   1. process.getBuiltinModule (Node >= 20.16 / 22.3, Bun) - synchronous, no import at all;
//   2. otherwise a dynamic import whose specifier is computed, which no bundler tries to resolve
//      (the webpackIgnore and @vite-ignore comments cover webpack and Vite; esbuild and rollup leave a
//      non-literal specifier alone).
// Where neither exists (a browser) it throws `hint`, a sentence naming the capability the caller lacked.

const SPEC_SCHEME = 'node';

/// The module namespace of Node builtin `name` ('zlib', 'fs', ...). `hint` is the error message when the
/// environment is not Node.
export async function nodeBuiltin(name, hint) {
  const proc = /** @type {any} */ (globalThis).process;
  if (proc && typeof proc.getBuiltinModule === 'function') {
    const m = proc.getBuiltinModule('node:' + name);
    if (m) return m;
  }
  if (proc && proc.versions && proc.versions.node) {
    const specifier = [SPEC_SCHEME, name].join(':');
    return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);
  }
  throw new Error(hint);
}

/// Node's zlib. `what` names the caller's operation for the error message.
export function nodeZlib(what) {
  return nodeBuiltin(
    'zlib',
    `${what}: this environment has no DecompressionStream support for it and no Node zlib; ` +
      'use a browser that implements DecompressionStream (and, for WOFF2, brotli).',
  );
}
