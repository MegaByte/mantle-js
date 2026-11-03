// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sourceTags.js — the negative node-input ids that name a filter graph's sentinel sources. Neutral (no GL): the SVG importer
// and the native backend build graphs without ever loading the GPU evaluator in filterGraph.js, which re-exports these.

export const SRC_GRAPHIC = -1;
export const SRC_ALPHA = -2;
export const SRC_BACKGROUND = -3;
export const SRC_BACKGROUND_A = -4;
export const SRC_FILL_PAINT = -5;
export const SRC_STROKE_PAINT = -6;
