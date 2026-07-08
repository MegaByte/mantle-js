// Bundle introspection inventory. Each case parses a minimal SVG and
// asserts the FeatureSet has the expected flag bits set (or not set).

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
const ok   = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };

async function imp(body) {
  return await importSvg(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">${body}</svg>`,
    {});
}
const has = (f, bit) => (f & bit) === bit;

// ---- T1: bare rect → no advanced features --------------------------
{
  const b = await imp('<rect x="10" y="10" width="30" height="30" fill="red"/>');
  const f = inspect(b);
  const Forbidden =
      Features.Strokes
    | Features.Gradients
    | Features.Clips
    | Features.Masks
    | Features.Filters
    | Features.Images
    | Features.BlendNonNormal
    | Features.ColrPaintGraph;
  if ((f & Forbidden) !== 0n)
    fail(`T1 bare rect: ${toNames(f).join(',')} (expected no Forbidden bits)`);
  else ok(`T1 bare rect → [${toNames(f).join(',') || 'None'}]`);
}

// ---- T2: stroke ---------------------------------------------------
{
  const b = await imp('<rect x="10" y="10" width="30" height="30" fill="red" stroke="black" stroke-width="2"/>');
  if (has(inspect(b), Features.Strokes)) ok('T2 stroke detected');
  else fail(`T2 stroke missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T3: stroke + dash --------------------------------------------
{
  const b = await imp('<rect x="10" y="10" width="30" height="30" fill="none" stroke="black" stroke-width="2" stroke-dasharray="4 2"/>');
  if (has(inspect(b), Features.Strokes | Features.StrokeDash))
    ok('T3 stroke + dash detected');
  else fail(`T3 expected Strokes|StrokeDash; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T4: linear gradient ------------------------------------------
{
  const b = await imp('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect x="10" y="10" width="30" height="30" fill="url(#g)"/>');
  const f = inspect(b);
  if (has(f, Features.Gradients | Features.GradientLinear)
      && !has(f, Features.GradientRadial))
    ok(`T4 linear gradient → [${toNames(f).join(',')}]`);
  else fail(`T4 expected Gradients|GradientLinear only; got ${toNames(f).join(',')}`);
}

// ---- T5: radial gradient ------------------------------------------
{
  const b = await imp('<defs><radialGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs><rect x="10" y="10" width="30" height="30" fill="url(#g)"/>');
  const f = inspect(b);
  if (has(f, Features.GradientRadial) && !has(f, Features.GradientLinear))
    ok(`T5 radial gradient → [${toNames(f).join(',')}]`);
  else fail(`T5 expected GradientRadial only; got ${toNames(f).join(',')}`);
}

// ---- T6: clip-path -------------------------------------------------
{
  const b = await imp('<defs><clipPath id="c"><rect x="0" y="0" width="50" height="50"/></clipPath></defs><rect x="10" y="10" width="80" height="80" fill="red" clip-path="url(#c)"/>');
  if (has(inspect(b), Features.Clips)) ok('T6 clip-path detected');
  else fail(`T6 missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T7: mask ------------------------------------------------------
{
  const b = await imp('<defs><mask id="m"><rect x="0" y="0" width="100" height="100" fill="white"/></mask></defs><rect x="10" y="10" width="80" height="80" fill="red" mask="url(#m)"/>');
  if (has(inspect(b), Features.Masks)) ok('T7 mask detected');
  else fail(`T7 missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T8: filter (Gaussian blur) ------------------------------------
{
  const b = await imp('<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>');
  const f = inspect(b);
  if (has(f, Features.Filters | Features.FilterBlur))
    ok(`T8 filter+blur → [${toNames(f).join(',')}]`);
  else fail(`T8 expected Filters|FilterBlur; got ${toNames(f).join(',')}`);
}

// ---- T9: filter (feColorMatrix saturate) ---------------------------
{
  const b = await imp('<defs><filter id="f"><feColorMatrix type="saturate" values="0.5"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>');
  const f = inspect(b);
  if (has(f, Features.FilterColorMatrix) && !has(f, Features.FilterBlur))
    ok(`T9 filter+color-matrix → [${toNames(f).join(',')}]`);
  else fail(`T9 expected FilterColorMatrix only; got ${toNames(f).join(',')}`);
}

// ---- T10: vector-effect=non-scaling-stroke -------------------------
{
  const b = await imp('<rect x="10" y="10" width="30" height="30" fill="none" stroke="black" stroke-width="2" vector-effect="non-scaling-stroke"/>');
  if (has(inspect(b), Features.NonScalingStroke))
    ok('T10 non-scaling-stroke detected');
  else fail(`T10 missed; got ${toNames(inspect(b)).join(',')}`);
}

// ---- T11: <g mix-blend-mode=multiply> with 2+ children -------------
{
  const b = await imp('<g style="mix-blend-mode: multiply"><rect x="10" y="10" width="30" height="30" fill="red"/><rect x="20" y="20" width="30" height="30" fill="blue"/></g>');
  const f = inspect(b);
  if (has(f, Features.GroupComposite | Features.BlendNonNormal))
    ok(`T11 group+blend → [${toNames(f).join(',')}]`);
  else fail(`T11 expected GroupComposite|BlendNonNormal; got ${toNames(f).join(',')}`);
}

// ---- T12: toNames produces a stable list ---------------------------
{
  const b = await imp('<rect x="10" y="10" width="30" height="30" fill="red" stroke="black" stroke-width="2"/>');
  const names = toNames(inspect(b));
  if (names.includes('Strokes')) ok(`T12 toNames → [${names.join(',')}]`);
  else fail(`T12 expected 'Strokes' in names; got [${names.join(',')}]`);
}

// ---- T13: inspectAll unions across multiple bundles ----------------
{
  const b1 = await imp('<rect x="10" y="10" width="30" height="30" fill="red" stroke="black" stroke-width="2"/>');
  const b2 = await imp('<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="10" y="10" width="30" height="30" fill="red" filter="url(#f)"/>');
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

console.log();
console.log(failures === 0 ? 'FEATURE-SET PASS' : `FEATURE-SET FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
