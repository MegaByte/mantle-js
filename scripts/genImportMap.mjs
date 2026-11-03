#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// genImportMap.mjs - the <script type="importmap"> that lets a page use the UNBUNDLED package from a CDN or static host.
//
//   node scripts/genImportMap.mjs [--base https://cdn.example/mantle@1.2.0/] [--only svg,renderer,font/text]
//
// Every bare `@kontek/mantle[/sub]` specifier maps to the module file package.json "exports" names, relative to --base (the
// URL the package root is served from, default "/"). Browsers key their module registry by URL, so every page, script and
// game that resolves a subpath through the same map shares one instance of every registry, cache and worker pool; a page
// that loads a second script later gets the same instances, and a feature registered by one script is seen by the other.
// Wildcard exports are expanded (every filter primitive, every worker script, every raw shader file), and the module
// graph itself is relative-imported, so only the entries an app names need to be in the map, but a map with all of them is
// harmless and also serves the computed `import('@kontek/mantle/' + name)` in font/auto.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {{ base?: string, only?: string[] }} [o] @returns {{ imports: Record<string,string> }} */
export function buildImportMap({ base = '/', only } = {}) {
  const pj = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const root = base.endsWith('/') ? base : base + '/';
  const imports = {};
  const pick = (v) => (typeof v === 'string' ? v : v.default);
  for (const [key, val] of Object.entries(pj.exports)) {
    if (key === './package.json') continue;
    const target = pick(val);
    const spec = key === '.' ? '@kontek/mantle' : '@kontek/mantle/' + key.slice(2);
    if (!key.includes('*')) {
      imports[spec] = root + target.replace(/^\.\//, '');
      continue;
    }
    const [pre, post] = key.split('*');
    const [tpre, tpost] = target.split('*');
    const dir = path.join(PKG, tpre.endsWith('/') ? tpre : path.dirname(tpre));
    const base0 = tpre.endsWith('/') ? '' : path.basename(tpre);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.startsWith(base0) || !f.endsWith(tpost)) continue;
      const mid = f.slice(base0.length, f.length - tpost.length);
      if (!mid || mid.includes('/')) continue;
      imports[`@kontek/mantle/${pre.slice(2)}${mid}${post}`] =
        root + (tpre + mid + tpost).replace(/^\.\//, '');
    }
  }
  if (only)
    for (const k of Object.keys(imports))
      if (!only.some((o) => k === '@kontek/mantle/' + o || (o === '.' && k === '@kontek/mantle')))
        delete imports[k];
  return { imports };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => {
    const i = process.argv.indexOf('--' + n);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  console.log(
    JSON.stringify(
      buildImportMap({ base: arg('base'), only: arg('only') ? arg('only').split(',') : undefined }),
      null,
      2,
    ),
  );
}
