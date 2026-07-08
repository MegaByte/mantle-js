// externalStylesheetSmoke.mjs — verify external <link rel="stylesheet">
// rules are pulled via the cssTextLoader callback and merged with
// inline <style> rules.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';
import { buildStylesheetAsync } from '../../src/svg/stylesheet.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

// ----- T1: rules from external sheet appear ------------------------
{
  const doc = new DP().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">
      <link rel="stylesheet" href="ext.css"/>
      <rect class="foo"/>
    </svg>`, 'application/xml');
  const root = doc.documentElement;
  const loader = async (href) => href === 'ext.css' ? '.foo { fill: red; }' : null;
  const rules = await buildStylesheetAsync(root, loader);
  if (!rules || rules.length !== 1)
    fail(`T1 expected 1 rule from external CSS, got ${rules?.length}`);
  else ok(`T1 external sheet pulled: ${rules.length} rule(s)`);
}

// ----- T2: inline + external compose --------------------------------
{
  const doc = new DP().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">
      <style>.bar { stroke: blue; }</style>
      <link rel="stylesheet" href="ext.css"/>
      <rect class="foo"/>
    </svg>`, 'application/xml');
  const loader = async () => '.foo { fill: red; }';
  const rules = await buildStylesheetAsync(doc.documentElement, loader);
  if (!rules || rules.length !== 2) fail(`T2 expected 2 rules (inline+external), got ${rules?.length}`);
  else ok('T2 inline + external rules compose');
}

// ----- T3: no loader → external links skipped ----------------------
{
  const doc = new DP().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">
      <style>.bar { fill: blue; }</style>
      <link rel="stylesheet" href="ext.css"/>
    </svg>`, 'application/xml');
  const rules = await buildStylesheetAsync(doc.documentElement, null);
  if (!rules || rules.length !== 1) fail(`T3 expected only inline rule, got ${rules?.length}`);
  else ok('T3 no loader → inline only, external silently skipped');
}

// ----- T4: rel != stylesheet → skipped -----------------------------
{
  const doc = new DP().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">
      <link rel="alternate stylesheet" href="alt.css"/>
      <link rel="icon" href="favicon.png"/>
      <link rel="stylesheet" href="ext.css"/>
    </svg>`, 'application/xml');
  let calls = [];
  const loader = async (href) => { calls.push(href); return ''; };
  await buildStylesheetAsync(doc.documentElement, loader);
  if (calls.length !== 1 || calls[0] !== 'ext.css')
    fail(`T4 loader called for: ${calls.join(',')} (expected only ext.css)`);
  else ok('T4 rel="alternate stylesheet" / rel="icon" correctly ignored');
}

// ----- T5: full importSvg pipeline with cssTextLoader ----------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <link rel="stylesheet" href="theme.css"/>
  <rect x="10" y="10" width="80" height="80" class="theme-fill"/>
</svg>`;
  const loader = async (href) => href === 'theme.css' ? '.theme-fill { fill: red; }' : null;
  const bundle = await importSvg(svg, { cssTextLoader: loader });
  if (!bundle || bundle.numShapes < 1) fail('T5 bundle has no shape');
  else {
    // Verify fill color from external rule landed: meta texel 1 = fillColor (RGBA)
    const f = new Float32Array(bundle.meta, 32);
    const r = f[4], g = f[5], b = f[6];
    if (r < 0.95 || g > 0.05 || b > 0.05)
      fail(`T5 external rule didn't take effect; rect fill = [${r}, ${g}, ${b}] not red`);
    else ok('T5 importSvg + cssTextLoader: external rule fills rect red');
  }
}

// ----- T6: disabled link is skipped --------------------------------
{
  const doc = new DP().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">
      <link rel="stylesheet" href="ext.css" disabled=""/>
    </svg>`, 'application/xml');
  let called = false;
  const loader = async () => { called = true; return ''; };
  await buildStylesheetAsync(doc.documentElement, loader);
  if (called) fail('T6 disabled link should be skipped');
  else ok('T6 disabled attribute → skipped');
}

if (failures > 0) {
  console.error(`\nEXTERNAL-STYLESHEET FAIL (${failures})`);
  process.exit(1);
}
console.log('\nEXTERNAL-STYLESHEET PASS');
