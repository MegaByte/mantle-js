// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// switchSystemLanguageSmoke.mjs — <switch> picks its child by systemLanguage (SVG 2 §5.8.5).
//
// Treating systemLanguage as "match anything" in Node, or as the HOST PAGE's <html lang> in a
// browser, would render a <switch> whose first child is, say, the French branch in French for
// everyone. The test is the user's languages against the listed tags: a child passes iff
// one user language EQUALS a listed tag, or equals a PREFIX of one followed by '-' (user "en"
// matches "en-US"; user "en-US" does not match "en"), case-insensitively.
//
// The languages come from importSvg({ languages }), else navigator.languages, else
// navigator.language, else nothing (match anything). Asserts each source and the matching rule,
// by which child's id reaches bundle.shapeIds.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

const svg = (kids) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><switch>${kids}</switch></svg>`;
const r = (id, attr = '') => `<rect id="${id}" ${attr} width="10" height="10"/>`;
const pick = async (markup, opts) => {
  const b = await importSvg(markup, opts || {});
  return (b.shapeIds || []).filter(Boolean).join(',') || '(none)';
};
const expect = async (what, markup, opts, want) => {
  const got = await pick(markup, opts);
  if (got === want) ok(`${what}: ${got}`);
  else fail(`${what}: rendered ${got}, want ${want}`);
};

const I18N = svg(
  r('fr', 'systemLanguage="fr"') +
    r('en', 'systemLanguage="en"') +
    r('multi', 'systemLanguage="de, pt-BR"') +
    r('fallback'),
);

// ---- The matching rule, with the languages passed explicitly ----
await expect('languages [en] takes the en child', I18N, { languages: ['en'] }, 'en');
await expect(
  'languages [fr-CA, fr] takes the fr child',
  I18N,
  { languages: ['fr-CA', 'fr'] },
  'fr',
);
await expect(
  'languages [pt] matches the listed pt-BR (user tag is a prefix)',
  I18N,
  { languages: ['pt'] },
  'multi',
);
await expect('languages [DE] matches case-insensitively', I18N, { languages: ['DE'] }, 'multi');
await expect(
  'languages [en-US] does NOT match a listed "en" (prefix runs one way)',
  I18N,
  { languages: ['en-US'] },
  'fallback',
);
await expect(
  'languages [e] is not a prefix of "en" (a prefix must end at a "-")',
  I18N,
  { languages: ['e'] },
  'fallback',
);
await expect(
  'languages [ja] matches nothing, takes the unconditional child',
  I18N,
  { languages: ['ja'] },
  'fallback',
);
await expect(
  'an empty languages list matches no systemLanguage',
  I18N,
  { languages: [] },
  'fallback',
);
await expect('a single string is accepted', I18N, { languages: 'fr' }, 'fr');
await expect(
  'first passing child wins',
  svg(r('a', 'systemLanguage="en"') + r('b', 'systemLanguage="en"')),
  { languages: ['en'] },
  'a',
);
await expect(
  'no passing child renders nothing',
  svg(r('a', 'systemLanguage="fr"')),
  { languages: ['en'] },
  '(none)',
);
await expect(
  'an empty systemLanguage is false',
  svg(r('a', 'systemLanguage=""') + r('b')),
  { languages: ['en'] },
  'b',
);

// ---- The defaults: navigator.languages, then navigator.language, then match-anything ----
const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const setNav = (v) =>
  Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
try {
  setNav({ languages: ['fr-CA', 'fr'], language: 'en' });
  await expect('default: navigator.languages', I18N, {}, 'fr');
  setNav({ language: 'de-AT' });
  await expect('default: navigator.language when languages is absent', I18N, {}, 'fallback');
  setNav({ language: 'de' });
  await expect('default: navigator.language "de" matches the listed "de"', I18N, {}, 'multi');
  setNav(undefined);
  await expect('default with no navigator: match anything (first child)', I18N, {}, 'fr');
  setNav({ languages: ['fr'] });
  await expect('an explicit languages option beats navigator', I18N, { languages: ['en'] }, 'en');
} finally {
  if (desc) Object.defineProperty(globalThis, 'navigator', desc);
  else delete globalThis.navigator;
}

if (failures) {
  console.error(`\nSWITCH-SYSTEM-LANGUAGE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nSWITCH-SYSTEM-LANGUAGE PASS');
