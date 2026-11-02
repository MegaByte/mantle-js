// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bidiConst.js — base direction enum for the lean text path.
//
// Lets textRun / font/text reference the base direction enum (to honor
// layout.baseDirection) without statically importing the full UAX #9
// implementation. bidi.js re-exports this.

export const BaseDirection = Object.freeze({
  Auto: 0,
  Ltr: 1,
  Rtl: 2,
});
