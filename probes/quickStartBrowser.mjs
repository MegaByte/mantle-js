#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// quickStartBrowser.mjs - the README Quick start, built by real bundlers from the PACKED package and run in Chrome.
//
// Takes the first ```js block under "## Quick start" in README.md verbatim (so the documented code is what runs),
// wraps it with a canvas and an SVG, bundles it with Vite (production), esbuild (splitting), webpack 5 and rollup,
// serves each build from a loopback server that answers unknown paths with index.html (the default of most static
// hosts, which turns a fetched .glsl's 404 into HTML-as-GLSL), loads it in Chrome through
// puppeteer and reads a pixel back.
//
// A build passes when: the page drew the red shape, nothing threw, no .glsl request was made, and no console message reads
// "[object Event]". Worker messages are reported: Vite and webpack emit worker chunks; esbuild and rollup leave the
// `new URL('./x.worker.js', import.meta.url)` literal pointing at a file they never emitted, so the pool must warn with
// the readable text and fall back to the main thread (the draw still succeeds).
//
//   node probes/quickStartBrowser.mjs --tools DIR [--work DIR] [--only vite,esbuild] [--gl metal|swiftshader] [--keep]
//
// DIR is a directory whose node_modules holds esbuild, webpack, rollup, @rollup/plugin-node-resolve and vite.
// GPU use: one Chrome page per build. Run it alone, one GPU job at a time.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../test/_launch.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i < 0 ? d : (process.argv[i + 1] ?? true);
};
const TOOLS = arg('tools', process.env.MANTLE_BUNDLER_TOOLS);
const ONLY = String(arg('only', '')).split(',').filter(Boolean);
const GL = arg('gl', 'metal');
const WORK = path.resolve(arg('work', fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-qs-'))));
if (!TOOLS) {
  console.error('quickStartBrowser: pass --tools DIR');
  process.exit(2);
}
const toolRequire = createRequire(path.join(path.resolve(TOOLS), 'package.json'));
const load = async (n) => import(pathToFileURL(toolRequire.resolve(n)).href);

// The documented sample, verbatim.
const readme = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8');
const afterQuick = readme.slice(readme.indexOf('## Quick start'));
const sample = /```js\n([\s\S]*?)```/.exec(afterQuick)[1];
const sampleLines = sample.split('\n');
const IMPORTS = sampleLines.filter((l) => /^import .* from .*;\s*$/.test(l)).join('\n');
const BODY = sampleLines.filter((l) => !/^import .* from .*;\s*$/.test(l)).join('\n');
const ENTRY = `${IMPORTS}
const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128; document.body.append(canvas);
const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C90 10 90 90 10 90 Z" fill="#ff0000"/></svg>';
window.__result = { error: null };
try {
${BODY.replace(
  /renderer\.render\(bundle\);/,
  `renderer.render(bundle);
const px = () => { const a = new Uint8Array(4); gl.readPixels(40, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a); return Array.from(a); };
window.__result.first = px();
await new Promise((r) => setTimeout(r, 2500));   // let the build workers answer, or fail over
renderer.render(bundle);
window.__result.second = px();`,
)}
} catch (e) { window.__result.error = String(e && e.stack || e); }
window.__done = true;
`;

fs.mkdirSync(WORK, { recursive: true });
const packDir = path.join(WORK, 'pack');
fs.mkdirSync(packDir, { recursive: true });
const tgz = path.join(
  packDir,
  execFileSync('npm', ['pack', '--pack-destination', packDir, '--silent'], {
    cwd: PKG,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop(),
);
const consumer = path.join(WORK, 'consumer');
fs.mkdirSync(path.join(consumer, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(consumer, 'package.json'),
  '{"name":"consumer","private":true,"type":"module"}',
);
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tgz], {
  cwd: consumer,
  stdio: 'pipe',
});
fs.writeFileSync(path.join(consumer, 'src/main.js'), ENTRY);

const builders = {
  async vite() {
    const vite = await load('vite');
    await vite.build({
      root: consumer,
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: 'out-vite',
        emptyOutDir: true,
        rollupOptions: { input: { main: 'src/main.js' } },
      },
    });
    return {
      dir: path.join(consumer, 'out-vite'),
      script: pickMain(path.join(consumer, 'out-vite/assets')),
    };
  },
  async esbuild() {
    const esbuild = await load('esbuild');
    await esbuild.build({
      absWorkingDir: consumer,
      entryPoints: ['src/main.js'],
      bundle: true,
      splitting: true,
      format: 'esm',
      minify: true,
      outdir: 'out-esbuild',
      platform: 'browser',
      logLevel: 'error',
    });
    return { dir: path.join(consumer, 'out-esbuild'), script: 'main.js' };
  },
  async webpack() {
    const webpack = (await load('webpack')).default;
    const compiler = webpack({
      context: consumer,
      mode: 'production',
      entry: { main: './src/main.js' },
      target: 'web',
      output: { path: path.join(consumer, 'out-webpack'), clean: true, publicPath: '/' },
      performance: { hints: false },
      stats: 'errors-warnings',
    });
    const stats = await new Promise((res, rej) => compiler.run((e, s) => (e ? rej(e) : res(s))));
    await new Promise((res) => compiler.close(res));
    if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
    return { dir: path.join(consumer, 'out-webpack'), script: 'main.js' };
  },
  async rollup() {
    const { rollup } = await load('rollup');
    const resolve = (await load('@rollup/plugin-node-resolve')).default;
    const b = await rollup({
      input: path.join(consumer, 'src/main.js'),
      plugins: [resolve({ browser: true })],
      onwarn() {},
    });
    await b.write({ dir: path.join(consumer, 'out-rollup'), format: 'es' });
    await b.close();
    return { dir: path.join(consumer, 'out-rollup'), script: 'main.js' };
  },
};
function pickMain(dir) {
  return 'assets/' + fs.readdirSync(dir).find((f) => /^main-.*\.js$/.test(f));
}

function serve(dir) {
  const srv = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    const known = fs.existsSync(p) && fs.statSync(p).isFile();
    if (!known) p = path.join(dir, 'index.html'); // SPA fallback: unknown paths answer 200 text/html
    const ext = path.extname(p);
    res.setHeader(
      'content-type',
      { '.js': 'text/javascript', '.html': 'text/html', '.glsl': 'text/plain' }[ext] ||
        'application/octet-stream',
    );
    res.end(fs.readFileSync(p));
    (srv.log ||= []).push(`${known ? 200 : '200(spa)'} ${req.url}`);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const results = [];
const browser = await launchBrowser({
  headless: 'new',
  args:
    GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
try {
  for (const [name, build] of Object.entries(builders)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const row = { name, ok: false, notes: [] };
    results.push(row);
    try {
      const out = await build();
      fs.writeFileSync(
        path.join(out.dir, 'index.html'),
        `<!doctype html><meta charset="utf-8"><script type="module" src="/${out.script}"></script>`,
      );
      const srv = await serve(out.dir);
      const page = await browser.newPage();
      const msgs = [];
      page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => msgs.push('[pageerror] ' + String(e).slice(0, 300)));
      await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__done === true, { timeout: 60000, polling: 200 });
      const r = await page.evaluate(() => window.__result);
      await page.close();
      srv.close();
      const red = (p) => p && p[0] > 200 && p[1] < 60 && p[2] < 60;
      const glslReq = (srv.log || []).filter((l) => /\.glsl/.test(l));
      const workerMsgs = msgs.filter((m) => /worker/i.test(m));
      const objEvent = msgs.filter((m) => /\[object Event\]/.test(m));
      const files = fs
        .readdirSync(out.dir, { recursive: true })
        .filter((f) => /worker/i.test(String(f)));
      row.notes.push(
        `first pixel ${JSON.stringify(r.first)}, after workers settle ${JSON.stringify(r.second)}`,
      );
      row.notes.push(`worker chunks emitted: ${files.length ? files.join(', ') : 'none'}`);
      for (const m of workerMsgs.slice(0, 3)) row.notes.push('console: ' + m.slice(0, 300));
      row.ok =
        !r.error &&
        red(r.first) &&
        red(r.second) &&
        glslReq.length === 0 &&
        objEvent.length === 0 &&
        !msgs.some((m) => m.startsWith('[pageerror]'));
      if (r.error) row.notes.push('ERROR ' + r.error.slice(0, 300));
      if (glslReq.length)
        row.notes.push(
          `${glslReq.length} .glsl requests (the bundled path must make none): ${glslReq[0]}`,
        );
      if (objEvent.length) row.notes.push('"[object Event]" in console');
      for (const m of msgs.filter((x) => x.startsWith('[pageerror]')).slice(0, 2))
        row.notes.push(m);
    } catch (e) {
      row.notes.push(
        'FAILED: ' +
          String((e && e.message) || e)
            .split('\n')
            .slice(0, 3)
            .join(' | '),
      );
    }
  }
} finally {
  await browser.close();
}

let bad = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
  for (const n of r.notes) console.log('     ' + n);
  if (!r.ok) bad++;
}
if (!arg('keep', false)) fs.rmSync(WORK, { recursive: true, force: true });
else console.log('kept', WORK);
console.log(bad ? `quickStartBrowser: ${bad} FAILED` : 'quickStartBrowser: PASS');
process.exit(bad ? 1 : 0);
