#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// bakeCPatch.mjs — produce a CPatch BAKE for an SVG: the converter's decision trace per contour
// and the graph front end's cut parameters per shape, in the byte form cpatchTrace.js defines.
//
//   node scripts/bakeCPatch.mjs asset.svg              -> asset.svg.cpt
//   node scripts/bakeCPatch.mjs asset.svg -o out.cpt
//   node scripts/bakeCPatch.mjs asset.svg --max-curves 8 --tol 0.05 --interior 8
//
// These bytes record legacy decomposition decisions, keyed by geometry and
// conversion settings. Pass them through createBundle's cpatchBake option or
// setCPatchBake. Legacy builds replay matching entries and convert cache misses.
// The prepared whole-paint renderer does not replay decomposition traces; an
// explicit trace request declines that representation to the selected raw cover.
// Use matching cpatchOpts for legacy baking and replay.
import { readFileSync, writeFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, bakeCPatchBundle } = await import('../src/renderer/cpatchBuild.js');

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log(
    'usage: node scripts/bakeCPatch.mjs <asset.svg> [-o out.cpt] [--max-curves N] [--tol PX] [--interior N] [--quiet]',
  );
  process.exit(args.length ? 0 : 1);
}
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const file = args.find(
  (a) =>
    !a.startsWith('-') &&
    !['-o', '--max-curves', '--tol', '--interior'].includes(args[args.indexOf(a) - 1]),
);
const out = flag('-o', file + '.cpt');
const opts = { maxCurves: +flag('--max-curves', 8), tolPx: +flag('--tol', 0.05) };
const interior = flag('--interior', null);
if (interior != null) opts.interiorN = +interior;

const svg = readFileSync(file, 'utf8');
const t0 = performance.now();
const sections = await importSvg(svg);
const t1 = performance.now();
const bundle = headlessCPatchBundle(sections);
const bytes = bakeCPatchBundle(bundle, opts);
const t2 = performance.now();
writeFileSync(out, bytes);
if (!args.includes('--quiet')) {
  console.log(
    `${out}: ${bytes.length} bytes, ${bytes.entries} entries for ${bytes.shapes} shapes (${bytes.skipped} primitives skipped); import ${(t1 - t0).toFixed(0)}ms, bake ${(t2 - t1).toFixed(0)}ms`,
  );
}
