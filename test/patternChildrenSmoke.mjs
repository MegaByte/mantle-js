// Verify the SVG importer threads gradient and image fills into
// vector-pattern child meta rows correctly. Pattern children route through
// the same walk() as top-level shapes, so fillGradId / imageId / atlasSlot
// get written to the pattern-child meta row with FLAG_LAYER (bit 8) set; the
// coverage shader and MantleUnified.shader composite loops dispatch to
// sampleGradient / sampleChildImage when those slots are non-zero. Guards
// against the importer threading regressing (e.g. resetting fillGradId=0 on
// layer rows).

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importSvg } from '../src/svg/importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }

const META_STRIDE   = 48;
const FLAG_LAYER    = 0x100;
const META_FLAGS    = 27;
const META_FILLGID  = 28;
const META_IMAGEID  = 35;
const META_ATLAS_W  = 43;
const META_ATLAS_X  = 40;
const META_ATLAS_Y  = 41;

async function loadSections(relPath) {
  const svg = readFileSync(path.join(ROOT, relPath), 'utf8');
  return await importSvg(svg, {});
}

function metaFloats(sections) { return new Float32Array(sections.meta, 32); }

function readShape(m, i) {
  const b = i * META_STRIDE;
  return {
    fillGradId: Math.round(m[b + META_FILLGID]),
    imageId:    Math.round(m[b + META_IMAGEID]),
    flags:      Math.round(m[b + META_FLAGS]),
    atlas: [m[b + META_ATLAS_X], m[b + META_ATLAS_Y], m[b + META_ATLAS_W]],
  };
}

// === T1: pattern_gradient.svg — linear + radial gradient children ====
{
  const s = await loadSections('examples/_pattern_gradient.svg');
  const m = metaFloats(s);
  if (s.numShapes !== 3) {
    fail(`T1 expected 3 shapes (2 pattern children + 1 carrier rect), got ${s.numShapes}`);
  } else {
    const sh0 = readShape(m, 0), sh1 = readShape(m, 1), sh2 = readShape(m, 2);
    // Children: both gradient-filled, FLAG_LAYER set.
    if (sh0.fillGradId > 0 && (sh0.flags & FLAG_LAYER) !== 0)
      ok(`T1 pattern-child 0: gradient #${sh0.fillGradId} on FLAG_LAYER row`);
    else
      fail(`T1 child 0: fillGradId=${sh0.fillGradId} flags=0x${sh0.flags.toString(16)} (want gradId>0 + FLAG_LAYER)`);
    if (sh1.fillGradId > 0 && (sh1.flags & FLAG_LAYER) !== 0)
      ok(`T1 pattern-child 1: gradient #${sh1.fillGradId} on FLAG_LAYER row`);
    else
      fail(`T1 child 1: fillGradId=${sh1.fillGradId} flags=0x${sh1.flags.toString(16)}`);
    if (sh0.fillGradId !== sh1.fillGradId)
      ok('T1 distinct gradients per child (linear vs radial)');
    else
      fail(`T1 children share gradient id ${sh0.fillGradId}; expected linear≠radial`);
    // Carrier: atlasSlot.w == 2 marks vector pattern; .xy = (firstRow1, lastRow1).
    if (Math.abs(sh2.atlas[2] - 2) < 0.5)
      ok('T1 carrier shape: atlasSlot.w == 2 (vector-pattern sentinel)');
    else
      fail(`T1 carrier atlasSlot.w = ${sh2.atlas[2]} (want 2)`);
    const firstRow1 = sh2.atlas[0], lastRow1 = sh2.atlas[1];
    if (firstRow1 === 1 && lastRow1 === 2)
      ok(`T1 carrier child range: rows ${firstRow1}..${lastRow1} (1-based)`);
    else
      fail(`T1 carrier child range = ${firstRow1}..${lastRow1}, expected 1..2`);
  }
}

// === T2: pattern_image.svg — graceful degradation in node ============
// decodeImageHref() requires DOM Image + Canvas APIs (browser only).
// In node the importer skips the <image> element gracefully, which
// makes the pattern empty (no children → claimVectorPattern returns
// 0). The carrier rect then renders as a plain rect rather than a
// vector-pattern carrier (the full 2-shape bundle requires the browser).
//
// Assertion here is the graceful path: importer doesn't crash, the
// fallback rect is non-pattern, and no spurious vector-pattern
// sentinel leaks onto it.
{
  const s = await loadSections('examples/_pattern_image.svg');
  const m = metaFloats(s);
  if (s.numShapes !== 1) {
    fail(`T2 node graceful-degradation: expected 1 shape (fallback rect, image skipped), got ${s.numShapes}`);
  } else {
    const sh0 = readShape(m, 0);
    if (sh0.imageId === 0 && Math.abs(sh0.atlas[2]) < 0.5)
      ok('T2 node: image-pattern degrades cleanly (carrier rect with no pattern wiring)');
    else
      fail(`T2 node: stray pattern state leaked (imageId=${sh0.imageId} atlas.w=${sh0.atlas[2]})`);
  }
}

// === T3: simple _pattern.svg — solid-fill children regression guard ===
{
  const s = await loadSections('examples/_pattern.svg');
  const m = metaFloats(s);
  let anyGrad = false, anyImg = false;
  for (let i = 0; i < s.numShapes; i++) {
    const sh = readShape(m, i);
    if (sh.fillGradId > 0) anyGrad = true;
    if (sh.imageId > 0)    anyImg = true;
  }
  if (!anyGrad && !anyImg)
    ok('T3 solid-fill pattern: no gradient/image ids leak onto child rows');
  else
    fail(`T3 solid-fill pattern: anyGrad=${anyGrad} anyImg=${anyImg} (want both false)`);
}

console.log('---');
if (failures) console.error(`PATTERN-CHILDREN FAIL (${failures})`);
else          console.log('PATTERN-CHILDREN PASS');
process.exit(failures ? 1 : 0);
