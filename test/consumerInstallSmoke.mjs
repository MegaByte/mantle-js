// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// consumerInstallSmoke.mjs - the PACKED package works from a scratch consumer.
//
// `npm pack` (prepack runs), `npm install <tgz>` into an empty project (offline, no third-party packages), then in a
// separate Node process: import every `exports` subpath, resolve ./package.json, run bundleShaders.fromPackage() and
// loadShaders(file: URL) for real, and (Node with require(esm)) require() the root. Then compile a TypeScript consumer
// that uses the documented calls under `strict` with skipLibCheck OFF, for nodenext and bundler resolution.
//
// The bundler matrix (esbuild, webpack, rollup, Vite) is probes/bundlerMatrix.mjs: it needs those tools installed.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packPackage, packageJson } from './_packagePack.mjs';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const { tgz, dest } = packPackage();
const pkg = packageJson();
const dir = mkdtempSync(path.join(os.tmpdir(), 'mantle-consumer-'));
try {
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  const inst = spawnSync(
    'npm',
    ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', tgz],
    { cwd: dir, encoding: 'utf8' },
  );
  if (inst.status !== 0) {
    fail('npm install of the tarball failed: ' + (inst.stderr || '').slice(-500));
    throw new Error('install');
  }
  ok('npm install <tarball> into an empty project');

  const specs = Object.keys(pkg.exports)
    .filter((k) => !k.includes('*') && k !== './package.json')
    .map((k) => '@kontek/mantle' + k.slice(1));
  const wild = [
    '@kontek/mantle/filterGraph/primitives/blur',
    '@kontek/mantle/shaders/generated/mantle.vert.glsl',
    '@kontek/mantle/renderer/lbBuild.worker.js',
    '@kontek/mantle/renderer/cpatch.worker.js',
    '@kontek/mantle/renderer/occlusion.worker.js',
    '@kontek/mantle/renderer/occupancy.worker.js',
  ];
  writeFileSync(
    path.join(dir, 'probe.mjs'),
    `
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const out = { imported: [], failed: [], resolved: [], unresolved: [] };
for (const s of ${JSON.stringify(specs)}) {
  try { const m = await import(s); out.imported.push([s, Object.keys(m).length]); } catch (e) { out.failed.push([s, String(e && e.message).split('\\n')[0]]); }
}
for (const s of ${JSON.stringify(wild)}) {
  try { import.meta.resolve(s); out.resolved.push(s); } catch (e) { out.unresolved.push([s, String(e && e.message).split('\\n')[0]]); }
}
const req = createRequire(import.meta.url);
out.pkgVersion = JSON.parse(readFileSync(new URL(import.meta.resolve('@kontek/mantle/package.json')), 'utf8')).version;
try { out.pkgViaRequire = req('@kontek/mantle/package.json').version; } catch (e) { out.pkgViaRequire = 'ERR ' + e.code; }
try { out.requireRoot = Object.keys(req('@kontek/mantle')).length; } catch (e) { out.requireRoot = 'ERR ' + e.code; }
const { bundleShaders, loadShaders, SHADER_FILENAMES } = await import('@kontek/mantle/shaders');
const sh = await bundleShaders.fromPackage();
out.fromPackage = [Object.keys(sh).length, SHADER_FILENAMES.length, sh.fillVert.startsWith('#version 300 es'), typeof sh.fillFrag];
const lean = await bundleShaders.fromPackage({ features: 0n });
out.lean = Object.keys(lean).length;
const base = new URL('./node_modules/@kontek/mantle/src/shaders/', import.meta.url);
const viaFile = await loadShaders(base, { features: 0n });
out.fileUrl = [Object.keys(viaFile).length, viaFile.fillFrag === sh.fillFrag];
const bundled = await import('@kontek/mantle/shaders/bundled');
out.bundledSame = bundled.fillFrag === sh.fillFrag;
// Root import with no window / document / navigator must not throw, and the worker policy must exist.
const root = await import('@kontek/mantle');
out.rootConfigureWorkers = typeof root.configureWorkers;
out.rootTerminateWorkers = typeof root.terminateWorkers;
console.log(JSON.stringify(out));
`,
  );
  const run = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8' });
  if (run.status !== 0) {
    fail('consumer probe crashed: ' + (run.stderr || '').slice(-600));
    throw new Error('probe');
  }
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  out.failed.length === 0
    ? ok(`all ${out.imported.length} exports subpaths import from the installed tarball`)
    : fail('subpaths failed to import: ' + out.failed.map((f) => f.join(' -> ')).join('; '));
  out.unresolved.length === 0
    ? ok(
        `${out.resolved.length} wildcard exports resolve (primitives, generated shader, 4 worker scripts)`,
      )
    : fail('wildcard exports unresolved: ' + out.unresolved.map((f) => f.join(' -> ')).join('; '));
  out.pkgVersion === pkg.version && out.pkgViaRequire === pkg.version
    ? ok(
        `@kontek/mantle/package.json resolves by import.meta.resolve and require (${out.pkgVersion})`,
      )
    : fail(`package.json export: ${out.pkgVersion} / ${out.pkgViaRequire}`);
  if (process.features.require_module) {
    typeof out.requireRoot === 'number'
      ? ok(
          `require('@kontek/mantle') works on this Node (require(esm)): ${out.requireRoot} exports`,
        )
      : fail('require(root) failed: ' + out.requireRoot);
  } else {
    out.requireRoot === 'ERR ERR_REQUIRE_ESM'
      ? ok('this Node has no require(esm): require() reports ERR_REQUIRE_ESM, as the README says')
      : fail('require(root) on a Node without require(esm): ' + out.requireRoot);
  }
  out.fromPackage[0] === out.fromPackage[1] && out.fromPackage[2]
    ? ok(`bundleShaders.fromPackage() in Node: ${out.fromPackage[0]} shaders, GLSL ES 3.00`)
    : fail('fromPackage result ' + JSON.stringify(out.fromPackage));
  out.lean > 0 && out.lean < out.fromPackage[0]
    ? ok(`fromPackage({ features }) trims to ${out.lean}`)
    : fail('spec did not trim: ' + out.lean);
  out.fileUrl[0] === out.lean && out.fileUrl[1] === true
    ? ok(
        'loadShaders(file: URL) in Node reads the shipped generated/ files, byte-equal to the bundled path',
      )
    : fail('file URL load ' + JSON.stringify(out.fileUrl));
  out.bundledSame
    ? ok('@kontek/mantle/shaders/bundled agrees with fromPackage()')
    : fail('bundled.js differs from fromPackage()');
  out.rootConfigureWorkers === 'function'
    ? ok('root exports configureWorkers')
    : fail('configureWorkers missing from the root');
  out.rootTerminateWorkers === 'function'
    ? ok('root exports terminateWorkers')
    : fail('terminateWorkers missing from the root');

  // TypeScript consumer.
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  mkdirSync(path.join(dir, 'ts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'ts/main.ts'),
    `
import { importSvg, createBundle, createRenderer, configureWorkers } from '@kontek/mantle';
import { bundleShaders, loadShaders } from '@kontek/mantle/shaders';
import { buildTextSections } from '@kontek/mantle/textBundle';
import { MantleFontAsset } from '@kontek/mantle/font';
import pkgJson from '@kontek/mantle/package.json' with { type: 'json' };
declare const canvas: HTMLCanvasElement;
declare const svgText: string;
declare const fontBytes: Uint8Array;
configureWorkers({ enabled: false });
const gl = canvas.getContext('webgl2', { depth: true, antialias: false })!;
const shaders = await bundleShaders.fromPackage();
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(svgText));
renderer.render(bundle);
const more: Record<string, string> = await loadShaders();
const font = new MantleFontAsset(fontBytes);
const { sections } = await buildTextSections(font, 'Hello, world', { fontSizePx: 32, fill: [0, 0, 0, 1] });
export const version: string = pkgJson.version;
void more; void sections;
`,
  );
  for (const [name, mod, res] of [
    ['nodenext', 'nodenext', 'nodenext'],
    ['bundler', 'esnext', 'bundler'],
  ]) {
    writeFileSync(
      path.join(dir, `ts/tsconfig.${name}.json`),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: 'es2022',
          module: mod,
          moduleResolution: res,
          lib: ['es2022', 'dom'],
          resolveJsonModule: true,
          types: [],
          typeRoots: [],
        },
        files: ['main.ts'],
      }),
    );
    const t = spawnSync(process.execPath, [tsc, '-p', `ts/tsconfig.${name}.json`], {
      cwd: dir,
      encoding: 'utf8',
    });
    t.status === 0
      ? ok(`TypeScript consumer compiles under strict, skipLibCheck off, ${name} resolution`)
      : fail(
          `TypeScript consumer (${name}):\n` +
            (t.stdout || t.stderr).split('\n').slice(0, 8).join('\n'),
        );
  }
} catch (e) {
  if (!['install', 'probe'].includes(e.message)) fail('smoke error: ' + ((e && e.stack) || e));
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('consumerInstallSmoke: PASS');
