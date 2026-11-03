// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// originRenderSmoke, corpus part 1 of 10 (assets 0-99), in a browser of its own. See originRenderSmoke.mjs.
process.env.ORIGIN_PART = 'corpus:1/10';
await import('./originRenderSmoke.mjs');
