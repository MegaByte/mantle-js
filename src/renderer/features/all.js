// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// features/all.js — register every optional renderer feature (frame export, CPatch). The root entry imports this; a
// feature-splitting app imports only the feature modules it uses.
import './frameExport.js';
import './cpatch.js';
