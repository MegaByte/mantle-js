// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// statSelectionSmoke.mjs — STAT AxisValue selection + automatic style naming, the picker catalog, and the
// OpenType feature catalog, against fontTools. Fixture: csharp_tests/font-f2/StatFixture.json (genStatFixture.py),
// which the C# runtime's StatSelectionParity.cs reads too.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerVariableFontReaders } from '../../src/font/variations/index.js';

registerVariableFontReaders();
const fx = JSON.parse(
  readFileSync(new URL('../fixtures/fonts/statSelection.json', import.meta.url), 'utf8'),
);
const load = (b64) => new MantleFontAsset(new Uint8Array(Buffer.from(b64, 'base64')));
let failures = 0,
  checks = 0;
const check = (label, want, got) => {
  checks++;
  const w = JSON.stringify(want),
    g = JSON.stringify(got);
  if (w !== g) {
    failures++;
    console.error(`FAIL ${label}: want ${w} got ${g}`);
  }
};

const A = load(fx.fontA);
for (const c of fx.casesA)
  check(`A fontTools ${JSON.stringify(c.location)}`, c.fonttools, A.instanceStyleName(c.location));
for (const c of fx.specA)
  check(`A spec ${JSON.stringify(c.location)}`, c.name, A.instanceStyleName(c.location));
// A partial location falls back to the fvar defaults (400/100/0): all elidable -> "Regular".
check('A defaults', 'Regular', A.instanceStyleName());

// Ordering by axisOrdering (spec), where fontTools sorts by design-axis index.
const B = load(fx.fontB);
for (const c of fx.casesB)
  check(`B spec ordering ${JSON.stringify(c.location)}`, c.spec, B.instanceStyleName(c.location));

// statNaming 'fonttools' (constructor option or per-call argument) orders by design-axis index, as fontTools does.
check('statNaming default', 'spec', B.statNaming);
const Bft = new MantleFontAsset(new Uint8Array(Buffer.from(fx.fontB, 'base64')), {
  statNaming: 'fonttools',
});
check('statNaming option', 'fonttools', Bft.statNaming);
for (const c of fx.casesB) {
  check(
    `B fontTools ordering (option) ${JSON.stringify(c.location)}`,
    c.fonttools,
    Bft.instanceStyleName(c.location),
  );
  check(
    `B fontTools ordering (argument) ${JSON.stringify(c.location)}`,
    c.fonttools,
    B.instanceStyleName(c.location, 'fonttools'),
  );
  check('B spec ordering via argument', c.spec, Bft.instanceStyleName(c.location, 'spec'));
  check(
    'B styleAxisValues fonttools order',
    ['Bold', 'Condensed'],
    B.styleAxisValues(c.location, 'fonttools').map((v) => B.name.get(v.valueNameID)),
  );
  check(
    'B styleAxisValues spec order',
    ['Condensed', 'Bold'],
    B.styleAxisValues(c.location).map((v) => B.name.get(v.valueNameID)),
  );
}

// Legacy RIBBI family/subfamily records against fontTools' instancer (_updateNameRecords).
for (const c of fx.casesA)
  check(`A ribbi ${JSON.stringify(c.location)}`, c.ribbi, A.ribbiNames(c.location));
for (const c of fx.casesB)
  check(`B ribbi ${JSON.stringify(c.location)}`, c.ribbi, B.ribbiNames(c.location));
check('ribbi without STAT', null, load(fx.fontC).ribbiNames());

// Picker catalog.
const cat = A.pickerCatalog();
check(
  'axis tags',
  ['wght', 'wdth', 'ital'],
  cat.axes.map((a) => a.tag),
);
check(
  'wght value names',
  ['Thin', 'Light', 'Regular', 'Bold', 'Black'],
  cat.axes[0].values.map((v) => v.name),
);
check(
  'Light range',
  [250, 350, 300],
  [cat.axes[0].values[1].rangeMin, cat.axes[0].values[1].rangeMax, cat.axes[0].values[1].value],
);
check(
  'Regular linked + elidable',
  [700, true],
  [cat.axes[0].values[2].linkedValue, cat.axes[0].values[2].elidable],
);
check(
  'combinations',
  [
    {
      name: 'Bold Oblique Combo',
      elidable: false,
      records: [
        { axisTag: 'wght', value: 700 },
        { axisTag: 'ital', value: 1 },
      ],
    },
  ],
  cat.combinations,
);
check(
  'instances',
  ['Regular', 'Bold Italic', 'Condensed Light'],
  cat.instances.map((i) => i.name),
);
check(
  'instance style names (STAT composed)',
  ['Regular', 'Bold Oblique Combo', 'Light Condensed'],
  cat.instances.map((i) => i.styleName),
);

// What a font or format lacks is null, never a sentinel.
check(
  'Thin value has no range or link',
  [100, null, null, null],
  ['value', 'rangeMin', 'rangeMax', 'linkedValue'].map((k) => cat.axes[0].values[0][k]),
);
check(
  'axis ordering present',
  [true, true, true],
  cat.axes.map((a) => typeof a.ordering === 'number'),
);

// Feature catalog vs fontTools FeatureParams.
const C = load(fx.fontC);
const feats = C.pickerCatalog().features;
check(
  'feature tags',
  fx.features.map((f) => f.tag),
  feats.map((f) => f.tag),
);
for (const want of fx.features) {
  const got = feats.find((f) => f.tag === want.tag);
  check(`${want.tag} tables`, want.tables, got.tables);
  check(`${want.tag} ui name`, want.uiName || '', got.name);
  check(`${want.tag} characters`, want.characters, got.characters);
  check(`${want.tag} named parameters`, want.params, got.namedParameterCount);
  if (want.tooltip) check(`${want.tag} tooltip`, want.tooltip, C.name.get(got.tooltipNameID));
  if (want.sample) check(`${want.tag} sample`, want.sample, C.name.get(got.sampleNameID));
}
check(
  'registry label',
  ['Standard Ligatures', 'Kerning', 'Stylistic Set 1', 'Character Variant 2'],
  ['liga', 'kern', 'ss01', 'cv02'].map((t) => feats.find((f) => f.tag === t).label),
);

// RIBBI follows instancer nominal matching; picker range naming remains spec-based.
check('unnameable nominal location', null, A.ribbiNames({ wght: 280, wdth: 100, ital: 0 }));
const statFixture = (name) =>
  new MantleFontAsset(
    new Uint8Array(readFileSync(new URL('../fixtures/fonts/' + name + '.ttf', import.meta.url))),
  );
const mac = statFixture('statRibbiMac'),
  duplicate = statFixture('statRibbiDuplicate'),
  empty = statFixture('statRibbiEmptyF4'),
  elidable = statFixture('statRibbiElidableF4');
check(
  'Mac fixture has no Windows English names',
  false,
  mac.name
    .decodedRecords()
    .some((r) => r.platformID === 3 && r.encodingID === 1 && r.languageID === 0x409),
);
check(
  'Mac-only RIBBI family extension',
  {
    familyName: 'Stat Test Bold',
    subfamilyName: 'Regular',
    typographicFamilyName: 'Stat Test',
    typographicSubfamilyName: 'Bold',
    fullName: 'Stat Test Bold',
    postScriptName: 'StatTest-Bold',
  },
  mac.ribbiNames({ wght: 700, wdth: 100, ital: 0 }),
);
const duplicateNames = duplicate.name.decodedRecords();
check(
  'duplicate English records differ',
  true,
  duplicateNames.some((r, i) =>
    duplicateNames
      .slice(0, i)
      .some(
        (a) =>
          a.nameID === r.nameID &&
          a.platformID === r.platformID &&
          a.encodingID === r.encodingID &&
          a.languageID === r.languageID &&
          a.text !== r.text,
      ),
  ),
);
check(
  'first English record classifies RIBBI',
  {
    familyName: 'Stat Test',
    subfamilyName: 'Bold',
    typographicFamilyName: null,
    typographicSubfamilyName: null,
    fullName: 'Stat Test Bold',
    postScriptName: 'StatTest-Bold',
  },
  duplicate.ribbiNames({ wght: 700, wdth: 100, ital: 0 }),
);
check(
  'empty format4 is present',
  true,
  empty.stat.axisValues.some((v) => v.format === 4 && v.records.length === 0),
);
check('empty format4 declines', null, empty.ribbiNames({ wght: 700, wdth: 100, ital: 1 }));
check(
  'elidable format4 is present',
  true,
  elidable.stat.axisValues.some((v) => v.format === 4 && v.elidable),
);
check(
  'RIBBI filters elidable before dominance',
  {
    familyName: 'Stat Test',
    subfamilyName: 'Bold Italic',
    typographicFamilyName: null,
    typographicSubfamilyName: null,
    fullName: 'Stat Test Bold Italic',
    postScriptName: 'StatTest-BoldItalic',
  },
  elidable.ribbiNames({ wght: 700, wdth: 100, ital: 1 }),
);
check(
  'spec format4 dominance stays unchanged',
  'Regular',
  elidable.instanceStyleName({ wght: 700, wdth: 100, ital: 1 }),
);

console.log(`STAT SELECTION: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
