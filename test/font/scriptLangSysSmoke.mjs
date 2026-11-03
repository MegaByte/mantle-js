// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// scriptLangSysSmoke — a run's features come from its own script's language system.
//
// One language system per font — latn, else DFLT, else the first script — whatever the text is, would be wrong:
// Devanagari through Devanagari Sangam MN would read DFLT's four features instead of dev2's twelve and lose every half
// form and conjunct, and Latin through a font whose first script is 'arab' (Arial Unicode) would run Arabic's.
//
// Two checks. A synthesized font pins the selection order itself: the same 'ccmp' feature resolves to a different
// lookup under DFLT, deva, dev2 and latn, so the glyph a run produces names the language system it read. Then recorded
// HarfBuzz glyph ids on macOS system fonts, with each font's byte size, so a font that is missing or a different build
// skips rather than fails.
import { readFileSync, statSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { layoutSlots } from '../../src/font/textLayout.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { otScriptTagsForScript } from '../../src/font/otScriptTags.js';
import { SCRIPT } from '../../src/font/unicode/scripts.js';
import { registerIndicShaping } from '../../src/font/scripts/indic.js';
registerIndicShaping();

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ---- synthetic font -------------------------------------------------
// gid 1 = 'A' (U+0041), gid 2 = Devanagari KA (U+0915). One feature tag,
// 'ccmp', appears once per language system, each reaching its own single
// substitution, so the output glyph identifies the selection:
//   DFLT default        KA -> 30
//   deva default        KA -> 31
//   dev2 default        KA -> 32
//   dev2 / 'MAR ' required feature   KA -> 33
//   latn default        A  -> 40
// The `arabOnly` variant carries one script, 'arab' (A -> 41), and no
// DFLT / dflt / latn: a Latin run there must reach no feature at all.

const TAG = (s) =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>>
  0;

class Be {
  constructor() {
    this.bytes = [];
  }
  u8(n) {
    this.bytes.push(n & 0xff);
  }
  u16(n) {
    this.bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  s16(n) {
    this.u16(n & 0xffff);
  }
  u32(n) {
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  raw(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
  }
  get length() {
    return this.bytes.length;
  }
  toUint8() {
    return new Uint8Array(this.bytes);
  }
}

const NUM_GLYPHS = 64;
const UPEM = 1000;

function buildHead() {
  const b = new Be();
  b.u16(1);
  b.u16(0);
  b.u16(1);
  b.u16(0);
  b.u32(0);
  b.u32(0x5f0f3cf5);
  b.u16(0);
  b.u16(UPEM);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.s16(0);
  b.s16(-200);
  b.s16(UPEM);
  b.s16(UPEM);
  b.u16(0);
  b.u16(8);
  b.s16(2);
  b.s16(0);
  b.s16(0);
  return b.toUint8();
}
function buildHhea() {
  const b = new Be();
  b.u16(1);
  b.u16(0);
  b.s16(UPEM);
  b.s16(-200);
  b.s16(0);
  b.u16(UPEM);
  b.s16(0);
  b.s16(0);
  b.s16(UPEM);
  b.s16(1);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.u16(NUM_GLYPHS);
  return b.toUint8();
}
function buildHmtx() {
  const b = new Be();
  for (let i = 0; i < NUM_GLYPHS; i++) {
    b.u16(500);
    b.s16(0);
  }
  return b.toUint8();
}
function buildMaxp() {
  const b = new Be();
  b.u16(1);
  b.u16(0);
  b.u16(NUM_GLYPHS);
  for (let i = 0; i < 13; i++) b.u16(0);
  return b.toUint8();
}
/// cmap format 4: 'A' -> gid 1, Devanagari KA -> gid 2.
function buildCmap() {
  const segs = [
    { start: 0x0041, end: 0x0041, gid: 1 },
    { start: 0x0915, end: 0x0915, gid: 2 },
    { start: 0xffff, end: 0xffff, gid: 0 },
  ];
  const segCount = segs.length;
  const sub = new Be();
  sub.u16(4);
  sub.u16(16 + 8 * segCount);
  sub.u16(0);
  sub.u16(segCount * 2);
  let pow = 1,
    log = 0;
  while (pow << 1 <= segCount) {
    pow <<= 1;
    log++;
  }
  sub.u16(pow * 2);
  sub.u16(log);
  sub.u16(segCount * 2 - pow * 2);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0);
  for (const s of segs) sub.u16(s.start);
  for (const s of segs) sub.s16((s.gid - s.start) & 0xffff);
  for (const _ of segs) sub.u16(0);
  const b = new Be();
  b.u16(0);
  b.u16(1);
  b.u16(3);
  b.u16(1);
  b.u32(12);
  b.raw(Array.from(sub.toUint8()));
  return b.toUint8();
}
function buildGlyfAndLoca() {
  const loca = new Be();
  for (let i = 0; i <= NUM_GLYPHS; i++) loca.u16(0);
  return { glyf: new Uint8Array(0), loca: loca.toUint8() };
}
function buildPost() {
  const b = new Be();
  b.u16(3);
  b.u16(0);
  b.u32(0);
  b.s16(-100);
  b.s16(50);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  return b.toUint8();
}

/// One SingleSubstFormat 2 lookup: each `from` glyph maps to its `to`.
function singleSubLookup(pairs) {
  const glyphs = pairs.map((p) => p[0]);
  const cov = new Be();
  cov.u16(1);
  cov.u16(glyphs.length);
  for (const g of glyphs) cov.u16(g);
  const covBytes = cov.toUint8();
  const sub = new Be();
  sub.u16(2); // substFormat
  sub.u16(6 + pairs.length * 2); // coverageOffset, past the subtable body
  sub.u16(pairs.length);
  for (const p of pairs) sub.u16(p[1]);
  sub.raw(Array.from(covBytes));
  const subBytes = sub.toUint8();
  const lk = new Be();
  lk.u16(1);
  lk.u16(0);
  lk.u16(1);
  lk.u16(8); // type, flag, subtableCount, offset
  lk.raw(Array.from(subBytes));
  return lk.toUint8();
}

/// Assemble GSUB from a description:
///   lookups: [[from, to], ...][]            one single-sub lookup each
///   features: { tag, lookups: number[] }[]  sorted by tag by the caller
///   scripts:  { tag, def, langs }[]         sorted by tag by the caller,
///     where def / each lang is { req, feats }
function buildGsub({ lookups, features, scripts }) {
  // LookupList
  const lkBytes = lookups.map(singleSubLookup);
  const lkList = new Be();
  lkList.u16(lkBytes.length);
  let lkCursor = 2 + lkBytes.length * 2;
  for (const b of lkBytes) {
    lkList.u16(lkCursor);
    lkCursor += b.length;
  }
  for (const b of lkBytes) lkList.raw(Array.from(b));
  const lookupList = lkList.toUint8();

  // FeatureList
  const featBodies = features.map((f) => {
    const b = new Be();
    b.u16(0);
    b.u16(f.lookups.length);
    for (const li of f.lookups) b.u16(li);
    return b.toUint8();
  });
  const ftList = new Be();
  ftList.u16(features.length);
  let ftCursor = 2 + features.length * 6;
  for (let i = 0; i < features.length; i++) {
    ftList.u32(TAG(features[i].tag));
    ftList.u16(ftCursor);
    ftCursor += featBodies[i].length;
  }
  for (const b of featBodies) ftList.raw(Array.from(b));
  const featureList = ftList.toUint8();

  // ScriptList. Each Script table holds its default LangSys and any
  // language records, so lay the bodies out script by script.
  const langSys = ({ req, feats }) => {
    const b = new Be();
    b.u16(0);
    b.u16(req);
    b.u16(feats.length);
    for (const fi of feats) b.u16(fi);
    return b.toUint8();
  };
  const scriptBodies = scripts.map((s) => {
    const langs = s.langs || [];
    const head = new Be();
    const defBytes = s.def ? langSys(s.def) : null;
    const langBytes = langs.map((l) => langSys(l));
    let cursor = 4 + langs.length * 6;
    head.u16(defBytes ? cursor : 0);
    if (defBytes) cursor += defBytes.length;
    head.u16(langs.length);
    for (let i = 0; i < langs.length; i++) {
      head.u32(TAG(langs[i].tag));
      head.u16(cursor);
      cursor += langBytes[i].length;
    }
    if (defBytes) head.raw(Array.from(defBytes));
    for (const b of langBytes) head.raw(Array.from(b));
    return head.toUint8();
  });
  const scList = new Be();
  scList.u16(scripts.length);
  let scCursor = 2 + scripts.length * 6;
  for (let i = 0; i < scripts.length; i++) {
    scList.u32(TAG(scripts[i].tag));
    scList.u16(scCursor);
    scCursor += scriptBodies[i].length;
  }
  for (const b of scriptBodies) scList.raw(Array.from(b));
  const scriptList = scList.toUint8();

  const b = new Be();
  b.u16(1);
  b.u16(0);
  const headerLen = 10;
  b.u16(headerLen);
  b.u16(headerLen + scriptList.length);
  b.u16(headerLen + scriptList.length + featureList.length);
  b.raw(Array.from(scriptList));
  b.raw(Array.from(featureList));
  b.raw(Array.from(lookupList));
  return b.toUint8();
}

function tableDir(records) {
  const n = records.length;
  let cursor = 12 + 16 * n;
  const offsets = [];
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.bytes.length;
    while (cursor & 3) cursor++;
  }
  const out = new Uint8Array(cursor);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000, false);
  dv.setUint16(4, n, false);
  let pow = 1,
    log = 0;
  while (pow << 1 <= n) {
    pow <<= 1;
    log++;
  }
  dv.setUint16(6, pow * 16, false);
  dv.setUint16(8, log, false);
  dv.setUint16(10, n * 16 - pow * 16, false);
  const order = records.map((r, i) => i).sort((a, b) => records[a].tag - records[b].tag);
  let dirCursor = 12;
  for (const i of order) {
    dv.setUint32(dirCursor, records[i].tag, false);
    dv.setUint32(dirCursor + 4, 0, false);
    dv.setUint32(dirCursor + 8, offsets[i], false);
    dv.setUint32(dirCursor + 12, records[i].bytes.length, false);
    dirCursor += 16;
  }
  for (let i = 0; i < records.length; i++) out.set(records[i].bytes, offsets[i]);
  return out;
}

/// `variant`: 'scripts' (DFLT + dev2 + deva + latn) or 'arabOnly'.
/// `extra`: additional scripts appended (sorted by the caller).
export function buildScriptTestFont(variant = 'scripts', extra = []) {
  const gsub =
    variant === 'arabOnly'
      ? buildGsub({
          lookups: [[[1, 41]]],
          features: [{ tag: 'ccmp', lookups: [0] }],
          scripts: [{ tag: 'arab', def: { req: 0xffff, feats: [0] } }],
        })
      : buildGsub({
          lookups: [[[2, 30]], [[2, 31]], [[2, 32]], [[2, 33]], [[1, 40]], [[2, 35]]],
          features: [
            { tag: 'ccmp', lookups: [0] }, // 0: DFLT
            { tag: 'ccmp', lookups: [1] }, // 1: deva
            { tag: 'ccmp', lookups: [2] }, // 2: dev2
            { tag: 'ccmp', lookups: [3] }, // 3: dev2 / MAR, required
            { tag: 'ccmp', lookups: [4] }, // 4: latn
            { tag: 'ccmp', lookups: [5] }, // 5: for `extra` scripts
          ],
          // ScriptRecords are sorted by tag: 'DFLT' < 'dev2' < 'deva' < 'latn'.
          scripts: [
            { tag: 'DFLT', def: { req: 0xffff, feats: [0] } },
            {
              tag: 'dev2',
              def: { req: 0xffff, feats: [2] },
              langs: [{ tag: 'MAR ', req: 3, feats: [] }],
            },
            { tag: 'deva', def: { req: 0xffff, feats: [1] } },
            { tag: 'latn', def: { req: 0xffff, feats: [4] } },
            ...extra,
          ].sort((a, b) => TAG(a.tag) - TAG(b.tag)),
        });
  const { glyf, loca } = buildGlyfAndLoca();
  return tableDir([
    { tag: TAG('head'), bytes: buildHead() },
    { tag: TAG('hhea'), bytes: buildHhea() },
    { tag: TAG('hmtx'), bytes: buildHmtx() },
    { tag: TAG('maxp'), bytes: buildMaxp() },
    { tag: TAG('cmap'), bytes: buildCmap() },
    { tag: TAG('loca'), bytes: loca },
    { tag: TAG('glyf'), bytes: glyf },
    { tag: TAG('post'), bytes: buildPost() },
    { tag: TAG('GSUB'), bytes: gsub },
  ]);
}

const KA = 0x0915;
const shape = (font, text, layout = {}) =>
  layoutSlots([{ text, style: defaultStyle() }], font, layout).map((s) => s.glyphId);

// ---- T1: the run's script wins over DFLT and over latn ---------------
{
  const font = new MantleFontAsset(buildScriptTestFont());
  const devaTags = otScriptTagsForScript(SCRIPT.Devanagari);
  const gsub = font.gsub;
  gsub.setShapingScript(devaTags, 0);
  const out = gsub.applyFeatureToSeq('ccmp', [2]);
  if (out[0] !== 32)
    fail(`T1 Devanagari selected the wrong language system: KA -> ${out[0]} (want 32 = dev2)`);
  else ok('T1 dev2 beats deva, DFLT and latn for a Devanagari run');
}

// ---- T2: new-style tag first, old-style next ------------------------
{
  // A font with no 'dev2' must fall to 'deva', not to DFLT.
  const bytes = buildGsub({
    lookups: [[[2, 30]], [[2, 31]]],
    features: [
      { tag: 'ccmp', lookups: [0] },
      { tag: 'ccmp', lookups: [1] },
    ],
    scripts: [
      { tag: 'DFLT', def: { req: 0xffff, feats: [0] } },
      { tag: 'deva', def: { req: 0xffff, feats: [1] } },
    ],
  });
  const { glyf, loca } = buildGlyfAndLoca();
  const font = new MantleFontAsset(
    tableDir([
      { tag: TAG('head'), bytes: buildHead() },
      { tag: TAG('hhea'), bytes: buildHhea() },
      { tag: TAG('hmtx'), bytes: buildHmtx() },
      { tag: TAG('maxp'), bytes: buildMaxp() },
      { tag: TAG('cmap'), bytes: buildCmap() },
      { tag: TAG('loca'), bytes: loca },
      { tag: TAG('glyf'), bytes: glyf },
      { tag: TAG('post'), bytes: buildPost() },
      { tag: TAG('GSUB'), bytes },
    ]),
  );
  font.gsub.setShapingScript(otScriptTagsForScript(SCRIPT.Devanagari), 0);
  const out = font.gsub.applyFeatureToSeq('ccmp', [2]);
  if (out[0] !== 31) fail(`T2 'deva' not reached without 'dev2': KA -> ${out[0]} (want 31)`);
  else ok("T2 a Devanagari run falls from 'dev2' to 'deva' before DFLT");
}

// ---- T2b: the '3' form of a new-style tag comes first -----------------
{
  // Nothing ships 'dev3', but HarfBuzz takes one over 'dev2' where a font
  // has both (checked against hb-shape 14.4.0 on a font carrying each).
  const font = new MantleFontAsset(
    buildScriptTestFont('scripts', [{ tag: 'dev3', def: { req: 0xffff, feats: [5] } }]),
  );
  font.gsub.setShapingScript(otScriptTagsForScript(SCRIPT.Devanagari), 0);
  const out = font.gsub.applyFeatureToSeq('ccmp', [2]);
  if (out[0] !== 35) fail(`T2b 'dev3' should be tried before 'dev2': KA -> ${out[0]} (want 35)`);
  else ok("T2b 'dev3' is tried before 'dev2'");

  // Myanmar is HarfBuzz's exception: it has no 'mym3'.
  const mymTags = otScriptTagsForScript(SCRIPT.Myanmar).map((t) =>
    String.fromCharCode((t >>> 24) & 0xff, (t >>> 16) & 0xff, (t >>> 8) & 0xff, t & 0xff),
  );
  if (mymTags.join(' ') !== 'mym2 mymr') fail(`T2b Myanmar tags are [${mymTags}] (want mym2 mymr)`);
  else ok('T2b Myanmar keeps mym2 then mymr, with no mym3');
}

// ---- T3: a script the font lacks falls back to DFLT ------------------
{
  const font = new MantleFontAsset(buildScriptTestFont());
  font.gsub.setShapingScript(otScriptTagsForScript(SCRIPT.Khmer), 0);
  const out = font.gsub.applyFeatureToSeq('ccmp', [2]);
  if (out[0] !== 30) fail(`T3 Khmer should fall back to DFLT: KA -> ${out[0]} (want 30)`);
  else ok('T3 a script the font lacks falls back to DFLT');
}

// ---- T4: language system, and its required feature -------------------
{
  const font = new MantleFontAsset(buildScriptTestFont());
  const devaTags = otScriptTagsForScript(SCRIPT.Devanagari);
  const MAR = TAG('MAR ');
  font.gsub.setShapingScript(devaTags, MAR);
  const marOut = font.gsub.applyFeatureToSeq('ccmp', [2]);
  if (marOut[0] !== 33)
    fail(
      `T4 'MAR ' language system not selected: KA -> ${marOut[0]} (want 33, its required feature)`,
    );
  else ok("T4 'MAR ' takes its language system, and its REQUIRED feature counts");

  // A language the script doesn't carry takes the default language system.
  font.gsub.setShapingScript(devaTags, TAG('ZZZ '));
  const unknown = font.gsub.applyFeatureToSeq('ccmp', [2]);
  if (unknown[0] !== 32)
    fail(`T4 unknown language should use the default LangSys: KA -> ${unknown[0]} (want 32)`);
  else ok('T4 a language the script lacks takes the default language system');
}

// ---- T5: no script matched means no features -------------------------
{
  // Arial Unicode has no DFLT and its first script is 'arab'. Latin text
  // there must not run Arabic's features; HarfBuzz applies none.
  const font = new MantleFontAsset(buildScriptTestFont('arabOnly'));
  font.gsub.setShapingScript(otScriptTagsForScript(SCRIPT.Latin), 0);
  const out = font.gsub.applyFeatureToSeq('ccmp', [1]);
  if (out[0] !== 1)
    fail(`T5 Latin run reached another script's feature: A -> ${out[0]} (want 1, unchanged)`);
  else ok("T5 a font with only 'arab' contributes no features to a Latin run");
  if (font.gsub.hasFeature('ccmp')) fail('T5 hasFeature reports a feature the run cannot reach');
  else ok('T5 hasFeature answers under the selected script');
}

// ---- T6: end to end through layout -----------------------------------
{
  const font = new MantleFontAsset(buildScriptTestFont());
  const deva = shape(font, String.fromCodePoint(KA));
  if (deva.length !== 1 || deva[0] !== 32) fail(`T6 layout of KA: [${deva}] (want [32])`);
  else ok('T6 layoutSlots shapes a Devanagari run under dev2');

  const latin = shape(font, 'A');
  if (latin.length !== 1 || latin[0] !== 40) fail(`T6 layout of 'A': [${latin}] (want [40])`);
  else ok('T6 the same font shapes a Latin run under latn');

  const mixed = shape(font, 'A' + String.fromCodePoint(KA));
  if (mixed.length !== 2 || mixed[0] !== 40 || mixed[1] !== 32) {
    fail(`T6 mixed-script run: [${mixed}] (want [40,32])`);
  } else ok('T6 one span, two scripts, two language systems');

  const mar = shape(font, String.fromCodePoint(KA), { language: 'MAR' });
  if (mar.length !== 1 || mar[0] !== 33) fail(`T6 layout.language 'MAR': [${mar}] (want [33])`);
  else ok('T6 layout.language selects the language system');
}

// ---- T7: HarfBuzz's glyph ids on macOS system fonts -------------------
// Recorded with uharfbuzz (default features, script and direction guessed).
// Devanagari Sangam MN's DFLT script carries akhn, blwf, nukt and rphf
// only; dev2 adds half, cjct, rkrf, pres, psts, blws, abvs and haln, and
// every row below needs one of those. Arial Unicode has no DFLT at all.
const REF = {
  'Devanagari Sangam MN': {
    font: '/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc',
    size: 1021020,
    rows: [
      ['क्क', [854]],
      ['प्र', [339]],
      ['क्त', [1363]],
      ['द्वार', [312, 175, 163]],
      ['क्ष', [391]],
    ],
  },
  'Arial Unicode': {
    font: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    size: 23278008,
    rows: [
      ['हिन्दी', [1439, 1435, 7008, 1416, 1440]],
      ['क्ष', [6979]],
      ['fi', [73, 76]],
    ],
  },
};
for (const [name, { font: path, size, rows }] of Object.entries(REF)) {
  if (!existsSync(path) || statSync(path).size !== size) {
    console.log(`Skip ${name}: absent or a different build`);
    continue;
  }
  const font = new MantleFontAsset(new Uint8Array(readFileSync(path)));
  let same = 0;
  for (const [text, want] of rows) {
    const got = shape(font, text);
    if (got.length === want.length && got.every((g, i) => g === want[i])) same++;
    else fail(`T7 ${name} ${JSON.stringify(text)}: [${got}] but HarfBuzz gives [${want}]`);
  }
  if (same === rows.length) ok(`T7 ${name}: ${same}/${rows.length} strings match HarfBuzz`);
}

// Four-byte script tags retain their trailing spaces during selection.
for (const [script, tag] of [
  [SCRIPT.Nko, 'nko '],
  [SCRIPT.Lao, 'lao '],
  [SCRIPT.Yi, 'yi  '],
]) {
  const tags = otScriptTagsForScript(script);
  if (!tags || tags.length !== 1 || tags[0] !== TAG(tag))
    fail(`padded tag ${JSON.stringify(tag)}: ${JSON.stringify(tags)}`);
  else ok(`padded tag ${JSON.stringify(tag)} retains all four bytes`);
  const font = new MantleFontAsset(
    buildScriptTestFont('scripts', [{ tag, def: { req: 0xffff, feats: [5] } }]),
  );
  font.gsub.setShapingScript(tags, 0);
  const out = font.gsub.applyFeatureToSeq('ccmp', [2]);
  if (out.length !== 1 || out[0] !== 35)
    fail(`padded script ${JSON.stringify(tag)} selects ${out}, expected35`);
  else ok(`padded script ${JSON.stringify(tag)} reaches its own feature`);
}

console.log(failures === 0 ? 'SCRIPT-LANGSYS PASS' : `SCRIPT-LANGSYS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
