// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _pageReady.mjs — the one place a smoke navigates to its page and waits for the page to say it is ready.
//
// A pair like a 15 s `page.goto` timeout and a 10 s `page.waitForFunction` timeout sets ceilings on
// POLLING, not sleeps -- nothing waits longer than the page needs -- but a ceiling that is too
// short turns a slow first frame into a test failure: on a cold
// shader cache the first program link of a fresh text costs 2-10 s, and a loaded machine adds to that. A
// failure there says nothing about the code under test.
//
// So readiness comes from the PAGE (`window.__ready === true`, or the renderer and its GL context existing) and
// the deadline is a single, generous budget shared by the navigation and the wait, there to catch a page that
// will never be ready, not to time a healthy one. Under the render lane the budget is derived from the lane's
// own per-test cap (`pageTimeoutFor`, so the test outlives its wait and can still print why); standalone it is
// 120 s. When the budget is spent the error says WHAT was not ready and WHAT the page had said by then.
import { pageTimeoutFor } from './_laneBudget.mjs';

const PREDICATES = {
  flag: () => window.__ready === true,
  renderer: () => !!(window.__mantleRenderer && window.__mantleGl),
  // mantleDemo.html loaded with ?svg=: renderer, GL, a BOUND bundle, and no load still in progress. The status text
  // alone is not readiness -- it reads "Waiting for files" until the module has run, which passes a "not Fetching" test.
  demoSvg: () => {
    const s = document.getElementById('status');
    return !!(
      window.__mantleRenderer &&
      window.__mantleGl &&
      window.__mantleGetBundle &&
      window.__mantleGetBundle() &&
      s &&
      !/Fetching|Converting/.test(s.textContent)
    );
  },
};
const DESCRIPTIONS = {
  flag: 'window.__ready === true',
  renderer: 'window.__mantleRenderer && window.__mantleGl',
  demoSvg: 'demo renderer + GL + bound bundle, status not Fetching/Converting',
};

/** The deadline, in ms, that `openReady` gives the navigation and the readiness wait together. */
export function readyBudget(opts = {}) {
  return opts.readyMs > 0 ? opts.readyMs : pageTimeoutFor(120000);
}

/**
 * Navigate to `url` and wait until the page reports it is ready, inside one shared deadline.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {{ ready?: 'flag'|'renderer'|'demoSvg'|Function, readyMs?: number, name?: string, waitUntil?: string }} [opts]
 *   `ready`: 'flag' (default) = `window.__ready === true`; 'renderer' = `window.__mantleRenderer && window.__mantleGl`; 'demoSvg' = mantleDemo.html with a bound bundle;
 *   or a function evaluated in the page. `readyMs`: override the deadline. `name`: how the error names the smoke.
 * @returns {Promise<{ elapsedMs: number }>} resolves when ready; rejects with a diagnostic Error otherwise
 */
export async function openReady(page, url, opts = {}) {
  const which = opts.ready === undefined ? 'flag' : opts.ready;
  const pred = typeof which === 'function' ? which : PREDICATES[which];
  if (!pred)
    throw new Error(
      `openReady: unknown ready form ${JSON.stringify(which)} (use 'flag', 'renderer' or a function)`,
    );
  const what =
    typeof which === 'function'
      ? `custom predicate ${which.toString().slice(0, 120)}`
      : DESCRIPTIONS[which];
  const budget = readyBudget(opts);
  const name = opts.name || process.argv[1] || 'smoke';
  const seen = [];
  const note = (s) => {
    if (seen.length < 40) seen.push(s.length > 400 ? s.slice(0, 400) + '...' : s);
  };
  const onConsole = (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning' || t === 'warn') note(`console.${t}: ${m.text()}`);
  };
  const onErr = (e) => note(`pageerror: ${(e && e.message) || e}`);
  const pending = new Set();
  let crashed = null;
  const onFail = (r) => {
    pending.delete(r);
    note(`requestfailed: ${r.url()} ${(r.failure() && r.failure().errorText) || ''}`);
  };
  const onReq = (r) => pending.add(r),
    onDone = (r) => pending.delete(r);
  const onCrash = (e) => {
    crashed = String((e && e.message) || e);
  };
  page.on('console', onConsole);
  page.on('pageerror', onErr);
  page.on('requestfailed', onFail);
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('error', onCrash);
  const t0 = Date.now();
  const left = () => Math.max(1, budget - (Date.now() - t0));
  let phase = 'goto';
  try {
    await page.goto(url, { waitUntil: opts.waitUntil || 'load', timeout: left() });
    phase = 'ready';
    await page.waitForFunction(pred, { timeout: left(), polling: 100 });
    const elapsedMs = Date.now() - t0;
    // PAGE_READY_LOG=1: how long each page took to say it was ready (a cold shader cache shows up here).
    if (process.env.PAGE_READY_LOG)
      console.log(`  [pageReady] ${name} ready in ${elapsedMs} ms (budget ${budget} ms)`);
    return { elapsedMs };
  } catch (e) {
    const state = await Promise.race([
      page.evaluate(() => {
        const o = {
          ready: window.__ready,
          hasRenderer: !!window.__mantleRenderer,
          hasGl: !!window.__mantleGl,
          error: window.__error === undefined ? null : String(window.__error),
        };
        try {
          const gl = window.__mantleGl;
          if (gl && gl.getError) o.glError = gl.getError();
        } catch (x) {
          o.glError = 'threw ' + x.message;
        }
        return o;
      }),
      new Promise((r) =>
        setTimeout(() => r('page did not answer a state query within 3 s (hung or crashed)'), 3000),
      ),
    ]).catch((x) => `state query failed: ${x.message}`);
    const hang = await dumpHang(page, name, pending, crashed, typeof state !== 'string');
    const err = new Error(
      `${name}: page not ready after ${Date.now() - t0} ms (budget ${budget} ms, during ${phase}); ` +
        `waiting for ${what}; url ${url}; cause: ${e.message}; page state: ${typeof state === 'string' ? state : JSON.stringify(state)}; ` +
        `page console (${seen.length}): ${seen.length ? seen.join(' | ') : 'nothing logged'}; ${hang}`,
    );
    err.cause = e;
    throw err;
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onErr);
    page.off('requestfailed', onFail);
    page.off('request', onReq);
    page.off('requestfinished', onDone);
    page.off('error', onCrash);
  }
}

const within = (p, ms, dflt) =>
  Promise.race([
    Promise.resolve(p).catch((e) => `failed: ${(e && e.message) || e}`),
    new Promise((r) => setTimeout(() => r(dflt), ms)),
  ]);

// What a hung page looks like from outside: did the renderer crash, which requests never finished, does the main
// thread answer at all, and if not whether a renderer process is burning CPU (a script/engine loop) or sitting still
// (blocked). PAGE_READY_DUMP_DIR=<dir> also saves a screenshot. Every probe is time-capped.
async function dumpHang(page, name, pending, crashed, answered) {
  const out = [];
  out.push(`renderer crashed: ${crashed || 'no'}`);
  out.push(`page closed: ${page.isClosed()}`);
  out.push(
    `requests still pending (${pending.size}): ${
      [...pending]
        .slice(0, 6)
        .map((r) => r.url())
        .join(' ') || 'none'
    }`,
  );
  if (answered) out.push('page main thread is responsive (idle): it simply never became ready');
  else {
    out.push('main thread did not answer a script query within 3 s');
    // Debugger.pause cannot name the stack: Debugger.enable is itself served by the stuck main thread. What can be
    // told from outside is whether the renderer PROCESS is burning CPU (a script/engine loop) or sitting still
    // (blocked in a wait), by sampling every browser process's CPU time one second apart.
    try {
      const bc = await within(page.browser().target().createCDPSession(), 3000, null);
      if (bc && bc.send) {
        const snap = async () => {
          const r = await within(bc.send('SystemInfo.getProcessInfo'), 2000, null);
          return (r && r.processInfo) || [];
        };
        const a1 = await snap();
        await new Promise((r) => setTimeout(r, 1000));
        const a2 = await snap();
        const prev = new Map(a1.map((x) => [x.id, x.cpuTime]));
        out.push(
          'processes, CPU seconds used in the last 1 s: ' +
            a2
              .map(
                (x) =>
                  `${x.type}#${x.id}=${(x.cpuTime - (prev.get(x.id) ?? x.cpuTime)).toFixed(2)}`,
              )
              .join(' '),
        );
      } else out.push('no browser CDP session');
    } catch (e) {
      out.push(`process probe failed: ${e.message}`);
    }
  }
  const dir = process.env.PAGE_READY_DUMP_DIR;
  if (dir) {
    try {
      const fs = await import('node:fs');
      fs.mkdirSync(dir, { recursive: true });
      const f = `${dir}/${String(name).split('/').pop()}-${Date.now()}.png`;
      const r = await within(
        page.screenshot({ path: f }).then(() => f),
        5000,
        'screenshot timed out',
      );
      out.push(`screenshot: ${r}`);
    } catch (e) {
      out.push(`screenshot failed: ${e.message}`);
    }
  }
  return out.join('; ');
}
