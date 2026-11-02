// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// compositingGroupSmoke -- the importer records of the compositing rules (mask on a group, markers
// under the element's opacity, filter and mask and under the <marker>'s own opacity, context-fill / context-stroke).
// Every cell asserts the meta rows the importer writes (group scaffolding, ids, colors), never pixels; compositingGroupRenderSmoke proves
// the pixels against controls. Each assertion is written so an importer with the defect fails it.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { fillHits, HitMode } = await import('../src/hitTest/index.js');

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const warn = console.warn;
console.warn = () => {};

const MASK = '<mask id="m"><rect width="64" height="64" fill="#808080"/></mask>';
const MASK2 = '<mask id="m2"><rect width="64" height="64" fill="#404040"/></mask>';
const WHITE_MASK =
  '<mask id="w"><path d="M0 0H64V64H0Z" fill="white"/><circle cx="9" cy="9" r="3" fill="#000"/></mask>';
const TWO =
  '<rect width="40" height="40" fill="#0cf"/><rect x="20" y="20" width="40" height="40" fill="#f0c"/>';
const MARK = (attrs = '', inner = '<circle cx="5" cy="5" r="5" fill="#f00"/>', id = 'k') =>
  `<marker id="${id}" markerWidth="10" markerHeight="10" refX="5" refY="5" markerUnits="userSpaceOnUse" ${attrs}>${inner}</marker>`;
const PATH = (attrs = '', m = 'k') =>
  `<path d="M8 32 H56" stroke="#00f" stroke-width="8" fill="none" marker-start="url(#${m})" marker-end="url(#${m})" ${attrs}/>`;

/// The rows of a bundle, resource (layer) rows left out: { kind: 'begin' | 'end' | 'shape', fill, stroke, sw, clip, mask, filter, opacity }.
async function rows(body) {
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
    { preserveViewport: true },
  );
  const st = b.metaFloatsPerShape,
    mf = parseMetaBin(b.meta, st).metaFloats,
    out = [];
  for (let r = 0; r < mf.length / st; r++) {
    const o = r * st,
      flags = Math.round(mf[o + 27]);
    if (flags & 256) continue;
    out.push({
      kind: flags & 64 ? 'begin' : flags & 128 ? 'end' : 'shape',
      fill: Array.from(mf.slice(o + 4, o + 8)).map((v) => +v.toFixed(3)),
      stroke: Array.from(mf.slice(o + 8, o + 12)).map((v) => +v.toFixed(3)),
      sw: mf[o + 12],
      clip: Math.round(mf[o + 30]),
      mask: Math.round(mf[o + 31]),
      filter: Math.round(mf[o + 32]),
      opacity: mf[o + 7],
    });
  }
  return out;
}
const kinds = (rs) => rs.map((r) => r.kind[0]).join('');
const shapes = (rs) => rs.filter((r) => r.kind === 'shape');
const begins = (rs) => rs.filter((r) => r.kind === 'begin');

console.log('a mask on a container masks the composited group');
{
  let rs = await rows(`${MASK}<g mask="url(#m)">${TWO}</g>`);
  check(kinds(rs) === 'bsse', `<g mask> of two rects: begin, shape, shape, end (got ${kinds(rs)})`);
  check(
    begins(rs)[0]?.mask > 0 && shapes(rs).every((r) => r.mask === 0),
    'the group row carries the mask, the leaves carry none (they would mask each other twice)',
  );
  rs = await rows(`${MASK}<g mask="url(#m)">${TWO}</g>${TWO}`);
  check(kinds(rs) === 'bssess', `a sibling after the group stays ungrouped (got ${kinds(rs)})`);
  rs = await rows(`${MASK}<g mask="url(#m)" opacity=".5">${TWO}</g>`);
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].mask > 0 && Math.abs(begins(rs)[0].opacity - 0.5) < 1e-6,
    'mask + opacity: ONE group carries both',
  );
  rs = await rows(
    `${MASK}${MASK2}<g mask="url(#m)"><g mask="url(#m2)">${TWO}</g><rect width="9" height="9"/></g>`,
  );
  check(
    kinds(rs) === 'bbssese' &&
      begins(rs).length === 2 &&
      begins(rs).every((r) => r.mask > 0) &&
      begins(rs)[0].mask !== begins(rs)[1].mask &&
      shapes(rs).every((r) => r.mask === 0),
    `nested group masks: each group row carries its own mask, no leaf carries one (got ${kinds(rs)})`,
  );
  rs = await rows(
    `${MASK}<defs><rect id="r1" width="40" height="40" fill="#0cf"/><g id="r2"><rect x="20" y="20" width="40" height="40" fill="#f0c"/><rect x="30" y="30" width="20" height="20"/></g></defs><use href="#r1"/><use href="#r2" mask="url(#m)"/>`,
  );
  check(
    begins(rs).length === 1 && begins(rs)[0].mask > 0 && shapes(rs).every((r) => r.mask === 0),
    '<use mask> opens a group that carries the mask',
  );
  rs = await rows(
    `${MASK}<g mask="url(#m)" opacity=".5"><use href="#q"/></g><defs><rect id="q" width="9" height="9"/></defs>`,
  );
  check(
    begins(rs).length === 1 && begins(rs)[0].mask > 0,
    'a <use> inside a masked group does not add one',
  );
  rs = await rows(
    `${MASK}<filter id="f"><feOffset dx="1"/></filter><g mask="url(#m)" filter="url(#f)">${TWO}</g>`,
  );
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].mask > 0 && begins(rs)[0].filter > 0,
    'mask + filter on one group: one group row with both (unchanged)',
  );
  rs = await rows(
    `<clipPath id="c"><rect width="50" height="50"/></clipPath>${MASK}<g mask="url(#m)" clip-path="url(#c)">${TWO}</g>`,
  );
  check(
    begins(rs)[0]?.mask > 0 && shapes(rs).every((r) => r.mask === 0 && r.clip > 0),
    'mask + clip on one group: the mask moves to the group, the clip stays on the leaves',
  );
  rs = await rows(`${WHITE_MASK}<g mask="url(#w)">${TWO}</g>`);
  check(
    begins(rs).length === 0 && shapes(rs).every((r) => r.mask > 0),
    "cost: a mask of exactly white / black shapes (the exporters' frame) keeps the per-leaf mask and opens no group",
  );
  rs = await rows(
    `<mask id="w2"><rect width="64" height="64" fill="white" opacity=".5"/></mask><mask id="w3"><rect width="64" height="64" fill="url(#gg)"/></mask><mask id="w4" mask-type="alpha"><rect width="64" height="64" fill="#336699"/></mask><g mask="url(#w2)">${TWO}</g><g mask="url(#w3)">${TWO}</g><g mask="url(#w4)">${TWO}</g>`,
  );
  check(
    begins(rs).length === 2 && shapes(rs).filter((r) => r.mask > 0).length === 2,
    'a mask with an opacity or a gradient is not binary (grouped); an opaque alpha mask is (per leaf)',
  );
  rs = await rows(
    `${MASK}<g mask="url(#m)"></g><g mask="none">${TWO}</g><g mask="url(#nope)">${TWO}</g>`,
  );
  check(
    begins(rs).length === 0,
    'an empty group, mask="none" and a missing reference open no group',
  );
  rs = await rows(`${MASK}<g>${TWO}</g><g opacity="1">${TWO}</g>`);
  check(
    begins(rs).length === 0,
    'cost: groups without a mask, an opacity, a filter or a blend still open no group',
  );
  rs = await rows(`${MASK}<rect width="40" height="40" fill="#0cf" mask="url(#m)"/>`);
  check(
    kinds(rs) === 's' && rs[0].mask > 0,
    'cost: a fill-only leaf with a mask keeps its mask on the leaf (no group)',
  );
  rs = await rows(
    `${MASK}<rect x="12" y="12" width="40" height="40" fill="#0cf" stroke="#f0c" stroke-width="16" mask="url(#m)"/>`,
  );
  check(
    kinds(rs) === 'bsse' && begins(rs)[0].mask > 0 && rs[1].mask === 0,
    `a leaf with a fill AND a stroke under a mask is one group (got ${kinds(rs)})`,
  );
  rs = await rows(
    `${WHITE_MASK}<rect x="12" y="12" width="40" height="40" fill="#0cf" stroke="#f0c" stroke-width="16" mask="url(#w)"/>`,
  );
  check(
    kinds(rs) === 'ss' && rs.every((r) => r.mask > 0),
    'cost: a fill and a stroke under a white / black mask keep the per-row mask',
  );
  rs = await rows(
    `<mask id="outer"><g mask="url(#m)">${TWO}</g></mask>${MASK}<rect width="64" height="64" mask="url(#outer)"/>`,
  );
  check(
    begins(rs).length === 0 || begins(rs).every((r) => r.mask === 0),
    'a <g mask> inside mask content keeps the per-leaf mask (a layer group is not baked as a group)',
  );
}

console.log('a masked group answers the coverage hit test through its mask');
{
  const svg = (inner) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${inner}</svg>`;
  const maskDef =
    '<mask id="h" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="32" fill="#fff"/><rect y="32" width="64" height="32" fill="#202020"/></mask>';
  const b = await importSvg(
    svg(
      `${maskDef}<g mask="url(#h)"><rect x="4" y="4" width="40" height="56" fill="#0cf"/><rect x="20" y="4" width="40" height="56" fill="#f0c"/></g>`,
    ),
  );
  const hit = (x, y) => fillHits(b, x, y, HitMode.Coverage, 0.2).length > 0;
  check(
    hit(30, 16) && !hit(30, 48),
    "inside the group a point under the mask's white hits and one under its 12% gray (below minAlpha .2) does not",
  );
  const lone = await importSvg(
    svg(`${maskDef}<rect x="4" y="4" width="40" height="56" fill="#0cf" mask="url(#h)"/>`),
  );
  check(
    fillHits(lone, 30, 16, HitMode.Coverage, 0.2).length > 0 &&
      fillHits(lone, 30, 48, HitMode.Coverage, 0.2).length === 0,
    'the same answer for a lone leaf with the mask on the leaf (unchanged)',
  );
}

console.log('markers are part of the element they are on');
{
  let rs = await rows(MARK() + PATH('opacity=".5"'));
  check(
    kinds(rs) === 'bssse',
    `path opacity .5 with markers: one group around the path and its markers (got ${kinds(rs)})`,
  );
  check(
    begins(rs)[0] &&
      Math.abs(begins(rs)[0].opacity - 0.5) < 1e-6 &&
      rs[1].stroke[3] === 1 &&
      rs[2].fill[3] === 1,
    'the group carries .5; the path stroke and the marker rows stay at alpha 1 (the group composites them once)',
  );
  rs = await rows(MARK() + PATH());
  check(
    begins(rs).length === 0,
    'cost: markers on an unfaded, unfiltered, unmasked path open no group',
  );
  rs = await rows(MARK() + '<filter id="f"><feOffset dx="0"/></filter>' + PATH('filter="url(#f)"'));
  check(
    begins(rs).length === 1 && begins(rs)[0].filter > 0 && shapes(rs).every((r) => r.filter === 0),
    'filter on a path with markers: the group row carries the filter, the path and marker rows none',
  );
  rs = await rows(MARK() + MASK + PATH('mask="url(#m)"'));
  check(
    begins(rs).length === 1 && begins(rs)[0].mask > 0 && shapes(rs).every((r) => r.mask === 0),
    'mask on a path with markers: the group row carries the mask (markers and stroke mask once)',
  );
  rs = await rows(MARK('opacity=".5"') + PATH());
  check(
    begins(rs).length === 2 &&
      Math.abs(begins(rs)[0].opacity - 0.5) < 1e-6 &&
      kinds(rs) === 'sbsebse',
    `<marker opacity=".5">: each instance is its own group at .5 (got ${kinds(rs)})`,
  );
  rs = await rows(
    MARK(
      'opacity=".5"',
      '<circle cx="5" cy="5" r="5" fill="#f00"/><rect width="10" height="10" fill="#0f0"/>',
    ) + PATH(),
  );
  check(
    rs.filter((r) => r.kind === 'shape' && r.fill[3] === 1).length >= 4,
    'the marker opacity is a group, not a multiplier on each child (children keep alpha 1)',
  );
}

console.log('context-fill / context-stroke');
{
  let rs = await rows(
    MARK('', '<circle cx="5" cy="5" r="5" fill="context-stroke"/>') +
      '<path d="M8 32 H56" stroke="#0a0" stroke-width="4" marker-start="url(#k)" marker-end="url(#k)" fill="none"/>',
  );
  const markers = shapes(rs).filter((r) => r.fill[3] > 0);
  check(
    markers.length === 2 &&
      markers.every((r) => r.fill[0] === 0 && r.fill[1] === 0.667 && r.fill[2] === 0),
    `a marker circle with fill=context-stroke paints the path's stroke #0a0 (got ${JSON.stringify(markers.map((r) => r.fill))})`,
  );
  rs = await rows(
    MARK('', '<circle cx="5" cy="5" r="5" fill="context-fill"/>') +
      '<path d="M8 32 H56" stroke="#0a0" fill="#a0a" stroke-width="4" marker-start="url(#k)" marker-end="url(#k)"/>',
  );
  const mf = shapes(rs).filter((r) => r.sw === 0 && r.fill[3] > 0 && r.fill[0] > 0.6);
  check(
    mf.length >= 2 && mf.every((r) => r.fill[1] === 0 && r.fill[2] === 0.667),
    `a marker circle with fill=context-fill paints the path's fill #a0a (got ${JSON.stringify(mf.map((r) => r.fill))})`,
  );
  rs = await rows(
    '<defs><rect id="r" width="30" height="30" fill="context-fill" stroke="context-stroke" stroke-width="6"/></defs><use href="#r" x="10" y="10" fill="#f80" stroke="#08f"/>',
  );
  const u = shapes(rs).filter((r) => r.kind === 'shape');
  check(
    u.length >= 2 &&
      u.some((r) => r.fill[0] === 1 && r.fill[1] === 0.533 && r.fill[2] === 0) &&
      u.some((r) => r.stroke[2] === 1 && r.stroke[1] === 0.533),
    `a <use> instance's context-fill / context-stroke are the use's #f80 / #08f (got ${JSON.stringify(u.map((r) => [r.fill, r.stroke]))})`,
  );
  rs = await rows(
    '<rect width="30" height="30" fill="context-fill" stroke="context-stroke" stroke-width="6"/>',
  );
  check(
    shapes(rs).every((r) => r.fill[3] === 0 && r.stroke[3] === 0),
    'with no context element they are none (not black)',
  );
}

console.warn = warn;
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\ncompositingGroupSmoke: mask groups, marker groups and context paints write the expected rows',
);
