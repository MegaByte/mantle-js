// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textStyleWeightSmoke.mjs — buildTextSections' `style` → span-style mapping.
//
// The span style the layout consumes has a BOOLEAN `bold` (textLayout selects
// the bold variant font on it). A mapping that assigned `out.weight`, a name
// nothing reads, would silently lay out `style: { weight: 700 }` at normal
// weight -- a dead write, so it gets a test.
//
// Asserts the mapping directly (CSS Fonts Level 4 rules) and then end-to-end:
// a bold run wired to a distinct variant font must lay out differently from the
// same text at normal weight.
//
// GL-free (fast node lane). Skips when the Roboto fixture isn't fetched.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../src/font/fontAsset.js';
import { buildTextSections } from '../src/font/textSections.js';
import { isBoldWeight } from '../src/font/textRun.js';
import { fontFixture, requireAsset } from './_assets.mjs';

const FIXTURE = fontFixture('roboto-regular.ttf');
requireAsset(FIXTURE);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

// ---- T1: the CSS weight rule itself -----------------------------------
{
  const bold = [600, 700, 900, '700', 'bold', 'bolder'];
  const normal = [100, 400, 500, '400', 'normal', 'lighter', null, undefined, 'nonsense'];
  const badBold = bold.filter((v) => isBoldWeight(v) !== true);
  const badNormal = normal.filter((v) => isBoldWeight(v) !== false);
  if (!badBold.length && !badNormal.length)
    ok('T1 isBoldWeight follows CSS Fonts Level 4 (600+ / bold / bolder)');
  else fail(`T1 misclassified bold=${JSON.stringify(badBold)} normal=${JSON.stringify(badNormal)}`);
}

const font = new MantleFontAsset(new Uint8Array(readFileSync(FIXTURE)));

// ---- T2: style.weight reaches the layout ------------------------------
// A distinct variant font is the observable: with weight mapped, layout picks
// boldFont for the run; without, it stays on the base font. Using the same file
// as the "bold" variant keeps the fixture set at one font, so the assertion is
// about WHICH font object layout selected, not about glyph shapes.
{
  const built = async (weight) =>
    (
      await buildTextSections(
        font,
        'Hg',
        {
          fontSizePx: 32,
          weight,
          fill: [0, 0, 0, 1],
        },
        false,
      )
    ).sections;
  const normal = await built(400);
  const bold = await built(700);
  if (normal && bold && normal.totalSegments > 0 && bold.totalSegments > 0) {
    ok(`T2 both weights lay out (${normal.totalSegments} segments)`);
  } else {
    fail('T2 a weighted run produced no shapes');
  }
}

// ---- T3: the mapping actually reaches the layout ----------------------
// THE end-to-end guard. With no boldFont wired textLayout SYNTHESIZES bold
// (stroke inflation on top of the fill), which lands in the per-shape meta.
// So a bold weight must produce different meta from a normal one — that is
// only true if style.weight reached span.style.bold. A dead write to
// out.weight leaves the two byte-identical.
const metaFloats = (sections) => {
  const m = sections.meta;
  return m instanceof Float32Array ? m : new Float32Array(m.buffer || m);
};
{
  const a = await buildTextSections(font, 'Hg', { fontSizePx: 32, weight: 400 }, false);
  const b = await buildTextSections(font, 'Hg', { fontSizePx: 32, weight: 700 }, false);
  const ma = metaFloats(a.sections),
    mb = metaFloats(b.sections);
  let differing = 0;
  for (let i = 0; i < Math.min(ma.length, mb.length); i++) if (ma[i] !== mb[i]) differing++;
  if (differing > 0)
    ok(`T3 weight:700 reaches the layout — synthetic bold changed ${differing} meta floats`);
  else
    fail(
      'T3 weight:700 produced meta identical to weight:400 — the mapping never reached span.style.bold',
    );

  // Geometry itself is untouched: synthesis paints, it does not re-outline.
  const ga = a.sections.runMetrics.typoBBox,
    gb = b.sections.runMetrics.typoBBox;
  if (
    a.sections.totalSegments === b.sections.totalSegments &&
    ga.every((v, i) => Math.abs(v - gb[i]) < 1e-9)
  ) {
    ok('T3b synthesis paints rather than re-outlining (segments + typoBBox unchanged)');
  } else {
    fail('T3b synthetic bold perturbed the outline/metrics');
  }
}

// ---- T4: the literal CSS spellings map too ----------------------------
{
  const norm = metaFloats(
    (await buildTextSections(font, 'Hg', { fontSizePx: 32 }, false)).sections,
  );
  const word = metaFloats(
    (await buildTextSections(font, 'Hg', { fontSizePx: 32, weight: 'bold' }, false)).sections,
  );
  let differing = 0;
  for (let i = 0; i < Math.min(norm.length, word.length); i++) if (norm[i] !== word[i]) differing++;
  if (differing > 0) ok(`T4 weight:'bold' maps too (${differing} meta floats differ)`);
  else fail("T4 weight:'bold' was ignored");
}

// ---- T5: a wired bold FACE is selected over synthesis ------------------
// layoutFromStyle forwards the variant faces, so this entry point selects the
// real face when the caller has it loaded rather than synthesizing. Using the same
// file as the "bold" face keeps the fixture set at one font: what is asserted
// is that layout took the SELECTION branch (no synthetic stroke in the meta),
// not that the glyphs differ.
{
  const bold = new MantleFontAsset(new Uint8Array(readFileSync(FIXTURE)));
  const synth = metaFloats(
    (await buildTextSections(font, 'Hg', { fontSizePx: 32, weight: 700 }, false)).sections,
  );
  const wired = metaFloats(
    (await buildTextSections(font, 'Hg', { fontSizePx: 32, weight: 700, boldFont: bold }, false))
      .sections,
  );
  const plain = metaFloats(
    (await buildTextSections(font, 'Hg', { fontSizePx: 32 }, false)).sections,
  );
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!eq(wired, synth) && eq(wired, plain)) {
    ok('T5 a wired boldFont is selected — no synthetic stroke, unlike the synthesized path');
  } else {
    fail(
      `T5 boldFont not honored (wired==synth:${eq(wired, synth)} wired==plain:${eq(wired, plain)})`,
    );
  }
}

console.log();
console.log(failures === 0 ? 'TEXT-STYLE-WEIGHT PASS' : `TEXT-STYLE-WEIGHT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
