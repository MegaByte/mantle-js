// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchKernelPresenceSmoke — a CPatch program compiles only the kernels its bundle can reach.
//
// Two presence questions must be answered for CPatch, because an unanswered question keeps the kernel:
//
//   1. THE LOOP-BLINN CHAIN KERNELS. fillPass drops cubicChainBoxCov (MANTLE_LB_NO_CUBIC_CHAIN) when no drawn mesh packed a
//      cubic chain face; a CPatch mesh that carried no flag would read "unknown" and every CPatch program would compile
//      it, though a CPatch vertex returns cpatchCoverage() before any Loop-Blinn kind is looked at. A CPatch mesh (and a
//      recognized SDF primitive's) answers: none.
//   2. THE SEAM COMPANION. Its branch runs only for a seam whose kind word carries CP_COMP, and the companion is
//      off by default -- but cpOutlineBound inlines a second whole arc-distance solver, cubic and conic chains with
//      their root arrays, into the composition loop. So it is under MANTLE_CPATCH_COMP, which the renderer defines
//      only for a bundle whose packs wrote a companion.
//
// On a text bundle's bound key the CPatch program goes 8,828 -> 4,335 optimized SPIR-V instructions, 90 -> 36 loops and
// 25 -> 11 function-scope arrays (spirv-opt -O). Both are output-identical: the companion-free program is bitwise the
// program with the companion's code on every fragment of a default pack (pinned here on a small shape; it holds on tiger
// at 512 px, 817,258 fragments, too).
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

// A curved blob and a stem that the converter cuts: seams, and outline running along them for the companion to find.
const SVG =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M20 100 C20 20 180 20 180 100 C180 150 120 160 110 120 L104 190 L96 190 L90 120 C80 160 20 150 20 100 Z"/>' +
  '</svg>';
async function build(comp) {
  // Companions are a property of retained seam patches.
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_AREA = 1;
  if (comp) {
    globalThis.__MANTLE_DEBUG__ = true;
    globalThis.__CP_COMP_ON = 1;
  }
  try {
    const sec = await importSvg(SVG, { preserveViewport: true });
    const b = CB.headlessCPatchBundle(sec);
    const gl = glStub();
    CB.buildCPatchBundle(gl, b, { pool: false });
    Object.assign(b, {
      numFillShapes: b.numShapes,
      segTypeMask: 0xf,
      drawList: [{ kind: 'shape', shapeIdx: 0 }],
      _geomGen: comp ? 2 : 1,
      _lbAdoptKey: 0,
      _fillMeshOwner: 'cpatch',
    });
    return { b, plane: gl.plane };
  } finally {
    delete globalThis.__CP_NO_AREA;
    delete globalThis.__CP_COMP_ON;
    delete globalThis.__MANTLE_DEBUG__;
  }
}

console.log('\n  a default CPatch bundle:');
const A = await build(false);
const meshes = (A.b._lbMeshes || []).filter((m) => m && m.cpatch);
ok(meshes.length > 0, `the shape packs as CPatch (${meshes.length} mesh)`);
ok(
  meshes.every((m) => m.hasCubicChain === false),
  'every CPatch mesh answers: no Loop-Blinn chain face',
);
ok(
  meshes.every((m) => !m.comp),
  'and no seam packed a companion',
);
{
  const d = definesFor(A.b);
  ok(
    d.has('MANTLE_CPATCH') && d.has('MANTLE_LB_FILL'),
    'it binds the CPatch kernel on the unified route',
  );
  ok(d.has('MANTLE_LB_NO_CUBIC_CHAIN'), 'with the Loop-Blinn cubic chain kernel compiled out');
  ok(!d.has('MANTLE_CPATCH_COMP'), "and without the companion's code");
}

console.log('\n  a bundle whose seams pack their companions (__CP_COMP_ON):');
const B = await build(true);
const compWords = (() => {
  let n = 0;
  if (B.plane)
    for (let k = 3; k < B.plane.length; k += 28) {
      const w = B.plane[k] % 4096;
      if (w > CPK_COMP - 0.5 && w < 4 * CPK_COMP) n++;
    }
  return n;
})();
ok(compWords > 0, `seams carry the companion bit in their kind word (${compWords})`);
ok(
  (B.b._lbMeshes || []).some((m) => m && m.cpatch && m.comp),
  'the mesh says so',
);
ok(definesFor(B.b).has('MANTLE_CPATCH_COMP'), "and its program compiles the companion's code");

console.log('\n  the companion-free program is the same program on a default pack:');
{
  const E = await import('./_glslEmu.mjs');
  if (!E.hasCxx()) ok(true, 'no C++ compiler: the twin half is skipped');
  else {
    const ROOT = new URL('..', import.meta.url).pathname;
    const glsl = readFileSync(
      new URL('../src/shaders/generated/mantle.frag.glsl', import.meta.url),
      'utf8',
    );
    const qs = [];
    for (const m of meshes) {
      const v = m.verts,
        S = LB_STRIDE;
      for (let tri = 0; (tri + 1) * 3 * S <= v.length; tri++) {
        const f = v.subarray((tri * 3 + 2) * S, (tri * 3 + 3) * S),
          O = [f[17], f[18]];
        const c = [0, 1, 2].map((k) => [
          v[(tri * 3 + k) * S] + v[(tri * 3 + k) * S + 17],
          v[(tri * 3 + k) * S + 1] + v[(tri * 3 + k) * S + 18],
        ]);
        for (let a = 0; a <= 6; a++)
          for (let bb = 0; a + bb <= 6; bb++) {
            const u = a / 6,
              w = bb / 6,
              x = c[0][0] + u * (c[1][0] - c[0][0]) + w * (c[2][0] - c[0][0]),
              y = c[0][1] + u * (c[1][1] - c[0][1]) + w * (c[2][1] - c[0][1]);
            for (const epp of [0.05, 0.6, 4])
              qs.push({
                k: E.K_CPATCH_COV,
                GD: [f[7], f[8], f[9], f[10]],
                bb: [f[11], f[12], f[13], f[14]],
                c: [x - O[0], y - O[1]],
                ePx: [f[19], f[20]],
                ex: [0, 0, 1000, f[15], f[16], epp],
              });
          }
      }
    }
    const on = E.buildGlslEmu(ROOT, { cpatch: true, glsl }).run(new Float32Array(4), A.plane, qs);
    const off = E.buildGlslEmu(ROOT, { cpatch: true, glsl, cpatchComp: false }).run(
      new Float32Array(4),
      A.plane,
      qs,
    );
    const ua = new Uint32Array(on.buffer, on.byteOffset, on.length),
      ub = new Uint32Array(off.buffer, off.byteOffset, off.length);
    let differ = 0;
    for (let k = 0; k < ua.length; k++) if (ua[k] !== ub[k]) differ++;
    ok(
      qs.length > 1000 && differ === 0,
      `bitwise identical on ${qs.length} fragments (${differ} differ)`,
    );
  }
}

console.log(
  fail ? `\ncpatchKernelPresenceSmoke FAIL (${fail})` : '\ncpatchKernelPresenceSmoke PASS',
);
process.exit(fail ? 1 : 0);
