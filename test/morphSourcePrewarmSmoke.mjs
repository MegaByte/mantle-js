// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphSourcePrewarmSmoke -- a morph's SOURCE poses are not prewarmed unless `warmMorphSources` is set.
//
// createShapeMorph(gl, a, b) takes two bundles that the app never draws; prewarming them would compile their fill variants, draw them
// once (building and uploading a Loop-Blinn stream and coefficient texture for each: tens of MB on a six-pair scene) and start their
// worker meshes. So createShapeMorph marks both poses and the automatic queue skips them; `warmMorphSources: true` prewarms them for an
// app that draws a pose directly (whose first draw without it costs a few ms). createSpriteMorph does not mark: its poses are usually a sheet that is drawn on its own.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const { attachFillPass } = await import('../src/renderer/fillPass.js');

const SVG =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';
const sections = await importSvg(SVG, { preserveViewport: true });

const makeGl = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );

// A renderer just complete enough for attachFillPass + fillWarmTick. R.program is the observable:
// prewarmFillVariant compiles each bundle's lean variant through it, tagged 'fill:prewarm:<key>',
// so the tag list says which renderer was actually handed which bundle.
function makeRenderer(gl, opts = {}) {
  const warmed = [];
  const R = {
    gl,
    opts,
    draw: {},
    _lbFillMode: 'auto',
    _warmed: warmed,
    viewportSize: [0, 0],
    arScale: 1,
    dummyDashTex: null,
    dummyGradientTex: null,
    dummyGradientStops: null,
    IDENTITY_COLOR_MATRIX: new Float32Array(16),
    ZERO_OFFSET: new Float32Array(4),
    fillProg: {},
    shaderSources: { fillVert: '', fillFrag: '' },
    withDefines: (s) => s,
    program: (_v, _f, tag) => {
      warmed.push(tag);
      return {};
    },
    glEnable: () => {},
    glDisable: () => {},
    bindFb: () => {},
    glBindVertexArray: () => {},
    glViewport: () => {},
    glBlendFunc: () => {},
    mantleError: () => {},
    mantleWarn: () => {},
  };
  attachFillPass(R);
  warmed.length = 0; // ignore whatever attach itself compiled
  return R;
}
const prewarms = (R) => R._warmed.filter((t) => t && t.startsWith('fill:prewarm:')).length;

{
  const gl = makeGl();
  const R = makeRenderer(gl); // default options
  const src = B.createBundle(gl, sections),
    plain = B.createBundle(gl, sections);
  src._morphSourcePose = true;
  R.fillWarmTick();
  const n = prewarms(R);
  ok(n > 0, `the unmarked bundle is still warmed (${n} prewarm compile(s))`);
}
{
  const gl = makeGl();
  const R = makeRenderer(gl);
  const a = B.createBundle(gl, sections),
    b = B.createBundle(gl, sections);
  a._morphSourcePose = true;
  b._morphSourcePose = true;
  for (let i = 0; i < 4; i++) R.fillWarmTick();
  ok(prewarms(R) === 0, 'two marked source poses alone: nothing is prewarmed');
  ok(R.precompileFills() === 0 && prewarms(R) === 0, 'precompileFills() does not warm them either');
}
{
  const gl = makeGl();
  const R = makeRenderer(gl, { warmMorphSources: true });
  const a = B.createBundle(gl, sections);
  a._morphSourcePose = true;
  for (let i = 0; i < 4; i++) R.fillWarmTick();
  ok(prewarms(R) > 0, 'warmMorphSources: true prewarms a marked pose');
}
{
  // the marking itself: createShapeMorph marks both poses, createSpriteMorph does not
  const { createFakeGl } = await import('./_fakeGl.mjs');
  const { createShapeMorph, createSpriteMorph } = await import('../src/animation/shapeMorph.js');
  const { gl } = createFakeGl();
  const mk = async (svg) => B.createBundle(gl, await importSvg(svg));
  const A =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M10 10 L60 10 L60 60 Z" fill="#f00"/></svg>';
  const C =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M20 20 L80 20 L80 80 Z" fill="#00f"/></svg>';
  const a = await mk(A),
    b = await mk(C);
  ok(!a._morphSourcePose && !b._morphSourcePose, 'a fresh bundle is not marked');
  createShapeMorph(gl, a, b);
  ok(
    a._morphSourcePose === true && b._morphSourcePose === true,
    'createShapeMorph marks both poses',
  );
  const sheet = await mk(
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g id="p"><path d="M10 10 L60 10 L60 60 Z" fill="#f00"/></g><g id="q"><path d="M20 20 L80 20 L80 80 Z" fill="#00f"/></g></svg>',
  );
  createSpriteMorph(gl, { bundle: sheet, sprite: 'p' }, { bundle: sheet, sprite: 'q' });
  ok(
    !sheet._morphSourcePose,
    'createSpriteMorph leaves its sheet unmarked (the sheet is drawn on its own)',
  );
}
if (fail) {
  console.log('\nMORPH-SOURCE-PREWARM FAIL');
  process.exit(1);
}
console.log('\nMORPH-SOURCE-PREWARM PASS');
