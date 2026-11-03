// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// featureCatalog.js — the OpenType layout features a font offers, for a font-picker UI.
//
// Lists the distinct feature tags of GSUB and GPOS (script/language independent) with the user-facing names the font
// carries in its FeatureParams (ssXX UINameID; cvXX label, tooltip, sample text, named-parameter run and characters),
// and the registered-feature description for standard tags. This describes features; it does not select them.
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/featurelist

/** Registered OpenType feature descriptions (the standard tags a picker shows a label for). */
export const FEATURE_LABELS = {
  aalt: 'Access All Alternates',
  abvf: 'Above-base Forms',
  abvm: 'Above-base Mark Positioning',
  abvs: 'Above-base Substitutions',
  afrc: 'Alternative Fractions',
  akhn: 'Akhands',
  blwf: 'Below-base Forms',
  blwm: 'Below-base Mark Positioning',
  blws: 'Below-base Substitutions',
  c2pc: 'Petite Capitals From Capitals',
  c2sc: 'Small Capitals From Capitals',
  calt: 'Contextual Alternates',
  case: 'Case-Sensitive Forms',
  ccmp: 'Glyph Composition / Decomposition',
  cfar: 'Conjunct Form After Ro',
  chws: 'Contextual Half-width Spacing',
  cjct: 'Conjunct Forms',
  clig: 'Contextual Ligatures',
  cpct: 'Centered CJK Punctuation',
  cpsp: 'Capital Spacing',
  cswh: 'Contextual Swash',
  curs: 'Cursive Positioning',
  dist: 'Distances',
  dlig: 'Discretionary Ligatures',
  dnom: 'Denominators',
  dtls: 'Dotless Forms',
  expt: 'Expert Forms',
  falt: 'Final Glyph on Line Alternates',
  fin2: 'Terminal Forms #2',
  fin3: 'Terminal Forms #3',
  fina: 'Terminal Forms',
  flac: 'Flattened Accent Forms',
  frac: 'Fractions',
  fwid: 'Full Widths',
  half: 'Half Forms',
  haln: 'Halant Forms',
  halt: 'Alternate Half Widths',
  hist: 'Historical Forms',
  hkna: 'Horizontal Kana Alternates',
  hlig: 'Historical Ligatures',
  hngl: 'Hangul',
  hojo: 'Hojo Kanji Forms',
  hwid: 'Half Widths',
  init: 'Initial Forms',
  isol: 'Isolated Forms',
  ital: 'Italics',
  jalt: 'Justification Alternates',
  jp04: 'JIS04 Forms',
  jp78: 'JIS78 Forms',
  jp83: 'JIS83 Forms',
  jp90: 'JIS90 Forms',
  kern: 'Kerning',
  lfbd: 'Left Bounds',
  liga: 'Standard Ligatures',
  ljmo: 'Leading Jamo Forms',
  lnum: 'Lining Figures',
  locl: 'Localized Forms',
  ltra: 'Left-to-right Alternates',
  ltrm: 'Left-to-right Mirrored Forms',
  mark: 'Mark Positioning',
  med2: 'Medial Forms #2',
  medi: 'Medial Forms',
  mgrk: 'Mathematical Greek',
  mkmk: 'Mark to Mark Positioning',
  mset: 'Mark Positioning via Substitution',
  nalt: 'Alternate Annotation Forms',
  nlck: 'NLC Kanji Forms',
  nukt: 'Nukta Forms',
  numr: 'Numerators',
  onum: 'Oldstyle Figures',
  opbd: 'Optical Bounds',
  ordn: 'Ordinals',
  ornm: 'Ornaments',
  palt: 'Proportional Alternate Widths',
  pcap: 'Petite Capitals',
  pkna: 'Proportional Kana',
  pnum: 'Proportional Figures',
  pref: 'Pre-base Forms',
  pres: 'Pre-base Substitutions',
  pstf: 'Post-base Forms',
  psts: 'Post-base Substitutions',
  pwid: 'Proportional Widths',
  qwid: 'Quarter Widths',
  rand: 'Randomize',
  rclt: 'Required Contextual Alternates',
  rkrf: 'Rakar Forms',
  rlig: 'Required Ligatures',
  rphf: 'Reph Forms',
  rtbd: 'Right Bounds',
  rtla: 'Right-to-left Alternates',
  rtlm: 'Right-to-left Mirrored Forms',
  ruby: 'Ruby Notation Forms',
  rvrn: 'Required Variation Alternates',
  salt: 'Stylistic Alternates',
  sinf: 'Scientific Inferiors',
  size: 'Optical size',
  smcp: 'Small Capitals',
  smpl: 'Simplified Forms',
  ssty: 'Math Script Style Alternates',
  stch: 'Stretching Glyph Decomposition',
  subs: 'Subscript',
  sups: 'Superscript',
  swsh: 'Swash',
  titl: 'Titling',
  tjmo: 'Trailing Jamo Forms',
  tnam: 'Traditional Name Forms',
  tnum: 'Tabular Figures',
  trad: 'Traditional Forms',
  twid: 'Third Widths',
  unic: 'Unicase',
  valt: 'Alternate Vertical Metrics',
  vatu: 'Vattu Variants',
  vchw: 'Vertical Contextual Half-width Spacing',
  vert: 'Vertical Writing',
  vhal: 'Alternate Vertical Half Metrics',
  vjmo: 'Vowel Jamo Forms',
  vkna: 'Vertical Kana Alternates',
  vkrn: 'Vertical Kerning',
  vpal: 'Proportional Alternate Vertical Metrics',
  vrt2: 'Vertical Alternates and Rotation',
  vrtr: 'Vertical Alternates for Rotation',
  zero: 'Slashed Zero',
};

/** Registry description for a tag: the fixed table, or the ssNN / cvNN pattern ("Stylistic Set 3"). */
export function featureLabel(tag) {
  if (FEATURE_LABELS[tag]) return FEATURE_LABELS[tag];
  const m = /^(ss|cv)(\d\d)$/.exec(tag);
  if (m) {
    const n = Number(m[2]);
    if (m[1] === 'ss' && n >= 1 && n <= 20) return `Stylistic Set ${n}`;
    if (m[1] === 'cv' && n >= 1) return `Character Variant ${n}`;
  }
  return '';
}

const tagOf = (v, o) =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/**
 * Distinct features of GSUB and GPOS: [{ tag, label, tables: ['GSUB'|'GPOS'], uiNameID, tooltipNameID, sampleNameID,
 * namedParameterCount, firstParameterNameID, characters: [cp] }], in first-seen order (GSUB first). Name IDs are 0
 * when the font carries none; resolve them with the font's name table.
 * @param {object} tables  result of parseTtfTables
 */
export function openTypeFeatureCatalog(tables) {
  const v = tables.view;
  const out = [];
  const byTag = new Map();
  for (const [name, span] of [
    ['GSUB', tables.gsub],
    ['GPOS', tables.gpos],
  ]) {
    if (!span || span[1] < 10) continue;
    const base = span[0],
      end = base + span[1];
    if (v.getUint16(base, false) !== 1) continue;
    const list = base + v.getUint16(base + 6, false);
    if (list + 2 > end) continue;
    const count = v.getUint16(list, false);
    for (let i = 0; i < count; i++) {
      const rec = list + 2 + i * 6;
      if (rec + 6 > end) break;
      const tag = tagOf(v, rec);
      let e = byTag.get(tag);
      if (!e) {
        e = {
          tag,
          label: featureLabel(tag),
          tables: [],
          uiNameID: 0,
          tooltipNameID: 0,
          sampleNameID: 0,
          namedParameterCount: 0,
          firstParameterNameID: 0,
          characters: [],
        };
        byTag.set(tag, e);
        out.push(e);
      }
      if (!e.tables.includes(name)) e.tables.push(name);
      const feat = list + v.getUint16(rec + 4, false);
      if (feat + 4 > end) continue;
      const pOff = v.getUint16(feat, false);
      if (pOff === 0 || e.uiNameID !== 0) continue;
      const p = feat + pOff;
      if (/^ss\d\d$/.test(tag)) {
        if (p + 4 <= end) e.uiNameID = v.getUint16(p + 2, false);
      } else if (/^cv\d\d$/.test(tag)) {
        if (p + 14 > end) continue;
        e.uiNameID = v.getUint16(p + 2, false);
        e.tooltipNameID = v.getUint16(p + 4, false);
        e.sampleNameID = v.getUint16(p + 6, false);
        e.namedParameterCount = v.getUint16(p + 8, false);
        e.firstParameterNameID = v.getUint16(p + 10, false);
        const n = v.getUint16(p + 12, false);
        for (let k = 0; k < n && p + 14 + k * 3 + 3 <= end; k++) {
          const o = p + 14 + k * 3;
          e.characters.push((v.getUint8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2));
        }
      }
    }
  }
  return out;
}
