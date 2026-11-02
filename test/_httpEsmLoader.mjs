// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _httpEsmLoader.mjs - a node module-customization hook that makes node resolve like a browser with an import map and load over HTTP.
//   module.register('./_httpEsmLoader.mjs', { parentURL, data: { imports: { '@kontek/mantle/svg': 'http://host/src/svg/importer.js', ... } } })
// Bare specifiers in the map resolve to their URL; a relative specifier under an http(s) parent resolves against the parent URL; http(s)
// modules load by fetch. Module identity is the resolved URL, exactly the browser's registry key. Test support only.
let imports = {};
export function initialize(data) {
  imports = (data && data.imports) || {};
}
export async function resolve(specifier, context, next) {
  if (imports[specifier]) return { url: imports[specifier], shortCircuit: true };
  const parent = context.parentURL || '';
  if (/^https?:/.test(parent) && (specifier.startsWith('.') || specifier.startsWith('/')))
    return { url: new URL(specifier, parent).href, shortCircuit: true };
  if (/^https?:/.test(specifier)) return { url: specifier, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (!/^https?:/.test(url)) return next(url, context);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return { format: 'module', source: await r.text(), shortCircuit: true };
}
