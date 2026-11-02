// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Chrome launch helper with an isolated profile, removed on close or exit.
// Callers that supply userDataDir own that profile and its cleanup.
//
// Smoke tests pass Chromium switches directly to Puppeteer. Supporting Firefox
// requires a shared backend configuration, browser-specific launch options and
// qualification of the Metal-dependent pixel thresholds. Unsupported browser
// requests fail before launch.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const _dirs = new Set();
let _hooked = false;

function _drop(dir) {
  _dirs.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

function _hookExit() {
  if (_hooked) return;
  _hooked = true;
  // Exit cleanup must be synchronous. Signal handlers clean up before exiting.
  process.on('exit', () => {
    for (const d of [..._dirs]) _drop(d);
  });
  process.on('SIGINT', () => {
    for (const d of [..._dirs]) _drop(d);
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    for (const d of [..._dirs]) _drop(d);
    process.exit(143);
  });
}

/**
 * Launch Chrome with an isolated, self-cleaning profile. Takes and returns exactly what
 * `puppeteer.launch` does; a caller that passes its own `userDataDir` keeps it and owns it.
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function launchBrowser(opts = {}) {
  // Reject unsupported backends before Puppeteer can launch Chrome by default.
  const want = process.env.MANTLE_TEST_BROWSER;
  if (want && want !== 'chrome') {
    throw new Error(
      `MANTLE_TEST_BROWSER=${want}: the render lane runs Chrome only. Every smoke passes Chromium ` +
        `switches (--use-angle, --use-gl, --enable-unsafe-swiftshader, --no-sandbox) straight to ` +
        `puppeteer.launch, and Firefox takes prefs, not switches. See the verdict at the top of ` +
        `test/_launch.mjs: this file has to own the backend choice first.`,
    );
  }
  if (opts && opts.userDataDir) return puppeteer.launch(opts);
  _hookExit();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mantle-chrome-'));
  _dirs.add(dir);
  let browser;
  try {
    browser = await puppeteer.launch({ ...opts, userDataDir: dir });
  } catch (e) {
    _drop(dir);
    throw e;
  }
  const close = browser.close.bind(browser);
  browser.close = async () => {
    try {
      await close();
    } finally {
      _drop(dir);
    }
  };
  return browser;
}
