// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// tarballContentsSmoke.mjs - what `npm pack` ships.
//
// Packs the package (prepack runs, as in a publish) and checks the file list against a must-have list (every file an
// `exports` target or the docs point at, types/, the bundled shader modules, the license and notice files) and a
// must-not-have list (tests, probes, scripts, examples, research, source .glsl duplicates, anything under docs/internal).
// Then it reads every shipped text file and fails on a private doc path, a private ledger row id, or an absolute
// home-directory path. Needs `npm` on PATH; no network.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packPackage, packageJson } from './_packagePack.mjs';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const { dest, tgz, files, size, unpackedSize } = packPackage();
const set = new Set(files);
console.log(
  `packed ${files.length} files, ${(size / 1024).toFixed(0)} KB tgz, ${(unpackedSize / 1024).toFixed(0)} KB unpacked`,
);

const pkg = packageJson();
const must = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'CHANGELOG.md',
  'docs/NATIVE_FALLBACK.md',
  'types/index.d.ts',
  'src/index.js',
  'src/shaders/index.js',
  'src/shaders/bundled.js',
  'src/shaders/bundledSources.js',
  'src/shaders/generated/mantle.frag.glsl',
  'src/shaders/generated/mantle.vert.glsl',
  'src/core/nodeBuiltin.js',
  'src/renderer/lbBuild.worker.js',
  'src/renderer/cpatch.worker.js',
  'src/renderer/occlusion.worker.js',
  'src/renderer/occupancy.worker.js',
]);
const walk = (v) =>
  typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : [];
for (const [name, target] of Object.entries(pkg.exports)) {
  for (const t of walk(target)) {
    if (t.includes('*')) continue;
    must.add(t.replace(/^\.\//, ''));
  }
}
const missing = [...must].filter((f) => !set.has(f));
missing.length === 0
  ? ok(`all ${must.size} must-have files are present`)
  : fail('missing from the tarball: ' + missing.slice(0, 12).join(', '));

const NOT = [
  [/^test\//, 'tests'],
  [/^probes\//, 'probes'],
  [/^scripts\//, 'build scripts'],
  [/^examples\//, 'examples'],
  [/^research\//, 'research'],
  [/^docs\/internal\//, 'private docs'],
  [/^src\/shaders\/[^/]+\.glsl$/, 'source .glsl (marker-bearing duplicates of generated/)'],
  [/\.map$/, 'source maps'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/^tsconfig/, 'tsconfig'],
  [/mantleDemo\.html$/, 'the demo page'],
  [/^\./, 'dot files'],
  [/package-lock\.json$/, 'a lockfile'],
];
const bad = files.filter((f) => NOT.some(([re]) => re.test(f)));
bad.length === 0
  ? ok('no test, probe, script, example, research, private-doc or source-.glsl file is shipped')
  : fail('must-not-have files shipped: ' + bad.slice(0, 10).join(', '));

// Every file must come from the allow-list shapes in `files` (guards a stray new top-level file).
const TOP = new Set(['package.json', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md']);
const strays = files.filter((f) => !f.includes('/') && !TOP.has(f));
strays.length === 0
  ? ok('no unexpected top-level file')
  : fail('unexpected top-level files: ' + strays.join(', '));

// Read every shipped text file.
const dir = mkdtempSync(path.join(os.tmpdir(), 'mantle-untar-'));
try {
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  const root = path.join(dir, 'package');
  const TEXT = /\.(js|mjs|ts|md|json|glsl|txt)$|(^|\/)(LICENSE|NOTICE)$/;
  const PRIVATE = [
    [/docs\/internal/, 'docs/internal'],
    [/research\/(?:js|unity)-release/, 'an internal research path'],
    [/\b(?:AP|PK|REL|REV|BEN)\d{1,3}\b/, 'a ledger row id'],
    [/\/Users\/[a-z]/i, 'a home-directory path'],
    [/MANTLE_(?:BUG|API|QUESTION)_/, 'an internal tracker id'],
  ];
  // Internal codenames are matched by the SHA-256 of each lowercased word piece, so this public test does not spell them.
  const CODENAMES = new Set(['101e7df3b885c6a301d9a87c5c66663b7491cab90251b4b5dd3dca3d09c190f8']);
  const codename = (text) => {
    for (const w of new Set(text.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) || []))
      if (CODENAMES.has(createHash('sha256').update(w.toLowerCase()).digest('hex'))) return w;
    return null;
  };
  let scanned = 0;
  const hits = [];
  (function walkDir(d) {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) {
        walkDir(p);
        continue;
      }
      const rel = path.relative(root, p);
      if (!TEXT.test(rel)) continue;
      scanned++;
      const text = readFileSync(p, 'utf8');
      for (const [re, what] of PRIVATE) {
        const m = re.exec(text);
        if (m)
          hits.push(
            `${rel}: ${what} ("${text.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' ')}")`,
          );
      }
      if (codename(text)) hits.push(`${rel}: an internal codename`);
    }
  })(root);
  hits.length === 0
    ? ok(
        `${scanned} shipped text files carry no private path, ledger id, codename or home-directory path`,
      )
    : fail(`${hits.length} private reference(s) shipped:\n  ` + hits.slice(0, 12).join('\n  '));

  // NOTICE must name files that exist in this tarball or are explicitly the source repository's.
  const notice = readFileSync(path.join(root, 'NOTICE'), 'utf8');
  const cited = [...notice.matchAll(/\b(src\/[\w./-]+\.(?:js|glsl))/g)].map((m) => m[1]);
  const gone = cited.filter(
    (c) =>
      !set.has(c) &&
      !/source repository/i.test(notice.slice(notice.indexOf(c) - 140, notice.indexOf(c) + 140)),
  );
  gone.length === 0
    ? ok(`NOTICE cites ${cited.length} paths, each shipped or marked as source-repository-only`)
    : fail('NOTICE cites paths not in the tarball: ' + gone.join(', '));

  // The Unicode version in NOTICE must be the version the generated tables say.
  const ucd = /Unicode (\d+\.\d+\.\d+)/.exec(notice);
  const tbl = /from Unicode (\d+\.\d+\.\d+)/.exec(
    readFileSync(path.join(root, 'src/font/unicode/tables/bidiClass.js'), 'utf8'),
  );
  ucd && tbl && ucd[1] === tbl[1]
    ? ok(`NOTICE and the generated tables agree on Unicode ${ucd[1]}`)
    : fail(`NOTICE says Unicode ${ucd && ucd[1]}, the tables say ${tbl && tbl[1]}`);
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const rv = [...readme.matchAll(/UCD-(\d+\.\d+)/g)].map((m) => m[1]);
  rv.every((v) => tbl && tbl[1].startsWith(v + '.'))
    ? ok('README names the same UCD version')
    : fail(`README names UCD ${rv.join(',')}, tables say ${tbl && tbl[1]}`);

  // package.json fields a published package needs.
  const pj = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  pj.publishConfig && pj.publishConfig.access === 'public'
    ? ok('publishConfig.access is public')
    : fail('publishConfig.access is not public');
  pj.exports['./package.json']
    ? ok('./package.json is exported')
    : fail('./package.json is not exported');
  pj.bugs && pj.bugs.url ? ok('bugs.url is set') : fail('bugs.url missing');
  pj.types === './types/index.d.ts' && set.has('types/index.d.ts')
    ? ok('types/ ships with the tarball (prepack generated it)')
    : fail('types missing');
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('tarballContentsSmoke: PASS');
