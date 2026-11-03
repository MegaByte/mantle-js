// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gzipBombSmoke.mjs — the decompress limit must bound MEMORY, not just report.
//
// gunzipBytes inflates untrusted content: .svgz images (svg/image.js) and
// SVG-in-OpenType glyphs (font/textRun.js). Both can come straight from an
// asset a user opened.
//
// Buffering the whole stream with `new Response(stream).arrayBuffer()` and
// measuring it afterwards throws the right error at the wrong time — the bomb
// is fully allocated before the check runs: a 200 KB gzip of zeros drives
// 658 MB of RSS against a 64 MB limit, so the "limit" bounds nothing. On a
// browser tab that is an out-of-memory kill rather than a caught error.
//
// A test that only asserts "it throws" passes against buffering code. So this
// measures the ALLOCATION as well, which is the property that actually
// matters, and pins the round trip so the streaming decoder can't quietly
// corrupt ordinary payloads.
//
// GL-free (fast node lane). Node exposes DecompressionStream, so this exercises
// the same branch a browser takes.

import zlib from 'node:zlib';
import { gunzipBytes } from '../src/core/gzip.js';
import { MAX_DECOMPRESS_BYTES } from '../src/core/decompress.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

if (typeof DecompressionStream === 'undefined') {
  console.log(
    'SKIP gzipBombSmoke — no DecompressionStream, the guarded branch is unreachable here',
  );
  process.exit(0);
}

const MB = 1048576;

// ---- T1: ordinary payloads still round-trip exactly --------------------
// First, because a "safe" decompressor that corrupts real input is worse than
// the bomb it prevents.
{
  const cases = [
    ['empty', Buffer.alloc(0)],
    ['small', Buffer.from('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')],
    // Comfortably more than one stream chunk, so the multi-chunk concat path runs.
    ['multi-chunk', Buffer.from('<svg>' + 'x'.repeat(3 * MB) + '</svg>')],
    ['binary', Buffer.from(Array.from({ length: 100000 }, (_, i) => (i * 31) & 0xff))],
  ];
  const bad = [];
  for (const [name, buf] of cases) {
    const out = await gunzipBytes(new Uint8Array(zlib.gzipSync(buf)));
    if (!Buffer.from(out).equals(buf))
      bad.push(`${name}: ${out.length} bytes, expected ${buf.length}`);
  }
  if (!bad.length)
    ok(`T1 ${cases.length} payloads round-trip byte-identically (incl. multi-chunk)`);
  else for (const b of bad) fail(`T1 ${b}`);
}

// ---- T2: a bomb is refused, and BOUNDED while being refused ------------
{
  // ~200 KB in, 200 MB out — comfortably past the limit.
  const bomb = new Uint8Array(zlib.gzipSync(Buffer.alloc(200 * MB, 0)));

  if (global.gc) global.gc();
  const before = process.memoryUsage().rss;
  let threw = null;
  try {
    await gunzipBytes(bomb);
  } catch (e) {
    threw = e;
  }
  const delta = (process.memoryUsage().rss - before) / MB;

  if (!threw) {
    fail(
      `T2 a ${bomb.length}-byte input inflated past the ${MAX_DECOMPRESS_BYTES}-byte limit without throwing`,
    );
  } else if (!/exceeds .* decompress limit/.test(threw.message)) {
    fail(`T2 threw the wrong error: ${threw.message}`);
  } else {
    ok(`T2 bomb refused (${threw.message})`);
  }

  // The allocation is the property under test. Buffering-then-checking costs 658 MB
  // here; streaming-and-checking costs ~106 MB. 300 MB separates them by a wide
  // margin without being tight enough to flake on GC timing.
  if (threw && delta > 300) {
    fail(
      `T2 refusing the bomb still allocated ${delta.toFixed(0)} MB — ` +
        'the whole stream was buffered before the limit was applied',
    );
  } else if (threw) {
    ok(`T2 refusing it cost ${delta.toFixed(0)} MB, not the full inflated size`);
  }
}

// ---- T3: the guard is not simply refusing everything large -------------
// T2 would also pass if gunzipBytes rejected any sizeable input. Inflate
// something well over a chunk but under the limit and require it through.
{
  const big = Buffer.alloc(8 * MB, 0x41);
  const out = await gunzipBytes(new Uint8Array(zlib.gzipSync(big)));
  if (out.length === big.length && Buffer.from(out).equals(big)) {
    ok(`T3 an 8 MB payload under the limit still inflates (T2 is not a blanket refusal)`);
  } else {
    fail(`T3 an 8 MB payload under the limit was mangled: got ${out.length} bytes`);
  }
}

// PNG glyphs share the bounded zlib inflater and must preserve straight RGBA.
{
  const { decodePng } = await import('../src/core/png.js');
  const { inflateZlibBytes } = await import('../src/core/gzip.js');
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQjz75HwAEAwI7AZm8YgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const image = await decodePng(png);
  if (image.w !== 1 || image.h !== 1 || Array.from(image.rgba).join() !== '23,91,201,255')
    fail('PNG glyph pixels changed');
  const oversized = png.slice();
  new DataView(oversized.buffer).setUint32(16, 65536);
  new DataView(oversized.buffer).setUint32(20, 65536);
  let rejected = false;
  try {
    await decodePng(oversized);
  } catch (e) {
    rejected = /decompress limit/.test(e.message);
  }
  if (!rejected) fail('PNG dimensions must be checked before raster allocation');
  const saved = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    const raw = Buffer.from([1, 2, 3, 4]);
    const out = await inflateZlibBytes(new Uint8Array(zlib.deflateSync(raw)));
    if (!Buffer.from(out).equals(raw)) fail('Node zlib fallback changed bytes');
  } finally {
    globalThis.DecompressionStream = saved;
  }
}

console.log();
console.log(failures === 0 ? 'GZIP-BOMB PASS' : `GZIP-BOMB FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
