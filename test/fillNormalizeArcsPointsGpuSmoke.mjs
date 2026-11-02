// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

process.env.MANTLE_NORMALIZE_POINTS = '1';
await import('./fillNormalizeArcsGpuSmoke.mjs');
