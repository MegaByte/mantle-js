// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rotatedMapVariantSmoke — the fill's rotated footprint is compiled only into programs for draws that need it.
//
// Slug's and AAC's rotated footprints take the em -> pixel map of a rotated or skewed draw. Compiled into every program, that code
// cost AXIS-ALIGNED draws -- which never run it -- 1.16-1.19x (Slug, text) and 1.99-2.31x (AAC, tiger and text) on the
// GPU. So it sits behind MANTLE_ROTATED_MAP, and the renderer picks the define per draw (fillPass.variantDefinesFor,
// and the instanced path per instance) from the world matrix: shapeScale.worldMapAxisAligned. Node only, on the
// recording WebGL stand-in (test/_fakeGl.mjs), which links every program at once:
//   (a) worldMapAxisAligned: the identity, a scale, a mirror and a translation keep the axes; a rotation, a skew and a
//       projective row do not;
//   (b) the program a draw BINDS carries MANTLE_ROTATED_MAP exactly for a rotated or skewed world matrix, on the Slug and
//       the AAC renderer, and an axis-aligned draw after it goes back to the program without it;
//   (c) the instanced fast path: its program carries the define iff one of the instances is rotated.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true; // every frame runs the fill pass
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const { worldMapAxisAligned } = await import('../src/renderer/shapeScale.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- (a) the test -------------------------------------------------------------------------------
const c30 = Math.cos(Math.PI / 6),
  s30 = Math.sin(Math.PI / 6);
const KEEP = {
  identity: null,
  scale: [2, 0, 0, 0, 0.5, 0, 10, 20, 1],
  mirror: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  flipBoth: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
};
const TURN = {
  rotate30: [c30, s30, 0, -s30, c30, 0, 0, 0, 1],
  skewX: [1, 0, 0, 0.3, 1, 0, 0, 0, 1],
  projective: [1, 0, 0.001, 0, 1, 0, 0, 0, 1],
};
ok(
  Object.values(KEEP).every(worldMapAxisAligned) && !Object.values(TURN).some(worldMapAxisAligned),
  `(a) axis-aligned: ${Object.keys(KEEP).join(', ')}; not: ${Object.keys(TURN).join(', ')}`,
);

// ---- (b) the program a draw binds ------------------------------------------------------------------
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#000"/></svg>';
const sec = await importSvg(SVG, { preserveViewport: true });
for (const [arm, opts] of [
  ['slug', {}],
  ['aac', { aacFill: true }],
]) {
  const F = createFakeGl({ width: 128, height: 128 });
  // aacPoints:false: a small draw takes the vertex-stage point route, which binds no fill variant; this test is about the fill program
  const R = createRenderer(F.gl, taggedShaderSources(), { ...opts, aacPoints: false });
  if (arm === 'slug') R.setLoopBlinnFill('off');
  const b = createBundle(F.gl, sec);
  // the variant links and warms in the background (memory: fill-variant warm trap): prewarm, then draw with
  // precompileFills between frames until the BOUND program is a specialized one, and read its key
  R.setViewport(128, 128);
  R.prewarmBundle(b);
  const keyFor = (wm) => {
    let k = '';
    for (let i = 0; i < 16; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b, wm ? { worldMatrix: wm } : undefined);
      R.endFrame();
      R.precompileFills();
      k = R.debugStats.drawnFillVariantKey || '';
      if (i >= 2 && k && k.includes('MANTLE_ROTATED_MAP') === !worldMapAxisAligned(wm)) break;
    }
    return k;
  };
  const rows = [];
  for (const [n, wm] of Object.entries({ ...KEEP, ...TURN, identityAgain: null })) {
    const k = keyFor(wm),
      want = !!TURN[n];
    rows.push(`${n} ${k.includes('MANTLE_ROTATED_MAP') ? 'rotated' : 'plain'}`);
    ok(
      k.includes('MANTLE_ROTATED_MAP') === want,
      `(b) ${arm}: a ${n} draw binds ${want ? 'the rotated-map program' : 'a program without the rotated map'} (${k || 'base'})`,
    );
  }
  if (arm === 'aac')
    ok(
      keyFor(TURN.rotate30).includes('MANTLE_AAC'),
      '(b) aac: the rotated program is still an AAC program',
    );
}

// ---- (c) the instanced fast path ---------------------------------------------------------------------
{
  const F = createFakeGl({ width: 128, height: 128 });
  // the instanced fast path compiles its own program: record which fragment defines it asks for
  const seen = [];
  const gl = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'shaderSource')
          return (sh, text) => {
            if (/#define MANTLE_INSTANCED/.test(text) && /@@fillFrag/.test(text))
              seen.push(/#define MANTLE_ROTATED_MAP/.test(text));
            return F.gl.shaderSource(sh, text);
          };
        return F.gl[k];
      },
    },
  );
  const R = createRenderer(gl, taggedShaderSources(), { aacPoints: false, variantFirst: false });
  R.setLoopBlinnFill('off');
  const b = createBundle(gl, sec);
  const draw = (inst) => {
    R.setViewport(128, 128);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(b, inst);
    R.endFrame();
  };
  const n0 = R.debugStats.instancedFastCount | 0;
  draw([{ worldMatrix: KEEP.scale }, { worldMatrix: KEEP.mirror }]);
  const plain = seen.splice(0),
    n1 = R.debugStats.instancedFastCount | 0;
  draw([{ worldMatrix: KEEP.scale }, { worldMatrix: TURN.rotate30 }]);
  const turned = seen.splice(0),
    n2 = R.debugStats.instancedFastCount | 0;
  ok(n1 > n0 && n2 > n1, `(c) both draws took the instanced fast path (${n1 - n0}, ${n2 - n1})`);
  ok(
    plain.length > 0 && plain.every((r) => !r),
    `(c) instances that keep the axes compile the instanced program without the rotated map (${plain})`,
  );
  ok(
    turned.length > 0 && turned.every((r) => r),
    `(c) one rotated instance compiles it with the rotated map (${turned})`,
  );
}

console.log(fail ? `ROTATED-MAP-VARIANT FAIL (${fail})` : 'ROTATED-MAP-VARIANT PASS');
process.exit(fail ? 1 : 0);
