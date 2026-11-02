// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterSemanticsImportSmoke — what the importer reads from a <filter>.
//
//   *   flood-color, flood-opacity and lighting-color are CSS properties: a style attribute, a rule, currentColor and
//       var() set them, as the presentation attribute does (feFlood, feDropShadow, the tint shortcut, lighting).
//       They do not inherit, so `inherit` is the parent's value.
//   *   flood-opacity is an <alpha-value>: a percentage is a fraction and the used value is clamped to [0, 1].
//   *   an `in` that names no EARLIER result (unknown, or defined by a later primitive) is treated as unset: the
//       previous primitive's result, SourceGraphic for the first. (Filter Effects 1; SVG 1.1 §15.7.2.)
//   *   an feConvolveMatrix whose kernelMatrix is shorter than orderX * orderY is in error: the filter cannot be built
//       and is dropped (a node with no type would throw in the draw-time reference count).
//   *   a repeated feFuncR / G / B / A is overridden by the last.
//   *   filter x / y / width / height parse as lengths: units and em in userSpaceOnUse, plain numbers and percentages
//       in objectBoundingBox, and a value that does not parse is ignored ("1em" is not 1, nor "5foo" 5).
//   *   a stated width or height of zero or less disables the effect: the region is empty and nothing is painted.
//
// GL-free: reads the filter graph, the parsed record and bundle.filterRegions.
import { imp, wrap, rows, near, makeChecker } from './_importSemantics.mjs';
import { parseFilters } from '../../src/svg/filter.js';

const { ok, done } = makeChecker('FILTER-SEMANTICS');
const R = '<rect x="10" y="10" width="40" height="40" fill="red" filter="url(#f)"/>';
const graphOf = async (defs, body = R) => {
  const b = await imp(wrap(defs + body));
  return { b, g: b.filterGraphs && b.filterGraphs[0] };
};
const floodOf = async (filterBody, filterAttrs = '', before = '') => {
  const { g } = await graphOf(`${before}<filter id="f"${filterAttrs}>${filterBody}</filter>`);
  const n = g && g.nodes.find((x) => x.type === 'feFlood');
  return n ? n.params.rgba : null;
};
const eq = (a, b) => a && near(a, b, 1e-3);

// ---- flood, opacity and lighting colors are CSS properties ----------------------------------------------------------
ok(
  eq(await floodOf('<feFlood style="flood-color:lime;flood-opacity:.5"/>'), [0, 1, 0, 0.5]),
  'flood-color and flood-opacity in style',
);
ok(
  eq(
    await floodOf('<feFlood class="c"/>', '', '<style>.c{flood-color:lime}</style>'),
    [0, 1, 0, 1],
  ),
  'a rule sets flood-color',
);
ok(
  eq(await floodOf('<feFlood flood-color="currentColor"/>', ' color="blue"'), [0, 0, 1, 1]),
  "currentColor is the primitive's own color",
);
ok(
  eq(
    await floodOf('<feFlood style="flood-color:var(--c)"/>', '', '<style>:root{--c:lime}</style>'),
    [0, 1, 0, 1],
  ),
  'var() in flood-color',
);
ok(
  eq(await floodOf('<feFlood flood-color="bogus"/>'), [0, 0, 0, 1]),
  'an invalid flood-color is the initial black',
);
{
  const { g } = await graphOf(
    '<filter id="f"><feDropShadow dx="1" dy="1" stdDeviation="1" style="flood-color:red;flood-opacity:50%"/></filter>',
  );
  const flood = g && g.nodes.find((n) => n.type === 'feFlood');
  ok(
    flood && near(flood.params.rgba, [1, 0, 0, 0.5], 1e-3),
    'feDropShadow reads style and a percentage',
  );
}
{
  const { g } = await graphOf(
    '<filter id="f"><feDiffuseLighting style="lighting-color:red"><feDistantLight azimuth="45" elevation="30"/></feDiffuseLighting></filter>',
  );
  ok(g && near(g.nodes[0].params.lightColor, [1, 0, 0, 1], 1e-3), 'lighting-color in style');
  const specular = await graphOf(
    '<filter id="f"><feSpecularLighting style="lighting-color:lime"><fePointLight x="1" y="1" z="1"/></feSpecularLighting></filter>',
  );
  ok(
    specular.g && near(specular.g.nodes[0].params.lightColor, [0, 1, 0, 1], 1e-3),
    'lighting-color on feSpecularLighting',
  );
}
{
  // the tint shortcut (feFlood + feComposite in) folds the flood into a matrix; a black flood keeps it inline
  const doc = new DOMParser().parseFromString(
    wrap(
      '<filter id="f"><feFlood style="flood-opacity:.5" result="r"/>' +
        '<feComposite in="r" in2="SourceGraphic" operator="in"/></filter>',
    ),
    'image/svg+xml',
  );
  const rec = parseFilters(doc.documentElement, null, {}).f;
  ok(
    rec.kind === 'colorMatrix' && Math.abs(rec.matrix[18] - 0.5) < 1e-9,
    `the tint shortcut reads flood-opacity from style (${rec.kind}, A ${rec.matrix && rec.matrix[18]})`,
  );
}

// ---- flood-opacity is an <alpha-value> ------------------------------------------------------------------------------
ok(
  eq(await floodOf('<feFlood flood-color="blue" flood-opacity="50%"/>'), [0, 0, 1, 0.5]),
  'flood-opacity: 50% is one half',
);
ok(
  eq(await floodOf('<feFlood flood-color="blue" flood-opacity="5"/>'), [0, 0, 1, 1]),
  'flood-opacity above 1 is 1',
);
ok(
  eq(await floodOf('<feFlood flood-color="blue" flood-opacity="-1"/>'), [0, 0, 1, 0]),
  'a negative flood-opacity is 0',
);
ok(
  eq(
    await floodOf('<feFlood flood-color="rgb(0 0 255 / 50%)" flood-opacity="50%"/>'),
    [0, 0, 1, 0.25],
  ),
  "flood-opacity multiplies the color's alpha",
);

// ---- an `in` naming no earlier result -------------------------------------------------------------------------------
{
  const { g } = await graphOf(
    '<filter id="f"><feFlood flood-color="blue" result="a"/><feOffset in="nope" dx="5"/></filter>',
  );
  ok(
    g && g.nodes[1].inputs[0] === 0,
    `an unknown in takes the previous result (input ${g && g.nodes[1].inputs[0]})`,
  );
  const first = await graphOf(
    '<filter id="f"><feOffset in="later" dx="5"/><feFlood result="later" flood-color="blue"/></filter>',
  );
  ok(
    first.g && first.g.nodes[0].inputs[0] === -1,
    `a forward reference on the first primitive is SourceGraphic (${first.g && first.g.nodes[0].inputs[0]})`,
  );
  const mid = await graphOf(
    '<filter id="f"><feFlood result="a"/><feFlood result="b"/><feOffset in="later" dx="5"/><feFlood result="later"/></filter>',
  );
  ok(
    mid.g && mid.g.nodes[2].inputs[0] === 1,
    `a forward reference in the middle is the previous result (${mid.g && mid.g.nodes[2].inputs[0]})`,
  );
  const known = await graphOf(
    '<filter id="f"><feFlood result="a"/><feFlood result="b"/><feOffset in="a" dx="5"/></filter>',
  );
  ok(known.g && known.g.nodes[2].inputs[0] === 0, 'a known result is unchanged');
}

// ---- a short kernelMatrix -------------------------------------------------------------------------------------------
for (const [label, defs] of [
  [
    'in a chain',
    '<filter id="f"><feConvolveMatrix order="3" kernelMatrix="1 1 1"/><feOffset dx="1"/></filter>',
  ],
  ['alone', '<filter id="f"><feConvolveMatrix order="3" kernelMatrix="1 1 1"/></filter>'],
]) {
  const { b } = await graphOf(defs);
  const graphs = (b.filterGraphs || []).filter(Boolean);
  const typed = graphs.every((g) => g.nodes.every((n) => n.type && n.inputs && n.params));
  ok(
    typed && rows(b).every((r) => r.filt === 0),
    `a short kernelMatrix ${label} leaves no half-built node and no filter on the shape`,
  );
}
{
  const { g } = await graphOf(
    '<filter id="f"><feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/><feOffset dx="1"/></filter>',
  );
  ok(g && g.nodes[0].type === 'feConvolveMatrix', 'a complete kernel still builds');
}

// ---- a repeated transfer function -----------------------------------------------------------------------------------
{
  const { g } = await graphOf(
    '<filter id="f" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="0"/><feFuncR type="linear" slope="1" intercept="0.5"/></feComponentTransfer><feOffset dx="1"/></filter>',
  );
  const lut = g && g.nodes[0].params.lutBytes;
  ok(
    lut && lut[0] === 128 && lut[255 * 4] === 255,
    `the last feFuncR wins (R(0) ${lut && lut[0]}, R(1) ${lut && lut[255 * 4]})`,
  );
  // (in linearRGB the default is the spec's nearest entry, 127.5 -> 128; compat: 'chrome' truncates as Chrome's 8-bit table does, 127)
  const SV = wrap(
    '<filter id="f"><feComponentTransfer><feFuncR type="linear" slope="0"/><feFuncR type="linear" slope="1" intercept="0.5"/></feComponentTransfer><feOffset dx="1"/></filter><rect width="9" height="9" filter="url(#f)"/>',
  );
  const lutOf = async (o) => {
    const b = await imp(SV, o);
    return b.filterGraphs[0].nodes[0].params.lutBytes[0];
  };
  ok((await lutOf({})) === 128, 'a linearRGB table rounds by default (the spec)');
  ok(
    (await lutOf({ compat: 'chrome' })) === 127,
    "compat: 'chrome' truncates a linearRGB table (Chrome)",
  );
  const ident = await graphOf(
    '<filter id="f"><feComponentTransfer><feFuncG type="linear" slope="0"/><feFuncG type="identity"/></feComponentTransfer><feOffset dx="1"/></filter>',
  );
  const l2 = ident.g && ident.g.nodes[0].params.lutBytes;
  ok(
    l2 && l2[(256 + 255) * 4] === 255,
    'a later identity feFuncG overrides an earlier constant one',
  );
}

// ---- filter region lengths ------------------------------------------------------------------------------------------
const region = async (attrs, body = R) => {
  const b = await imp(wrap(`<filter id="f"${attrs}><feOffset dx="1"/></filter>${body}`));
  return b.filterRegions && b.filterRegions[0];
};
ok(
  near(
    await region(' filterUnits="userSpaceOnUse" x="1in" y="0" width="2in" height="100"'),
    [96, 0, 192, 100, 1],
  ),
  'userSpaceOnUse lengths take units',
);
ok(
  near(
    await region(' filterUnits="userSpaceOnUse" x="10px" y="0" width="50px" height="100"'),
    [10, 0, 50, 100, 1],
  ),
  'px',
);
ok(
  near(
    await region(
      ' filterUnits="userSpaceOnUse" x="1em" y="0" width="5em" height="100" font-size="20"',
    ),
    [20, 0, 100, 100, 1],
  ),
  "em is the filter element's font-size",
);
ok(
  near(
    await region(' filterUnits="userSpaceOnUse" x="5foo" y="0" width="100" height="100"'),
    [-10, 0, 100, 100, 1],
  ),
  'an unparseable x is ignored (the -10% default)',
);
ok(
  near(await region(' x="1in" y="0" width="2" height="2"'), [-0.1, 0, 2, 2, 0]),
  'a length with a unit is invalid in objectBoundingBox',
);
ok(
  near(await region(' x="10%" y="-5%" width="80%" height="110%"'), [0.1, -0.05, 0.8, 1.1, 0]),
  'percentages are fractions in objectBoundingBox',
);
ok(
  near(await region(' x="0" y="0" width="0" height="1"'), [0, 0, 0, 0, 0]),
  'width 0 is an empty region',
);
ok(
  near(await region(' x="0" y="0" width="-1" height="1"'), [0, 0, 0, 0, 0]),
  'a negative width is an empty region',
);
ok(
  near(await region(' x="0" y="0" width="1" height="0"'), [0, 0, 0, 0, 0]),
  'height 0 is an empty region',
);
ok(
  near(
    await region(' filterUnits="userSpaceOnUse" x="0" y="0" width="0" height="50"'),
    [0, 0, 0, 0, 0],
  ),
  'an empty userSpaceOnUse region',
);
{
  const g = await region(
    ' x="0" y="0" width="0" height="1"',
    '<g filter="url(#f)"><rect x="10" y="10" width="40" height="40"/></g>',
  );
  ok(
    g && g[2] === 0 && g[3] === 0,
    `a group filter with an empty region has no area (${JSON.stringify(g)})`,
  );
}
ok(
  near(await region(' x="0.1" y="0.1" width="0.5" height="0.5"'), [0.1, 0.1, 0.5, 0.5, 0]),
  'a positive region is unchanged',
);

done();
