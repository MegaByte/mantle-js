// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleHandleMorphSmoke — a bundle handle takes a morph the way drawBundle does.
//
// drawBundle unwraps an animation handle to its bundle ("consumers never have to manually unwrap"),
// and a mount is documented as taking drawBundle's options. createBundleHandle must unwrap too: handed
// the morph itself, a handle that wraps it as is holds an object with no geometry, and the first
// handle.draw() throws a TypeError inside render(). probes/apiGaps/morphFadeInk.mjs shows the handle
// drawing the morph's frames byte for byte at every t.
//
// Runs the real createRenderer on test/_fakeGl.mjs, which records every draw and its target.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer, createShapeMorph } =
  await import('../src/index.js');

const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const bar = (id, x, fill) =>
  `<rect id="${id}" x="${x}" y="10" width="20" height="80" fill="${fill}"/>`;
const F = createFakeGl({ width: 128, height: 128 });
const R = createRenderer(F.gl, taggedShaderSources(), {});
if (R.ready) await R.ready;
R.setViewport(128, 128);
const m = createShapeMorph(
  F.gl,
  createBundle(F.gl, await importSvg(doc(bar('a', 5, '#123') + bar('s', 70, '#812')))),
  createBundle(F.gl, await importSvg(doc(bar('a', 5, '#123') + bar('d', 40, '#162')))),
);
m.setT(0.5);

let h = null,
  threw = null;
try {
  h = R.createBundleHandle(m);
} catch (e) {
  threw = e;
}
ok(
  !threw && h,
  `createBundleHandle(morph) returns a handle${threw ? ' — threw ' + threw.message : ''}`,
);
if (h) {
  ok(h.bundle === m.bundle, "the handle wraps the morph's bundle, as drawBundle unwraps it");
  let drawErr = null;
  try {
    R.beginFrame([1, 1, 1, 1]);
    h.draw({});
    R.endFrame();
  } catch (e) {
    drawErr = e;
  }
  ok(
    !drawErr,
    `handle.draw() on a morph handle draws${drawErr ? ' — threw ' + drawErr.message : ''}`,
  );
}
// A plain bundle is untouched by the unwrap.
const b = createBundle(F.gl, await importSvg(doc(bar('p', 10, '#333'))));
const hb = R.createBundleHandle(b);
ok(hb.bundle === b, 'a plain bundle is wrapped as itself');

console.log(fail ? `\nBUNDLE-HANDLE-MORPH FAIL (${fail})` : '\nBUNDLE-HANDLE-MORPH PASS');
process.exit(fail ? 1 : 0);
