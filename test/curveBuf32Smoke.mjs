// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// curveBuf32Smoke -- the importer's texel-buffer storage choices are memory-only: they never change a wire section.
//
// Curves: the curve texel buffer is float64 only to feed `curves64` (the unrounded twin the CPatch converter reads). A context
// that narrows it to float32 anyway (scene, text run, streaming builders) or an import that opts out of the twin
// (`importSvg(svg, { curves64: false })`) stores float32 from the start: every wire section is byte-identical (rounding at the
// store is the rounding of the final downcast) and only `curves64` is absent. The default import keeps `curves64`, and it is
// the exact unrounded twin of the wire plane.
//
// Bands and capacity: the band buffer is write-only until texelToBytes narrows it to float32, so it is stored as float32 from
// the start (half the size), and both buffers start at a size hint taken from the source length (fewer doublings, less peak
// memory while importing). Sections from the default import, a float64 band buffer, a huge size hint (no regrowth at all) and
// the importer's own hint are equal.
import crypto from 'crypto';
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
const { default: importSvg } = await import('../src/svg/importer.js');
const { makeBuildContext } = await import('../src/svg/buildContext.js');
const { makeTexelBuffer } = await import('../src/svg/textures.js');
// sha1 over every section (ArrayBuffers and typed-array views), optionally skipping one
const hash = (s, skip) => {
  const h = crypto.createHash('sha1');
  for (const k of Object.keys(s).sort()) {
    if (k === skip) continue;
    const v = s[k];
    if (v instanceof ArrayBuffer) h.update(k).update(Buffer.from(v));
    else if (ArrayBuffer.isView(v))
      h.update(k).update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  }
  return h.digest('hex');
};
// Values that do NOT survive float32 unchanged (so a store-time narrowing that differed from the final one would show), arcs,
// strokes, a gradient and a dash so every record kind is written. The 400-segment path forces several capacity doublings.
let d = 'M0.1234567891 0.3333333333';
for (let i = 0; i < 300; i++)
  d += ` C${(i * 0.1237).toFixed(7)} 3.1415926 ${(i * 0.37).toFixed(7)} 7.7777777 ${(i * 0.11).toFixed(7)} ${(i % 9) + 0.5555555}`;
let d2 = 'M0.1234567891 0.3333333333';
for (let i = 0; i < 400; i++)
  d2 += ` C${(i * 0.1237).toFixed(7)} 3.1415926 ${(i * 0.37).toFixed(7)} 7.7777777 ${(i * 0.11).toFixed(7)} ${(i % 17) * 1.0000003}`;
const SVGS = [
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${d} Z" fill="#c33" stroke="#036" stroke-width="0.7" stroke-dasharray="1.1 0.7"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><ellipse cx="50.1234567" cy="50.7654321" rx="31.2345678" ry="20.5" fill="url(#g)"/><path d="M10.123 10.456 A 20.789 13.321 33 1 0 70.987 60.654 Q 5.55555 80.4444 10.123 10.456 Z" fill="#093"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${d2} Z" fill="#c33" stroke="#036" stroke-width="0.7"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><circle cx="50" cy="50" r="33.3333333" fill="url(#g)"/><path d="M10 10 A20 30 25 1 0 70 60 Z" fill="none" stroke="#000" stroke-dasharray="3 2"/></svg>`,
];
const dflt = () => makeBuildContext({ vBands: true, pairBands: true, aacLevels: true });
const run = async (svg, mk) => hash(await importSvg(svg, { ctx: mk() }));
for (const [i, svg] of SVGS.entries()) {
  // the curve buffer and its float64 twin
  const ref = await importSvg(svg);
  const viaOpt = await importSvg(svg, { curves64: false });
  const viaCtx = await importSvg(svg, {
    ctx: makeBuildContext({ vBands: true, pairBands: true, aacLevels: true, curve64: false }),
  });
  ok(
    ref.curves64 instanceof ArrayBuffer && ref.curves64.byteLength === ref.curves.byteLength * 2,
    `svg ${i}: the default import keeps the unrounded twin (8 B per float)`,
  );
  const f64 = new Float64Array(ref.curves64),
    f32 = new Float32Array(ref.curves);
  let same = f64.length === f32.length;
  for (let k = 0; k < f64.length && same; k++)
    if (Math.fround(f64[k]) !== f32[k] && !(Number.isNaN(f64[k]) && Number.isNaN(f32[k])))
      same = false;
  ok(same, `svg ${i}: curves is exactly the float32 rounding of curves64`);
  ok(
    f64.some((v, k) => v !== f32[k]),
    `svg ${i}: the fixture really carries values float32 cannot hold`,
  );
  ok(
    !viaOpt.curves64 && !viaCtx.curves64,
    `svg ${i}: curves64:false and a curve64:false context emit no twin`,
  );
  ok(
    hash(ref, 'curves64') === hash(viaOpt, 'curves64'),
    `svg ${i}: curves64:false leaves every other section byte-identical`,
  );
  ok(
    hash(ref, 'curves64') === hash(viaCtx, 'curves64'),
    `svg ${i}: a float32 curve buffer leaves every other section byte-identical`,
  );

  // the band buffer and the starting capacity
  const base = await run(svg, dflt);
  const band64 = await run(svg, () => {
    const c = dflt();
    c.bandBuf = makeTexelBuffer(Float64Array);
    return c;
  });
  const huge = await run(svg, () =>
    makeBuildContext({ vBands: true, pairBands: true, aacLevels: true, sizeHint: 5e6 }),
  );
  const viaImporter = hash(ref);
  ok(base === band64, `svg ${i}: a float64 band buffer gives the same sections`);
  ok(base === huge, `svg ${i}: a huge size hint gives the same sections`);
  ok(base === viaImporter, `svg ${i}: the importer's own size hint gives the same sections`);
}
ok(
  dflt().curveBuf.floats instanceof Float64Array,
  'a default context keeps a float64 curve buffer',
);
ok(
  makeBuildContext({ curve64: false }).curveBuf.floats instanceof Float32Array,
  'curve64:false stores float32',
);
const b = makeTexelBuffer(Float32Array);
ok(
  b.floats instanceof Float32Array && b.capacity === 256,
  'a float32 texel buffer starts at 256 texels',
);
// Not process.exit(): it joins the V8 platform's worker threads from the main thread, and a background compile that has just asked for a GC waits for the main thread forever. Sampled on a
// hung run: every check printed, the main thread in uv_thread_join under Environment::Exit, two node-V8Worker threads in TriggerAndWaitForGCFromBackgroundThread. A run that ends by itself tears the isolate down first.
process.exitCode = fail ? 1 : 0;
