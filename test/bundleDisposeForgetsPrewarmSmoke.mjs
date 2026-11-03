// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleDisposeForgetsPrewarmSmoke — a disposed bundle must not stay alive in the per-context prewarm backlog.
//
// createBundle enqueues every bundle on a per-context BACKLOG (what a renderer created later starts from) and on each
// renderer's own queue. Both are strong references, so dispose() must take the bundle out of both lists, not leave it for
// a doubling prune (64 bundles, then twice the survivors): otherwise every disposed bundle's CPU planes -- curve and band
// floats, cover-quad floats, Loop-Blinn meshes, a morph's merged planes -- stay on the heap (all of a six-pair morph
// scene's ~527 MB, after disposing the whole scene).
import { readFileSync } from 'fs';
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const B = await import('../src/renderer/bundle.js');
const SVG =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';
const sections = await importSvg(SVG, { preserveViewport: true });
const makeGl = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );

const gl = makeGl();
const live = B.createBundle(gl, sections),
  dead = B.createBundle(gl, sections);
// What a renderer would be handed: drain a consumer's queue.
const handed = (c) => {
  const got = [];
  for (let b; (b = B.takeFillPrewarm(c));) got.push(b);
  return got;
};
const c1 = B.addFillPrewarmConsumer(gl),
  c2 = B.addFillPrewarmConsumer(gl); // both seeded from the backlog
dead._disposed = false;
dead.dispose();
ok(dead.curveFloats64 === null, 'dispose releases the retained authored curve plane');
const h1 = handed(c1);
ok(
  h1.includes(live) && !h1.includes(dead),
  "dispose() drops the bundle from a renderer's own queue and keeps the live one",
);
// _disposed alone would also hide it from takeFillPrewarm, so look at the lists: a consumer registered AFTER the dispose is seeded from the backlog.
const c3 = B.addFillPrewarmConsumer(gl);
ok(
  c3.q.length === 1 && c3.q[0].deref() === live,
  `and from the per-context backlog a later renderer starts from (${c3.q.length} entry)`,
);
ok(
  c2.q.length === 1 && c2.q[0].deref() === live,
  '...and from the queue of a renderer that has not drained yet',
);
dead.dispose();
ok(true, 'dispose() twice is harmless');
// An undisposed bundle nobody references is not kept alive by the lists (a WeakRef, not the object).
ok(typeof c3.q[0].deref === 'function', 'the queues hold weak references');
B.removeFillPrewarmConsumer(c1);
B.removeFillPrewarmConsumer(c2);
B.removeFillPrewarmConsumer(c3);
process.exit(fail ? 1 : 0);
