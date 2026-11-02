// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// otScriptTags.js — the OpenType script tags a Unicode script selects,
// in the order HarfBuzz tries them.
//
// A font's GSUB/GPOS script list is keyed by OpenType script tag, and a
// run has to take its features from its own script's language system.
// Devanagari through a font whose DFLT script carries four features and
// whose 'dev2' script carries twelve must take the twelve.
//
// The list is ordered as hb_ot_all_tags_from_script builds it: a '3' form
// of the new-style tag ('dev3'), then the new-style tag itself ('dev2'),
// then the ISO 15924 code lowercased ('deva'). Nothing ships a '3' script
// yet, but HarfBuzz takes one over 'dev2' where a font has both, and does
// so for every new-style script except Myanmar, which has no 'mym3'. The
// lookup finder walks the list in order and falls back to DFLT, dflt,
// latn when the font carries none of them (see otCommon.js).
//
// Registered rather than imported by textLayout: resolving a codepoint's
// script needs the UCD script trie, which a Latin-only bundle should not
// carry. Every `font/scripts/**` entry registers this module, so any
// consumer that enabled a complex-script shaper resolves scripts per
// run; one that enabled none shapes Latin, where the finder's own
// fallback is already the right answer.

import { SCRIPT, itemizeScripts } from './unicode/scripts.js';
import { registerOtScriptTags as _register } from './shaperRegistry.js';

// Unicode script name → OpenType script tags, space separated, new-style
// first. Tags are four bytes, so short ISO codes keep their padding
// ('lao ', 'yi  '). Common, Inherited and Unknown are deliberately absent:
// they have no script of their own, and their runs take the fallback.
const TAGS_BY_NAME = {
  Latin: 'latn',
  Bopomofo: 'bopo',
  Greek: 'grek',
  Coptic: 'copt',
  Cyrillic: 'cyrl',
  Armenian: 'armn',
  Hebrew: 'hebr',
  Arabic: 'arab',
  Syriac: 'syrc',
  Thaana: 'thaa',
  Nko: 'nko ',
  Samaritan: 'samr',
  Mandaic: 'mand',
  Devanagari: 'dev2 deva',
  Bengali: 'bng2 beng',
  Gurmukhi: 'gur2 guru',
  Gujarati: 'gjr2 gujr',
  Oriya: 'ory2 orya',
  Tamil: 'tml2 taml',
  Telugu: 'tel2 telu',
  Kannada: 'knd2 knda',
  Malayalam: 'mlm2 mlym',
  Sinhala: 'sinh',
  Thai: 'thai',
  Lao: 'lao ',
  Tibetan: 'tibt',
  Myanmar: 'mym2 mymr',
  Georgian: 'geor',
  Hangul: 'hang',
  Ethiopic: 'ethi',
  Cherokee: 'cher',
  Canadian_Aboriginal: 'cans',
  Ogham: 'ogam',
  Runic: 'runr',
  Tagalog: 'tglg',
  Hanunoo: 'hano',
  Buhid: 'buhd',
  Tagbanwa: 'tagb',
  Khmer: 'khmr',
  Mongolian: 'mong',
  Limbu: 'limb',
  Tai_Le: 'tale',
  New_Tai_Lue: 'talu',
  Buginese: 'bugi',
  Tai_Tham: 'lana',
  Balinese: 'bali',
  Sundanese: 'sund',
  Batak: 'batk',
  Lepcha: 'lepc',
  Ol_Chiki: 'olck',
  Braille: 'brai',
  Glagolitic: 'glag',
  Tifinagh: 'tfng',
  Han: 'hani',
  Hiragana: 'kana',
  Katakana: 'kana',
  Yi: 'yi  ',
  Lisu: 'lisu',
  Vai: 'vai ',
  Bamum: 'bamu',
  Syloti_Nagri: 'sylo',
  Phags_Pa: 'phag',
  Saurashtra: 'saur',
  Kayah_Li: 'kali',
  Rejang: 'rjng',
  Javanese: 'java',
  Cham: 'cham',
  Tai_Viet: 'tavt',
  Meetei_Mayek: 'mtei',
  Linear_B: 'linb',
  Lycian: 'lyci',
  Carian: 'cari',
  Old_Italic: 'ital',
  Gothic: 'goth',
  Old_Permic: 'perm',
  Ugaritic: 'ugar',
  Old_Persian: 'xpeo',
  Deseret: 'dsrt',
  Shavian: 'shaw',
  Osmanya: 'osma',
  Osage: 'osge',
  Elbasan: 'elba',
  Caucasian_Albanian: 'aghb',
  Vithkuqi: 'vith',
  Todhri: 'todr',
  Linear_A: 'lina',
  Cypriot: 'cprt',
  Imperial_Aramaic: 'armi',
  Palmyrene: 'palm',
  Nabataean: 'nbat',
  Hatran: 'hatr',
  Phoenician: 'phnx',
  Lydian: 'lydi',
  Sidetic: 'sidt',
  Meroitic_Hieroglyphs: 'mero',
  Meroitic_Cursive: 'merc',
  Kharoshthi: 'khar',
  Old_South_Arabian: 'sarb',
  Old_North_Arabian: 'narb',
  Manichaean: 'mani',
  Avestan: 'avst',
  Inscriptional_Parthian: 'prti',
  Inscriptional_Pahlavi: 'phli',
  Psalter_Pahlavi: 'phlp',
  Old_Turkic: 'orkh',
  Old_Hungarian: 'hung',
  Hanifi_Rohingya: 'rohg',
  Garay: 'gara',
  Yezidi: 'yezi',
  Old_Sogdian: 'sogo',
  Sogdian: 'sogd',
  Old_Uyghur: 'ougr',
  Chorasmian: 'chrs',
  Elymaic: 'elym',
  Brahmi: 'brah',
  Kaithi: 'kthi',
  Sora_Sompeng: 'sora',
  Chakma: 'cakm',
  Mahajani: 'mahj',
  Sharada: 'shrd',
  Khojki: 'khoj',
  Multani: 'mult',
  Khudawadi: 'sind',
  Grantha: 'gran',
  Tulu_Tigalari: 'tutg',
  Newa: 'newa',
  Tirhuta: 'tirh',
  Siddham: 'sidd',
  Modi: 'modi',
  Takri: 'takr',
  Ahom: 'ahom',
  Dogra: 'dogr',
  Warang_Citi: 'wara',
  Dives_Akuru: 'diak',
  Nandinagari: 'nand',
  Zanabazar_Square: 'zanb',
  Soyombo: 'soyo',
  Pau_Cin_Hau: 'pauc',
  Sunuwar: 'sunu',
  Bhaiksuki: 'bhks',
  Marchen: 'marc',
  Masaram_Gondi: 'gonm',
  Gunjala_Gondi: 'gong',
  Tolong_Siki: 'tols',
  Makasar: 'maka',
  Kawi: 'kawi',
  Cuneiform: 'xsux',
  Cypro_Minoan: 'cpmn',
  Egyptian_Hieroglyphs: 'egyp',
  Anatolian_Hieroglyphs: 'hluw',
  Gurung_Khema: 'gukh',
  Mro: 'mroo',
  Tangsa: 'tnsa',
  Bassa_Vah: 'bass',
  Pahawh_Hmong: 'hmng',
  Kirat_Rai: 'krai',
  Medefaidrin: 'medf',
  Beria_Erfe: 'berf',
  Miao: 'plrd',
  Tangut: 'tang',
  Nushu: 'nshu',
  Khitan_Small_Script: 'kits',
  Duployan: 'dupl',
  SignWriting: 'sgnw',
  Nyiakeng_Puachue_Hmong: 'hmnp',
  Toto: 'toto',
  Wancho: 'wcho',
  Nag_Mundari: 'nagm',
  Ol_Onal: 'onao',
  Tai_Yo: 'tayo',
  Mende_Kikakui: 'mend',
  Adlam: 'adlm',
};

const _tagU32 = (s) =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>>
  0;

// Script id → frozen tag array, built once. Indexed by the trie's own
// numbering so a run costs one array read.
const _byId = [];
for (const [name, id] of Object.entries(SCRIPT)) {
  const tags = TAGS_BY_NAME[name];
  if (!tags) continue;
  const list = tags.length === 4 ? [tags] : tags.split(' ');

  if (list[0].endsWith('2') && list[0] !== 'mym2') list.unshift(list[0].slice(0, 3) + '3');
  _byId[id] = Object.freeze(list.map(_tagU32));
}

/**
 * The OpenType script tags for a Unicode script id, most specific first,
 * or null for a script with no tag of its own. The array is shared and
 * frozen — callers compare it by identity to skip redundant work.
 * @param {number} scriptId  a value from `SCRIPT`
 */
export function otScriptTagsForScript(scriptId) {
  return _byId[scriptId] || null;
}

/**
 * Per-codepoint OpenType script tags for one glyph stream. Common and
 * Inherited codepoints (a digit or a combining mark inside a word) adopt
 * their neighbors' script, as UAX #24 itemization and HarfBuzz both do,
 * so a run does not change language system mid-word.
 * @param {number[]} cps
 * @returns {(readonly number[]|null)[]}
 */
export function otScriptTagsPerCodepoint(cps) {
  const out = new Array(cps.length).fill(null);
  for (const { start, end, script } of itemizeScripts(cps)) {
    const tags = otScriptTagsForScript(script);
    for (let i = start; i < end; i++) out[i] = tags;
  }
  return out;
}

let _registered = false;

/** Install per-run OpenType script selection. Idempotent. */
export function registerOtScriptTags() {
  if (_registered) return;
  _registered = true;
  _register({ otScriptTagsForScript, otScriptTagsPerCodepoint });
}
