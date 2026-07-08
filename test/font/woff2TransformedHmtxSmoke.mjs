// woff2TransformedHmtxSmoke.mjs — WOFF2 hmtx transform (transformVersion 1).
//
// No real transformed-hmtx fixture ships, so we synthesize one from roboto.
// The transform is only valid (lossless) when every lsb == glyph xMin, so we
// build a valid "original" hmtx (roboto advances + lsb := xMin), drop its LSB
// arrays (flags=0x03) into a re-encoded WOFF2 with glyf stored raw, then decode
// and require the reconstructed hmtx to be byte-identical to that original.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { decodeWoff2 } from '../../src/font/formats/woff2Reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;
function tables(sfnt) {
  const n = u16(sfnt, 4), out = {};
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(sfnt[r], sfnt[r + 1], sfnt[r + 2], sfnt[r + 3]);
    out[tag] = sfnt.subarray(u32(sfnt, r + 8), u32(sfnt, r + 8) + u32(sfnt, r + 12));
  }
  return out;
}
function base128(n) {
  const bytes = []; if (n === 0) return [0];
  while (n > 0) { bytes.unshift(n & 0x7F); n = Math.floor(n / 128); }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}
const KNOWN = { head: 1, hhea: 2, hmtx: 3, maxp: 4, glyf: 10, loca: 11 };

let fail = 0;
const sfnt0 = await decodeWoff2(new Uint8Array(readFileSync(path.join(__dirname, 'fixtures/roboto-regular.woff2'))));
const t0 = tables(sfnt0);
const numHMetrics = u16(t0.hhea, 34);
const numGlyphs = u16(t0.maxp, 4);

// Glyph xMins (independent parse) — what the reader must reconstruct LSBs to.
function xMinsOf(glyf, loca, n) {
  const long = loca.length >= (n + 1) * 4;
  const at = g => long ? u32(loca, g * 4) : u16(loca, g * 2) * 2;
  const x = [];
  for (let g = 0; g < n; g++) {
    const s = at(g), e = at(g + 1);
    let v = e > s ? ((glyf[s + 2] << 8) | glyf[s + 3]) : 0;
    if (v >= 0x8000) v -= 0x10000;
    x.push(v);
  }
  return x;
}
const xMins = xMinsOf(t0.glyf, t0.loca, numGlyphs);

// Valid "original" hmtx: roboto advances, but lsb := xMin (so the transform
// is lossless). This is what the reconstructed table must equal.
const adv = [];
for (let i = 0; i < numHMetrics; i++) adv.push(u16(t0.hmtx, i * 4));
const wI16 = (b, o, v) => { if (v < 0) v += 0x10000; b[o] = (v >> 8) & 0xFF; b[o + 1] = v & 0xFF; };
const origHmtx = new Uint8Array(numHMetrics * 4 + (numGlyphs - numHMetrics) * 2);
for (let i = 0; i < numHMetrics; i++) { origHmtx[i * 4] = (adv[i] >> 8) & 0xFF; origHmtx[i * 4 + 1] = adv[i] & 0xFF; wI16(origHmtx, i * 4 + 2, xMins[i]); }
for (let i = numHMetrics; i < numGlyphs; i++) wI16(origHmtx, numHMetrics * 4 + (i - numHMetrics) * 2, xMins[i]);

// Transformed hmtx: flags 0x03 (drop both LSB arrays) + advanceWidths only.
const thmtx = new Uint8Array(1 + numHMetrics * 2);
thmtx[0] = 0x03;
for (let i = 0; i < numHMetrics; i++) { thmtx[1 + i * 2] = (adv[i] >> 8) & 0xFF; thmtx[2 + i * 2] = adv[i] & 0xFF; }

// Encode a WOFF2: glyf/loca/head/hhea/maxp raw (tv 3/0), hmtx transformed (tv 1).
const spec = [
  ['head', t0.head, 0, null], ['hhea', t0.hhea, 0, null], ['maxp', t0.maxp, 0, null],
  ['loca', t0.loca, 3, null], ['glyf', t0.glyf, 3, null],
  ['hmtx', thmtx, 1, origHmtx.length],   // origLength = standard hmtx size
];
const dir = [], body = [];
for (const [tag, data, tv, origLen] of spec) {
  dir.push(KNOWN[tag] | (tv << 6));
  for (const x of base128(origLen ?? data.length)) dir.push(x);
  if (tv === 1 || (tag === 'glyf' && tv === 0) || (tag === 'loca' && tv === 0))
    for (const x of base128(data.length)) dir.push(x);  // transformLength
  for (const x of data) body.push(x);
}
const comp = new Uint8Array(zlib.brotliCompressSync(Buffer.from(body)));
const head = new Uint8Array(48);
const w32 = (o, v) => { head[o] = (v >>> 24) & 255; head[o + 1] = (v >>> 16) & 255; head[o + 2] = (v >>> 8) & 255; head[o + 3] = v & 255; };
const w16 = (o, v) => { head[o] = (v >> 8) & 255; head[o + 1] = v & 255; };
w32(0, 0x774F4632); w32(4, u32(sfnt0, 0)); w32(8, 0); w16(12, spec.length); w16(14, 0);
w32(16, sfnt0.length); w32(20, comp.length);
const woff2 = new Uint8Array(head.length + dir.length + comp.length);
woff2.set(head, 0); woff2.set(dir, head.length); woff2.set(comp, head.length + dir.length);

// Decode + require the reconstructed hmtx byte-identical to the valid original.
const sfnt1 = await decodeWoff2(woff2);
const h1 = tables(sfnt1).hmtx;
let mism = 0;
if (h1.length !== origHmtx.length) { console.error(`hmtx length ${h1.length} != ${origHmtx.length}`); fail++; }
for (let i = 0; i < origHmtx.length; i++) if (h1[i] !== origHmtx[i]) { if (mism < 5) console.error(`  byte ${i}: ${origHmtx[i]} != ${h1[i]}`); mism++; }
const nonZeroLsb = xMins.filter(v => v !== 0).length;
if (mism) { console.error(`FAIL: ${mism}/${origHmtx.length} hmtx bytes differ after transform round-trip`); fail++; }
else console.log(`hmtx round-trip OK: ${numGlyphs} glyphs, ${numHMetrics} hMetrics, ${nonZeroLsb} non-zero LSBs reconstructed from glyf xMin`);

// Regression: plain roboto.woff2 still decodes.
const again = await decodeWoff2(new Uint8Array(readFileSync(path.join(__dirname, 'fixtures/roboto-regular.woff2'))));
if (again.length !== sfnt0.length) { console.error('FAIL: roboto re-decode size drift'); fail++; }

console.log(fail ? 'woff2TransformedHmtxSmoke: FAIL' : 'woff2TransformedHmtxSmoke: PASS');
process.exit(fail ? 1 : 0);
