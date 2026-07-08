// shaderGeneratedFreshSmoke.mjs — the committed generated/*.glsl files must be
// UP TO DATE with the source .glsl. Re-assembles every shader from source
// in-memory (assembleShader = preprocess + tidy, the same the build uses) and
// asserts each committed generated/<file>.glsl byte-matches. Fails if someone
// edited a source .glsl without rerunning `npm run build:shaders`. Node-only.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SHADER_FILENAMES, HELPER_FILENAMES, assembleShader,
} from '../src/shaders/index.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/shaders');
const GEN = path.join(DIR, 'generated');
const read = (f) => readFileSync(path.join(DIR, f), 'utf8');

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const helpers = {};
for (const [marker, file] of HELPER_FILENAMES) helpers[marker] = read(file);

let checked = 0, drift = 0, missing = 0;
for (const [, file] of SHADER_FILENAMES) {
  let raw;
  try { raw = read(file); } catch { continue; }   // optional shader absent
  const fresh = assembleShader(raw, helpers);      // unminified (build default)
  const genPath = path.join(GEN, file);
  if (!existsSync(genPath)) { missing++; if (missing <= 3) console.error(`  missing: generated/${file}`); continue; }
  checked++;
  if (readFileSync(genPath, 'utf8') !== fresh) {
    drift++;
    if (drift <= 3) console.error(`  stale: generated/${file}`);
  }
}

if (missing === 0) ok(`every source shader has a generated/*.glsl (${checked} files)`);
else fail(`${missing} shader(s) missing from generated/ — run: npm run build:shaders`);

if (drift === 0) ok('every committed generated/*.glsl byte-matches a fresh assemble of its source');
else fail(`${drift} generated file(s) stale — run: npm run build:shaders`);

// The generated files must be VALID standalone GLSL (no leftover @@markers@@),
// which is the whole point — so downstream GLSL tooling can process them.
let markerLeft = 0;
for (const [, file] of SHADER_FILENAMES) {
  const genPath = path.join(GEN, file);
  if (existsSync(genPath) && /@@[A-Z_]+@@/.test(readFileSync(genPath, 'utf8'))) markerLeft++;
}
if (markerLeft === 0) ok('no generated file has an unspliced @@marker@@ (valid standalone GLSL)');
else fail(`${markerLeft} generated file(s) still contain @@markers@@`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nSHADER-GENERATED-FRESH PASS');
process.exit(failures ? 1 : 0);
