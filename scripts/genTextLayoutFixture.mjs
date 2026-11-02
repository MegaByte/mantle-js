#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// genTextLayoutFixture.mjs — regenerate test/fixtures/text-layout-hb.json from HarfBuzz.
//
// The text layout smoke (test/font/textLayoutAuditSmoke.mjs) compares Mantle's glyph ids and
// advances with what hb-shape returns, but the routine lane must not shell out to hb-shape,
// so the expected values are frozen here once and the smoke reads the JSON.
//
//   node scripts/genTextLayoutFixture.mjs [hb-shape path]
//
// Needs hb-shape (HarfBuzz 14.x), test/font/fixtures/roboto-regular.ttf and, for the emoji
// rows, /System/Library/Fonts/Apple Color Emoji.ttc. Rows whose font is absent are omitted
// and the smoke skips them.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HB = process.argv[2] || 'hb-shape';
const ROBOTO = path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
const EMOJI = '/System/Library/Fonts/Apple Color Emoji.ttc';

const hbShape = (font, cps) =>
  JSON.parse(
    execFileSync(HB, [
      font,
      '-u',
      cps.map((c) => c.toString(16)).join(','),
      '--output-format=json',
      '--no-glyph-names',
      '--direction=ltr',
    ]).toString(),
  );

// NFC clusters: every canonical two-codepoint decomposition up to U+1FFF whose shaping gives Roboto at
// least one glyph. The smoke requires the same glyph ids: a cluster composes only when the
// font has the composed glyph, otherwise base and mark (or the font's ccmp) draw.
const nfc = [];
for (let c = 0x80; c < 0x2000; c++) {
  const nfd = String.fromCodePoint(c).normalize('NFD');
  if (nfd === String.fromCodePoint(c) || [...nfd].length !== 2) continue;
  const cps = [...nfd].map((ch) => ch.codePointAt(0));
  const out = hbShape(ROBOTO, cps);
  if (out.every((g) => g.g === 0)) continue;
  nfc.push([cps.map((x) => x.toString(16)).join(','), out.map((g) => g.g)]);
}

// Space advances: the advances of the space characters HarfBuzz falls back for.
const upem = 2048;
const spaces = [
  0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x202f, 0x205f, 0x3000,
].map((cp) => {
  const [g] = hbShape(ROBOTO, [cp]);
  return { cp: cp.toString(16), gid: g.g, advanceEm: g.ax / upem };
});

// Emoji: sequences shaped by the emoji font alone.
const emoji = [];
if (existsSync(EMOJI)) {
  const seqs = [
    [0xa9, 0xfe0f],
    [0x2122, 0xfe0f],
    [0x31, 0xfe0f, 0x20e3],
    [0x23, 0x20e3],
    [0x2194, 0xfe0f],
    [0x1f441, 0xfe0f, 0x200d, 0x1f5e8, 0xfe0f],
  ];
  for (const cps of seqs)
    emoji.push({
      cps: cps.map((x) => x.toString(16)).join(','),
      gids: hbShape(EMOJI, cps).map((g) => g.g),
    });
}

const out = {
  generator: 'scripts/genTextLayoutFixture.mjs',
  hbShape: execFileSync(HB, ['--version']).toString().split('\n')[0],
  robotoSha256: createHash('sha256').update(readFileSync(ROBOTO)).digest('hex'),
  nfc,
  spaces,
  emoji,
};
writeFileSync(path.join(ROOT, 'test/fixtures/text-layout-hb.json'), JSON.stringify(out) + '\n');
console.log(`nfc ${nfc.length}, spaces ${spaces.length}, emoji ${emoji.length}`);
