// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// silhouetteRefIndexSmoke — turning on `computeSilhouette` must not move anything else in the bundle.
//
// THE HAZARD. finalizeBundle injects the silhouette as a synthetic stroke-only shape at the FRONT of
// ctx.shapesData, so it draws behind the art. Four slot families recorded during the walk address that list BY
// POSITION and must be shifted with it:
//   ctx.vecPatternsUsed[i].firstShapeIdx / .lastShapeIdx  — a vector pattern's child span
//   ctx.clipBindings[i] / ctx.maskBindings[i]             — the shape an objectBoundingBox clip or mask binds to
//   ctx.filterBindings[i] / ctx.filterInstShapes          — the shapes a group filter's objectBoundingBox region spans
// Unshifted, every one of them points one shape too early: a carrier whose children begin at index 0 samples the
// SILHOUETTE row as its tile, and an objectBoundingBox clip binds to the shape emitted BEFORE the one that
// references it (here the clip of the 40x40 rect would come out over the pattern rect).
//
// Second half: the union must leave the PATTERN CHILDREN out. They are walked in the pattern's own space and reach
// the page only through a carrier's inverse pattern matrix, so their coordinates are not document coordinates; the
// tile child at (2, 3) would drag the silhouette of a drawing that starts at (10, 10) to the origin.
//
// No GPU: import the same document with and without the option and read the meta rows. A reference's TARGET row
// must carry the same geometry either way (texels the smoke reads: bbox floats 0-3, atlasSlot floats 40-43,
// clipId 30, maskId 31, flagsShape 27), and the silhouette's own row must cover the drawn art and nothing else.
//
// Mutation, required to FAIL: drop the index bump after `ctx.shapesData.unshift(silShape)` (checks 2, 3, 4), or
// drop the `sd.isLayer` skip in the union's input, or the visible-region restriction silRegions builds (check 5).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, e = 1e-3) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);
const fmt = (a) => (a ? '(' + a.map((v) => +v.toFixed(2)).join(', ') + ')' : 'none');

// A pattern-filled rect, an objectBoundingBox clip on a second rect and an objectBoundingBox mask on a third.
// Three distinct shapes so an off-by-one binding lands on a DIFFERENT box, not a coincidentally equal one, and
// the pattern child sits at (2, 3) — outside the drawing's own extent, which starts at (10, 10).
const SILHOUETTE_REFS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<defs>
<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse"><rect x="2" y="3" width="10" height="7" fill="#0090ff"/></pattern>
<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>
<mask id="m" maskContentUnits="objectBoundingBox"><rect x="0" y="0" width="0.25" height="1" fill="#ffffff"/></mask>
</defs>
<rect x="10" y="10" width="80" height="60" fill="url(#p)"/>
<rect x="100" y="100" width="40" height="40" fill="#c33" clip-path="url(#c)"/>
<rect x="20" y="150" width="60" height="30" fill="#3c3" mask="url(#m)"/>
</svg>`;

const LAYER = 0x100;
async function read(computeSilhouette) {
  const b = await importSvg(SILHOUETTE_REFS, { preserveViewport: true, computeSilhouette });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const st = pm.floatsPerShape,
    rows = [];
  for (let s = 0; s < pm.numShapes; s++)
    rows.push(Array.from(pm.metaFloats.subarray(s * st, s * st + st)));
  const bbox = (r) => (r ? r.slice(0, 4) : null);
  const drawn = rows.filter((r) => !((r[27] | 0) & LAYER));
  // The pattern carrier stamps atlasSlot = (firstChildRow+1, lastChildRow+1, 0, 2).
  const carrier = rows.find((r) => r[43] === 2);
  const patChild = carrier ? bbox(rows[carrier[40] - 1]) : null;
  // A clipped / masked drawn row names its first clip or mask row 1-based in texel 30 / 31.
  const clipped = drawn.find((r) => r[30] > 0);
  const masked = drawn.find((r) => r[31] > 0);
  return {
    b,
    rows,
    drawn,
    patChild,
    clipRow: clipped ? bbox(rows[clipped[30] - 1]) : null,
    maskRow: masked ? bbox(rows[masked[31] - 1]) : null,
    sil: computeSilhouette
      ? bbox(rows.find((_, i) => b.shapeIds[i] && b.shapeIds[i].startsWith('__silhouette__')))
      : null,
  };
}

const off = await read(false);
const on = await read(true);

// 1. The option adds exactly the silhouette row and nothing else.
ok(
  on.b.numShapes === off.b.numShapes + 1 && on.b.shapeIds[0].startsWith('__silhouette__'),
  `computeSilhouette adds one row at the front (${off.b.numShapes} -> ${on.b.numShapes}, shapeIds[0] ${on.b.shapeIds[0]})`,
);

// 2. The pattern carrier points at its CHILD, not at the silhouette.
ok(
  near(off.patChild, [2, 3, 12, 10]),
  `without the silhouette the carrier's tile row is the pattern child ${fmt(off.patChild)}`,
);
ok(
  near(on.patChild, off.patChild),
  `with the silhouette the carrier still points at its child ${fmt(on.patChild)}, want ${fmt(off.patChild)}`,
);

// 3. The objectBoundingBox clip binds to the rect that REFERENCED it (x = 0 .. 0.5 of the 40x40 rect at 100,100).
ok(
  near(off.clipRow, [100, 100, 120, 140]),
  `without the silhouette the clip is the left half of its own rect ${fmt(off.clipRow)}`,
);
ok(
  near(on.clipRow, off.clipRow),
  `with the silhouette the clip still binds to its own rect ${fmt(on.clipRow)}, want ${fmt(off.clipRow)}`,
);

// 4. ...and the objectBoundingBox mask likewise (x = 0 .. 0.25 of the 60x30 rect at 20,150).
ok(
  near(off.maskRow, [20, 150, 35, 180]),
  `without the silhouette the mask is the left quarter of its own rect ${fmt(off.maskRow)}`,
);
ok(
  near(on.maskRow, off.maskRow),
  `with the silhouette the mask still binds to its own rect ${fmt(on.maskRow)}, want ${fmt(off.maskRow)}`,
);

// 5. The union is over the DRAWN art only, and DRAWN means VISIBLE. The pattern rect reaches (90, 70);
//    the 40x40 rect at (100, 100) is clipped to its left half, so it reaches x = 120, not 140; the 60x30 rect at
//    (20, 150) is masked to its left quarter, so it reaches x = 35. Extent (10, 10)..(120, 180), and the default
//    4-unit outline pads the stroke row by 2. A silhouette that took the pattern child in reaches (0, 0)
//    instead; one that took the clipped rect at its FULL extent reaches x = 142.
ok(
  near(on.sil, [8, 8, 122, 182], 1e-2),
  `the silhouette covers the VISIBLE art padded by its half width ${fmt(on.sil)}, want (8, 8, 122, 182)`,
);

// 6. Every other drawn row is float-for-float unchanged either way (the silhouette is prepended, so compare
//    off[i] to on[i+1]). Prepending a shape legitimately RENUMBERS five slots and nothing else: the accumulation
//    group id (14), the curve/band table offset (16, 17), the 1-based clip and mask ROW (30, 31) and the pattern
//    child-row marker (40-43). Everything a row says about its own geometry and paint must be identical, which is
//    what an unshifted binding breaks: it changes the CLIP ROW'S bbox, not the index that names it.
{
  const RENUMBERED = new Set([14, 16, 17, 30, 31, 40, 41, 42, 43]);
  let moved = 0,
    first = '';
  for (let i = 0; i < off.drawn.length; i++) {
    const a = off.drawn[i],
      c = on.drawn[i + 1];
    if (!c) {
      moved++;
      continue;
    }
    for (let k = 0; k < a.length; k++) {
      if (RENUMBERED.has(k)) continue;
      if (a[k] !== c[k] && !(a[k] !== a[k] && c[k] !== c[k])) {
        moved++;
        if (moved < 5) first += `row ${i} float ${k}: ${a[k]} -> ${c[k]}; `;
      }
    }
  }
  ok(
    moved === 0,
    `every drawn row is unchanged by the option (${moved} moved${first ? '; ' + first : ''})`,
  );
}

console.log(fail ? `silhouetteRefIndexSmoke FAIL (${fail})` : 'silhouetteRefIndexSmoke PASS');
process.exit(fail ? 1 : 0);
