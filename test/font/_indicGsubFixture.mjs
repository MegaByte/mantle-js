// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _indicGsubFixture — a synthesized Devanagari font with one GSUB lookup
// type per feature.
//
// Shared by indicLookupTypesSmoke, which drives it through the Indic
// dispatch, and wouldSubstituteSmoke, which probes the lookups directly.
// Neither needs a system font: the contexts below are disjoint, so a
// feature can only fire on its own sequence.
//
//   psts  type 6 format 3   backtrack KA, input AA          -> AA 20
//   pres  type 6 format 1   cov I, input sequence I KA      -> I  21
//   blws  type 5 format 3   input TA VIRAMA YA, at seqIdx 2 -> YA 22
//   abvs  type 2            NA -> 25 26
//   haln  type 3            SSA -> 27
//   half  type 6 format 3   input MA VIRAMA, lookahead KA   -> MA 28
//   blwf  type 8            cov TA, backtrack VIRAMA        -> TA 29
//   cjct  type 8            cov RA, backtrack VIRAMA        -> RA 30

export const TAG = (s) =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>>
  0;

class Be {
  constructor() {
    this.bytes = [];
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
  raw(a) {
    for (const b of a) this.bytes.push(b & 0xff);
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

// Codepoint -> gid. Every consonant is distinct so one case cannot trip
// another's coverage.
export const CP = {
  KA: 0x0915,
  TA: 0x0924,
  NA: 0x0928,
  MA: 0x092e,
  YA: 0x092f,
  RA: 0x0930,
  SSA: 0x0937,
  AA: 0x093e,
  I: 0x093f,
  VIRAMA: 0x094d,
};
export const GID = { KA: 1, VIRAMA: 2, SSA: 3, RA: 4, I: 5, AA: 6, YA: 7, TA: 8, NA: 9, MA: 10 };

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
function buildGlyfAndLoca() {
  const loca = new Be();
  for (let i = 0; i <= NUM_GLYPHS; i++) loca.u16(0);
  return { glyf: new Uint8Array(0), loca: loca.toUint8() };
}
/// cmap format 4, one segment per codepoint (the gids are not in
/// codepoint order, so the segments cannot be merged).
function buildCmap() {
  const segs = Object.keys(CP)
    .map((k) => ({ start: CP[k], end: CP[k], gid: GID[k] }))
    .sort((a, b) => a.start - b.start);
  segs.push({ start: 0xffff, end: 0xffff, gid: 0 });
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

// -- GSUB subtable builders. Each returns subtable bytes; `lookup()`
// wraps them with the lookup header, whose one subtable sits at +8.
const cov = (glyphs) => {
  const b = new Be();
  b.u16(1);
  b.u16(glyphs.length);
  for (const g of [...glyphs].sort((x, y) => x - y)) b.u16(g);
  return b.toUint8();
};
const lookup = (type, subBytes) => {
  const b = new Be();
  b.u16(type);
  b.u16(0);
  b.u16(1);
  b.u16(8);
  b.raw(Array.from(subBytes));
  return b.toUint8();
};
/// SingleSubstFormat 2.
function single1(pairs) {
  const b = new Be();
  b.u16(2);
  b.u16(6 + pairs.length * 2);
  b.u16(pairs.length);
  for (const p of pairs) b.u16(p[1]);
  b.raw(Array.from(cov(pairs.map((p) => p[0]))));
  return lookup(1, b.toUint8());
}
/// MultipleSubstFormat 1 — one covered glyph, one Sequence.
function multiple2(from, to) {
  const seq = new Be();
  seq.u16(to.length);
  for (const g of to) seq.u16(g);
  const seqB = seq.toUint8();
  const b = new Be();
  const head = 8; // format, covOff, seqCount, seqOff[1]
  b.u16(1);
  b.u16(head + seqB.length);
  b.u16(1);
  b.u16(head);
  b.raw(Array.from(seqB));
  b.raw(Array.from(cov([from])));
  return lookup(2, b.toUint8());
}
/// AlternateSubstFormat 1 — one covered glyph, one AlternateSet.
function alternate3(from, alts) {
  const set = new Be();
  set.u16(alts.length);
  for (const g of alts) set.u16(g);
  const setB = set.toUint8();
  const b = new Be();
  const head = 8;
  b.u16(1);
  b.u16(head + setB.length);
  b.u16(1);
  b.u16(head);
  b.raw(Array.from(setB));
  b.raw(Array.from(cov([from])));
  return lookup(3, b.toUint8());
}
/// ContextSubstFormat 3 — `inputs` is one glyph list per input position.
function context5f3(inputs, records) {
  const b = new Be();
  const head = 6 + inputs.length * 2 + records.length * 4;
  b.u16(3);
  b.u16(inputs.length);
  b.u16(records.length);
  const covs = inputs.map(cov);
  let at = head;
  for (const c of covs) {
    b.u16(at);
    at += c.length;
  }
  for (const r of records) {
    b.u16(r[0]);
    b.u16(r[1]);
  }
  for (const c of covs) b.raw(Array.from(c));
  return lookup(5, b.toUint8());
}
/// ChainContextSubstFormat 3.
function chain6f3(back, input, ahead, records) {
  const all = [...back, ...input, ...ahead].map(cov);
  const head =
    2 +
    (2 + back.length * 2) +
    (2 + input.length * 2) +
    (2 + ahead.length * 2) +
    2 +
    records.length * 4;
  const b = new Be();
  b.u16(3);
  let at = head,
    k = 0;
  for (const list of [back, input, ahead]) {
    b.u16(list.length);
    for (let i = 0; i < list.length; i++) {
      b.u16(at);
      at += all[k].length;
      k++;
    }
  }
  b.u16(records.length);
  for (const r of records) {
    b.u16(r[0]);
    b.u16(r[1]);
  }
  for (const c of all) b.raw(Array.from(c));
  return lookup(6, b.toUint8());
}
/// ChainContextSubstFormat 1 — one ChainSubRuleSet holding one rule.
function chain6f1(first, back, restInput, ahead, records) {
  const rule = new Be();
  rule.u16(back.length);
  for (const g of back) rule.u16(g);
  rule.u16(restInput.length + 1);
  for (const g of restInput) rule.u16(g);
  rule.u16(ahead.length);
  for (const g of ahead) rule.u16(g);
  rule.u16(records.length);
  for (const r of records) {
    rule.u16(r[0]);
    rule.u16(r[1]);
  }
  const ruleB = rule.toUint8();
  const set = new Be();
  set.u16(1);
  set.u16(4);
  set.raw(Array.from(ruleB));
  const setB = set.toUint8();
  const b = new Be();
  const head = 8; // format, covOff, setCount, setOff[1]
  b.u16(1);
  b.u16(head + setB.length);
  b.u16(1);
  b.u16(head);
  b.raw(Array.from(setB));
  b.raw(Array.from(cov([first])));
  return lookup(6, b.toUint8());
}
/// ReverseChainSingleSubstFormat 1.
function reverse8(from, back, ahead, to) {
  const all = [...back, ...ahead].map(cov);
  const head = 4 + (2 + back.length * 2) + (2 + ahead.length * 2) + 4;
  const b = new Be();
  b.u16(1);
  b.u16(head + all.reduce((a, c) => a + c.length, 0));
  let at = head,
    k = 0;
  for (const list of [back, ahead]) {
    b.u16(list.length);
    for (let i = 0; i < list.length; i++) {
      b.u16(at);
      at += all[k].length;
      k++;
    }
  }
  b.u16(1);
  b.u16(to);
  for (const c of all) b.raw(Array.from(c));
  b.raw(Array.from(cov([from])));
  return lookup(8, b.toUint8());
}

/// Assemble GSUB from prebuilt lookup blobs, a feature list (sorted by
/// tag) and one 'dev2' script whose default language system carries them.
function buildGsub(lookupBlobs, features) {
  const lkList = new Be();
  lkList.u16(lookupBlobs.length);
  let at = 2 + lookupBlobs.length * 2;
  for (const b of lookupBlobs) {
    lkList.u16(at);
    at += b.length;
  }
  for (const b of lookupBlobs) lkList.raw(Array.from(b));
  const lookupList = lkList.toUint8();

  const bodies = features.map((f) => {
    const b = new Be();
    b.u16(0);
    b.u16(f.lookups.length);
    for (const li of f.lookups) b.u16(li);
    return b.toUint8();
  });
  const ftList = new Be();
  ftList.u16(features.length);
  let ftAt = 2 + features.length * 6;
  for (let i = 0; i < features.length; i++) {
    ftList.u32(TAG(features[i].tag));
    ftList.u16(ftAt);
    ftAt += bodies[i].length;
  }
  for (const b of bodies) ftList.raw(Array.from(b));
  const featureList = ftList.toUint8();

  const langSys = new Be();
  langSys.u16(0);
  langSys.u16(0xffff);
  langSys.u16(features.length);
  for (let i = 0; i < features.length; i++) langSys.u16(i);
  const script = new Be();
  script.u16(4);
  script.u16(0);
  script.raw(Array.from(langSys.toUint8()));
  const scriptB = script.toUint8();
  const scList = new Be();
  scList.u16(1);
  scList.u32(TAG('dev2'));
  scList.u16(8);
  scList.raw(Array.from(scriptB));
  const scriptList = scList.toUint8();

  const b = new Be();
  b.u16(1);
  b.u16(0);
  b.u16(10);
  b.u16(10 + scriptList.length);
  b.u16(10 + scriptList.length + featureList.length);
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
  let at = 12;
  for (const i of order) {
    dv.setUint32(at, records[i].tag, false);
    dv.setUint32(at + 4, 0, false);
    dv.setUint32(at + 8, offsets[i], false);
    dv.setUint32(at + 12, records[i].bytes.length, false);
    at += 16;
  }
  for (let i = 0; i < records.length; i++) out.set(records[i].bytes, offsets[i]);
  return out;
}

// Lookups 0-5 are the ones a feature names; 6-9 are the single
// substitutions the context lookups reach through a SubstLookupRecord.
export const LOOKUPS = [
  /* 0 psts */ chain6f3([[GID.KA]], [[GID.AA]], [], [[0, 6]]),
  /* 1 pres */ chain6f1(GID.I, [], [GID.KA], [], [[0, 7]]),
  /* 2 blws */ context5f3([[GID.TA], [GID.VIRAMA], [GID.YA]], [[2, 8]]),
  /* 3 abvs */ multiple2(GID.NA, [25, 26]),
  /* 4 haln */ alternate3(GID.SSA, [27]),
  /* 5 half */ chain6f3([], [[GID.MA], [GID.VIRAMA]], [[GID.KA]], [[0, 9]]),
  /* 6 */ single1([[GID.AA, 20]]),
  /* 7 */ single1([[GID.I, 21]]),
  /* 8 */ single1([[GID.YA, 22]]),
  /* 9 */ single1([[GID.MA, 28]]),
  /* 10 blwf */ reverse8(GID.TA, [[GID.VIRAMA]], [], 29),
  // The same lookup type under a feature the base index does not mask.
  // 'blwf' above can never fire: the Indic model asks the font whether a
  // consonant has a below-base form with a two-glyph would-substitute
  // probe, a reverse chain replaces ONE glyph and so answers no, the
  // consonant is therefore the base, and 'blwf' is withheld from the base
  // and everything before it. HarfBuzz leaves it unsubstituted for the
  // same reason. 'cjct' is global, so this one reaches lookup type 8.
  /* 11 cjct */ reverse8(GID.RA, [[GID.VIRAMA]], [], 30),
];
// FeatureRecords are sorted by tag, and the language system names them by
// index, so this order is also the order the features are numbered in.
export const FEATURES = [
  { tag: 'abvs', lookups: [3] },
  { tag: 'blwf', lookups: [10] },
  { tag: 'blws', lookups: [2] },
  { tag: 'cjct', lookups: [11] },
  { tag: 'half', lookups: [5] },
  { tag: 'haln', lookups: [4] },
  { tag: 'pres', lookups: [1] },
  { tag: 'psts', lookups: [0] },
];

export function buildIndicGsubFont() {
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
    { tag: TAG('GSUB'), bytes: buildGsub(LOOKUPS, FEATURES) },
  ]);
}
