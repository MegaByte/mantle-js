// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// setTextRetrySmoke -- setText and setStyle after a failed rebuild, and a repeat of a call still running.
//
// If setText recorded the new text before the rebuild, a rebuild that threw would leave `text` naming a string the bundle does not show, and the equal-text early return would swallow the retry: the
// label would stay stale for good. A repeat of a call in flight must not hit that return and resolve at once with the previous content either. CPU, recording GL stand-in.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
import { readFileSync } from 'node:fs';
const { createFakeGl } = await import('./_fakeGl.mjs');
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { createTextBundle } = await import('../src/textBundle.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const font = new MantleFontAsset(
  new Uint8Array(readFileSync(new URL('./fixtures/fonts/jstfPriorities.ttf', import.meta.url))),
);
const F = createFakeGl({ width: 64, height: 64 });
const S1 = { fontSizePx: 32 },
  S2 = { fontSizePx: 48 };
const mk = () => createTextBundle(F.gl, { font, text: 'ab', style: S1 });
const real = font.getGlyphSegsByGidVar;
const breakFont = () => {
  font.getGlyphSegsByGidVar = () => {
    throw new Error('a transient outline failure');
  };
};
const healFont = () => {
  font.getGlyphSegsByGidVar = real;
};
const rejected = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.message;
  }
};

{
  const tb = await mk(),
    shapes0 = tb.bundle.numShapes;
  breakFont();
  const e = await rejected(tb.setText('abcd'));
  healFont();
  ok(e === 'a transient outline failure', "setText rejects with the rebuild's error");
  ok(
    tb.text === 'ab' && tb.bundle.numShapes === shapes0,
    'and `text` names what the bundle still shows',
  );
  await tb.setText('abcd');
  ok(
    tb.text === 'abcd' && tb.bundle.numShapes === 4,
    `the retry rebuilds (${tb.bundle.numShapes} shapes)`,
  );
  tb.dispose();
}
{
  const tb = await mk();
  breakFont();
  const e = await rejected(tb.setStyle(S2));
  healFont();
  ok(
    !!e && tb.style === S1,
    'setStyle: a failed rebuild leaves `style` naming what the bundle shows',
  );
  const gen = tb.bundle._geomGen | 0;
  await tb.setText('ab');
  ok((tb.bundle._geomGen | 0) === gen, 'so the same text still costs nothing');
  await tb.setText('abc');
  ok(
    tb.style === S1 && tb.bundle.numShapes === 3,
    'and the next text does not pick the failed style up',
  );
  await tb.setStyle(S2);
  ok(tb.style === S2 && (tb.bundle._geomGen | 0) > gen + 1, "the style's retry rebuilds");
  tb.dispose();
}
{
  // A failed setText carrying a style takes both back.
  const tb = await mk();
  breakFont();
  await rejected(tb.setText('abcd', S2));
  healFont();
  ok(tb.text === 'ab' && tb.style === S1, 'setText(text, style): both come back');
  tb.dispose();
}
{
  const tb = await mk();
  const gen = tb.bundle._geomGen | 0;
  const p1 = tb.setText('abcde');
  let p1done = false;
  p1.then(() => {
    p1done = true;
  });
  await tb.setText('abcde');
  ok(
    tb.bundle.numShapes === 5,
    `a repeat of a running call resolves when the bundle shows the text (${tb.bundle.numShapes} shapes)`,
  );
  await p1;
  ok(p1done && (tb.bundle._geomGen | 0) === gen + 1, 'and the two calls are one rebuild');
  await tb.setText('abcde');
  ok((tb.bundle._geomGen | 0) === gen + 1, 'the text already shown costs nothing');
  tb.dispose();
}
{
  // A repeat of a running call that fails rejects with it, and the retry rebuilds.
  const tb = await mk();
  breakFont();
  const p1 = tb.setText('abcd'),
    p2 = tb.setText('abcd');
  const [e1, e2] = await Promise.all([rejected(p1), rejected(p2)]);
  healFont();
  ok(!!e1 && !!e2 && tb.text === 'ab', 'both of two equal calls reject');
  await tb.setText('abcd');
  ok(tb.bundle.numShapes === 4, 'and the retry rebuilds');
  tb.dispose();
}
{
  // The last request wins, in either order of landing, and a superseded failure touches nothing.
  const tb = await mk();
  const p1 = tb.setText('abc'),
    p2 = tb.setText('abcd');
  await Promise.all([p1, p2]);
  ok(tb.text === 'abcd' && tb.bundle.numShapes === 4, 'two different calls: the last one shows');
  const p3 = tb.setText('abcde'),
    p4 = tb.setText('abcd');
  await Promise.all([p3, p4]);
  ok(
    tb.text === 'abcd' && tb.bundle.numShapes === 4,
    'going back to the shown text while another call runs: the shown text wins',
  );
  tb.dispose();
}
{
  const tb = await mk();
  const p = tb.setText('abcd');
  tb.dispose();
  ok((await p) === null && tb.bundle === null, 'dispose while a call runs: it resolves to null');
  ok(
    (await tb.setText('x')) === null && (await tb.setStyle(S2)) === null,
    'and later calls do too',
  );
}
console.log(fail ? `setTextRetrySmoke: ${fail} FAILED` : 'setTextRetrySmoke: PASS');
process.exit(fail ? 1 : 0);
