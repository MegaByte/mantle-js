// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeTextHook.js — the registry slot for the native backend's text bundle.
//
// Building a text bundle needs the whole font/layout engine, which the rest of the native backend does not. So the native
// scene does not import it: `@kontek/mantle/native/text` fills this slot (the root and fallback entries do), and
// scene.createTextBundle() without it throws, naming that import.
let _createNativeTextBundle = null;
export function registerNativeTextBundle(fn) {
  _createNativeTextBundle = fn;
}
export function getNativeTextBundle() {
  return _createNativeTextBundle;
}
