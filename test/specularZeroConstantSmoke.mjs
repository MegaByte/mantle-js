// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// specularZeroConstantSmoke — feSpecularLighting specularConstant="0": the SPEC answer by default,
// Chrome's under importSvg({ compat: 'chrome' }).
//
// Filter Effects' specular formula, S = ks * pow(N.H, specularExponent) * L and alpha = max(S), makes a
// constant of 0 a TRANSPARENT result, and that is the default. Chrome departs from it: Blink picks its
// lighting TYPE by `specular_constant_ > 0` (platform/graphics/filters/fe_lighting.cc,
// GetLightingType), and FESpecularLighting passes FELighting a diffuse constant of 0 -- so a specular
// primitive with a constant of 0, or a negative one it clamps to 0, renders as DIFFUSE lighting with
// kd 0: black at alpha 1. The render lane found it (zeroValuedAttributeRenderSmoke: rgba(0,0,0,255) in
// Chrome, the ground through a transparent result here). The importer marks such a node
// `chromeSpecular` only under compat: 'chrome', and filterGraph/primitives/lighting.js then does
// what Blink does. specularExponent clamps to the spec's range, 1..128, in both modes.
//
// Checked through the importer's graph, the handler's uploads (a recording GL) and the shipped fragment
// shader on the CPU (test/_fragEmu.mjs) over a flat, opaque input under a distant light at elevation 30.
import path from 'path';
import { fileURLToPath } from 'url';
import { cxx } from './_glslEmu.mjs';
import { buildFragEmu, generatedShader } from './_fragEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { feLightingDispatch } = await import('../src/filterGraph/primitives/lighting.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the importer: the flag exists only under compat: 'chrome' --------------------------------------
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><filter id="f"><feSpecularLighting specularConstant="0">' +
  '<feDistantLight elevation="30"/></feSpecularLighting></filter><rect width="50" height="50" filter="url(#f)"/></svg>';
const specNode = async (opts) => {
  const b = await importSvg(SVG, opts);
  return (b.filterGraphs || [])
    .filter(Boolean)
    .flatMap((g) => g.nodes)
    .find((n) => n.type === 'feSpecularLighting');
};
{
  const d = await specNode({}),
    c = await specNode({ compat: 'chrome' }),
    s = await specNode({ compat: 'spec' });
  ok(
    d && !('chromeSpecular' in d.params) && s && !('chromeSpecular' in s.params),
    "a default (and an explicit 'spec') import leaves the lighting node as it was",
  );
  ok(
    c && c.params.chromeSpecular === true,
    `compat: 'chrome' marks it (chromeSpecular ${c && c.params.chromeSpecular})`,
  );
  // The per-feature option `compat` replaced is gone: it warns and changes nothing.
  const { setDiagnostics } = await import('../src/core/diagnostics.js');
  const warns = [];
  setDiagnostics({ onWarn: (m) => warns.push(String(m)) });
  const o = await specNode({ svgLighting: 'chrome' });
  setDiagnostics({ onWarn: null });
  ok(
    o && !('chromeSpecular' in o.params) && warns.some((w) => /svgLighting option is gone/.test(w)),
    `the deprecated svgLighting option warns and has no effect (warnings ${JSON.stringify(warns)})`,
  );
}

/// Every uniform the handler uploads for one lighting node, by name.
function uploads(type, params) {
  const u = {};
  const gl = new Proxy(
    {},
    {
      get: (_t, k) =>
        typeof k === 'string' && k.startsWith('uniform')
          ? (l, ...v) => {
              u[l] = v.length === 1 ? v[0] : v;
            }
          : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)
            ? 0
            : () => {},
    },
  );
  feLightingDispatch(
    { type, params },
    [{ kind: 'rt', idx: 0 }],
    { fbo: {}, size: [8, 8] },
    {
      gl,
      pool: { get: () => ({ tex: {}, fbo: {}, size: [8, 8] }) },
      feLightingProg: {},
      feLightingU: new Proxy({}, { get: (_t, k) => k }),
      coverVao: {},
    },
  );
  return u;
}
// A distant light at azimuth 0, elevation 30 (the importer's unit direction), white.
const el = Math.PI / 6,
  LIGHT = { lightType: 0, lightPos: [Math.cos(el), 0, Math.sin(el)], lightColor: [1, 1, 1, 1] };
const spec = (ks, exp = 1, chrome = false) =>
  uploads('feSpecularLighting', {
    surfaceScale: 1,
    specularConstant: ks,
    specularExponent: exp,
    ...LIGHT,
    ...(chrome ? { chromeSpecular: true } : {}),
  });

// ---- the uploads -----------------------------------------------------------------------------------
{
  const z = spec(0),
    zc = spec(0, 1, true),
    nc = spec(-2, 1, true),
    hc = spec(0.5, 1, true);
  ok(
    z.uMode === 1 && z.uK === 0,
    `default: specularConstant 0 stays SPECULAR with k 0 (uMode ${z.uMode}, uK ${z.uK})`,
  );
  ok(
    zc.uMode === 0 && zc.uK === 0,
    `chrome: specularConstant 0 runs as DIFFUSE with k 0, as Blink does (uMode ${zc.uMode}, uK ${zc.uK})`,
  );
  ok(
    nc.uMode === 0 && nc.uK === 0,
    `chrome: a negative one does the same (uMode ${nc.uMode}, uK ${nc.uK})`,
  );
  ok(
    hc.uMode === 1 && hc.uK === 0.5,
    `chrome: a positive one stays specular with its own k (uMode ${hc.uMode}, uK ${hc.uK})`,
  );
  for (const chrome of [false, true]) {
    ok(
      spec(1, 0.5, chrome).uExponent === 1 &&
        spec(1, 200, chrome).uExponent === 128 &&
        spec(1, 20, chrome).uExponent === 20,
      `${chrome ? 'chrome' : 'default'}: specularExponent clamps to the spec's 1..128 (0.5 -> ${spec(1, 0.5, chrome).uExponent}, 200 -> ${spec(1, 200, chrome).uExponent}, 20 -> ${spec(1, 20, chrome).uExponent})`,
    );
  }
  const d = uploads('feDiffuseLighting', { surfaceScale: 1, diffuseConstant: 0.7, ...LIGHT });
  ok(
    d.uMode === 0 && d.uK === 0.7,
    `feDiffuseLighting is untouched (uMode ${d.uMode}, uK ${d.uK})`,
  );
}

// ---- the shipped shader, on the CPU ----------------------------------------------------------------
if (!cxx()) {
  console.log('  -- no C++ compiler: the shader half is skipped');
} else {
  const emu = buildFragEmu(generatedShader(ROOT, 'feLighting.frag.glsl'));
  const W = 8,
    flat = { w: W, h: W, linear: false, data: new Float32Array(W * W * 4).fill(1) }; // opaque white: a flat height field
  const run = (u) => {
    const uniforms = {};
    for (const [k, v] of Object.entries(u)) if (emu.uniforms.includes(k)) uniforms[k] = v;
    uniforms.uInMap = [1, 1, 0, 0];
    return Array.from(
      emu.run({ uniforms, textures: { uIn: flat }, frags: [{ vUV: [0.5, 0.5] }] }).slice(0, 4),
    );
  };
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-5);
  const z = run(spec(0)),
    zc = run(spec(0, 1, true));
  ok(
    near(z, [0, 0, 0, 0]),
    `default: specularConstant 0 is (${z.map((v) => +v.toFixed(4))}), transparent -- the spec's answer`,
  );
  ok(
    near(zc, [0, 0, 0, 1]),
    `chrome: specularConstant 0 is (${zc.map((v) => +v.toFixed(4))}), opaque black -- Chrome's rgba(0,0,0,255)`,
  );
  // Flat surface: N = (0,0,1), H = normalize(L + (0,0,1)), N.H = cos(30 deg); ks 1, exponent 1, white light.
  const want = (Math.sin(el) + 1) / Math.hypot(Math.cos(el), Math.sin(el) + 1);
  for (const chrome of [false, true]) {
    const s = run(spec(1, 1, chrome));
    ok(
      near(s, [want, want, want, want]),
      `${chrome ? 'chrome' : 'default'}: specularConstant 1 is the Filter Effects specular (${s.map((v) => +v.toFixed(4))}), want ${want.toFixed(4)}`,
    );
  }
}

console.log(fail ? `specularZeroConstantSmoke FAIL (${fail})` : 'specularZeroConstantSmoke PASS');
process.exit(fail ? 1 : 0);
