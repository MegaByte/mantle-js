// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lengthIntegrationSmoke.mjs — verify calc() / min() / max() / clamp()
// actually flow through the importer's attribute reads into the bundle.
// Spot-checks key surfaces: rect dimensions, stroke-width,
// font-size, feOffset, gradient stop offset.

import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { importSvg } from '../../src/svg/importer.js';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}
function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

const META_STRIDE = 48;
async function importToMeta(svg) {
  const sections = await importSvg(svg, {});
  if (!sections) throw new Error('importer returned null');
  return {
    sections,
    meta: new Float32Array(sections.meta, 32),
  };
}

// === T1: rect width = calc(100 - 20) ================================
// Bare-number calc — no parent context needed. Expected w = 80, so the
// rect's bbox spans x=[10, 90].
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="10" y="20" width="calc(100 - 20)" height="60" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  // Texel 0 = bbox (xmin, ymin, xmax, ymax).
  const xmin = meta[0],
    ymin = meta[1],
    xmax = meta[2],
    ymax = meta[3];
  if (approx(xmin, 10) && approx(xmax, 90) && approx(ymin, 20) && approx(ymax, 80))
    ok(`T1 calc(100 - 20) width → rect bbox (${xmin},${ymin},${xmax},${ymax})`);
  else fail(`T1 expected (10,20,90,80); got (${xmin},${ymin},${xmax},${ymax})`);
}

// === T2: rect dims via min() / max() ================================
// width = max(30, 50) = 50; height = min(100, 40) = 40.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="0" y="0" width="max(30, 50)" height="min(100, 40)" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  const xmax = meta[2],
    ymax = meta[3];
  if (approx(xmax, 50) && approx(ymax, 40))
    ok(`T2 max(30, 50) / min(100, 40) → rect bbox ymax=${ymax}, xmax=${xmax}`);
  else fail(`T2 expected (50, 40); got (${xmax}, ${ymax})`);
}

// === T3: clamp() on a coordinate ====================================
// x = clamp(0, 80, 50) → 50 (above ceiling).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="clamp(0, 80, 50)" y="0" width="20" height="20" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  const xmin = meta[0],
    xmax = meta[2];
  if (approx(xmin, 50) && approx(xmax, 70)) ok(`T3 clamp(0, 80, 50) → x=50, rect span=[50, 70]`);
  else fail(`T3 expected xmin=50, xmax=70; got (${xmin}, ${xmax})`);
}

// === T4: stroke-width via calc ======================================
// The stroke meta row carries strokeWidth at texel 3.x (offset 12).
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="0" y="0" width="50" height="50" fill="none" stroke="black" stroke-width="calc(2 + 3)"/>
</svg>`;
  const { meta, sections } = await importToMeta(svg);
  // fill="none" → only the stroke row is emitted. Scan the meta rows
  // for one whose strokeWidth (texel 3.x = offset 12) is non-zero.
  let strokeWidth = 0;
  for (let i = 0; i < sections.numShapes; i++) {
    const w = meta[i * META_STRIDE + 12];
    if (w > 0) {
      strokeWidth = w;
      break;
    }
  }
  if (approx(strokeWidth, 5)) ok(`T4 calc(2 + 3) stroke-width → ${strokeWidth}`);
  else fail(`T4 expected strokeWidth=5; got ${strokeWidth} (numShapes=${sections.numShapes})`);
}

// === T5: circle r via calc ==========================================
// r = calc(20 + 10) = 30 → circle bbox is (cx-30, cy-30, cx+30, cy+30)
// with cx=100, cy=100.
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="calc(20 + 10)" fill="blue"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  const xmin = meta[0],
    xmax = meta[2];
  if (approx(xmin, 70) && approx(xmax, 130)) ok(`T5 circle r=calc(20 + 10) → bbox x=[70, 130]`);
  else fail(`T5 expected x=[70, 130]; got [${xmin}, ${xmax}]`);
}

// === T6: bare numbers still work ====================================
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="10" y="10" width="80" height="80" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  if (approx(meta[0], 10) && approx(meta[2], 90)) ok(`T6 bare-number attrs still parse correctly`);
  else fail(`T6 regression: bbox = ${meta.slice(0, 4)}`);
}

// === T7: pixel unit suffix preserved =================================
{
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="10px" y="10" width="80px" height="80" fill="red"/>
</svg>`;
  const { meta } = await importToMeta(svg);
  if (approx(meta[0], 10) && approx(meta[2], 90))
    ok(`T7 "10px"/"80px" → bare numbers (px = user units)`);
  else fail(`T7 px regression: bbox = ${meta.slice(0, 4)}`);
}

// The shader tag must describe the same resolved corners as the curve geometry.
for (const [attrs, kind, radius] of [
  ['rx="10%"', 3, 20],
  ['ry="10%"', 3, 10],
  ['rx="calc(10 + 10)"', 3, 20],
  ['rx="15pt"', 3, 20],
  ['rx="100"', 0, 0],
  ['rx="20" ry="0"', 2, 0],
  ['rx="-1" ry="10"', 3, 10],
  ['rx="auto" ry="10"', 3, 10],
]) {
  const { meta } = await importToMeta(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="80" height="40" ${attrs}/></svg>`,
  );
  if (meta[44] === kind && approx(meta[46], radius)) ok(`rect radii ${attrs}`);
  else fail(`rect ${attrs}: expected tag ${kind}/${radius}, got ${meta[44]}/${meta[46]}`);
}

// A nested viewport changes percentage units only for its descendants.
for (const symbol of [false, true]) {
  const rect = '<rect width="50%" height="10"/>';
  const inner = symbol
    ? `<defs><symbol id="v" viewBox="0 0 100 50" overflow="visible">${rect}</symbol></defs><use href="#v" width="200" height="100"/>`
    : `<svg width="200" height="100" viewBox="0 0 100 50" overflow="visible">${rect}</svg>`;
  const { meta } = await importToMeta(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600">${inner}<rect x="300" width="50%" height="10"/></svg>`,
  );
  const expected = [
    [0, 0, 100, 20],
    [300, 0, 800, 10],
  ];
  if (
    expected.every((box, row) => box.every((v, axis) => approx(meta[row * META_STRIDE + axis], v)))
  )
    ok(`nested ${symbol ? 'symbol' : 'svg'} percentage scope and sibling restoration`);
  else
    fail(
      `nested viewport percentage scope: ${Array.from(meta.slice(0, 4))} / ${Array.from(meta.slice(META_STRIDE, META_STRIDE + 4))}`,
    );
}

for (const inner of [
  '<svg viewBox="0 0 50 50"><rect width="50%" height="50%"/></svg>',
  '<defs><symbol id="v" viewBox="0 0 50 50"><rect width="50%" height="50%"/></symbol></defs><use href="#v"/>',
]) {
  const { meta } = await importToMeta(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">${inner}</svg>`,
  );
  if ([50, 0, 100, 50].every((v, axis) => approx(meta[axis], v)))
    ok('implicit nested viewport extents');
  else fail(`implicit viewport bbox: ${Array.from(meta.slice(0, 4))}`);
}

// Content-bounds imports have no parent viewport to supply default extents.
for (const inner of [
  '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  '<svg width="50%" height="50%" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  '<defs><symbol id="v" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs><use href="#v"/>',
  '<defs><symbol id="v" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs><use href="#v" width="50%" height="50%"/>',
]) {
  const { meta } = await importToMeta(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);
  if ([0, 0, 10, 10].every((v, axis) => approx(meta[axis], v)))
    ok('unknown parent viewport retains content bounds');
  else fail(`unknown parent viewport bbox: ${Array.from(meta.slice(0, 4))}`);
}

for (const attrs of ['stroke-width="10%"', 'stroke-width="calc(5% + 6)"']) {
  const { meta } = await importToMeta(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M8 32H100" fill="none" stroke="black" ${attrs}/></svg>`,
  );
  if (approx(meta[12], 12)) ok(`stroke normalized-diagonal length ${attrs}`);
  else fail(`stroke width expected 12, got ${meta[12]}`);
}
{
  const { getStrokeDashes } = await import('../../src/svg/style.js');
  const element = new DP().parseFromString(
    '<path stroke-dasharray="calc(4 + 4) min(6,4)" stroke-dashoffset="calc(2% + 1)"/>',
    'text/xml',
  ).documentElement;
  const d = getStrokeDashes(element, { parentWidth: 120, parentHeight: 120 });
  if (d.dashArray.join(',') === '8,4' && approx(d.dashOffset, 3.4))
    ok('stroke dash math retains complete list values');
  else fail(`stroke dash math: ${JSON.stringify(d)}`);
}

// CSS-wide values and invalid declarations retain inherited lengths in the local viewport.
{
  const norm = Math.hypot(100, 50) / Math.SQRT2;
  for (const token of ['unset', 'inherit', '-2', 'bad']) {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g stroke-width="10%"><svg width="100" height="50" viewBox="0 0 100 50" stroke-width="${token}"><path d="M8 25H88" fill="none" stroke="black"/></svg></g></svg>`;
    const b = await importSvg(source, { preserveViewport: true });
    const f = new Float32Array(b.meta, 32);
    if (approx(f[12], norm * 0.1, 1e-5)) ok(`${token}: inherited width resolves in local viewport`);
    else fail(`${token}: inherited width ${f[12]} != ${norm * 0.1}`);
  }
  const { getStrokeDashes } = await import('../../src/svg/style.js');
  for (const token of ['unset', 'inherit', 'bad', '2 -1']) {
    const doc = new DP().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg"><g stroke-dasharray="4% 2%" stroke-dashoffset="3%"><path stroke-dasharray="${token}" stroke-dashoffset="${token === '2 -1' ? 'bad' : token}"/></g></svg>`,
      'image/svg+xml',
    );
    const d = getStrokeDashes(doc.getElementsByTagName('path')[0], {
      parentWidth: 100,
      parentHeight: 50,
    });
    if (
      d.dashArray.length === 2 &&
      approx(d.dashArray[0], norm * 0.04) &&
      approx(d.dashOffset, norm * 0.03)
    )
      ok(`${token}: inherited dash lengths remain in local viewport`);
    else fail(`${token}: inherited dashes ${JSON.stringify(d)}`);
  }
}

console.log();
// Non-scaling dashes resolve inherited lengths and offsets in host stroke space.
{
  const { fillHitShape, HitMode } = await import('../../src/hitTest/index.js');
  for (const nss of [false, true])
    for (const offset of [0, 3, -3]) {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g stroke-dasharray="8 4" stroke-dashoffset="' +
        offset +
        '"><path d="M8 0H24" transform="matrix(2 0 0 2 0 32.25)" fill="none" stroke="red" stroke-width="8" ' +
        (nss ? 'vector-effect="non-scaling-stroke"' : '') +
        '/></g></svg>';
      const b = await importSvg(svg, { preserveViewport: true }),
        d = new Float32Array(b.dashes),
        scale = nss ? 1 : 2;
      if (
        d[0] === 12 * scale &&
        d[2] === offset * scale &&
        d[4] === 8 * scale &&
        d[5] === 4 * scale
      )
        ok('dash host/local metrics ' + nss + ' offset ' + offset);
      else fail('dash host/local metrics ' + nss + ': ' + Array.from(d.slice(0, 6)));
      if (nss && offset === 0) {
        const ink = fillHitShape(b, 20, 32.25, { mode: HitMode.Outline }) >= 0;
        const gap = fillHitShape(b, 26, 32.25, { mode: HitMode.Outline }) >= 0;
        if (ink && !gap) ok('non-scaling dash CPU hit distinguishes ink and gap');
        else fail('non-scaling dash CPU hit ' + ink + '/' + gap);
        const worldMatrix = [2, 0, 0, 0, 2, 0, 0, 0, 1];
        const worldGap = fillHitShape(b, 42, 64.5, { mode: HitMode.Outline, worldMatrix }) >= 0;
        const worldInk = fillHitShape(b, 46, 64.5, { mode: HitMode.Outline, worldMatrix }) >= 0;
        if (!worldGap && worldInk)
          ok('world-transformed non-scaling CPU dash phase is pixel-sized');
        else fail('world non-scaling dash phase ' + worldGap + '/' + worldInk);
      }
    }
}

console.log(failures === 0 ? 'LENGTH-INTEGRATION PASS' : `LENGTH-INTEGRATION FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
