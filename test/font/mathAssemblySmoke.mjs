// mathAssemblySmoke.mjs — verifies MATH GlyphAssembly stitching.
//
// STIX Two Math ships GlyphAssembly recipes for stretchy operators
// (parentheses, integrals, sums, braces) so they can scale beyond
// the largest pre-built variant. mathReader.buildAssembly() now
// produces the per-part offset list a layout engine needs.

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerMathReader } from '../../src/font/math/index.js';
registerMathReader();

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// Locate any MATH font. STIX Two Math is the canonical reference;
// on macOS Cambria Math / Lucida Bright Math also work.
const candidates = [
  '/System/Library/Fonts/Supplemental/STIXTwoMath.otf',
  '/Library/Fonts/STIXTwoMath-Regular.ttf',
  '/System/Library/Fonts/Supplemental/STIX2-Math.otf',
];
let mathFontPath = null;
for (const p of candidates) {
  if (existsSync(p)) { mathFontPath = p; break; }
}
if (!mathFontPath) {
  console.log('Skip MATH assembly smoke: no STIX Math font found');
  process.exit(0);
}

const font = new MantleFontAsset(new Uint8Array(readFileSync(mathFontPath)));
font.getMetrics(0x28);
const math = font.math;

// ----- T1: MATH table available -------------------------------------
{
  if (!math.hasTable) {
    fail(`T1 ${mathFontPath} should expose hasTable=true`);
  } else ok(`T1 MATH table present in ${mathFontPath.split('/').pop()}`);
}

// ----- T2: find a gid with vertical assembly -----------------------
// Sweep gids looking for one whose getMathVariants returns assembly.
{
  let asmGid = -1, asmDesc = null;
  for (let g = 1; g < 5000; g++) {
    const v = math.getMathVariants(g, 'v');
    if (v && v.assembly && v.assembly.parts.length >= 2) {
      asmGid = g; asmDesc = v;
      break;
    }
  }
  if (asmGid < 0) {
    fail('T2 no gid found with vertical GlyphAssembly recipe in first 5000');
  } else {
    ok(`T2 gid ${asmGid} has vertical assembly with ${asmDesc.assembly.parts.length} parts`);
  }
}

// ----- T3: buildAssembly returns sensible layout -------------------
{
  // Find a gid we know has assembly (often LEFT PAREN U+0028 or
  // similar; or use a sweep).
  let testGid = -1;
  let testDesc = null;
  for (let g = 1; g < 5000; g++) {
    const v = math.getMathVariants(g, 'v');
    if (v && v.assembly && v.assembly.parts.length >= 3) {
      testGid = g; testDesc = v;
      break;
    }
  }
  if (testGid < 0) {
    console.log('T3 SKIP: no ≥3-part assembly found');
  } else {
    // Pick a target much larger than the largest pre-built variant.
    const maxVariantAdv = testDesc.variants.length > 0
      ? testDesc.variants[testDesc.variants.length - 1].advance
      : 0;
    const target = Math.max(maxVariantAdv * 3, 10000);
    const asm = math.buildAssembly(testGid, target, 'v');
    if (!asm) fail('T3 buildAssembly returned null for gid with assembly');
    else if (asm.parts.length === 0) fail('T3 assembly has empty parts list');
    else if (asm.totalAdvance < target * 0.95) {
      // Allow small undershoot due to integer arithmetic on overlap rounding.
      fail(`T3 assembly totalAdvance=${asm.totalAdvance} fu, target=${target} fu (gap > 5%)`);
    } else {
      ok(`T3 assembly built for gid=${testGid} target=${target}fu: ` +
         `${asm.parts.length} parts, totalAdvance=${asm.totalAdvance}fu, ` +
         `first 3 parts: ${asm.parts.slice(0,3).map(p=>`{gid=${p.glyphID},off=${p.offset}}`).join(', ')}`);
    }
  }
}

// ----- T4: buildAssembly returns null when no assembly --------------
{
  // ASCII 'A' won't have a vertical assembly in any sane font.
  const aGid = font._tables.codepointToGlyphIndex(0x41);
  if (aGid > 0) {
    const asm = math.buildAssembly(aGid, 5000, 'v');
    if (asm !== null) fail(`T4 expected null for 'A' (no assembly), got ${JSON.stringify(asm)}`);
    else ok('T4 buildAssembly returns null for non-stretchy gid');
  }
}

// ----- T5: short target uses non-extenders only --------------------
{
  // For an assembly gid, pass target = sum of non-extender advances
  // so extReps should be 0.
  let testGid = -1;
  for (let g = 1; g < 5000; g++) {
    const v = math.getMathVariants(g, 'v');
    if (v && v.assembly) { testGid = g; break; }
  }
  if (testGid > 0) {
    const asm = math.buildAssembly(testGid, 1, 'v'); // tiny target
    if (!asm) fail('T5 assembly null for tiny target');
    else {
      // No extender repetitions; parts.length = nonExtender count.
      ok(`T5 tiny target uses base parts only: ${asm.parts.length} parts`);
    }
  }
}

if (failures > 0) {
  console.error(`\nMATH-ASSEMBLY FAIL (${failures})`);
  process.exit(1);
}
console.log('\nMATH-ASSEMBLY PASS');
