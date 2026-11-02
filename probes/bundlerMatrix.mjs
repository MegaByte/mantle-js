#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// bundlerMatrix.mjs - consumer bundle matrix over the PACKED package.
//
// Packs @kontek/mantle (npm pack), installs the tarball into a scratch consumer, and bundles each public
// entry with esbuild, webpack 5, rollup and Vite, in BROWSER mode with NO externals, no `resolve.fallback`
// and no plugin that hides a Node builtin. A hard error, or a warning about an unresolved or
// externalized import, fails the run. With esbuild it also reports the initial-closure min+gzip
// size of each entry (the numbers the README quotes; scripts/measureBundleSizes.mjs is the checked form).
//
// The bundlers are NOT dependencies of this package and the lane never installs them. Point --tools at a
// directory whose node_modules holds esbuild, webpack, rollup, @rollup/plugin-node-resolve and vite:
//
//   mkdir /tmp/tools && cd /tmp/tools && npm init -y >/dev/null \
//     && npm i esbuild webpack rollup @rollup/plugin-node-resolve vite
//   node probes/bundlerMatrix.mjs --tools /tmp/tools [--only esbuild,webpack] [--keep] [--work DIR] [--pkg DIR] [--json FILE]
//
// Exit 0 only when every (tool, entry) pair builds cleanly.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? dflt : (process.argv[i + 1] ?? true);
}
const PKG = path.resolve(arg('pkg', HERE_PKG)); // the package directory to pack (default: this one)
const TOOLS = arg('tools', process.env.MANTLE_BUNDLER_TOOLS);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const KEEP = process.argv.includes('--keep');
const WORK = path.resolve(arg('work', fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-bm-'))));
if (!TOOLS) {
  console.error('bundlerMatrix: pass --tools DIR (a dir whose node_modules holds the bundlers)');
  process.exit(2);
}

export const ENTRIES = {
  bundle: "import {inspectAll} from '@kontek/mantle/bundle'; console.log(inspectAll)",
  svg: "import {importSvg} from '@kontek/mantle/svg'; console.log(importSvg)",
  fonttext: "import * as M from '@kontek/mantle/font/text'; console.log(M)",
  font: "import * as M from '@kontek/mantle/font'; console.log(M)",
  renderer: "import {createRenderer} from '@kontek/mantle/renderer'; console.log(createRenderer)",
  scene: "import * as M from '@kontek/mantle/scene'; console.log(M)",
  hit: "import * as M from '@kontek/mantle/hitTest'; console.log(M)",
  anim: "import * as M from '@kontek/mantle/animation'; console.log(M)",
  fallback: "import * as M from '@kontek/mantle/fallback'; console.log(M)",
  filter: "import * as M from '@kontek/mantle/filterGraph'; console.log(M)",
  shaders: "import {bundleShaders} from '@kontek/mantle/shaders'; console.log(bundleShaders)",
  root_importSvg: "import {importSvg} from '@kontek/mantle'; console.log(importSvg)",
  root_createRenderer: "import {createRenderer} from '@kontek/mantle'; console.log(createRenderer)",
  root_createBundle: "import {createBundle} from '@kontek/mantle'; console.log(createBundle)",
  root_all: "import * as M from '@kontek/mantle'; console.log(M)",
};

const toolRequire = createRequire(path.join(path.resolve(TOOLS), 'package.json'));
const have = (name) => {
  try {
    toolRequire.resolve(name);
    return true;
  } catch {
    return false;
  }
};
const load = async (name) => {
  const r = toolRequire.resolve(name);
  return import(pathToFileURL(r).href);
};

// Pack, install, write entries.
fs.mkdirSync(WORK, { recursive: true });
const packDir = path.join(WORK, 'pack');
fs.mkdirSync(packDir, { recursive: true });
const packOut = execFileSync('npm', ['pack', '--pack-destination', packDir, '--silent'], {
  cwd: PKG,
  encoding: 'utf8',
});
const tgz = path.join(packDir, packOut.trim().split('\n').pop());
const consumer = path.join(WORK, 'consumer');
fs.mkdirSync(path.join(consumer, 'ent'), { recursive: true });
fs.writeFileSync(
  path.join(consumer, 'package.json'),
  '{"name":"consumer","private":true,"type":"module"}',
);
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tgz], {
  cwd: consumer,
  stdio: 'pipe',
});
for (const [n, src] of Object.entries(ENTRIES))
  fs.writeFileSync(path.join(consumer, 'ent', n + '.js'), src + '\n');

const results = []; // { tool, entry, ok, note }
const record = (tool, entry, ok, note = '') => results.push({ tool, entry, ok, note });
const sizes = {};

const BAD_WARN =
  /zlib|externaliz|could not be resolved|unresolved|Can't resolve|Critical dependency|node:|Module not found/i;

async function runEsbuild() {
  const esbuild = await load('esbuild');
  for (const n of Object.keys(ENTRIES)) {
    try {
      const r = await esbuild.build({
        absWorkingDir: consumer,
        entryPoints: ['ent/' + n + '.js'],
        bundle: true,
        minify: true,
        format: 'esm',
        splitting: true,
        outdir: 'out-esbuild/' + n,
        write: false,
        metafile: true,
        logLevel: 'silent',
        platform: 'browser',
        loader: { '.glsl': 'text' },
      });
      const bad = r.warnings.filter((w) => BAD_WARN.test(w.text));
      const outs = r.metafile.outputs;
      const entryKey = Object.keys(outs).find((k) => outs[k].entryPoint === 'ent/' + n + '.js');
      const seen = new Set();
      const q = [entryKey];
      while (q.length) {
        const k = q.pop();
        if (seen.has(k)) continue;
        seen.add(k);
        for (const i of outs[k].imports)
          if (i.kind === 'import-statement' && outs[i.path]) q.push(i.path);
      }
      let raw = 0,
        gz = 0;
      for (const f of r.outputFiles) {
        const rel = path.relative(consumer, f.path);
        if (seen.has(rel)) {
          raw += f.contents.length;
          gz += zlib.gzipSync(f.contents, { level: 9 }).length;
        }
      }
      sizes[n] = { raw, gz, lazyChunks: Object.keys(outs).length - seen.size };
      record('esbuild', n, bad.length === 0, bad.map((w) => w.text).join('; '));
    } catch (e) {
      record('esbuild', n, false, String(e.message).split('\n').slice(0, 2).join(' '));
    }
  }
}

async function runWebpack() {
  const webpack = (await load('webpack')).default;
  for (const n of Object.keys(ENTRIES)) {
    const compiler = webpack({
      context: consumer,
      mode: 'production',
      entry: { [n]: './ent/' + n + '.js' },
      output: { path: path.join(consumer, 'out-wp', n), clean: true },
      target: 'web',
      module: { rules: [{ test: /\.glsl$/, type: 'asset/source' }] },
      performance: { hints: false },
      stats: 'errors-warnings',
      resolve: { modules: [path.join(consumer, 'node_modules')] },
    });
    const stats = await new Promise((res, rej) => compiler.run((e, s) => (e ? rej(e) : res(s))));
    await new Promise((res) => compiler.close(res));
    const j = stats.toJson({ errors: true, warnings: true });
    const msgs = [...j.errors, ...j.warnings].map((m) => m.message.split('\n')[0]);
    record(
      'webpack',
      n,
      j.errors.length === 0 && j.warnings.length === 0,
      msgs.slice(0, 2).join('; '),
    );
  }
}

async function runRollup() {
  const { rollup } = await load('rollup');
  const resolve = (await load('@rollup/plugin-node-resolve')).default;
  for (const n of Object.keys(ENTRIES)) {
    const warns = [];
    try {
      const b = await rollup({
        input: path.join(consumer, 'ent', n + '.js'),
        plugins: [resolve({ browser: true })],
        onwarn: (w) => warns.push(w.message),
      });
      await b.generate({ format: 'es', dir: path.join(consumer, 'out-rollup', n) });
      await b.close();
      const bad = warns.filter((w) => BAD_WARN.test(w));
      record('rollup', n, bad.length === 0, bad.slice(0, 2).join('; '));
    } catch (e) {
      record('rollup', n, false, String(e.message).split('\n')[0]);
    }
  }
}

async function runVite() {
  const vite = await load('vite');
  for (const n of Object.keys(ENTRIES)) {
    const warns = [];
    const logger = {
      hasWarned: false,
      info() {},
      error: (m) => warns.push(String(m)),
      clearScreen() {},
      hasErrorLogged: () => false,
      warn: (m) => warns.push(String(m)),
      warnOnce: (m) => warns.push(String(m)),
    };
    try {
      await vite.build({
        root: consumer,
        configFile: false,
        logLevel: 'warn',
        customLogger: logger,
        build: {
          outDir: path.join(consumer, 'out-vite', n),
          emptyOutDir: true,
          write: true,
          rollupOptions: { input: { [n]: 'ent/' + n + '.js' } },
        },
      });
      const bad = warns.filter((w) => BAD_WARN.test(w));
      record(
        'vite',
        n,
        bad.length === 0,
        bad
          .slice(0, 2)
          .map((s) => s.split('\n')[0])
          .join('; '),
      );
    } catch (e) {
      record('vite', n, false, String(e.message).split('\n')[0]);
    }
  }
}

const RUNNERS = { esbuild: runEsbuild, webpack: runWebpack, rollup: runRollup, vite: runVite };
for (const [tool, run] of Object.entries(RUNNERS)) {
  if (ONLY.length && !ONLY.includes(tool)) continue;
  if (!have(tool === 'vite' ? 'vite' : tool)) {
    record(tool, '*', false, 'not installed in --tools');
    continue;
  }
  await run();
}

let failed = 0;
for (const tool of Object.keys(RUNNERS)) {
  const rows = results.filter((r) => r.tool === tool);
  if (!rows.length) continue;
  const bad = rows.filter((r) => !r.ok);
  failed += bad.length;
  console.log(`${tool.padEnd(8)} ${rows.length - bad.length}/${rows.length} entries clean`);
  for (const r of bad) console.log(`   FAIL ${r.entry}: ${r.note.slice(0, 240)}`);
}
if (Object.keys(sizes).length) {
  console.log('\nesbuild initial closure (min+gzip -9):');
  for (const [n, s] of Object.entries(sizes)) {
    console.log(
      `  ${n.padEnd(20)} ${(s.gz / 1024).toFixed(1).padStart(7)} KB gz  ${(s.raw / 1024).toFixed(1).padStart(7)} KB raw  lazy chunks ${s.lazyChunks}`,
    );
  }
}
if (arg('json', false)) fs.writeFileSync(arg('json'), JSON.stringify({ results, sizes }, null, 1));
if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
else console.log('kept', WORK);
process.exit(failed ? 1 : 0);
