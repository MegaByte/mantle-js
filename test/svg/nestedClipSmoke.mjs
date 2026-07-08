// nestedClipSmoke.mjs — verifies depth-1 nested <clipPath>.
//
// A clipPath's child shape can itself carry `clip-path="url(#other)"`.
// SVG-spec semantics: the child's coverage is intersected with the
// inner clip's union coverage before participating in the outer
// clip's union. The renderer implements this as a depth-1 AND in the
// fragment shader (mantle.frag.glsl evalClipCoverageAtRow +
// MantleSlugEvalClipPath in HLSL).
//
// This smoke verifies the IMPORTER half — that the clip-child's
// meta texel 7.z (clipId) is rewritten to point at the nested clip's
// first meta row, not the registry index. The rewrite loop must visit
// FLAG_LAYER rows; otherwise nested clipIds stay as 1-based registry
// indices and the shader misindexes the meta plane.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
const fail = (msg) => { console.error('FAIL', msg); failures++; };
const ok   = (msg) => console.log('ok', msg);

const META_STRIDE   = 48;    // floats per shape
const META_FLAGS    = 27;    // float offset of flagsShape  (texel 6.w)
const META_CLIPID   = 30;    // float offset of clipId      (texel 7.z)
const FLAG_LAYER    = 0x100;

function metaFloatsOf(bundle) {
  // bundle.meta is a 32-byte header + per-shape 48-float records.
  return new Float32Array(bundle.meta, 32);
}

// ----------------------------------------------------------------
// Test 1: nested clipPath (clip C1 has a child clipped by C2)
// ----------------------------------------------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <clipPath id="c2">
      <circle cx="50" cy="50" r="40"/>
    </clipPath>
    <clipPath id="c1">
      <rect x="10" y="10" width="80" height="80" clip-path="url(#c2)"/>
    </clipPath>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="red" clip-path="url(#c1)"/>
</svg>`;
  const bundle = await importSvg(svg, {});
  const m = metaFloatsOf(bundle);
  const n = bundle.numShapes;

  // Find the visible red rect — non-layer, fill alpha > 0.
  let visibleRow = -1;
  for (let i = 0; i < n; i++) {
    const flags = m[i * META_STRIDE + META_FLAGS] | 0;
    if ((flags & FLAG_LAYER) === 0) { visibleRow = i; break; }
  }
  if (visibleRow < 0) fail('test1: no visible shape found');
  else {
    const visClipId = m[visibleRow * META_STRIDE + META_CLIPID] | 0;
    if (visClipId <= 0) fail(`test1: visible shape has clipId=${visClipId}, expected > 0`);
    else if (visClipId > n) fail(`test1: visible clipId=${visClipId} out of range (numShapes=${n})`);
    else ok(`test1: visible shape clipId=${visClipId} resolves to a meta row`);

    // The visible clipId points at C1's first layer row. That row
    // is the rect with clip-path="url(#c2)" — its clipId should be
    // a rewritten meta-row index into C2's first layer row, NOT 1
    // (the registry index of C2).
    const c1FirstRow = visClipId - 1;
    const c1FirstFlags = m[c1FirstRow * META_STRIDE + META_FLAGS] | 0;
    if ((c1FirstFlags & FLAG_LAYER) === 0)
      fail(`test1: C1 first row ${c1FirstRow} should have FLAG_LAYER, flags=${c1FirstFlags}`);
    else ok('test1: C1 first row has FLAG_LAYER');

    const c1ChildClipId = m[c1FirstRow * META_STRIDE + META_CLIPID] | 0;
    if (c1ChildClipId <= 0)
      fail(`test1: C1 child clipId=${c1ChildClipId}, expected non-zero (the rewritten ref to C2)`);
    else if (c1ChildClipId > n)
      fail(`test1: C1 child clipId=${c1ChildClipId} out of range`);
    else ok(`test1: nested clipId=${c1ChildClipId} is a valid meta-row reference`);

    // Verify it actually points at a FLAG_LAYER row (C2's first child).
    if (c1ChildClipId > 0 && c1ChildClipId <= n) {
      const c2FirstFlags = m[(c1ChildClipId - 1) * META_STRIDE + META_FLAGS] | 0;
      if ((c2FirstFlags & FLAG_LAYER) === 0)
        fail(`test1: nested clip row ${c1ChildClipId - 1} should have FLAG_LAYER, flags=${c2FirstFlags}`);
      else ok('test1: nested clipId points at a FLAG_LAYER row (C2)');
    }
  }
}

// ----------------------------------------------------------------
// Test 2: clip without nested still works (rewriting layer rows must
// not break the single-level path)
// ----------------------------------------------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <clipPath id="c1">
      <rect x="10" y="10" width="80" height="80"/>
    </clipPath>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="blue" clip-path="url(#c1)"/>
</svg>`;
  const bundle = await importSvg(svg, {});
  const m = metaFloatsOf(bundle);
  const n = bundle.numShapes;

  let visibleRow = -1;
  for (let i = 0; i < n; i++) {
    const flags = m[i * META_STRIDE + META_FLAGS] | 0;
    if ((flags & FLAG_LAYER) === 0) { visibleRow = i; break; }
  }
  if (visibleRow < 0) fail('test2: no visible shape');
  else {
    const visClipId = m[visibleRow * META_STRIDE + META_CLIPID] | 0;
    if (visClipId <= 0 || visClipId > n)
      fail(`test2: visible clipId=${visClipId} invalid (numShapes=${n})`);
    else ok(`test2: single-level clip still works, visClipId=${visClipId}`);

    // The clip child should NOT carry a nested clipId (it had no clip-path).
    const c1Row = visClipId - 1;
    const c1Flags = m[c1Row * META_STRIDE + META_FLAGS] | 0;
    if ((c1Flags & FLAG_LAYER) === 0)
      fail(`test2: C1 row should have FLAG_LAYER, flags=${c1Flags}`);

    const c1ChildClipId = m[c1Row * META_STRIDE + META_CLIPID] | 0;
    if (c1ChildClipId !== 0)
      fail(`test2: C1 child unexpectedly has clipId=${c1ChildClipId}, expected 0`);
    else ok('test2: single-level clip child has no nested clipId (as expected)');
  }
}

// ----------------------------------------------------------------
// Test 3: pattern cycle guard (a pattern referencing itself doesn't
// hang the importer)
// ----------------------------------------------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <pattern id="p1" width="20" height="20" patternUnits="userSpaceOnUse">
      <rect width="20" height="20" fill="url(#p1)"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="url(#p1)"/>
</svg>`;
  // The cycle guard sets the memo to 0 before walking the pattern's
  // subtree, so the self-reference resolves to 0 (no pattern) and
  // recursion terminates.
  let didTimeout = true;
  const timer = setTimeout(() => {
    // Crude: this fires only if importSvg never returned. Node's
    // event loop normally keeps the timer alive; we clear it on
    // success below. The smoke is single-threaded so this works.
    fail('test3: pattern cycle hung importer (timeout)');
    process.exit(1);
  }, 5000);
  try {
    const bundle = await importSvg(svg, {});
    clearTimeout(timer);
    didTimeout = false;
    if (!bundle || typeof bundle.numShapes !== 'number')
      fail('test3: importer returned invalid bundle');
    else
      ok(`test3: self-referencing pattern terminated (${bundle.numShapes} shapes)`);
  } catch (e) {
    clearTimeout(timer);
    didTimeout = false;
    fail('test3: importer threw on self-referencing pattern: ' + e.message);
  }
}

// ----------------------------------------------------------------
// Test 4: nested clipPath on a <mask> child. The mask child's
// clip-path attribute clips that child's contribution to the mask.
// Importer-side check: clip-on-mask-child propagates the child's
// clipId onto its FLAG_LAYER meta row and rewrites it to a meta-row
// index. The clip claim must reach a fixed point across the mask
// emit loop (the mask loop can claim an inner clip after the clip
// loop has finished).
// ----------------------------------------------------------------
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <clipPath id="c1"><circle cx="50" cy="50" r="30"/></clipPath>
    <mask id="m1">
      <rect x="10" y="10" width="80" height="80" fill="white" clip-path="url(#c1)"/>
    </mask>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="red" mask="url(#m1)"/>
</svg>`;
  const bundle = await importSvg(svg, {});
  const m = metaFloatsOf(bundle);
  const n = bundle.numShapes;
  const META_MASKID = 31;  // texel 7.w

  let visRow = -1;
  for (let i = 0; i < n; i++) {
    const flags = m[i * META_STRIDE + META_FLAGS] | 0;
    if ((flags & FLAG_LAYER) === 0) { visRow = i; break; }
  }
  if (visRow < 0) fail('test4: no visible shape');
  else {
    const maskId = m[visRow * META_STRIDE + META_MASKID] | 0;
    if (maskId <= 0 || maskId > n)
      fail(`test4: visible maskId=${maskId} invalid (numShapes=${n})`);
    else {
      const maskFirstRow = maskId - 1;
      const maskFirstFlags = m[maskFirstRow * META_STRIDE + META_FLAGS] | 0;
      if ((maskFirstFlags & FLAG_LAYER) === 0)
        fail(`test4: mask first row missing FLAG_LAYER (got flags=0x${maskFirstFlags.toString(16)})`);
      else ok('test4: mask first row has FLAG_LAYER');
      const maskChildClipId = m[maskFirstRow * META_STRIDE + META_CLIPID] | 0;
      if (maskChildClipId <= 0 || maskChildClipId > n)
        fail(`test4: mask-child clipId=${maskChildClipId} invalid`);
      else {
        const innerFlags = m[(maskChildClipId - 1) * META_STRIDE + META_FLAGS] | 0;
        if ((innerFlags & FLAG_LAYER) === 0)
          fail(`test4: nested clipId points at row missing FLAG_LAYER (flags=0x${innerFlags.toString(16)})`);
        else ok(`test4: mask child carries nested clipId=${maskChildClipId}, resolves to layer row`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all ok');
