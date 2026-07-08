#!/usr/bin/env node
// checkRendererTypes.mjs — renderer-scoped type gate.
//
// Runs `tsc -p tsconfig.checkjs.json` (checkJs over src/renderer) and fails ONLY
// on errors in src/renderer/*. TS follows imports and reports type-noise in
// other JS (font/, fallback/, core/) that isn't yet annotated; this wrapper
// filters to the renderer so the gate goes red the instant a renderer bare-ref /
// missing-prop / JSDoc-mismatch regresses.
//
// LAYOUT-AGNOSTIC: everything is resolved relative to THIS file or via Node's
// module resolution, so it works whether this package sits inside the dev repo
// (typescript hoisted to a parent node_modules) or is published/extracted
// standalone under an arbitrary directory name (typescript in its own
// node_modules). No assumption about the repo root or the package's name.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <pkg>/scripts
const PKG = path.resolve(HERE, '..');                        // <pkg> (this package root)
const PROJECT = path.join(PKG, 'tsconfig.checkjs.json');

// Resolve the tsc CLI through Node from this file's location — walks up
// node_modules wherever typescript actually lives (package or hoisted parent),
// independent of cwd / repo layout. Run it with the current node binary rather
// than the .bin shim (the shim may be absent in some install layouts).
let tscJs;
try {
  tscJs = createRequire(import.meta.url).resolve('typescript/bin/tsc');
} catch {
  console.error('check:types: TypeScript not found. Install it: `npm install -D typescript`.');
  process.exit(2);
}

const r = spawnSync(process.execPath, [tscJs, '-p', PROJECT], { cwd: PKG, encoding: 'utf8' });
const lines = ((r.stdout || '') + (r.stderr || '')).split('\n');
// Match the renderer dir portably (tsc prints POSIX-style relative paths from cwd).
const RENDERER = 'src/renderer/';
const rendererErrors = lines.filter((l) => l.includes(RENDERER) && /error TS\d+/.test(l));

if (rendererErrors.length) {
  console.error('RENDERER TYPE-CHECK FAIL — checkJs errors in src/renderer:\n');
  for (const l of rendererErrors) console.error('  ' + l.trim());
  console.error(`\n${rendererErrors.length} renderer error(s). (Non-renderer type-noise is filtered.)`);
  process.exit(1);
}
console.log('RENDERER TYPE-CHECK PASS — src/renderer is checkJs-clean (bare refs, missing props, JSDoc).');
process.exit(0);
