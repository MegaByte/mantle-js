// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lengthUnitsSmoke — CSS units in SVG lengths and angle units.
//
// em and rem are of the element's COMPUTED font-size (CSS Values 4 §6.1): the nearest font-size set on the element or an
// ancestor in the rendered tree, from an attribute, a style, or a rule, relative sizes included. ex and ch are half an
// em. vw, vh, vmin and vmax are percents of the root viewport. A unit the parser does not know ("5foo"), a bare "1e" and
// trailing characters make the whole value invalid, not the bare number. An <angle> is degrees when it has
// no unit and converts deg, grad, rad and turn.
//
// GL-free: unit tests of parseLength / parseAngle and the geometry the importer emits.
import { imp, wrap, painted, box, near, makeChecker } from './_importSemantics.mjs';
import { parseLength, parseLengthOr, parseAngle } from '../../src/svg/length.js';

const { ok, done } = makeChecker('LENGTH-UNITS');

// ---- the parser -----------------------------------------------------------------------------------------------------
const ctx = {
  fontSize: 20,
  rootFontSize: 10,
  viewportWidth: 400,
  viewportHeight: 200,
  parentWidth: 200,
  parentHeight: 100,
};
const eq = (s, want, c = ctx) => {
  const v = parseLength(s, c);
  return Number.isNaN(want) ? Number.isNaN(v) : Math.abs(v - want) < 1e-9;
};
ok(eq('10vw', 40), '10vw is 10% of the root viewport width');
ok(eq('10vh', 20), '10vh is 10% of the root viewport height');
ok(eq('10vmin', 20), '10vmin takes the smaller side');
ok(eq('10vmax', 40), '10vmax takes the larger side');
ok(eq('1ex', 10) && eq('2ch', 20), 'ex and ch are half an em');
ok(eq('1em', 20) && eq('1rem', 10), 'em and rem use their own font sizes');
ok(
  eq('5foo', NaN) && eq('5px5', NaN) && eq('1e', NaN) && eq('1e+', NaN) && eq('1.5.5', NaN),
  'an unknown unit, trailing characters and a bare exponent are invalid',
);
ok(
  eq('1e1', 10) &&
    eq('1E1', 10) &&
    eq('1e1px', 10) &&
    eq('1e-1in', 9.6) &&
    eq('.5', 0.5) &&
    eq('5.', 5) &&
    eq('+5', 5),
  'valid exponents and number forms are unchanged',
);
ok(
  eq('10PX', 10) &&
    eq('1IN', 96) &&
    eq('1Q', 96 / 25.4 / 4) &&
    eq('1pt', 96 / 72) &&
    eq('1pc', 16) &&
    eq('1cm', 96 / 2.54),
  'absolute units are unchanged and case-insensitive',
);
ok(
  parseLengthOr('5foo', 7) === 7 && parseLengthOr('10vw', 7, { viewportWidth: 300 }) === 30,
  "an invalid length takes the caller's default",
);
ok(parseLength('10vw', {}) === 0, 'vw without a root viewport is 0, as % without a base is');
ok(Math.abs(parseLength('calc(1em + 10vw)', ctx) - 60) < 1e-9, 'units work inside calc()');

// ---- the angle parser ---------------------------------------------------------------------------------------
const deg = (s) => (parseAngle(s) * 180) / Math.PI;
ok(
  Math.abs(deg('90') - 90) < 1e-9 && Math.abs(deg('90deg') - 90) < 1e-9,
  'a bare number and deg are degrees',
);
ok(
  Math.abs(deg('0.25turn') - 90) < 1e-9 &&
    Math.abs(deg('100grad') - 90) < 1e-9 &&
    Math.abs(deg('1.5707963267948966rad') - 90) < 1e-9,
  'turn, grad and rad convert',
);
ok(
  Number.isNaN(parseAngle('90px')) &&
    Number.isNaN(parseAngle('abc')) &&
    Number.isNaN(parseAngle('')),
  'anything else is invalid',
);

// ---- em and rem in the importer -----------------------------------------------------------------------------------
const widthOf = async (body, attrs = 'viewBox="0 0 200 100"') => {
  const rs = painted(await imp(wrap(body, attrs))).filter((r) => r.fill[3] > 0);
  return rs.length ? +(rs[0].bbox[2] - rs[0].bbox[0]).toFixed(4) : null;
};
const W = (label, body, want, attrs) =>
  widthOf(body, attrs).then((got) => ok(got === want, `${label}: ${got} (want ${want})`));
await W(
  'font-size attribute on a group',
  '<g font-size="20"><rect width="1em" height="10"/></g>',
  20,
);
await W('font-size with px', '<g font-size="20px"><rect width="1em" height="10"/></g>', 20);
await W('font-size in style', '<g style="font-size:20px"><rect width="1em" height="10"/></g>', 20);
await W("the element's own font-size", '<rect font-size="20" width="1em" height="10"/>', 20);
await W(
  'font-size from a rule',
  '<style>g{font-size:20px}</style><g><rect width="1em" height="10"/></g>',
  20,
);
await W(
  'em on the root element',
  '<rect width="1em" height="10"/>',
  30,
  'viewBox="0 0 200 100" font-size="30"',
);
await W(
  'rem is the root font-size',
  '<g font-size="10"><rect width="1rem" height="10"/></g>',
  30,
  'viewBox="0 0 200 100" font-size="30"',
);
await W(
  'font-size in % is of the parent',
  '<g font-size="20"><g font-size="50%"><rect width="1em" height="10"/></g></g>',
  10,
);
await W(
  'font-size in em is of the parent',
  '<g font-size="20"><g font-size="2em"><rect width="1em" height="10"/></g></g>',
  40,
);
await W('font-size keyword', '<g font-size="x-large"><rect width="1em" height="10"/></g>', 24);
await W('no font-size is 16', '<rect width="1em" height="10"/>', 16);
await W('ex under a font-size', '<g font-size="20"><rect width="1ex" height="10"/></g>', 10);
await W(
  "a <use> target inherits the use's font-size, not its own ancestors'",
  '<defs><g font-size="50"><rect id="r" width="1em" height="10"/></g></defs><use href="#r" font-size="30"/>',
  30,
);
await W(
  'a nested <svg> content',
  '<g font-size="20"><svg width="100" height="100"><rect width="1em" height="10"/></svg></g>',
  20,
);
await W(
  'a document with no viewBox or size',
  '<g font-size="20"><rect width="1em" height="10"/></g>',
  20,
  '',
);
{
  const b = await imp(
    wrap(
      '<g font-size="20"><rect width="10" height="10" fill="none" stroke="red" stroke-width="1em"/></g>',
    ),
  );
  const sw = painted(b).find((r) => r.sw > 0);
  ok(sw && sw.sw === 20, `stroke-width in em (${sw && sw.sw})`);
  const xy = painted(
    await imp(wrap('<g font-size="20"><rect x="1em" y="1em" width="5" height="10"/></g>')),
  )[0];
  ok(xy && near(box(xy), [20, 20, 25, 30]), 'x and y in em');
  const c = painted(await imp(wrap('<g font-size="20"><circle r="1em" cx="30" cy="30"/></g>')))[0];
  ok(c && near(box(c), [10, 10, 50, 50]), 'r in em');
}

// ---- viewport units in the importer ----------------------------------------------------------------------------------
await W(
  '10vw under width=400',
  '<rect width="10vw" height="10"/>',
  40,
  'viewBox="0 0 200 100" width="400" height="200"',
);
await W(
  '10vh under height=200',
  '<rect width="10vh" height="10"/>',
  20,
  'viewBox="0 0 200 100" width="400" height="200"',
);
await W(
  '10vw without a width is the viewBox',
  '<rect width="10vw" height="10"/>',
  20,
  'viewBox="0 0 200 100"',
);
await W(
  '10vmin',
  '<rect width="10vmin" height="10"/>',
  20,
  'viewBox="0 0 200 100" width="400" height="200"',
);
await W(
  'an unknown unit leaves the width at its default (no rect)',
  '<rect width="5foo" height="10"/>',
  null,
);
await W('a bare exponent is invalid', '<rect width="1e" height="10"/>', null);
await W('1e1 is ten', '<rect width="1e1" height="10"/>', 10);

done();
