// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rendererUnknownOptionSmoke — createRenderer warns once per option key it never reads.
// A typo'd key (`aacFil: true`) must not pass silently while the renderer runs with the default. Checked on the real renderer over
// test/_fakeGl.mjs (no GPU):
//   (a) a typo warns, names the key and suggests the nearest known key;
//   (b) a key far from every known one warns without a suggestion;
//   (c) every known key is silent, including the hooks;
//   (d) the same key does not warn twice.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { setDiagnostics } from '../src/core/diagnostics.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const { createRenderer } = await import('../src/index.js');
const warns = [];
setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
const make = (opts) => {
  warns.length = 0;
  const F = createFakeGl({ width: 64, height: 64 });
  createRenderer(F.gl, taggedShaderSources(), opts);
  return warns.slice();
};

let w = make({ aacFil: true });
ok(
  w.length === 1 && w[0].includes('"aacFil"') && w[0].includes('did you mean "aacFill"'),
  '(a) typo warns with the nearest key: ' + (w[0] || 'none'),
);
w = make({ zzzQqqXxx: 1 });
ok(
  w.length === 1 && w[0].includes('"zzzQqqXxx"') && !w[0].includes('did you mean'),
  '(b) far key warns without a suggestion',
);
w = make({
  aacFill: true,
  psoWarmIdle: null,
  onContextLost() {},
  onContextRestored() {},
  captureFrames: false,
  filterCacheBytes: 1 << 20,
  groupFilterCache: true,
});
ok(w.length === 0, '(c) known keys are silent');
w = make({ aacFil: true });
ok(w.length === 0, '(d) the same key warns once');
setDiagnostics({ onWarn: null });
process.exit(fail ? 1 : 0);
