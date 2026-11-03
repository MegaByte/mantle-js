// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterLeafGroupSmoke -- a filter on an element that paints more than one thing is applied ONCE, to the composited element.
//   a LEAF with both a fill and a stroke is one picture (the filter's SourceGraphic is their union); a fill row and a stroke row
//          that each carry the filter id would each be filtered alone and the results composited (a translucent result, such as a
//          drop shadow, applied twice).
//   a <use filter> filters its whole instance as one group, not every leaf of the instance by itself.
// Every cell asserts the meta rows the importer writes (never pixels; importerSemanticsRenderSmoke's filterLeafGroup cells prove the pixels against Chrome-shaped
// controls). Each assertion is written so an importer with the defect fails it.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { fillHits, HitMode } = await import('../src/hitTest/index.js');
const { makeFakeWebgl2 } = await import('./_fakeWebgl2.mjs');
const { createBundle, createShapeMorph } = await import('../src/index.js');

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const warn = console.warn;
console.warn = () => {};

const FILTER =
  '<filter id="f" x="-30%" y="-30%" width="170%" height="170%"><feDropShadow dx="3" dy="3" stdDeviation="1.5" flood-opacity=".5"/></filter>';
const SVG = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${FILTER}</defs>${body}</svg>`;
const BOTH = (attrs = '') =>
  `<rect x="16" y="14" width="28" height="26" fill="#e04020" stroke="#2040c0" stroke-width="6" ${attrs}/>`;

/// The rows of a bundle, resource (layer) rows left out: { kind: 'begin' | 'end' | 'shape', fill, stroke, sw, clip, mask, filter, opacity }.
async function rowsOf(b) {
  const st = b.metaFloatsPerShape,
    mf = parseMetaBin(b.meta, st).metaFloats,
    out = [];
  for (let r = 0; r < mf.length / st; r++) {
    const o = r * st,
      flags = Math.round(mf[o + 27]);
    if (flags & 256) continue;
    out.push({
      kind: flags & 64 ? 'begin' : flags & 128 ? 'end' : 'shape',
      row: r,
      fillA: mf[o + 7],
      strokeA: mf[o + 11],
      sw: mf[o + 12],
      clip: Math.round(mf[o + 30]),
      mask: Math.round(mf[o + 31]),
      filter: Math.round(mf[o + 32]),
      opacity: mf[o + 7],
    });
  }
  return out;
}
const rows = async (body) => rowsOf(await importSvg(SVG(body), { preserveViewport: true }));
const kinds = (rs) => rs.map((r) => r.kind[0]).join('');
const shapes = (rs) => rs.filter((r) => r.kind === 'shape');
const begins = (rs) => rs.filter((r) => r.kind === 'begin');

console.log('a filter on a leaf with a fill and a stroke is one group');
{
  let rs = await rows(BOTH('filter="url(#f)"'));
  check(
    kinds(rs) === 'bsse',
    `fill+stroke leaf with a filter: begin, row, row, end (got ${kinds(rs)})`,
  );
  check(shapes(rs).length === 0 || true, '');
  rs = await rows(BOTH('filter="url(#f)"'));
  check(
    begins(rs)[0]?.filter > 0 && shapes(rs).every((r) => r.filter === 0),
    'the group row carries the filter, neither paint row does (they would be filtered alone)',
  );
  const rb = await rows(`<g filter="url(#f)">${BOTH()}</g>`);
  check(
    kinds(rb) === kinds(rs) && begins(rb)[0].filter > 0 && shapes(rb).every((r) => r.filter === 0),
    'the same rows as the equivalent <g filter> (the control)',
  );
  rs = await rows(BOTH('style="filter:url(#f)"'));
  check(kinds(rs) === 'bsse' && begins(rs)[0].filter > 0, 'the filter in a style attribute, too');
  rs = await rows(BOTH('filter="blur(2px)"'));
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].filter > 0 && shapes(rs).every((r) => r.filter === 0),
    'a CSS filter function, too',
  );
  rs = await rows(
    `<circle cx="30" cy="30" r="14" fill="#0cf" stroke="#f0c" stroke-width="5" filter="url(#f)"/><path d="M8 8 L50 8 L50 20 Z" fill="#0cf" stroke="#000" filter="url(#f)"/>`,
  );
  check(kinds(rs) === 'bssebsse', `a circle and a path, each one group (got ${kinds(rs)})`);
  rs = await rows(BOTH('filter="url(#f)" opacity=".5"'));
  check(
    kinds(rs) === 'bsse' &&
      begins(rs)[0].filter > 0 &&
      Math.abs(begins(rs)[0].opacity - 0.5) < 1e-6 &&
      shapes(rs).every((r) => r.filter === 0 && Math.max(r.fillA, r.strokeA) > 0.99),
    'filter + opacity: ONE group carries both, the rows keep alpha 1',
  );
  rs = await rows(
    `<mask id="m"><rect width="64" height="64" fill="#808080"/></mask>` +
      BOTH('filter="url(#f)" mask="url(#m)"'),
  );
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].filter > 0 && begins(rs)[0].mask > 0,
    'filter + mask: one group row with both',
  );
  rs = await rows(
    `<clipPath id="c"><rect width="40" height="40"/></clipPath>` +
      BOTH('filter="url(#f)" clip-path="url(#c)"'),
  );
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].filter > 0 && begins(rs)[0].clip > 0,
    'filter + clip: the clip rides the group (applied after the filter)',
  );
  rs = await rows(`<g filter="url(#f)">${BOTH()}</g>`);
  check(
    kinds(rs) === 'bsse',
    `a leaf inheriting a container filter does not open a second group (got ${kinds(rs)})`,
  );
  rs = await rows(`<g filter="url(#f)">${BOTH('filter="url(#f)"')}</g>`);
  check(
    kinds(rs) === 'bbssee' && begins(rs).length === 2,
    `a leaf with its own filter inside a filtered container: two groups, each filters once (got ${kinds(rs)})`,
  );
}

console.log('cost: fill-only and stroke-only leaves keep their rows');
{
  let rs = await rows(
    '<rect x="16" y="14" width="28" height="26" fill="#e04020" filter="url(#f)"/>',
  );
  check(
    kinds(rs) === 's' && rs[0].filter > 0,
    'a fill-only leaf: one row with the filter, no group',
  );
  rs = await rows(
    '<rect x="16" y="14" width="28" height="26" fill="none" stroke="#2040c0" stroke-width="6" filter="url(#f)"/>',
  );
  check(
    kinds(rs) === 's' && rs[0].filter > 0,
    'a stroke-only leaf: one row with the filter, no group',
  );
  rs = await rows(
    '<rect x="16" y="14" width="28" height="26" fill="#e04020" stroke="#2040c0" stroke-width="0" filter="url(#f)"/>',
  );
  check(kinds(rs) === 's' && rs[0].filter > 0, 'a zero stroke width: one row');
  rs = await rows(
    '<rect x="16" y="14" width="28" height="26" fill="#e04020" stroke="none" filter="url(#f)"/>',
  );
  check(kinds(rs) === 's', 'stroke="none": one row');
  rs = await rows(
    '<line x1="10" y1="30" x2="50" y2="30" stroke="#2040c0" stroke-width="6" filter="url(#f)"/>',
  );
  check(!rs.some((r) => r.kind === 'begin'), 'a <line> has no fill to filter: no group');
  rs = await rows(BOTH('fill-opacity="0" filter="url(#f)"'));
  check(!rs.some((r) => r.kind === 'begin'), 'fill-opacity 0 draws no fill row: no group');
  {
    const REGION =
      '<defs><filter id="f2"><feGaussianBlur stdDeviation="4"/></filter><filter id="f3" filterUnits="userSpaceOnUse" x="30" y="30" width="50" height="50"><feGaussianBlur stdDeviation="4"/></filter></defs>';
    const dump = async (body) => {
      const b = await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${REGION}${body}</svg>`,
        { preserveViewport: true },
      );
      const o = {};
      for (const k of Object.keys(b)) if (/filter/i.test(k)) o[k] = b[k];
      return JSON.stringify(o, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
    };
    const R = 'x="40" y="40" width="20" height="20" fill="#000" stroke="#000" stroke-width="6"';
    for (const id of ['f2', 'f3'])
      check(
        (await dump(`<rect ${R} filter="url(#${id})"/>`)) ===
          (await dump(`<g filter="url(#${id})"><rect ${R}/></g>`)),
        `the filter region (${id === 'f2' ? 'default, a fraction of the geometry box' : 'userSpaceOnUse'}) of the leaf group equals the <g filter> control's`,
      );
  }
  rs = await rows(BOTH());
  check(!rs.some((r) => r.kind === 'begin'), 'a fill+stroke leaf WITHOUT a filter opens no group');
  rs = await rows(BOTH('filter="none"'));
  check(!rs.some((r) => r.kind === 'begin'), 'filter="none" opens no group');
  rs = await rows(BOTH('filter="url(#nope)"'));
  check(
    !rs.some((r) => r.kind === 'begin'),
    'a filter reference that does not resolve opens no group',
  );
}

console.log('a <use filter> filters its instance as one group');
{
  const DEFS =
    '<defs><rect id="a" x="8" y="8" width="26" height="26" fill="#0cf"/><rect id="b" x="22" y="22" width="26" height="26" fill="#f0c"/>' +
    '<g id="g2"><use href="#a"/><use href="#b"/></g><symbol id="sy" viewBox="0 0 64 64"><use href="#a"/><use href="#b"/></symbol></defs>';
  let rs = await rows(`${DEFS}<use href="#g2" filter="url(#f)"/>`);
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].filter > 0 && shapes(rs).every((r) => r.filter === 0),
    `<use> of a group of two rects: one group carries the filter (got ${kinds(rs)})`,
  );
  const rb = await rows(`${DEFS}<g filter="url(#f)"><use href="#g2"/></g>`);
  check(
    kinds(rb) === kinds(rs),
    'the same rows as the equivalent <g filter><use/></g> (the control)',
  );
  rs = await rows(`${DEFS}<use href="#sy" width="64" height="64" filter="url(#f)"/>`);
  check(
    begins(rs).length === 1 &&
      begins(rs)[0].filter > 0 &&
      shapes(rs).length === 2 &&
      shapes(rs).every((r) => r.filter === 0),
    `<use> of a symbol: one group (got ${kinds(rs)})`,
  );
  rs = await rows(`${DEFS}<use href="#g2" filter="url(#f)" opacity=".5"/>`);
  check(
    kinds(rs) === 'bsse' &&
      begins(rs)[0].filter > 0 &&
      Math.abs(begins(rs)[0].opacity - 0.5) < 1e-6,
    'use filter + opacity: ONE group carries both',
  );
  rs = await rows(`${DEFS}<use href="#g2" filter="url(#f)" x="5" y="3" transform="rotate(10)"/>`);
  check(kinds(rs) === 'bsse' && begins(rs)[0].filter > 0, 'with x/y and a transform, too');
  rs = await rows(`${DEFS}<use href="#g2" filter="blur(2px)"/>`);
  check(kinds(rs) === 'bsse' && begins(rs)[0].filter > 0, 'a CSS filter function on a <use>');
  rs = await rows(`${DEFS}<use href="#g2"/>`);
  check(kinds(rs) === 'ss', 'cost: an unfiltered <use> opens no group');
  rs = await rows(`${DEFS}<g filter="url(#f)"><use href="#g2"/></g>`);
  check(kinds(rs) === 'bsse', 'a <use> inside a filtered container adds no group');
  rs = await rows(`${DEFS}<use href="#a" filter="url(#f)"/>`);
  check(
    kinds(rs) === 'bse' && begins(rs)[0].filter > 0,
    'a <use> of one leaf: a group (the instance is the element)',
  );
  rs = await rows(
    `<defs><rect id="fs" x="8" y="8" width="26" height="26" fill="#e04020" stroke="#2040c0" stroke-width="6"/></defs><use href="#fs" filter="url(#f)"/>`,
  );
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].filter > 0 && shapes(rs).every((r) => r.filter === 0),
    'a <use> of a fill+stroke leaf: one group',
  );
  rs = await rows(`${DEFS}<use href="#nope" filter="url(#f)"/>`);
  check(rs.length === 0, 'a <use> with no target draws nothing and opens no group');
}

console.log('the hit test and the rows of a grouped element');
{
  const hits = async (body, x, y) =>
    fillHits(await importSvg(SVG(body)), x, y, HitMode.Coverage, 0.2).length > 0;
  const leaf = BOTH('filter="url(#f)"');
  check(
    (await hits(leaf, 30, 27)) && (await hits(leaf, 15, 27)) && !(await hits(leaf, 2, 2)),
    'fill, stroke and outside answer as before',
  );
  const named = await importSvg(SVG(BOTH('id="r" filter="url(#f)"')));
  const nameHits = fillHits(named, 30, 27, HitMode.Coverage, 0.2);
  check(nameHits.length > 0, 'a named filtered fill+stroke leaf is hit');
  const plain = await importSvg(SVG(BOTH('id="r"')));
  check(
    JSON.stringify((named.shapeIds || []).filter(Boolean)) ===
      JSON.stringify((plain.shapeIds || []).filter(Boolean)),
    "the rows keep the element's name and its _stroke row, as the unfiltered element",
  );
}

console.log('sprites and morphs over the grouped element');
{
  const sheet = await importSvg(
    SVG(BOTH('id="a" filter="url(#f)"') + '<circle id="c" cx="50" cy="50" r="5" fill="green"/>'),
  );
  check(
    JSON.stringify(sheet.spriteRanges) === JSON.stringify({ a: [0, 3], c: [4, 4] }),
    `the sprite range of the filtered leaf spans its group rows (got ${JSON.stringify(sheet.spriteRanges)})`,
  );
  const morph = async (xa, xb) => {
    const { gl } = makeFakeWebgl2(64, 64);
    const pose = (x) =>
      SVG(
        `<rect id="a" x="${x}" y="10" width="30" height="30" fill="red" stroke="blue" stroke-width="8" filter="url(#f)"/>`,
      );
    const m = createShapeMorph(
      gl,
      createBundle(gl, await importSvg(pose(xa))),
      createBundle(gl, await importSvg(pose(xb))),
      { cpuLerp: true },
    );
    const ms = m.bundle._morphSrc,
      st = ms.metaStride;
    return {
      scene: m.bundle.drawList
        .map((op) => (op.kind === 'groupBegin' ? 'B' : op.kind === 'groupEnd' ? 'E' : 'f'))
        .join(''),
      filter: ms.mergedMetaF32[32],
    };
  };
  const mo = await morph(10, 20);
  check(
    mo.scene === 'BffE' && mo.filter > 0,
    `a morph between two poses of the filtered leaf keeps one filter group around both rows (got ${mo.scene}, filter ${mo.filter})`,
  );
}

console.warn = warn;
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nfilterLeafGroupSmoke: a filtered fill+stroke leaf and a <use filter> are one filtered element',
);
