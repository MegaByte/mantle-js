// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// structureSemanticsSmoke — document structure and attribute grammar.
//
//   *   a <use> of an <svg> overrides that svg's width and height with its own.
//   *   systemLanguage and requiredExtensions hold on every element, not only a <switch> child.
//   *   a <clipPath> holds shapes, text and <use> of a shape or text; a <g> in it, or a <use> of one, is not
//       part of the clip.
//   *   a radial gradient's fx / fy default to ITS cx / cy unless it or its href chain AUTHORS them.
//   *   fr, the SVG 2 focal radius, is carried on the gradient (test/radialFrSmoke.mjs draws and checks it); a negative one reads as 0.
//   *   path data is rendered up to the first error: a path that does not begin with a moveto, an unknown
//       command, a stray word, a flag that is not 0 or 1 and a stray comma all end it.
//   *   a transform list with an error anywhere is ignored (the identity).
//   *   an <ellipse> radius that is auto, missing, negative or unparseable takes the other radius.
//   *   an element nesting deeper than MAX_ELEMENT_DEPTH is refused with an Error, not a RangeError.
//
// GL-free.
import { imp, wrap, rows, painted, box, near, makeChecker } from './_importSemantics.mjs';
import { parsePathD, tokenizePath } from '../../src/svg/path.js';
import { parseTransform } from '../../src/svg/transform.js';
import { parseGradients } from '../../src/svg/gradient.js';
import { MAX_ELEMENT_DEPTH } from '../../src/svg/utils.js';

const { ok, done } = makeChecker('STRUCTURE-SEMANTICS');
const RECT = '<rect width="10" height="10" fill="red"/>';
const boxes = async (body, opts, attrs) => painted(await imp(wrap(body, attrs), opts)).map(box);

// ---- a <use> of an <svg> --------------------------------------------------------------------------------------------
{
  const svg = (a) =>
    `<defs><svg id="s" width="20" height="20" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg></defs><use href="#s" ${a}/>`;
  const same = await boxes(svg(''));
  ok(
    same.length >= 1 && near(same[0], [0, 0, 20, 20]),
    `without width and height the svg keeps its own (${JSON.stringify(same[0])})`,
  );
  const big = await boxes(svg('width="40" height="40"'));
  ok(
    big.length >= 1 && near(big[0], [0, 0, 40, 40]),
    `the use's width and height override the svg's (${JSON.stringify(big[0])})`,
  );
  const wide = await boxes(svg('width="40"'));
  ok(
    wide.length >= 1 && near(wide[0], [10, 0, 30, 20]),
    `one override leaves the other axis (meet fit) (${JSON.stringify(wide[0])})`,
  );
}

// ---- systemLanguage and requiredExtensions everywhere ---------------------------------------------------------------
{
  const en = { languages: ['en'] };
  ok(
    (await boxes('<rect width="10" height="10" fill="red" systemLanguage="xx"/>', en)).length === 0,
    'a failing systemLanguage hides the element outside a switch',
  );
  ok(
    (await boxes('<rect width="10" height="10" fill="red" systemLanguage="en, fr"/>', en))
      .length === 1,
    'a matching systemLanguage shows it',
  );
  ok(
    (await boxes('<g systemLanguage="xx"><rect width="10" height="10" fill="red"/></g>', en))
      .length === 0,
    'a failing group hides its content',
  );
  ok(
    (
      await boxes(
        '<rect width="10" height="10" fill="red" requiredExtensions="http://example.com/x"/>',
        en,
      )
    ).length === 0,
    'requiredExtensions fails outside a switch',
  );
  ok(
    (
      await boxes(
        '<rect width="10" height="10" fill="red" requiredFeatures="http://example.com/unknown"/>',
        en,
      )
    ).length === 1,
    'requiredFeatures (removed in SVG 2) is ignored outside a switch',
  );
  ok(
    (
      await boxes(
        '<switch><rect width="10" height="10" fill="red" systemLanguage="xx"/><rect x="20" width="10" height="10" fill="red"/></switch>',
        en,
      )
    ).length === 1,
    'a switch still picks its first passing child',
  );
  ok(
    (
      await boxes(
        '<defs><rect id="r" width="10" height="10" fill="red" systemLanguage="xx"/></defs><use href="#r"/>',
        en,
      )
    ).length === 0,
    'a use of a failing element draws nothing',
  );
}

// ---- what a <clipPath> holds ----------------------------------------------------------------------------------------
{
  const clipBox = async (defs) => {
    const b = await imp(
      wrap(defs + '<rect x="10" y="10" width="40" height="40" fill="red" clip-path="url(#c)"/>'),
    );
    const rs = rows(b);
    return rs.length > 1 ? box(rs[1]) : null;
  };
  const SQ = [20, 20, 30, 30];
  ok(
    near(
      await clipBox('<clipPath id="c"><rect x="20" y="20" width="10" height="10"/></clipPath>'),
      SQ,
    ),
    'a shape child is the clip',
  );
  ok(
    !near(
      (await clipBox(
        '<clipPath id="c"><g><rect x="20" y="20" width="10" height="10"/></g></clipPath>',
      )) || [],
      SQ,
    ),
    'a <g> child is not part of the clip',
  );
  ok(
    near(
      await clipBox(
        '<defs><rect id="u" width="10" height="10"/></defs><clipPath id="c"><use href="#u" x="20" y="20"/></clipPath>',
      ),
      SQ,
    ),
    'a use of a shape is the clip',
  );
  ok(
    !near(
      (await clipBox(
        '<defs><g id="u"><rect width="10" height="10"/></g></defs><clipPath id="c"><use href="#u" x="20" y="20"/></clipPath>',
      )) || [],
      SQ,
    ),
    'a use of a <g> is not part of the clip',
  );
  ok(
    near(
      await clipBox(
        '<clipPath id="c"><rect x="20" y="20" width="10" height="10"/><g><rect x="30" y="30" width="10" height="10"/></g></clipPath>',
      ),
      SQ,
    ),
    'only the shape child counts beside a <g>',
  );
  // the importer's own wrappers (a clip-path on a clipPath) are not authored <g> and still work
  const nested = await imp(
    wrap(
      '<clipPath id="d"><rect x="20" y="20" width="5" height="5"/></clipPath>' +
        '<clipPath id="c" clip-path="url(#d)"><rect x="20" y="20" width="10" height="10"/></clipPath>' +
        '<rect x="10" y="10" width="40" height="40" fill="red" clip-path="url(#c)"/>',
    ),
  );
  ok(
    rows(nested).length === 3 &&
      near(box(rows(nested)[1]), SQ) &&
      near(box(rows(nested)[2]), [20, 20, 25, 25]),
    'a clip-of-clip keeps both clips',
  );
}

// ---- radial focal point and focal radius ----------------------------------------------------------------------------
{
  const parse = (s) =>
    parseGradients(new DOMParser().parseFromString(wrap(s), 'image/svg+xml').documentElement);
  const a = parse(
    '<radialGradient id="p"><stop offset="0" stop-color="red"/></radialGradient><radialGradient id="c" href="#p" cx="0.8" cy="0.7"/>',
  );
  ok(
    a.c.cx === 0.8 && a.c.fx === 0.8 && a.c.fy === 0.7,
    `a child that authors only cx / cy puts the focal point at its own center (${a.c.fx}, ${a.c.fy})`,
  );
  const b = parse(
    '<radialGradient id="p" fx="0.2"><stop offset="0"/></radialGradient><radialGradient id="c" href="#p" cx="0.8"/>',
  );
  ok(
    b.c.fx === 0.2 && b.c.fy === 0.5,
    `an authored fx is inherited, an unauthored fy is the child's cy (${b.c.fx}, ${b.c.fy})`,
  );
  const c = parse(
    '<radialGradient id="p" fx="0.2"/><radialGradient id="m" href="#p" cx="0.9"/><radialGradient id="c" href="#m"><stop offset="0"/></radialGradient>',
  );
  ok(c.c.fx === 0.2, 'an authored fx passes down a chain');
  const d = parse(
    '<radialGradient id="g" fr="0.2" r="0.5" cx=".5"><stop offset="0"/></radialGradient>',
  );
  ok(d.g.fr === 0.2, `fr is carried on the gradient (${d.g.fr})`);
  const e = parse('<radialGradient id="g" fr="-0.2"><stop offset="0"/></radialGradient>');
  ok(e.g.fr === 0, 'a negative fr reads as 0');
}

// ---- path data up to the first error --------------------------------------------------------------------------------
{
  const n = (d) => parsePathD(d).length;
  ok(n('L10 10 L50 50') === 0 && n('10 10 L50 50') === 0, 'path data must begin with a moveto');
  ok(
    n('M10 10 L50 10 L50 50') === 2 && n('m10 10 20 20 20 0') === 2,
    'valid data is unchanged (implicit lineto, relative first moveto)',
  );
  ok(n('M10 10 L20 20 foo L40 40') === 1, 'a stray word ends the path');
  ok(n('M10 10 R 20 20 L40 40') === 0, 'an unknown command ends the path');
  ok(n('M10 10 L20 20 L 1e L 30 30') === 1, 'a bare exponent ends the path');
  ok(
    n('M10 10 A 20 20 0 2 1 50 10') === 0 && n('M10 10 A 20 20 0 1 7 50 10') === 0,
    'an arc flag that is not 0 or 1 ends the path',
  );
  ok(
    n('M10 10 A 20 20 0 0110 10 L30 30') === 2 && n('M10 10 A 20 20 0 1 1 50 10') === 1,
    'glued and spaced flags are unchanged',
  );
  ok(
    n('M10 10 L20,,20 L30 30') === 0 && n('M,10 10 L20 20') === 0,
    'a doubled comma, or a comma after a command, ends the path',
  );
  ok(n('M10 10 L20 20, L30 30') === 1, 'a comma before a command ends the path');
  ok(n('M10,10 L20,20, 30,30') === 2, 'commas between numbers are fine');
  ok(
    n('M10 10 L20 20 Z L40 10') === 3 && n('M10-5-5 10 20 20') === 2,
    'numbers after Z and packed signs are unchanged',
  );
  ok(
    tokenizePath('M10 10 L20 oops 30').join(' ') === 'M 10 10 L 20',
    'tokenizePath stops at the first error',
  );
}

// ---- a transform list with an error ---------------------------------------------------------------------------------
{
  const id = (t) => parseTransform(t).every((v, i) => v === [1, 0, 0, 1, 0, 0][i]);
  ok(
    id('translate(20 30) bogus') && id('bogus translate(20 30)') && id('translate(20 30) scale()'),
    'an error after or before good functions makes the whole list the identity',
  );
  ok(
    id('translate()') &&
      id('matrix(1 0 0 1 20)') &&
      id('rotate(45 10)') &&
      id('scale(1 2 3)') &&
      id('TRANSLATE(20 30)'),
    'a wrong argument count or case is an error',
  );
  ok(
    id('translate(1e)') &&
      id('translate(NaN 0)') &&
      id('translate(1 2') &&
      id('translate(1 2),') &&
      id('translate(1,,2)'),
    'a bad number, a missing parenthesis and a stray comma are errors',
  );
  ok(
    near(parseTransform('translate(20 30)'), [1, 0, 0, 1, 20, 30]) &&
      near(parseTransform('translate(20,30),scale(2)'), [2, 0, 0, 2, 20, 30]),
    'valid lists compose as before',
  );
  ok(
    near(parseTransform('translate(10,)'), [1, 0, 0, 1, 10, 0]),
    'a comma after the last argument is tolerated',
  );
  ok(
    near(
      parseTransform('rotate(90 10 10)'),
      parseTransform('translate(10 10) rotate(90) translate(-10 -10)'),
    ),
    'rotate about a point',
  );
  ok(
    near(parseTransform('rotate(0.25turn)'), parseTransform('rotate(90)'), 1e-9) &&
      near(parseTransform('translate(5px 6px)'), [1, 0, 0, 1, 5, 6]),
    'the CSS forms with a unit that means something here',
  );
  ok(id('translate(5em)') && id('scale(2px)'), 'a unit that has no meaning here is an error');
  const b = await imp(
    wrap('<rect width="10" height="10" fill="red" transform="translate(20 30) bogus"/>'),
  );
  ok(near(box(painted(b)[0]), [0, 0, 10, 10]), 'the importer leaves the element in place');
}

// ---- an <ellipse> radius --------------------------------------------------------------------------------------------
{
  const e = async (attrs) => {
    const r = painted(await imp(wrap(`<ellipse cx="20" cy="20" ${attrs}/>`)))[0];
    return r ? box(r) : null;
  };
  ok(near(await e('rx="5"'), [15, 15, 25, 25]), 'a missing ry is rx');
  ok(near(await e('ry="5"'), [15, 15, 25, 25]), 'a missing rx is ry');
  ok(
    near(await e('rx="auto" ry="5"'), [15, 15, 25, 25]) &&
      near(await e('rx="5" ry="auto"'), [15, 15, 25, 25]),
    'auto is the other radius',
  );
  ok(
    near(await e('rx="-3" ry="5"'), [15, 15, 25, 25]) &&
      near(await e('rx="5foo" ry="4"'), [16, 16, 24, 24]),
    'a negative or unparseable radius is auto',
  );
  ok(near(await e('rx="6" ry="3"'), [14, 17, 26, 23]), 'two radii are unchanged');
  ok(
    (await e('')) === null && (await e('rx="0"')) === null && (await e('rx="0" ry="5"')) === null,
    'no radius, or an explicit 0, draws nothing',
  );
}

// ---- element nesting depth ------------------------------------------------------------------------------------------
{
  const nest = (n) => wrap('<g>'.repeat(n) + RECT + '</g>'.repeat(n));
  ok(
    MAX_ELEMENT_DEPTH >= 256,
    `the documented limit (${MAX_ELEMENT_DEPTH}) is well above real art`,
  );
  const fine = await imp(nest(MAX_ELEMENT_DEPTH - 3));
  ok(fine.numShapes === 1, 'a document just inside the limit imports');
  for (const n of [MAX_ELEMENT_DEPTH + 1, 3000]) {
    let err = null;
    try {
      await imp(nest(n));
    } catch (e) {
      err = e;
    }
    ok(
      err && err.constructor === Error && /nested deeper than/.test(err.message),
      `${n} levels: ${err ? err.constructor.name + ': ' + err.message : 'imported'}`,
    );
  }
}

done();
