#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// genSmokeAssets.mjs — derive examples/smoke/*.svg from the smokes themselves.
//
// A smoke's fixture can be declared half a dozen ways: a top-level const, a const inside a
// function, a GENERATOR called with literal args (`const svg = rule => \`<svg …>\``), a
// literal passed straight to importSvg. A regex over the source finds the first kind and
// misses the rest, which leaves many smokes with no asset you can open.
//
// So don't parse it. RUN it. Each smoke's Node-side module scope is pure setup — consts,
// helper functions, a template string for the page — so it can be evaluated in a sandbox
// with the imports stubbed. Anything that comes out as a string containing an <svg> is a
// fixture, whatever shape the source used to build it. Generators are then called with
// every literal-argument call site found in the file.
//
// Run explicitly after fixture changes. Validation compares a temporary derivation
// with the committed examples and does not write to the shared source tree.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { ACCURACY_DIAGNOSTICS } from './accuracyDiagnostics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'test');
const diagnostics = new Set(ACCURACY_DIAGNOSTICS.map((f) => path.basename(f)));
const includeDiagnostics = process.argv.includes('--include-diagnostics');
// MANTLE_SMOKE_ASSETS_DIR: derive into another folder (test/smokeAssetsFreshSmoke.mjs checks the committed copies against a fresh derivation).
const OUT = process.env.MANTLE_SMOKE_ASSETS_DIR
  ? path.resolve(process.env.MANTLE_SMOKE_ASSETS_DIR)
  : path.join(ROOT, 'examples', 'smoke');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// An SVG asset — not an HTML page that merely CONTAINS one. Several smokes build their own
// test page as a string, and those were being written out as fixtures.
const isSvg = (v) =>
  typeof v === 'string' &&
  /<svg[\s>]/.test(v) &&
  /<\/svg>/.test(v) &&
  !/<html[\s>]|<!doctype|<script[\s>]|<body[\s>]/i.test(v);

// A callable, self-returning Proxy. Everything a smoke touches on the browser side
// (puppeteer.launch(...).newPage().goto(...), the http server, page.evaluate) becomes a
// harmless no-op, so the module's Node-side declarations all execute. Cutting the source at
// the first browser call instead lands mid-expression and every file dies with
// "Unexpected end of input".
function deepStub() {
  const f = function () {
    return f;
  };
  return new Proxy(f, {
    get: (t, k) =>
      // A stub must COERCE cleanly. Without this, any `'x' + stub` inside a smoke's own
      // logging throws "Cannot convert object to primitive value" — from a microtask, after
      // the scan is done, so it escapes the try/catch entirely.
      k === Symbol.toPrimitive
        ? () => ''
        : k === 'toString' || k === 'valueOf'
          ? () => ''
          : k === 'then'
            ? undefined
            : k === Symbol.iterator
              ? function* () {}
              : deepStub(),
    apply: () => deepStub(),
    construct: () => deepStub(),
  });
}

function evalScope(src, file) {
  // Strip imports/exports and top-level awaits — we only want the pure declarations.
  let body = src
    .replace(/^\s*import\s[^\n]*\n/gm, '')
    .replace(/^\s*export\s+/gm, '')
    .replace(/^\s*await\s[^\n]*\n/gm, '')
    .replace(/\bawait\s+/g, '')
    // import.meta has no meaning in a vm script.
    .replace(/import\.meta\.url/g, "'file:///x/y.mjs'")
    // TOP-LEVEL const/let -> var. In a vm script const and let are block-scoped and never
    // land on the sandbox object, so the whole scope would come back empty and this would find nothing.
    // var does bind to the context global. Only column 0, so declarations inside functions
    // keep their own scoping.
    .replace(/^const\s/gm, 'var ')
    .replace(/^let\s/gm, 'var ');
  const sandbox = new Proxy(
    {
      console: { log() {}, warn() {}, error() {} },
      Math,
      JSON,
      String,
      Number,
      Array,
      Object,
      Boolean,
      RegExp,
      Error,
      Set,
      Map,
      Promise,
      parseInt,
      parseFloat,
      isFinite,
      isNaN,
      encodeURIComponent,
      decodeURIComponent,
      readFileSync: (p) => {
        try {
          return readFileSync(String(p).replace('file://', ''));
        } catch {
          return '';
        }
      },
      process: { env: {}, argv: [], exit() {} },
      URL,
      TextEncoder,
      Uint8Array,
      Uint32Array,
      Float32Array,
      Int32Array,
      ArrayBuffer,
      setTimeout: () => 0,
      clearTimeout: () => {},
      path,
      fileURLToPath: (u) => String(u).replace('file://', ''),
    },
    {
      // Anything else the module reaches for — puppeteer, http, page, browser — is a stub.
      has: () => true,
      get: (t, k) => (k in t ? t[k] : deepStub()),
    },
  );
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(body, ctx, { timeout: 3000 });
  } catch (e) {
    if (process.env.DEBUG_GEN) console.error('  [scope]', file, '->', String(e).slice(0, 90));
  }
  return { ctx, sandbox, body };
}

const manifest = [];
const seen = new Map(); // sha-ish (content) -> filename

function emit(base, name, svg, smoke) {
  let out = String(svg).trim();
  if (!out.startsWith('<?xml')) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
  out += '\n';
  const key = out;
  if (seen.has(key)) return;
  let file = `${base}__${name}.svg`;
  let i = 2;
  while (manifest.some((e) => e.file === file)) file = `${base}__${name}${i++}.svg`;
  seen.set(key, file);
  const full = path.join(OUT, file);
  if (!existsSync(full) || readFileSync(full, 'utf8') !== out) writeFileSync(full, out);
  manifest.push({ file, smoke, const: name });
}

let scanned = 0,
  produced = 0;
for (const f of readdirSync(TESTS)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
  .sort()) {
  // Shader-model diagnostics belong to explicit development runs. Their existing
  // examples stay in the manifest without executing their emulated raster loops.
  if (!includeDiagnostics && diagnostics.has(f)) continue;
  const src = readFileSync(path.join(TESTS, f), 'utf8');
  if (!/<svg[\s>]/.test(src)) continue;
  scanned++;
  const base = f.replace(/Smoke\.mjs$|\.mjs$/, '');
  const before = manifest.length;
  const { sandbox, body } = evalScope(src, f);

  // 1. every binding that came out as an SVG string
  for (const [k, v] of Object.entries(sandbox)) {
    if (isSvg(v)) emit(base, k, v, f);
  }
  // 2. GENERATORS: any binding that is a function, called with the literal args the file
  //    actually uses. `const svg = rule => \`<svg …>\`` is invisible until you call it.
  for (const [k, v] of Object.entries(sandbox)) {
    if (typeof v !== 'function') continue;
    const calls = new Set();
    const re = new RegExp(`\\b${k}\\s*\\(([^()]*)\\)`, 'g');
    let m;
    while ((m = re.exec(src))) calls.add(m[1].trim());
    for (const argsrc of calls) {
      try {
        const args =
          argsrc === ''
            ? []
            : vm.runInContext(`[${argsrc}]`, vm.createContext({ ...sandbox }), { timeout: 500 });
        const r = v(...args);
        if (isSvg(r)) {
          const tag = argsrc
            ? argsrc
                .replace(/[^A-Za-z0-9]+/g, '_')
                .replace(/^_|_$/g, '')
                .slice(0, 24)
            : k;
          emit(base, `${k}_${tag}`.replace(/_+$/, ''), r, f);
        }
      } catch {
        /* args we can't evaluate — skip that call site */
      }
    }
  }
  if (manifest.length > before) produced++;
}

// The manifest is the DIRECTORY, enriched by whatever the scan learned.
//
// Three kinds of file live here and only one of them is derivable from the sources:
//   - SOURCE: a smoke readFileSync's it (the static fixtures) — invisible to the scanner,
//     because the source does not contain the SVG.
//   - GENERATED: a smoke builds it at runtime and emitFixture writes it.
//   - DERIVED: the scanner pulled it out of an inline literal, above.
// Listing the directory covers all three; listing only what the scan produced would silently
// unlist every static and generated fixture still in use.
const known = new Map(manifest.map((e) => [e.file, e]));
const prev = (() => {
  try {
    return new Map(
      JSON.parse(readFileSync(path.join(OUT, 'index.json'), 'utf8')).map((e) => [e.file, e]),
    );
  } catch {
    return new Map();
  }
})();
manifest.length = 0;
for (const file of readdirSync(OUT)
  .filter((f) => f.endsWith('.svg'))
  .sort()) {
  const discovered = known.get(file);
  const previous = prev.get(file);
  if (discovered || previous) {
    // Preserve runtime-fixture metadata such as `generated: true` when the
    // static scanner also discovers the same SVG.
    manifest.push({ ...previous, ...discovered, file });
    continue;
  }
  const [base, konst] = file.replace(/\.svg$/, '').split('__');
  manifest.push({ file, smoke: `${base}Smoke.mjs`, const: konst || base });
}
manifest.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(
  `genSmokeAssets: ${manifest.length} assets from ${produced}/${scanned} SVG-bearing smokes`,
);
// Stubbed browser code can leave pending microtasks; the scan is done, so don't let one of
// them fail the script.
process.exit(0);
