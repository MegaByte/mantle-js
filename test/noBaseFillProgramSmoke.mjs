// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// noBaseFillProgramSmoke -- the universal (base) fill program is not built in a default session.
//
// The base program is 320 KB of source whose first draw is a ~10 s Metal pipeline build, so the renderer never draws it while a lean variant,
// a ready superset or a deferred draw can serve the frame (variantFirst, psoWarm). Linking it at load would cost GPU-process compile time for a
// program nothing draws. It is linked at the first read of R.fillProg instead, and eagerly under the options that make it a draw target:
// variantFirst:false, psoWarm:false, loadingBaseWarm:true.
//   (a) default options, a scene of nine bundle classes (solid, stroke, gradient, mask, clip, filter, pattern, group opacity, morph), drawn cold
//       for several frames, then prewarmed, precompiled and drawn again: debugStats.baseFillBuilt stays false;
//   (b) each option that can draw the base builds it at createRenderer;
//   (c) a renderer disposed without ever building it disposes cleanly, and the programs created differ by exactly the base.
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
const { importSvg, createBundle, createRenderer, createShapeMorph } =
  await import('../src/index.js');
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
  group: svg(
    `<g opacity=".5"><path d="${P}" fill="#48c"/><path d="${blob(40, 60, 20)}" fill="#c48"/></g>`,
  ),
};

async function session(opts, { draw = true } = {}) {
  const F = createFakeGl({ width: 128, height: 128 });
  let programs = 0;
  const cp = F.gl.createProgram.bind(F.gl);
  F.gl.createProgram = () => {
    programs++;
    return cp();
  };
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false, ...opts });
  const created = programs;
  const built0 = R.debugStats.baseFillBuilt;
  R.setViewport(128, 128);
  if (!draw) return { R, F, built0, created };
  const bundles = {};
  for (const [name, s] of Object.entries(SCENES))
    bundles[name] = createBundle(F.gl, await importSvg(s, { preserveViewport: true }));
  const A = createBundle(F.gl, await importSvg(SCENES.solid, { preserveViewport: true }));
  const B = createBundle(
    F.gl,
    await importSvg(svg(`<path d="${blob(55, 45, 25)}" fill="#48c"/>`), { preserveViewport: true }),
  );
  try {
    bundles.morph = createShapeMorph(F.gl, A, B).bundle;
  } catch {
    /* a build without morphs */
  }
  const frames = (n) => {
    for (let f = 0; f < n; f++) {
      R.beginFrame([1, 1, 1, 1]);
      for (const b of Object.values(bundles)) R.drawBundle(b);
      R.endFrame();
    }
  };
  frames(4);
  for (const b of Object.values(bundles)) R.prewarmBundle(b);
  R.precompileFills();
  frames(4);
  return { R, F, built0, bundles };
}

// (a) a default session never builds the base
{
  const { R, built0, bundles } = await session({});
  ok(
    Object.keys(bundles).length >= 8,
    `(a) the scene carries ${Object.keys(bundles).length} bundles`,
  );
  ok(built0 === false, '(a) the base fill program is not built by createRenderer');
  ok(
    R.debugStats.baseFillBuilt === false,
    '(a) a default session (cold frames, prewarm, precompileFills, warm frames) never builds the base fill program',
  );
  R.dispose();
}
// (b) the options that can draw the base build it up front
for (const o of [{ variantFirst: false }, { psoWarm: false }, { loadingBaseWarm: true }]) {
  const { R, built0 } = await session(o, { draw: false });
  ok(built0 === true, `(b) ${JSON.stringify(o)}: the base fill program is built by createRenderer`);
  R.dispose();
}
// (c) one program fewer than the eager path
{
  const lazy = await session({}, { draw: false });
  const eager = await session({ variantFirst: false }, { draw: false });
  ok(
    eager.created - lazy.created === 1,
    `(c) the eager renderer creates exactly one more program than the lazy one (${eager.created} vs ${lazy.created})`,
  );
  lazy.R.dispose();
  eager.R.dispose();
}
console.log(fail ? `FAIL noBaseFillProgramSmoke: ${fail}` : 'noBaseFillProgramSmoke PASS');
process.exit(fail ? 1 : 0);
