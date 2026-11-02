// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillDefinesGateSmoke — createRenderer's `fillDefines` is a test hook, honored only under __MANTLE_DEBUG__.
//
// The option compiles arbitrary defines into every fill program: a kernel no default draw runs, an omission that
// paints wrong when the content has the feature, an experimental arm. Like the `__MANTLE_FILL_DEFINES` global it takes
// effect only while `globalThis.__MANTLE_DEBUG__ === true`; otherwise createRenderer warns ONCE per page and drops
// it. Checked on the real renderer over test/_fakeGl.mjs (no GPU), by the program a draw binds:
//   (a) without debug: MANTLE_HARD passed through fillDefines is absent from the bound program, and the warning is
//       said once for two renderers;
//   (b) with debug: the same option is in the bound program;
//   (c) `aacFill: true`, which the renderer itself bakes into the field, still binds MANTLE_AAC without debug;
//   (d) an empty list is not a use of the hook: no warning.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const warnings = [];
const warn = console.warn;
console.warn = (...a) => {
  const m = a.map(String).join(' ');
  if (/fillDefines/.test(m)) warnings.push(m);
};

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 20 L50 90 Z" fill="#48c"/></svg>';
const sec = await importSvg(SVG);
async function boundDefs(opts, kernel = 'slug') {
  const F = createFakeGl({ width: 128, height: 128 });
  // aacPoints:false: a small draw takes the vertex-stage point route, which binds no fill variant; this test is about the fill program
  const R = createRenderer(F.gl, taggedShaderSources(), { ...opts, aacPoints: false });
  R.setFillEngine({ route: 'none', kernel });
  const b = createBundle(F.gl, sec);
  R.setViewport(128, 128);
  R.prewarmBundle(b);
  // the BASE program draws until a variant warms; either one carries the renderer's fillDefines
  let key = null;
  for (let i = 0; i < 8; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    R.precompileFills();
    key = R.debugStats.drawnFillVariantKey;
    if (i >= 2 && key) break;
  }
  const defs = new Set(String(key || '').split('|'));
  try {
    R.dispose();
  } catch {
    /* headless */
  }
  return defs;
}

// (a)
delete globalThis.__MANTLE_DEBUG__;
const off1 = await boundDefs({ fillDefines: ['MANTLE_HARD', 'MANTLE_GWN'] });
const off2 = await boundDefs({ fillDefines: ['MANTLE_HARD', 'MANTLE_GWN'] });
ok(
  !off1.has('MANTLE_HARD') && !off2.has('MANTLE_HARD'),
  '(a) without __MANTLE_DEBUG__, fillDefines does not reach the bound program',
);
ok(
  warnings.length === 1,
  `(a) ...and createRenderer says so once for two renderers (${warnings.length} warning(s))`,
);
// (b)
globalThis.__MANTLE_DEBUG__ = true;
const on = await boundDefs({ fillDefines: ['MANTLE_HARD', 'MANTLE_GWN'] });
delete globalThis.__MANTLE_DEBUG__;
ok(
  on.has('MANTLE_HARD') && on.has('MANTLE_GWN'),
  `(b) with __MANTLE_DEBUG__ it does (bound: ${[...on].filter((d) => /HARD|GWN/.test(d)).join('+') || 'none'})`,
);
// (c)
const aac = await boundDefs({ aacFill: true }, 'aac');
ok(aac.has('MANTLE_AAC'), '(c) AAC selection compiles MANTLE_AAC without debug');
const switched = await boundDefs({ aacFill: true }, 'slug');
ok(!switched.has('MANTLE_AAC'), '(c) switching from initial AAC selects a Slug program');
// (d)
const n0 = warnings.length;
await boundDefs({ fillDefines: [] });
ok(warnings.length === n0, '(d) an empty fillDefines is not a use of the hook: no warning');

console.warn = warn;
console.log(fail ? `\nfillDefinesGateSmoke FAIL (${fail})` : '\nfillDefinesGateSmoke PASS');
process.exit(fail ? 1 : 0);
