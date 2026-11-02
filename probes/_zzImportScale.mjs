// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does a <g transform="scale(S)"> get BAKED into the curve buffer, or carried as a world matrix?
// The frame probe scales that way; the stage probes scale the contours directly. If the importer
// keeps the transform, the two are exercising different code and the stage result does not cover
// the frame result.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
const RAW = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const scaled = (k) => {
  const S = 2 ** k;
  const m = RAW.match(/viewBox\s*=\s*"([^"]+)"/);
  const vb = m
    ? m[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [0, 0, 900, 900];
  const body = RAW.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map((v) => v * S).join(' ')}"><g transform="scale(${S})">${body}</g></svg>`;
};
for (const k of [0, 4]) {
  const sec = await importSvg(scaled(k), { preserveViewport: true });
  const c = new Float32Array(sec.curves);
  const r = sec.curveRangesByShape.find(Boolean);
  const b = r ? r.begin | 0 : 0;
  console.log(
    `2^${k}: len=${c.length} first shape begin=${b} vals=${Array.from(c.slice(b, b + 8))
      .map((v) => (+v).toPrecision(8))
      .join(' ')}`,
  );
}
