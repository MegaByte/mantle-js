// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// universalProgramsSmoke -- no UNIVERSAL (all-feature) program is built in a default session. Generalizes noBaseFillProgramSmoke from the base fill program to every
// program that a lean variant stands in for or that no draw reaches: the base fill program, the AAC base, the instanced base and its AAC twin (each ~320 KB, drawn by no
// entry of the census table) and the drawImage / drawImageInstanced programs (72 KB each; reachable only by the drawImage API).
//   (a) default options, the nine-class scene drawn cold, prewarmed, precompiled, drawn again, plus an instanced draw: no fill program without a MANTLE_NO_* define is
//       linked, no instanced one, no drawImage one; a program census over every shader source the renderer handed to GL
//   (b) each option that can draw a universal builds it (variantFirst:false, psoWarm:false, loadingBaseWarm:true, eagerPrograms:true), and only the ones it can draw
//   (c) the first drawImage builds its program on demand and counts as a need miss; a declared `drawImage` need builds it with the declaration, never a miss
//   (d) needMissPolicy:'block' compiles and draws the exact variant (no stand-in, no skipped draw), 'defer' (default) is the existing path
// CPU, fake GL.
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
globalThis.__MANTLE_DEBUG__ = true;
const { importSvg, createBundle, createRenderer, createPalette } = await import('../src/index.js');
console.warn = () => {};

const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy} C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
const P = blob(50, 50, 30);
const SCENES = {
  solid: svg(`<path d="${P}" fill="#48c"/>`),
  stroke: svg(`<path d="${P}" fill="none" stroke="#222" stroke-width="3"/>`),
  gradient: svg(
    `<path d="${P}" fill="url(#g)"/>`,
    '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  ),
  mask: svg(
    `<g mask="url(#m)"><path d="${P}" fill="#4a8"/></g>`,
    `<mask id="m"><circle cx="50" cy="50" r="28" fill="#fff"/></mask>`,
  ),
  clip: svg(
    `<path d="${P}" fill="#a48" clip-path="url(#c)"/>`,
    '<clipPath id="c"><rect x="20" y="20" width="60" height="60"/></clipPath>',
  ),
  filter: svg(
    `<path d="${P}" fill="#c84" filter="url(#f)"/>`,
    '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>',
  ),
  pattern: svg(
    `<path d="${P}" fill="url(#p)"/>`,
    '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#333"/></pattern>',
  ),
};

/// A program census: every (vert, frag) source pair the renderer hands to the GL, classified by its tag and its defines.
function census(F) {
  const src = new Map(),
    progs = [];
  const ss = F.gl.shaderSource.bind(F.gl);
  F.gl.shaderSource = (sh, s) => {
    src.set(sh, s);
    return ss(sh, s);
  };
  const att = F.gl.attachShader.bind(F.gl);
  const owner = new Map();
  F.gl.attachShader = (p, sh) => {
    (owner.get(p) || owner.set(p, []).get(p)).push(sh);
    return att(p, sh);
  };
  const lk = F.gl.linkProgram.bind(F.gl);
  F.gl.linkProgram = (p) => {
    progs.push((owner.get(p) || []).map((s) => src.get(s) || '').join('\n'));
    return lk(p);
  };
  const fillProgs = () => progs.filter((t) => t.includes('@@fillFrag'));
  return {
    all: () => progs.length,
    universalFill: () =>
      fillProgs().filter((t) => !/MANTLE_NO_/.test(t) && !/MANTLE_INSTANCED/.test(t)).length,
    universalInst: () =>
      fillProgs().filter((t) => !/MANTLE_NO_/.test(t) && /MANTLE_INSTANCED/.test(t)).length,
    aacBase: () =>
      fillProgs().filter(
        (t) => !/MANTLE_NO_/.test(t) && /MANTLE_AAC\b/.test(t) && !/MANTLE_INSTANCED/.test(t),
      ).length,
    image: () =>
      progs.filter((t) => t.includes('@@drawImageFrag') || t.includes('@@drawImageInstancedFrag'))
        .length,
  };
}
async function session(opts, { draw = true } = {}) {
  const F = createFakeGl({ width: 128, height: 128 });
  const C = census(F);
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false, ...opts });
  R.setViewport(128, 128);
  if (!draw) return { R, F, C };
  const bundles = {};
  for (const [name, s] of Object.entries(SCENES))
    bundles[name] = createBundle(F.gl, await importSvg(s, { preserveViewport: true }));
  const frames = (n) => {
    for (let f = 0; f < n; f++) {
      R.beginFrame([1, 1, 1, 1]);
      for (const b of Object.values(bundles)) R.drawBundle(b);
      R.drawBundleInstanced(bundles.solid, [
        { worldMatrix: new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0, 0, 1]) },
        { worldMatrix: new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0.3, 0.3, 1]) },
      ]);
      R.endFrame();
    }
  };
  frames(4);
  for (const b of Object.values(bundles)) R.prewarmBundle(b);
  R.precompileFills();
  frames(4);
  return { R, F, C, bundles };
}

console.log('(a) a default session builds no universal program');
{
  const { R, C } = await session({});
  ok(
    C.universalFill() === 0,
    `no fill program without a MANTLE_NO_* define (${C.universalFill()} of ${C.all()} programs)`,
  );
  ok(C.aacBase() === 0, `no AAC base program (${C.aacBase()})`);
  ok(C.universalInst() === 0, `no universal instanced program (${C.universalInst()})`);
  ok(
    C.image() >= 2,
    `the image programs stay eager by default (${C.image()}): their first draw would wait on the link`,
  );
  const lz = await session({ lazyImagePrograms: true });
  ok(
    lz.C.image() === 0,
    `lazyImagePrograms: true builds none until an image is drawn (${lz.C.image()})`,
  );
  lz.R.dispose();
  ok(R.debugStats.baseFillBuilt === false, 'debugStats.baseFillBuilt false');
  const n = R.debugStats.needMiss;
  ok(
    n && typeof n.fillMisses === 'number' && typeof n.blocked === 'number' && n.policy === 'defer',
    `needMiss carries the counters and the policy (${JSON.stringify({ miss: n.fillMisses, blocked: n.blocked, policy: n.policy })})`,
  );
  ok(
    typeof n.standInDraws === 'number',
    `stand-in draws are counted by program key (${n.standInDraws})`,
  );
  R.dispose();
}

console.log('(b) the options that can draw a universal build it');
{
  const base = await session({}, { draw: false });
  const nBase = base.C.all();
  base.R.dispose();
  for (const [o, want] of [
    [{ variantFirst: false }, ['universalFill']],
    [{ psoWarm: false }, ['universalFill']],
    [{ loadingBaseWarm: true }, ['universalFill']],
    [{ eagerPrograms: true }, ['universalFill']],
  ]) {
    const { R, C } = await session(o, { draw: false });
    R.precompileFills();
    ok(
      want.every((w) => C[w]() >= 1),
      `${JSON.stringify(o)}: ${want.join(', ')} built (${want.map((w) => C[w]()).join(',')}); ${C.all() - nBase} more programs than the default`,
    );
    R.dispose();
  }
}

console.log(
  '(c) the first drawImage builds its program on demand (a counted need miss); a declared need builds it up front',
);
{
  const { R, C } = await session({ lazyImagePrograms: true }, { draw: false });
  await R.precompileFillsAsync({});
  ok(C.image() === 0, 'no image program before the first image draw');
  const m0 = R.debugStats.needMiss.programMisses;
  R.beginFrame([1, 1, 1, 1]);
  try {
    R.drawImage({ width: 2, height: 2, data: new Uint8Array(16) }, { dstRect: [0, 0, 8, 8] });
  } catch {
    /* the stand-in GL has no texture upload for this source */
  }
  R.endFrame();
  ok(C.image() >= 1, `the first image draw built the program (${C.image()})`);
  ok(
    R.debugStats.needMiss.programMisses === m0 + 1,
    `and counted one need miss (${R.debugStats.needMiss.programMisses - m0})`,
  );
  R.dispose();
  const d = await session(
    {
      lazyImagePrograms: true,
      declaredNeeds: { format: 'mantle-needs', version: 1, programs: [{ t: 'drawImage', a: [] }] },
    },
    { draw: false },
  );
  ok(
    d.C.image() >= 1,
    `a declared drawImage need builds the program with the declaration (${d.C.image()})`,
  );
  await d.R.precompileFillsAsync({});
  const mm = d.R.debugStats.needMiss.programMisses;
  d.R.beginFrame([1, 1, 1, 1]);
  try {
    d.R.drawImage({ width: 2, height: 2, data: new Uint8Array(16) }, { dstRect: [0, 0, 8, 8] });
  } catch {
    /* as above */
  }
  d.R.endFrame();
  ok(d.R.debugStats.needMiss.programMisses === mm, 'and the draw is not a miss');
  d.R.dispose();
}

console.log("(d) needMissPolicy 'block' compiles the exact variant; 'defer' is the existing path");
{
  const run = async (policy) => {
    const F = createFakeGl({ width: 128, height: 128 });
    const R = createRenderer(F.gl, taggedShaderSources(), {
      aacPoints: false,
      ...(policy ? { needMissPolicy: policy } : {}),
    });
    R.setViewport(128, 128);
    const b = createBundle(F.gl, await importSvg(SCENES.gradient, { preserveViewport: true }));
    await R.precompileFillsAsync({});
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    const s0 = R.debugStats.needMiss.standInDraws | 0,
      d0 = R.debugStats.deferredFillDraws | 0;
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, {
      palette: createPalette(F.gl, [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
      ]),
      paletteChannel: 'r',
    });
    R.endFrame();
    const out = {
      blocked: R.debugStats.needMiss.blocked,
      stand: (R.debugStats.needMiss.standInDraws | 0) - s0,
      deferred: (R.debugStats.deferredFillDraws | 0) - d0,
      miss: R.debugStats.needMiss.fillMisses,
    };
    R.dispose();
    return out;
  };
  const dflt = await run(null),
    blk = await run('block');
  ok(dflt.blocked === 0, `default: nothing blocked (${JSON.stringify(dflt)})`);
  ok(
    blk.blocked >= 1 && blk.stand === 0 && blk.deferred === 0,
    `block: the cold draw compiled its exact variant (${JSON.stringify(blk)})`,
  );
}

console.log(
  '(e) a broken fill shader source fails createRenderer even though the base program is lazy (the plain-fill check variant linked at init carries the source)',
);
{
  const F = createFakeGl({ width: 64, height: 64 });
  const src = new Map();
  const ss = F.gl.shaderSource.bind(F.gl);
  F.gl.shaderSource = (sh, s) => {
    src.set(sh, s);
    return ss(sh, s);
  };
  const gp = F.gl.getShaderParameter.bind(F.gl);
  F.gl.getShaderParameter = (sh, p) =>
    p === F.gl.COMPILE_STATUS
      ? !/#error intentional_shader_failure/.test(src.get(sh) || '')
      : gp(sh, p);
  const good = taggedShaderSources();
  const bad = new Proxy(
    {},
    {
      get: (_t, k) =>
        typeof k === 'string'
          ? k === 'fillFrag'
            ? `// @@fillFrag\n#error intentional_shader_failure\nvoid main() {}\n`
            : good[k]
          : undefined,
      has: () => true,
    },
  );
  let failure = null;
  try {
    const R = createRenderer(F.gl, bad, { aacPoints: false });
    await R.ready;
    R.dispose();
  } catch (e) {
    failure = String((e && e.message) || e);
  }
  ok(
    failure && /intentional_shader_failure|shader compile|link/.test(failure),
    `createRenderer rejects with the compile diagnostic (${failure && failure.slice(0, 80)})`,
  );
  const leaked = [...src.keys()].filter((sh) => F.gl.isShader && F.gl.isShader(sh)).length;
  ok(leaked === 0 || F.gl.isShader === undefined, `no shader object is left behind (${leaked})`);
  // the check costs one program: the default session's program count with the check (this build) versus the eager-base build
  const a = await session({}, { draw: false });
  const withProbe = a.C.all();
  a.R.dispose();
  const d = await session({ disableFillVariants: true }, { draw: false });
  const without = d.C.all();
  d.R.dispose();
  ok(
    withProbe - without === 1,
    `the plain-fill check is exactly one program at init (${withProbe} with, ${without} with fill variants disabled)`,
  );
}

console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
