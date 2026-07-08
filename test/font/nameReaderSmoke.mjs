// nameReaderSmoke.mjs — name-table reader exercises a synthesized
// font + a real one (Arial on macOS). No vendored fixture in the
// repo for the synth case — we build the name-table bytes inline.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { NameTable } from '../../src/font/nameReader.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// ----- T1: synthesized inline name table ---------------------------------
{
  // Build a minimal name-table buffer with two records:
  //   (platform=3, encoding=1, lang=0x0409, nameID=1) "TestFamily"
  //   (platform=3, encoding=1, lang=0x0409, nameID=2) "Bold"
  function utf16BE(s) {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      b[i * 2]     = (c >> 8) & 0xff;
      b[i * 2 + 1] =  c       & 0xff;
    }
    return b;
  }
  const s1 = utf16BE('TestFamily');
  const s2 = utf16BE('Bold');
  const headerLen = 6 + 2 * 12;   // format/count/strOff + 2 records
  const total = headerLen + s1.length + s2.length;
  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  dv.setUint16(0, 0, false);          // format 0
  dv.setUint16(2, 2, false);          // count
  dv.setUint16(4, headerLen, false);  // stringOffset (relative to table start)
  // Record 0 (family)
  dv.setUint16(6 + 0, 3, false); dv.setUint16(6 + 2, 1, false);
  dv.setUint16(6 + 4, 0x0409, false); dv.setUint16(6 + 6, 1, false);
  dv.setUint16(6 + 8, s1.length, false);
  dv.setUint16(6 + 10, 0, false);     // strOff
  // Record 1 (subfamily)
  dv.setUint16(18 + 0, 3, false); dv.setUint16(18 + 2, 1, false);
  dv.setUint16(18 + 4, 0x0409, false); dv.setUint16(18 + 6, 2, false);
  dv.setUint16(18 + 8, s2.length, false);
  dv.setUint16(18 + 10, s1.length, false);
  bytes.set(s1, headerLen);
  bytes.set(s2, headerLen + s1.length);

  // Mock the `tables` shape NameTable expects.
  const tables = { bytes, view: new DataView(buf), name: [0, total] };
  const t = new NameTable(tables);
  if (!t.hasNames) fail('T1 hasNames false');
  else if (t.get(1) !== 'TestFamily') fail(`T1 family=${t.get(1)}`);
  else if (t.get(2) !== 'Bold')       fail(`T1 subfamily=${t.get(2)}`);
  else if (t.get(99) !== null)        fail(`T1 unknown id should be null`);
  else ok(`T1 synth name table: family=${t.get(1)} subfamily=${t.get(2)}`);
}

// ----- T2: empty / missing name table ----------------------------------
{
  const t = new NameTable({ bytes: new Uint8Array(0), view: null });
  if (t.hasNames) fail('T2 hasNames true on empty');
  else if (t.get(1) !== null) fail('T2 lookup non-null on empty');
  else ok('T2 no name table: hasNames false');
}

// ----- T3: real font (Arial on macOS) ----------------------------------
{
  const arial = '/System/Library/Fonts/Supplemental/Arial.ttf';
  if (!existsSync(arial)) {
    ok('T3 skipped (Arial not present)');
  } else {
    const bytes = new Uint8Array(readFileSync(arial));
    const font = new MantleFontAsset(bytes);
    // Force _ensure (familyName is a field; getters trigger init).
    void font.name;
    if (!font.familyName) fail(`T3 familyName empty`);
    else if (font.familyName.toLowerCase().indexOf('arial') < 0)
      fail(`T3 familyName='${font.familyName}' doesn't contain 'arial'`);
    else if (!font.fullName) fail(`T3 fullName empty`);
    else if (!font.postScriptName) fail(`T3 postScriptName empty`);
    else ok(`T3 Arial → family='${font.familyName}' style='${font.styleName}' ps='${font.postScriptName}'`);
  }
}

console.log();
console.log(failures === 0 ? 'NAME-READER PASS' : `NAME-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
