// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importCapacityHintSmoke -- the importer's texel-buffer sizing is memory-only: a float32 band buffer and any starting capacity
// must give byte-identical sections.
//
// The band buffer is write-only until texelToBytes narrows it to float32, so it is stored as float32 from the start (half the
// size) and both buffers start at a size hint taken from the source length (fewer doublings, less peak memory while importing).
// Rounding at the store is the rounding the downcast would do; capacity never changes content.
// Pinned here: sections from (a) the default import, (b) a float64 band buffer, (c) a huge size hint (no regrowth at all) and (d) the importer's own hint are equal.
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
const hash = (s) => {
  const h = crypto.createHash('sha1');
  for (const k of Object.keys(s).sort()) {
    const v = s[k];
    if (v instanceof ArrayBuffer) h.update(k).update(Buffer.from(v));
  }
  return h.digest('hex');
};
// values that do NOT survive float32 unchanged (so a store-time narrowing that differed from the final one would show)
let d = 'M0.1234567891 0.3333333333';
for (let i = 0; i < 400; i++)
  d += ` C${(i * 0.1237).toFixed(7)} 3.1415926 ${(i * 0.37).toFixed(7)} 7.7777777 ${(i * 0.11).toFixed(7)} ${(i % 17) * 1.0000003}`;
const SVGS = [
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${d} Z" fill="#c33" stroke="#036" stroke-width="0.7"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><circle cx="50" cy="50" r="33.3333333" fill="url(#g)"/><path d="M10 10 A20 30 25 1 0 70 60 Z" fill="none" stroke="#000" stroke-dasharray="3 2"/></svg>`,
];
const run = async (svg, mk) => hash(await importSvg(svg, { ctx: mk() }));
for (const [i, svg] of SVGS.entries()) {
  const dflt = () => makeBuildContext({ vBands: true, pairBands: true, aacLevels: true });
  const ref = await run(svg, dflt);
  const f64 = await run(svg, () => {
    const c = dflt();
    c.bandBuf = makeTexelBuffer(Float64Array);
    return c;
  });
  const huge = await run(svg, () =>
    makeBuildContext({ vBands: true, pairBands: true, aacLevels: true, sizeHint: 5e6 }),
  );
  const viaImporter = hash(await importSvg(svg));
  ok(ref === f64, `svg ${i}: a float64 band buffer gives the same sections`);
  ok(ref === huge, `svg ${i}: a huge size hint gives the same sections`);
  ok(ref === viaImporter, `svg ${i}: the importer's own size hint gives the same sections`);
}
const b = makeTexelBuffer(Float32Array);
ok(
  b.floats instanceof Float32Array && b.capacity === 256,
  'a float32 texel buffer starts at 256 texels',
);
// Not process.exit(): it joins the V8 platform's worker threads from the main thread, and a background compile that has just asked for a GC waits for the main thread forever. Sampled on a
// hung run: every check printed, the main thread in uv_thread_join under Environment::Exit, two node-V8Worker threads in TriggerAndWaitForGCFromBackgroundThread. A run that ends by itself tears the isolate down first.
process.exitCode = fail ? 1 : 0;
