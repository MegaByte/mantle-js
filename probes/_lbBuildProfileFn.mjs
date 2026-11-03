// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Session } from 'inspector';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(ROOT + '/examples/tiger.svg', 'utf8');
const bundle = await importSvg(svg);
// bundle.meta carries a 32-BYTE HEADER; wrapping it whole shifts every meta row by 8 floats and sends most
// shapes down the CDT partition, so a build measured that way is 20x the real one. Strip it, as the tests do.
const input = {
  curveFloats: new Float32Array(bundle.curves),
  metaFloats: bundle.meta ? new Float32Array(bundle.meta, 32) : null,
  metaFloatsPerShape: bundle.metaFloatsPerShape,
  ranges: bundle.curveRangesByShape,
  numShapes: bundle.numShapes,
};
const session = new Session();
session.connect();
const post = (m, p) =>
  new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 80 });
await post('Profiler.start');
buildLbBundle(input);
const { profile } = await post('Profiler.stop');
session.disconnect();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const total = profile.samples.length;
for (const s of profile.samples) {
  const n = byId.get(s);
  if (!n) continue;
  const cf = n.callFrame;
  const file = (cf.url || '(native)').split('/').pop();
  const fn = cf.functionName || '(anon)';
  if (file === '(native)' || file === '' || /node:|inspector/.test(cf.url || '')) continue;
  const k = file + ' :: ' + fn + ' :' + (cf.lineNumber + 1);
  self.set(k, (self.get(k) || 0) + 1);
}
console.log('top self-time functions (tiger cold build):');
for (const [k, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22))
  console.log('  ' + (((c / total) * 100).toFixed(1) + '%').padStart(6) + '  ' + k);
