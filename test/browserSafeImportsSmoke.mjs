// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// browserSafeImportsSmoke.mjs - no Node builtin is statically reachable from src/.
//
// A literal `import('zlib')` is a hard "cannot resolve" error in esbuild and webpack 5 browser builds even when the
// browser never reaches it, and a warning-plus-stub in Vite and rollup. Node-only code must reach its builtin through
// src/core/nodeBuiltin.js, which computes the specifier. This scans every shipped module for a literal builtin specifier
// and exercises the three decompress paths: DecompressionStream, process.getBuiltinModule, and the computed import
// (the Node 18 path); with no capability at all it must throw a message that names what is missing.
//
// GL-free.

import { builtinModules } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const names = new Set(builtinModules.flatMap((m) => [m, 'node:' + m]));
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(SRC);

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
let scanned = 0;
for (const f of files) {
  scanned++;
  const text = readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  for (const m of text.matchAll(SPEC)) {
    if (names.has(m[2]))
      fail(
        `${path.relative(SRC, f)}: literal Node builtin specifier '${m[2]}' (use core/nodeBuiltin.js)`,
      );
  }
}
ok(`scanned ${scanned} modules for literal Node builtin specifiers`);

const { gunzipBytes } = await import('../src/core/gzip.js');
const { nodeZlib } = await import('../src/core/nodeBuiltin.js');
const payload = Buffer.from('mantle '.repeat(200));
const gz = new Uint8Array(zlib.gzipSync(payload));
const same = (a, label) =>
  Buffer.compare(Buffer.from(a), payload) === 0 ? ok(label) : fail(label + ': wrong bytes');

same(await gunzipBytes(gz), 'gunzip via DecompressionStream');

const realDS = globalThis.DecompressionStream;
const proc = globalThis.process;
const realGet = proc.getBuiltinModule;
try {
  globalThis.DecompressionStream = undefined;
  same(await gunzipBytes(gz), 'gunzip via process.getBuiltinModule (no DecompressionStream)');

  proc.getBuiltinModule = undefined;
  same(await gunzipBytes(gz), 'gunzip via the computed dynamic import (Node 18 path)');

  const zl = await nodeZlib('test');
  typeof zl.gunzipSync === 'function'
    ? ok('computed import yields zlib')
    : fail('computed import yields no zlib');

  Object.defineProperty(globalThis, 'process', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    await gunzipBytes(gz);
    fail('no capability: expected a throw');
  } catch (e) {
    /DecompressionStream/.test(e.message) && /gzip/.test(e.message)
      ? ok('no capability throws a named message: ' + e.message.slice(0, 70))
      : fail('unhelpful error: ' + e.message);
  }
} finally {
  Object.defineProperty(globalThis, 'process', { value: proc, configurable: true, writable: true });
  proc.getBuiltinModule = realGet;
  globalThis.DecompressionStream = realDS;
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('browserSafeImportsSmoke: PASS');
