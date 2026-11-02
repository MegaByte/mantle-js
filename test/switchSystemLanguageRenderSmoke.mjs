// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// switchSystemLanguageRenderSmoke — a <switch> skips a child whose systemLanguage no user language
// matches, as Chrome does. The reference is Chrome's rendering of the same SVG (test/_chromeRef.mjs).
//
// Comparing systemLanguage against the HOST PAGE's <html lang> is wrong: with no lang there (this page
// has none) it matches anything, and a <switch> always draws its first child. The user's languages are
// navigator.languages, the same list Chrome's own <switch> consults. The
// listed tag is a private-use one no locale matches, so the outcome is the same for every user:
// the unconditional green child, never the red one.
import { launchBrowser } from './_launch.mjs';
import { openChromeRef, rgbaAt } from './_chromeRef.mjs';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const W = 60,
  H = 20;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<switch><rect systemLanguage="x-mantle-none" width="20" height="20" fill="#f00"/><rect width="20" height="20" fill="#0a0"/></switch>` +
  `<switch><g systemLanguage="x-mantle-none, x-mantle-other"><rect x="20" width="20" height="20" fill="#f00"/></g>` +
  `<g><rect x="20" width="20" height="20" fill="#00f"/></g></switch>` +
  `<switch><rect x="40" systemLanguage="x-mantle-none" width="20" height="20" fill="#f00"/></switch>` +
  `</svg>`;

const ref = await openChromeRef(launchBrowser);
try {
  const { mantle, chrome } = await ref.render(svg, { w: W, h: H, ground: 'white' });
  for (const [x, what] of [
    [10, 'unconditional rect after an unmatched one'],
    [30, 'unconditional group after an unmatched list'],
    [50, 'a switch with no passing child (white)'],
  ]) {
    const m = rgbaAt(mantle, W, x, 10),
      c = rgbaAt(chrome, W, x, 10);
    const d = Math.max(...m.map((v, i) => Math.abs(v - c[i])));
    const msg = `${what} (${x},10): mantle rgba(${m.join(',')}) chrome rgba(${c.join(',')})`;
    if (d <= 2) ok(msg);
    else fail(msg + ` — off by ${d}/255`);
  }
  for (const e of ref.pageErrors) fail('page: ' + e);
} catch (e) {
  fail('setup: ' + e.message);
}
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nswitchSystemLanguageRenderSmoke: <switch> skips a child no user language matches, as Chrome does',
);
