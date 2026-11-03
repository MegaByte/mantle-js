// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Exercises GPOS feature dispatch + context-positioning machinery
// (types 7/8) + extension deref (type 9).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ----- T1: SFArabic has kern + curs + mark + mkmk + ... ----------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) {
    console.log('Skip SFArabic:', e.message);
  }
  if (font) {
    const gpos = font.gpos;
    const tags = ['kern', 'curs', 'mark', 'mkmk', 'dist', 'vpal', 'vkrn', 'vert', 'vrt2'];
    const present = tags.filter((t) => gpos.hasFeature(t));
    ok(`T1 SFArabic GPOS features: ${present.join(' ')}`);
    // Existing capability bits should agree
    if (gpos.hasFeature('mark') !== gpos.hasMarkBase) fail('T1 hasFeature/hasMarkBase mismatch');
    if (gpos.hasFeature('mkmk') !== gpos.hasMarkMark) fail('T1 hasFeature/hasMarkMark mismatch');
  }
}

// ----- T2: SFNS has kern --------------------------------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFNS.ttf')));
    font.getMetrics(0x41);
  } catch (e) {
    console.log('Skip SFNS:', e.message);
  }
  if (font) {
    const gpos = font.gpos;
    if (!gpos.hasFeature('kern')) fail('T2 SFNS has no kern feature');
    else ok(`T2 SFNS GPOS hasFeature('kern') = true`);
  }
}

// ----- T3: getLookupAt deref + type returned ---------------------
{
  let font = null;
  try {
    font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/SFArabic.ttf')));
    font.getMetrics(0x0628);
  } catch (e) {
    console.log('Skip:', e.message);
  }
  if (font) {
    const gpos = font.gpos;
    // Walk every lookup and confirm getLookupAt returns matching types.
    const v = font._tables.view;
    const lookupListOff = gpos.lookupListOff;
    if (!lookupListOff) fail('T3 lookupListOff missing');
    else {
      const lookupCount = v.getUint16(lookupListOff, false);
      let extCount = 0,
        typed = 0;
      for (let i = 0; i < lookupCount; i++) {
        const r = gpos.getLookupAt(i);
        if (!r) {
          fail(`T3 lookup ${i} returned null`);
          break;
        }
        const rawType = v.getUint16(
          lookupListOff + v.getUint16(lookupListOff + 2 + i * 2, false),
          false,
        );
        if (rawType === 9) extCount++;
        typed++;
      }
      ok(`T3 walked ${typed} GPOS lookups (${extCount} ext-9 wrappers)`);
    }
  }
}

// ----- T4: unknown feature returns null ---------------------------
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
    const gpos = font.gpos;
    if (gpos.hasFeature('xyzw')) fail('T4 unknown feature unexpectedly hasFeature=true');
    else ok(`T4 unknown feature → hasFeature=false`);
  }
}

// Conditional feature selection follows changing axes on a reused font asset.
{
  await import('../../src/font/index.js');
  const { featureVariationFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const fixture = new MantleFontAsset(featureVariationFont('gpos'));
  for (const axis of [0, 0.1, 1, 0, 1, 0])
    for (const tagged of [false, true]) {
      const layout = { varCoords: tagged ? { wght: axis } : [axis] };
      const result = measureGlyphs([{ text: 'aa', style: defaultStyle() }], fixture, layout);
      const expected = axis === 0 ? 0.6 : 0.8;
      if (
        result.glyphs.length !== 2 ||
        Math.abs(result.glyphs[0].advance - expected) > 1e-6 ||
        Math.abs(result.glyphs[1].penX - expected) > 1e-6
      )
        fail(`conditional feature "gpos"/${axis}/${tagged}`);
    }
}

{
  const { requiredLanguageFont } = await import('./_featureVariationFonts.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  {
    const font = new MantleFontAsset(requiredLanguageFont('position-pair'));
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.36) > 1e-6
      )
        fail('required language feature position-pair');
    }
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: { xxxx: true },
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.36) > 1e-6
      )
        fail('required language feature position-pair');
    }
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: ['xxxx'],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.36) > 1e-6
      )
        fail('required language feature position-pair');
    }
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: ['kern'],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.4) > 1e-6
      )
        fail('required language feature position-pair');
    }
  }
  {
    const font = new MantleFontAsset(requiredLanguageFont('required-kern'));
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.4) > 1e-6
      )
        fail('required language feature required-kern');
    }
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: { kern: true },
        disabledFeatures: [],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.4) > 1e-6
      )
        fail('required language feature required-kern');
    }
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: ['kern'],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.4) > 1e-6
      )
        fail('required language feature required-kern');
    }
    {
      const m = measureGlyphs([{ text: 'ab', style: defaultStyle() }], font, {
        varCoords: [0, 0],
        features: {},
        disabledFeatures: ['kern'],
      });
      if (
        m.glyphs.length !== 2 ||
        Math.abs((m.glyphs.at(-1)?.penX ?? 0) + (m.glyphs.at(-1)?.advance ?? 0) - 1.4) > 1e-6
      )
        fail('required language feature required-kern');
    }
  }
}

console.log();
console.log(failures === 0 ? 'GPOS-LOOKUP-TYPES PASS' : `GPOS-LOOKUP-TYPES FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
