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
  'test/filterPassParityRenderSmoke.mjs', // filter pass rewrites equal their before-texts under probes/filtperf; the CPU lane runs the same cases and filterPixelFix pins the shipped output
  'test/strictDerivedRealSmoke.mjs', // needs private game art (MANTLE_GAMES_DIR, MANTLE_GAMES); without it the test skips
  'test/coefTexWarmSmoke.mjs', // a removed coefficient-texture warm-up stays removed; switchCensusSmoke fails on any new ungated global
  'test/cpatchMorphBudgetHeadroomSmoke.mjs', // pins source comments and constants to a probe measurement (probes/perf/cpatchMorphBoxCensus.mjs)
  'test/originRenderSmoke.mjs', // the whole bundle-origin check in one run (its phases in child processes); the render lane runs it as thirteen parts, originRenderCorpus1..10Smoke.mjs and originRenderCells1..3Smoke.mjs
];
