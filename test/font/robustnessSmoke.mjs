// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// robustnessSmoke.mjs — exercise edge cases and malformed inputs.
//
// Each case should either return a sensible result OR throw a clear
// error — neither crash silently nor produce garbage.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MantleFontAsset, decodeIfWoff2 } from '../../src/font/fontAsset.js';
import { registerCffReader } from '../../src/font/formats/cff.js';
registerCffReader();
import { buildTextRun, buildFromMarkup } from '../../src/font/textRun.js';
import { registerWoff2Reader } from '../../src/font/formats/woff2.js';
import { fontFixture, optionalAsset } from '../_assets.mjs';
registerWoff2Reader();

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function expectThrows(label, fn) {
  try {
    fn();
    fail(label, 'did not throw');
  } catch (e) {
    console.log(`ok ${label} — threw: ${(e.message || String(e)).slice(0, 80)}`);
  }
}
async function expectThrowsAsync(label, fn) {
  try {
    await fn();
    fail(label, 'did not throw');
  } catch (e) {
    console.log(`ok ${label} — threw: ${(e.message || String(e)).slice(0, 80)}`);
  }
}
function expectOk(label, val, predicate) {
  if (predicate(val)) console.log(`ok ${label}`);
  else fail(label, `value: ${JSON.stringify(val).slice(0, 100)}`);
}
function fail(label, msg) {
  console.error(`FAIL ${label}: ${msg}`);
  failures++;
}

const arialBytes = new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf'));
const arial = new MantleFontAsset(arialBytes);

// ---- 1. Empty string ----
{
  const b = await buildTextRun('', arial);
  expectOk('empty string → 0 shapes', b.numShapes, (n) => n === 0);
}
{
  const b = await buildFromMarkup('', arial);
  expectOk('empty markup → 0 shapes', b.numShapes, (n) => n === 0);
}

// ---- 2. Whitespace-only ----
{
  const b = await buildTextRun('   ', arial);
  expectOk('whitespace → 0 shapes (spaces have no contours)', b.numShapes, (n) => n === 0);
}

// ---- 3. Unmapped codepoint (reserved U+1FFFF) → renders .notdef ----
{
  // Standard font behavior: unmapped codepoints render the .notdef
  // glyph (typically a hollow rectangle). Better than silently
  // disappearing.
  const b = await buildTextRun('\u{1FFFF}', arial);
  expectOk('unmapped → 1 .notdef shape', b.numShapes, (n) => n === 1);
}

// ---- 4. Mixed real + truly unmapped ----
{
  const b = await buildTextRun('A\u{1FFFF}Z', arial);
  expectOk('A + unmapped + Z → 3 shapes (A, .notdef, Z)', b.numShapes, (n) => n === 3);
}

// ---- 5. Surrogate-pair codepoint walk (no crash on emoji range) ----
{
  // Arial may or may not have a glyph for U+1F600; we just check
  // that the parser walks the surrogate pair without crashing and
  // returns ≤ 1 shape.
  const b = await buildTextRun('\u{1F600}', arial);
  expectOk('surrogate pair handled → 0 or 1 shape', b.numShapes, (n) => n === 0 || n === 1);
}

// ---- 6. Null font ----
await expectThrowsAsync('buildTextRun with null font', async () => await buildTextRun('hi', null));

// ---- 7. Empty font bytes ----
expectThrows('MantleFontAsset(empty Uint8Array)', () =>
  new MantleFontAsset(new Uint8Array(0)).getMetrics(0x41),
);

// ---- 8. Random garbage ----
expectThrows('MantleFontAsset(garbage)', () =>
  new MantleFontAsset(new Uint8Array(64)).getMetrics(0x41),
);

// ---- 9. Truncated woff2 ----
await expectThrowsAsync('decodeIfWoff2(truncated header)', async () => {
  const buf = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0]);
  await decodeIfWoff2(buf);
});

// ---- 10. Unclosed markup tag → passes through as literal ----
{
  const b = await buildFromMarkup('hello <color=#f00 missing close', arial);
  expectOk('unclosed tag → renders fragment as text', b.numShapes, (n) => n > 0);
}

// ---- 11. Extra close tag ----
{
  const b = await buildFromMarkup('<color=red>X</color></color>Y', arial);
  // </color> in default style is a no-op pop attempt (stack only has
  // default), so it stays in the literal text. Then 'Y' renders too.
  // Total shapes ≈ "X" (1) + "</color>" literal (8 chars) + "Y" (1) = 10.
  // Accept any positive count — the point is no crash.
  expectOk('extra close tag → renders without crashing', b.numShapes, (n) => n > 0);
}

// ---- 12. Very long string ----
{
  const longText = 'A'.repeat(1000);
  const b = await buildTextRun(longText, arial);
  expectOk('1000 chars → 1000 shapes', b.numShapes, (n) => n === 1000);
}

// ---- 13. STIX CFF ----
{
  const stix = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/STIXGeneral.otf')),
  );
  const b = await buildTextRun('A', stix);
  expectOk('STIX CFF "A" → 1 shape', b.numShapes, (n) => n === 1);
}

// ---- 14. woff2 round-trip ----
{
  // The only case here that needs a fetched fixture; the other fifteen run off system fonts and
  // synthetic input. optionalAsset keeps them running and turns the whole file's exit into SKIP.
  const w2p = optionalAsset(fontFixture('roboto-regular.woff2'));
  if (w2p) {
    const w2 = await decodeIfWoff2(new Uint8Array(readFileSync(w2p)));
    const roboto = new MantleFontAsset(w2);
    const b = await buildTextRun('Hi', roboto);
    expectOk('woff2 → asset → bundle', b.numShapes, (n) => n === 2);
  }
}

// ---- 15. Long markup with many tag transitions ----
{
  const m = '<color=#f00>A</color><color=#0f0>B</color><color=#00f>C</color>'.repeat(10);
  const b = await buildFromMarkup(m, arial);
  expectOk('30 tag transitions → 30 shapes', b.numShapes, (n) => n === 30);
}

// ---- 16. Markup with deeply nested tags ----
{
  const m = '<color=red><size=2><voffset=1>X</voffset></size></color>';
  const b = await buildFromMarkup(m, arial);
  expectOk('3 nested tags → 1 shape', b.numShapes, (n) => n === 1);
}

console.log();
console.log(failures === 0 ? `ROBUSTNESS PASS` : `ROBUSTNESS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
