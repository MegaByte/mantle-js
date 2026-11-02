// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerContentSmoke -- a marker's content goes through the main walker when it needs more than solid shapes.
//
// SVG 2 §13.7: marker content is ordinary graphics content: child and group transforms, <use>, gradient and pattern
// paints, groups with opacity, clip and mask all apply, and it inherits from the <marker> and its ancestors, never from
// the referencing path. Content of plain solid-paint shapes keeps the flat record form (markerPlacementSmoke covers
// its placement); the marker's placement, viewBox fit and overflow clip are the same in both forms.
//
// GL-free: the marker is placed at userSpaceOnUse scale at the end of a horizontal path at (90, 50).
import { imp, wrap, rows, sequence, near, makeChecker } from './_importSemantics.mjs';

const { ok, done } = makeChecker('MARKER-CONTENT');
// `attrs` overrides the defaults (a 30x30 viewport, overflow visible) by name
const marker = (content, attrs = '', defs = '') => {
  const have = new Set([...attrs.matchAll(/([\w-]+)=/g)].map((m) => m[1]));
  const dflt = {
    markerUnits: 'userSpaceOnUse',
    markerWidth: '30',
    markerHeight: '30',
    overflow: 'visible',
  };
  const own = Object.entries(dflt)
    .filter(([k]) => !have.has(k))
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return `<defs>${defs}<marker id="m" ${own} ${attrs}>${content}</marker></defs>`;
};
const PATH =
  '<path d="M10 50 L90 50" fill="none" stroke="black" stroke-width="2" marker-end="url(#m)"/>';
// the shape rows that are not the path and its stroke (the marker's rows)
const markerRows = async (body) => {
  const b = await imp(wrap(body));
  return { b, rs: rows(b).filter((r) => !(r.flags & 192) && r.bbox[0] >= 80 && r.bbox[2] > 80) };
};
const GRAD =
  '<linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>';

{
  const { rs } = await markerRows(
    marker('<rect width="10" height="10" fill="url(#g)"/>', 'refX="5" refY="5"', GRAD) + PATH,
  );
  const r = rs.find((x) => near(x.bbox, [85, 45, 95, 55], 1e-3));
  // A gradient is painted white times the ramp, not a hard-coded black
  ok(
    r && near(r.fill, [1, 1, 1, 1], 1e-6),
    `a gradient fill in a marker is a gradient, not black: ${r && r.fill}`,
  );
}
{
  const { rs } = await markerRows(
    marker(
      '<rect width="10" height="10" fill="red" transform="translate(5 5)"/>',
      'refX="0" refY="0"',
    ) + PATH,
  );
  ok(
    rs.some((x) => near(x.bbox, [95, 55, 105, 65], 1e-3)),
    `a child transform moves the child: ${JSON.stringify(rs.map((x) => x.bbox))}`,
  );
}
{
  const { rs } = await markerRows(
    marker('<g transform="scale(2)"><rect width="5" height="5" fill="red"/></g>') + PATH,
  );
  ok(
    rs.some((x) => near(x.bbox, [90, 50, 100, 60], 1e-3)),
    `a group transform scales its children: ${JSON.stringify(rs.map((x) => x.bbox))}`,
  );
}
{
  const { rs } = await markerRows(
    marker('<use href="#r" x="3"/>', '', '<rect id="r" width="4" height="4" fill="blue"/>') + PATH,
  );
  ok(
    rs.some((x) => near(x.bbox, [93, 50, 97, 54], 1e-3) && near(x.fill, [0, 0, 1, 1], 1e-6)),
    `a <use> in a marker draws its target: ${JSON.stringify(rs.map((x) => x.bbox))}`,
  );
}
{
  const { b } = await markerRows(
    marker(
      '<g opacity=".5"><rect width="10" height="10" fill="red"/><rect x="5" width="10" height="10" fill="red"/></g>',
    ) + PATH,
  );
  const seq = sequence(b);
  ok(
    seq.join().includes('B(0.5,0,0),S,S,E'),
    `a group's opacity composes its children as a group: ${seq}`,
  );
}
{
  // inheritance: from the marker's ancestors, not from the referencing path
  const body =
    `<g fill="green"><defs><marker id="m" markerUnits="userSpaceOnUse" markerWidth="30" markerHeight="30" overflow="visible"><g transform="translate(0 0)"><rect width="4" height="4"/></g></marker></defs></g>` +
    '<path d="M10 50 L90 50" fill="red" stroke="black" stroke-width="2" marker-end="url(#m)"/>';
  const { rs } = await markerRows(body);
  const r = rs.find((x) => near(x.bbox, [90, 50, 94, 54], 1e-3));
  ok(
    r && near(r.fill, [0, 0.50196, 0, 1], 1e-3),
    `marker content inherits from the marker's ancestors, not the path: ${r && r.fill}`,
  );
}
{
  // a path inside the marker that names the same marker does not recurse
  const body =
    '<defs><marker id="m" markerUnits="userSpaceOnUse" markerWidth="30" markerHeight="30" overflow="visible">' +
    '<g transform="translate(1 0)"><path d="M0 0 L5 0" stroke="black" marker-end="url(#m)"/></g></marker></defs>' +
    PATH;
  const b = await imp(wrap(body));
  ok(
    rows(b).length > 0 && rows(b).length < 20,
    `a marker that names itself terminates: ${rows(b).length} rows`,
  );
}
{
  // the overflow clip still applies to walked content, and overflow=visible lifts it
  const clipped = marker(
    '<rect width="10" height="10" fill="url(#g)"/>',
    'refX="5" refY="5" markerWidth="4" markerHeight="4" overflow="hidden"',
    GRAD,
  );
  const a = await markerRows(clipped + PATH);
  const mk = a.rs.find((x) => near(x.bbox, [85, 45, 95, 55], 1e-3));
  ok(
    mk && mk.clip > 0,
    `walked content takes the marker viewport clip when overflow is hidden: clip ${mk && mk.clip}`,
  );
  const c = await markerRows(
    marker(
      '<rect width="10" height="10" fill="url(#g)"/>',
      'refX="5" refY="5" markerWidth="4" markerHeight="4"',
      GRAD,
    ) + PATH,
  );
  const mv = c.rs.find((x) => near(x.bbox, [85, 45, 95, 55], 1e-3));
  ok(mv && mv.clip === 0, `overflow=visible lifts it: clip ${mv && mv.clip}`);
}
{
  // a plain solid marker keeps its output: no group, no clip when the content fits
  const { b } = await markerRows(marker('<rect width="4" height="4" fill="red"/>') + PATH);
  ok(!sequence(b).some((x) => x.startsWith('B')), 'a solid marker adds no group');
}
done();
