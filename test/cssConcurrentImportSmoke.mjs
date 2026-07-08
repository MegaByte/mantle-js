// cssConcurrentImportSmoke.mjs — <style> class fills survive CONCURRENT
// imports (many SVGs in one Promise.all).
//
// importSvg awaits mid-walk, so concurrent imports interleave. The
// active stylesheet is therefore keyed on the parsed Document (each
// element resolves ITS OWN document's sheet) rather than a module-global
// slot, which a second import would otherwise clobber while the first is
// suspended at an await. Asserts (1) the mechanism directly — two live
// docs resolve independently — and (2) the end-to-end Promise.all batch
// yields correct fills.

import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import {
  buildStylesheet, setActiveStylesheet, lookupCssProp, clearActiveStylesheet,
} from '../src/svg/stylesheet.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };

const meta = (r) => r.metaFloats || new Float32Array(r.meta, 32);
const hex = (r, i) => { const m = meta(r), o = i * 48;
  return '#' + [m[o + 4], m[o + 5], m[o + 6]].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); };

// --- (1) Mechanism: two documents "active" at once resolve independently.
// A module-global sheet would let the second setActiveStylesheet clobber
// the first, making rectA resolve B's (empty) sheet → null.
const docA = new DP().parseFromString(
  '<svg xmlns="http://www.w3.org/2000/svg"><style>.cls-1{fill:#103a49}</style><rect class="cls-1"/></svg>', 'image/svg+xml');
const docB = new DP().parseFromString(
  '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000"/></svg>', 'image/svg+xml');
const rootA = docA.documentElement, rootB = docB.documentElement;
setActiveStylesheet(rootA, buildStylesheet(rootA));
setActiveStylesheet(rootB, buildStylesheet(rootB)); // empty sheet; would clobber A's global
const rectA = rootA.getElementsByTagName('rect')[0];
const fillA = lookupCssProp(rectA, 'fill');
const fillAValue = fillA && typeof fillA === 'object' ? fillA.value : fillA;
if (fillAValue === '#103a49')
  ok('two live documents resolve their own sheet (no global clobber)');
else fail('rectA fill resolved to ' + JSON.stringify(fillA) + ' — global clobber');
clearActiveStylesheet(rootA); clearActiveStylesheet(rootB);

// --- (2) End-to-end: a batch of imports run together via Promise.all,
// alternating <style> class fills and plain inline fills. Every one must
// keep its own fill.
const classSvg = (color) =>
  `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><defs><style>.cls-1{fill:${color};}</style></defs><rect class="cls-1" width="10" height="10"/></svg>`;
const inlineSvg = (color) =>
  `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect fill="${color}" width="10" height="10"/></svg>`;

// 24 SVGs: even = class-based teal/maroon, odd = inline green (empty sheet).
const palette = ['#103a49', '#0b5669', '#024c60', '#e5e5e5'];
const jobs = [];
const expected = [];
for (let i = 0; i < 24; i++) {
  if (i % 2 === 0) { const c = palette[(i / 2) % palette.length]; jobs.push(classSvg(c)); expected.push(c); }
  else { jobs.push(inlineSvg('#00ff00')); expected.push('#00ff00'); }
}
const results = await Promise.all(jobs.map((svg) => importSvg(svg, {})));
let bad = 0;
results.forEach((r, i) => { const got = hex(r, 0); if (got !== expected[i]) { bad++; if (bad <= 4) console.error(`  job ${i}: got ${got}, expected ${expected[i]}`); } });
if (bad === 0) ok(`24 concurrent imports (class + inline interleaved) all keep their fill`);
else fail(`${bad}/24 concurrent imports lost their fill (stylesheet clobber)`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nCSS-CONCURRENT-IMPORT PASS');
process.exit(failures ? 1 : 0);
