// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPassParityRenderSmoke — every filter/paint shader rewrite in test/_filtperfCases.mjs gives, ON
// THE GPU, what its before-text gives.
//
// Each case in test/_filtperfCases.mjs is a pass A/B: the shader text before a rewrite (kept under
// probes/filtperf/) and the shipped text, each with its own inputs (a rewrite that moves work to the CPU
// changes the uniforms). Both run as one fullscreen pass into an RGBA8 target in the same page
// (test/_passRunner.mjs), and the readbacks are diffed. The node smokes hold the same cases to the
// case's tolerance on the CPU in float32; a GPU compiler may fuse or reorder, so here every case is held
// to at most 1 LSB (a case whose rewrite moves float rounding -- the linear, sweep and transform cases --
// also allows its small fraction of outlier channels, where a hard stop or a texel moved by a pixel),
// and the report says how many channels moved and how many of those sit on an exact rounding tie. A
// case past that, or one that fails to compile, fails.
//
//   node test/filterPassParityRenderSmoke.mjs [--items convolveKernel,boxBlur]
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ia = argv.indexOf('--items');
const ITEMS = ia >= 0 ? argv[ia + 1].split(',') : null;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="4" height="4"></canvas><script type="module">
import { filtperfCases } from '/test/_filtperfCases.mjs';
import { makePassRunner, comparePx } from '/test/_passRunner.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false });
const runner = makePassRunner(gl, async (p) => { const r = await fetch('/' + p); if (!r.ok) throw new Error('fetch ' + p); return r.text(); });
window.__run = async (items) => {
  const out = [];
  for (const c of filtperfCases(items)) {
    try {
      const A = await runner.prepare(c, 'old'), B = await runner.prepare(c, 'new');
      const a = A.read(), b = B.read();
      A.dispose(); B.dispose();
      out.push(Object.assign({ item: c.item, name: c.name, n: c.size[0] * c.size[1] }, comparePx(c, a, b)));
    } catch (e) { out.push({ item: c.item, name: c.name, error: String(e.message || e) }); }
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => {
  failures++;
  console.error('FAIL: page: ' + e.message);
});
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error') console.log('  [page]', m.text());
});
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const rows = await page.evaluate((items) => window.__run(items), ITEMS);
  if (!rows.length) {
    failures++;
    console.error('FAIL: no cases ran');
  }
  for (const r of rows) {
    const tag = `${r.item} ${r.name}`;
    if (r.error) {
      failures++;
      console.error(`FAIL: ${tag}: ${r.error}`);
      continue;
    }
    const msg =
      `${tag}: ${r.ch8} of ${r.n * 4} channels apart (max ${r.mx}), ${r.ties} of them 1 LSB at an exact rounding tie, ` +
      `${r.outliers} past the case's tolerance` +
      (r.off ? `; first elsewhere ${JSON.stringify(r.off)}` : '');
    if (r.pass) console.log('ok ' + msg);
    else {
      failures++;
      console.error('FAIL: ' + msg);
    }
  }
} catch (e) {
  failures++;
  console.error('FAIL: setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterPassParityRenderSmoke: every rewritten pass is within 1 LSB of the text it replaced, on the GPU',
);
