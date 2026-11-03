// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// woff1Smoke -- WOFF 1.0 input. `new MantleFontAsset(woff1)` (parsed on first use) names WOFF 1.0 rather than a bare "Not a TTF/OTF:
// 0x774f4646", and decodeIfWoff2() (and the auto resolver) decode it.
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { deflateSync } from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { MantleFontAsset, decodeIfWoff2, ttcFaceCount } from '../../src/font/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sfnt = new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts/gposVarKern.ttf')));

// Wrap an sfnt as WOFF 1.0 (W3C spec): header 44 bytes, directory 20 bytes/table, tables zlib'd when smaller.
function toWoff1(sf, { compress = true } = {}) {
  const v = new DataView(sf.buffer, sf.byteOffset, sf.byteLength);
  const n = v.getUint16(4, false),
    flavor = v.getUint32(0, false);
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const d = 12 + i * 16,
      off = v.getUint32(d + 8, false),
      len = v.getUint32(d + 12, false);
    const raw = sf.subarray(off, off + len),
      z = compress ? deflateSync(raw) : raw;
    tabs.push({
      tag: v.getUint32(d, false),
      sum: v.getUint32(d + 4, false),
      orig: len,
      data: z.length < len ? z : raw,
    });
  }
  let size = 44 + 20 * n;
  const offs = tabs.map((t) => {
    const o = size;
    size += (t.data.length + 3) & ~3;
    return o;
  });
  const out = new Uint8Array(size),
    ov = new DataView(out.buffer);
  ov.setUint32(0, 0x774f4646, false);
  ov.setUint32(4, flavor, false);
  ov.setUint32(8, size, false);
  ov.setUint16(12, n, false);
  ov.setUint32(16, sf.length, false);
  tabs.forEach((t, i) => {
    const e = 44 + i * 20;
    ov.setUint32(e, t.tag, false);
    ov.setUint32(e + 4, offs[i], false);
    ov.setUint32(e + 8, t.data.length, false);
    ov.setUint32(e + 12, t.orig, false);
    ov.setUint32(e + 16, t.sum, false);
    out.set(t.data, offs[i]);
  });
  return out;
}

for (const compress of [true, false]) {
  const woff = toWoff1(sfnt, { compress });
  assert.throws(
    () => new MantleFontAsset(woff).codepointToGlyphId(0x41),
    /WOFF 1\.0 needs async pre-decoding.*decodeIfWoff2/,
    'the constructor names the container and the way out',
  );
  assert.throws(() => ttcFaceCount(woff), /WOFF 1\.0/, 'ttcFaceCount names it too');
  const dec = await decodeIfWoff2(woff);
  const a = new MantleFontAsset(sfnt),
    b = new MantleFontAsset(dec);
  assert.equal(b.unitsPerEm, a.unitsPerEm);
  const ga = a.codepointToGlyphId(0x41),
    gb = b.codepointToGlyphId(0x41);
  assert.equal(ga, gb);
  assert.deepEqual(
    b.getMetricsByGid(gb),
    a.getMetricsByGid(ga),
    `decoded WOFF 1.0 reads like the sfnt (compress=${compress})`,
  );
  assert.deepEqual(a.getGlyphSegsByGid(ga), b.getGlyphSegsByGid(gb));
}
// a damaged container fails loudly rather than yielding a broken font
{
  const woff = toWoff1(sfnt);
  const bad = woff.slice(0, 60);
  await assert.rejects(() => decodeIfWoff2(bad), /WOFF 1\.0/);
  const sized = woff.slice();
  new DataView(sized.buffer).setUint32(44 + 12, 99999, false); // table 0 orig length lies
  await assert.rejects(() => decodeIfWoff2(sized), /WOFF 1\.0/);
}
// plain sfnt passes through untouched
assert.strictEqual(await decodeIfWoff2(sfnt), sfnt);
console.log('ok woff1');
