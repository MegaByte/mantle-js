// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pageReadySmoke — test/_pageReady.mjs: a page that becomes ready late passes; a page that never does fails
// with a diagnostic naming what was not ready and what the page logged. No GL needed, only a browser.
import http from 'http';
import { launchBrowser } from './_launch.mjs';
import { openReady, readyBudget } from './_pageReady.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const PAGES = {
  '/late': '<script>setTimeout(() => { window.__ready = true; }, 700);</script>',
  '/late-renderer':
    '<script>setTimeout(() => { window.__mantleRenderer = {}; }, 300); setTimeout(() => { window.__mantleGl = {}; }, 800);</script>',
  '/never': '<script>console.error("boom: the page said why"); window.__ready = false;</script>',
  '/spin':
    '<script>function spinInTheEngine(){ for (;;) {} } setTimeout(spinInTheEngine, 100);</script>',
  '/custom': '<script>setTimeout(() => { window.__phase = 3; }, 300);</script>',
};
const server = http.createServer((req, res) => {
  const body = PAGES[req.url.split('?')[0]];
  if (!body) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  let r = await openReady(page, base + '/late', { ready: 'flag' });
  ok(
    r.elapsedMs >= 600,
    `a flag that flips after 700 ms is waited for, not raced (${r.elapsedMs} ms)`,
  );
  r = await openReady(page, base + '/late-renderer', { ready: 'renderer' });
  ok(
    r.elapsedMs >= 700,
    `'renderer' waits for BOTH the renderer and the GL context (${r.elapsedMs} ms)`,
  );
  r = await openReady(page, base + '/custom', { ready: () => window.__phase === 3 });
  ok(r.elapsedMs >= 250, `a custom predicate is honored (${r.elapsedMs} ms)`);
  ok(
    readyBudget({ readyMs: 1234 }) === 1234 && readyBudget() >= 10000,
    'budget: explicit override honored, default generous',
  );

  let msg = null;
  const t0 = Date.now();
  try {
    await openReady(page, base + '/never', {
      ready: 'flag',
      readyMs: 1500,
      name: 'neverReadyPage',
    });
  } catch (e) {
    msg = e.message;
  }
  const took = Date.now() - t0;
  ok(msg !== null, 'a never-ready page rejects');
  ok(took >= 1400 && took < 8000, `...at its own budget, not before and not hanging (${took} ms)`);
  ok(
    msg && /neverReadyPage/.test(msg) && /budget 1500 ms/.test(msg) && /during ready/.test(msg),
    'the error names the smoke, the budget and the phase',
  );
  ok(
    msg && /window\.__ready === true/.test(msg) && /"ready":false/.test(msg),
    'the error says what was awaited and the page state',
  );
  ok(msg && /boom: the page said why/.test(msg), 'the error carries the page console');
  console.log('  sample: ' + (msg || '').slice(0, 300));

  const page2 = await browser.newPage();
  msg = null;
  try {
    await openReady(page2, base + '/spin', { ready: 'flag', readyMs: 1500, name: 'spinPage' });
  } catch (e) {
    msg = e.message;
  }
  ok(
    msg && /did not answer a script query/.test(msg) && /renderer#\d+=(0\.[5-9]|1\.)/.test(msg),
    'a page stuck in a script loop is reported as a busy renderer process (CPU used)',
  );
  console.log('  sample: ' + (msg || '').slice(-420));
  ok(
    /responsive \(idle\)/.test(
      await openReady(page, base + '/never', { readyMs: 800 }).catch((e) => e.message),
    ),
    'an idle never-ready page is reported as responsive',
  );

  let unk = null;
  try {
    await openReady(page, base + '/late', { ready: 'nope' });
  } catch (e) {
    unk = e.message;
  }
  ok(unk && /unknown ready form/.test(unk), 'an unknown ready form is refused');
} finally {
  await browser.close();
  server.close();
}
if (fail) {
  console.error(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log('\npageReadySmoke: all checks passed');
