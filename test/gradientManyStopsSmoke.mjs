// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gradientManyStopsSmoke — a gradient keeps every stop past 256, at a position fine enough to tell
// them apart, in a stop LUT that fits any number of them.
//
// THREE LIMITS. A binary search of a fixed 9 probes (log2 256 + 1) would cut every gradient to 256
// stops. A one-byte stop offset has only 256 distinct positions: 600 stops cannot be placed on 256.
// And a LUT of ONE ROW of texels is pushed past MAX_TEXTURE_SIZE by a long gradient (or many
// gradients). So:
//   - the search runs while the bracket is open, bounded at 16 probes (65536 stops, the cap,
//     sentinels included); a gradient of N stops takes ceil(log2 N) probes, so one of <= 256
//     takes at most 9;
//   - a gradient of more than 256 stops takes the two-texel layout with a 24-bit offset in the
//     second texel's spare bytes (hi + mid/255 + lo/255^2, all over 255); a shorter one keeps the
//     one-byte offset;
//   - LUT texel i lives at (i % 2048, i / 2048), so a LUT over 2048 texels wraps onto more rows.
//
// The sampler below mirrors _gradientHelpers.glsl's sampleStopsRaw (lower-bound search, the two
// guards, the lerp) over the texture exactly as createBundle uploads it, captured from a GL stub; the
// shader's own constants are read out of its text so the mirror cannot drift from what ships. The
// reference is the AUTHORED float stops, interpolated in float64.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { buildGradientTables, packGradientStops } from '../src/svg/gradient.js';
import { createBundle } from '../src/renderer/bundle.js';
import { importSvg } from '../src/svg/importer.js';
import * as layout from '../src/bundle/layout.js';
import { setDiagnostics } from '../src/core/diagnostics.js';
import { createFakeGl } from './_fakeGl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const LUT_W = 2048,
  MAX_STOPS = 65536;
if (layout.GRAD_STOPS_LUT_W === LUT_W && layout.GRAD_STOPS_MAX === MAX_STOPS)
  ok(`layout.js: GRAD_STOPS_LUT_W ${LUT_W}, GRAD_STOPS_MAX ${MAX_STOPS}`);
else
  fail(
    `layout.js: GRAD_STOPS_LUT_W ${layout.GRAD_STOPS_LUT_W}, GRAD_STOPS_MAX ${layout.GRAD_STOPS_MAX}`,
  );

// ---- The shader text: probe bound, wrap addressing, offset decode ----------------------------
const helper = readFileSync(path.join(ROOT, 'src/shaders/_gradientHelpers.glsl'), 'utf8');
const iters = (() => {
  const i = helper.indexOf('int lo = 0, hi = count - 1');
  const m = i < 0 ? null : helper.slice(i).match(/for\s*\(\s*int\s+it\s*=\s*0;\s*it\s*<\s*(\d+)/);
  return m ? +m[1] : NaN;
})();
if (iters === Math.ceil(Math.log2(MAX_STOPS)))
  ok(`sampleStopsRaw probes at most ${iters} times = ceil(log2 ${MAX_STOPS})`);
else
  fail(
    `sampleStopsRaw's probe bound is ${iters}, want ${Math.ceil(Math.log2(MAX_STOPS))} (log2 of the ${MAX_STOPS}-stop cap)`,
  );
const wrapOk =
  new RegExp(`i\\s*&\\s*${LUT_W - 1}`).test(helper) &&
  new RegExp(`i\\s*>>\\s*${Math.log2(LUT_W)}`).test(helper);
if (wrapOk) ok(`the shader addresses LUT texel i at (i & ${LUT_W - 1}, i >> ${Math.log2(LUT_W)})`);
else
  fail(
    `the shader does not wrap LUT texels at ${LUT_W} (want i & ${LUT_W - 1}, i >> ${Math.log2(LUT_W)})`,
  );
if (/\.y\s*\*\s*\(1\.0\s*\/\s*255\.0\)\s*\+\s*\w+\.z\s*\*\s*\(1\.0\s*\/\s*65025\.0\)/.test(helper))
  ok('the shader decodes a two-texel offset as x + y/255 + z/65025');
else fail('the shader does not decode the 24-bit offset (x + y/255 + z/65025)');
for (const f of ['mantle.frag.glsl', 'paintLinearGradient.frag.glsl', 'maskBake.frag.glsl']) {
  const g = readFileSync(path.join(ROOT, 'src/shaders/generated', f), 'utf8');
  if (g.includes(`i & ${LUT_W - 1}`)) ok(`generated/${f} carries the wrapped sampler`);
  else fail(`generated/${f} is stale: no wrapped sampler (run npm run build:shaders)`);
}

// ---- A GL stub that keeps the stop LUT upload -------------------------------------------------
function uploadedLut(sections) {
  const F = createFakeGl();
  const uploads = [];
  const gl = new Proxy(F.gl, {
    get: (t, k) =>
      k === 'texImage2D'
        ? (...a) => {
            uploads.push(a);
          }
        : t[k],
  });
  createBundle(gl, sections, { occlusionCull: false });
  // The stop LUT is the RGBA8 upload whose bytes are the section's.
  const want = new Uint8Array(sections.gradientStops);
  for (const a of uploads) {
    const [, , , w, h, , , , data] = a;
    if (
      data instanceof Uint8Array &&
      data.length >= want.length &&
      w * h * 4 === data.length &&
      want.every((v, i) => data[i] === v)
    )
      return { w, h, data };
  }
  return null;
}

// ---- The sampler mirror (sampleStopsRaw) ------------------------------------------------------
function makeSampler({ w, data }) {
  const texel = (i) => {
    const x = i & (LUT_W - 1),
      y = i >> Math.log2(LUT_W);
    if (x >= w) return [0, 0, 0, 0];
    const o = (y * w + x) * 4;
    return [data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, data[o + 3] / 255];
  };
  const offOf = (b) => b[0] + b[1] * (1 / 255) + b[2] * (1 / 65025);
  return (t, stopsOffset, stopsCount) => {
    if (stopsCount === 0) return [0, 0, 0, 0];
    const one = stopsCount < 0,
      n = Math.abs(stopsCount),
      base = stopsOffset;
    const col = (k) => {
      const c = texel(base + (one ? k : k * 2));
      return one ? [c[0], c[1], c[2], 1] : c;
    };
    const off = (k) => (one ? texel(base + k)[3] : offOf(texel(base + k * 2 + 1)));
    if (n === 1) return col(0);
    let lo = 0,
      hi = n - 1,
      probes = 0;
    for (let it = 0; it < iters; it++) {
      if (lo >= hi) break;
      const mid = (lo + hi) >> 1;
      probes++;
      if (off(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    const cur = col(lo),
      curOff = off(lo);
    if (lo === 0 || curOff < t) return cur;
    const prev = col(lo - 1),
      prevOff = off(lo - 1);
    const k = (t - prevOff) / Math.max(curOff - prevOff, 1e-6);
    return prev.map((v, i) => v + (cur[i] - v) * k);
  };
}
// The float64 reference over the AUTHORED stops (sorted, clamped pad at the ends).
function reference(stops, t) {
  if (t <= stops[0].offset) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const a = stops[i - 1],
        b = stops[i];
      const k = (t - a.offset) / Math.max(b.offset - a.offset, 1e-12);
      return a.color.map((v, j) => v + (b.color[j] - v) * k);
    }
  }
  return stops[stops.length - 1].color;
}
let seed = 0x2545f491;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;

// A gradient record the way parseGradients leaves one (only what buildGradientTables reads).
const grad = (stops) => ({
  gtype: 0,
  spread: 0,
  units: 0,
  gradient_transform: [1, 0, 0, 1, 0, 0],
  x1: 0,
  y1: 0,
  x2: 1,
  y2: 0,
  stops,
});
function tablesSections(grads) {
  const t = buildGradientTables(grads);
  return {
    t,
    sections: {
      numShapes: 0,
      flags: 0,
      globalBBox: [0, 0, 1, 1],
      metaFloatsPerShape: 48,
      curves: new ArrayBuffer(16),
      bands: new ArrayBuffer(16),
      meta: new ArrayBuffer(32),
      curveGeom: new ArrayBuffer(0),
      gradients: t.records.buffer.slice(0),
      gradientStops: t.stops.buffer.slice(0),
      gradientStopsCount: t.stopsCount,
    },
  };
}
const recOf = (t, i) => {
  const f = new Float32Array(t.records.buffer, t.records.byteOffset);
  return [f[i * 16 + 10], f[i * 16 + 11]];
};

// ---- 1. 600 opaque stops, smooth random colors: every stop kept, sampled to within a quantum ----
{
  const stops = [];
  let r = rnd(),
    g = rnd(),
    b = rnd();
  for (let i = 0; i < 600; i++) {
    r = Math.min(1, Math.max(0, r + (rnd() - 0.5) * 0.2));
    g = Math.min(1, Math.max(0, g + (rnd() - 0.5) * 0.2));
    b = Math.min(1, Math.max(0, b + (rnd() - 0.5) * 0.2));
    stops.push({ offset: i / 599, color: [r, g, b, 1] });
  }
  const { t, sections } = tablesSections([grad(stops)]);
  const [so, sc] = recOf(t, 0);
  if (sc === 600)
    ok(
      `600 opaque stops: record stopsCount ${sc} (every stop, two-texel layout for the fine offset)`,
    );
  else fail(`600 opaque stops: record stopsCount ${sc}, want 600`);
  const lut = uploadedLut(sections);
  if (!lut) fail('600 stops: no stop LUT upload found');
  else {
    const sample = makeSampler(lut);
    let worst = 0,
      at = 0;
    for (let k = 0; k <= 6000; k++) {
      const tt = k / 6000;
      const got = sample(Math.fround(tt), so, sc),
        want = reference(stops, tt);
      for (let j = 0; j < 4; j++) {
        const d = Math.abs(got[j] - want[j]);
        if (d > worst) {
          worst = d;
          at = tt;
        }
      }
    }
    // Color is 8-bit (half a quantum each end) and the offset is exact to ~6e-8 of the axis.
    if (worst <= 0.6 / 255)
      ok(`600 stops sample within ${(worst * 255).toFixed(3)}/255 of the float stops over 6001 t`);
    else
      fail(
        `600 stops: worst |sample - stops| ${(worst * 255).toFixed(2)}/255 at t=${at.toFixed(5)}`,
      );
  }
}

// ---- 2. Hard stops among 400: the left color below each edge, the right color above ---------
{
  const stops = [];
  for (let i = 0; i < 200; i++) {
    const o = (i + 1) / 201;
    stops.push({ offset: o, color: i & 1 ? [1, 0, 0, 0.5] : [0, 0, 1, 1] });
    stops.push({ offset: o, color: i & 1 ? [0, 1, 0, 1] : [1, 1, 0, 0.25] });
  }
  const { t, sections } = tablesSections([grad(stops)]);
  const [so, sc] = recOf(t, 0);
  const lut = uploadedLut(sections);
  const sample = lut && makeSampler(lut);
  let bad = 0;
  for (let i = 0; sample && i < 200; i++) {
    const o = (i + 1) / 201,
      eps = 1e-5;
    const below = sample(Math.fround(o - eps), so, sc),
      above = sample(Math.fround(o + eps), so, sc);
    const L = stops[2 * i].color,
      Rr = stops[2 * i + 1].color;
    const near = (a, b, tol) => a.every((v, j) => Math.abs(v - b[j]) <= tol);
    // Just below the edge the ramp from the previous edge is ~1e-5 / (1/201) of the way to L.
    if (!near(below, L, 0.01) || !near(above, Rr, 0.01)) bad++;
  }
  if (sample && bad === 0)
    ok(`400 stops as 200 hard edges (stopsCount ${sc}): every edge is sharp and in place`);
  else fail(`400 hard stops: ${sample ? bad + ' of 200 edges wrong' : 'no LUT upload'}`);
}

// ---- 3. A LUT over one row wraps: 1500 translucent stops = 3000 texels = 2 rows of 2048 --------
{
  const stops = [];
  for (let i = 0; i < 1500; i++)
    stops.push({ offset: i / 1499, color: [i / 1499, 1 - i / 1499, (i % 7) / 6, 0.5] });
  const { t, sections } = tablesSections([
    grad([
      { offset: 0, color: [1, 1, 1, 1] },
      { offset: 1, color: [0, 0, 0, 1] },
    ]),
    grad(stops),
  ]);
  const lut = uploadedLut(sections);
  const texels = t.stopsCount;
  if (lut && lut.w === LUT_W && lut.h === Math.ceil(texels / LUT_W))
    ok(
      `${texels}-texel LUT uploads as ${lut.w}x${lut.h} (padded ${lut.data.length - texels * 4} bytes)`,
    );
  else
    fail(
      `${texels}-texel LUT: uploaded ${lut ? lut.w + 'x' + lut.h : 'nothing'}, want ${LUT_W}x${Math.ceil(texels / LUT_W)}`,
    );
  if (lut) {
    const sample = makeSampler(lut);
    const [so, sc] = recOf(t, 1);
    let worst = 0;
    for (let k = 0; k <= 3000; k++) {
      const tt = k / 3000,
        got = sample(Math.fround(tt), so, sc),
        want = reference(stops, tt);
      for (let j = 0; j < 4; j++) worst = Math.max(worst, Math.abs(got[j] - want[j]));
    }
    if (worst <= 0.6 / 255)
      ok(
        `the wrapped gradient (offset ${so}, crossing row 0 -> 1) samples within ${(worst * 255).toFixed(3)}/255`,
      );
    else fail(`the wrapped gradient samples ${(worst * 255).toFixed(2)}/255 off`);
  }
  const small = tablesSections([
    grad([
      { offset: 0, color: [1, 0, 0, 1] },
      { offset: 1, color: [0, 0, 1, 1] },
    ]),
  ]);
  const sl = uploadedLut(small.sections);
  if (sl && sl.w === 2 && sl.h === 1)
    ok('a 2-texel LUT still uploads as 2x1 (one row of exactly its length)');
  else fail(`a 2-texel LUT uploaded as ${sl ? sl.w + 'x' + sl.h : 'nothing'}, want 2x1`);
}

// ---- 4. <= 256 stops pack exactly as they did -------------------------------------------------
{
  const p = packGradientStops({
    stops: [
      { offset: 0, color: [1, 0, 0, 1] },
      { offset: 77 / 255, color: [0, 1, 0, 0.5] },
      { offset: 1, color: [0, 0, 1, 1] },
    ],
  });
  // 77/255, not 0.3: an offset that is a whole multiple of 1/255 keeps the 8-bit offset and these bytes. An offset 8 bits cannot place
  // exactly (0.3 * 255 = 76.5) packs with the 24-bit offset instead (checked just below).
  const want = [
    255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128, 77, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0,
  ];
  if (p.length === want.length && want.every((v, i) => p[i] === v))
    ok('a 3-stop gradient keeps the one-byte layout (8-bit offset, spare bytes 0)');
  else fail(`3-stop pack changed: [${Array.from(p).join(',')}]`);
  // an offset 8 bits cannot place (0.3) uses the 24-bit one: hi/255 + mid/255^2 + lo/255^3 within 1/(2 * 255^3) of it
  const fine = packGradientStops({
    stops: [
      { offset: 0, color: [1, 0, 0, 1] },
      { offset: 0.3, color: [0, 1, 0, 0.5] },
      { offset: 1, color: [0, 0, 1, 1] },
    ],
  });
  const dec = fine[12] / 255 + fine[13] / 65025 + fine[14] / 16581375;
  if (Math.abs(dec - 0.3) <= 0.5 / 16581375 + 1e-12 && fine[15] === 0)
    ok(
      'an offset 8 bits cannot place (0.3) packs a 24-bit offset that decodes within 1/(2 * 255^3)',
    );
  else fail(`0.3 packed as [${Array.from(fine.subarray(12, 16)).join(',')}] decoding to ${dec}`);
  const s256 = [];
  for (let i = 0; i < 256; i++) s256.push({ offset: i / 255, color: [i / 255, 0, 0, 1] });
  const t256 = buildGradientTables([grad(s256)]);
  if (recOf(t256, 0)[1] === -256)
    ok('256 opaque stops keep the one-texel fast path (stopsCount -256)');
  else fail(`256 opaque stops: stopsCount ${recOf(t256, 0)[1]}, want -256`);
}

// ---- 5. The cap is 65536, sentinels included, with a warning ----------------------------------
{
  const warns = [];
  setDiagnostics({ onWarn: (m) => warns.push(String(m)) });
  const s = [];
  for (let i = 0; i < 70000; i++) s.push({ offset: i / 69999, color: [0, 0, 0, 0.5] });
  const p = packGradientStops({ stops: s });
  setDiagnostics({ onWarn: null });
  if (p.length === MAX_STOPS * 8 && warns.some((w) => /65536/.test(w)))
    ok(`70000 stops are cut to ${MAX_STOPS}, with a warning`);
  else fail(`70000 stops packed to ${p.length / 8} stops; warnings: ${JSON.stringify(warns)}`);
}

// ---- 6. End to end through importSvg: a 600-stop <linearGradient> keeps its 600 stops ---------
{
  const xml = [];
  for (let i = 0; i < 600; i++)
    xml.push(
      `<stop offset="${(i / 599).toFixed(6)}" stop-color="rgb(${i % 256},${(i * 7) % 256},0)"/>`,
    );
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g">${xml.join('')}</linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`,
    {},
  );
  const recs = new Float32Array(b.gradients);
  if (Math.abs(recs[11]) === 600)
    ok(`importSvg: the 600-stop gradient ships ${Math.abs(recs[11])} stops`);
  else fail(`importSvg: the 600-stop gradient ships ${recs[11]} stops`);
}

if (failures) {
  console.error(`\nGRADIENT-MANY-STOPS FAIL (${failures})`);
  process.exit(1);
}
console.log('\nGRADIENT-MANY-STOPS PASS');
