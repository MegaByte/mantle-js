#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// checkPublicTypes.mjs — the PUBLISHED-TYPES gate.
//
// check:types covers src/renderer. This covers what consumers actually see:
// every `exports` subpath's .d.ts, compiled the way a TypeScript app compiles
// it — `--strict`, and WITHOUT `--skipLibCheck`.
//
// That distinction is the whole point. skipLibCheck suppresses errors inside
// .d.ts files, so a declaration can reference a type that was never declared
// and every local check still passes while the consumer's build breaks: a
// function returning a name (MantleTextBundle, …) that no @typedef declares,
// or destructured options emitted as `?: {}` so every property access on them
// fails.
//
// Generates a temp entry that imports every subpath, type-checks it, and
// reports errors anywhere in types/ — never touching the repo on failure.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

let tscJs;
try {
  tscJs = createRequire(import.meta.url).resolve('typescript/bin/tsc');
} catch {
  console.error(
    'check:public-types: TypeScript not found. Install it: `npm install -D typescript`.',
  );
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const subpaths = [];
for (const [name, entry] of Object.entries(pkg.exports || {})) {
  if (!entry || typeof entry !== 'object' || !entry.types) continue;
  // Wildcard subpaths have no single declaration file to import.
  if (name.includes('*') || entry.types.includes('*')) continue;
  const rel = entry.types.replace(/\.d\.ts$/, '');
  if (!existsSync(path.join(PKG, `${rel}.d.ts`))) {
    console.error(
      `check:public-types: ${name} → ${entry.types} is missing. Run \`npm run gen:types\`.`,
    );
    process.exit(1);
  }
  subpaths.push([name, rel]);
}

// One import per subpath, and a value binding so the module type is
// instantiated rather than merely resolved.
const lines = subpaths.flatMap(([, rel], i) => [
  `import * as m${i} from '${rel}';`,
  `export const e${i}: typeof m${i} = m${i};`,
]);
// Check the documented loading calls as a consumer sees them. A declaration
// with no parameters rejected draw:false even while runtime and README allowed it.
const rootIndex = subpaths.findIndex(([name]) => name === '.');
if (rootIndex < 0) throw new Error('Root public declaration is missing.');
lines.push(
  `declare const loadingRenderer: ReturnType<typeof m${rootIndex}.createRenderer>;`,
  'export const loadingDefaultAttempts: number = loadingRenderer.precompileFills();',
  'export const loadingDrawAttempts: number = loadingRenderer.precompileFills({ draw: true });',
  'export const loadingLinkAttempts: number = loadingRenderer.precompileFills({ draw: false });',
  '// @ts-expect-error loading draw must be boolean',
  'loadingRenderer.precompileFills({ draw: "false" });',
  '// @ts-expect-error reject unknown loading options',
  'loadingRenderer.precompileFills({ draww: false });',
  'loadingRenderer.setFillEngine({ route: "none", kernel: "slug", primitives: "on" });',
  'loadingRenderer.setFillEngine({ primitives: false });',
  '// @ts-expect-error primitive override accepts only on/off or boolean',
  'loadingRenderer.setFillEngine({ primitives: "auto" });',
);
const fontIndex = subpaths.findIndex(([name]) => name === './font');
if (fontIndex < 0) throw new Error('Font public declaration is missing.');
lines.push(
  `declare const variableFont: InstanceType<typeof m${fontIndex}.MantleFontAsset>;`,
  `m${fontIndex}.measureText([], variableFont, { varCoords: [0] });`,
  `m${fontIndex}.measureGlyphs([], variableFont, { varCoords: { wght: 400 } });`,
  '// @ts-expect-error axis coordinates must be numeric',
  `m${fontIndex}.measureText([], variableFont, { varCoords: ['heavy'] });`,
);
const unicodeIndex = subpaths.findIndex(([name]) => name === './font/unicode');
if (unicodeIndex < 0) throw new Error('Unicode public declaration is missing.');
lines.push(
  `m${unicodeIndex}.registerUnicode({ wordStarts: (text: string) => text.length ? [0] : null });`,
  `m${unicodeIndex}.registerUnicode({ wordStarts: function*(text: string) { if (text.length) yield 0; } });`,
  `m${unicodeIndex}.registerUnicode({ normalizeNFC: (text: string) => text.normalize('NFC'), segmentGraphemes: (text: string) => [text] });`,
  `export const dictionaryStarts: Iterable<number> | null = m${unicodeIndex}.segmentWordStarts('text');`,
  '// @ts-expect-error word offsets must be numeric',
  `m${unicodeIndex}.registerUnicode({ wordStarts: () => ['0'] });`,
  '// @ts-expect-error Unicode providers must be synchronous',
  `m${unicodeIndex}.registerUnicode({ wordStarts: async () => [0] });`,
  '// @ts-expect-error reject misspelled provider hooks',
  `m${unicodeIndex}.registerUnicode({ wordStart: () => [0] });`,
  `export const namedFont = new m${fontIndex}.MantleFontAsset(new Uint8Array(), { compat: 'harfbuzz' });`,
  'namedFont.pickerCatalog(); namedFont.styleLocation({ wght: 600 });',
  'namedFont.styleAxisValues({ wght: 600 }); namedFont.instanceStyleName({ wght: 600 });',
  `m${fontIndex}.measureText([], namedFont, { align: 'justify', lastLineAlign: 'justify' });`,
  '// @ts-expect-error final-line alignment has a fixed vocabulary',
  `m${fontIndex}.measureText([], namedFont, { lastLineAlign: 'typo' });`,
  'declare const textGl: WebGL2RenderingContext;',
  `m${rootIndex}.createTextBundle(textGl, { font: namedFont, style: { align: 'justify', lastLineAlign: 'justify' } });`,
  '// @ts-expect-error final-line alignment must be a supported string',
  `export const invalidFinalLineStyle: import('./types/textBundle').TextStyle = { lastLineAlign: 1 };`,
  '// @ts-expect-error font compatibility has a fixed vocabulary',
  `new m${fontIndex}.MantleFontAsset(new Uint8Array(), { compat: 'typo' });`,
);
// The documented shader-loading and worker calls: optional parameters must be optional, results must be typed.
const shaderIndex = subpaths.findIndex(([name]) => name === './shaders');
if (shaderIndex < 0) throw new Error('Shaders public declaration is missing.');
lines.push(
  `export const shadersFromPackage: Promise<Record<string, string>> = m${shaderIndex}.bundleShaders.fromPackage();`,
  `m${shaderIndex}.bundleShaders.fromPackage({ features: 0n });`,
  `export const shadersLoaded: Promise<Record<string, string>> = m${shaderIndex}.loadShaders();`,
  `m${shaderIndex}.loadShaders('https://example.test/shaders/', { include: ['feBlendFrag'] });`,
  `export const fillVertText: string | undefined = m${shaderIndex}.bundleShaders({ fillVert: 'x' }).fillVert;`,
  `export const shaderKeys: Set<string> | null = m${shaderIndex}.shaderKeysFor();`,
  `m${shaderIndex}.shaderFilesFor();`,
  `m${rootIndex}.configureWorkers({ enabled: false });`,
  `export const stoppedPools: number = m${rootIndex}.terminateWorkers();`,
  `m${rootIndex}.configureWorkers({ lb: new URL('https://example.test/lbBuild.worker.js') });`,
  '// @ts-expect-error unknown worker option',
  `m${rootIndex}.configureWorkers({ workers: false });`,
  `declare const anyGl: WebGL2RenderingContext;`,
  `m${rootIndex}.importToBundle(anyGl, '<svg/>');`,
  `declare const textFont: InstanceType<typeof m${fontIndex}.MantleFontAsset>;`,
  `import { buildTextSections } from './types/textBundle';`,
  `buildTextSections(textFont, 'Hello', { fontSizePx: 32 });`,
);
const entryPath = path.join(PKG, '.check-public-types.ts');
writeFileSync(entryPath, `${lines.join('\n')}\n`, 'utf8');

let out = '';
try {
  const r = spawnSync(
    process.execPath,
    [
      tscJs,
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--moduleResolution',
      'bundler',
      '--module',
      'esnext',
      '.check-public-types.ts',
    ],
    { cwd: PKG, encoding: 'utf8' },
  );
  out = (r.stdout || '') + (r.stderr || '');
} finally {
  try {
    unlinkSync(entryPath);
  } catch {
    /* already gone */
  }
}

const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
if (errors.length) {
  console.error(errors.join('\n'));
  console.error(
    `\nPUBLIC-TYPES FAIL — ${errors.length} error(s) across ${subpaths.length} subpath(s).`,
  );
  console.error('These break a strict consumer build even though check:types is green.');
  process.exit(1);
}
console.log(
  `PUBLIC-TYPES PASS — ${subpaths.length} exported subpaths type-check under --strict ` +
    'with skipLibCheck OFF.',
);
