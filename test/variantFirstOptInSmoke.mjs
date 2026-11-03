// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// variantFirstOptInSmoke -- the `variantFirst` renderer option (DEFAULT ON): the default draws the same lean variant the
// settled path uses, from the first frame, for every feature a bundle carries; `variantFirst: false` is the opt-out and draws the base program first.
//
// variantFirst: a bundle's draws use the general (base) fill program until its specialized variant has its pipeline built, and the
// base program's first draw costs seconds on a cold Metal cache. With `opts.variantFirst` on (the default), while the base has never drawn, the
// renderer confirms the lean variant's link and draws with it instead.
//
//   (a) option false (the opt-out): the program key of every draw on frames 0-3 is the base program's (empty);
//   (b) option unset or true, a scene of several bundles (solid, stroke, gradient, mask, clip, filter, pattern, group opacity, morph): the
//       option is read from the createRenderer options and survives across bundles (every bundle's frame-0 key is a lean key, none is base);
//   (c) no correctness gate is skipped: each bundle's frame-0 key under variantFirst equals the lean key the default path settles
//       on after its warm-up (same `NO_*` feature gates -- masks, filters, gradients, patterns, groups and morphs keep their code).
// CPU, fake GL: the pixel side is a GPU measurement, and the render lane (variantFirstDefaultSmoke) is the default path's pixel gate.
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
const KEY = (R) => R.debugStats.drawnFillVariantKey || '';

async function scene(opts, frames, { settle = false } = {}) {
  const F = createFakeGl({ width: 128, height: 128 });
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false, ...opts });
  R.setViewport(128, 128);
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
  if (settle) for (const b of Object.values(bundles)) R.prewarmBundle(b);
  const keys = [];
  for (let f = 0; f < frames; f++) {
    R.beginFrame([1, 1, 1, 1]);
    const row = {};
    for (const [name, b] of Object.entries(bundles)) {
      R.drawBundle(b);
      row[name] = KEY(R);
    }
    R.endFrame();
    if (settle) R.precompileFills();
    keys.push(row);
  }
  return { R, keys };
}

// ---- (a) default and false: the base program ----------------------------------------------------------------------
for (const o of [{ variantFirst: false }]) {
  const { keys } = await scene(o, 4);
  const names = Object.keys(keys[0]);
  ok(
    keys.every((row) => names.every((n) => row[n] === '')),
    `(a) opt-out ${JSON.stringify(o)}: frames 0-3 draw the base program (empty key) for all ${names.length} bundles`,
  );
}

// ---- (b) true: read from the options, and survives across several bundles ---------------------------------------------
const on = await scene({ variantFirst: true }, 4);
const dflt = await scene({}, 4); // (b') the default is the same as variantFirst: true
const names = Object.keys(on.keys[0]);
ok(names.length >= 8, `(b) the scene carries ${names.length} bundles`);
ok(
  on.keys.every((row) => names.every((n) => row[n] !== '')),
  '(b) every bundle draws a lean variant (no base key) on frames 0-3',
);
ok(
  new Set(names.map((n) => on.keys[0][n])).size >= 4,
  `(b) the bundles bind different lean variants (${new Set(names.map((n) => on.keys[0][n])).size} distinct keys), not one shared program`,
);

ok(
  JSON.stringify(dflt.keys) === JSON.stringify(on.keys),
  "(b') the DEFAULT (option unset) draws exactly the keys variantFirst: true does, on frames 0-3",
);

// ---- (c) the lean variant is the one the default path settles on -----------------------------------------------------
const settled = await scene({ variantFirst: false }, 40, { settle: true });
const last = settled.keys[settled.keys.length - 1];
// A filter bundle's FIRST frame ends on its content pass (a different program from its composite pass, whose key every later frame
// ends on), under the default path as well (its frame-0 key is the base program's); its key is compared from frame 1.
for (const n of names) {
  const f = n === 'filter' ? 1 : 0,
    lean = on.keys[f][n],
    steady = last[n];
  ok(
    steady !== '' && lean === steady && on.keys[3][n] === steady,
    `(c) ${n}: the key under variantFirst (frame ${f}, and frame 3) equals the key the default path settles on`,
  );
}
console.log(fail ? `FAIL variantFirstOptInSmoke: ${fail}` : 'variantFirstOptInSmoke PASS');
process.exit(fail ? 1 : 0);
