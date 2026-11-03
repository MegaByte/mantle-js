// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphGradientStopLayoutSmoke -- a matched shape whose two gradients pack their stops in DIFFERENT layouts still tweens its stops.
//
// The stop LUT holds a gradient either as one texel per stop (all stops opaque, every offset a multiple of 1/255: count < 0) or as two
// (a translucent stop, or an offset 8 bits cannot place: count > 0). prepareMorphGradients plans the stop tween across layouts, not only where
// the two poses' counts are EQUAL, signs included: otherwise red->blue (one texel) morphing to green->yellow with a stop at 0.5 or a
// stop-opacity (two texels) would tween the axis and hold the source colors at every t -- on the WebGL morph and, through the same plan, on
// the native one.
// The independent decoder below reads the layout from the contract (bundle/layout.js, _gradientHelpers.glsl), not from the packer.
import { buildMorphPlan } from '../src/core/morphCore.js';
import { prepareMorphGradients } from '../src/core/morphGradients.js';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};

const svg = (stops) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs><rect id="r" x="0" y="0" width="100" height="100" fill="url(#g)"/></svg>`;
const st = (o, c, a) =>
  `<stop offset="${o}" stop-color="${c}"${a == null ? '' : ` stop-opacity="${a}"`}/>`;

// Independent reader of one record's stops from a LUT: [offset, r, g, b, a], colors 0..255.
function readStops(rec, bytes) {
  const count = Math.round(rec[11]),
    begin = Math.round(rec[10]) * 4,
    n = Math.abs(count),
    out = [];
  for (let k = 0; k < n; k++) {
    if (count < 0) {
      const o = begin + 4 * k;
      out.push([bytes[o + 3] / 255, bytes[o], bytes[o + 1], bytes[o + 2], 255]);
    } else {
      const c = begin + 8 * k,
        o = c + 4;
      out.push([
        bytes[o] / 255 + bytes[o + 1] / 65025 + bytes[o + 2] / 16581375,
        bytes[c],
        bytes[c + 1],
        bytes[c + 2],
        bytes[c + 3],
      ]);
    }
  }
  return out;
}

async function sections(markup) {
  const b = await importSvg(markup, { retainSource: true });
  return {
    numShapes: b.numShapes,
    metaFloats: new Float32Array(b.meta, 32).slice(),
    gradientFloats: new Float32Array(b.gradients),
    gradientStopsBytes: new Uint8Array(b.gradientStops),
  };
}

async function pair(name, aStops, bStops, { wantLayoutsDiffer = true } = {}) {
  console.log(name);
  const a = await sections(svg(aStops)),
    b = await sections(svg(bStops));
  const ca = Math.round(a.gradientFloats[11]),
    cb = Math.round(b.gradientFloats[11]);
  check(
    wantLayoutsDiffer ? Math.sign(ca) !== Math.sign(cb) && Math.abs(ca) === Math.abs(cb) : true,
    `the poses pack differently: counts ${ca} and ${cb}`,
  );
  const stride = 48,
    meta = a.metaFloats.slice(),
    plan = { matched: [{ srcIdx: 0, dstIdx: 0 }], dstOnly: [] };
  const r = prepareMorphGradients(a, b, plan, meta, stride);
  check(r.stopPlan.length === 1, `the stop tween is planned (${r.stopPlan.length} stop slice)`);
  if (r.stopPlan.length !== 1) return;
  const id = Math.round(meta[28]),
    rec = r.params.subarray((id - 1) * 16, id * 16),
    end = r.targetParams.subarray((id - 1) * 16, id * 16);
  const from = readStops(rec, r.stops),
    to = readStops(end, r.targetStops);
  const want = readStops(a.gradientFloats, a.gradientStopsBytes),
    wantTo = readStops(b.gradientFloats, b.gradientStopsBytes);
  const sameStops = (x, y, tol) =>
    x.length === y.length &&
    x.every(
      (s, i) =>
        Math.abs(s[0] - y[i][0]) <= tol &&
        s.slice(1).every((v, c) => Math.abs(v - y[i][c + 1]) <= 1),
    );
  check(sameStops(from, want, 0.003), 'the prepared source end reads the authored source stops');
  check(
    sameStops(to, wantTo, 0.003),
    'the prepared destination end reads the authored destination stops',
  );
  // the byte lerp the morph uploads (shapeMorph.js: (a * (1 - t) + b * t + 0.5) | 0) at t = 0.5
  const plan0 = r.stopPlan[0],
    mid = Uint8Array.from(r.stops);
  for (let k = 0; k < plan0.byteLength; k++)
    mid[plan0.srcByteOffset + k] =
      (r.stops[plan0.srcByteOffset + k] * 0.5 +
        r.targetStops[plan0.dstByteOffset + k] * 0.5 +
        0.5) |
      0;
  const got = readStops(rec, mid);
  const mean = want.map((s, i) => s.map((v, c) => (v + wantTo[i][c]) / 2));
  check(
    sameStops(got, mean, 0.004),
    `t = 0.5 reads the mean stops: ${got.map((s) => s.map((v) => +v.toFixed(3)).join(',')).join(' | ')}`,
  );
}

await pair(
  'one texel (opaque, offsets 0/1) -> two texels (a translucent stop)',
  st(0, '#ff0000') + st(1, '#0000ff'),
  st(0, '#00ff00') + st(1, '#ffff00', 0.5),
);
await pair(
  'one texel (offsets 0, 0.4, 1) -> two texels (an offset 0.5 is not a multiple of 1/255)',
  st(0, '#ff0000') + st(0.4, '#ffffff') + st(1, '#0000ff'),
  st(0, '#00ff00') + st(0.5, '#000000') + st(1, '#ffff00'),
);
await pair(
  'two texels -> one texel (the other way)',
  st(0, '#ff0000') + st(0.5, '#ffffff') + st(1, '#0000ff'),
  st(0, '#00ff00') + st(0.4, '#000000') + st(1, '#ffff00'),
);
console.log('same layout is untouched');
{
  const a = await sections(svg(st(0, '#ff0000') + st(1, '#0000ff'))),
    b = await sections(svg(st(0, '#00ff00') + st(1, '#ffff00')));
  const meta = a.metaFloats.slice(),
    r = prepareMorphGradients(a, b, { matched: [{ srcIdx: 0, dstIdx: 0 }], dstOnly: [] }, meta, 48);
  check(
    r.stopPlan.length === 1 && r.stops.length === a.gradientStopsBytes.length,
    `one texel both: ${r.stopPlan.length} slice, the LUT keeps its ${a.gradientStopsBytes.length} bytes`,
  );
  const c = await sections(svg(st(0, '#ff0000') + st(1, '#0000ff'))),
    d = await sections(svg(st(0, '#00ff00') + st(0.5, '#fff') + st(1, '#ffff00')));
  const m2 = c.metaFloats.slice(),
    r2 = prepareMorphGradients(c, d, { matched: [{ srcIdx: 0, dstIdx: 0 }], dstOnly: [] }, m2, 48);
  check(
    r2.stopPlan.length === 0,
    'different stop COUNTS still hold the source stops (no stop resampling)',
  );
}
console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
