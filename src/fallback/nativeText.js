// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeText.js — enables scene.createTextBundle() on the native backend (`@kontek/mantle/native/text`). Importing this module
// registers it; it carries the font/layout engine, which the rest of the native entry does not.
//
//   import '@kontek/mantle/native/text';

import { createNativeTextBundle } from './nativeTextBundle.js';
import { registerNativeTextBundle } from './nativeTextHook.js';

export function registerNativeText() {
  registerNativeTextBundle(createNativeTextBundle);
}
registerNativeText();

export { createNativeTextBundle };
