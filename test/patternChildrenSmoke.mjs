// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verify the SVG importer threads gradient and image fills into
// vector-pattern child meta rows correctly. Pattern children route through
// the same walk() as top-level shapes, so fillGradId / imageId / atlasSlot
// get written to the pattern-child meta row with FLAG_LAYER (bit 8) set; the
// coverage shader and MantleUnified.shader composite loops dispatch to
// sampleGradient / sampleChildImage when those slots are non-zero. Guards
// against a break in the importer's threading (e.g. resetting fillGradId=0 on
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
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}

const META_STRIDE = 48;
const FLAG_LAYER = 0x100;
const META_FLAGS = 27;
const META_FILLGID = 28;
const META_IMAGEID = 35;
const META_ATLAS_W = 43;
const META_ATLAS_X = 40;
const META_ATLAS_Y = 41;

async function loadSections(relPath) {
  const svg = readFileSync(path.join(ROOT, relPath), 'utf8');
  return await importSvg(svg, {});
}

function metaFloats(sections) {
  return new Float32Array(sections.meta, 32);
}

function readShape(m, i) {
  const b = i * META_STRIDE;
  return {
    fillGradId: Math.round(m[b + META_FILLGID]),
    imageId: Math.round(m[b + META_IMAGEID]),
    flags: Math.round(m[b + META_FLAGS]),
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
    const sh0 = readShape(m, 0),
      sh1 = readShape(m, 1),
      sh2 = readShape(m, 2);
    // Children: both gradient-filled, FLAG_LAYER set.
    if (sh0.fillGradId > 0 && (sh0.flags & FLAG_LAYER) !== 0)
      ok(`T1 pattern-child 0: gradient #${sh0.fillGradId} on FLAG_LAYER row`);
    else
      fail(
        `T1 child 0: fillGradId=${sh0.fillGradId} flags=0x${sh0.flags.toString(16)} (want gradId>0 + FLAG_LAYER)`,
      );
    if (sh1.fillGradId > 0 && (sh1.flags & FLAG_LAYER) !== 0)
      ok(`T1 pattern-child 1: gradient #${sh1.fillGradId} on FLAG_LAYER row`);
    else fail(`T1 child 1: fillGradId=${sh1.fillGradId} flags=0x${sh1.flags.toString(16)}`);
    if (sh0.fillGradId !== sh1.fillGradId) ok('T1 distinct gradients per child (linear vs radial)');
    else fail(`T1 children share gradient id ${sh0.fillGradId}; expected linear≠radial`);
    // Carrier: atlasSlot.w == 2 marks vector pattern; .xy = (firstRow1, lastRow1).
    if (Math.abs(sh2.atlas[2] - 2) < 0.5)
      ok('T1 carrier shape: atlasSlot.w == 2 (vector-pattern sentinel)');
    else fail(`T1 carrier atlasSlot.w = ${sh2.atlas[2]} (want 2)`);
    const firstRow1 = sh2.atlas[0],
      lastRow1 = sh2.atlas[1];
    if (firstRow1 === 1 && lastRow1 === 2)
      ok(`T1 carrier child range: rows ${firstRow1}..${lastRow1} (1-based)`);
    else fail(`T1 carrier child range = ${firstRow1}..${lastRow1}, expected 1..2`);
  }
}

// === T2: pattern_image.svg — graceful degradation in node ============
// decodeImageHref() requires DOM Image + Canvas APIs (browser only).
// In node the importer skips the <image> element gracefully, which
// makes the pattern empty (no children → claimVectorPattern returns
// 0). A valid pattern with no decoded paint is transparent.
{
  const s = await loadSections('examples/_pattern_image.svg');
  if (s.numShapes === 0) ok('T2 unavailable image-pattern paints nothing');
  else fail(`T2 unavailable image-pattern unexpectedly emits ${s.numShapes} shapes`);
}

// === T3: simple _pattern.svg — solid-fill children ===
{
  const s = await loadSections('examples/_pattern.svg');
  const m = metaFloats(s);
  let anyGrad = false,
    anyImg = false;
  for (let i = 0; i < s.numShapes; i++) {
    const sh = readShape(m, i);
    if (sh.fillGradId > 0) anyGrad = true;
    if (sh.imageId > 0) anyImg = true;
  }
  if (!anyGrad && !anyImg) ok('T3 solid-fill pattern: no gradient/image ids leak onto child rows');
  else fail(`T3 solid-fill pattern: anyGrad=${anyGrad} anyImg=${anyImg} (want both false)`);
}

for (const content of [
  '',
  '<g/>',
  '<rect width="64" height="64" display="none"/>',
  '<rect width="64" height="64" fill="url(#p)"/>',
]) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64">' +
    content +
    '</pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>';
  const s = await importSvg(svg, { preserveViewport: true, keepInvisibleShapes: true }),
    m = metaFloats(s);
  let paints = false;
  for (let row = 0; row < s.numShapes; row++)
    if (m[row * 48 + 7] > 0 && m[row * 48 + 43] !== 2) paints = true;
  if (!paints) ok('empty/cyclic pattern has no solid fallback');
  else fail('empty/cyclic pattern emits solid fallback');
}

// Descriptive children do not replace inherited template drawing content.
{
  const doc = (content) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="base" patternUnits="userSpaceOnUse" width="8" height="8"><rect width="4" height="8" fill="lime"/></pattern><pattern id="p" href="#base">' +
    content +
    '</pattern></defs><rect width="32" height="32" fill="url(#p)"/></svg>';
  const control = await importSvg(doc(''), { preserveViewport: true });
  for (const content of [
    '<title>Label</title>',
    '<desc>Explanation</desc>',
    '<metadata>Info</metadata>',
    '<s:title xmlns:s="http://www.w3.org/2000/svg">Label</s:title><desc/>',
  ]) {
    const actual = await importSvg(doc(content), { preserveViewport: true });
    const same =
      actual.numShapes === control.numShapes &&
      Buffer.from(actual.meta).equals(Buffer.from(control.meta)) &&
      Buffer.from(actual.curves).equals(Buffer.from(control.curves));
    if (same) ok('descriptive children retain inherited pattern data');
    else fail('descriptive children discard inherited pattern data');
  }
  const own = await importSvg(doc('<title>Own</title><rect width="8" height="8" fill="red"/>'), {
    preserveViewport: true,
  });
  if (!Buffer.from(own.meta).equals(Buffer.from(control.meta)))
    ok('drawing child replaces inherited pattern');
  else fail('drawing child incorrectly inherits pattern');
}

console.log('---');
if (failures) console.error(`PATTERN-CHILDREN FAIL (${failures})`);
else console.log('PATTERN-CHILDREN PASS');
process.exit(failures ? 1 : 0);
