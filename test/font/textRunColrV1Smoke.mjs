// COLRv1 end-to-end: buildTextRun on a v1 font produces a bundle whose
// metas carry a non-zero colrGraphId and whose colrGraphs section
// contains the per-glyph paint trees.

import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();
import { buildColrTestFont } from './_colrFontFixture.mjs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextRun } from '../../src/font/textRun.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else       { console.log('ok:', msg); }
}

// === 1: v1 rich font, single codepoint → one shape with colrGraphId=1 =
{
  // codepoint 'A' (0x41) maps to gid 1. In the rich fixture the
  // top-level paint is PaintGlyph(glyphId=2); gid 1 has no glyf
  // outline, so the FontAsset surface falls back to gid 2's
  // silhouette (a simpleSquare), yielding a 5-node graph.
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Rich: true });
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [1, 0, 0, 1]);
  assert(Array.isArray(bundle.colrGraphs),
         `bundle has a colrGraphs array, got ${typeof bundle.colrGraphs}`);
  assert(bundle.colrGraphs.length === 1,
         `1 v1 glyph → 1 colrGraph entry, got ${bundle.colrGraphs.length}`);
  // colrGraphs entry is { graph, masks }, not a bare DAG.
  const entry = bundle.colrGraphs[0];
  assert(entry && entry.graph && Array.isArray(entry.graph.nodes),
         'colrGraphs[0] is { graph, masks } shape');
  assert(entry.graph.nodes.length === 5,
         `colrGraphs[0].graph has 5 nodes (rich), got ${entry.graph.nodes.length}`);
  assert(entry.masks && typeof entry.masks === 'object',
         'colrGraphs[0].masks present');
  // Rich gid 1 references PaintGlyph(glyphId=2); both gid 1 (primary)
  // and gid 2 (mask) should be in entry.masks.
  assert(typeof entry.masks[1] === 'number',
         `entry.masks has primary gid 1 mapped to a shapeIdx, got ${entry.masks[1]}`);
  assert(typeof entry.masks[2] === 'number',
         `entry.masks has secondary gid 2 mapped to a shapeIdx, got ${entry.masks[2]}`);
  assert(entry.masks[1] !== entry.masks[2],
         'primary and mask-only shapeIdxs are distinct');
  // The shape's meta should carry colrGraphId=1 at texel 11.y (slot 45;
  // slot 44 is primKind).
  const stride = bundle.metaFloatsPerShape;
  let coloredShapeIdx = -1, maskOnlyShapeIdx = -1;
  for (let s = 0; s < bundle.numShapes; s++) {
    const cg = Math.floor(bundle.metaFloats[s * stride + 45] + 0.5);
    if (cg !== 1) continue;
    const flagsShape = Math.floor(bundle.metaFloats[s * stride + 27] + 0.5);
    if ((flagsShape & 256) !== 0) maskOnlyShapeIdx = s;
    else                          coloredShapeIdx = s;
  }
  assert(coloredShapeIdx >= 0,
         'at least one shape with colrGraphId=1 is colored (not mask-only)');
  assert(maskOnlyShapeIdx >= 0,
         'rich gid 1 emitted a mask-only shape for PaintGlyph(gid=2)');
}

// === 2: v0 font (no v1) → empty colrGraphs ============================
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  assert(Array.isArray(bundle.colrGraphs),
         'v0 font also produces a (possibly empty) colrGraphs array');
  assert(bundle.colrGraphs.length === 0,
         `v0 font → no v1 graphs, got ${bundle.colrGraphs.length}`);
  // No meta should have colrGraphId set (texel 11.y / slot 45).
  const stride = bundle.metaFloatsPerShape;
  let anyCg = false;
  for (let s = 0; s < bundle.numShapes; s++) {
    if (Math.floor(bundle.metaFloats[s * stride + 45] + 0.5) !== 0) { anyCg = true; break; }
  }
  assert(!anyCg, 'v0 font: no shape has colrGraphId set');
}

// === 3: v1 simple fixture has no PaintGlyph fallback → degrades to v0 =
{
  // The simple v1 fixture (PaintColrLayers → 2 PaintSolids) has no
  // PaintGlyph node and gid 1 has no glyf outline, so the FontAsset
  // surface returns empty segs. The TextRun branch correctly skips
  // emission and falls through to v0 layers (which DOES have layer
  // glyphs gid 2 + 3 with simpleSquare outlines).
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1: true });
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 1, 0, 1]);
  // The fall-through to v0 means colrGraphs stays empty for this case.
  // (A real font that uses simple v1 layers would also ship a top-level
  // PaintGlyph; the fixture is artificially minimal.)
  assert(bundle.colrGraphs.length === 0,
         `simple v1 (no PaintGlyph + no outline) → v0 fallback, 0 graphs, got ${bundle.colrGraphs.length}`);
}

// === 4: v1 gradient → 1-node graph (but no silhouette in fixture) ====
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Grad: true });
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  // Gradient fixture's gid 1 is a bare PaintLinearGradient — no
  // PaintGlyph anywhere and no outline. TextRun correctly skips.
  assert(bundle.colrGraphs.length === 0,
         `gradient (no silhouette) → 0 graphs, got ${bundle.colrGraphs.length}`);
}

// === 5: gradient nodes baked into bundle.gradientStops ===============
{
  // Synthesize a v1 rich font where gid 1's tree is a gradient-driven
  // PaintGlyph chain. The rich fixture itself only has solid colors;
  // we mutate the FontAsset's getColrV1GraphByGid to inject a
  // gradient at the root for this assertion.
  //
  // Approach: build the rich fixture, intercept the FontAsset's v1
  // graph for gid 1, and replace its root paint with a synthetic
  // linear-gradient PaintMerge so we can verify the bake.
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Rich: true });
  const font = new MantleFontAsset(bytes);
  const originalGetter = font.getColrV1GraphByGid.bind(font);
  font.getColrV1GraphByGid = (gid) => {
    const r = originalGetter(gid);
    if (!r) return r;
    // Inject a linear gradient at node 0 (used by no other node in
    // the rich fixture's existing graph; we just append it).
    const gradNodeIdx = r.graph.nodes.length;
    r.graph.nodes.push({
      type: 'PaintLinearGradient',
      inputs: [],
      params: {
        stops: [
          { offset: 0, color: [1, 0, 0, 1] },
          { offset: 1, color: [0, 0, 1, 1] },
        ],
        p0: [0, 0], p1: [100, 0], p2: [0, 100], extend: 0,
      },
    });
    return r;
  };
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  assert(bundle.colrGraphs.length === 1, 'rich+gradient: 1 graph baked');
  // Gradient node should have stopsOffset/stopsCount, NOT raw stops.
  const gradNode = bundle.colrGraphs[0].graph.nodes.find(
    n => n.type === 'PaintLinearGradient');
  assert(gradNode, 'gradient node present');
  assert(typeof gradNode.params.stopsOffset === 'number',
         `gradient node has stopsOffset, got ${gradNode.params.stopsOffset}`);
  assert(typeof gradNode.params.stopsCount === 'number',
         `gradient node has stopsCount, got ${gradNode.params.stopsCount}`);
  assert(!gradNode.params.stops,
         'raw stops array dropped after bake');
  // Bundle ships a gradientStops ArrayBuffer the renderer can upload.
  assert(bundle.gradientStops instanceof ArrayBuffer,
         `bundle.gradientStops is an ArrayBuffer, got ${typeof bundle.gradientStops}`);
  assert(bundle.gradientStopsCount > 0,
         `bundle.gradientStopsCount > 0, got ${bundle.gradientStopsCount}`);
  // Both stops are OPAQUE → the 1-texel/stop fast path: stopsCount is NEGATIVE
  // and the LUT is 2 stops × 1 RGBA8 texel × 4 bytes = 8 bytes. (A transparent
  // stop would use 2 texels/stop → positive count, 16 bytes.)
  assert(gradNode.params.stopsCount === -2,
         `opaque gradient takes the 1-texel fast path (count -2), got ${gradNode.params.stopsCount}`);
  assert(bundle.gradientStops.byteLength === 8,
         `2-stop opaque gradient packs to 8 bytes (1 texel/stop), got ${bundle.gradientStops.byteLength}`);
}

console.log('---');
if (failures) console.error(`TEXTRUN-COLR-V1 FAIL (${failures})`);
else          console.log('TEXTRUN-COLR-V1 PASS');
process.exit(failures ? 1 : 0);
