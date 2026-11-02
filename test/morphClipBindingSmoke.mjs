// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Matched rows retain source clip bindings. Destination-only bindings are
// remapped, and compatible clip geometry retains exact native curve ranges.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { buildMorphPlan, composeMorphSections } from '../src/core/morphCore.js';
import { setDiagnostics } from '../src/core/diagnostics.js';
import {
  META_CLIP_ID,
  META_FLAGS_SHAPE,
  FS_LAYER,
  META_FLOATS_PER_SHAPE,
} from '../src/bundle/layout.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const STRIDE = META_FLOATS_PER_SHAPE;

let warns = [];
setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });

const asBundle = (b) => ({
  ...b,
  metaFloats: b.meta.byteLength >= 32 ? new Float32Array(b.meta, 32) : new Float32Array(0),
  curveFloats: new Float32Array(b.curves),
  shapeIds: b.shapeIds || [],
});
const load = async (svg) => asBundle(await importSvg(svg, {}));

const svg = (body, clipBody = '<rect id="cl" x="20" y="20" width="60" height="60"/>') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<defs><clipPath id="c1">${clipBody}</clipPath></defs>${body}</svg>`;
const rect = (id, x, clip) =>
  `<rect id="${id}" x="${x}" y="10" width="30" height="30" fill="#345"` +
  (clip ? ' clip-path="url(#c1)"' : '') +
  '/>';

const clipOf = (meta, row) => Math.round(meta[row * STRIDE + META_CLIP_ID]);
const isLayer = (meta, row) => ((meta[row * STRIDE + META_FLAGS_SHAPE] | 0) & FS_LAYER) !== 0;
const mergedMeta = (m) => new Float32Array(m.meta, 32);

// ===========================================================================
console.log('\n-- the clip layout the rest of this file reasons about --');
{
  const b = await load(svg(rect('a', 10, true)));
  ok(
    b.numShapes === 2,
    `one clipped rect imports as 2 rows — the shape and its clip layer (got ${b.numShapes})`,
  );
  ok(
    !isLayer(b.metaFloats, 0) && isLayer(b.metaFloats, 1),
    'row 0 is the visible shape, row 1 carries FS_LAYER',
  );
  ok(
    clipOf(b.metaFloats, 0) === 2,
    `the shape's clipId is the 1-based index of that layer row (got ${clipOf(b.metaFloats, 0)})`,
  );
}

// ===========================================================================
console.log(
  '\n-- a matched pair keeps its source clip until t = 1, then takes the destination binding --',
);
{
  const src = await load(svg(rect('a', 10, true)));
  const dst = await load(svg(rect('a', 40, false)));
  warns = [];
  const plan = buildMorphPlan(src, dst);
  const m = composeMorphSections(src, dst, plan);
  const meta = mergedMeta(m);
  ok(
    clipOf(src.metaFloats, 0) === 2 && clipOf(dst.metaFloats, 0) === 0,
    'the pair genuinely disagrees: src clips this shape, dst does not',
  );
  ok(clipOf(meta, 0) === 2, "the merged row keeps SRC's binding — this is the constraint");
  const steps = m._morphBindingSteps;
  ok(
    steps.length === 1 &&
      steps[0].row === 0 &&
      steps[0].slot === META_CLIP_ID &&
      steps[0].value === 0,
    `the destination's unclipped binding is a t = 1 step (${JSON.stringify(steps)})`,
  );
  ok(m._dstAlignedMetaF32[META_CLIP_ID] === 0, 'the destination plane carries the t = 1 binding');
  ok(
    warns.length === 0,
    `a resolvable binding change is policy, not a warning (${JSON.stringify(warns)})`,
  );
}
{
  // The same pair with no disagreement must not warn — a warning on every
  // morph would be worse than none.
  const src = await load(svg(rect('a', 10, true)));
  const dst = await load(svg(rect('a', 40, true)));
  warns = [];
  composeMorphSections(src, dst, buildMorphPlan(src, dst));
  ok(warns.length === 0, `an agreeing pair is silent (got ${JSON.stringify(warns)})`);
}

// ===========================================================================
console.log("\n-- a dst-only shape's binding is TRANSLATED into the merged plane --");
{
  // src: [a, z]                      (2 rows, nothing clipped)
  // dst: [a, b, clipLayer]           (3 rows) — b is dst-only and clipped, so
  //      its clipId is 3 (dst row 2). The merged plane is [a, z, b, clipLayer],
  //      so row 3 is b ITSELF: unadjusted, b would be clipped to its own
  //      silhouette, and a different layout would clip it to a stranger's.
  //      Translated through the plan the clip layer is merged row 3 (index 3),
  //      so the binding must become 4.
  const src = await load(svg(rect('a', 10, false) + rect('z', 50, false)));
  const dst = await load(svg(rect('a', 40, false) + rect('b', 60, true)));
  ok(
    clipOf(dst.metaFloats, 1) === 3,
    `dst's own layout puts b's clip at row 3 (got ${clipOf(dst.metaFloats, 1)})`,
  );
  warns = [];
  const plan = buildMorphPlan(src, dst);
  const m = composeMorphSections(src, dst, plan);
  const meta = mergedMeta(m);
  const bRow = src.numShapes; // dst-only rows are appended after src's
  ok(
    !isLayer(meta, 2) && isLayer(meta, 3),
    'in the merged plane the clip layer moved from index 2 to index 3',
  );
  ok(
    clipOf(meta, bRow) === 4,
    `b's binding was re-pointed at the layer row's NEW index (got ${clipOf(meta, bRow)}, want 4)`,
  );
  ok(warns.length === 0, `a translatable binding is silent (${JSON.stringify(warns)})`);
}
{
  // ...and a binding that cannot be translated is dropped rather than left
  // pointing somewhere arbitrary. Forged: dst's clipped row is made to point at
  // a VISIBLE dst row, which no plan can turn into a clip. (The importer never
  // writes this; the path exists because a plan CAN split a multi-row clip, and
  // a defensive branch with no test is a branch that rots.)
  const src = await load(svg(rect('a', 10, false) + rect('z', 50, false)));
  const dst = await load(svg(rect('a', 40, false) + rect('b', 60, true)));
  dst.metaFloats[1 * STRIDE + META_CLIP_ID] = 1; // -> dst row 0, a visible shape
  warns = [];
  const m = composeMorphSections(src, dst, buildMorphPlan(src, dst));
  const meta = mergedMeta(m);
  ok(
    clipOf(meta, src.numShapes) === 0,
    `an untranslatable binding is cleared (got ${clipOf(meta, src.numShapes)})`,
  );
  ok(
    warns.some((w) => /dropped 1 destination clip\/mask binding/.test(w)),
    `the drop is reported (${JSON.stringify(warns)})`,
  );
}
{
  // ...and the case that must NOT be cleared: the two planes agree, so dst's
  // index still points at a real layer row in the merged plane.
  // src: [a, z, clipLayer]  dst: [a, b, clipLayer]  -> merged [a, z, clipLayer, b]
  // b's clipId is 3, and merged row 3 IS the clip layer.
  const src = await load(svg(rect('a', 10, true) + rect('z', 50, true)));
  const dst = await load(svg(rect('a', 40, true) + rect('b', 60, true)));
  ok(src.numShapes === 3 && dst.numShapes === 3, 'both sides are two visible rows plus one layer');
  ok(
    isLayer(src.metaFloats, 2) && clipOf(dst.metaFloats, 1) === 3,
    'the layer sits at the same index on both sides',
  );
  warns = [];
  const plan = buildMorphPlan(src, dst);
  const m = composeMorphSections(src, dst, plan);
  const meta = mergedMeta(m);
  const bRow = plan.finalShapeCount - 1;
  ok(clipOf(meta, bRow) === 3, `a binding that still resolves is kept (got ${clipOf(meta, bRow)})`);
  ok(
    !warns.some((w) => /dropped/.test(w)),
    `and nothing is reported dropped (${JSON.stringify(warns)})`,
  );
}

// ===========================================================================
console.log('\n-- the clip PATH itself is not frozen --');
{
  // The clipPath's child carries an id, so the plan matches it like any other
  // shape and setT lerps its curves. This is the supported way to animate a
  // clip across a morph.
  const src = await load(
    svg(rect('a', 10, true), '<rect id="cl" x="20" y="20" width="60" height="60"/>'),
  );
  const dst = await load(
    svg(rect('a', 10, true), '<rect id="cl" x="10" y="10" width="80" height="80"/>'),
  );
  const plan = buildMorphPlan(src, dst);
  const layerRow = 1;
  const matchedLayer = plan.matched.some((p) => p.srcIdx === layerRow);
  ok(
    matchedLayer,
    'the clip layer row is MATCHED by the plan, so its curves participate in the lerp',
  );
  const m = composeMorphSections(src, dst, plan);
  // The two clip rects have different bboxes; the dst-aligned plane is what the
  // per-t lerp reads, so it must carry DST's clip bbox in the src row's slot —
  // which is what makes the clip deform rather than sit still.
  const sourceRange = src.curveRangesByShape[layerRow];
  const paintRange = src.curveRangesByShape[0];
  ok(
    sourceRange.end - sourceRange.begin === paintRange.end - paintRange.begin,
    'a rectangle layer range contains native records only, like the paint rectangle',
  );
  ok(
    Array.isArray(m.curveRangesByShape) && m.curveRangesByShape.length === plan.finalShapeCount,
    'composed sections retain every explicit curve range',
  );
  ok(
    m.curveRangesByShape &&
      m.curveRangesByShape[layerRow].begin === sourceRange.begin &&
      m.curveRangesByShape[layerRow].end === sourceRange.end,
    'the merged layer retains its exact source range',
  );
  const dstAligned = m._dstAlignedMetaF32;
  ok(!!dstAligned, 'the composition exposes the dst-aligned meta plane the lerp reads');
  ok(
    dstAligned &&
      Math.round(dstAligned[layerRow * STRIDE]) === 10 &&
      Math.round(mergedMeta(m)[layerRow * STRIDE]) === 20,
    "src's clip bbox is 20 and dst's is 10 in the SAME slot — setT lerps between them" +
      ` (got ${dstAligned && dstAligned[layerRow * STRIDE]} vs ${mergedMeta(m)[layerRow * STRIDE]})`,
  );
}

for (const resource of ['clipPath', 'mask']) {
  const attr = resource === 'mask' ? 'mask' : 'clip-path';
  const defs = `<defs><${resource} id="c"><rect id="same" width="16" height="16" fill="white"/></${resource}><${resource} id="d"><rect id="same" width="16" height="16" fill="white"/></${resource}></defs>`;
  const body = ['c', 'd', 'c']
    .map(
      (id, i) =>
        `<g transform="translate(${8 + 16 * i} 8)" ${attr}="url(#${id})"><rect id="paint${i}" width="24" height="16"/></g>`,
    )
    .join('');
  const b = await load(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40">${defs}${body}</svg>`,
  );
  const groups = b.clipperRowSets.c;
  const foreign = b.clipperRowSets.d.flat();
  ok(
    groups.length === 2 && groups.flat().every((r) => !foreign.includes(r)),
    `${resource}: exact row groups preserve both placed instances and exclude foreign rows`,
  );
  const plan = buildMorphPlan(b, b);
  ok(
    plan.matched.length === b.numShapes && plan.srcOnly.length === 0 && plan.dstOnly.length === 0,
    `${resource}: repeated internal child IDs match by occurrence without fades`,
  );
  const merged = composeMorphSections(b, b, plan);
  ok(
    JSON.stringify(merged.clipperRowSets.c) === JSON.stringify(groups),
    `${resource}: morph composition retains exact placed row groups`,
  );
}

// Resource IDs are authored strings, including Object prototype property names.
{
  const section = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><clipPath id="constructor"><rect width="16" height="16"/></clipPath></defs><rect width="32" height="32" clip-path="url(#constructor)"/></svg>',
  );
  ok(Array.isArray(section.clipperRowSets.constructor), 'prototype-named clip retains exact rows');
}

setDiagnostics({ onWarn: null });

// A truly empty SVG does not supply a paint frame; adopt the target's viewport.
{
  const source = asBundle(
    await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"/>', {
      preserveViewport: true,
    }),
  );
  const target = asBundle(
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect x="40" y="16" width="24" height="24"/></svg>',
      { preserveViewport: true },
    ),
  );
  const merged = composeMorphSections(source, target, buildMorphPlan(source, target));
  const header = new DataView(merged.meta);
  const frame = [0, 1, 2, 3].map((i) => header.getFloat32(4 + i * 4, true));
  ok(
    frame.every((v, i) => v === target.globalBBox[i]),
    'empty source adopts target frame',
  );
  ok(merged.flags === target.flags, 'empty source adopts target band layout flags');
}

{
  const source = asBundle(
    await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"/>', {
      preserveViewport: true,
    }),
  );
  const target = asBundle(
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect id="new" x="40" y="16" width="24" height="24"/></svg>',
      { preserveViewport: true },
    ),
  );
  const out = composeMorphSections(source, target, buildMorphPlan(source, target));
  if (!(out.curveRangesByShape[0].begin >= 4))
    throw new Error('empty morph overwrites reserved curve location zero');
}
console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
