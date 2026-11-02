// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cssDeclarationSmoke — declaration-level CSS: what the importer reads from style="…", <style> rules and presentation
// attributes.
//
// CSS Syntax 3 / Cascade 4: a declaration whose value does not parse for its property is dropped at parse time, so the
// declaration before it, the lower layers of the cascade, or the inherited value stay in force. `inherit`
// on a property that does not inherit takes the parent's value (stop-color, flood-color). Comments are
// not part of a declaration and property names are case-insensitive. x, y, width, height, cx, cy, r, rx
// and ry are CSS properties, so style and rules set them over the attribute. `fill: inherit` is the
// parent's fill, not black.
//
// GL-free: reads the meta rows, the parsed gradient stops and the filter graph.
import { imp, wrap, rows, painted, box, near, makeChecker } from './_importSemantics.mjs';
import { parseGradients } from '../../src/svg/gradient.js';
import { parseCssDecls } from '../../src/svg/stylesheet.js';
import { parseStyleString } from '../../src/svg/style.js';

const { ok, done } = makeChecker('CSS-DECLARATION');
const RED = [1, 0, 0],
  BLUE = [0, 0, 1],
  LIME = [0, 1, 0],
  BLACK = [0, 0, 0];
const R = '<rect width="10" height="10"';
const fillOf = async (body, attrs) => {
  const rs = painted(await imp(wrap(body, attrs))).filter((r) => r.bbox[2] - r.bbox[0] >= 4);
  return rs.length ? rs[0].fill.slice(0, 3) : null;
};
const isColor = async (label, body, want) => {
  const got = await fillOf(body);
  ok(
    got && near(got, want, 1e-3),
    `${label}: ${got ? got.map((v) => +v.toFixed(2)).join('/') : 'nothing painted'}`,
  );
};

// ---- invalid declarations are dropped at parse --------------------------------------------------------------------
await isColor(
  'a later invalid declaration leaves the earlier one',
  `${R} style="fill:blue;fill:bogus"/>`,
  BLUE,
);
await isColor(
  'an invalid attribute leaves the inherited fill',
  `<g fill="blue">${R} fill="bogus"/></g>`,
  BLUE,
);
await isColor(
  'an invalid style value leaves the inherited fill',
  `<g fill="blue">${R} style="fill:bogus"/></g>`,
  BLUE,
);
await isColor('a malformed hex is invalid', `<g fill="blue">${R} fill="#12"/></g>`, BLUE);
await isColor(
  'a later invalid rule declaration leaves the earlier one',
  `<style>rect{fill:blue;fill:bogus}</style>${R}/>`,
  BLUE,
);
await isColor(
  'an invalid declaration in the more specific rule yields to the less specific rule',
  `<style>#a{fill:bogus} rect{fill:lime}</style>${R} id="a"/>`,
  LIME,
);
await isColor(
  'a valid declaration after an invalid one applies',
  `${R} style="fill:bogus;fill:red"/>`,
  RED,
);
await isColor(
  'an invalid stroke-linejoin keyword is ignored, the fill is untouched',
  `${R} style="stroke-linejoin:bogus" fill="red"/>`,
  RED,
);
{
  // an invalid fill-rule is dropped, so the element takes the inherited evenodd
  const body =
    '<g fill-rule="evenodd"><path fill-rule="bogus" fill="red" d="M0 0H30V30H0Z M10 10H20V20H10Z"/></g>';
  const r = painted(await imp(wrap(body)))[0];
  ok(
    r && r.eo === 1,
    `an invalid fill-rule keyword leaves the inherited evenodd (eo ${r && r.eo})`,
  );
}
ok(
  JSON.stringify(parseStyleString('fill:red;fill:bogus;stroke:/*c*/blue')) ===
    '{"fill":"red","stroke":"blue"}',
  'parseStyleString drops the invalid declaration and the comment',
);
ok(
  JSON.stringify(parseCssDecls('fill:bogus;opacity:50%;stroke-linecap:round')) ===
    '{"opacity":"50%","stroke-linecap":"round"}',
  'parseCssDecls drops the invalid declaration',
);
ok(
  parseStyleString('fill: var(--c); stroke: env(x, red)').fill === 'var(--c)',
  'a var() value is not judged at parse time',
);
await isColor(
  'var() still resolves',
  `<style>:root{--c:lime}</style>${R} style="fill:var(--c)"/>`,
  LIME,
);
await isColor(
  'color functions and system colors are valid',
  `${R} fill="rgb(255 0 0 / 50%)"/>`,
  RED,
);
ok(
  parseStyleString('fill:red !important;fill:blue').fill === 'red !important',
  'a later normal declaration does not replace !important',
);

// ---- inherit on a property that does not inherit -------------------------------------------------------------------
{
  const doc = new DOMParser().parseFromString(
    wrap(
      '<linearGradient id="a" style="stop-color:red;stop-opacity:.5"><stop offset="0" style="stop-color:inherit;stop-opacity:inherit"/></linearGradient>' +
        '<linearGradient id="b" stop-color="red"><stop offset="0"/></linearGradient>',
    ),
    'image/svg+xml',
  );
  const g = parseGradients(doc.documentElement);
  ok(
    near(g.a.stops[0].color, [1, 0, 0, 0.5], 1e-6),
    `stop-color: inherit takes the gradient's value (${JSON.stringify(g.a.stops[0].color)})`,
  );
  ok(
    near(g.b.stops[0].color, [0, 0, 0, 1], 1e-6),
    'stop-color without the keyword is not inherited',
  );
}
{
  const b = await imp(
    wrap(
      '<filter id="f" style="flood-color:lime"><feFlood style="flood-color:inherit"/></filter>' +
        '<rect width="10" height="10" filter="url(#f)"/>',
    ),
  );
  const rgba = b.filterGraphs && b.filterGraphs[0] && b.filterGraphs[0].nodes[0].params.rgba;
  ok(
    rgba && near(rgba, [0, 1, 0, 1], 1e-6),
    `flood-color: inherit takes the filter's value (${JSON.stringify(rgba)})`,
  );
}

// ---- comments and case --------------------------------------------------------------------------------------------
await isColor('a comment before the property', `${R} style="/*x*/fill:red"/>`, RED);
await isColor('a comment inside the value', `${R} style="fill:/*x*/red"/>`, RED);
await isColor('an upper-case property name in style', `${R} style="FILL:red"/>`, RED);
await isColor(
  'comments and case in a rule',
  `<style>rect{ /* c */ FILL : /* d */ red }</style>${R}/>`,
  RED,
);
await isColor('a semicolon inside a comment does not split', `${R} style="/*a;b*/fill:red"/>`, RED);

// ---- geometry properties in style ---------------------------------------------------------------------------------
{
  const geomBox = async (body) => {
    const r = painted(await imp(wrap(body)))[0];
    return r && box(r);
  };
  ok(
    near(await geomBox('<circle style="cx:20px;cy:20px;r:5px"/>'), [15, 15, 25, 25]),
    'circle cx, cy and r from style',
  );
  ok(
    near(await geomBox('<rect style="x:10px;y:10px;width:30px;height:30px"/>'), [10, 10, 40, 40]),
    'rect x, y, width and height from style',
  );
  ok(
    near(
      await geomBox('<rect x="10" y="10" width="30" height="30" style="width:5px"/>'),
      [10, 10, 15, 40],
    ),
    'style beats the attribute',
  );
  ok(
    near(
      await geomBox('<style>rect{width:7px}</style><rect x="10" y="10" width="30" height="30"/>'),
      [10, 10, 17, 40],
    ),
    'a rule beats the attribute',
  );
  ok(
    near(await geomBox('<ellipse cx="20" cy="20" style="rx:6px;ry:3px"/>'), [14, 17, 26, 23]),
    'ellipse rx and ry from style',
  );
}

// ---- fill: inherit ------------------------------------------------------------------------------------------------
await isColor(
  'inherit: fill="inherit" is the parent fill',
  `<g fill="blue">${R} fill="inherit"/></g>`,
  BLUE,
);
await isColor(
  'inherit: fill:unset is the parent fill',
  `<g fill="blue">${R} style="fill:unset"/></g>`,
  BLUE,
);
await isColor(
  'inherit: through two levels',
  `<g fill="blue"><g fill="inherit">${R}/></g></g>`,
  BLUE,
);
await isColor(
  'inherit: fill:initial is black',
  `<g fill="blue">${R} style="fill:initial"/></g>`,
  BLACK,
);

done();
