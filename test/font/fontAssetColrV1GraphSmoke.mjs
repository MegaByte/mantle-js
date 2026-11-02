// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// COLRv1 surface test for FontAsset.getColrV1GraphByGid():
//   - returns null when the font has no COLRv1 (graceful fallback)
//   - returns a {graph, glyphSegs, glyphIds} triple for v1 glyphs
//   - the returned graph matches what colrPaintToGraph would produce
//   - glyphIds includes every PaintGlyph-referenced gid (for mask plumbing)
//   - cross-glyph reference (PaintColrGlyph) gets inlined upstream so
//     the only PaintGlyph nodes that survive name local gids

import { registerColorEmojiReaders } from '../../src/font/color/index.js';
registerColorEmojiReaders();
import { buildColrTestFont } from './_colrFontFixture.mjs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// === 1: non-COLR font → null ===========================================
{
  // Synthesize a font with no COLR table at all (default builder
  // gives v0; we'll instead use the simple v0 fixture to confirm
  // hasColrV1 is false → null result).
  const bytes = buildColrTestFont({ codepoint: 0x41 });
  const font = new MantleFontAsset(bytes);
  assert(!font.hasColrV1, 'v0-only font: hasColrV1 = false');
  const result = font.getColrV1GraphByGid(1);
  assert(result === null, 'v0-only font: getColrV1GraphByGid returns null');
}

// === 2: simple v1 fixture (PaintColrLayers → 2× PaintSolid) ============
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1: true });
  const font = new MantleFontAsset(bytes);
  assert(font.hasColrV1, 'colrV1 fixture: hasColrV1 = true');
  const result = font.getColrV1GraphByGid(1);
  assert(result !== null, 'colrV1 fixture: getColrV1GraphByGid returns a triple');
  assert(
    result.graph && result.graph.nodes.length === 3,
    `graph has 3 nodes (Solid, Solid, Merge), got ${result.graph?.nodes?.length}`,
  );
  assert(result.graph.nodes[2].type === 'PaintMerge', 'rootOut node = PaintMerge');
  assert(Array.isArray(result.glyphIds), 'glyphIds is an array');
  // Simple fixture has no PaintGlyph nodes; only the top-level gid 1
  // should appear in glyphIds.
  assert(
    result.glyphIds.length === 1 && result.glyphIds[0] === 1,
    `simple fixture: glyphIds = [1], got [${result.glyphIds.join(',')}]`,
  );
  // glyphSegs is the silhouette outline — empty for the test fixture's
  // synthetic glyph (no glyf body) is fine; we only check that the
  // field exists and is an array.
  assert(Array.isArray(result.glyphSegs), 'glyphSegs is an array');
}

// === 3: rich v1 fixture (gid 1: PaintGlyph → Transform → Merge) =======
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Rich: true });
  const font = new MantleFontAsset(bytes);
  const result = font.getColrV1GraphByGid(1);
  assert(result !== null, 'rich gid 1: triple returned');
  // 5 nodes: PaintSolid, PaintSolid, PaintMerge, PaintTransform, PaintGlyph.
  assert(result.graph.nodes.length === 5, `rich gid 1: 5 nodes, got ${result.graph.nodes.length}`);
  // PaintGlyph is at index 4 with glyphId = 2 (per the fixture).
  const pg = result.graph.nodes[4];
  assert(
    pg.type === 'PaintGlyph' && pg.params.glyphId === 2,
    `rich gid 1: rootOut = PaintGlyph(glyphId=2), got ${pg.type}/${pg.params?.glyphId}`,
  );
  // glyphIds should contain both 1 (the top-level) and 2 (the PaintGlyph target).
  const ids = new Set(result.glyphIds);
  assert(
    ids.has(1) && ids.has(2),
    `rich gid 1: glyphIds includes 1 and 2, got [${result.glyphIds.join(',')}]`,
  );
  // glyphSegsByGid map should have entries for every gid in
  // glyphIds, keyed by gid (the PaintGlyph.glyphId).
  assert(result.glyphSegsByGid instanceof Map, 'rich gid 1: glyphSegsByGid is a Map');
  assert(
    result.glyphSegsByGid.has(2),
    'rich gid 1: glyphSegsByGid includes the PaintGlyph(gid=2) outline',
  );
  assert(
    Array.isArray(result.glyphSegsByGid.get(2)) && result.glyphSegsByGid.get(2).length > 0,
    'rich gid 1: glyphSegsByGid[2] has actual segs (simpleSquare from fixture)',
  );
}

// === 4: rich v1 gid 2 (PaintColrGlyph(1) — inlined upstream) ==========
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Rich: true });
  const font = new MantleFontAsset(bytes);
  const result = font.getColrV1GraphByGid(2);
  assert(result !== null, 'rich gid 2: triple returned (after PaintColrGlyph inline)');
  // Same shape as gid 1 (PaintColrGlyph just inlined gid 1's tree).
  assert(
    result.graph.nodes.length === 5,
    `rich gid 2: 5 nodes after inline, got ${result.graph.nodes.length}`,
  );
  // glyphIds still references gid 2 (top-level) + inlined PaintGlyph's gid.
  const ids = new Set(result.glyphIds);
  assert(ids.has(2), 'rich gid 2: glyphIds includes top-level gid 2');
}

// === 5: rich v1 gid 3 (PaintComposite of Rotated + Solid) =============
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Rich: true });
  const font = new MantleFontAsset(bytes);
  const result = font.getColrV1GraphByGid(3);
  assert(result !== null, 'rich gid 3: triple returned');
  // 4 nodes (red, rotate, green, composite).
  assert(result.graph.nodes.length === 4, `rich gid 3: 4 nodes, got ${result.graph.nodes.length}`);
  assert(
    result.graph.nodes[3].type === 'PaintComposite',
    `rich gid 3: rootOut = PaintComposite, got ${result.graph.nodes[3].type}`,
  );
  // Composite mode preserved from the fixture (mode 7 = SrcOut).
  assert(
    result.graph.nodes[3].params.mode === 7,
    `rich gid 3: composite mode = 7, got ${result.graph.nodes[3].params.mode}`,
  );
}

// === 6: gradient fixture =============================================
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Grad: true });
  const font = new MantleFontAsset(bytes);
  for (const [gid, expectedType] of [
    [1, 'PaintLinearGradient'],
    [2, 'PaintRadialGradient'],
    [3, 'PaintSweepGradient'],
  ]) {
    const result = font.getColrV1GraphByGid(gid);
    assert(result !== null, `gradient gid ${gid}: triple returned`);
    assert(
      result.graph.nodes[0].type === expectedType,
      `gradient gid ${gid}: first node = ${expectedType}, got ${result.graph.nodes[0].type}`,
    );
  }
}

// === compat: 'chrome' marks a gradient node for Chrome's interpolation, and leaves name decoding alone; 'harfbuzz' is the reverse ===
{
  const bytes = buildColrTestFont({ codepoint: 0x41, colrV1Grad: true });
  const read = (compat) => {
    const font = new MantleFontAsset(bytes, compat === undefined ? {} : { compat });
    const gradients = font
      .getColrV1GraphByGid(1)
      .graph.nodes.filter((n) => n.type.endsWith('Gradient'));
    if (!gradients.length) throw new Error('no gradient node in the fixture');
    return {
      chrome: gradients.every((n) => n.params.stopsChrome === true),
      spec: gradients.every((n) => !('stopsChrome' in n.params)),
      names: font._compat,
    };
  };
  for (const [compat, want] of [
    [undefined, ['spec', false]],
    ['spec', ['spec', false]],
    ['harfbuzz', ['harfbuzz', false]],
    ['chrome', ['spec', true]],
    [
      ['harfbuzz', 'chrome'],
      ['harfbuzz', true],
    ],
  ]) {
    const r = read(compat);
    assert(
      r.names === want[0],
      `compat ${JSON.stringify(compat)}: names read as ${want[0]}, got ${r.names}`,
    );
    assert(
      want[1] ? r.chrome : r.spec,
      `compat ${JSON.stringify(compat)}: gradients ${want[1] ? 'marked for Chrome' : 'unmarked'}`,
    );
  }
}

console.log('---');
if (failures) console.error(`FONT-ASSET-COLR-V1-GRAPH FAIL (${failures})`);
else console.log('FONT-ASSET-COLR-V1-GRAPH PASS');
process.exit(failures ? 1 : 0);
