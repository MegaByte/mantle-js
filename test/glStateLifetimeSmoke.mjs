// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Context state shares native-call suppression without retaining renderer owners.
// This checks production object lifetime and dispatch; it does not model a GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!global.gc) {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status ?? 1);
}
const { attachGlState } = await import(
  process.env.MANTLE_GL_STATE_MODULE || '../src/renderer/glState.js'
);
const enabled = new Set();
let nativeEnables = 0,
  firstAudits = 0,
  secondAudits = 0;
const gl = {
  BLEND: 3042,
  DEPTH_TEST: 2929,
  STENCIL_TEST: 2960,
  SCISSOR_TEST: 3089,
  CULL_FACE: 2884,
  enable(cap) {
    nativeEnables++;
    enabled.add(cap);
  },
  disable(cap) {
    enabled.delete(cap);
  },
  isEnabled: (cap) => enabled.has(cap),
};
const second = { gl, mantleWarn() {} };
let owner, control;
(() => {
  const first = { gl, mantleWarn() {}, payload: new Uint8Array(1048576) },
    unattached = { gl };
  attachGlState(first);
  attachGlState(second);
  first._glStateExtraAudit = () => {
    firstAudits++;
    return [];
  };
  second._glStateExtraAudit = () => {
    secondAudits++;
    return [];
  };
  first.glEnable(gl.BLEND);
  second.glEnable(gl.BLEND);
  assert.equal(nativeEnables, 1, 'renderers on one context share the state shadow');
  first.glAuditState();
  second.glAuditState();
  assert.deepEqual(
    [firstAudits, secondAudits],
    [1, 1],
    'each renderer invokes its own extra audit hook',
  );
  owner = new WeakRef(first);
  control = new WeakRef(unattached);
})();
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 0));
  global.gc();
}
assert.equal(control.deref(), undefined, 'the collection control must be eligible');
assert.equal(
  owner.deref(),
  undefined,
  'a live context and peer renderer must not retain the first owner',
);
second.glDisable(gl.BLEND);
second.glEnable(gl.BLEND);
assert.equal(nativeEnables, 2, 'shared state still works after the first owner is collected');
console.log('glState lifetime and per-renderer audit PASS');
