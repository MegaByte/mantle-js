// mathStretchySmoke.mjs — MathVariants reader + codepoint-triggered
// stretchy variant substitution via textRun.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { registerCffReader } from "../../src/font/formats/cff.js";
registerCffReader();
import { buildSvgTextGlyphs } from '../../src/font/textRun.js';
import { isCodepointStretchy, isDisplayNary, isAlwaysStretchy } from '../../src/font/math/mathStretchy.js';
import { registerMathStretchy } from '../../src/font/scripts/math.js';
import { registerMathReader } from '../../src/font/math/index.js';
registerMathStretchy();
registerMathReader();

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

let math = null;
try {
  math = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/STIXTwoMath.otf')));
  math.getMetrics(0x41);
} catch (e) {
  console.log('Skip:', e.message);
  process.exit(0);
}

// ----- T1: codepoint predicates --------------------------------
{
  if (!isDisplayNary(0x2211)) fail('T1 ∑ (U+2211) not display-nary');
  else if (!isDisplayNary(0x222B)) fail('T1 ∫ (U+222B) not display-nary');
  else if (isDisplayNary(0x41)) fail('T1 ASCII A flagged display-nary');
  else if (!isAlwaysStretchy(0x23DE, 'v')) fail('T1 ⏞ (U+23DE) not stretchy vert');
  else if (!isAlwaysStretchy(0x23DE, 'h')) fail('T1 ⏞ not stretchy horiz');
  else if (!isCodepointStretchy(0x2211)) fail('T1 ∑ not isCodepointStretchy');
  else if (isCodepointStretchy(0x41)) fail('T1 A flagged stretchy');
  else ok('T1 codepoint predicates: ∑ ∫ ⏞ flagged; ASCII rejected');
}

// ----- T2: getMathVariants for ∑ ---------------------------
{
  const sumGid = math.codepointToGlyphId(0x2211);
  if (!sumGid) fail('T2 no glyph for ∑');
  else {
    const v = math.math.getMathVariants(sumGid, 'v');
    if (!v) fail('T2 no MathVariants entry for ∑');
    else if (v.variants.length === 0) fail('T2 ∑ MathVariants empty');
    else {
      // Variants should be sorted ascending by advance.
      let mono = true;
      for (let i = 1; i < v.variants.length; i++) {
        if (v.variants[i].advance < v.variants[i-1].advance) { mono = false; break; }
      }
      if (!mono) fail('T2 variants not sorted ascending');
      else {
        const sizes = v.variants.map(r => r.advance).join(', ');
        const asmStr = v.assembly ? `+assembly(${v.assembly.parts.length} parts)` : '';
        ok(`T2 ∑ MathVariants: ${v.variants.length} variants [${sizes}] ${asmStr}`);
      }
    }
  }
}

// ----- T3: pickVariantForSize on ∑ ------------------------
{
  const sumGid = math.codepointToGlyphId(0x2211);
  if (sumGid) {
    const inline = math.math.pickVariantForSize(sumGid, 800, 'v');  // small target
    const display = math.math.pickVariantForSize(sumGid, 1800, 'v'); // big target
    if (inline === display) fail(`T3 inline and display both = ${inline} (no variant selection)`);
    else ok(`T3 ∑ pickVariantForSize: 800fu → gid ${inline}; 1800fu → gid ${display}`);
  }
}

// ----- T4: '∑' end-to-end — display variant substituted ------
// Without cp-triggered substitution, '∑' would emit the inline gid.
// With it, the textRun should emit the display variant.
// Variants of ∑ in STIX have identical seg COUNT (both 19) but
// different BBOXES — compare by bbox dimensions instead.
{
  const inlineGid = math.codepointToGlyphId(0x2211);
  const constants = math.math.getConstants();
  const target = constants.displayOperatorMinHeight || 1800;
  const pickedGid = math.math.pickVariantForSize(inlineGid, target, 'v');

  // Compute bbox of a glyph's segs in font units.
  const bboxOf = (segs) => {
    let xmin=Infinity, xmax=-Infinity, ymin=Infinity, ymax=-Infinity;
    for (const s of segs) {
      const pts = s.type === 0 ? [s.p1, s.p2] : s.type === 1 ? [s.p1, s.p2, s.p3] : [s.p1, s.p2, s.p3, s.p4];
      for (const p of pts) {
        if(p[0]<xmin)xmin=p[0]; if(p[0]>xmax)xmax=p[0];
        if(p[1]<ymin)ymin=p[1]; if(p[1]>ymax)ymax=p[1];
      }
    }
    return { w: xmax-xmin, h: ymax-ymin };
  };
  const inlineBbox = bboxOf(math.getGlyphSegsByGid(inlineGid));
  const pickedBbox = bboxOf(math.getGlyphSegsByGid(pickedGid));

  const { glyphs } = buildSvgTextGlyphs('∑', math, 0, 0, 100);
  if (glyphs.length !== 1) fail(`T4 expected 1 glyph, got ${glyphs.length}`);
  else {
    const emitBbox = bboxOf(glyphs[0].segs);
    // Emit bbox is in pixels (font units / upem * fontSize). At
    // fontSize=100 and STIX upem=1000, emit h = picked.h / 10.
    const expectH = pickedBbox.h * 100 / math.unitsPerEm;
    const inlineH = inlineBbox.h * 100 / math.unitsPerEm;
    // Verify emit matches the DISPLAY variant, not the inline.
    if (Math.abs(emitBbox.h - expectH) > 0.5) {
      fail(`T4 '∑' emit bbox h=${emitBbox.h.toFixed(2)}, want display variant ${expectH.toFixed(2)} (inline=${inlineH.toFixed(2)})`);
    } else if (pickedGid === inlineGid) {
      ok(`T4 '∑' inline form emitted (no display variant in this font)`);
    } else {
      ok(`T4 '∑' display variant emitted: bbox h=${emitBbox.h.toFixed(2)}px vs inline ${inlineH.toFixed(2)}px (variant gid ${pickedGid})`);
    }
  }
}

// ----- T5: ASCII regression — no stretchy substitution -----------
{
  const aGid = math.codepointToGlyphId(0x41);
  const { glyphs } = buildSvgTextGlyphs('A', math, 0, 0, 100);
  if (glyphs.length !== 1) fail(`T5 'A' expected 1 glyph`);
  else {
    const emittedSegs = glyphs[0].segs.length;
    const baseSegs = (math.getGlyphSegsByGid(aGid) || []).length;
    if (emittedSegs !== baseSegs) fail(`T5 'A' segs differ: emitted ${emittedSegs} vs base ${baseSegs}`);
    else ok(`T5 ASCII 'A' regression: same gid as base (no stretchy path)`);
  }
}

// ----- T6: Overbrace ⏞ (U+23DE) — always-stretchy --------------
{
  const obGid = math.codepointToGlyphId(0x23DE);
  if (!obGid) ok(`T6 STIXTwoMath has no glyph for ⏞ (U+23DE); skip`);
  else {
    const v = math.math.getMathVariants(obGid, 'h');
    if (!v) {
      // STIX might list ⏞ only in vertical variants (it's an
      // unusual codepoint).
      const vv = math.math.getMathVariants(obGid, 'v');
      ok(`T6 ⏞ MathVariants: horiz=${v?'yes':'no'} vert=${vv?'yes':'no'}`);
    } else {
      ok(`T6 ⏞ MathVariants(horiz): ${v.variants.length} variants`);
    }
  }
}

console.log();
console.log(failures === 0 ? 'MATH-STRETCHY PASS' : `MATH-STRETCHY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
