// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashSeamSmoke, part 6 of 6 (every 6th row from the 6th): the accuracy lane's per-smoke budget is 180 s. See strokeDashSeamSmoke.mjs.
process.argv.push('--part', '6/6');
await import('./strokeDashSeamSmoke.mjs');
