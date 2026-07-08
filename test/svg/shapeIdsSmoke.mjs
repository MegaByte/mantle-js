// shapeIdsSmoke.mjs — verifies SVG `id` attributes flow into
// bundle.shapeIds (via el.getAttribute('id') on staged shape records)
// and are addressable from createOverrideTable.
//
// Asserts:
//   T1: a 2-shape SVG with id="bg" + id="fill" yields a bundle whose
//       shapeIds contains both names (fill-row IDs).
//   T2: createOverrideTable.set('fill', { … }) returns true for known
//       ids and false for unknown ones.
//   T3: a bundle whose SVG has NO ids at all triggers the one-shot
//       warn ('bundle.shapeIds is empty — set("…") will never
//       resolve') on first unknown-id miss, then stays silent.
//   T4: stroked shapes get a `${id}_stroke` row in addition to the
//       fill row (so the C# `_stroke` naming convention is preserved).
//   T5: <a href> + id stack lifecycle survives nesting (id pushed,
//       popped on exit; sibling shapes don't inherit parent's id).

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';
import { createOverrideTable } from '../../src/animation/overrides.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

// Minimal WebGL2 shim (matches overridesSmoke.mjs's pattern).
function makeGlStub() {
  return {
    NEAREST: 9728, CLAMP_TO_EDGE: 33071,
    TEXTURE_2D: 3553, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243,
    RGBA32F: 34836, RGBA: 6408, FLOAT: 5126,
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    deleteTexture: () => {},
  };
}

// ----- T1: SVG ids flow into bundle.shapeIds ----------------------
{
  const svg = `<?xml version="1.0"?>
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle id="bg"   cx="50" cy="50" r="50" fill="rgb(255,255,255)" fill-opacity="0.5"/>
      <circle id="fill" cx="50" cy="50" r="40" fill="rgb(51,51,51)"/>
    </svg>`;
  const bundle = await importSvg(svg, {});
  if (!Array.isArray(bundle.shapeIds))
    fail(`T1 bundle.shapeIds not an array: ${typeof bundle.shapeIds}`);
  else if (bundle.shapeIds.length !== bundle.numShapes)
    fail(`T1 shapeIds length ${bundle.shapeIds.length} != numShapes ${bundle.numShapes}`);
  else if (!bundle.shapeIds.includes('bg') || !bundle.shapeIds.includes('fill'))
    fail(`T1 missing expected ids in [${bundle.shapeIds.join(', ')}]`);
  else
    ok(`T1 SVG ids propagate: shapeIds = [${bundle.shapeIds.join(', ')}]`);
}

// ----- T2: overrideTable.set(string) hits known ids ---------------
{
  const svg = `<?xml version="1.0"?>
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle id="bg"   cx="50" cy="50" r="50" fill="rgb(255,255,255)"/>
      <circle id="fill" cx="50" cy="50" r="40" fill="rgb(51,51,51)"/>
    </svg>`;
  const bundle = await importSvg(svg, {});
  // Stub a minimal bundle handle expected by createOverrideTable
  // (numShapes + shapeIds is all it reads).
  const handle = { numShapes: bundle.numShapes, shapeIds: bundle.shapeIds };
  const ov = createOverrideTable(makeGlStub(), handle);
  const okBg   = ov.set('bg',   { tint: [1, 0, 0, 1] });
  const okFill = ov.set('fill', { tint: [0, 1, 0, 1] });
  const okMiss = ov.set('xxxxx', { tint: [0, 0, 1, 1] });
  if (!okBg)   fail('T2 set("bg") returned false despite id existing');
  else if (!okFill) fail('T2 set("fill") returned false despite id existing');
  else if (okMiss) fail('T2 set("xxxxx") returned true despite unknown id');
  else ok('T2 set(known) true / set(unknown) false');
}

// ----- T3: warn-once on empty-shapeIds bundle ---------------------
{
  // Synthetic bundle with NO ids — simulates a bundle source that
  // forgets to populate them.
  const handle = { numShapes: 2, shapeIds: ['', ''] };
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    const ov = createOverrideTable(makeGlStub(), handle);
    ov.set('foo', { tint: [1, 0, 0, 1] });    // miss #1 → expect warn
    ov.set('bar', { tint: [0, 1, 0, 1] });    // miss #2 → silent
    ov.set('baz', { tint: [0, 0, 1, 1] });    // miss #3 → silent
  } finally {
    console.warn = origWarn;
  }
  if (warnings.length === 0)
    fail('T3 expected one console.warn on empty-shapeIds miss; got none');
  else if (warnings.length > 1)
    fail(`T3 expected exactly ONE warn, got ${warnings.length}`);
  else if (!/shapeIds is empty/.test(warnings[0]))
    fail(`T3 warn text doesn't mention empty shapeIds: ${warnings[0]}`);
  else
    ok(`T3 unknown-id on empty bundle warns once: "${warnings[0].slice(0, 60)}…"`);
}

// ----- T4: stroked shape gets fill + _stroke rows -----------------
{
  const svg = `<?xml version="1.0"?>
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect id="frame" x="10" y="10" width="80" height="80"
            fill="rgb(255,0,0)" stroke="rgb(0,0,0)" stroke-width="4"/>
    </svg>`;
  const bundle = await importSvg(svg, {});
  const hasFill   = bundle.shapeIds.includes('frame');
  const hasStroke = bundle.shapeIds.includes('frame_stroke');
  if (!hasFill)   fail(`T4 expected 'frame' id, got [${bundle.shapeIds.join(', ')}]`);
  else if (!hasStroke) fail(`T4 expected 'frame_stroke' id, got [${bundle.shapeIds.join(', ')}]`);
  else ok(`T4 stroked shape emits fill+_stroke rows: [${bundle.shapeIds.join(', ')}]`);
}

// ----- T5: id stack doesn't leak across siblings ------------------
{
  const svg = `<?xml version="1.0"?>
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <g id="group1">
        <circle id="inner" cx="25" cy="25" r="10" fill="rgb(255,0,0)"/>
      </g>
      <circle id="sibling" cx="75" cy="75" r="10" fill="rgb(0,255,0)"/>
    </svg>`;
  const bundle = await importSvg(svg, {});
  // 'group1' is a non-rendering container, so it shouldn't appear in
  // shapeIds. 'inner' and 'sibling' should both appear.
  const hasInner   = bundle.shapeIds.includes('inner');
  const hasSibling = bundle.shapeIds.includes('sibling');
  const hasGroup   = bundle.shapeIds.includes('group1');
  if (!hasInner)        fail(`T5 expected 'inner' in [${bundle.shapeIds.join(', ')}]`);
  else if (!hasSibling) fail(`T5 expected 'sibling' (id stack popped after group): [${bundle.shapeIds.join(', ')}]`);
  else if (hasGroup)    fail(`T5 unexpected 'group1' (group container should NOT produce an id'd meta row): [${bundle.shapeIds.join(', ')}]`);
  else ok(`T5 id stack scopes correctly across siblings: [${bundle.shapeIds.join(', ')}]`);
}

if (failures > 0) {
  console.error(`\nSHAPE-IDS FAIL (${failures})`);
  process.exit(1);
}
console.log('\nSHAPE-IDS PASS');
