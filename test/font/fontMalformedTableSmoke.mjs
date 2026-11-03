// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fontMalformedTableSmoke.mjs — a malformed table is dropped, not thrown out of layout: the font lays out exactly as if it never had
// the table, warns once per font and table, and valid fonts see none of this. The fonts are the fixtures, mutated here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import {
  MantleFontAsset,
  buildTextRun,
  measureGlyphsFromText,
  decodeIfWoff2,
} from '../../src/font/index.js';
import { CffReader } from '../../src/font/formats/cffReader.js';
import { EbdtReader } from '../../src/font/color/ebdtReader.js';
import { SbixReader } from '../../src/font/color/sbixReader.js';
import { buildCff2TestSfnt } from './_cff2FontFixture.mjs';
import { defaultStyle } from '../../src/font/markupParser.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';
import { GsubReader } from '../../src/font/gsubReader.js';
import { MAX_JSTF_PRIORITIES } from '../../src/font/typography/jstfReader.js';
import { setDiagnostics } from '../../src/core/diagnostics.js';
import { buildSvgInOtTestFont } from './_svgInOtFontFixture.mjs';

const warnings = [];
setDiagnostics({ onWarn: (...a) => warnings.push(a.join(' ')) });
const bytesOf = (name) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/fonts/${name}`, import.meta.url)));
const FIXTURES = [
  'aatContext1.ttf',
  'aatContext4.ttf',
  'aatLegacyContext.ttf',
  'aatPosition.ttf',
  'aatPrefer.ttf',
  'cffSubrBomb.otf',
  'colrSpecClipVar.ttf',
  'colrSpecVar.ttf',
  'gposValues.ttf',
  'gposVarKern.ttf',
  'jstfCursive.ttf',
  'jstfPriorities.ttf',
  'shapeArabMulti.ttf',
  'shapeCursRtl.ttf',
  'shapeDevaMatra.ttf',
  'shapeDlig.ttf',
  'shapeKnda.ttf',
  'shapeThaiAm.ttf',
  'statRibbiMac.ttf',
  'wordBoundary.ttf',
];
const TEXTS = ['abc fi AV a b c d e f g\nabc', 'مرحبا', 'क्ति', 'กำ', 'שלום abc'];
const LAYOUTS = [
  {},
  { maxWidthEm: 3, align: 'justify' },
  { writingMode: 'vertical-rl' },
  { features: { dlig: 1, ss01: 1 } },
];

function directory(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = [];
  for (let i = 0; i < v.getUint16(4); i++) {
    const r = 12 + i * 16;
    out.push({
      tag: String.fromCharCode(...bytes.subarray(r, r + 4)),
      rec: r,
      off: v.getUint32(r + 8),
      len: v.getUint32(r + 12),
    });
  }
  return { v, out };
}
const slotsOf = (font, text, layout) =>
  _layoutSlotsForTest([{ text, style: { ...defaultStyle() } }], font, layout).map((s) => [
    s.glyphId,
    s.penX,
    s.penY,
    s.advance,
  ]);
const sameLayouts = (a, b, what) => {
  for (const text of TEXTS)
    for (const layout of LAYOUTS)
      assert.deepEqual(
        slotsOf(a, text, layout),
        slotsOf(b, text, layout),
        `${what}: ${JSON.stringify(text)} ${JSON.stringify(layout)}`,
      );
};

// A valid font sees none of it: no warning, nothing reported, readers still what they are.
for (const name of FIXTURES) {
  if (name === 'cffSubrBomb.otf') continue; // its CharStrings are the malformed part
  warnings.length = 0;
  const f = new MantleFontAsset(bytesOf(name));
  for (const text of TEXTS) for (const layout of LAYOUTS) slotsOf(f, text, layout);
  assert.deepEqual(f.malformedTables, [], `${name} reports nothing`);
  assert.equal(warnings.length, 0, `${name} warns nothing: ${warnings[0]}`);
  assert.ok(f.gsub instanceof GsubReader);
}
// A layout reads the readers directly; whoever asks the font after it gets the guard, for a reader first built during that layout too.
{
  const f = new MantleFontAsset(bytesOf('shapeDlig.ttf'));
  slotsOf(f, 'abc fi', {});
  assert.ok(f.gsub.hasFeature('dlig'));
  f.gsub._view = new DataView(new ArrayBuffer(0)); // the reader's view of the file now faults on any read
  assert.doesNotThrow(() => f.gsub.applyFeatureToSeq('dlig', [1, 2, 3]));
  assert.deepEqual(f.malformedTables, ['GSUB'], 'the guard named the table');
  assert.ok(!f.gsub.hasFeature('dlig'), 'and the font no longer has it');
  warnings.length = 0;
}
console.log('ok valid fonts');

// Every table of every fixture, its directory entry past the end of the file so any read of it faults: as if the table were not there.
let tablesTried = 0;
for (const name of FIXTURES) {
  const base = bytesOf(name);
  for (const { tag, rec } of directory(base).out) {
    const bad = base.slice(),
      gone = base.slice();
    new DataView(bad.buffer).setUint32(rec + 8, bad.length + 16);
    gone.set([0x7a, 0x7a, 0x7a, 0x7a], rec); // the tag no reader looks for
    warnings.length = 0;
    const f = new MantleFontAsset(bad);
    for (const text of TEXTS) for (const layout of LAYOUTS) slotsOf(f, text, layout);
    assert.ok(
      new Set(warnings).size === warnings.length,
      `${name} ${tag}: one warning per table: ${warnings.join(' | ')}`,
    );
    sameLayouts(f, new MantleFontAsset(gone), `${name} ${tag}`);
    tablesTried++;
  }
}
console.log('ok', tablesTried, 'tables past the end of the file');

// The fault is deep in a table, and only some text reaches it. That text gets the result the font gives without the table, and so does
// the text after it, which is what laying out again is for.
{
  const base = bytesOf('gposVarKern.ttf');
  const { v, out } = directory(base);
  const gpos = out.find((t) => t.tag === 'GPOS').off;
  const lookups = gpos + v.getUint16(gpos + 8);
  const lookup = lookups + v.getUint16(lookups + 2);
  const subtableCount = v.getUint16(lookup + 4);
  assert.ok(subtableCount >= 1);
  for (let i = 0; i < subtableCount; i++) v.setUint16(lookup + 6 + i * 2, 0xfff0);
  const gone = base.slice();
  gone.set([0x7a, 0x7a, 0x7a, 0x7a], out.find((t) => t.tag === 'GPOS').rec);
  warnings.length = 0;
  const f = new MantleFontAsset(base),
    clean = new MantleFontAsset(gone);
  const first = slotsOf(f, 'AVTo', {});
  assert.deepEqual(f.malformedTables, ['GPOS'], `the kerned text found it: ${warnings}`);
  assert.deepEqual(first, slotsOf(clean, 'AVTo', {}), 'the text that found the bad table');
  assert.deepEqual(slotsOf(f, 'AVTo', {}), first, 'and the same text after it');
  assert.equal(f.gpos.hasTable, false, 'the font has no GPOS now');
  assert.equal(warnings.length, 1);
  console.log('ok a fault deep in GPOS');
}

// Seeded mutation, as a font off the network would be: nothing crosses layout or a build.
function rng(seed) {
  let x = (seed * 2654435761 + 12345) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
let mutated = 0;
for (const name of FIXTURES) {
  const base = bytesOf(name),
    tables = directory(base).out;
  for (let seed = 0; seed < 40; seed++) {
    const r = rng(seed + 1),
      b = base.slice(),
      v = new DataView(b.buffer);
    for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
      const t = tables[Math.floor(r() * tables.length)],
        at = t.off + Math.floor(r() * Math.max(1, Math.min(t.len, 256) - 1));
      const how = Math.floor(r() * 5);
      if (how === 0) v.setUint32(t.rec + 8, b.length + 8);
      else if (at + 1 < b.length) {
        if (how === 1) b.set([0xff, 0xff], at);
        else if (how === 2) b.set([0, 0], at);
        else if (how === 3) b.set([0x7f, 0xff], at);
        else b[at] = Math.floor(r() * 256);
      }
    }
    warnings.length = 0;
    const f = new MantleFontAsset(b);
    for (const text of TEXTS) {
      for (const layout of LAYOUTS) measureGlyphsFromText(text, f, layout);
      await buildTextRun(text, f);
    }
    assert.ok(
      new Set(warnings).size === warnings.length,
      `${name} seed ${seed}: one warning per table: ${warnings.join(' | ')}`,
    );
    mutated++;
  }
}
console.log('ok', mutated, 'mutated fonts');

// Budgets this policy leans on. Replacing a table: the new bytes go at the end of the file and the directory entry points there.
function withTable(base, tag, bytes) {
  const { out } = directory(base);
  const o = new Uint8Array(base.length + bytes.length);
  o.set(base);
  o.set(bytes, base.length);
  const v = new DataView(o.buffer),
    t = out.find((e) => e.tag === tag);
  v.setUint32(t.rec + 8, base.length);
  v.setUint32(t.rec + 12, bytes.length);
  return o;
}

// JSTF: 65535 priorities sharing one list of 65535 lookups, 260 KB: 4 x 10^10 list entries, and a trial layout of every line per priority.
{
  const base = bytesOf('jstfPriorities.ttf');
  const { v, out } = directory(base);
  const old = out.find((t) => t.tag === 'JSTF').off,
    script = old + v.getUint16(old + 10),
    tag = base.subarray(old + 6, old + 10);
  const prio = 16 + 2 * 65535,
    list = prio + 20,
    size = list + 2 + 2 * 65535;
  const t = new Uint8Array(size),
    d = new DataView(t.buffer);
  d.setUint32(0, 0x00010000);
  d.setUint16(4, 1);
  t.set(tag, 6);
  d.setUint16(10, 12); // one JstfScriptRecord, script at 12
  d.setUint16(14, 4); // script: no extender, defLangSys at +4, 0 languages
  const lang = 16;
  d.setUint16(lang - 0, 65535);
  for (let i = 0; i < 65535; i++) d.setUint16(lang + 2 + i * 2, 2 + 2 * 65535); // every priority record is the same one
  const pr = lang + 2 + 2 * 65535;
  d.setUint16(pr, 20); // shrinkage GSUB enable list, at +20
  d.setUint16(pr + 10, 20); // extension GSUB enable list, the same list
  d.setUint16(pr + 20, 65535);
  warnings.length = 0;
  const f = new MantleFontAsset(
    withTable(base, 'JSTF', t.subarray(0, Math.min(size, pr + 22 + 2 * 65535))),
  );
  const n = measureGlyphsFromText('abc abc abc abc', f, { maxWidthEm: 3, align: 'justify' });
  assert.ok(n, 'laid out');
  assert.ok(f.malformedTables.includes('JSTF'), `the list bomb drops the table: ${warnings}`);
  assert.ok(MAX_JSTF_PRIORITIES <= 256, 'a line tries a bounded number of priorities');
  console.log('ok JSTF');
}

// name: 52980 records of 64 KB each decode to 3.4 GB (found by mutation in a real font's table). The count is read against the table.
{
  const base = bytesOf('statRibbiMac.ttf');
  const { v, out } = directory(base),
    name = out.find((t) => t.tag === 'name');
  const realCount = v.getUint16(name.off + 2);
  v.setUint16(name.off + 2, 65000);
  const f = new MantleFontAsset(base);
  assert.ok(
    f.name.decodedRecords().length >= realCount && f.name.decodedRecords().length <= name.len / 12,
    'records past the table are not records',
  );
  console.log('ok name');
}
{
  // The same strings under every record of a table that really is that long: the decoded total is budgeted.
  const base = bytesOf('statRibbiMac.ttf');
  const count = 65000,
    t = new Uint8Array(6 + count * 12 + 65535),
    d = new DataView(t.buffer);
  d.setUint16(2, count);
  d.setUint16(4, 6 + count * 12 > 65535 ? 65535 : 6 + count * 12);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    d.setUint16(r, 3);
    d.setUint16(r + 2, 1);
    d.setUint16(r + 4, 0x409);
    d.setUint16(r + 6, 1);
    d.setUint16(r + 8, 65534);
  }
  const f = new MantleFontAsset(withTable(base, 'name', t));
  assert.equal(f.name.decodedRecords().length, count);
  console.log('ok name budget');
}

// mort: a chain of length 0 repeated 2^32 times. morx had this guard; mort did not. The font is the one aatMortSmoke builds, by its layout.
{
  const u16 = (n) => [(n >> 8) & 255, n & 255],
    u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const base = bytesOf('jstfPriorities.ttf');
  const lookup = [
    ...u16(6),
    ...u16(4),
    ...u16(1),
    ...u16(4),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...u16(3),
  ]; // glyph 1 -> 3
  const subtable = [...u16(8 + lookup.length), ...u16(0x0004), ...u32(1), ...lookup];
  const mort = new Uint8Array([
    ...u32(0x00010000),
    ...u32(0xffffffff),
    ...u32(1),
    ...u32(0),
    ...u16(0),
    ...u16(1),
    ...subtable,
  ]);
  const b = withTable(base, 'post', mort);
  b.set([0x6d, 0x6f, 0x72, 0x74], directory(base).out.find((e) => e.tag === 'post').rec);
  const f = new MantleFontAsset(b);
  assert.ok(f.mort.hasMort);
  assert.equal(f.applyAatShaping([1, 2]).gids.length, 2, 'the walk stops');
  console.log('ok mort walk');
}

// sbix: an image that does not decode costs that glyph its bitmap, not the run. The strike goes in post's directory entry, renamed.
{
  const base = bytesOf('gposVarKern.ttf');
  const f0 = new MantleFontAsset(base),
    n = f0.codepointToGlyphId(0x41) >= 0 ? f0._tables.numGlyphs : 0,
    gid = f0.codepointToGlyphId(0x41);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const head = 8 + 4,
    strike = 4 + (n + 1) * 4,
    record = 8 + png.length;
  const t = new Uint8Array(head + strike + record),
    d = new DataView(t.buffer);
  d.setUint16(0, 1);
  d.setUint32(4, 1);
  d.setUint32(8, head);
  d.setUint16(head, 64);
  d.setUint16(head + 2, 72);
  for (let g = 0; g <= n; g++) d.setUint32(head + 4 + g * 4, strike + (g > gid ? record : 0));
  const r = head + strike;
  d.setInt16(r, 0);
  d.setInt16(r + 2, 0);
  t.set([0x70, 0x6e, 0x67, 0x20], r + 4);
  t.set(png, r + 8);
  const b = withTable(base, 'post', t);
  b.set([0x73, 0x62, 0x69, 0x78], directory(base).out.find((e) => e.tag === 'post').rec);
  const f = new MantleFontAsset(b);
  assert.ok(f.hasBitmaps, 'the font has its strike');
  assert.ok((await buildTextRun('A', f)).numShapes >= 1, 'the outline draws');
  assert.ok(f.malformedTables.includes('sbix'), `the image is reported: ${f.malformedTables}`);
  console.log('ok a bad bitmap');
}

// SVG: with no DOMParser in the host, or a document that does not parse, the glyph falls to its outline and the run builds.
{
  const f = new MantleFontAsset(buildSvgInOtTestFont({}));
  assert.ok(f.hasSvgGlyphs);
  const run = await buildTextRun('A', f);
  assert.ok(run, 'the run builds');
  console.log('ok an SVG glyph that cannot import');
}

// CFF2's INDEX counts are 32 bits: two billion Font DICTs from a 384-byte font exhausted the heap.
{
  const b = buildCff2TestSfnt({}),
    { out } = directory(b),
    cff2 = out.find((e) => e.tag === 'CFF2');
  const rd = new CffReader(b, cff2.off, cff2.len, 2);
  new DataView(b.buffer, b.byteOffset).setUint32(rd._fdArrayOff, 0x7ffffff0);
  const f = new MantleFontAsset(b);
  assert.ok(measureGlyphsFromText('A', f, {}), 'lays out');
  assert.ok(f.malformedTables.includes('CFF2'), `reported: ${f.malformedTables}`);
  console.log('ok CFF2 FDArray count');
}

// EBDT composites: glyphs that each name the next eight times, 8^16 reads in 200 bytes.
{
  const depth = 16,
    recordSize = 5 + 1 + 2 + 8 * 4;
  const eblc = new Uint8Array(8 + 48 + 8 + 8 + (depth + 2) * 4),
    l = new DataView(eblc.buffer);
  l.setUint32(0, 0x00020000);
  l.setUint32(4, 1);
  l.setUint32(8, 56);
  l.setUint32(16, 1);
  l.setUint16(48, 1);
  l.setUint16(50, depth);
  eblc[52] = 16;
  eblc[53] = 16;
  eblc[54] = 1;
  l.setUint16(56, 1);
  l.setUint16(58, depth);
  l.setUint32(60, 8);
  l.setUint16(64, 1);
  l.setUint16(66, 8);
  l.setUint32(68, 4);
  for (let i = 0; i <= depth; i++) l.setUint32(72 + i * 4, i * recordSize);
  const ebdt = new Uint8Array(4 + depth * recordSize),
    e = new DataView(ebdt.buffer);
  for (let g = 1; g <= depth; g++) {
    const o = 4 + (g - 1) * recordSize;
    ebdt[o] = 1;
    ebdt[o + 1] = 1;
    e.setUint16(o + 6, 8);
    for (let c = 0; c < 8; c++) e.setUint16(o + 8 + c * 4, g + 1);
  }
  const bytes = new Uint8Array(eblc.length + ebdt.length);
  bytes.set(eblc);
  bytes.set(ebdt, eblc.length);
  const reader = new EbdtReader({
    view: new DataView(bytes.buffer),
    bytes,
    eblc: [0, eblc.length],
    ebdt: [eblc.length, ebdt.length],
  });
  assert.throws(
    () => reader.getBitmapGlyph(1, 0),
    RangeError,
    'the budget stops it, and the reader guard turns that into a dropped table',
  );
  console.log('ok EBDT composites');
}

// sbix 'dupe': the glyph shares another glyph's image. Glyph 1 -> 2 -> png; 3 and 4 name each other and have none.
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const recs = [
    [],
    [0x64757065, [0, 2]],
    [0x706e6720, png],
    [0x64757065, [0, 4]],
    [0x64757065, [0, 3]],
  ];
  const n = recs.length,
    head = 12,
    strike = 4 + (n + 1) * 4;
  const size = recs.reduce((a, r) => a + (r.length ? 8 + r[1].length : 0), 0);
  const bytes = new Uint8Array(head + strike + size),
    d = new DataView(bytes.buffer);
  d.setUint16(0, 1);
  d.setUint32(4, 1);
  d.setUint32(8, head);
  d.setUint16(head, 64);
  let at = strike;
  recs.forEach((r, g) => {
    d.setUint32(head + 4 + g * 4, at);
    if (!r.length) return;
    d.setUint32(head + at + 4, r[0]);
    bytes.set(r[1], head + at + 8);
    at += 8 + r[1].length;
  });
  d.setUint32(head + 4 + n * 4, at);
  const reader = new SbixReader({ view: d, bytes, sbix: [0, bytes.length], numGlyphs: n });
  assert.ok(reader.getBitmapGlyph(1, 0)?.isPng, 'a dupe draws the image it names');
  assert.equal(reader.getBitmapGlyph(3, 0), null, 'a loop of dupes draws nothing');
  console.log('ok sbix dupe');
}

// WOFF2 glyf transform: 32767 contours of 65535 points each, from a few hundred bytes. A corrupt container is still an error, at decode.
{
  const stream = [];
  const u16 = (n) => stream.push((n >> 8) & 255, n & 255),
    u32 = (n) => {
      u16(n >>> 16);
      u16(n & 0xffff);
    };
  const contours = 32767,
    points = [];
  for (let i = 0; i < contours; i++) points.push(253, 0xff, 0xff);
  u16(0);
  u16(0);
  u16(1);
  u16(1);
  u32(2);
  u32(points.length);
  u32(4);
  u32(0);
  u32(0);
  u32(4);
  u32(0);
  u16(contours);
  stream.push(...points, 0, 0, 0, 0, 0, 0, 0, 0);
  const body = brotliCompressSync(new Uint8Array(stream));
  const hdr = [0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2];
  const file = new Uint8Array(48 + 12 + body.length),
    d = new DataView(file.buffer);
  file.set(hdr);
  d.setUint32(20, body.length);
  const base128 = (n) => {
    const o = [];
    for (let i = 4; i >= 0; i--) {
      const b = (n >>> (i * 7)) & 0x7f;
      if (b || o.length || i === 0) o.push(b | (i ? 0x80 : 0));
    }
    return o;
  };
  const dir = [10, ...base128(1000), ...base128(stream.length), 11, ...base128(8), ...base128(0)];
  file.set(dir, 48);
  const whole = new Uint8Array(48 + dir.length + body.length);
  whole.set(file.subarray(0, 48));
  whole.set(dir, 48);
  whole.set(body, 48 + dir.length);
  await assert.rejects(decodeIfWoff2(whole), /points past its data/);
  console.log('ok WOFF2 glyf transform');
}

// Bytes that are not a font at all are still an error: there is no table to drop.
assert.throws(() => new MantleFontAsset(new Uint8Array(64)).getMetrics(0x41), /Not a TTF/);
console.log('ok not a font');
