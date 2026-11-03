// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeInkBBoxSmoke -- globalBBox holds the stroke's INK, miter tips and square-cap corners included, so a
// renderer that fits the content box (setViewport + drawBundle) does not crop them. The stroke ROW's bbox stays path +- halfW
// (the box the shader indexes the row's bands through), and a bundle whose ink stays inside path +- halfW is unchanged.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const imp = (d, attrs, o = {}) =>
  importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${d}" fill="none" stroke="#000" ${attrs}/></svg>`,
    o,
  );
const box = (b) => {
  const g = Array.from(b.globalBBox);
  return [g[0], g[1], g[0] + g[2], g[1] + g[3]];
};
const rowBox = (b) => {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  return [0, 1, 2, 3].map((i) => pm.metaFloats[i]);
};

console.log('miter tip');
{
  // 67.4 degree corner, half width 5, limit 10: tip at 20 - 5 / sin(33.7 deg) = 10.986
  const b = await imp('M10 80 L50 20 L90 80', 'stroke-width="10" stroke-miterlimit="10"');
  const r = 5 / Math.sin(Math.atan(40 / 60));
  check(
    near(box(b)[1], 20 - r),
    `miter spike inside globalBBox (y0 ${box(b)[1].toFixed(3)} vs ${(20 - r).toFixed(3)})`,
  );
  check(
    near(box(b)[0], 5) && near(box(b)[2], 95) && near(box(b)[3], 85),
    'other sides stay path +- halfW',
  );
  check(
    near(rowBox(b)[1], 15) && near(rowBox(b)[0], 5),
    'the stroke row bbox stays path +- halfW (wire unchanged)',
  );
  const lim = await imp('M10 80 L50 20 L90 80', 'stroke-width="10" stroke-miterlimit="1.5"');
  check(near(box(lim)[1], 15), 'a miter past its limit bevels: no growth');
  const clip = await imp(
    'M10 80 L50 20 L90 80',
    'stroke-width="10" stroke-linejoin="miter-clip" stroke-miterlimit="1.5"',
  );
  check(
    box(clip)[1] < 15 - 1e-3 && box(clip)[1] > 20 - r,
    `miter-clip past its limit grows to the clip line (y0 ${box(clip)[1].toFixed(3)})`,
  );
  const rnd = await imp(
    'M10 80 L50 20 L90 80',
    'stroke-width="10" stroke-linejoin="round" stroke-miterlimit="10"',
  );
  check(near(box(rnd)[1], 15), 'a round join: no growth');
  const closed = await imp('M50 20 L90 80 L10 80 Z', 'stroke-width="10" stroke-miterlimit="10"');
  check(
    box(closed)[1] < 15 - 1e-3,
    `closed triangle: the apex tip counts (y0 ${box(closed)[1].toFixed(3)})`,
  );
  const sq = await imp('M20 20 L80 20 L80 80', 'stroke-width="10"');
  check(
    near(box(sq)[0], 15) && near(box(sq)[2], 85) && near(box(sq)[1], 15) && near(box(sq)[3], 85),
    'a 90 degree miter stays inside path +- halfW',
  );
}

console.log('square cap');
{
  const b = await imp('M20 20 L80 80', 'stroke-width="20" stroke-linecap="square"');
  const e = 10 * Math.SQRT2; // the corner sits halfW * (t +- n) from the end: 10 * sqrt(2) along x for a diagonal
  check(
    near(box(b)[2], 80 + e) &&
      near(box(b)[3], 80 + e) &&
      near(box(b)[0], 20 - e) &&
      near(box(b)[1], 20 - e),
    `diagonal square cap corners inside globalBBox (${box(b).map((v) => v.toFixed(2))})`,
  );
  const ax = await imp('M20 50 L80 50', 'stroke-width="20" stroke-linecap="square"');
  check(
    near(box(ax)[0], 10) && near(box(ax)[2], 90) && near(box(ax)[1], 40) && near(box(ax)[3], 60),
    'axis-aligned square cap: path +- halfW, unchanged',
  );
  const butt = await imp('M20 20 L80 80', 'stroke-width="20"');
  check(near(box(butt)[0], 10) && near(box(butt)[2], 90), 'butt cap: unchanged');
  const dashed = await imp(
    'M20 20 L80 80',
    'stroke-width="20" stroke-linecap="square" stroke-dasharray="10 10"',
  );
  check(box(dashed)[2] > 90 + 1e-3, 'dashed square caps: the end corners count');
  const dashedButt = await imp('M20 20 L80 80', 'stroke-width="20" stroke-dasharray="10 10"');
  check(near(box(dashedButt)[2], 90), 'dashed butt caps: unchanged');
}

console.log('stroke space (a non-uniform scale)');
{
  // drawn in STROKE SPACE (sMax = 3): the stroke is an ordinary one of the local path, so the tip is local (50, 20 - r) = document
  // (50, 3 * (20 - r)); the row's box (path +- sMax * halfW = 15 in every direction) stops at 45, the tip is at 32.96
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 300"><g transform="scale(1 3)"><path d="M10 80 L50 20 L90 80" fill="none" stroke="#000" stroke-width="10" stroke-miterlimit="10"/></g></svg>';
  const b = await importSvg(svg);
  const r = 5 / Math.sin(Math.atan(40 / 60)),
    g = box(b);
  check(
    near(g[1], 3 * (20 - r)),
    `a framed miter tip is found through the frame (y0 ${g[1].toFixed(3)} vs ${(3 * (20 - r)).toFixed(3)})`,
  );
  check(near(rowBox(b)[1], 45), 'the row bbox is unchanged');
}

console.log('viewBox and wire');
{
  const b = await imp('M10 80 L50 20 L90 80', 'stroke-width="10" stroke-miterlimit="10"', {
    preserveViewport: true,
  });
  check(
    near(box(b)[0], 0) && near(box(b)[1], 0) && near(box(b)[2], 100) && near(box(b)[3], 100),
    'preserveViewport: the viewBox, as before',
  );
  const clipped = await imp('M10 3 L50 -40 L90 3', 'stroke-width="10" stroke-miterlimit="10"');
  check(box(clipped)[1] >= 0, 'default mode still clamps the ink to the viewBox');
}

if (failures) {
  console.error(`strokeInkBBoxSmoke: ${failures} FAILED`);
  process.exit(1);
}
console.log('strokeInkBBoxSmoke: ok');
