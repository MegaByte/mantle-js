// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// auxWarm.js -- the registry of pipeline warmers that live outside the renderer's own programs. A feature module that owns GL programs the
// renderer cannot see (the morph lerp and fixup passes in animation/shapeMorph.js) adds a warmer when it is imported; the loading call of a
// strictPlay renderer runs every registered warmer once per context behind the loading screen, one fence apart, so the first use in play builds nothing.
/** @type {Set<(gl: WebGL2RenderingContext, ready: (prog: any) => boolean, clearNow?: () => boolean) => boolean>} */
export const auxWarmers = new Set();
