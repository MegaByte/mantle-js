// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterCleanupSmoke — the filter/paint shader cleanups (c) onward, each held to the
// before-text on the CPU in float32 (test/_fragEmu.mjs; cases in _filtperfCases.mjs):
//   (c) the box blur decides its pair/single split once instead of re-testing it every iteration;
//   (d) feMorphology picks its loop by operator instead of branching inside a loop of up to 64 steps;
//   (e) feLighting does not fetch the center tap neither kernel weights (9 -> 8 fetches) -- and the
//       handler uploads the importer's light vectors (checked on a recording GL);
//   (f) feDisplacementMap picks channels by a one-hot dot product; feImage's aspect and atlas maps are
//       composed on the CPU (moves float rounding: within 1 LSB); feTile loses its dead negative-fract
//       fixups; the Porter-Duff dispatch becomes coefficient uniforms (feComposite, PaintComposite);
//       sampleStops stops re-testing a zero stop count -- and, on the recording fake GL with the real
//       renderer, every feComposite draw gets its weights (a caller that missed them would CLEAR).
// Each case must meet its own tolerance (bit-identical unless the case says otherwise) and make no
// more texture fetches than its before-text. The GPU twin is filterPassParityRenderSmoke; the render lane's
// users of each pass (blurLargeSigmaSmoke for the box blur, filterVisualSmoke for morphology) check the whole route.
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, emulateCase, meetsTol } from './_fragEmu.mjs';
import { filtperfCases } from './_filtperfCases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasCxx()) {
  console.log('SKIP: no C++ compiler for the shader emulator');
  process.exit(0);
}

const ITEMS = ['boxBlur', 'morphology', 'lighting', 'compositing'];
for (const c of filtperfCases(ITEMS)) {
  let r;
  try {
    r = emulateCase(ROOT, c);
  } catch (e) {
    ok(false, `${c.item} ${c.name}: ${String(e.message).split('\n')[0]}`);
    continue;
  }
  const w = r.work,
    fetches = (s) => s.texture + s.texelFetch;
  const exact = c.tol === 0;
  ok(
    (exact ? r.bits === 0 : meetsTol(c, r)) && fetches(w.new) <= fetches(w.old),
    `${c.item} ${c.name}: ${exact ? `bit-identical (${r.bits} float bits differ)` : `${r.ch8} channels apart at 8 bits (max ${r.mx})`}, ` +
      `fetches per pixel ${+fetches(w.old).toFixed(3)} -> ${+fetches(w.new).toFixed(3)}` +
      (r.off ? ` -- ${JSON.stringify(r.off)}` : ''),
  );
}

// (e) THE HANDLER AND THE SHADER on the light vectors: the handler uploads the importer's direction or
// position and pointsAt as they are (no CPU-side vectors: they tie on the GPU and add plumbing), and a
// spot light aimed at itself lights nothing rather than making the pass NaN.
{
  const { feLightingDispatch } = await import('../src/filterGraph/primitives/lighting.js');
  const run = (params) => {
    const u = new Map();
    const noop = () => {};
    const gl = new Proxy(
      {},
      {
        get: (_t, k) =>
          typeof k === 'string' && k.startsWith('uniform')
            ? (l, ...v) => u.set(l, v.length === 1 ? v[0] : v)
            : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)
              ? 0
              : noop,
      },
    );
    const U = new Proxy({}, { get: (_t, k) => k });
    feLightingDispatch(
      { type: 'feSpecularLighting', params },
      [{ kind: 'rt', idx: 0 }],
      { fbo: {}, size: [16, 16] },
      {
        gl,
        pool: { get: () => ({ tex: {}, fbo: {}, size: [16, 16] }) },
        feLightingProg: {},
        feLightingU: U,
        coverVao: {},
      },
    );
    return u;
  };
  const same = (a, b) => a && a.every((v, i) => v === b[i]);
  const s2 = run({ lightType: 2, lightPos: [10, 10, 50], spotAt: [10, 40, 10] });
  // the pass is in GL space (y up); a bare context (no lightToGL, ctx.h 0) maps SVG y down to 0 - y.
  ok(
    same(s2.get('uLightPos'), [10, -10, 50]) && same(s2.get('uSpotAt'), [10, -40, 10]),
    `feLighting uploads uLightPos ${JSON.stringify(s2.get('uLightPos'))} and uSpotAt ${JSON.stringify(s2.get('uSpotAt'))} with y taken to GL space`,
  );
  const { buildFragEmu, generatedShader } = await import('./_fragEmu.mjs');
  const emu = buildFragEmu(generatedShader(ROOT, 'feLighting.frag.glsl'));
  const z = run({
    lightType: 2,
    lightPos: [5, 5, 5],
    spotAt: [5, 5, 5],
    surfaceScale: 1,
    specularConstant: 1,
    specularExponent: 1,
    lightColor: [1, 1, 1, 1],
  });
  const uniforms = {};
  for (const [k, v] of z) if (emu.uniforms.includes(k)) uniforms[k] = v;
  uniforms.uInMap = [1, 1, 0, 0];
  uniforms.uOutRect = [0, 0, 8, 8];
  const flat = { w: 8, h: 8, linear: false, data: new Float32Array(8 * 8 * 4).fill(1) };
  const o = Array.from(
    emu.run({ uniforms, textures: { uIn: flat }, frags: [{ vUV: [0.5, 0.5] }] }).slice(0, 4),
  );
  ok(
    o.every((v) => v === 0),
    `a spot aimed at itself lights nothing, not NaN: (${o.join(', ')})`,
  );
}

// (f) THE DATAFLOW: the real renderer on the recording fake GL, both routes -- every feComposite draw
// (a graph's feComposite, an feMerge, the drop-shadow recipe) carries its Porter-Duff weights.
{
  const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
  const { porterDuffCoefficients, feCompositeMode } =
    await import('../src/filterGraph/porterDuff.js');
  const N = 96;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}"><defs>` +
    '<filter id="ds"><feGaussianBlur in="SourceAlpha" stdDeviation="3"/><feOffset dx="3" dy="3" result="o"/>' +
    '<feFlood flood-color="#000" flood-opacity="0.5"/><feComposite in2="o" operator="in" result="s"/>' +
    '<feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    '<filter id="xo"><feMorphology operator="dilate" radius="2" result="d"/><feComposite in="d" in2="SourceGraphic" operator="xor"/></filter>' +
    `</defs><circle cx="30" cy="30" r="18" fill="#c33" filter="url(#ds)"/><rect x="50" y="50" width="30" height="30" fill="#36c" filter="url(#xo)"/></svg>`;
  const want = new Set(
    ['in', 'xor', 'over'].map((o) =>
      porterDuffCoefficients(
        feCompositeMode(['over', 'in', 'out', 'atop', 'xor'].indexOf(o)),
      ).join(),
    ),
  );
  for (const route of ['none', 'lb']) {
    const F = createFakeGl({ width: N, height: N });
    const R = createRenderer(F.gl, taggedShaderSources(), {});
    R.setFillEngine({ route, kernel: 'slug' });
    const b = createBundle(F.gl, await importSvg(svg, { preserveViewport: true }));
    if (R.prepareBundle) R.prepareBundle(b);
    if (R.awaitLbReady) {
      try {
        await R.awaitLbReady(b, 20000);
      } catch {
        /* counts report it */
      }
    }
    R.prewarmBundle(b);
    R.precompileFills();
    R.setViewport(N, N);
    for (let i = 0; i < 2; i++) {
      F.setFrame(i);
      R.beginFrame([0, 0, 0, 0]);
      R.drawBundle(b, { worldMatrix: [1, 0, 0, 0, 1, 0, 0.01 * i, 0, 1] });
      R.endFrame();
    }
    const draws = F.log.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('feCompositeFrag'));
    const seen = new Set(draws.map((e) => (e.uni.uPD || []).join()));
    const missing = draws.filter((e) => !e.uni.uPD || e.uni.uPD.length !== 4).length;
    ok(
      draws.length > 0 && !missing && [...want].every((k) => seen.has(k)),
      `route ${route}: ${draws.length} feComposite draws, each with Porter-Duff weights (${missing} without); ` +
        `weights seen: ${[...seen].map((k) => '(' + k + ')').join(' ')}`,
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
