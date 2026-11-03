// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// harfbuzzCompatSmoke -- real-script strings in installed system fonts against HarfBuzz 14.x default-feature shaping.
//
// harfbuzzSweepData.json holds, per case, the glyph ids and pen positions (pen + x offset, in font units) uharfbuzz produced;
// The recorded font bytes are identified by size and SHA256. A different or
// unavailable font build skips its case; glyph ids belong to the recorded bytes.
//
// This sweep compares sorted glyph identities and rounded horizontal positions.
// It does not compare output order, vertical positions, advances or source clusters.
// SPEC_DIFFERS identifies expected differences between the two compatibility modes.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';

const cases = JSON.parse(
  readFileSync(new URL('./harfbuzzSweepData.json', import.meta.url), 'utf8'),
);
// NewYork: trak tracking (spec default differs). Kannada MN has morx and GSUB: AAT is preferred by default, so it matches in every
// mode but `preferAat: false`, which keeps GSUB/GPOS and so differs from HarfBuzz there.
const SPEC_DIFFERS = new Set(['NewYork.ttf']);
const OPENTYPE_DIFFERS = new Set(['Kannada MN.ttc']);
let failures = 0,
  ran = 0,
  skipped = 0;
const fontBytes = new Map();
for (const c of cases) {
  if (!existsSync(c.path) || statSync(c.path).size !== c.size) {
    skipped++;
    continue;
  }
  if (!/^[a-f0-9]{64}$/.test(c.sha256 || ''))
    throw Error('Recorded font SHA256 missing: ' + c.path);
  if (!fontBytes.has(c.path)) {
    const bytes = readFileSync(c.path);
    fontBytes.set(c.path, { bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const recorded = fontBytes.get(c.path);
  if (recorded.sha256 !== c.sha256) {
    skipped++;
    continue;
  }
  const name = c.path.split('/').pop();
  const font = new MantleFontAsset(new Uint8Array(recorded.bytes), { faceIndex: c.face });
  for (const [mode, opts] of [
    ['harfbuzz', { compat: 'harfbuzz' }],
    ['spec', { compat: 'spec' }],
    ['opentype', { preferAat: false }],
  ]) {
    const compat = mode;
    const slots = _layoutSlotsForTest([{ text: c.text, style: { ...defaultStyle() } }], font, opts)
      .filter((s) => !s.isDirective)
      .map((s) => [s.glyphId, s.penX * c.upem]);
    // Positions may differ by one unit of rounding: compare with a tolerance.
    const sorted = (rows) =>
      rows.map(([g, x]) => [g, Math.round(x)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const a = sorted(slots),
      b = sorted(c.glyphs);
    const ok =
      a.length === b.length && a.every(([g, x], i) => g === b[i][0] && Math.abs(x - b[i][1]) <= 1);
    ran++;
    const expectOk =
      mode === 'harfbuzz' ||
      (mode === 'spec'
        ? !SPEC_DIFFERS.has(name)
        : !SPEC_DIFFERS.has(name) && !OPENTYPE_DIFFERS.has(name));
    if (ok !== expectOk) {
      failures++;
      console.error(
        `FAIL ${name} [${compat}] ${ok ? 'now matches HarfBuzz' : 'differs from HarfBuzz'}: ${c.text}`,
      );
    }
  }
}
console.log(
  skipped === cases.length
    ? 'HARFBUZZ-COMPAT SKIP (no recorded font present)'
    : failures
      ? `HARFBUZZ-COMPAT FAIL (${failures})`
      : `HARFBUZZ-COMPAT PASS (${ran} runs, ${skipped} cases skipped)`,
);
process.exit(failures ? 1 : skipped === cases.length ? 77 : 0);
