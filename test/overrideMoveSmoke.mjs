// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// overrideMoveSmoke — a row an override MOVES is drawn where it went, and hit where it is drawn.
//
// A per-shape override's affine (localPosition / localRotation / localScale) moves the row in em space before the
// draw's own map. A vertex stage that moves the row's cover quad and then samples its curves AT THE MOVED POINT, where
// they are not, draws a translated square nowhere, on every route (on the GPU: test/overrideMoveRenderSmoke.mjs).
// So the fragment samples the row in its own frame, and its clip-path and mask move with it (element-transform
// semantics, which the native fallback has by writing the override as the element's `transform`). The hit test takes the point back through the same affine.
//
// Through the REAL vertex and fragment texts (test/_lbPipeScene.mjs, the unified fill stream on the CPU), 100 px canvas
// over a 100-unit drawing, for a filled curve, a stroked one, a clipped rect, a single-row mask and a two-child mask:
//   (a) moved by a whole number of pixels, the row is the unmoved row shifted, to float rounding (cover quad; the
//       filled curve on its Loop-Blinn mesh too);
//   (b) scaled (1.5, 0.75), it is the same drawing authored inside <g transform="translate scale">, to float rounding;
//   (c) rotated 30 degrees (the rotated-footprint program, as the renderer picks it for such a draw), it is that drawing
//       to within an AA ramp on every pixel: no pixel off by 0.15 (a row in the wrong place is off by 1);
//   (d) a moved row reads its mask through the in-shader walk, not the screen-space mask bake (a bake of all zeros
//       hides the unmoved row and not the moved one, which draws as it does with no bake);
//   (e) the hit test agrees with the render on every pixel the render decides (coverage >= 0.95 hits, <= 0.05 misses),
//       for every case above, and honors the absolute fill alpha, stroke width and a collapsed row;
//   (f) the renderer asks for the rotated footprint when an override rotates a row, and not for a translation; its
//       transform test is exact (a 2^-30 move is a move).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { lbScene, renderScene, compositeAlpha } = await import('./_lbPipeScene.mjs');
const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');
const GEN = path.join(ROOT, 'src/shaders/generated');
const vertText = readFileSync(path.join(GEN, 'mantle.vert.glsl'), 'utf8');
const fragText = readFileSync(path.join(GEN, 'mantle.frag.glsl'), 'utf8');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const N = 100;
// Two corner anchors pin the content box to the viewBox, so every scene maps one unit to one pixel.
const ANCH =
  '<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="99.5" y="99.5" width="0.5" height="0.5" fill="#000"/>';
const doc = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${ANCH}${body}</svg>`;
const BLOB = 'M30 20 C45 10 60 25 55 40 C50 55 30 50 25 40 Z';
const CASES = {
  fill: ['', `<path id="t" d="${BLOB}" fill="#000"/>`],
  stroke: ['', `<path id="t" d="${BLOB}" fill="none" stroke="#000" stroke-width="3"/>`],
  clip: [
    '<clipPath id="c" clipPathUnits="userSpaceOnUse"><circle cx="40" cy="30" r="12"/></clipPath>',
    '<rect id="t" x="25" y="15" width="30" height="30" fill="#000" clip-path="url(#c)"/>',
  ],
  mask1: [
    '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><circle cx="40" cy="30" r="12" fill="#fff"/></mask>',
    '<rect id="t" x="25" y="15" width="30" height="30" fill="#000" mask="url(#m)"/>',
  ],
  mask2: [
    '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect x="25" y="15" width="30" height="30" fill="#fff"/>' +
      '<circle cx="40" cy="30" r="8" fill="#000"/></mask>',
    '<rect id="t" x="25" y="15" width="30" height="30" fill="#000" mask="url(#m)"/>',
  ],
};
const XF = {
  translate: { o: { localPosition: [20, 10] }, g: 'translate(20 10)' },
  scale: {
    o: { localPosition: [-10, 20], localScale: [1.5, 0.75] },
    g: 'translate(-10 20) scale(1.5 0.75)',
  },
  rotate: {
    o: { localPosition: [40, -10], localRotation: Math.PI / 6 },
    g: 'translate(40 -10) rotate(30)',
  },
};
// overrides.js writeShape's packing: M = R(rot) S(scale), row-major, then the translation.
const packRow = (o) => {
  const rot = o.localRotation || 0,
    sx = o.localScale ? o.localScale[0] : 1,
    sy = o.localScale ? o.localScale[1] : 1;
  const c = Math.cos(rot),
    s = Math.sin(rot);
  return [
    c * sx,
    -s * sy,
    s * sx,
    c * sy,
    o.localPosition ? o.localPosition[0] : 0,
    o.localPosition ? o.localPosition[1] : 0,
  ];
};
const targetRow = (sec) => (sec.shapeIds || []).findIndex((id) => id === 't' || /^t_/.test(id));
function packedFor(numShapes, row, o, extra) {
  const P = new Float32Array(numShapes * 24);
  for (let r = 0; r < numShapes; r++) {
    const b = r * 24;
    P[b] = 1;
    P[b + 3] = 1;
    P[b + 6] = 1;
    P[b + 8] = P[b + 9] = P[b + 10] = P[b + 11] = 1;
  }
  if (o) {
    const p = packRow(o);
    for (let k = 0; k < 6; k++) P[row * 24 + k] = p[k];
  }
  if (extra) extra(P, row * 24);
  return P;
}
/// The target row's coverage (its fragments only, composited), rows top-down. opts: route 'cover' | 'lb', defines,
/// bake (a zero mask bake bound for the target's mask), exact (default true: build with MANTLE_STROKE_EXACT, the renderer's
/// strokeExactEdges opt-in; the default program drops the exact edge records, and every assertion here but the records-off
/// case below pins the exact-edge path -- the same build the exact-AA smokes use).
async function render(svg, o, { route = 'cover', defines = [], bake = false, exact = true } = {}) {
  if (exact && !defines.includes('MANTLE_STROKE_EXACT'))
    defines = defines.concat('MANTLE_STROKE_EXACT');
  const sc = await lbScene(svg, {
    N,
    rows: (s, stroke) => (route === 'lb' && !stroke ? 'lb' : 'cover'),
  });
  const row = targetRow(sc.sec);
  const T = sc.textures[sc.uniforms.get('uOverrideTex')].data;
  T.set(packedFor(T.length / 24, row, o));
  if (o) sc.uniforms.set('uHasOverrides', 1);
  if (bake) {
    const maskId = Math.round(sc.pm.metaFloats[row * sc.pm.floatsPerShape + 31]);
    sc.textures[sc.uniforms.get('uMaskRowToLayerTex')].data[(maskId - 1) * 4] = 0;
    sc.textures.push({ w: N, h: N, l: 1, data: new Float32Array(N * N * 4) });
    sc.uniforms.set('uMaskRTArray', sc.textures.length - 1);
    sc.uniforms.set('uHasOffscreenMask', 1);
  }
  const res = renderScene(sc, vertText, fragText, defines);
  const ent = new Set(
    sc.entries.map((e, k) => (e.shapeIdx === row ? k : -1)).filter((k) => k >= 0),
  );
  if (route === 'lb' && !sc.entries.some((e) => e.shapeIdx === row && e.kind === 'lb'))
    throw new Error('no LB mesh for the target');
  return {
    cov: compositeAlpha(res.recs, N, (tri) => ent.has(sc.entryOfTri[tri])),
    sec: sc.sec,
    row,
  };
}
const sum = (a) => a.reduce((s, v) => s + v, 0);
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const shifted = (a, dx, dy) => {
  const o = new Float64Array(N * N);
  for (let y = dy; y < N; y++) for (let x = dx; x < N; x++) o[y * N + x] = a[(y - dy) * N + x - dx];
  return o;
};

console.log('overrideMoveSmoke');
const renders = [];
for (const [cn, [defs, body]] of Object.entries(CASES)) {
  const svg = doc(defs, body);
  const base = await render(svg, null);
  // (a)
  const mt = await render(svg, XF.translate.o);
  const dT = maxDiff(mt.cov, shifted(base.cov, 20, 10));
  ok(
    sum(base.cov) > 100 && dT < 1e-4,
    `(a) ${cn}: moved (20, 10) px is the unmoved row shifted (max |diff| ${dT.toExponential(1)}, ink ${sum(base.cov).toFixed(1)} px)`,
  );
  renders.push({ cn, xn: 'translate', ...mt });
  if (cn === 'fill') {
    const lb0 = await render(svg, null, { route: 'lb' }),
      lbT = await render(svg, XF.translate.o, { route: 'lb' });
    // The mesh's edge strips carry corner planes in canvas pixels, mapped from the moved corners: rounding of 1e-4 there.
    const dL = maxDiff(lbT.cov, shifted(lb0.cov, 20, 10));
    ok(
      sum(lb0.cov) > 100 && dL < 1e-3,
      `(a) fill on its Loop-Blinn mesh: moved (20, 10) px is the unmoved mesh shifted (max |diff| ${dL.toExponential(1)})`,
    );
  }
  // (b), (c)
  for (const xn of ['scale', 'rotate']) {
    const X = XF[xn];
    const mv = await render(svg, X.o, { defines: xn === 'rotate' ? ['MANTLE_ROTATED_MAP'] : [] });
    const ref = await render(doc(defs, `<g transform="${X.g}">${body}</g>`), null);
    const d = maxDiff(mv.cov, ref.cov),
      bar = xn === 'scale' ? 2e-3 : 0.15;
    ok(
      sum(ref.cov) > 100 && d < bar,
      `(${xn === 'scale' ? 'b' : 'c'}) ${cn}: ${xn}d by the override is <g transform="${X.g}"> (max |diff| ${d.toFixed(4)} < ${bar}, ink ${sum(mv.cov).toFixed(1)} vs ${sum(ref.cov).toFixed(1)} px)`,
    );
    renders.push({ cn, xn, ...mv });
  }
}

// (b') the records-OFF program (the default, strokeExactEdges unset) under the non-uniform scale override. With the edge records
// dropped, a stroke's AA edge under scale(1.5, 0.75) differs from the same drawing authored inside the <g> by up to 0.0223
// coverage (5.7/255, ink 341.3 vs 341.3 px; 0.0009 with the records on). That is the accepted cost of records-off, so this
// pins it: a bound of 0.03 (the measured value plus 35%) catches a change that makes the default program's scaled strokes
// worse, without asking the default program for the exact-edge result it does not compute.
{
  const [defs, body] = CASES.stroke,
    X = XF.scale;
  const mv = await render(doc(defs, body), X.o, { exact: false });
  const ref = await render(doc(defs, `<g transform="${X.g}">${body}</g>`), null, { exact: false });
  const d = maxDiff(mv.cov, ref.cov);
  ok(
    sum(ref.cov) > 100 && Math.abs(sum(mv.cov) - sum(ref.cov)) < 1 && d < 0.03,
    `(b') stroke, records off: scaled by the override stays within 0.03 of the <g> drawing (max |diff| ${d.toFixed(4)}, ink ${sum(mv.cov).toFixed(1)} vs ${sum(ref.cov).toFixed(1)} px)`,
  );
}

// (d) the mask bake is a screen-space image of the mask where the row was authored
{
  const svg = doc(...CASES.mask2);
  const still = await render(svg, null, { bake: true });
  const moved = await render(svg, XF.translate.o, { bake: true }),
    inline = await render(svg, XF.translate.o);
  ok(
    sum(still.cov) === 0,
    `(d) an unmoved row reads the bake: an all-zero bake hides it (${sum(still.cov).toFixed(2)} px)`,
  );
  const d = maxDiff(moved.cov, inline.cov);
  ok(
    sum(inline.cov) > 100 && d === 0,
    `(d) a moved row reads its mask in its own frame, bake or none (${sum(moved.cov).toFixed(1)} px, max |diff| ${d})`,
  );
}

// (e) the hit test, against the render
for (const r of renders) {
  const P = packedFor(r.sec.numShapes, r.row, XF[r.xn].o);
  let dis = 0,
    decided = 0,
    first = '';
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const c = r.cov[y * N + x];
      if (c > 0.05 && c < 0.95) continue;
      decided++;
      const hit =
        fillHitShape(r.sec, x + 0.5, y + 0.5, { mode: HitMode.Coverage, overrides: P }) === r.row;
      if (hit !== c >= 0.95) {
        dis++;
        if (!first) first = ` first at (${x}, ${y}): render ${c.toFixed(3)}, hit ${hit}`;
      }
    }
  ok(
    dis === 0,
    `(e) ${r.cn} ${r.xn}d: the hit test agrees with the render on ${decided} decided pixels (${dis} disagree)${first}`,
  );
}
{
  const sec = (await render(doc(...CASES.fill), null)).sec,
    row = targetRow(sec);
  const at = (P, x, y, o = {}) =>
    fillHitShape(sec, x, y, { mode: HitMode.Coverage, overrides: P, ...o }) === row;
  const moved = packedFor(sec.numShapes, row, XF.translate.o);
  ok(
    at(moved, 60, 42) && !at(moved, 40, 32),
    '(e) a translated row answers where it went (60, 42), not where it was (40, 32)',
  );
  const half = packedFor(sec.numShapes, row, null, (P, b) => {
    P[b + 7] = 1;
    P[b + 12] = 0;
    P[b + 13] = 0;
    P[b + 14] = 0;
    P[b + 15] = 0.3;
  });
  ok(
    !at(half, 40, 32, { minAlpha: 0.5 }) && at(half, 40, 32, { minAlpha: 0.2 }),
    '(e) an absolute fill of alpha 0.3 misses at minAlpha 0.5 and hits at 0.2',
  );
  const flat = packedFor(sec.numShapes, row, { localScale: [0, 1] });
  ok(
    !at(flat, 40, 32) && !at(flat, 0.25, 32),
    '(e) a row collapsed to a line (localScale [0, 1]) answers nowhere',
  );
  const ssec = (await render(doc(...CASES.stroke), null)).sec,
    srow = targetRow(ssec);
  const sat = (P, x, y) => fillHitShape(ssec, x, y, { mode: HitMode.Auto, overrides: P }) === srow;
  // (30, 20) is on the outline; (30, 16) is 4 units off it, outside a 3-wide stroke and inside a 10-wide one
  const wide = packedFor(ssec.numShapes, srow, null, (P, b) => {
    P[b + 7] = 4;
    P[b + 20] = 10;
  });
  ok(
    sat(packedFor(ssec.numShapes, srow, null), 30, 20) &&
      !sat(packedFor(ssec.numShapes, srow, null), 30, 16) &&
      sat(wide, 30, 16),
    '(e) an absolute stroke width of 10 hits 4 units off the outline, where the authored 3 does not',
  );
}

// (f) the renderer's choices, against the recording fake GL
{
  const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
  const { importSvg, createBundle, createRenderer, createOverrideTable } =
    await import('../src/index.js');
  const F = createFakeGl({ width: 100, height: 100 });
  const srcs = [];
  const gl = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'shaderSource'
          ? (sh, src) => {
              srcs.push(String(src));
              F.gl.shaderSource(sh, src);
            }
          : k === 'getExtension'
            ? () => null
            : F.gl[k],
    },
  );
  const r = createRenderer(gl, taggedShaderSources());
  r.setFillEngine({ route: 'none' });
  const b = createBundle(gl, await importSvg(doc(...CASES.fill)));
  const table = createOverrideTable(gl, b);
  const drawWith = (o) => {
    table.set('t', o);
    srcs.length = 0;
    r.setViewport(100, 100);
    r.beginFrame([1, 1, 1, 1]);
    r.drawBundle(b, { overrides: table });
    r.endFrame();
    return srcs.some((s) => /#define MANTLE_ROTATED_MAP\b/.test(s));
  };
  const rotated = drawWith({ localRotation: 0.5 }),
    translated = drawWith({ localPosition: [3, 4] });
  ok(
    rotated && !translated,
    `(f) a rotating override compiles the rotated footprint (${rotated}), a translating one does not (${translated})`,
  );
  // The transform test that sends a moved row to its cover quad (morphDraw _ovHasXform), off a renderer stub.
  const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
  const Rs = /** @type {any} */ ({ gl: createFakeGl({}).gl, opts: {} });
  attachMorphDraw(Rs);
  const tiny = new Float32Array(48);
  tiny[0] = tiny[3] = tiny[24] = tiny[27] = 1;
  tiny[28] = 2 ** -30;
  ok(
    !Rs._ovHasXform(tiny, 0) && Rs._ovHasXform(tiny, 1),
    "(f) the route's transform test is exact: a 2^-30 translation is a move",
  );
  const { overridesAxisAligned } = await import('../src/renderer/shapeScale.js');
  const rot = new Float32Array(24);
  rot[0] = rot[3] = Math.cos(0.5);
  rot[1] = -Math.sin(0.5);
  rot[2] = Math.sin(0.5);
  ok(
    overridesAxisAligned(tiny) && !overridesAxisAligned(rot) && overridesAxisAligned(null),
    '(f) overridesAxisAligned: a translation keeps the axes, a rotation does not',
  );
}

console.log(fail ? `\nOVERRIDE-MOVE FAIL (${fail})` : '\nOVERRIDE-MOVE PASS');
process.exit(fail ? 1 : 0);
