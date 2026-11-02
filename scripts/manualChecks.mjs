// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Explicitly standalone reports, source pins and cross-package checks.
export const MANUAL_CHECKS = [
  'test/strokeWidthOverrideReachRenderSmoke.mjs', // development witness; does not establish a stroke-reach repair
  'test/font/perfBench.mjs',
  'test/font/smoke.mjs',
  'test/font/textRunOneGlyph.mjs',
  'test/font/textRunPerGlyph.mjs',
  'test/font/textRunSmoke.mjs',
  'test/svgBundleSize.mjs',
  'test/svgImportBench.mjs',
  'test/arcFootAngleSignedZeroSmoke.mjs',
  'test/shaderParitySmoke.mjs',
  'test/shapeAnimationMultiCurveDiag.mjs',
  'test/svgRenderBench.mjs',
  'test/shapeAnimationCardFlipRepro.mjs',
  'test/strokeDashSeamSmoke.mjs', // the whole closed-dashed-seam oracle set (about nine minutes); the accuracy lane runs it as six parts, strokeDashSeamPart1..6Smoke.mjs
];
