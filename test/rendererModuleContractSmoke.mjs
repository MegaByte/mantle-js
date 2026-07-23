// Static guard against cross-module wiring bugs introduced when renderer.js's
// single closure scope is split into modules sharing an `R` context object.
// Three bug classes:
//
//   A) a module references a renderer.js-scope helper BARE (not via R.x) — it's
//      undefined in the module's scope → ReferenceError when that path runs
//      (e.g. the morph-filter helper cluster).
//   B) a module declares a local `let/const _x` that SHADOWS an `R._x` it also
//      sets/reads — writes/reads split across the two → silent desync.
//   C) a module calls `R.<x>` where `x` is a module-LOCAL IMPORT never attached
//      to R — the inverse of (A): an imported binding wrongly prefixed with R.
//      → undefined at runtime. Invisible to checkJs because the module's `R`
//      param is typed `any`.
//
// This lint is STATIC (no browser, ~instant), so it can gate CI cheaply where
// the puppeteer render smokes can't. Add new render-module files to MODULES;
// when a cross-ref is intentionally on R, the lint stops flagging it.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/');
const MODULES = ['shaderPrograms', 'drawImages', 'instancedFill', 'morphDraw', 'drawSprites', 'cacheDraw', 'staticCache', 'filterDraw', 'clipDraw', 'bundleHandle', 'maskBake', 'fillPass', 'frameLoop', 'drawDispatch', 'incrementalStroke'];

// Allowlist for cross-refs that are intentionally not-yet-on-R. Keep this
// empty: filter-compositing dependencies (shapeFbo, ensureShapeFbo,
// _compositeFilteredTex, …) are exposed on R via live getters + Object.assign
// in renderer.js, so routes use R.x. A new entry means a new cross-module gap
// is being papered over instead of fixed.
const KNOWN_CROSS_REFS = new Set([]);

const stripCommentsStrings = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

function localNames(src) {
  const s = stripCommentsStrings(src);
  const set = new Set();
  for (const m of s.matchAll(/\b(?:function|const|let|var)\s+(\w+)/g)) set.add(m[1]);
  // function / arrow params (crude but covers the common forms)
  for (const m of s.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/[\s=:{}[\]]/)[0]; if (n) set.add(n); }
  for (const m of s.matchAll(/\(([^)]*)\)\s*=>/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/[\s=:{}[\]]/)[0]; if (n) set.add(n); }
  for (const m of s.matchAll(/(?:^|[^.\w])(\w+)\s*=>/g)) set.add(m[1]);
  for (const m of s.matchAll(/\bcatch\s*\(\s*(\w+)/g)) set.add(m[1]);
  // object-literal method shorthand `name(...) {` (e.g. an image handle's
  // dispose()) — a definition, not a free reference. Keywords (if/for/…) are
  // dropped below by the rfuncs cross-ref (they're never renderer functions).
  for (const m of s.matchAll(/[,{]\s*(\w+)\s*\([^)]*\)\s*\{/g)) set.add(m[1]);
  // destructure bindings
  for (const m of s.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const nm = n.trim().split(':').pop().trim().split('=')[0].trim(); if (nm) set.add(nm); }
  for (const m of s.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) for (const n of m[1].split(',')) { const nm = n.trim().split('=')[0].trim(); if (nm) set.add(nm); }
  for (const m of s.matchAll(/import\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) set.add(n.trim().split(/\s+as\s+/).pop().trim());
  return set;
}

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };

const rsrc = readFileSync(path.join(DIR, 'renderer.js'), 'utf8');
// renderer.js closure functions
const rfuncs = new Set([...stripCommentsStrings(rsrc).matchAll(/\bfunction\s+(\w+)\s*\(/g)].map((m) => m[1]));
// every name attached to R (across renderer + modules)
const allSrc = [rsrc, ...MODULES.map((m) => readFileSync(path.join(DIR, m + '.js'), 'utf8'))].join('\n');
const onR = new Set();
for (const m of allSrc.matchAll(/\bR\.(\w+)\s*=/g)) onR.add(m[1]);
for (const b of allSrc.matchAll(/Object\.assign\(R,\s*\{([\s\S]*?)\}\)/g)) for (const m of b[1].matchAll(/\b(\w+)\b/g)) onR.add(m[1]);

// ── Class A: cross-module bare reference to a renderer.js function not on R ──
let aHits = 0, aKnown = 0;
for (const mod of MODULES) {
  const raw = readFileSync(path.join(DIR, mod + '.js'), 'utf8');
  const s = stripCommentsStrings(raw);
  const local = localNames(raw);
  for (const fn of rfuncs) {
    if (onR.has(fn) || local.has(fn)) continue;
    const c = [...s.matchAll(new RegExp('(?<![.\\w])' + fn + '\\b', 'g'))].length;
    if (c === 0) continue;
    if (KNOWN_CROSS_REFS.has(fn)) { aKnown++; continue; }
    fail(`${mod}.js references renderer.js fn '${fn}' bare (${c}×) — not on R, not local → ReferenceError. Expose it as R.${fn} and call R.${fn}.`);
    aHits++;
  }
}
if (aHits === 0) ok(`Class A (cross-module bare fn refs): none new${aKnown ? ` (${aKnown} known/allowlisted — morph-filter cluster)` : ''}`);

// ── Class B: module-local that shadows an R._x the SAME module sets ──────────
let bHits = 0;
for (const mod of MODULES) {
  const raw = readFileSync(path.join(DIR, mod + '.js'), 'utf8');
  const s = stripCommentsStrings(raw);
  const setOnR = new Set([...s.matchAll(/\bR\.(_\w+)\s*=/g)].map((m) => m[1]));
  for (const nm of setOnR) {
    const localDecl = new RegExp('\\b(?:let|const|var)\\s+' + nm + '\\b').test(s);
    if (localDecl) { fail(`${mod}.js declares local '${nm}' AND sets R.${nm} — shadow desync risk (writes/reads split). Drop the local; use R.${nm} everywhere.`); bHits++; }
  }
}
if (bHits === 0) ok('Class B (local/R.x shadows): none');

// ── Class C: module calls R.<x> where x is a LOCAL IMPORT not attached to R ──
// An imported binding wrongly prefixed with `R.` → undefined at runtime. This
// slips both other guards: it's not a bare ref (Class A), and checkJs sees the
// module's `R` param as `any` so `R.<anything>` type-checks. A local import
// that's ALSO attached to R (e.g. LB_VERT_FLOATS, CacheStrategy) is fine —
// `R.x` resolves; only flag imports NOT on R.
let cHits = 0;
for (const mod of MODULES) {
  const raw = readFileSync(path.join(DIR, mod + '.js'), 'utf8');
  const s = stripCommentsStrings(raw);
  const imports = new Set();
  for (const im of raw.matchAll(/import\s*\{([^}]*)\}/g)) for (const n of im[1].split(',')) { const nm = n.trim().split(/\s+as\s+/).pop().trim(); if (nm) imports.add(nm); }
  for (const nm of imports) {
    if (onR.has(nm)) continue;                       // also on R → R.nm valid
    const c = [...s.matchAll(new RegExp('\\bR\\.' + nm + '\\b', 'g'))].length;
    if (c > 0) { fail(`${mod}.js calls R.${nm} (${c}×) but '${nm}' is a local import NOT on R → undefined at runtime. Call it bare: ${nm}.`); cHits++; }
  }
}
if (cHits === 0) ok('Class C (R.<import> not on R): none');

console.log(failures ? `\nMODULE-CONTRACT FAIL (${failures})` : '\nMODULE-CONTRACT PASS');
process.exit(failures ? 1 : 0);
