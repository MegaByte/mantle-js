// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverKernelPerEntrySmoke — the cover-quad kernel id rides the stream, and the fragment recovers
// exactly the id the meta row carries.
//
// Every row resolves to the kernel its per-shape arm would pick, PROVEN BYTE-IDENTICAL; the per-entry
// id is the unified route's only id source, which (g) pins.
//
// WHY THE PROOF IS BUILT this WAY. The test tools include no GLSL compiler (`glslangValidator`) and
// a shader error blanks silently, so "proven byte-identical on a render" is out of reach here.
// test/_glslEmu.mjs compiles the SHIPPED shader text to float32 C++ and can run a function out of it
// directly, so the whole risk sits in ONE liftable expression — `coverKernelId` — and that
// expression is held to its own per-shape arm over every input the renderer can produce. Float32
// matters here and a float64 model would not do: `int(-kindV - 1.0 + 0.5)` is a rounding decision,
// and a float64 model can pass a form that fails in the shader (`A + t*(B-A)` canceling).
//
// WHAT IS PROVEN
//   (a) the two arms of `coverKernelId` agree for every flagsShape a bundle can carry, in float32,
//       compiled from src/shaders/generated/mantle.frag.glsl;
//   (b) `vKind = -1 - id` survives the round trip for every id, and the ±0.5 rounding has a full
//       half-unit of slack either side, so a flat varying cannot land on the wrong id;
//   (c) the id rides `aLbMeta.y` and leaves `.x` (the IS-LB test) and `.z` (vSeam) at zero, so no
//       other consumer of the stream can see it;
//   (d) with no id stamped the stream is the one the per-shape program drew, and the
//       coefficient-texture dedup is unaffected either way;
//   (e) the ids the draw stamps ARE the row's flagsShape bits, on a real imported mixed asset;
//   (f) the engine ledger resolves MANTLE_COVER_KERNEL to the mixed kernel, so a unified mixed draw
//       cannot report Slug while a mixed program draws;
//   (g) the unified route binds the per-entry program and stamps every cover entry (no switch).
//
// WHAT IS NOT PROVEN HERE, and is left to a GPU: that the linked program draws the same pixels.
// The kernels, their order and their arguments are shared with the per-shape chain and the id is
// proven equal, so the remaining risk is the link itself — which is exactly the risk a missing
// `glslangValidator` leaves for every shader change, and the render lane is the check for it.
//
// A tree without the per-entry id FAILS: `coverKernelId` is not in the shader text (liftFn throws),
// `appendCoverQuads` takes no id, and coverKernelOfVariantKey resolves MANTLE_COVER_KERNEL to Slug.
import path from 'path';
import { fileURLToPath } from 'url';
import {
  UNIFIED_STRIDE,
  U_POS,
  U_LBMETA,
  U_SHAPEIDX,
  buildUnifiedFillVerts,
  buildCurveTexStream,
  UC_STRIDE,
  UC_LBMETA,
} from '../src/renderer/unifiedFillVerts.js';
import { coverKernelOfVariantKey, ENGINES } from '../src/renderer/engineLedger.js';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { META_FLAGS_SHAPE, META_FILL_A } from '../src/bundle/layout.js';
import { hasCxx, buildGlslEmu, K_COVER_KID } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- (c)(d) the stream ---------------------------------------------------------------------
{
  const cover = new Float32Array(6 * 12);
  for (let i = 0; i < 6; i++) {
    const o = i * 12;
    cover[o] = 10 + i;
    cover[o + 1] = 20 + i;
    cover[o + 4] = 30 + i;
    cover[o + 5] = 40 + i;
  }
  const shapeIdx = new Float32Array([3, 3, 3, 9, 9, 9]);
  const lb = new Float32Array(3 * 24);
  for (let i = 0; i < 3; i++) {
    const o = i * 24;
    lb[o] = 100 + i;
    lb[o + 5] = 12;
    lb[o + 6] = -1;
    lb[o + 23] = 6;
  }

  const mk = (kidA, kidB) =>
    buildUnifiedFillVerts(
      [
        { kind: 'cover', srcVert: 0, count: 3, shapeIdx: 3, coverKid: kidA },
        { kind: 'lb', verts: lb, vertexCount: 3, shapeIdx: 5 },
        { kind: 'cover', srcVert: 3, count: 3, shapeIdx: 9, coverKid: kidB },
      ],
      cover,
      shapeIdx,
    );

  const off = mk(0, 0),
    on = mk(2, 3);
  ok(
    off.verts.length === on.verts.length && off.vertexCount === 9,
    `the stream is ${off.vertexCount} vertices either way`,
  );

  let stampedOk = true,
    otherSlots = true;
  for (let v = 0; v < 9; v++) {
    const d = v * UNIFIED_STRIDE,
      isCover = v < 3 || v >= 6;
    if (!isCover) continue;
    const want = v < 3 ? 2 : 3;
    if (on.verts[d + U_LBMETA + 1] !== want) stampedOk = false;
    // .x must stay 0 — `aLbMeta.x > 0.5` IS the "this is an LB vertex" test — and .z is vSeam.
    if (on.verts[d + U_LBMETA] !== 0 || on.verts[d + U_LBMETA + 2] !== 0) otherSlots = false;
  }
  ok(stampedOk, "each cover entry's id lands on aLbMeta.y for every one of its vertices");
  ok(
    otherSlots,
    'aLbMeta.x stays 0 (the IS-LB test) and aLbMeta.z stays 0 (vSeam) on a stamped cover vertex',
  );

  // The LB half is untouched: kind, sign and seam are still the packer's.
  const dl = 3 * UNIFIED_STRIDE;
  ok(
    on.verts[dl + U_LBMETA] === 13 &&
      on.verts[dl + U_LBMETA + 1] === -1 &&
      on.verts[dl + U_LBMETA + 2] === 6,
    'an LB vertex keeps kind (biased), sign and seamM — appendLbMesh is untouched',
  );

  // (d) byte identity with the flag off. Every float, not a spot check.
  let same = off.verts.length === mk(0, 0).verts.length;
  const off2 = mk(0, 0);
  for (let i = 0; same && i < off.verts.length; i++)
    if (off.verts[i] !== off2.verts[i]) same = false;
  ok(
    same,
    'with no id stamped the stream is byte-identical to itself — the default path writes the same zero it always wrote',
  );

  // ...and the id must not disturb the coefficient-texture dedup, which keys on the 16 coefficient
  // floats alone. Cover vertices all carry the same all-zero block and must still collapse to one.
  const tOff = buildCurveTexStream(off.verts, 9, false),
    tOn = buildCurveTexStream(on.verts, 9, false);
  ok(
    tOff && tOn && tOff.blocks === tOn.blocks,
    `the coefficient dedup is unaffected: ${tOff && tOff.blocks} blocks either way`,
  );
  let carried = true;
  for (let v of [0, 1, 2, 6, 7, 8]) {
    const want = v < 3 ? 2 : 3;
    if (tOn.verts[v * UC_STRIDE + UC_LBMETA + 1] !== want) carried = false;
  }
  ok(carried, 'the narrow curve-texture stream carries the id through unchanged');
}

// ---- (f) the engine ledger -----------------------------------------------------------------
{
  ok(
    coverKernelOfVariantKey('MANTLE_COVER_KERNEL|MANTLE_GWN|MANTLE_LB_FILL', false) ===
      ENGINES.HARD_MIXED,
    'the engine ledger resolves MANTLE_COVER_KERNEL to the MIXED kernel, not Slug',
  );
  ok(
    coverKernelOfVariantKey('MANTLE_AAC|MANTLE_COVER_KERNEL|MANTLE_LB_FILL', false) ===
      ENGINES.HARD_MIXED_AAC,
    '...and to the AAC pairing when the program compiled AAC',
  );
  ok(
    coverKernelOfVariantKey('MANTLE_HARD_MIXED|MANTLE_GWN', false) === ENGINES.HARD_MIXED,
    '...and the per-shape spelling is unchanged',
  );
}

// ---- (e) the ids the draw stamps are the row's own bits -------------------------------------
const REAL_FLAGS = [];
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  // mixedHardFillSmoke's own asset shape: fills whose edge a later opaque stroke provably hides,
  // which is the only thing that sets bits 15-16 at import.
  const blob = (cx, cy, r) =>
    `M${cx - r} ${cy} C${cx - r} ${cy - r} ${cx + r} ${cy - r} ${cx + r} ${cy}` +
    ` C${cx + r} ${cy + r} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
  const paths = Array.from(
    { length: 6 },
    (_, i) =>
      `<path d="${blob(20 + (i % 3) * 30, 25 + ((i / 3) | 0) * 45, 13)}" fill="#c0392b" stroke="#1a1a1a" stroke-width="9" stroke-linejoin="round"/>`,
  ).join('');
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 110">${paths}</svg>`,
  );
  const { parseMetaBin } = await import('../src/core/metaBin.js');
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const meta = pm.metaFloats,
    st = pm.floatsPerShape | 0;
  const bits = [];
  for (let s = 0; s < b.numShapes; s++)
    if (meta[s * st + META_FILL_A] > 0)
      bits.push(((meta[s * st + META_FLAGS_SHAPE] | 0) >> 15) & 3);
  ok(
    b.noAaMixed === true,
    `the asset is a MIXED bundle (noAaMixed ${b.noAaMixed}) — without that this arm proves nothing`,
  );
  ok(
    bits.length > 0 && bits.some((v) => v === 2),
    `its fill rows carry hard-band bits: [${bits.join(',')}]`,
  );
  // Every meta row's whole word, handed to the shader arm below: the identity is then asserted on
  // words an importer actually produced, not only on hand-built ones.
  for (let s = 0; s < b.numShapes; s++) REAL_FLAGS.push(meta[s * st + META_FLAGS_SHAPE] | 0);
  ok(
    REAL_FLAGS.length === b.numShapes,
    `${REAL_FLAGS.length} real flagsShape words go to the shader arm`,
  );

  // (g) IT IS THE ROUTE'S only ID SOURCE, not a switch. Behind an unset switch the route would bind MANTLE_HARD_MIXED and stamp 0 on every
  // entry, which is what both halves fail on.
  //   (g1) the ENTRY BUILDER (unifiedFillDraw's own, on a stub context) stamps every cover entry of
  //        this asset with its row's bits;
  //   (g2) the real renderer, headless on test/_fakeGl.mjs, BINDS the per-entry program for a mixed
  //        bundle on the unified route (`unifiedFill: 'force'` with no meshes, so every row is a cover
  //        quad and the kernel ids are the only thing under test) under the 'auto' kernel.
  {
    const { attachUnifiedFillDraw } = await import('../src/renderer/unifiedFillDraw.js');
    const RS = {
      gl: {},
      opts: { unifiedFill: 'force' },
      draw: {},
      _lbFillMode: 'on',
      _coverChunkStart: (c) => c.vboStart | 0,
      filterRecord: () => null,
    };
    attachUnifiedFillDraw(RS);
    const drawList = [];
    for (let s2 = 0; s2 < b.numShapes; s2++)
      drawList.push({ kind: 'fillShape', shapeIdx: s2, chunk: { vboStart: s2 * 6, count: 6 } });
    const entries =
      RS._unifiedFillEntriesFor({
        drawList,
        metaFloats: meta,
        metaFloatsPerShape: st,
        numShapes: b.numShapes,
      }) || [];
    const covers = entries.filter((e) => e.kind === 'cover');
    const rowBits = (sIdx) => ((meta[sIdx * st + META_FLAGS_SHAPE] | 0) >> 15) & 3;
    ok(
      covers.length === b.numShapes && covers.every((e) => e.coverKid === rowBits(e.shapeIdx)),
      `(g1) every cover entry carries its own row's kernel id (${covers.map((e) => e.coverKid).join(',')})`,
    );
    ok(
      covers.some((e) => e.coverKid === 2),
      '...and some of them are hard rows, or the check above is vacuous',
    );
  }
  {
    const { createBundle, createRenderer } = await import('../src/index.js');
    // MIXED, not whole-bundle hard: two of the fills have no covering stroke.
    const plain = `<path d="${blob(20, 95, 9)}" fill="#2980b9"/><path d="${blob(80, 95, 9)}" fill="#27ae60"/>`;
    const sec = await importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 110">${paths}${plain}</svg>`,
    );
    ok(
      sec.noAaMixed === true && !sec.noAaFill,
      `(g2) the asset is per-row mixed (noAaMixed ${sec.noAaMixed}, noAaFill ${!!sec.noAaFill})`,
    );
    const F = createFakeGl({ width: 256, height: 256 });
    const R = createRenderer(F.gl, taggedShaderSources(), { unifiedFill: 'force' });
    // The route OFF builds no mesh, so under 'force' every row rides the unified stream as a cover
    // quad -- which is what keeps the per-row kernel in the program (coverKernelPresenceSmoke).
    R.setFillEngine({ route: 'none', kernel: 'auto' });
    const bundle = createBundle(F.gl, sec);
    if (R.prepareBundle) R.prepareBundle(bundle);
    if (R.awaitLbReady) {
      try {
        await R.awaitLbReady(bundle, 20000);
      } catch {
        /* the key check reports it */
      }
    }
    R.setViewport(256, 256);
    R.prewarmBundle(bundle);
    let key = '';
    for (let i = 0; i < 12 && !key; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(bundle);
      R.endFrame();
      R.precompileFills();
      key = R.debugStats.drawnFillVariantKey || '';
    }
    const defs = key.split('|');
    ok(
      defs.includes('MANTLE_LB_FILL') &&
        defs.includes('MANTLE_COVER_KERNEL') &&
        !defs.includes('MANTLE_HARD_MIXED'),
      `(g2) the unified mixed draw binds the per-ENTRY program, never MANTLE_HARD_MIXED (bound: ${key || 'the base program'})`,
    );
    try {
      R.dispose();
    } catch {
      /* headless */
    }
  }
}

// ---- (a)(b) the shader text itself ----------------------------------------------------------
if (!hasCxx()) {
  console.log('  -- SKIP the shader arm: no C++ compiler ($CXX, clang++, g++, c++)');
} else {
  const LB = ['MANTLE_LB_FILL', 'MANTLE_GWN'];
  const perShape = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD_MIXED', ...LB], coverKernel: true });
  const perEntry = buildGlslEmu(ROOT, {
    defines: ['MANTLE_COVER_KERNEL', ...LB],
    coverKernel: true,
  });
  const band = new Float32Array(4),
    curve = new Float32Array(4);
  const q = (flags, kindV) => ({
    k: K_COVER_KID,
    GD: [0, 0, 0, 0],
    bb: [flags, 0, 0, 0],
    eo: false,
    c: [kindV, 0],
    ePx: [1, 1],
  });

  // Every flagsShape a bundle can carry: bits 0,1,8,9-12,13,14 are taken and 17+ are free, so
  // sweep the whole low word together with the two id bits rather than a hand-picked few.
  const flagsSet = [];
  for (const lo of [
    0, 1, 2, 3, 0x100, 0x400, 0x800, 0x1000, 0x1c00, 0x2000, 0x4000, 0x6000, 0x7fff,
  ])
    for (let id = 0; id < 4; id++) flagsSet.push(lo | (id << 15));
  for (const extra of [0x20000, 0x40000, 0x7e0000])
    for (let id = 0; id < 4; id++) flagsSet.push(extra | (id << 15));
  for (const f of REAL_FLAGS) flagsSet.push(f);

  const qs = flagsSet.map((f) => q(f, 0));
  const got = perShape.run(band, curve, qs);
  let shapeOk = true;
  for (let i = 0; i < flagsSet.length; i++)
    if (got[i] !== ((flagsSet[i] >> 15) & 3)) shapeOk = false;
  ok(
    shapeOk,
    `the per-SHAPE arm reads bits 15-16 over ${flagsSet.length} flagsShape values, and nothing else in the word reaches it`,
  );

  // (b) the round trip, and its slack. A FLAT varying carries -1 - id exactly, but the rounding has
  // to be robust anyway, so sweep the half-unit either side of each id.
  const kidQs = [],
    kidWant = [];
  for (let id = 0; id < 8; id++)
    for (const dv of [0, 1e-7, -1e-7, 1e-4, -1e-4, 0.4, -0.4, 0.49, -0.49]) {
      kidQs.push(q(0, -1 - id + dv));
      kidWant.push(id);
    }
  const kidGot = perEntry.run(band, curve, kidQs);
  let tripOk = true,
    worst = 0;
  for (let i = 0; i < kidWant.length; i++)
    if (kidGot[i] !== kidWant[i]) {
      tripOk = false;
      worst = i;
    }
  ok(
    tripOk,
    `vKind = -1 - id recovers the id for ids 0..7 with a HALF-UNIT of slack either side (${kidQs.length} float32 queries)` +
      (tripOk ? '' : ` — first miss at ${kidQs[worst].c[0]}, got ${kidGot[worst]}`),
  );

  // (a) THE IDENTITY. For every flagsShape, feeding the per-entry arm the id that row carries gives
  // the per-shape arm's answer. This is step (1)+(2)'s whole claim.
  const idQs = flagsSet.map((f) => q(0, -1 - ((f >> 15) & 3)));
  const idGot = perEntry.run(band, curve, idQs);
  let identical = true;
  for (let i = 0; i < flagsSet.length; i++) if (idGot[i] !== got[i]) identical = false;
  ok(
    identical,
    `the two arms agree on all ${flagsSet.length} rows: the per-entry id recovered from vKind IS the per-shape id, in float32, from the shipped shader text`,
  );

  // NON-VACUITY: the instrument must be able to disagree. Feed the per-entry arm the WRONG id and
  // the comparison has to break, or "identical" above is a tautology about a constant.
  const wrongQs = flagsSet.map((f) => q(0, -1 - ((((f >> 15) & 3) + 1) & 3)));
  const wrongGot = perEntry.run(band, curve, wrongQs);
  let moved = 0;
  for (let i = 0; i < flagsSet.length; i++) if (wrongGot[i] !== got[i]) moved++;
  ok(
    moved === flagsSet.length,
    `shifting the id by one moves ALL ${moved} of ${flagsSet.length} rows — the agreement above is a measurement, not a constant`,
  );

  // ...and the per-entry arm must genuinely IGNORE the meta bits, or it is not per entry at all.
  const ignQs = flagsSet.map((f) => q(f, -1 - 2));
  const ignGot = perEntry.run(band, curve, ignQs);
  let allTwo = true;
  for (let i = 0; i < flagsSet.length; i++) if (ignGot[i] !== 2) allTwo = false;
  ok(
    allTwo,
    "the per-ENTRY arm ignores flagsShape entirely — the id is the entry's, not the row's",
  );
}

console.log(fail ? `coverKernelPerEntrySmoke FAIL (${fail})` : 'coverKernelPerEntrySmoke PASS');
process.exit(fail ? 1 : 0);
