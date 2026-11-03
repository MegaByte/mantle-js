// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Chrome launch helper with an isolated profile, removed on close or exit.
// Callers that supply userDataDir own that profile and its cleanup.
// The profile is named after the launching process, mantle-chrome-<pid>-XXXXXX, in MANTLE_CHROME_PROFILE_ROOT when the
// render lane names one (scripts/laneProfiles.mjs: the runner reaps a browser there only once its launcher is gone),
// else in the temp directory.
//
// Smoke tests pass Chromium switches directly to Puppeteer. Supporting Firefox
// requires a shared backend configuration, browser-specific launch options and
// qualification of the Metal-dependent pixel thresholds. Unsupported browser
// requests fail before launch.
//
// THE RENDER LANE SHARES ITS BROWSERS. scripts/runRenderSmokes.mjs keeps one browser per worker and launch configuration
// (scripts/sharedBrowsers.mjs) and names its broker in MANTLE_SHARED_BROWSER and its own pid in
// MANTLE_SHARED_BROWSER_RUNNER. A smoke that is a direct child of that runner, and passes no launch option other than
// `headless` and `args` (`protocolTimeout` and `defaultViewport` apply to the connection), gets a fresh incognito
// browser context in the browser started with exactly that headless mode and those args, instead of a Chrome of its
// own. The returned Browser opens and lists its pages in that context (newPage, pages, defaultBrowserContext), and
// close() closes only the context and disconnects. A probe or phase a smoke spawns is not
// the runner's child, so it launches its own browser; so does a smoke the runner lists as needing a fresh browser
// (it does not get the broker), and any smoke the broker cannot serve.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

// Launch options a shared browser can honor: the two it is started with, and the two that belong to the connection.
const SHARED_LAUNCH_OPTS = ['headless', 'args'];
const SHARED_CLIENT_OPTS = ['protocolTimeout', 'defaultViewport'];

/**
 * A context in the runner's shared browser for these options, or null when this process should launch its own.
 * @param {object} opts
 * @returns {Promise<any>}
 */
async function _sharedBrowser(opts) {
  const broker = process.env.MANTLE_SHARED_BROWSER;
  if (!broker || String(process.ppid) !== process.env.MANTLE_SHARED_BROWSER_RUNNER) return null;
  if (
    Object.keys(opts).some(
      (k) => !SHARED_LAUNCH_OPTS.includes(k) && !SHARED_CLIENT_OPTS.includes(k),
    )
  )
    return null;
  let ws = null;
  try {
    const res = await fetch(broker, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headless: opts.headless ?? true, args: opts.args ?? [] }),
    });
    const answer = await res.json();
    if (res.ok) ws = answer.ws;
    else
      console.error(
        `launchBrowser: the shared browser was refused (${answer.error}); launching one`,
      );
  } catch (e) {
    console.error(
      `launchBrowser: the shared-browser broker did not answer (${e.message}); launching one`,
    );
  }
  if (!ws) return null;
  const client = {};
  for (const k of SHARED_CLIENT_OPTS) if (k in opts) client[k] = opts[k];
  let browser = null;
  let context;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: ws, ...client });
    context = await browser.createBrowserContext();
  } catch (e) {
    console.error(
      `launchBrowser: could not open a context in the shared browser (${e.message}); launching one`,
    );
    try {
      await browser?.disconnect();
    } catch {
      /* not connected */
    }
    return null;
  }
  // Only what a smoke reaches for is redirected. Puppeteer itself reads targets(), waitForTarget() and
  // browserContexts() of the whole browser (the browser target, a page being created), so those stay as they are.
  browser.newPage = (o) => context.newPage(o);
  browser.pages = () => context.pages();
  browser.defaultBrowserContext = () => context;
  let closing = null;
  // The runner disposes any context a smoke leaves, so a context or connection already gone is not an error here.
  browser.close = () =>
    (closing ??= (async () => {
      try {
        await context.close();
      } catch {
        /* already disposed */
      }
      try {
        await browser.disconnect();
      } catch {
        /* already disconnected */
      }
    })());
  return browser;
}

/**
 * Launch Chrome with an isolated, self-cleaning profile. Takes and returns exactly what
 * `puppeteer.launch` does; a caller that passes its own `userDataDir` keeps it and owns it.
 * Under the render lane the browser may be a context in the runner's shared browser (see the top of this file).
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
  const shared = await _sharedBrowser(opts || {});
  if (shared) return shared;
  _hookExit();
  const root = process.env.MANTLE_CHROME_PROFILE_ROOT;
  const dir = mkdtempSync(
    path.join(root && existsSync(root) ? root : os.tmpdir(), `mantle-chrome-${process.pid}-`),
  );
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
