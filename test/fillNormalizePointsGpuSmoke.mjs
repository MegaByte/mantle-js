// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Reuse exact area oracles, but require actual aac@points draw-site ledger entries.
process.env.MANTLE_NORMALIZE_POINTS = '1';
await import('./fillNormalizePolynomialGpuSmoke.mjs');
