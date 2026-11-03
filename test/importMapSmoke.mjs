// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importMapSmoke.mjs - the import map for the unbundled/CDN recipe is complete and honest (node, CPU only).
//
//   - scripts/genImportMap.mjs maps every package.json export (wildcards expanded: all 16 filter primitives, the 4 worker scripts, the
//     raw shader files), each to a file that exists, and `--only` narrows it to named subpaths.
//   - every literal `@kontek/mantle/...` specifier written anywhere in src/ is in the map (so an unbundled page that serves src/ resolves it).
//   - the computed `import('@kontek/mantle/' + pkg)` sites (font/auto, svg/auto via featureManifest) only ever name mapped subpaths.
//   - the map's targets are relative to --base, so one map serves a CDN path or a same-origin folder.
//   - a module's URL is its identity: no two exports name the same file through different non-alias spellings except the declared ones.
import fs from 'node:fs';
import path from 'node:path';
import { buildImportMap } from '../scripts/genImportMap.mjs';
import { PKG, importsOf } from '../scripts/importGraph.mjs';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('ok', name);
  else {
    failures++;
    console.error('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 300));
  }
};

const pj = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const full = buildImportMap({ base: 'https://cdn.example/mantle@1.2.0/' }).imports;
const keys = Object.keys(full);

const nonWild = Object.keys(pj.exports).filter((k) => !k.includes('*') && k !== './package.json');
check(
  `all ${nonWild.length} non-wildcard exports are in the map`,
  nonWild.every((k) => (k === '.' ? full['@kontek/mantle'] : full['@kontek/mantle/' + k.slice(2)])),
);
check(
  'the 16 filter primitives (all + 15) are expanded',
  keys.filter((k) => k.startsWith('@kontek/mantle/filterGraph/primitives/')).length === 16,
  keys.filter((k) => /primitives/.test(k)).length,
);
check(
  'the 4 worker scripts are expanded',
  keys.filter((k) => k.endsWith('.worker.js')).length === 4,
  keys.filter((k) => /worker/.test(k)).join(),
);
check(
  'the raw shader files are expanded (an asset URL per .glsl)',
  keys.filter((k) => k.endsWith('.glsl')).length > 40,
);
const missingFile = keys.filter(
  (k) => !fs.existsSync(path.join(PKG, full[k].replace('https://cdn.example/mantle@1.2.0/', ''))),
);
check(
  `every one of the ${keys.length} targets exists in the package`,
  missingFile.length === 0,
  missingFile.slice(0, 3).join(' '),
);
check(
  'targets are under --base',
  keys.every((k) => full[k].startsWith('https://cdn.example/mantle@1.2.0/src/')),
);
const only = buildImportMap({ base: '/x/', only: ['svg', 'renderer', 'font/text'] }).imports;
check(
  '--only narrows the map to the named subpaths',
  Object.keys(only).sort().join() ===
    '@kontek/mantle/font/text,@kontek/mantle/renderer,@kontek/mantle/svg' &&
    only['@kontek/mantle/svg'] === '/x/src/svg/importer.js',
  Object.keys(only).join(),
);

// Literal specifiers in src.
const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(d, e.name))
        : e.name.endsWith('.js')
          ? [path.join(d, e.name)]
          : [],
    );
const unmapped = [];
for (const f of walk(path.join(PKG, 'src'))) {
  if (f.includes('/generated/')) continue;
  for (const { spec } of importsOf(fs.readFileSync(f, 'utf8')))
    if (spec.startsWith('@kontek/mantle') && !full[spec])
      unmapped.push(`${path.relative(PKG, f)}: ${spec}`);
}
check(
  'every literal @kontek/mantle specifier in src/ is mapped',
  unmapped.length === 0,
  unmapped.slice(0, 3).join('; '),
);

// Computed sites.
const { featuresToModules } = await import('../src/bundle/featureManifest.js');
const { Features } = await import('../src/bundle/featureSet.js');
const fromManifest = featuresToModules(Object.values(Features).reduce((a, b) => a | b, 0n));
check(
  `featureManifest names ${fromManifest.length} subpaths, all mapped`,
  fromManifest.length > 0 && fromManifest.every((m) => full[m]),
  fromManifest.filter((m) => !full[m]).join(),
);
const auto = fs.readFileSync(path.join(PKG, 'src/font/auto.js'), 'utf8');
const pkgs = [...auto.matchAll(/add\([^,]+,\s*'(font\/[^']+)'/g)].map(
  (m) => '@kontek/mantle/' + m[1],
);
check(
  `font/auto names ${pkgs.length} subpaths, all mapped`,
  pkgs.length >= 10 && pkgs.every((m) => full[m]),
  pkgs.filter((m) => !full[m]).join(),
);

// Identity: the module registry is keyed by URL, so two specifiers for one file (the raw `shaders/*` wildcard also names the .js files
// beside the .glsl ones) are the same module, not two. What would split an instance is one specifier resolving to two URLs; a map is a
// function, so that cannot happen. Check the aliases are exactly those wildcard spellings.
const byFile = {};
for (const k of keys) (byFile[full[k]] ||= []).push(k);
const aliases = Object.values(byFile).filter((v) => v.length > 1);
check(
  'the only multi-specifier files are the shaders/*.js wildcard aliases',
  aliases.every((v) => v.some((k) => k.startsWith('@kontek/mantle/shaders/'))),
  aliases.map((v) => v.join(' = ')).join('; '),
);

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('importMapSmoke: PASS');
