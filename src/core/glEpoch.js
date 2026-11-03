// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// External GL writes invalidate the renderer's pipeline-state shadows.
// Animation, filter/COLR handlers and host GL calls increment this shared epoch;
// tracked setters compare it before suppressing a native state call.

let _epoch = 0;

/// Call after writing GL pipeline state (enable/disable, depth, blend,
/// viewport, program, VAO) from code that does not use renderer/glState.js.
export function noteExternalGlWrite() {
  _epoch++;
}

/// Current epoch. glState compares this against the value it last saw.
export function glEpoch() {
  return _epoch;
}
