// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sharedBrowsers.mjs -- the render lane's browsers: one per runner worker and launch configuration, shared by the
// smokes that worker runs one after another.
//
// A smoke's launchBrowser() (test/_launch.mjs) posts its headless mode and args to this broker at /<worker> and gets
// the WebSocket endpoint of a browser the runner started with exactly those options; the smoke then works in a fresh
// incognito context of it, and its close() closes only that context. Each worker runs one smoke at a time, so a
// browser never serves two smokes at once.
//
// Between two smokes of a worker, afterSmoke() disposes every context the last smoke left open (a smoke that exits
// without closing, or is killed at its cap), and checks that the browser still answers. It replaces a browser that
// crashed or stopped answering, one that served a smoke that failed or hung (that smoke's retry launches its own),
// and one that has served `maxUses` smokes, so no state builds up over a long lane. A worker keeps at most
// `maxPerWorker` configurations; the least recently used goes first.
//
// The browsers are children of the runner. Their profiles sit in the lane root as mantle-chrome-<runner pid>-shared-*,
// so the orphan reaper (scripts/laneProfiles.mjs) keeps them while the runner lives; a runner that dies without closing
// them (SIGKILL) leaves them to PID 1 under a root whose runner is gone, and the next lane's reaper takes them.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../test/_launch.mjs';

const within = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Start the broker.
 * @param {{ laneRoot: string, maxUses: number, maxPerWorker: number, log: (worker: number, line: string) => void }} o
 */
export async function startSharedBrowsers({ laneRoot, maxUses, maxPerWorker, log }) {
  const workers = new Map(); // worker -> Map(key -> entry)
  let tick = 0;
  let closed = false;
  const stats = { launched: 0, served: 0, retired: {} };
  const count = (why) => (stats.retired[why] = (stats.retired[why] || 0) + 1);

  const launch = async (headless, args) => {
    const dir = mkdtempSync(path.join(laneRoot, `mantle-chrome-${process.pid}-shared-`));
    let browser = null;
    try {
      // userDataDir: launchBrowser launches exactly these options and leaves the profile to its owner, this module.
      browser = await launchBrowser({ headless, args, userDataDir: dir });
      const session = await browser.target().createCDPSession();
      stats.launched++;
      const ws = browser.wsEndpoint();
      return { browser, session, dir, pid: browser.process()?.pid, ws };
    } catch (e) {
      if (browser)
        try {
          await within(browser.close(), 10000, 'browser.close');
        } catch {
          const pid = browser.process()?.pid;
          if (pid) process.kill(pid, 'SIGKILL');
        }
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  };

  const retire = async (w, m, e, why) => {
    m.delete(e.key);
    count(why);
    log(w, `shared browser ${e.label} replaced: ${why}`);
    const b = await e.ready.catch(() => null);
    if (!b) return;
    try {
      await within(b.browser.close(), 10000, 'browser.close');
    } catch {
      // Kill only this browser's own main process, by its exact pid.
      if (b.pid)
        try {
          process.kill(b.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
    }
    try {
      rmSync(b.dir, { recursive: true, force: true });
    } catch {
      /* a helper still holds it; the lane root goes when the runner exits */
    }
  };

  const get = async (w, headless, args) => {
    if (closed) throw new Error('the lane is closing');
    if (!workers.has(w)) workers.set(w, new Map());
    const m = workers.get(w);
    const key = JSON.stringify([headless, [...args].sort()]);
    let e = m.get(key);
    if (e && e.browser && !e.browser.connected) {
      await retire(w, m, e, 'disconnected');
      e = null;
    }
    if (!e) {
      e = { key, label: `${headless === true ? '' : headless + ' '}${args.join(' ')}`, uses: 0 };
      e.ready = launch(headless, args);
      e.ready.then(
        (b) => (e.browser = b.browser),
        () => m.get(key) === e && m.delete(key),
      );
      m.set(key, e);
    }
    e.touched = true;
    e.last = ++tick;
    const b = await e.ready;
    stats.served++;
    return b.ws;
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    try {
      const w = Number(req.url.slice(1));
      let body = '';
      for await (const chunk of req) body += chunk;
      const { headless, args } = JSON.parse(body);
      if (
        req.method !== 'POST' ||
        !Number.isInteger(w) ||
        w < 0 ||
        !(typeof headless === 'boolean' || typeof headless === 'string') ||
        !Array.isArray(args) ||
        !args.every((a) => typeof a === 'string')
      )
        return reply(400, { error: 'expected POST /<worker> {headless, args: [string]}' });
      reply(200, { ws: await get(w, headless, args) });
    } catch (e) {
      reply(503, { error: e.message });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    stats,
    /** The environment a smoke on worker `w` needs to reach its browsers. */
    env: (w) => ({
      MANTLE_SHARED_BROWSER: `${base}/${w}`,
      MANTLE_SHARED_BROWSER_RUNNER: String(process.pid),
    }),
    /** Clean up after one smoke attempt on worker `w`; `failed` replaces the browsers it used. */
    async afterSmoke(w, { failed = false } = {}) {
      const m = workers.get(w);
      if (!m) return;
      for (const e of [...m.values()]) {
        const b = await e.ready.catch(() => null);
        if (!b) continue;
        const used = e.touched;
        e.touched = false;
        if (used) e.uses++;
        if (!b.browser.connected) {
          await retire(w, m, e, 'crashed or disconnected');
          continue;
        }
        if (failed && used) {
          await retire(w, m, e, 'its smoke failed');
          continue;
        }
        try {
          const { browserContextIds } = await within(
            b.session.send('Target.getBrowserContexts'),
            10000,
            'Target.getBrowserContexts',
          );
          for (const id of browserContextIds)
            await within(
              b.session.send('Target.disposeBrowserContext', { browserContextId: id }),
              10000,
              'Target.disposeBrowserContext',
            );
          await within(b.session.send('Browser.getVersion'), 5000, 'Browser.getVersion');
        } catch (err) {
          await retire(w, m, e, err.message);
          continue;
        }
        if (e.uses >= maxUses) await retire(w, m, e, `served ${e.uses} smokes`);
      }
      while (m.size > maxPerWorker) {
        const lru = [...m.values()].sort((a, b) => a.last - b.last)[0];
        await retire(w, m, lru, 'least recently used configuration');
      }
    },
    /** Close every browser and the broker. */
    async close() {
      closed = true;
      server.close();
      for (const m of workers.values())
        for (const e of [...m.values()]) {
          m.delete(e.key);
          const b = await e.ready.catch(() => null);
          if (!b) continue;
          try {
            await within(b.browser.close(), 10000, 'browser.close');
          } catch {
            if (b.pid)
              try {
                process.kill(b.pid, 'SIGKILL');
              } catch {
                /* already gone */
              }
          }
          rmSync(b.dir, { recursive: true, force: true });
        }
    },
    /** Synchronous last resort on exit: kill each browser's exact main pid. */
    killAll() {
      for (const m of workers.values())
        for (const e of m.values()) {
          const pid = e.browser?.process()?.pid;
          if (pid)
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* already gone */
            }
        }
    },
  };
}
