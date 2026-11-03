// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// synthBoldInkModelSmoke — the synthetic-bold ink model answers what the RENDER measures.
//
//
// `probes/strokeRest/_synthBoldInk.mjs` predicts, on the CPU, how much ink sizing a synthetically bolded
// run's stroke row by its STROKE box, rather than its PATH box, adds: with no bold face to select,
// font/textColrEmit.js paints the run's color as a 0.04 em stroke on top of each glyph's fill, and a row
// sized by the path box gives the outer half of the synthesised weight no fragments wherever the outline
// touches its own bbox.
//
// `probes/strokeRest/_synthBoldInkGpu.mjs` renders the same run both ways and subtracts them: 724.0
// device px at 96 px/em and 3548.4 at 192 (see MEASURED), on a 0.000 A/A floor, byte-identical across
// Slug, Loop-Blinn and CPatch. A model that misses those cannot tell a partly-working padding from a
// working one, which is the only reason to have one.
//
// TWO TERMS the naive model leaves out, and this pins both (the derivation is in
// test/_synthBoldInkModel.mjs):
//
//   * THE BAKED QUAD IS NOT THE QUAD THAT RASTERIZES. mantle.vert.glsl's coverQuadDilate pushes
//     every cover-quad edge out by half a DEVICE pixel before rasterization, so the path-box build
//     already paints a band a naive model counts as excluded. Scale-linear in device pixels.
//   * THE EXCLUDED REGION IS NOT DISJOINT FROM THE FILL, though a naive model needs no fill term
//     on that assumption. emitShape puts fill and stroke on ONE meta row, and the padded build's
//     wider band membership reaches pixels on the INNER half of the stroke that the path-box walk
//     misses — inside the path, where the fill is already solid, so the render gains nothing there.
//
// The two measured gains are the target, and they are what is asserted. A tolerance is stated
// per size rather than shared: the residual is a boundary effect of sampling coverage at the
// pixel CENTER, so it must SHRINK with size, and a band that allowed 3% at both would not notice
// the model going wrong at 192 px/em.
import { readFileSync } from 'node:fs';
import { fontFixture, requireAsset } from './_assets.mjs';

const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { buildTextSections } = await import('../src/font/textSections.js');
const { synthBoldInkGain } = await import('./_synthBoldInkModel.mjs');

const TTF = readFileSync(requireAsset(fontFixture('roboto-regular.ttf')));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

/// What probes/strokeRest/_synthBoldInkGpu.mjs measures for "Hamburg", weight 700, one em = PX
/// device pixels, as the difference between the padded build and the path-box build.
/// `tol` is a FRACTION of the measured gain.
///
/// Both builds include the stroke's AA reach in the band walk's reach and break (strokeAaReachEm),
/// and so does the model, because _strokeBandEmu models the same walk.
const MEASURED = [
  { px: 96, gain: 724.0, tol: 0.05 },
  { px: 192, gain: 3548.4, tol: 0.01 },
];

const results = [];
for (const m of MEASURED) {
  const font = new MantleFontAsset(new Uint8Array(TTF));
  const { sections } = await buildTextSections(
    font,
    'Hamburg',
    { fontSizePx: m.px, weight: 700, fill: [0, 0, 0, 1] },
    false,
  );
  const out = synthBoldInkGain(sections, m.px);
  results.push({ ...m, out });
}

console.log('\n-- the model lands on the two measured renders --');
for (const r of results) {
  const d = r.out.total - r.gain,
    rel = Math.abs(d) / r.gain;
  ok(
    rel <= r.tol,
    `"Hamburg" at ${r.px} px/em: model ${r.out.total.toFixed(1)} px against a measured ` +
      `${r.gain.toFixed(1)} (${d >= 0 ? '+' : ''}${d.toFixed(1)}, ${(100 * rel).toFixed(2)}%, ` +
      `allowed ${(100 * r.tol).toFixed(0)}%)`,
  );
}

console.log('\n-- the residual is a boundary effect, so it shrinks with size --');
{
  const [a, b] = results;
  const relA = Math.abs(a.out.total - a.gain) / a.gain;
  const relB = Math.abs(b.out.total - b.gain) / b.gain;
  ok(
    relB < relA,
    `relative error falls from ${(100 * relA).toFixed(2)}% at 96 px/em to ${(100 * relB).toFixed(2)}% at 192`,
  );
  ok(
    a.out.total > a.gain && b.out.total >= b.gain,
    'and it is an OVER-prediction at both sizes — the model may still count a sliver of fill ink ' +
      'the render gains and it does not, never the other way',
  );
}

console.log('\n-- both corrections are doing work, and each is the right shape --');
{
  const [a, b] = results;
  // Scale-LINEAR: a perimeter (which doubles) times a fixed device reach (which does not).
  const rq = b.out.quadDilation / a.out.quadDilation;
  ok(
    a.out.quadDilation > 100 && rq > 1.7 && rq < 2.3,
    `the cover quad's own AA dilation removes ${a.out.quadDilation.toFixed(1)} px at 96 and ` +
      `${b.out.quadDilation.toFixed(1)} at 192 — a ratio of ${rq.toFixed(2)}, i.e. scale-LINEAR`,
  );
  // Scale-invariant in em: a region fixed in the artwork, so its device area goes as s^2 -- 4 at
  // these two sizes, less where AA fringes count (3.73 on this walk).
  const rf = b.out.fillAlready / a.out.fillAlready;
  ok(
    a.out.fillAlready > 100 && rf > 2.4 && rf < 4.4,
    `the fill already painting it removes ${a.out.fillAlready.toFixed(1)} px at 96 and ` +
      `${b.out.fillAlready.toFixed(1)} at 192 — a ratio of ${rf.toFixed(2)}, which a device-fixed ` +
      'dilation cannot produce',
  );
  // ...and neither is a rounding term: without them the model is the naive one.
  const old96 = a.out.total + a.out.quadDilation + a.out.fillAlready;
  // the naive model reads 1215.0 on this walk.
  ok(
    Math.abs(old96 - 1215.0) < 1.0,
    `putting both back reproduces the naive model, 1215.0 at 96 px/em on this walk (${old96.toFixed(1)})`,
  );
}

console.log(
  '\n-- the path-box build this is a difference against is still the one buildContext.js pads --',
);
{
  // The model rebuilds buildContext.js with the padding's two lines reverted. If that hunk moves, the
  // path-box arm silently becomes the shipped one and every gain above collapses to zero — which
  // would read as a model that suddenly agrees with nothing.
  const { PAD_HINGE } = await import('./_synthBoldInkModel.mjs');
  const src = readFileSync(new URL('../src/svg/buildContext.js', import.meta.url), 'utf8');
  ok(src.includes(PAD_HINGE), 'the strokePad / bbMeta hinge is still in buildContext.js verbatim');
  ok(
    results[0].out.rows.length === 7,
    `"Hamburg" is still 7 glyph rows (${results[0].out.rows.length})`,
  );
  ok(
    results[0].out.rows.every((r) => Math.abs(r.halfWpx - 1.92) < 0.01),
    'and each carries the 0.04 em synthetic-bold stroke (halfW 1.92 px at 96 px/em)',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
