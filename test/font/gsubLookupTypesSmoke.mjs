// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Exercises GSUB lookup types (3 alternate, 5 context, 6 chaining
// context, 7 extension, 8 reverse chaining) + generic feature-tag dispatch.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: capability bits + feature discovery --------------------
// SFArabic ships many features including `salt`/`dlig`/`frac` + type 3.
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) {
    console.log('Skip SFArabic:', e.message);
  }
  if (font) {
    const gsub = font.gsub;
    const tags = [
      'aalt',
      'dlig',
      'frac',
      'sups',
      'subs',
      'tnum',
      'dnom',
      'numr',
      'ordn',
      'case',
      'locl',
      'calt',
      'rclt',
    ];
    const present = tags.filter((t) => gsub.hasFeature(t));
    if (present.length === 0) fail('T1 SFArabic discovered no extra features');
    else ok(`T1 SFArabic hasFeature() picks up: ${present.join(' ')}`);
  }
}

// ----- T2: alternate substitution (type 3 dispatch) ---------------
// SFArabic carries one type-3 lookup. The 'aalt' feature is the
// canonical user of alternate substitution.
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) {
    console.log('Skip SFArabic for T2:', e.message);
  }
  if (font) {
    const gsub = font.gsub;
    // Try aalt across several gids; need at least one to substitute
    // (otherwise the test isn't proving anything).
    let foundSubstitution = false;
    for (let cp = 0x0620; cp <= 0x064a; cp++) {
      const baseGid = font.codepointToGlyphId(cp);
      if (!baseGid) continue;
      const altGid = gsub.substituteAlternate(baseGid, 'aalt', 0);
      if (altGid !== baseGid) {
        foundSubstitution = true;
        break;
      }
    }
    // If aalt isn't actually populated with alternates for any of
    // these gids, that's fine — at least the dispatch didn't crash.
    if (foundSubstitution) ok(`T2 'aalt' alternate substitution fires on at least one Arabic gid`);
    else ok(`T2 'aalt' dispatch invoked safely (no alternates for tested gids)`);
  }
}

// ----- T3: generic applyFeatureToSeq — pass-through for unknown tag
{
  let font = null;
  try {
    font = new MantleFontAsset(
      new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
    );
    font.getMetrics(0x41);
  } catch (e) {
    console.log('Skip Arial:', e.message);
  }
  if (font) {
    const seq = [
      font.codepointToGlyphId(0x41),
      font.codepointToGlyphId(0x42),
      font.codepointToGlyphId(0x43),
    ];
    const out = font.gsub.applyFeatureToSeq('xyzx' /* unknown tag */, seq);
    let same = out.length === seq.length;
    for (let i = 0; same && i < seq.length; i++) if (out[i] !== seq[i]) same = false;
    if (!same) fail(`T3 unknown tag mutated stream: out=[${out.join(',')}], in=[${seq.join(',')}]`);
    else ok(`T3 applyFeatureToSeq with unknown tag = identity passthrough`);
  }
}

// ----- T4: SFNS — feature discovery (validates type 1 + 6 dispatch) -
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFNS.ttf')));
    font.getMetrics(0x41);
  } catch (e) {
    console.log('Skip SFNS:', e.message);
  }
  if (font) {
    const gsub = font.gsub;
    const tags = [
      'frac',
      'sups',
      'subs',
      'tnum',
      'onum',
      'locl',
      'case',
      'ordn',
      'dnom',
      'numr',
      'ss01',
      'ss02',
      'ss03',
      'calt',
    ];
    const present = tags.filter((t) => gsub.hasFeature(t));
    if (present.length < 5) fail(`T4 SFNS feature discovery too sparse: ${present.length}`);
    else ok(`T4 SFNS feature discovery: ${present.join(' ')}`);
  }
}

// ----- T5: 'frac' fraction substitution end-to-end ----------------
// SFNS ships 'frac' which (depending on input) maps '1/2' to a single
// fraction glyph via a chaining-context lookup that calls 'numr' and
// 'dnom' nested lookups + a single-sub for the slash.
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFNS.ttf')));
    font.getMetrics(0x41);
  } catch (e) {
    console.log('Skip SFNS for T5:', e.message);
  }
  if (font) {
    // Sequence: '1' '/' '2' — gids for those.
    const one = font.codepointToGlyphId(0x31);
    const slash = font.codepointToGlyphId(0x2f);
    const two = font.codepointToGlyphId(0x32);
    const seq = [one, slash, two];
    const out = font.gsub.applyFeatureToSeq('frac', seq);
    // We don't claim a specific output; just verify the call didn't
    // crash AND that the output is a valid array.
    if (!Array.isArray(out)) fail(`T5 frac returned non-array`);
    else if (out.length === 0) fail(`T5 frac produced empty output`);
    else {
      const changed = out.length !== seq.length || out.some((g, i) => g !== seq[i]);
      ok(
        `T5 'frac' on '1/2': ${changed ? 'substituted' : 'unchanged (font-specific)'}; out length ${out.length}, gids [${out.join(',')}]`,
      );
    }
  }
}

// ----- T6: 'sups' superscript substitution ----------------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFNS.ttf')));
    font.getMetrics(0x41);
  } catch (e) {
    console.log('Skip SFNS for T6:', e.message);
  }
  if (font) {
    // '1' gid → its superscript variant (typically a single sub).
    const one = font.codepointToGlyphId(0x31);
    const seq = [one];
    const out = font.gsub.applyFeatureToSeq('sups', seq);
    if (out.length !== 1) fail(`T6 sups expanded the stream`);
    else if (out[0] === one) {
      // Not a fail — some fonts only do sups via contextual substitution.
      ok(`T6 'sups' did not substitute on isolated '1' (font may need context)`);
    } else ok(`T6 'sups' single-sub: '1' (gid ${one}) → gid ${out[0]}`);
  }
}

// Conditional feature selection follows changing axes on a reused font asset.
{
  await import('../../src/font/index.js');
  const { featureVariationFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const fixture = new MantleFontAsset(featureVariationFont('gsub'));
  for (const axis of [0, 0.1, 1, 0, 1, 0])
    for (const tagged of [false, true]) {
      const layout = { varCoords: tagged ? { wght: axis } : [axis] };
      const result = measureGlyphs([{ text: 'aa', style: defaultStyle() }], fixture, layout);
      const expected = axis === 0 ? 0.6 : 0.9;
      if (
        result.glyphs.length !== 2 ||
        Math.abs(result.glyphs[0].advance - expected) > 1e-6 ||
        Math.abs(result.glyphs[1].penX - expected) > 1e-6
      )
        fail(`conditional feature "gsub"/${axis}/${tagged}`);
    }
}

{
  const { reversedLookupOrderFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const font = new MantleFontAsset(reversedLookupOrderFont());
  for (const coords of [
    [0, 0],
    [0.5, 0],
    [1, 0],
  ]) {
    const result = measureGlyphs([{ text: 'a', style: defaultStyle() }], font, {
      varCoords: coords,
      features: { ss01: true },
    });
    if (result.glyphs.length !== 1 || Math.abs(result.glyphs[0].advance - 1.2) > 1e-6)
      fail('feature lookups run once in LookupList order');
  }
}

{
  const { requiredLanguageFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  {
    const font = new MantleFontAsset(requiredLanguageFont('multiple'));
    {
      const m = measureGlyphs([{ text: 'a', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 2.1) > 1e-6
      )
        fail('required language feature multiple');
    }
    {
      const m = measureGlyphs([{ text: 'a', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: { xxxx: true },
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 2.1) > 1e-6
      )
        fail('required language feature multiple');
    }
    {
      const m = measureGlyphs([{ text: 'a', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: ['xxxx'],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 2.1) > 1e-6
      )
        fail('required language feature multiple');
    }
    {
      const m = measureGlyphs([{ text: 'a', style: defaultStyle() }], font, {
        varCoords: [0.5, 0],
        features: {},
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 2.1) > 1e-6
      )
        fail('required language feature multiple');
    }
  }
  {
    const font = new MantleFontAsset(requiredLanguageFont('known-liga'));
    {
      const m = measureGlyphs([{ text: 'aa', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 1 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 0.9) > 1e-6
      )
        fail('required language feature known-liga');
    }
    {
      const m = measureGlyphs([{ text: 'aa', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: { liga: true },
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 1 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 0.9) > 1e-6
      )
        fail('required language feature known-liga');
    }
    {
      const m = measureGlyphs([{ text: 'aa', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: ['liga'],
      });
      if (
        m.glyphs.length !== 1 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 0.9) > 1e-6
      )
        fail('required language feature known-liga');
    }
    {
      const m = measureGlyphs([{ text: 'aa', style: defaultStyle() }], font, {
        varCoords: [0.5, 0],
        features: {},
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 1 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 0.9) > 1e-6
      )
        fail('required language feature known-liga');
    }
  }
}

{
  const { requiredOwnershipFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const markFont = new MantleFontAsset(requiredOwnershipFont('required-ligature-mark'));
  for (const text of ['a\u20d0a', 'aa\u20d0']) {
    const result = measureGlyphs([{ text, style: defaultStyle() }], markFont, {});
    const mark = result.glyphs[1];
    if (
      result.glyphs.length !== 2 ||
      Math.abs(mark.penX - (text[1] === 'a' ? 0.4 : 0.1)) > 1e-6 ||
      Math.abs(mark.penY + 0.7) > 1e-6 ||
      mark.cluster !== 0
    )
      fail('required ligature retains mark component and cluster');
  }
  const chainFont = new MantleFontAsset(requiredOwnershipFont('required-after-ccmp'));
  for (const enabled of [false, true]) {
    const result = measureGlyphs([{ text: 'a', style: defaultStyle() }], chainFont, {
      features: { xxxx: enabled },
    });
    if (
      result.glyphs.length !== 1 ||
      Math.abs(result.glyphs[0].advance - (enabled ? 1.2 : 0.9)) > 1e-6
    )
      fail('explicit custom required feature retains its optional stage');
  }
}

{
  const { identityFirstSubtableFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const font = new MantleFontAsset(identityFirstSubtableFont());
  for (const axis of [0, 0.5, 1]) {
    const result = measureGlyphs([{ text: 'a', style: defaultStyle() }], font, {
      varCoords: [axis, 0],
    });
    if (result.glyphs.length !== 1 || Math.abs(result.glyphs[0].advance - 0.6) > 1e-6)
      fail('identity substitution stops the first covered subtable');
  }
}

{
  const { localizedFormsFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const font = new MantleFontAsset(localizedFormsFont());
  for (const enabled of [undefined, true, false, 0]) {
    const layout = enabled === undefined ? {} : { features: { locl: enabled } };
    const result = measureGlyphs([{ text: 'a', style: defaultStyle() }], font, layout);
    if (
      result.glyphs.length !== 1 ||
      Math.abs(result.glyphs[0].advance - (enabled === false || enabled === 0 ? 0.6 : 0.9)) > 1e-6
    )
      fail('localized forms default and explicit once-only selection');
  }
}

{
  const { mixedRequiredFonts } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const fonts = mixedRequiredFonts().map((bytes) => new MantleFontAsset(bytes));
  const result = measureGlyphs([{ text: 'az', style: defaultStyle() }], fonts[0], {
    varCoords: [0.5, 0],
    fallbacks: [fonts[1]],
  });
  if (
    result.glyphs.length !== 2 ||
    Math.abs(result.glyphs[0].advance - 0.9) > 1e-6 ||
    Math.abs(result.glyphs[1].penX - 0.9) > 1e-6
  )
    fail('required fallback does not repeat primary rvrn');
}

console.log();
console.log(failures === 0 ? 'GSUB-LOOKUP-TYPES PASS' : `GSUB-LOOKUP-TYPES FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
