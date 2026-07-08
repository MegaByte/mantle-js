// Verifies CFF decode (STIX OTF) and woff2 decode (Roboto): a few glyphs
// decode to plausible segs with positive advances.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MantleFontAsset, decodeIfWoff2 } from '../../src/font/fontAsset.js';
import { registerWoff2Reader } from '../../src/font/formats/woff2.js';
import { registerCffReader } from '../../src/font/formats/cff.js';
registerWoff2Reader();
registerCffReader();

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL', msg); };

async function smoke(label, path, codepoints) {
  console.log(`\n=== ${label}: ${path} ===`);
  let raw;
  try { raw = new Uint8Array(readFileSync(path)); }
  catch (e) {
    // Missing optional system fonts → skip, not fail (CFF OTF lives at
    // /System/Library on macOS only).
    console.log(`SKIP ${label}: ${e.code} ${path}`);
    return;
  }
  const sfnt = await decodeIfWoff2(raw);
  console.log(`pre-decode: ${raw.length} bytes → ${sfnt.length} bytes`);
  const font = new MantleFontAsset(sfnt);
  let cps;
  // Force the asset to parse so unitsPerEm etc. are populated.
  font.getMetrics(0x41);
  console.log(`upem=${font.unitsPerEm} ascent=${font.ascent.toFixed(3)}`);
  for (const cp of codepoints) {
    const segs = font.getGlyphSegs(cp);
    const m = font.getMetrics(cp);
    const cpHex = cp.toString(16).padStart(4, '0').toUpperCase();
    console.log(`  U+${cpHex}: ${segs ? segs.length : 0} segs, advance=${m.advance.toFixed(3)}em`);
    if (!segs || segs.length === 0)
      fail(`${label} U+${cpHex}: no segs decoded`);
    else {
      const s0 = segs[0];
      console.log(`    seg[0] type=${s0.type} p1=(${s0.p1[0].toFixed(0)},${s0.p1[1].toFixed(0)})`);
    }
    if (!(m.advance > 0))
      fail(`${label} U+${cpHex}: zero advance (${m.advance})`);
  }
}

await smoke('CFF OTF', '/System/Library/Fonts/Supplemental/STIXGeneral.otf', [0x41, 0x42, 0x43, 0x66, 0x69]);
await smoke('woff2',   join(HERE, 'fixtures', 'roboto-regular.woff2'), [0x41, 0x42, 0x43]);

console.log();
console.log(failures === 0 ? 'CFF-JS PASS' : `CFF-JS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
