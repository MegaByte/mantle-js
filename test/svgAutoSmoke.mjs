// svgAutoSmoke.mjs — svg/auto (autoRegisterForSvg) is the SVG peer of
// font/auto: inspect an SVG, dynamic-import + register exactly the filter /
// COLR handlers it uses, leave the rest unregistered. Verifies the reported
// `registered` list AND that the handlers actually land in the dispatch
// registry (hasSvgFilter), and that a plain SVG registers nothing.
import { DOMParser } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;
import { autoRegisterForSvg } from '../src/svg/auto.js';
import { hasSvgFilter } from '../src/filterGraph/dispatchRegistry.js';

let failures = 0;
const fail = (m) => { console.error('FAIL', m); failures++; };
const ok = (m) => console.log('ok', m);
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

// ---- T1: a plain (no-filter) SVG registers nothing ----
{
  const { registered } = await autoRegisterForSvg(svg('<rect width="100" height="100" fill="red"/>'));
  if (registered.length === 0) ok('T1 plain SVG → no optional handlers registered');
  else fail(`T1 plain SVG should register nothing, got ${JSON.stringify(registered)}`);
}

// ---- T2: feGaussianBlur → only the blur primitive ----
{
  const { registered } = await autoRegisterForSvg(svg(
    '<defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter></defs>' +
    '<rect width="100" height="100" filter="url(#b)"/>'));
  if (!registered.includes('filterGraph/primitives/blur')) fail(`T2 blur SVG should register blur, got ${JSON.stringify(registered)}`);
  else if (!hasSvgFilter('feGaussianBlur')) fail('T2 feGaussianBlur handler not in the dispatch registry after auto');
  else ok(`T2 feGaussianBlur → registered ${JSON.stringify(registered)} + handler live`);
}

// ---- T3: drop-shadow pulls the synthesis primitive set (blur+offset+flood+composite+merge) ----
{
  const { registered } = await autoRegisterForSvg(svg(
    '<defs><filter id="d"><feDropShadow dx="2" dy="2" stdDeviation="2"/></filter></defs>' +
    '<rect width="100" height="100" filter="url(#d)"/>'));
  const want = ['feOffset', 'feFlood', 'feComposite', 'feMerge'];
  const missing = want.filter((t) => !hasSvgFilter(t));
  if (missing.length) fail(`T3 drop-shadow should make ${want} live; missing ${missing}`);
  else ok(`T3 feDropShadow → synthesis primitives live (${registered.length} modules)`);
}

// ---- T4: accepts an already-imported bundle (no re-parse) ----
{
  const importSvg = (await import('../src/svg/importer.js')).default;
  const bundle = await importSvg(svg('<rect width="100" height="100" fill="blue"/>'), { bundleForm: false });
  const r = await autoRegisterForSvg(bundle);
  if (r.bundle === bundle && Array.isArray(r.registered)) ok('T4 accepts a pre-imported bundle (returns it, no re-parse)');
  else fail('T4 bundle passthrough failed');
}

console.log(failures ? `\nSVG-AUTO FAIL (${failures})` : '\nSVG-AUTO PASS');
process.exit(failures ? 1 : 0);
