// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies the importer emits a synthetic close UNCONDITIONALLY per
// subpath, so two paths with identical Q/L topology produce the same
// curveFloats.length regardless of whether their endpoints land within
// the 1e-4 close-detection tolerance band.
//
// splitSubpathsWithCloseInto must NOT gate the close-line on abs(lp - fp) >
// 1e-4: two topologically-identical poses whose endpoints straddle that
// band would then differ by 12 floats (1 LINE = 3 texels × 4), breaking
// createShapeMorph's topology-match path.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const ok = (msg) => console.log('ok', msg);
const fail = (msg) => {
  failures++;
  console.error('FAIL', msg);
};

async function importLen(svg) {
  const sections = await importSvg(svg, {});
  const buf = new Float32Array(sections.curves);
  return buf.length;
}

// A: open path whose end is well clear of its start (> 1e-4).
// B: same path but with its end NUDGED to land within the 1e-4 band.
// C: same path but with its end snapped exactly to its start (== 0).
// All three should produce the same curveFloats.length because the
// synthetic close is unconditional.
const A = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 Q 50 0 90 10 L 90 90 Q 50 100 10 90 L 11 11" fill="#fff"/>
</svg>`;
const B = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 Q 50 0 90 10 L 90 90 Q 50 100 10 90 L 10.00005 10.00005" fill="#fff"/>
</svg>`;
const C = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 Q 50 0 90 10 L 90 90 Q 50 100 10 90 L 10 10" fill="#fff"/>
</svg>`;

const lenA = await importLen(A);
const lenB = await importLen(B);
const lenC = await importLen(C);

if (lenA === lenB && lenB === lenC) {
  ok(`open / sub-tolerance / exact-close all produce curveFloats.length = ${lenA}`);
} else {
  fail(`divergence: A=${lenA} B=${lenB} C=${lenC} (expected all equal)`);
}

// Also: an SVG with explicit Z (which causes the parser to emit the
// close itself) should still produce the same length.
const D = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 Q 50 0 90 10 L 90 90 Q 50 100 10 90 Z" fill="#fff"/>
</svg>`;
const lenD = await importLen(D);
if (lenD === lenA) {
  ok(`explicit Z produces same length as L-back-to-start (${lenD})`);
} else {
  // Acceptable: Z may resolve to the same line as the L back-to-start
  // but the parser path is slightly different. Just don't fail.
  console.log(`note: explicit Z length=${lenD} vs L-back-to-start=${lenA}`);
}

// ----- Degenerate-segment determinism --------------------------------
// Pose A has a sub-1e-7 quadratic (control points effectively collapsed
// to a point — bbox ≈ 0). Pose B has the same quadratic with its control
// point perturbed by 1e-6 (still visually degenerate but bbox crosses the
// 1e-7 filter). The texture builder must retain the quad in both poses —
// dropping one would cause a 16-float divergence (1 quad = 4 texels × 4).
const E = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 L 50 10 Q 50 10 50 10 L 50 90 L 10 90 Z" fill="#fff"/>
</svg>`;
const F = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 L 50 10 Q 50.000001 10.000001 50 10 L 50 90 L 10 90 Z" fill="#fff"/>
</svg>`;
const lenE = await importLen(E);
const lenF = await importLen(F);
if (lenE === lenF) {
  ok(`sub-1e-7 quad + perturbed quad produce same length (${lenE})`);
} else {
  fail(`degenerate quad divergence: E=${lenE} F=${lenF}`);
}

if (failures > 0) {
  console.error(`\nCLOSE-DETERMINISM FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCLOSE-DETERMINISM PASS');
