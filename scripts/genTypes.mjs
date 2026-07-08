#!/usr/bin/env node
// genTypes.mjs — emit the public-API TypeScript declarations (.d.ts) from the
// existing JSDoc into ./types, via `tsc -p tsconfig.dts.json`. The output is a
// BUILD ARTIFACT (types/ is gitignored); prepublishOnly runs this so the
// published package carries `"types": "./types/index.d.ts"`.
//
// checkJs is OFF in tsconfig.dts.json — type-CORRECTNESS is gated separately by
// scripts/checkRendererTypes.mjs over src/renderer. This script only EMITS
// declarations, so a stray non-renderer type-noise never blocks the build
// (noEmitOnError:false). Layout-agnostic: resolves tsc through Node from this
// file, so it works hoisted (dev repo) or standalone (published/extracted).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const PROJECT = path.join(PKG, 'tsconfig.dts.json');

let tscJs;
try {
  tscJs = createRequire(import.meta.url).resolve('typescript/bin/tsc');
} catch {
  console.error('gen:types: TypeScript not found. Install it: `npm install -D typescript`.');
  process.exit(2);
}

const r = spawnSync(process.execPath, [tscJs, '-p', PROJECT], { cwd: PKG, encoding: 'utf8' });
// noEmitOnError is false, so declarations emit even if TS reports diagnostics in
// the (ungated) non-renderer JS. Only a HARD failure (config error, no output)
// is fatal here.
const out = (r.stdout || '') + (r.stderr || '');
if (r.status !== 0 && /error TS5\d{3}/.test(out)) {
  // TS5xxx = config/CLI errors (e.g. bad rootDir) — these block emission.
  console.error('gen:types: declaration emit failed:\n' + out.trim());
  process.exit(1);
}
console.log('gen:types: public-API declarations emitted to types/ (types/index.d.ts).');
process.exit(0);
