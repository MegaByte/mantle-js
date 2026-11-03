// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Bundle introspection inventory. Each case parses a minimal SVG and
// asserts the FeatureSet has the expected flag bits set (or not set).
// The tracked paint fixtures (test/fixtures/paint) must inventory the
// row types they exist for, on curved geometry.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../src/svg/importer.js';
import { inspect, inspectAll, toNames, Features } from '../src/bundle/featureSet.js';
import {
  META_FLOATS_PER_SHAPE,
  META_STROKE_A,
  META_STROKE_W,
  META_STROKE_IMAGE_ID,
} from '../src/bundle/layout.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

async function imp(body) {
  return await importSvg(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">${body}</svg>`,
    {},
  );
}
const has = (f, bit) => (f & bit) === bit;

// ---- T1: bare rect → no advanced features --------------------------
{
  const b = await imp('<rect x="10" y="10" width="30" height="30" fill="red"/>');
  const f = inspect(b);
  const Forbidden =
    Features.Strokes |
    Features.Gradients |
    Features.Clips |
    Features.Masks |
    Features.Filters |
    Features.Images |
    Features.BlendNonNormal |
    Features.ColrPaintGraph;
  if ((f & Forbidden) !== 0n)
    fail(`T1 bare rect: ${toNames(f).join(',')} (expected no Forbidden bits)`);
  else ok(`T1 bare rect → [${toNames(f).join(',') || 'None'}]`);
}

// ---- T2: stroke ---------------------------------------------------
{
  const b = await imp(
    '<rect x="10" y="10" width="30" height="30" fill="red" stroke="black" stroke-width="2"/>',
  );
  if (has(inspect(b), Features.Strokes)) ok('T2 stroke detected');
  else fail(`T2 stroke missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T3: stroke + dash --------------------------------------------
{
  const b = await imp(
    '<rect x="10" y="10" width="30" height="30" fill="none" stroke="black" stroke-width="2" stroke-dasharray="4 2"/>',
  );
  if (has(inspect(b), Features.Strokes | Features.StrokeDash)) ok('T3 stroke + dash detected');
  else fail(`T3 expected Strokes|StrokeDash; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T4: linear gradient ------------------------------------------
{
  const b = await imp(
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect x="10" y="10" width="30" height="30" fill="url(#g)"/>',
  );
  const f = inspect(b);
  if (has(f, Features.Gradients | Features.GradientLinear) && !has(f, Features.GradientRadial))
    ok(`T4 linear gradient → [${toNames(f).join(',')}]`);
  else fail(`T4 expected Gradients|GradientLinear only; got ${toNames(f).join(',')}`);
}

// ---- T5: radial gradient ------------------------------------------
{
  const b = await imp(
    '<defs><radialGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs><rect x="10" y="10" width="30" height="30" fill="url(#g)"/>',
  );
  const f = inspect(b);
  if (has(f, Features.GradientRadial) && !has(f, Features.GradientLinear))
    ok(`T5 radial gradient → [${toNames(f).join(',')}]`);
  else fail(`T5 expected GradientRadial only; got ${toNames(f).join(',')}`);
}

// ---- T6: clip-path -------------------------------------------------
{
  const b = await imp(
    '<defs><clipPath id="c"><rect x="0" y="0" width="50" height="50"/></clipPath></defs><rect x="10" y="10" width="80" height="80" fill="red" clip-path="url(#c)"/>',
  );
  if (has(inspect(b), Features.Clips)) ok('T6 clip-path detected');
  else fail(`T6 missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T7: mask ------------------------------------------------------
{
  const b = await imp(
    '<defs><mask id="m"><rect x="0" y="0" width="100" height="100" fill="white"/></mask></defs><rect x="10" y="10" width="80" height="80" fill="red" mask="url(#m)"/>',
  );
  if (has(inspect(b), Features.Masks)) ok('T7 mask detected');
  else fail(`T7 missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T8: filter (Gaussian blur) ------------------------------------
{
  const b = await imp(
    '<defs><filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>',
  );
  const f = inspect(b);
  if (has(f, Features.Filters | Features.FilterBlur))
    ok(`T8 filter+blur → [${toNames(f).join(',')}]`);
  else fail(`T8 expected Filters|FilterBlur; got ${toNames(f).join(',')}`);
}

// ---- T8b: the same blur in the DEFAULT color space (linearRGB) is the kind-7 record: Filters | FilterBlur, no graph ------------
{
  const b = await imp(
    '<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>',
  );
  const f = inspect(b);
  if (has(f, Features.Filters | Features.FilterBlur) && !has(f, Features.FilterGraph))
    ok(`T8b filter+blur in linearRGB → [${toNames(f).join(',')}]`);
  else fail(`T8b expected Filters|FilterBlur without FilterGraph; got ${toNames(f).join(',')}`);
}

// ---- T8c: a blur and a color matrix in linearRGB still need the graph ------------
{
  const b = await imp(
    '<defs><filter id="f"><feGaussianBlur stdDeviation="2"/><feColorMatrix type="saturate" values="0.3"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>',
  );
  const f = inspect(b);
  if (has(f, Features.Filters | Features.FilterGraph))
    ok(`T8c filter+blur+matrix in linearRGB → [${toNames(f).join(',')}]`);
  else fail(`T8c expected Filters|FilterGraph; got ${toNames(f).join(',')}`);
}

// ---- T9: filter (feColorMatrix saturate) ---------------------------
{
  const b = await imp(
    '<defs><filter id="f" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0.5"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>',
  );
  const f = inspect(b);
  if (has(f, Features.FilterColorMatrix) && !has(f, Features.FilterBlur))
    ok(`T9 filter+color-matrix → [${toNames(f).join(',')}]`);
  else fail(`T9 expected FilterColorMatrix only; got ${toNames(f).join(',')}`);
}

// ---- T10: vector-effect=non-scaling-stroke -------------------------
{
  const b = await imp(
    '<rect x="10" y="10" width="30" height="30" fill="none" stroke="black" stroke-width="2" vector-effect="non-scaling-stroke"/>',
  );
  if (has(inspect(b), Features.NonScalingStroke)) ok('T10 non-scaling-stroke detected');
  else fail(`T10 missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T11: <g mix-blend-mode=multiply> with 2+ children -------------
{
  const b = await imp(
    '<g style="mix-blend-mode: multiply"><rect x="10" y="10" width="30" height="30" fill="red"/><rect x="20" y="20" width="30" height="30" fill="blue"/></g>',
  );
  const f = inspect(b);
  if (has(f, Features.GroupComposite | Features.BlendNonNormal))
    ok(`T11 group+blend → [${toNames(f).join(',')}]`);
  else fail(`T11 expected GroupComposite|BlendNonNormal; got ${toNames(f).join(',')}`);
}

// ---- T12: toNames produces a stable list ---------------------------
{
  const b = await imp(
    '<rect x="10" y="10" width="30" height="30" fill="red" stroke="black" stroke-width="2"/>',
  );
  const names = toNames(inspect(b));
  if (names.includes('Strokes')) ok(`T12 toNames → [${names.join(',')}]`);
  else fail(`T12 expected 'Strokes' in names; got [${names.join(',')}]`);
}

// ---- T13: inspectAll unions across multiple bundles ----------------
{
  const b1 = await imp(
    '<rect x="10" y="10" width="30" height="30" fill="red" stroke="black" stroke-width="2"/>',
  );
  const b2 = await imp(
    '<defs><filter id="f" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>',
  );
  const f = inspectAll([b1, b2]);
  if (has(f, Features.Strokes | Features.FilterBlur))
    ok(`T13 inspectAll union → [${toNames(f).join(',')}]`);
  else fail(`T13 union missed; got [${toNames(f).join(',')}]`);
}

// ---- T14: bitmap stroke image slot also requires image support ------
{
  const metaFloats = new Float32Array(META_FLOATS_PER_SHAPE);
  metaFloats[META_STROKE_A] = 1;
  metaFloats[META_STROKE_W] = 2;
  metaFloats[META_STROKE_IMAGE_ID] = 1;
  const f = inspect({
    numShapes: 1,
    metaFloats,
    metaFloatsPerShape: META_FLOATS_PER_SHAPE,
  });
  if (has(f, Features.Images | Features.Strokes))
    ok(`T14 strokeImageId image feature → [${toNames(f).join(',')}]`);
  else fail(`T14 expected Images|Strokes from strokeImageId; got [${toNames(f).join(',')}]`);
}

// ---- T15: featuresToFillOmit / omitDefinesFor (internal: the fill variants' omissions) -----------------
{
  const { featuresToFillOmit } = await import('../src/bundle/featureSet.js');
  const { omitDefinesFor } = await import('../src/renderer/fillOmit.js');
  const bare = featuresToFillOmit(Features.None);
  const expectOmit = ['gradient', 'clip', 'mask', 'filter', 'stroke', 'pattern', 'image'];
  if (expectOmit.every((n) => bare.includes(n)) && bare.length === expectOmit.length)
    ok(`T15a empty flags omits all baked fill features → [${bare.join(',')}]`);
  else fail(`T15a unexpected omit ${JSON.stringify(bare)}`);

  const withGrad = featuresToFillOmit(Features.Gradients);
  if (!withGrad.includes('gradient') && withGrad.includes('filter'))
    ok(`T15b Gradients keeps gradient, still omits filter → [${withGrad.join(',')}]`);
  else fail(`T15b unexpected omit ${JSON.stringify(withGrad)}`);

  const defs = omitDefinesFor(featuresToFillOmit(Features.None));
  if (
    defs.includes('MANTLE_NO_GRADIENT') &&
    defs.includes('MANTLE_NO_STROKE') &&
    !defs.includes('MANTLE_NO_RECOLOR') &&
    !defs.includes('MANTLE_NO_EXTCLIP')
  )
    ok(`T15c omitDefinesFor(featuresToFillOmit) → [${defs.join(',')}]`);
  else fail(`T15c unexpected defines ${JSON.stringify(defs)}`);

  // ...and no public helper hands this list to createRenderer's fillDefines (that
  // option is a debug-only test hook), from the package root, `./shaders` and `./bundle`.
  const root = await import('../src/index.js'),
    sh = await import('../src/shaders/index.js'),
    bu = await import('../src/bundle/index.js');
  const left = [
    'featuresToFillDefines',
    'fillOmitDefines',
    'FILL_FEATURES',
    'featuresToFillOmit',
    'BAKED_FILL_FEATURES',
  ].filter((n) => n in root || n in sh || n in bu);
  if (!left.length) ok('T15d the fill-omit helpers are not public (root, ./shaders, ./bundle)');
  else fail(`T15d still exported: ${left.join(', ')}`);
}

// ---- T16: the tracked paint fixtures carry their row types on curved geometry ------------------------
// The hand-written files under test/fixtures/paint give the lanes every paint row type (gradient, mask and clip,
// vector pattern, filter, blend) without proprietary or painted art. Each must inventory the row type it exists
// for, in at least two shapes with curves (quadratic, cubic or arc) so the analytic engines have something to draw.
{
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/paint');
  const want = {
    gradient_rows: ['Gradients', 'GradientLinear', 'GradientRadial'],
    mask_rows: ['Masks', 'Clips'],
    pattern_rows: ['VectorPattern'],
    filter_rows: ['Filters', 'FilterBlur', 'FilterColorMatrix'],
    blend_rows: ['BlendNonNormal'],
  };
  for (const [name, names] of Object.entries(want)) {
    const sc = await importSvg(readFileSync(path.join(dir, name + '.svg'), 'utf8'), {
      preserveViewport: true,
    });
    const f = inspect(sc);
    for (const n of names) {
      if ((f & Features[n]) !== 0n) ok(`T16 ${name}: ${n}`);
      else fail(`T16 ${name}: ${n} missing; got [${toNames(f).join(',')}]`);
    }
    if (sc.numShapes >= 2 && (sc.segTypeMask & 0b1110) !== 0)
      ok(`T16 ${name}: ${sc.numShapes} shapes with curved segments (mask ${sc.segTypeMask})`);
    else
      fail(
        `T16 ${name}: ${sc.numShapes} shapes, segment mask ${sc.segTypeMask} (want >= 2 shapes with curves)`,
      );
  }
}

console.log();
console.log(failures === 0 ? 'FEATURE-SET PASS' : `FEATURE-SET FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
