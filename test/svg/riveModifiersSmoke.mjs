// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// riveModifiersSmoke.mjs — verify Rive-flavored primitives:
//   • featherGraph + featherDropShadowGraph (svg/effectsSynth.js)
//   • mirror-wrap encoding (coverage shader kind=3 bits — checked
//     structurally via coverage shader text inspection)
//   • textFollowPath / textVariationApply / applyGlyphRange
//     (svg/textModifiers.js)

import { featherGraph, featherDropShadowGraph } from '../../src/svg/effectsSynth.js';
import {
  textFollowPath,
  textVariationApply,
  applyGlyphRange,
} from '../../src/svg/textModifiers.js';
import { mkLine } from '../../src/svg/segment.js';
import { SRC_GRAPHIC, SRC_ALPHA } from '../../src/filterGraph/filterGraph.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}
function approx(a, b, eps = 1e-5) {
  return Math.abs(a - b) < eps;
}

// ────────────────────────────────────────────────────────────────
// Feather
// ────────────────────────────────────────────────────────────────

(() => {
  // No offset → 1-node graph (just feGaussianBlur).
  const g = featherGraph(4, 4, 0, 0);
  if (g.nodes.length !== 1 || g.nodes[0].type !== 'feGaussianBlur')
    fail(
      `featherGraph σ=4 no offset: expected 1 feGaussianBlur node, got ${g.nodes.length}/${g.nodes[0].type}`,
    );
  else if (g.nodes[0].params.sigmaX !== 4 || g.nodes[0].params.sigmaY !== 4)
    fail(
      `featherGraph σ=4: sigma not 4/4 (got ${g.nodes[0].params.sigmaX}/${g.nodes[0].params.sigmaY})`,
    );
  else if (g.rootOut !== 0) fail(`featherGraph: rootOut != 0`);
  else ok('featherGraph σ=4 no offset → 1 feGaussianBlur node');
})();

(() => {
  // With offset → 2-node graph (blur → offset).
  const g = featherGraph(4, 4, 3, 5);
  if (g.nodes.length !== 2 || g.nodes[1].type !== 'feOffset')
    fail(
      `featherGraph σ=4 offset (3,5): expected blur+offset, got ${g.nodes.map((n) => n.type).join(',')}`,
    );
  else if (g.nodes[1].params.dx !== 3 || g.nodes[1].params.dy !== 5)
    fail(`featherGraph offset: dx/dy not 3/5`);
  else if (g.rootOut !== 1) fail(`featherGraph offset: rootOut != 1`);
  else ok('featherGraph σ=4 offset(3,5) → blur+offset, rootOut=1');
})();

(() => {
  // Drop-shadow shape: 5 nodes (blur sourceAlpha → offset → flood → composite → merge).
  const g = featherDropShadowGraph(2, 3, 4, 6, [0, 0, 0, 1]);
  if (g.nodes.length !== 5) fail(`featherDropShadowGraph: expected 5 nodes, got ${g.nodes.length}`);
  else if (g.nodes[0].inputs[0] !== SRC_ALPHA)
    fail(`featherDropShadowGraph: blur should sample SRC_ALPHA, got ${g.nodes[0].inputs[0]}`);
  else if (g.nodes[4].type !== 'feMerge') fail(`featherDropShadowGraph: rootOut should be feMerge`);
  else if (g.nodes[4].inputs[0] !== 3 || g.nodes[4].inputs[1] !== SRC_GRAPHIC)
    fail(`featherDropShadowGraph: merge inputs should be [3, -1]`);
  else
    ok(
      'featherDropShadowGraph: 5-node graph (alpha-blur → offset → flood → composite-in → merge-over-source)',
    );
})();

(() => {
  // Negative strength clamps to 0.
  const g = featherGraph(-1, -2, 0, 0);
  if (g.nodes[0].params.sigmaX !== 0 || g.nodes[0].params.sigmaY !== 0)
    fail(
      `featherGraph negative: should clamp to 0, got ${g.nodes[0].params.sigmaX}/${g.nodes[0].params.sigmaY}`,
    );
  else ok('featherGraph negative strength clamps to 0');
})();

// ────────────────────────────────────────────────────────────────
// ImageSampler mirror-wrap (structural — verify the coverage shader carries the kind=3 branch)
// ────────────────────────────────────────────────────────────────

(() => {
  // The kind==3 mirror-wrap branch may live in mantle.frag.glsl or in the
  // shared coverage helper; check both so the test stays robust to where the
  // helper is defined.
  //
  // "Robust" has to mean tolerating a candidate that isn't there: reading every
  // path unconditionally throws ENOENT when a helper is renamed. Absent
  // candidates are skipped, and the check stays honest — at least one
  // candidate must exist, or the search is vacuous.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = ['../../src/shaders/mantle.frag.glsl', '../../src/shaders/_coverage.glsl'];
  let found = false,
    formulaFound = false,
    read = 0;
  for (const rel of candidates) {
    let src;
    try {
      src = readFileSync(resolve(here, rel), 'utf8');
    } catch {
      continue;
    }
    read++;
    if (/kind == 3/.test(src)) found = true;
    if (/abs\(fract\(u \* 0\.5\) - 0\.5\) \* 2/.test(src)) formulaFound = true;
  }
  if (!read) fail('coverage shaders: none of the candidate files exist — this check is vacuous');
  else if (!found)
    fail(`coverage shaders: mirror-wrap branch (kind==3) not found in any candidate`);
  else if (!formulaFound)
    fail(`coverage shaders: mirror triangle-wave formula not found in expected shape`);
  else ok('coverage shaders: kind==3 mirror-wrap branch with triangle-wave formula present');
})();

// ────────────────────────────────────────────────────────────────
// TextFollowPath
// ────────────────────────────────────────────────────────────────

// Synthetic 3-glyph layout: each glyph a unit-square at (penX, 0..1).
function fakeLayout(n) {
  const glyphs = [];
  const advance = 10;
  for (let i = 0; i < n; i++) {
    const px = i * advance;
    glyphs.push({
      codepoint: 65 + i,
      penX: px,
      advance,
      segs: [mkLine([px - 1, 0], [px + 1, 0]), mkLine([px + 1, 0], [px + 1, 1])],
    });
  }
  return glyphs;
}

(() => {
  // Straight horizontal path from (0,0) to (100,0). Strength=1
  // should produce glyphs at their anchor (penX + advance/2 = 5, 15, 25).
  // Y stays 0.
  const path = [mkLine([0, 0], [100, 0])];
  const glyphs = fakeLayout(3);
  const out = textFollowPath(glyphs, path, { strength: 1, start: 0, end: 1 });
  if (out.length !== 3) fail(`textFollowPath: expected 3 followed glyphs, got ${out.length}`);
  else {
    // First glyph's anchor (cx=5) sits at fraction 5/30 of the layout
    // mapped to arc-length window [0..100]. Followed glyph 0's segs
    // should be shifted so the geometry near (cx, 0) lies near
    // (sample.x, sample.y).
    // Just verify all glyphs are marked .followed:
    if (!out.every((g) => g.followed)) fail(`textFollowPath: some glyphs not marked followed`);
    else ok(`textFollowPath strength=1 straight path → 3 followed glyphs`);
  }
})();

(() => {
  // Strength=0 → identity (positions unchanged from flat layout).
  const path = [mkLine([0, 50], [100, 50])]; // shifted +50y path
  const glyphs = fakeLayout(3);
  const out = textFollowPath(glyphs, path, { strength: 0 });
  // With strength=0, py = 0*0.5 + 0*1 = 0 (path y ignored).
  // First glyph's first seg.p1 should be (px-1, 0) = (-1, 0) — unchanged.
  if (!approx(out[0].segs[0].p1[0], -1) || !approx(out[0].segs[0].p1[1], 0))
    fail(
      `textFollowPath strength=0: glyph 0 seg p1 should be (-1,0), got (${out[0].segs[0].p1[0]}, ${out[0].segs[0].p1[1]})`,
    );
  else ok('textFollowPath strength=0 preserves flat baseline (no displacement)');
})();

(() => {
  // Radial orient flag flips axes — test that radial=true produces
  // different output than radial=false on a curving path.
  const path = [mkLine([0, 0], [100, 100])]; // 45° tangent (.707, .707)
  const g1 = fakeLayout(2);
  const g2 = fakeLayout(2);
  const tan = textFollowPath(g1, path, { strength: 1, radial: false });
  const rad = textFollowPath(g2, path, { strength: 1, radial: true });
  // Second-glyph y from tangential vs radial should differ.
  if (
    approx(tan[1].segs[1].p2[0], rad[1].segs[1].p2[0]) &&
    approx(tan[1].segs[1].p2[1], rad[1].segs[1].p2[1])
  )
    fail(`textFollowPath radial: identical output to tangential mode — flag not honored`);
  else ok('textFollowPath radial vs tangential produces distinct geometry');
})();

// ────────────────────────────────────────────────────────────────
// TextVariationApply
// ────────────────────────────────────────────────────────────────

(() => {
  // 5 glyphs, axis wght range 0..2 with full ramp (no falloff).
  // Inside the range, every glyph gets full target value (weight=1).
  const glyphs = fakeLayout(5);
  const out = textVariationApply(
    glyphs,
    { startIndex: 0, endIndex: 4, fallOffStart: 0, fallOffEnd: 0 },
    { wght: { base: 400, target: 700 } },
  );
  if (!out.every((g) => g.varCoords && approx(g.varCoords.wght, 700)))
    fail(
      `textVariationApply full ramp: expected all wght=700, got [${out.map((g) => g.varCoords?.wght).join(',')}]`,
    );
  else ok('textVariationApply full ramp → all 5 glyphs at wght=700');
})();

(() => {
  // Linear falloff: 5 glyphs, range [0..4] with fallOffStart=2,
  // fallOffEnd=2 → bell shape, peaks in the middle.
  const glyphs = fakeLayout(5);
  const out = textVariationApply(
    glyphs,
    { startIndex: 0, endIndex: 4, fallOffStart: 2, fallOffEnd: 2 },
    { wght: { base: 400, target: 800 } },
  );
  // Glyph 0: inStart=0 → wIn = 0/2 = 0 → weight 0 → wght=400.
  // Glyph 2: inStart=2 (wIn=1), inEnd=2 (wOut=1) → weight 1 → wght=800.
  // Glyph 4: inEnd=0 → wOut=0 → weight 0 → wght=400.
  if (!approx(out[0].varCoords.wght, 400))
    fail(`textVariationApply falloff: glyph 0 should be base=400 (got ${out[0].varCoords.wght})`);
  else if (!approx(out[2].varCoords.wght, 800))
    fail(`textVariationApply falloff: glyph 2 should be target=800 (got ${out[2].varCoords.wght})`);
  else if (!approx(out[4].varCoords.wght, 400))
    fail(`textVariationApply falloff: glyph 4 should be base=400 (got ${out[4].varCoords.wght})`);
  else ok(`textVariationApply falloff: 0→400, 2→800, 4→400 (linear ramp)`);
})();

(() => {
  // Multi-axis: wght + wdth + slnt all set together.
  const glyphs = fakeLayout(2);
  const out = textVariationApply(
    glyphs,
    { startIndex: 0, endIndex: 1, fallOffStart: 0, fallOffEnd: 0 },
    {
      wght: { base: 400, target: 900 },
      wdth: { base: 100, target: 150 },
      slnt: { base: 0, target: -12 },
    },
  );
  if (
    !out[0].varCoords ||
    !approx(out[0].varCoords.wght, 900) ||
    !approx(out[0].varCoords.wdth, 150) ||
    !approx(out[0].varCoords.slnt, -12)
  )
    fail(
      `textVariationApply multi-axis: wght/wdth/slnt not all set (got ${JSON.stringify(out[0].varCoords)})`,
    );
  else ok('textVariationApply multi-axis: wght+wdth+slnt all interpolated together');
})();

// ────────────────────────────────────────────────────────────────
// applyGlyphRange (per-glyph property animator)
// ────────────────────────────────────────────────────────────────

(() => {
  // Opacity: target 0.5, full ramp → all glyphs at 0.5.
  const glyphs = fakeLayout(3);
  const out = applyGlyphRange(
    glyphs,
    { startIndex: 0, endIndex: 2, fallOffStart: 0, fallOffEnd: 0 },
    { opacity: { base: 1, target: 0.5 } },
  );
  if (!out.every((g) => g.modifiers && approx(g.modifiers.opacity, 0.5)))
    fail(`applyGlyphRange opacity: not all at 0.5 (${out.map((g) => g.modifiers?.opacity)})`);
  else ok('applyGlyphRange opacity full ramp: all glyphs at 0.5');
})();

(() => {
  // Multi-prop: opacity + rotateDeg + scale.
  const glyphs = fakeLayout(2);
  const out = applyGlyphRange(
    glyphs,
    { startIndex: 0, endIndex: 1 },
    {
      opacity: { base: 1, target: 0 },
      rotateDeg: { base: 0, target: 45 },
      scale: { base: 1, target: 2 },
    },
  );
  const m = out[0].modifiers;
  if (!approx(m.opacity, 0) || !approx(m.rotateDeg, 45) || !approx(m.scale, 2))
    fail(`applyGlyphRange multi: ${JSON.stringify(m)}`);
  else ok(`applyGlyphRange multi-prop: opacity/rotateDeg/scale all set on glyph 0`);
})();

(() => {
  // Tint array prop: [r,g,b,a] interpolation.
  const glyphs = fakeLayout(1);
  const out = applyGlyphRange(
    glyphs,
    { startIndex: 0, endIndex: 0 },
    { tint: { base: [0, 0, 0, 1], target: [1, 0.5, 0, 1] } },
  );
  const t = out[0].modifiers.tint;
  if (!t || !approx(t[0], 1) || !approx(t[1], 0.5) || !approx(t[2], 0) || !approx(t[3], 1))
    fail(`applyGlyphRange tint: ${JSON.stringify(t)}`);
  else ok('applyGlyphRange tint array: full ramp gives target rgba');
})();

(() => {
  // Easing functions produce different mid-range weights.
  // 3 glyphs, falloff 1+1 → glyph 1 gets weight 0.5 raw.
  // easeIn(0.5) = 0.25, easeOut(0.5) = 0.75, linear(0.5) = 0.5.
  // Here we verify the API accepts easing names.
  const glyphs = fakeLayout(3);
  const out = applyGlyphRange(
    glyphs,
    { startIndex: 0, endIndex: 2, fallOffStart: 1, fallOffEnd: 1, easing: 'easeInOut' },
    { opacity: { base: 0, target: 1 } },
  );
  if (!out[1].modifiers || out[1].modifiers.opacity === undefined)
    fail(`applyGlyphRange easeInOut: no opacity on middle glyph`);
  else
    ok(
      `applyGlyphRange easing 'easeInOut' accepted, opacity[1]=${out[1].modifiers.opacity.toFixed(3)}`,
    );
})();

// ────────────────────────────────────────────────────────────────

const { sampleImageAt } = await import('../../src/hitTest/paintSample.js');
const image = { px: Uint8Array.from([255, 255, 255, 0, 255, 255, 255, 255]), w: 2, h: 1 };
for (const [coordinate, expected] of [
  [0.25, 0],
  [0.75, 1],
  [1.25, 1],
  [1.75, 0],
  [-0.25, 0],
  [-0.75, 1],
]) {
  const alpha = sampleImageAt(image, coordinate, 0.5, [0, 0, 1, 1], [0, 2, 1, 7])[3];
  if (alpha === expected) ok(`CPU mirror addressing ${coordinate}`);
  else fail(`CPU mirror addressing ${coordinate}: ${alpha}, expected ${expected}`);
}

{
  const atlas = new Uint8Array(4 * 3 * 4);
  for (let i = 0; i < atlas.length; i += 4) atlas.set([255, 255, 255, 255], i);
  atlas[19] = 0;
  atlas[27] = 0;
  const alpha = sampleImageAt(
    { px: atlas, w: 4, h: 3 },
    31.75,
    20.25,
    [16, 16, 16, 16],
    [1, 2, 1, 3],
  )[3];
  if (alpha === 1) ok('CPU image filtering stays in its atlas slot');
  else fail(`CPU atlas boundary alpha ${alpha}`);
}

if (failures === 0) console.log('\nRIVE-MODIFIERS PASS');
else {
  console.error(`\nRIVE-MODIFIERS FAIL (${failures})`);
  process.exit(1);
}
