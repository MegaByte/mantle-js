// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeTextRebuildSmoke -- what a native text label costs to change, and that the cheaper build draws the same text.
//
// A HUD rewrites a native label often, as a clock or a score. The native bundle needs only curves, so its build skips the
// GL tables and probes its box without them; a font outlines each glyph once; and two changes in one task rebuild once,
// to the last. CPU, no DOM.
import { readFileSync } from 'node:fs';
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { buildTextSections } = await import('../src/font/textSections.js');
const { createNativeTextBundle, sectionsToSvgSource } = await import('../src/fallback/nativeTextBundle.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const fontOf = () =>
  new MantleFontAsset(new Uint8Array(readFileSync(new URL('./fixtures/fonts/jstfPriorities.ttf', import.meta.url))));
const STYLE = { fontSizePx: 32 };
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

{
  const font = fontOf();
  const gid = font.glyphIdForChar ? font.glyphIdForChar('a'.codePointAt(0)) : 1;
  ok(font.getGlyphSegsByGidVar(gid) === font.getGlyphSegsByGidVar(gid), 'a glyph asked for twice is outlined once');
}
{
  const font = fontOf();
  for (const [text, style] of [
    ['ab', STYLE],
    ['abc ab', { fontSizePx: 20 }],
    ['ab abc ab abc', { fontSizePx: 24, layoutWidthEm: 3 }],
    ['', STYLE],
  ]) {
    const full = await buildTextSections(font, text, style, false);
    const curves = await buildTextSections(font, text, style, false, { curvesOnly: true });
    const label = JSON.stringify(text) + (style.layoutWidthEm ? ' wrapped' : '');
    ok(
      JSON.stringify(sectionsToSvgSource(curves.sections)) === JSON.stringify(sectionsToSvgSource(full.sections)),
      `${label}: the curves-only build draws what the full build draws`,
    );
    ok(
      JSON.stringify(curves.sections?.globalBBox ?? null) === JSON.stringify(full.sections?.globalBBox ?? null),
      `${label}: and has the same box`,
    );
  }
}
{
  const font = fontOf();
  const outlined = { count: 0 };
  const outline = font.getGlyphSegsByGidVar.bind(font);
  font.getGlyphSegsByGidVar = (...args) => {
    outlined.count++;
    return outline(...args);
  };
  const label = await createNativeTextBundle({ font, text: 'ab', style: STYLE });
  await settled();
  outlined.count = 0;
  await label.setText('abc');
  const once = outlined.count;
  await label.setText('ab');
  await settled();
  outlined.count = 0;
  const first = label.setText('abcd');
  const last = label.setText('abc');
  await Promise.all([first, last]);
  ok(label.text === 'abc', 'two changes in one task: the last one shows');
  ok(outlined.count === once, `and they rebuild once (${outlined.count} glyph reads, one rebuild reads ${once})`);
  label.dispose();
}
console.log(fail ? `nativeTextRebuildSmoke: ${fail} FAILED` : 'nativeTextRebuildSmoke: PASS');
process.exit(fail ? 1 : 0);
