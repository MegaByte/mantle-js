// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Why does the CPatch BUILD produce no shapes for an asset the converter handles?
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { headlessCPatchBundle, bakeCPatchBundle } from '../src/renderer/cpatchBuild.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const b = headlessCPatchBundle(sections);
console.log('bundle shapes:', b.numShapes, 'ranges:', (b.curveRangesByShape || []).length);
const r = bakeCPatchBundle(b, { pool: false });
console.log(
  'bake -> shapes',
  r && r.shapes,
  'skipped',
  JSON.stringify(r && r.skipped),
  'entries',
  r && r.entries && r.entries.length,
);
console.log(
  '_cpatchBuilt:',
  b._cpatchBuilt,
  ' _cpatchBail:',
  b._cpatchBail,
  ' _cpatchRules:',
  JSON.stringify(b._cpatchRules),
);
