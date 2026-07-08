// woff2CollectionSmoke.mjs — WOFF2 font collection (TTC, spec §6).
//
// No real woff2-ttc fixture exists, so we synthesize one from roboto: a 2-face
// collection where both faces share all outline tables but reference distinct
// `name` tables (indices 7 vs 8). decodeWoff2 must emit a standard TTC whose
// two font directories share the glyf offset (dedup) but point at different
// name offsets (per-face divergence).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { decodeWoff2 } from '../../src/font/formats/woff2Reader.js';
import { ttcFaceCount } from '../../src/font/ttfTables.js';

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
function base128(n) { const b = []; if (n === 0) return [0]; while (n > 0) { b.unshift(n & 0x7F); n = Math.floor(n / 128); } for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80; return b; }
const KNOWN = { cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, glyf: 10, loca: 11 };

let fail = 0;
const sfnt0 = await decodeWoff2(new Uint8Array(readFileSync(path.join(__dirname, 'fixtures/roboto-regular.woff2'))));
const t0 = tables(sfnt0);
const name1 = Uint8Array.from(t0.name); name1[name1.length - 1] ^= 0xFF;  // make face-1 name differ

// Unique table directory (raw glyf/loca; two distinct `name` entries).
const T = [
  ['head', t0.head, 0], ['hhea', t0.hhea, 0], ['maxp', t0.maxp, 0],
  ['loca', t0.loca, 3], ['glyf', t0.glyf, 3], ['hmtx', t0.hmtx, 0],
  ['cmap', t0.cmap, 0], ['name', t0.name, 0], ['name', name1, 0],
];
const dir = [], body = [];
for (const [tag, data, tv] of T) { dir.push(KNOWN[tag] | (tv << 6)); for (const x of base128(data.length)) dir.push(x); for (const x of data) body.push(x); }
// CollectionDirectory: version, numFonts=2, then per-font {numTables, flavor, indices}.
const coll = [0, 1, 0, 0];                        // version 0x00010000
coll.push(2);                                     // numFonts (255U16, <253 → literal)
for (const nameIdx of [7, 8]) {
  coll.push(8);                                   // numTables
  coll.push(0, 1, 0, 0);                          // flavor 0x00010000
  for (const i of [0, 1, 2, 3, 4, 5, 6, nameIdx]) coll.push(i);  // table indices
}
const comp = new Uint8Array(zlib.brotliCompressSync(Buffer.from(body)));
const head = new Uint8Array(48);
const w32 = (o, v) => { head[o] = (v >>> 24) & 255; head[o + 1] = (v >>> 16) & 255; head[o + 2] = (v >>> 8) & 255; head[o + 3] = v & 255; };
const w16 = (o, v) => { head[o] = (v >> 8) & 255; head[o + 1] = v & 255; };
w32(0, 0x774F4632); w32(4, 0x74746366); w32(8, 0); w16(12, T.length); w16(14, 0); w32(16, 0); w32(20, comp.length);
const woff2 = new Uint8Array(48 + dir.length + coll.length + comp.length);
woff2.set(head, 0); woff2.set(dir, 48); woff2.set(coll, 48 + dir.length); woff2.set(comp, 48 + dir.length + coll.length);

// Decode → standard TTC, then inspect its two font directories.
const ttc = await decodeWoff2(woff2);
if (u32(ttc, 0) !== 0x74746366) { console.error('FAIL: output is not a ttcf'); fail++; }
const nFonts = u32(ttc, 8);
if (nFonts !== 2) { console.error(`FAIL: numFonts ${nFonts} != 2`); fail++; }
if (ttcFaceCount(ttc) !== 2) { console.error(`FAIL: ttcFaceCount ${ttcFaceCount(ttc)} != 2`); fail++; }
function faceTables(fi) {
  const dirOff = u32(ttc, 12 + fi * 4), n = u16(ttc, dirOff + 4), m = {};
  for (let i = 0; i < n; i++) {
    const r = dirOff + 12 + i * 16;
    const tag = String.fromCharCode(ttc[r], ttc[r + 1], ttc[r + 2], ttc[r + 3]);
    m[tag] = { off: u32(ttc, r + 8), len: u32(ttc, r + 12) };
  }
  return m;
}
const f0 = faceTables(0), f1 = faceTables(1);
if (f0.glyf.off !== f1.glyf.off) { console.error('FAIL: shared glyf not deduplicated (different offsets)'); fail++; }
if (f0.name.off === f1.name.off) { console.error('FAIL: per-face name tables not distinct (same offset)'); fail++; }
// face-1 name should be the mutated copy.
const nm0 = ttc[f0.name.off + f0.name.len - 1], nm1 = ttc[f1.name.off + f1.name.len - 1];
if (nm0 === nm1) { console.error('FAIL: face name contents identical (expected divergence)'); fail++; }
if (!fail) console.log(`TTC OK: ${nFonts} faces, glyf shared @${f0.glyf.off}, name distinct (@${f0.name.off} vs @${f1.name.off})`);

console.log(fail ? 'woff2CollectionSmoke: FAIL' : 'woff2CollectionSmoke: PASS');
process.exit(fail ? 1 : 0);
