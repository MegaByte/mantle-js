// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nameCodecsSmoke.mjs — name-record codecs against fontTools (default, spec) and HarfBuzz (compat:"harfbuzz").
// Fixture: csharp_tests/font-f2/NameCodecFixture.json from genNameCodecFixture.py (the C# runtime's tests read it too).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';

const fx = JSON.parse(
  readFileSync(new URL('../fixtures/fonts/nameCodecs.json', import.meta.url), 'utf8'),
);
const bytes = new Uint8Array(Buffer.from(fx.font, 'base64'));
let failures = 0,
  checks = 0;
const check = (label, want, got) => {
  checks++;
  if (want !== got) {
    failures++;
    console.error(`FAIL ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  }
};

const spec = new MantleFontAsset(bytes);
const hbf = new MantleFontAsset(bytes, { compat: 'harfbuzz' });
const specRecs = spec.name.decodedRecords();
for (const r of fx.records) {
  const label = `${r.platform}/${r.encoding}/${r.language} (${r.codec})`;
  const got = specRecs.find((x) => x.nameID === r.nameId).text;
  // fontTools has no codec for Mac Arabic (py null): the reader keeps its latin-1 reading.
  if (r.py !== null) check(`spec ${label}`, r.py, got);
  // HarfBuzz: null = the record is invisible; get() then finds nothing for that nameID.
  const hgot = hbf.name.get(r.nameId);
  check(`harfbuzz ${label}`, r.hb, hgot);
}
// Default lookup in spec mode returns the decoded record.
check('get(100) spec', fx.records[0].py, spec.name.get(100));
console.log(`NAME CODECS: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
