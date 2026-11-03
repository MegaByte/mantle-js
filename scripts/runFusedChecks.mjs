#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Compatibility entry point for optional fused accuracy diagnostics.
process.argv.push('--fused');
await import('./runAccuracyDiagnostics.mjs');
