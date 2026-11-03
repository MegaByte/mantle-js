// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sceneUnionSmoke -- renderer.setSceneUnion(bundles): bundles that agree on their kernel class bind one program.
//   * undeclared: a solid bundle and a gradient bundle have different defines (the solid one omits the gradient block);
//   * declared: their defines are the same set, which carries the gradient block (the union's presence) and omits only what both omit;
//   * every define a member needed alone is still in the union, and nothing a member was missing a PRESENCE for is dropped;
//   * a bundle not declared is untouched; setSceneUnion(null) restores each bundle's own defines.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { createRenderer } from '../src/renderer/renderer.js';
import { createBundle } from '../src/renderer/bundle.js';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
import { mergeSceneDefines, classSig } from '../src/renderer/sceneUnion.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
// ---- the algebra ----
const LB = ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX'];
const A = [...LB, 'MANTLE_NO_GRADIENT', 'MANTLE_NO_CLIP', 'MANTLE_CPATCH', 'MANTLE_LB_NO_DISC']; // a solid CPatch bundle
const B = [...LB, 'MANTLE_NO_CLIP', 'MANTLE_LB_NO_CPATCH_X']; // an LB bundle with a gradient
const S = ['MANTLE_NO_GRADIENT', 'MANTLE_NO_CLIP']; // a Slug bundle (no LB_FILL)
const U = mergeSceneDefines(A, [B, S]);
ok(
  classSig(A) === classSig(B) && classSig(A) !== classSig(S),
  'LB bundles share a class; the Slug bundle is a different one',
);
ok(
  U.includes('MANTLE_CPATCH') && LB.every((d) => U.includes(d)),
  'presence is the union: the CPatch kernel and the LB stream defines are in',
);
ok(
  !U.includes('MANTLE_NO_GRADIENT') && U.includes('MANTLE_NO_CLIP'),
  'omission is the intersection: NO_GRADIENT is gone (B needs it), NO_CLIP stays (both omit it)',
);
ok(
  !U.includes('MANTLE_LB_NO_DISC') && !U.includes('MANTLE_LB_NO_CPATCH_X'),
  'an omission only one member made is dropped',
);
const H = [...LB, 'MANTLE_NO_CLIP', 'MANTLE_NO_FILTER'];
ok(
  mergeSceneDefines(A, [H]) === A && mergeSceneDefines(H, [A]) === H,
  'a union does not cross a HEAVY feature block (a bundle that omits the filter block never joins one that carries it)',
);
ok(mergeSceneDefines(S, [A, B]) === S, 'a bundle with no same-class partner keeps its own defines');
ok(mergeSceneDefines(A, []) === A, 'a lone bundle is unchanged');
// ---- through the renderer: declaring a scene never changes a bundle of another class ----
const { gl } = createFakeGl();
const R = createRenderer(gl, taggedShaderSources(), { cpatchFill: false, psoWarmIdle: () => true });
const solid = createBundle(
  gl,
  await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#c00" d="M10 10 L90 10 L90 90 L10 90 Z"/></svg>',
  ),
);
const grad = createBundle(
  gl,
  await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><circle cx="50" cy="50" r="40" fill="url(#g)"/></svg>',
  ),
);
const set = (b) => [...R._variantDefinesNow(b)].sort().join();
const s0 = set(solid),
  g0 = set(grad);
R.setSceneUnion([solid, grad]);
const s1 = set(solid),
  g1 = set(grad);
// in this GL-less renderer both draw the same (Slug) kernel class, so declared they must bind one program carrying the gradient block
ok(s1 === g1, 'declared: the solid and gradient bundles resolve to one define set (one program)');
ok(
  !s1.split(',').includes('MANTLE_NO_GRADIENT') && s0.split(',').includes('MANTLE_NO_GRADIENT'),
  'the union keeps the gradient block the solid bundle alone would have omitted',
);
ok(
  s1 === g0,
  "and it is the gradient bundle's own program: the solid bundle merely stopped omitting a block",
);
R.setSceneUnion(null);
ok(set(solid) === s0 && set(grad) === g0, "setSceneUnion(null) restores each bundle's own defines");
if (fail) {
  console.error(`FAIL sceneUnionSmoke: ${fail}`);
  process.exit(1);
}
console.log('sceneUnionSmoke PASS');
