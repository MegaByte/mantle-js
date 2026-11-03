// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerPlacementSmoke — where markers go and how they turn.
//
//   *   orient takes an <angle>: a bare number is degrees and deg / grad / rad / turn convert, once (a conversion
//       applied twice turns orient="90deg" by 1.57 degrees).
//   *   every vertex but the first and the last is a mid vertex (SVG 2 §13.6.2), the end and the start of each inner
//       subpath included: `M a L b M c L d` has start, two mids and end. A subpath's end takes its incoming tangent,
//       a start its outgoing one, and a closed subpath joins the two.
//   *   only <path>, <line>, <polyline> and <polygon> take markers; a <rect>, <circle> or <ellipse> does not.
//   *   `marker` is the shorthand of marker-start, marker-mid and marker-end, in a style attribute or a rule, in the
//       order the declarations are written.
//
// GL-free: the marker is a 4x2 red rectangle at userSpaceOnUse scale, so each placed marker is one red row whose box
// shows its position and angle.
import { imp, wrap, rows, near, makeChecker } from './_importSemantics.mjs';

const { ok, done } = makeChecker('MARKER-PLACEMENT');
const marker = (attrs = '') =>
  `<defs><marker id="m" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" ${attrs}>` +
  '<path d="M0 0 L4 0 L4 2 L0 2Z" fill="red"/></marker></defs>';
const reds = async (body) => {
  const b = await imp(wrap(body));
  return rows(b)
    .filter((r) => r.fill[3] > 0 && r.fill[0] === 1 && r.fill[1] === 0 && r.fill[2] === 0)
    .map((r) => r.bbox.map((v) => +v.toFixed(3)));
};
const path = (d, extra) => `<path d="${d}" fill="none" stroke="black" ${extra}/>`;
const ALL = 'marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"';

// ---- orient takes an <angle> ----------------------------------------------------------------------------------------
for (const [label, v] of [
  ['90', '90'],
  ['90deg', '90deg'],
  ['0.25turn', '0.25turn'],
  ['100grad', '100grad'],
  ['1.5707963rad', '1.5707963rad'],
]) {
  const got = await reds(marker(`orient="${v}"`) + path('M20 20 L60 20', 'marker-end="url(#m)"'));
  ok(
    got.length === 1 && near(got[0], [58, 20, 60, 24], 1e-3),
    `orient="${label}" turns the marker a quarter turn: ${JSON.stringify(got)}`,
  );
}
{
  const got = await reds(marker('orient="45deg"') + path('M20 20 L60 20', 'marker-end="url(#m)"'));
  const c = Math.SQRT1_2;
  const corners = [
    [0, 0],
    [4, 0],
    [4, 2],
    [0, 2],
  ].map(([x, y]) => [60 + c * x - c * y, 20 + c * x + c * y]);
  const want = [
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ];
  ok(
    got.length === 1 && near(got[0], want, 1e-3),
    `orient="45deg" is 45 degrees: ${JSON.stringify(got)}`,
  );
}

// ---- start, mid and end vertices ------------------------------------------------------------------------------------
{
  const got = await reds(marker() + path('M10 10 L50 10 M10 50 L50 50', ALL));
  const at = got.map((b) => `${b[0]},${b[1]}`);
  ok(
    got.length === 4 &&
      at.includes('10,10') &&
      at.includes('50,10') &&
      at.includes('10,50') &&
      at.includes('50,50'),
    `two subpaths give start, two mids and end: ${at.join(' ')}`,
  );
}
{
  const got = await reds(marker('orient="auto"') + path('M10 10 L50 10 M10 50 L50 50', ALL));
  // all four vertices point along +x: the mid at the end of the first subpath uses its incoming tangent and the mid at
  // the start of the second its outgoing one (the average of the two would point diagonally)
  ok(
    got.length === 4 &&
      got.every((b) => Math.abs(b[2] - b[0] - 4) < 1e-3 && Math.abs(b[3] - b[1] - 2) < 1e-3),
    `inner subpath ends keep their own tangent: ${JSON.stringify(got)}`,
  );
}
{
  const got = await reds(
    marker('orient="auto"') + path('M10 10 L30 10 L30 30 Z M50 50 L70 50', ALL),
  );
  ok(
    got.length === 6,
    `a closed subpath then an open one: ${got.length} markers (start, 2 joints, close, next start, end)`,
  );
  // the close vertex (10,10) joins the closing tangent (-1,-1) with the first segment's (1,0): a -67.5 degree marker
  const a = Math.atan2(-Math.SQRT1_2, 1 - Math.SQRT1_2),
    ca = Math.cos(a),
    sa = Math.sin(a);
  const cs = [
    [0, 0],
    [4, 0],
    [4, 2],
    [0, 2],
  ].map(([x, y]) => [10 + ca * x - sa * y, 10 + sa * x + ca * y]);
  const want = [
    Math.min(...cs.map((p) => p[0])),
    Math.min(...cs.map((p) => p[1])),
    Math.max(...cs.map((p) => p[0])),
    Math.max(...cs.map((p) => p[1])),
  ];
  ok(
    got.some((b) =>
      near(
        b,
        want.map((v) => +v.toFixed(3)),
        2e-3,
      ),
    ),
    `the closed subpath's end vertex bisects its two tangents (${JSON.stringify(want.map((v) => +v.toFixed(3)))})`,
  );
}
{
  // a single subpath is unchanged: start, one mid per interior vertex, end, in order
  const got = await reds(marker() + path('M10 10 L50 10 L50 50 L10 50', ALL));
  ok(got.length === 4, `one subpath keeps start, 2 mids, end: ${got.length}`);
}

// ---- which elements take markers ------------------------------------------------------------------------------------
ok(
  (
    await reds(
      marker() + `<rect x="10" y="10" width="40" height="40" fill="none" stroke="black" ${ALL}/>`,
    )
  ).length === 0,
  'a <rect> takes no markers',
);
ok(
  (await reds(marker() + `<circle cx="30" cy="30" r="10" fill="none" stroke="black" ${ALL}/>`))
    .length === 0,
  'a <circle> takes no markers',
);
ok(
  (
    await reds(
      marker() + `<ellipse cx="30" cy="30" rx="10" ry="5" fill="none" stroke="black" ${ALL}/>`,
    )
  ).length === 0,
  'an <ellipse> takes no markers',
);
ok(
  (await reds(marker() + `<line x1="10" y1="10" x2="50" y2="10" stroke="black" ${ALL}/>`))
    .length === 2,
  'a <line> takes start and end',
);
ok(
  (
    await reds(
      marker() + `<polyline points="10,10 50,10 50,50" fill="none" stroke="black" ${ALL}/>`,
    )
  ).length === 3,
  'a <polyline> takes all three',
);
ok(
  (await reds(marker() + `<polygon points="10,10 50,10 50,50" fill="none" stroke="black" ${ALL}/>`))
    .length === 4,
  'a <polygon> takes all three, the closing vertex too',
);
ok(
  (
    await reds(
      marker() +
        `<g ${ALL}><rect x="10" y="10" width="40" height="40" fill="none"/><path d="M10 60 L50 60" stroke="black"/></g>`,
    )
  ).length === 2,
  'inherited markers reach the path, not the rect',
);

// ---- the marker shorthand -------------------------------------------------------------------------------------------
const P3 = 'M10 10 L50 10 L50 50';
ok(
  (await reds(marker() + path(P3, 'style="marker:url(#m)"'))).length === 3,
  'style="marker:url(#m)" places start, mid and end',
);
ok(
  (await reds(marker() + path(P3, 'style="marker:url(#m);marker-mid:none"'))).length === 2,
  'a later longhand overrides the shorthand',
);
ok(
  (await reds(marker() + path(P3, 'style="marker-mid:none;marker:url(#m)"'))).length === 3,
  'a later shorthand overrides an earlier longhand',
);
ok(
  (await reds(marker() + `<style>path{marker:url(#m)}</style>` + path(P3, ''))).length === 3,
  'the shorthand in a stylesheet rule',
);
ok(
  (await reds(marker() + `<g style="marker:url(#m)">${path(P3, '')}</g>`)).length === 3,
  'the shorthand inherits',
);
ok((await reds(marker() + path(P3, 'style="marker:none"'))).length === 0, 'marker:none');

done();
