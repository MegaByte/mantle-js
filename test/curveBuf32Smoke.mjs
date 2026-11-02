// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// curveBuf32Smoke -- the curve texel buffer is float64 only to feed `curves64` (the unrounded twin the CPatch converter reads).
// A context that narrows it to float32 anyway (scene, text run, streaming builders) or an import that opts out of the twin
// (`importSvg(svg, { curves64: false })`) stores float32 from the start: every wire section is byte-identical (rounding at the
// store is the rounding of the final downcast) and only `curves64` is absent. The default import keeps `curves64`, and it is
// the exact unrounded twin of the wire plane.
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
// values that do NOT survive float32 unchanged, arcs, strokes, a gradient and a dash so every record kind is written
let d = 'M0.1234567891 0.3333333333';
for (let i = 0; i < 300; i++)
  d += ` C${(i * 0.1237).toFixed(7)} 3.1415926 ${(i * 0.37).toFixed(7)} 7.7777777 ${(i * 0.11).toFixed(7)} ${(i % 9) + 0.5555555}`;
const SVGS = [
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${d} Z" fill="#c33" stroke="#036" stroke-width="0.7" stroke-dasharray="1.1 0.7"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><ellipse cx="50.1234567" cy="50.7654321" rx="31.2345678" ry="20.5" fill="url(#g)"/><path d="M10.123 10.456 A 20.789 13.321 33 1 0 70.987 60.654 Q 5.55555 80.4444 10.123 10.456 Z" fill="#093"/></svg>`,
];
const mk = () => makeBuildContext({ vBands: true, pairBands: true, aacLevels: true });
for (const [i, svg] of SVGS.entries()) {
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
}
ok(mk().curveBuf.floats instanceof Float64Array, 'a default context keeps a float64 curve buffer');
ok(
  makeBuildContext({ curve64: false }).curveBuf.floats instanceof Float32Array,
  'curve64:false stores float32',
);
process.exit(fail ? 1 : 0);
