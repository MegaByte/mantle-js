// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// readmeTypesSmoke.mjs - every documented sample type-checks against the PUBLISHED declarations.
//
// readmeSamplesSmoke runs the README's JavaScript samples; this compiles them under `strict` the way a TypeScript
// consumer would: `@kontek/mantle` and every `@kontek/mantle/<subpath>` resolve to the generated types/ through the
// package's own `exports`. A documented call the declarations reject (a parameter the runtime treats as optional but
// the .d.ts requires, a result typed `{}`, a named import that does not exist) fails here.
//
// Samples are fragments: names they use without declaring (canvas, svgText, gl, ...) are declared `any`, so
// only genuine API mismatches remain. A sample that does not parse is reported and not counted.
// Needs types/ (npm run gen:types); generates it when absent. GL-free.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(PKG, 'types/index.d.ts'))) {
  const r = spawnSync(process.execPath, [path.join(PKG, 'scripts/genTypes.mjs')], {
    cwd: PKG,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('FAIL gen:types');
    process.exit(1);
  }
}
const ts = createRequire(import.meta.url)('typescript');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

// Documents to check; the repo-root docs are absent from a standalone package and are skipped there.
const DOCS = [
  'README.md',
  'docs/NATIVE_FALLBACK.md',
  '../README.md',
  '../STRIPPING.md',
  '../FEATURES.md',
  '../SPRITE_SHEET.md',
]
  .map((f) => path.join(PKG, f))
  .filter((f) => existsSync(f));

const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const paths = {};
for (const [name, entry] of Object.entries(pkg.exports)) {
  if (!entry || typeof entry !== 'object' || !entry.types) continue;
  const spec = '@kontek/mantle' + name.slice(1);
  paths[spec] = [path.join(PKG, entry.types)];
}
paths['@kontek/mantle/filterGraph/primitives/*'] = [
  path.join(PKG, 'types/filterGraph/primitives/*.d.ts'),
];

const SYNTAX = new Set([
  1002, 1003, 1005, 1009, 1011, 1068, 1109, 1128, 1131, 1136, 1138, 1160, 1161, 1434, 1435, 1472,
  1477, 1478,
]);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mantle-readme-types-'));
let checked = 0,
  skipped = 0,
  errors = 0;
try {
  const files = [];
  for (const doc of DOCS) {
    const md = readFileSync(doc, 'utf8');
    const re = /```(js|javascript|ts|typescript)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(md))) {
      if (!/from '@kontek\/mantle/.test(m[2])) continue; // a fragment with no import has nothing to resolve
      const line = md.slice(0, m.index).split('\n').length;
      const tag = `${path.basename(doc)}:${line}`;
      const code = m[2].replace(/^\s*\.\.\.\s*$/gm, '').replace(/^\s*\/\/\s*\.\.\.\s*$/gm, '');
      files.push({ tag, code, file: path.join(tmp, `s${files.length}.ts`) });
    }
  }
  const options = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    skipLibCheck: true,
    paths,
  };
  const host = ts.createCompilerHost(options);
  const diag = (list) => {
    const texts = new Map(list.map((f) => [f.file, f.text]));
    const origRead = host.readFile.bind(host),
      origExists = host.fileExists.bind(host),
      origGet = host.getSourceFile.bind(host);
    host.readFile = (f) => (texts.has(f) ? texts.get(f) : origRead(f));
    host.fileExists = (f) => texts.has(f) || origExists(f);
    host.getSourceFile = (f, lang, ...r) =>
      texts.has(f) ? ts.createSourceFile(f, texts.get(f), lang) : origGet(f, lang, ...r);
    const prog = ts.createProgram(
      list.map((f) => f.file),
      options,
      host,
    );
    return list.map((f) => ({
      f,
      d: ts
        .getPreEmitDiagnostics(prog, prog.getSourceFile(f.file))
        .filter((x) => x.category === ts.DiagnosticCategory.Error),
    }));
  };
  // Pass 1: find undeclared names; declare them `any` so only API mismatches are left.
  const prelude = 'export {};\n';
  let list = files.map((f) => ({ ...f, text: prelude + f.code }));
  for (const round of [1, 2]) {
    const res = diag(list);
    list = res.map(({ f, d }) => {
      const missing = new Set();
      for (const x of d) {
        if (x.code === 2304 || x.code === 2552 || x.code === 18004) {
          const msg = ts.flattenDiagnosticMessageText(x.messageText, '\n');
          const nm = /Cannot find name '([^']+)'|shorthand property '([^']+)'/.exec(msg);
          if (nm) missing.add(nm[1] || nm[2]);
        }
      }
      const decl = [...missing].map((n) => `declare var ${n}: any;`).join('\n');
      return {
        ...f,
        text: prelude + (f.decl ? f.decl + '\n' : '') + decl + (decl ? '\n' : '') + f.code,
        decl: (f.decl ? f.decl + '\n' : '') + decl,
      };
    });
  }
  for (const { f, d } of diag(list)) {
    if (d.some((x) => SYNTAX.has(x.code))) {
      skipped++;
      console.log(`INFO ${f.tag} does not parse as TypeScript, not checked`);
      continue;
    }
    checked++;
    for (const x of d) {
      errors++;
      if (!x.file) {
        fail(
          `${f.tag} TS${x.code}: ${ts.flattenDiagnosticMessageText(x.messageText, '\n').slice(0, 200)}`,
        );
        continue;
      }
      const where = x.file.getLineAndCharacterOfPosition(x.start);
      const srcLine = f.text.split('\n')[where.line].trim().slice(0, 100);
      fail(
        `${f.tag} TS${x.code}: ${ts.flattenDiagnosticMessageText(x.messageText, '\n').split('\n')[0].slice(0, 160)}   | ${srcLine}`,
      );
    }
  }
  // a standalone package has only its own docs (11 samples); the monorepo adds the repository-root docs
  checked >= (existsSync(path.join(PKG, '../README.md')) ? 12 : 8)
    ? ok(
        `${checked} documented samples type-check against the declarations (${skipped} unparsed fragments, ${errors} errors)`,
      )
    : fail(`only ${checked} samples were checked; the extraction is broken`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('readmeTypesSmoke: PASS');
