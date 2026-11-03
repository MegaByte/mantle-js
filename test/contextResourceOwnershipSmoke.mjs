// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Resource ownership bookkeeping; no shader, geometry or GPU-state model.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  resourceGeneration,
  resourceScope,
  trackGlResource,
  deleteGlResource,
} from '../src/renderer/contextResources.js';
function owner() {
  const canvas = new EventTarget(),
    calls = [];
  const gl = { canvas, deleteBuffer: (resource) => calls.push(resource) };
  return { gl, calls, lose: () => canvas.dispatchEvent(new Event('webglcontextlost')) };
}
const a = owner(),
  b = owner();
const firstScope = resourceScope(a.gl),
  firstGeneration = resourceGeneration(a.gl);
const first = {},
  untracked = {};
assert.equal(trackGlResource(a.gl, first), first);
assert.equal(trackGlResource(a.gl, null), null);
assert.equal(resourceScope(a.gl), firstScope);
deleteGlResource(a.gl, 'Buffer', first);
assert.deepEqual(a.calls, [first], 'Unused live allocations must be deleted');
a.lose();
assert.equal(resourceGeneration(a.gl), firstGeneration + 1);
assert.notEqual(resourceScope(a.gl), firstScope);
assert.equal(resourceGeneration(b.gl), 0, 'Other contexts are independent');
deleteGlResource(a.gl, 'Buffer', first);
assert.equal(a.calls.length, 1, 'Stale allocations must not reach native deletion');
const second = trackGlResource(a.gl, {});
deleteGlResource(a.gl, 'Buffer', second);
assert.deepEqual(a.calls, [first, second]);
deleteGlResource(a.gl, 'Buffer', untracked);
assert.equal(a.calls.at(-1), untracked, 'External resources retain native deletion behavior');
deleteGlResource(b.gl, 'Buffer', second);
assert.deepEqual(b.calls, [second], 'Wrong-context live deletes retain native validation');
a.lose();
deleteGlResource(a.gl, 'Buffer', second);
assert.equal(a.calls.length, 3, 'A second loss invalidates the second generation');
const third = trackGlResource(a.gl, {});
deleteGlResource(a.gl, 'Buffer', third);
assert.equal(a.calls.at(-1), third);
console.log(
  'contextResourceOwnershipSmoke PASS: allocation identity, generation changes, unused allocations, sharing scopes and native forwarding',
);

// Every internal allocation needs a generation stamp, including failure paths.
// Parse JS calls so shader strings and comments cannot satisfy this invariant.
const { default: ts } = await import('typescript');
const fs = await import('node:fs'),
  path = await import('node:path');
const root = new URL('../src/', import.meta.url),
  missing = [];
let allocations = 0;
const nativeCreates = new Set([
  'createBuffer',
  'createTexture',
  'createProgram',
  'createShader',
  'createVertexArray',
  'createFramebuffer',
  'createRenderbuffer',
  'createQuery',
  'createSampler',
  'createTransformFeedback',
  'fenceSync',
]);
const nativeDeletes = new Set(
  [...nativeCreates].map((name) => 'delete' + (name === 'fenceSync' ? 'Sync' : name.slice(6))),
);
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(file);
      continue;
    }
    if (!file.endsWith('.js')) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text,
          receiver = node.expression.expression.getText(source);
        if (receiver === 'gl' || receiver === 'R.gl') {
          if (nativeCreates.has(method)) {
            allocations++;
            const parent = node.parent;
            if (
              !ts.isCallExpression(parent) ||
              parent.expression.getText(source) !== 'trackGlResource' ||
              parent.arguments[1] !== node ||
              parent.arguments[0].getText(source) !== receiver
            )
              missing.push(
                file + ':' + source.getLineAndCharacterOfPosition(node.pos).line + ' ' + method,
              );
          } else if (nativeDeletes.has(method)) missing.push(file + ': direct ' + method);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
scan(fileURLToPath(root));
assert(allocations > 0);
assert.deepEqual(missing, [], 'Native allocations/deletes bypass generation ownership');
console.log('contextResourceOwnershipSmoke allocation audit PASS:', allocations, 'creation sites');
