// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchCubicAreaPresenceSmoke -- the native-cubic area integral and its 256-span loop bound are compiled only for a bundle whose
// certified area paints carry a cubic span. Presence is paid on every fragment of a quadratic-only draw.

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
const CB = await import('../src/renderer/cpatchBuild.js');
const { attachFillPass } = await import('../src/renderer/fillPass.js');
const { attachUnifiedFillDraw } = await import('../src/renderer/unifiedFillDraw.js');
const { LB_STRIDE, CPK_COMP } = await import('../src/renderer/cpatchPack.js');

const makeGl = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );
function makeRenderer() {
  const compiled = [];
  const R = {
    gl: makeGl(),
    opts: { aacFill: 'auto' },
    draw: {},
    _lbFillMode: 'auto',
    _compiled: compiled,
    viewportSize: [256, 256],
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
      compiled.push(tag);
      return {};
    },
    glEnable: () => {},
    glDisable: () => {},
    bindFb: () => {},
    glBindVertexArray: () => {},
    glViewport: () => {},
    glBlendFunc: () => {},
    glUseProgram: () => {},
    glDepthMask: () => {},
    glDepthFunc: () => {},
    mantleError: () => {},
    mantleWarn: () => {},
  };
  attachUnifiedFillDraw(R);
  attachFillPass(R);
  return R;
}
function definesFor(bundle) {
  const R = makeRenderer();
  R.prewarmFillVariant(bundle);
  const out = new Set();
  for (const t of R._compiled) {
    if (!t || !t.startsWith('fill:')) continue;
    for (const d of t.replace(/^fill:(prewarm:)?/, '').split('|')) if (d) out.add(d);
  }
  return out;
}
const glStub = () => {
  const g = { TEXTURE_2D: 1, RGBA32F: 2, RGBA: 3, FLOAT: 4, plane: null };
  g.texImage2D = (...a) => {
    g.plane = a[8];
  };
  g.bindTexture = g.texParameteri = g.texSubImage2D = g.deleteTexture = () => {};
  g.createTexture = () => ({});
  return g;
};

const quadBlob = 'M30 100Q30 30 100 30Q170 30 170 100Q170 170 100 170Q30 170 30 100Z';
// a cubic loop the certificate accepts (one complete area paint with native cubic spans) ...
const cubicLoop =
  'M20 100C20 20 180 20 180 100C180 150 120 160 110 120L104 190L96 190L90 120C80 160 20 150 20 100Z';
// ... and a cubic lens: two curves between the same two nodes, whose hulls touch at both nodes; the cycle certificate takes it as an
// area paint of four spans (each curve split at its midpoint). With the cycle area off, it takes the
// seam route and carries no area paint at all.
const cubicLens = 'M20 100C20 20 180 20 180 100C180 170 20 170 20 100Z';
async function bundleOf(d, extra = '') {
  const sec = await importSvg(
    `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="${d}"/>${extra}</svg>`,
    { preserveViewport: true },
  );
  const b = CB.headlessCPatchBundle(sec),
    gl = glStub();
  CB.buildCPatchBundle(gl, b, { pool: false });
  Object.assign(b, {
    numFillShapes: b.numShapes,
    segTypeMask: 0xf,
    drawList: Array.from({ length: b.numShapes }, (_, i) => ({ kind: 'shape', shapeIdx: i })),
    _geomGen: 1,
    _lbAdoptKey: 0,
    _fillMeshOwner: 'cpatch',
  });
  return b;
}
const cpMeshes = (b) => (b._lbMeshes || []).filter((m) => m && m.cpatch && m.vertexCount | 0);
const NO = 'MANTLE_CPATCH_NO_CUBIC_AREA';
{
  const b = await bundleOf(quadBlob);
  ok(
    cpMeshes(b).some((m) => m.hasQuadraticArea === true),
    'a quadratic loop packs as one complete area paint',
  );
  ok(
    cpMeshes(b).every((m) => m.hasCubicArea === false),
    'and says it carries no cubic span',
  );
  const d = definesFor(b);
  ok(d.has('MANTLE_CPATCH') && d.has(NO), 'its program compiles without the cubic integral');
}
{
  const b = await bundleOf(cubicLoop);
  ok(
    cpMeshes(b).some((m) => m.hasQuadraticArea === true && m.hasCubicArea === true),
    'a cubic loop packs as a complete area paint with cubic spans',
  );
  const d = definesFor(b);
  ok(
    d.has('MANTLE_CPATCH') && !d.has(NO) && !d.has('MANTLE_CPATCH_NO_QUADRATIC_AREA'),
    'its program keeps the cubic integral',
  );
}
{
  const b = await bundleOf(quadBlob, `<path fill="#00f" d="${cubicLoop}"/>`);
  ok(
    cpMeshes(b).some((m) => m.hasCubicArea === true) && !definesFor(b).has(NO),
    'one cubic area paint keeps the integral for the whole bundle',
  );
}
{
  const b = await bundleOf(cubicLens);
  ok(
    cpMeshes(b).some((m) => m.hasQuadraticArea === true && m.hasCubicArea === true),
    'a cubic lens packs as a complete area paint with cubic spans',
  );
}
{
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_CYCLE_AREA = 1;
  let b;
  try {
    b = await bundleOf(cubicLens);
  } finally {
    delete globalThis.__CP_NO_CYCLE_AREA;
    delete globalThis.__MANTLE_DEBUG__;
  }
  const d = definesFor(b);
  ok(
    cpMeshes(b).every((m) => m.hasQuadraticArea === false && m.hasCubicArea === false),
    'a seam-route cubic shape packs no area paint',
  );
  ok(
    d.has('MANTLE_CPATCH_NO_QUADRATIC_AREA') && !d.has(NO),
    'it drops the whole area walk, which subsumes the cubic define',
  );
}
{
  // an unanswered question keeps the helper: a mesh that does not say is treated as carrying one
  const b = await bundleOf(quadBlob);
  for (const m of cpMeshes(b)) delete m.hasCubicArea;
  b._geomGen = 2;
  ok(!definesFor(b).has(NO), 'a mesh that does not say keeps the cubic integral');
}
{
  const src = readFileSync(new URL('../src/shaders/_cpatchCoverage.glsl', import.meta.url), 'utf8');
  const i = src.indexOf('float cpConvexArea'),
    j = src.indexOf('return clamp(abs(area)', i);
  const seg = src.slice(src.lastIndexOf('#define CP_AREA_MAX_CURVES 64', i) - 80, j);
  ok(
    /defined\(MANTLE_CPATCH_NO_CUBIC_AREA\)/.test(seg) &&
      /MANTLE_CPATCH_NO_CUBIC_AREA/.test(src.slice(i, j)),
    'the shader gates both the record bound and the cubic branch on the define',
  );
}
console.log(
  fail
    ? '\ncpatchCubicAreaPresenceSmoke FAIL (' + fail + ')'
    : '\ncpatchCubicAreaPresenceSmoke PASS',
);
process.exit(fail ? 1 : 0);
