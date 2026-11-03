// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _glPreflight — is the BROWSER healthy, or did my change break the render?
//
// Every render probe here launches Chrome through puppeteer, and when the machine has been
// launching them back to back the launches start failing transiently: the page loads, and then
// `Runtime.callFunctionOn` times out. What that looks like from the outside is a probe printing
// nothing, which is exactly what a shader that fails to compile looks like — a shader error blanks
// the render silently. The two are indistinguishable without a control, and the cost of guessing
// wrong is high: three revert cycles proving a change innocent, ending at a CLEAN TREE that also
// printed nothing.
//
// So run this first. It launches a browser, evaluates 1+1 and asks for a WebGL2 context, touching
// none of this repo's code. About 1.5 seconds.
//
//   ok        -> the browser is fine; a probe printing nothing is YOUR change
//   not ok    -> the environment is transiently wedged; wait a few minutes and retry
//
// It clears on its own with time. No reboot has been needed. If it stays wedged, the stale profile
// directories left behind by killed runs are worth clearing:
//   rm -rf /var/folders/*/*/T/puppeteer_dev_chrome_profile-*
import { launchBrowser } from '../test/_launch.mjs';
const t0 = Date.now();
const GPU = process.env.GPU === '1';
const args = ['--no-sandbox'];
args.push(...(GPU ? ['--use-angle=metal', '--enable-gpu'] : ['--enable-unsafe-swiftshader']));
let br = null,
  bad = null;
try {
  br = await launchBrowser({ headless: GPU ? false : 'new', args, protocolTimeout: 30000 });
  const pg = await br.newPage();
  if ((await pg.evaluate(() => 1 + 1)) !== 2) bad = 'evaluate returned the wrong answer';
  const ver = await pg.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2');
    return g ? g.getParameter(g.VERSION) : null;
  });
  if (!bad && !ver) bad = 'no webgl2 context';
  if (!bad) console.log(`  ok — browser healthy in ${Date.now() - t0} ms, ${ver}`);
} catch (e) {
  bad = ((e && e.message) || String(e)).split('\n')[0];
}
try {
  if (br) await br.close();
} catch {}
if (bad) {
  console.error(`  NOT OK after ${Date.now() - t0} ms — ${bad}`);
  console.error('  The environment is wedged, not your change. Wait a few minutes and retry.');
  process.exit(1);
}
