// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillBezoutOmitSmoke — the Bezout tier is compiled out of a bundle that cannot reach it.
//
// `MANTLE_NO_BEZOUT` guards three blocks of the fill ubershader — the kind-4 3x3 Bezout
// determinant and its cofactor gradient, the whole kind-12 curve band, and the interior
// chain's SECOND outline arc — and it drops aC1/aC2 from `lbVertexSetup`'s signature with
// them, so two vec4 varyings (and, under MANTLE_LB_CURVE_TEX, two texel fetches per vertex)
// go too. The packer answers the presence question per mesh (`hasBezout`, which ORs
// `interiorHasChain2` because chain 2 lives in aC1/aC2), that flag crosses the worker wire,
// and the renderer reads it to emit the define.
//
// What this pins (and a fourth, below: the kind-4 body alone):
//   1. a bundle whose every mesh reports hasBezout === false compiles MANTLE_NO_BEZOUT;
//   2. one mesh that reports true keeps the full program — the flag is a UNION, not a vote;
//   3. UNKNOWN (undefined — a pre-flag pack, a CPatch pack, a morph segment without one)
//      is not absent, and a CPatch bundle never takes the define whatever Loop-Blinn's
//      meshes say, because CPatch parks its oriented bounding box in those same slots.
//
// Driven from Node against a stub GL: attachFillPass and attachUnifiedFillDraw both run
// headless, so this pins the real define selection rather than a restatement of the rule.
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
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const { attachFillPass } = await import('../src/renderer/fillPass.js');
const { attachUnifiedFillDraw } = await import('../src/renderer/unifiedFillDraw.js');

const makeGl = () =>
  new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null),
    },
  );

// A renderer just complete enough for attachFillPass + attachUnifiedFillDraw. Every variant
// this renderer compiles is tagged 'fill:<key>' / 'fill:prewarm:<key>' through R.program, so
// the tag list IS the define set the draw path chose.
function makeRenderer(opts) {
  const compiled = [];
  const R = {
    gl: makeGl(),
    opts: opts || {},
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

/// The define set the fill pass would compile for this bundle, as a Set.
///
/// A FRESH RENDERER each TIME, deliberately. The variant cache is keyed on the sorted define
/// string, so a second bundle whose defines match the first compiles nothing and reports an
/// EMPTY set — which is indistinguishable from "took no defines" and would have made this
/// harness assert the opposite of what it means on any tree where the two keys coincide.
function definesFor(opts, bundle) {
  const R = makeRenderer(opts);
  R._compiled.length = 0;
  R.prewarmFillVariant(bundle);
  const keys = R._compiled
    .filter((t) => t && t.startsWith('fill:'))
    .map((t) => t.replace(/^fill:(prewarm:)?/, ''));
  const out = new Set();
  for (const k of keys) for (const d of k.split('|')) if (d) out.add(d);
  return out;
}

/// Build a bundle-shaped object carrying real packed Loop-Blinn meshes for one SVG.
async function lbBundleFor(svg) {
  const sec = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const res = buildLbBundle({
    curveFloats: new Float32Array(sec.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: sec.curveRangesByShape,
    numShapes: sec.numShapes,
  });
  const meshes = res.packed.map((pk) =>
    pk && !pk.slug && (pk.vertexCount | 0) > 0
      ? {
          verts: pk.verts,
          vertexCount: pk.vertexCount,
          hasBezout: !!pk.hasBezout,
          prim: !!pk.prim,
          kindMask: pk.kindMask | 0,
        }
      : null,
  );
  return {
    numShapes: sec.numShapes,
    numFillShapes: sec.numShapes,
    drawList: [{ kind: 'shape', shapeIdx: 0 }],
    segTypeMask: 0xf,
    _lbMeshes: meshes,
    _geomGen: 1,
    _lbAdoptKey: 0,
    meshes,
  };
}

// A rectangle: straight edges only — INTERIOR + EDGE_STRIP, and no Bezout tier anywhere.
const RECT =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M10 10 L90 10 L90 90 L10 90 Z"/></svg>';
// A curved blob: the packer emits kind-12 curve bands, which live in the Bezout tier
// (they read aC2.xy for their end normals) — the full program.
const BLOB =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';

console.log("\n  presence, from the packer's own flag:");
const rectB = await lbBundleFor(RECT);
const blobB = await lbBundleFor(BLOB);
const rectHas = rectB.meshes.some((m) => m && m.hasBezout);
const blobHas = blobB.meshes.some((m) => m && m.hasBezout);
ok(
  rectB.meshes.some((m) => m && (m.vertexCount | 0) > 0),
  'the straight-edge fixture built a mesh',
);
ok(
  blobB.meshes.some((m) => m && (m.vertexCount | 0) > 0),
  'the curved fixture built a mesh',
);
ok(!rectHas, 'the straight-edge bundle reports hasBezout false on every mesh');
ok(blobHas, 'the curved bundle has at least one Bezout-tier mesh');

// A missing predicate is a FAILURE, not a crash: a tree with no `_lbNoBezout` at all must
// print FAIL lines, because a stack trace in their place is exactly what makes a red smoke
// read as an environment problem.
const noBez = (R, b) => (typeof R._lbNoBezout === 'function' ? R._lbNoBezout(b) : 'ABSENT');
{
  const R = makeRenderer({ aacFill: 'auto' });
  ok(noBez(R, rectB) === true, '_lbNoBezout: true for the Bezout-free bundle');
  ok(noBez(R, blobB) === false, '_lbNoBezout: false for the curve-band bundle');
}

// Later morph intervals may need kernels absent from the static fallback.
{
  const R = makeRenderer({ aacFill: 'auto' });
  const b = {
    ...rectB,
    _lbMeshes: [{ vertexCount: 3, kindMask: 1, hasBezout: false, hasCubicChain: false }],
  };
  ok(
    R._lbKindMask(b) === 1 && noBez(R, b),
    'static fallback specializes before interval preparation',
  );
  b._morphMeshes = [
    {
      segments: [
        { vertexCount: 3, kindMask: 1, hasBezout: false, hasCubicChain: false },
        { vertexCount: 3, kindMask: 1 << 12, hasBezout: true, hasCubicChain: true },
      ],
    },
  ];
  ok(
    R._lbKindMask(b) === (1 | (1 << 12)),
    'arrival of interval meshes invalidates the cached kind union',
  );
  ok(
    !noBez(R, b) && !R._lbNoCubicChain(b),
    'later intervals retain Bezout and cubic-chain kernels',
  );
  b._morphMeshes = [{ segments: [{ vertexCount: 3 }] }];
  ok(
    R._lbKindMask(b) === -1,
    'unknown interval kinds retain all kernels despite a known static fallback',
  );
  b._morphMeshes = null;
  ok(
    R._lbKindMask(b) === 1 && noBez(R, b),
    'removing interval meshes restores the static specialization',
  );
}

console.log('\n  the define reaches the compiled variant:');
{
  const d = definesFor({ aacFill: 'auto' }, rectB);
  ok(d.has('MANTLE_LB_FILL'), 'the Bezout-free bundle still takes the unified fill route');
  ok(d.has('MANTLE_NO_BEZOUT'), 'MANTLE_NO_BEZOUT is compiled for it');
  const d2 = definesFor({ aacFill: 'auto' }, blobB);
  ok(d2.has('MANTLE_LB_FILL'), 'the curve-band bundle takes the unified fill route');
  ok(!d2.has('MANTLE_NO_BEZOUT'), '...and keeps the full program');
}

console.log('\n  unknown is not absent:');
{
  const R = makeRenderer({ aacFill: 'auto' });
  // A pack from before the flag existed: no hasBezout field at all.
  const legacy = {
    ...rectB,
    _geomGen: 2,
    _lbMeshes: rectB.meshes.map((m) =>
      m ? { verts: m.verts, vertexCount: m.vertexCount, kindMask: m.kindMask } : null,
    ),
  };
  ok(noBez(R, legacy) === false, 'a mesh with no hasBezout field keeps the full program');
  // One of several meshes says true — the union, not a vote.
  const mixed = {
    ...rectB,
    _geomGen: 3,
    _lbMeshes: rectB.meshes.concat([
      { verts: new Float32Array(24), vertexCount: 1, hasBezout: true, kindMask: 1 << 4 },
    ]),
  };
  ok(noBez(R, mixed) === false, 'one Bezout-bearing mesh among many keeps the full program');
  // No meshes at all: the bundle has not built, and nothing is known.
  ok(noBez(R, { _geomGen: 4 }) === false, 'a bundle with no meshes keeps the full program');
}

console.log('\n  CPatch shares the slots the define drops:');
{
  // CPatch publishes itself into the kind mask as bit 14 and parks its oriented bounding box
  // in aC1/aC2 (cBoxA/cBoxU/cBoxV = vLB1/vLB2). Its packs carry no hasBezout, so the union
  // already refuses — but the guard beside the define is what must hold if one ever does.
  const cp = {
    ...rectB,
    _geomGen: 5,
    _lbMeshes: rectB.meshes.map((m) => (m ? { ...m, kindMask: m.kindMask | 0 | (1 << 14) } : null)),
  };
  const d = definesFor({ aacFill: 'auto' }, cp);
  ok(d.has('MANTLE_CPATCH'), 'the CPatch bit in the kind mask compiles the CPatch kernel');
  ok(!d.has('MANTLE_NO_BEZOUT'), '...and a CPatch program never drops aC1/aC2');
}

console.log('\n  the kind-4 body, when the tier stays for chain 2:');
{
  // lbPartialAdoption's stars: straight outlines (cubics that are lines) whose chain faces carry chain
  // 2 in aC1/aC2, so the tier's SLOTS stay -- but no kind-4 piece exists, so its 3x3 determinant is
  // dead code, and compiled in it makes the stars' program 1.15-2.13x slower on the GPU.
  const { readFileSync } = await import('fs');
  const star = await lbBundleFor(
    readFileSync(path.join(ROOT, 'examples/smoke/lbPartialAdoption__svg.svg'), 'utf8'),
  );
  const any = (f) => star.meshes.some((m) => m && f(m));
  ok(
    any((m) => m.hasBezout) && !any((m) => m.kindMask & (1 << 4)),
    'the stars carry chain 2 (hasBezout) and no kind-4 piece',
  );
  const d = definesFor({ aacFill: 'auto' }, star);
  ok(
    d.has('MANTLE_LB_FILL') && !d.has('MANTLE_NO_BEZOUT'),
    '...so they keep aC1/aC2 (no MANTLE_NO_BEZOUT)',
  );
  ok(
    d.has('MANTLE_LB_NO_CUBIC_BEZ'),
    '...and compile the kind-4 determinant out (MANTLE_LB_NO_CUBIC_BEZ)',
  );
  // A kind-4 piece anywhere keeps it; unknown keeps it.
  const withBez = {
    ...star,
    _geomGen: 7,
    _lbMeshes: star.meshes.concat([
      { verts: new Float32Array(24), vertexCount: 1, hasBezout: true, kindMask: 1 << 4 },
    ]),
  };
  ok(
    !definesFor({ aacFill: 'auto' }, withBez).has('MANTLE_LB_NO_CUBIC_BEZ'),
    'one kind-4 piece keeps the determinant',
  );
  const legacy = {
    ...star,
    _geomGen: 8,
    _lbMeshes: star.meshes.map((m) =>
      m ? { verts: m.verts, vertexCount: m.vertexCount, hasBezout: true } : null,
    ),
  };
  ok(
    !definesFor({ aacFill: 'auto' }, legacy).has('MANTLE_LB_NO_CUBIC_BEZ'),
    'a mesh with no kind mask keeps it (unknown is not absent)',
  );
  // ...and a Bezout-free bundle already drops the whole tier, so it needs no second define.
  ok(
    !definesFor({ aacFill: 'auto' }, rectB).has('MANTLE_LB_NO_CUBIC_BEZ'),
    'MANTLE_NO_BEZOUT alone covers a Bezout-free bundle',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
