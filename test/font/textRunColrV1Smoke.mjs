// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
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
  assert(
    Array.isArray(bundle.colrGraphs),
    `bundle has a colrGraphs array, got ${typeof bundle.colrGraphs}`,
  );
  assert(
    bundle.colrGraphs.length === 1,
    `1 v1 glyph → 1 colrGraph entry, got ${bundle.colrGraphs.length}`,
  );
  // colrGraphs entry is { graph, masks }, not a bare DAG.
  const entry = bundle.colrGraphs[0];
  assert(
    entry && entry.graph && Array.isArray(entry.graph.nodes),
    'colrGraphs[0] is { graph, masks } shape',
  );
  // PaintGlyph(2) -> PaintTransform -> PaintColrLayers(solid, solid). The transform is pushed to the two generator
  // leaves (placeColrTransforms): solid, transform, solid, transform, merge, glyph.
  assert(
    entry.graph.nodes.length === 6 &&
      entry.graph.nodes.filter((n) => n.type === 'PaintTransform').length === 2 &&
      entry.graph.nodes.every(
        (n) => n.type !== 'PaintTransform' || entry.graph.nodes[n.inputs[0]].type === 'PaintSolid',
      ),
    `colrGraphs[0].graph has 6 nodes with the transforms above the solids (rich), got ${entry.graph.nodes.map((n) => n.type)}`,
  );
  assert(entry.masks && typeof entry.masks === 'object', 'colrGraphs[0].masks present');
  // Rich gid 1 references PaintGlyph(glyphId=2); both gid 1 (primary)
  // and gid 2 (mask) should be in entry.masks.
  assert(
    typeof entry.masks[1] === 'number',
    `entry.masks has primary gid 1 mapped to a shapeIdx, got ${entry.masks[1]}`,
  );
  assert(
    typeof entry.masks[2] === 'number',
    `entry.masks has secondary gid 2 mapped to a shapeIdx, got ${entry.masks[2]}`,
  );
  assert(entry.masks[1] !== entry.masks[2], 'primary and mask-only shapeIdxs are distinct');
  // The shape's meta should carry colrGraphId=1 at texel 11.y (slot 45;
  // slot 44 is primKind).
  const stride = bundle.metaFloatsPerShape;
  let coloredShapeIdx = -1,
    maskOnlyShapeIdx = -1;
  for (let s = 0; s < bundle.numShapes; s++) {
    const cg = Math.floor(bundle.metaFloats[s * stride + 45] + 0.5);
    if (cg !== 1) continue;
    const flagsShape = Math.floor(bundle.metaFloats[s * stride + 27] + 0.5);
    if ((flagsShape & 256) !== 0) maskOnlyShapeIdx = s;
    else coloredShapeIdx = s;
  }
  assert(coloredShapeIdx >= 0, 'at least one shape with colrGraphId=1 is colored (not mask-only)');
  assert(maskOnlyShapeIdx >= 0, 'rich gid 1 emitted a mask-only shape for PaintGlyph(gid=2)');
}

// === 2: v0 font (no v1) → empty colrGraphs ============================
{
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  assert(
    Array.isArray(bundle.colrGraphs),
    'v0 font also produces a (possibly empty) colrGraphs array',
  );
  assert(bundle.colrGraphs.length === 0, `v0 font → no v1 graphs, got ${bundle.colrGraphs.length}`);
  // No meta should have colrGraphId set (texel 11.y / slot 45).
  const stride = bundle.metaFloatsPerShape;
  let anyCg = false;
  for (let s = 0; s < bundle.numShapes; s++) {
    if (Math.floor(bundle.metaFloats[s * stride + 45] + 0.5) !== 0) {
      anyCg = true;
      break;
    }
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
  assert(
    bundle.colrGraphs.length === 0,
    `simple v1 (no PaintGlyph + no outline) → v0 fallback, 0 graphs, got ${bundle.colrGraphs.length}`,
  );
}

// === 4: v1 gradient → 1-node graph (but no silhouette in fixture) ====
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Grad: true });
  const font = new MantleFontAsset(bytes);
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  // Gradient fixture's gid 1 is a bare PaintLinearGradient — no
  // PaintGlyph anywhere and no outline. TextRun correctly skips.
  assert(
    bundle.colrGraphs.length === 0,
    `gradient (no silhouette) → 0 graphs, got ${bundle.colrGraphs.length}`,
  );
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
        p0: [0, 0],
        p1: [100, 0],
        p2: [0, 100],
        extend: 0,
      },
    });
    // Reachable from the root: the emitter walks the graph from rootOut (a node nothing reads is dropped).
    r.graph.nodes.push({ type: 'PaintMerge', inputs: [r.graph.rootOut, gradNodeIdx], params: {} });
    r.graph.rootOut = r.graph.nodes.length - 1;
    return r;
  };
  const bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
  assert(bundle.colrGraphs.length === 1, 'rich+gradient: 1 graph baked');
  // Gradient node should have stopsOffset/stopsCount, NOT raw stops.
  const gradNode = bundle.colrGraphs[0].graph.nodes.find((n) => n.type === 'PaintLinearGradient');
  assert(gradNode, 'gradient node present');
  assert(
    typeof gradNode.params.stopsOffset === 'number',
    `gradient node has stopsOffset, got ${gradNode.params.stopsOffset}`,
  );
  assert(
    typeof gradNode.params.stopsCount === 'number',
    `gradient node has stopsCount, got ${gradNode.params.stopsCount}`,
  );
  assert(!gradNode.params.stops, 'raw stops array dropped after bake');
  // Bundle ships a gradientStops ArrayBuffer the renderer can upload.
  assert(
    bundle.gradientStops instanceof ArrayBuffer,
    `bundle.gradientStops is an ArrayBuffer, got ${typeof bundle.gradientStops}`,
  );
  assert(
    bundle.gradientStopsCount > 0,
    `bundle.gradientStopsCount > 0, got ${bundle.gradientStopsCount}`,
  );
  // Both stops are OPAQUE → the 1-texel/stop fast path: stopsCount is NEGATIVE
  // and the LUT is 2 stops × 1 RGBA8 texel × 4 bytes = 8 bytes. (A transparent
  // stop would use 2 texels/stop → positive count, 16 bytes.)
  assert(
    gradNode.params.stopsCount === -2,
    `opaque gradient takes the 1-texel fast path (count -2), got ${gradNode.params.stopsCount}`,
  );
  assert(
    bundle.gradientStops.byteLength === 8,
    `2-stop opaque gradient packs to 8 bytes (1 texel/stop), got ${bundle.gradientStops.byteLength}`,
  );
}

// === 6: a COLRv1 FONT's gradient reaches the renderer ===============
{
  // Every gradient above is injected with `color` stops. A font's ColorLine comes from the reader as
  // { offset, paletteIndex, alpha, rgba } -- and the packer read `color`, so any COLRv1 glyph with a
  // gradient threw before a bundle existed. Past that, the text sections dropped the stop LUT, and
  // createBundle uploaded one only beside an SVG gradient table, so the gradient drew nothing.
  const { createTextBundle } = await import('../../src/textBundle.js');
  const { createFakeGl } = await import('../_fakeGl.mjs');
  for (const kind of ['h', 'v', 'sweep']) {
    const font = new MantleFontAsset(buildColrTestFont({ codepoint: 0x41, colrV1GlyphGrad: kind }));
    let bundle = null,
      err = null;
    try {
      bundle = await buildTextRun('A', font, [0, 0, 0, 1]);
    } catch (e) {
      err = e;
    }
    assert(
      bundle && !err,
      `${kind}: a COLRv1 font with a gradient builds (${err ? err.message : 'ok'})`,
    );
    if (!bundle) continue;
    const g = bundle.colrGraphs[0].graph.nodes.find((n) => /Gradient$/.test(n.type));
    const lut = bundle.gradientStops ? new Uint8Array(bundle.gradientStops) : null;
    // Two opaque stops, one texel each: (R, G, B, offset) -- red at 0, blue (palette 2) at 1.
    assert(
      g &&
        g.params.stopsCount === -2 &&
        lut &&
        lut.length === 8 &&
        lut.join() === '255,0,0,0,0,0,255,255',
      `${kind}: the ColorLine packs red -> blue into the LUT, got count ${g && g.params.stopsCount}, LUT ${lut && Array.from(lut)}`,
    );
    const F = createFakeGl({ width: 64, height: 64 });
    const tb = await createTextBundle(F.gl, {
      font,
      text: 'A',
      style: { fontSize: 1, fill: [0, 0, 0, 1] },
    });
    assert(
      tb.bundle && tb.bundle.gradientStopsTex,
      `${kind}: createTextBundle uploads the stop LUT (gradientStopsTex ${tb.bundle && !!tb.bundle.gradientStopsTex})`,
    );
  }
  // A stop naming the foreground (palette 0xFFFF) takes the text's color at the stop's alpha: green at 0.5,
  // which is translucent, so the list takes two texels a stop -- straight (R, G, B, A), then the offset.
  const fgFont = new MantleFontAsset(
    buildColrTestFont({ codepoint: 0x41, colrV1GlyphGrad: 'h', fgStop: true }),
  );
  const fb = await buildTextRun('A', fgFont, [0, 1, 0, 1]);
  const fg = fb.colrGraphs[0].graph.nodes.find((n) => /Gradient$/.test(n.type)).params;
  const flut = new Uint8Array(fb.gradientStops);
  assert(
    fg.stopsCount === 2 && Array.from(flut.slice(8, 12)).join() === '0,255,0,128',
    `a foreground stop is the text's color at the stop's alpha, got count ${fg.stopsCount}, stop 1 rgba(${Array.from(flut.slice(8, 12))})`,
  );
}

// === 7: the graph is PLACED with its glyph ================
{
  // The graph keeps the design grid's coordinates (normalized, y up); the glyph's outline went through
  // its layout (pen position, size, the y flip). The entry's `placement` must be that same map, or a
  // gradient never meets its glyph: here each gradient spans the square gid 2 exactly, so its ends must
  // land on the square's edges in bundle em.
  // Two glyphs, so the second sits at a pen offset: the placement carries position as well as the flip.
  for (const kind of ['h', 'v', 'sweep']) {
    const font = new MantleFontAsset(buildColrTestFont({ codepoint: 0x41, colrV1GlyphGrad: kind }));
    const bundle = await buildTextRun('AA', font, [0, 0, 0, 1]);
    const st = bundle.metaFloatsPerShape;
    assert(
      bundle.colrGraphs && bundle.colrGraphs.length === 2,
      `${kind}: two glyphs, two graphs, got ${bundle.colrGraphs && bundle.colrGraphs.length}`,
    );
    for (let gi = 0; gi < ((bundle.colrGraphs && bundle.colrGraphs.length) | 0); gi++) {
      const entry = bundle.colrGraphs[gi];
      const P = entry && entry.placement;
      assert(
        Array.isArray(P) && P.length === 6,
        `${kind} glyph ${gi}: the graph entry carries its placement, got ${JSON.stringify(P)}`,
      );
      if (!Array.isArray(P)) continue;
      const at = (q) => [P[0] * q[0] + P[2] * q[1] + P[4], P[1] * q[0] + P[3] * q[1] + P[5]];
      let si = -1;
      for (let i = 0; i < bundle.numShapes; i++) {
        if (
          Math.round(bundle.metaFloats[i * st + 45]) === gi + 1 &&
          Math.round(bundle.metaFloats[i * st + 27]) !== 256
        ) {
          si = i;
          break;
        }
      }
      const box = Array.from(bundle.metaFloats.slice(si * st, si * st + 4)); // em, y down
      const cx = (box[0] + box[2]) / 2,
        cy = (box[1] + box[3]) / 2,
        eps = 1e-6 * Math.max(1, box[2] - box[0]);
      const near = (a, b) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
      const g = entry.graph.nodes.find((n) => n.type !== 'PaintGlyph').params;
      const pts =
        kind === 'sweep'
          ? [[g.center, [cx, cy], 'center']]
          : kind === 'h'
            ? [
                [g.p0, [box[0], cy], 'p0 (left edge)'],
                [g.p1, [box[2], cy], 'p1 (right edge)'],
              ]
            : [
                [g.p0, [cx, box[3]], 'p0 (bottom edge)'],
                [g.p1, [cx, box[1]], 'p1 (top edge)'],
              ];
      for (const [q, want, name] of pts) {
        const got = at(q);
        assert(
          near(got, want),
          `${kind} glyph ${gi}: the gradient's ${name} lands on the glyph at (${want.map((v) => v.toFixed(4))}), got (${got.map((v) => v.toFixed(4))})`,
        );
      }
    }
  }
}

console.log('---');
if (failures) console.error(`TEXTRUN-COLR-V1 FAIL (${failures})`);
else console.log('TEXTRUN-COLR-V1 PASS');
process.exit(failures ? 1 : 0);
