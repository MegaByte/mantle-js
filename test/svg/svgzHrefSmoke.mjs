// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgzHrefSmoke.mjs — verify .svgz href decompression helpers
// (gunzipBytes / isGzipped / decodeSvgzBytes).

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';
import { isSvgHref, isGzipped, gunzipBytes, decodeSvgzBytes } from '../../src/svg/image.js';
import zlib from 'zlib';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

const innerSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="purple"/></svg>';
const innerBytes = new Uint8Array(Buffer.from(innerSvg, 'utf8'));
const gzipped = new Uint8Array(zlib.gzipSync(innerBytes));

// ----- T1: isGzipped detects magic ---------------------------------
{
  if (!isGzipped(gzipped)) fail('T1 isGzipped should detect 1f 8b magic');
  else if (isGzipped(innerBytes)) fail('T1 plain bytes should NOT be flagged');
  else ok('T1 isGzipped magic detection');
}

// ----- T2: gunzipBytes round-trip ----------------------------------
{
  const out = await gunzipBytes(gzipped);
  const text = new TextDecoder('utf-8').decode(out);
  if (text !== innerSvg) fail('T2 gunzip text mismatch');
  else ok('T2 gunzipBytes round-trips');
}

// ----- T3: decodeSvgzBytes handles both gzipped and plain ----------
{
  const a = await decodeSvgzBytes(gzipped);
  const b = await decodeSvgzBytes(innerBytes);
  if (a !== innerSvg || b !== innerSvg)
    fail('T3 decodeSvgzBytes should handle gzipped + plain identically');
  else ok('T3 decodeSvgzBytes auto-detects gzip + falls back to plain');
}

// ----- T4: isSvgHref classifies .svgz ------------------------------
{
  if (!isSvgHref('icon.svgz')) fail('T4 isSvgHref must accept .svgz');
  else if (!isSvgHref('/path/to/icon.svgz')) fail('T4 paths');
  else if (!isSvgHref('icon.svgz?v=2')) fail('T4 query strings');
  else ok('T4 isSvgHref accepts .svgz extension variants');
}

// ----- T5: full pipeline — svgTextLoader uses decodeSvgzBytes ------
{
  const outer = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <image x="0" y="0" width="100" height="100" href="icon.svgz"/>
</svg>`;
  // Simulate: loader fetches bytes (gzipped), decodes via decodeSvgzBytes.
  const loader = async (href) => {
    if (href === 'icon.svgz') return await decodeSvgzBytes(gzipped);
    return null;
  };
  const bundle = await importSvg(outer, { svgTextLoader: loader });
  if (!bundle || bundle.numShapes < 1)
    fail(`T5 svgz pipeline: expected shape, got ${bundle?.numShapes}`);
  else ok(`T5 .svgz href via decodeSvgzBytes: ${bundle.numShapes} shape(s) imported`);
}

if (failures > 0) {
  console.error(`\nSVGZ-HREF FAIL (${failures})`);
  process.exit(1);
}
console.log('\nSVGZ-HREF PASS');
