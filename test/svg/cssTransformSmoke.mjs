// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cssTransformSmoke -- the CSS transform properties of an SVG element.
//
// CSS Transforms 1 and 2, SVG 2 §8: `transform` (a CSS property that overrides the attribute), `translate`, `rotate`,
// `scale`, `transform-origin` and `transform-box`. The matrix is T(origin) * translate * rotate * scale * transform *
// T(-origin), the origin resolved against the reference box (view-box by default: the viewBox at the origin of the
// user space; fill-box: the element's geometry box). The used transform-origin when none is authored is `0 0` of the
// reference box. stroke-box and border-box measure the fill box.
//
// GL-free: a 10x10 rect at (x, y) and the bounding box of the row it becomes.
import { imp, wrap, rows, near, makeChecker } from './_importSemantics.mjs';

const { ok, done } = makeChecker('CSS-TRANSFORM');
const E = 1e-3;
const red = (x) =>
  !(x.flags & 192) && x.fill[0] === 1 && x.fill[1] === 0 && x.fill[2] === 0 && x.fill[3] > 0;
const boxOf = async (body, attrs) => {
  const b = await imp(wrap(body, attrs));
  const r = rows(b).filter(red);
  return r.length === 1 ? r[0].bbox.map((v) => +v.toFixed(4)) : r.map((x) => x.bbox);
};
const rect = (style, extra = '', x = 0, y = 0) =>
  `<rect x="${x}" y="${y}" width="10" height="10" fill="red" ${extra} style="${style}"/>`;
const check = async (label, body, want, attrs) => {
  const got = await boxOf(body, attrs);
  ok(near(got, want, E), `${label}: ${JSON.stringify(got)} ~ ${JSON.stringify(want)}`);
};

// ---- transform: functions and units -----------------------------------------------------------------------------
await check('translate(px)', rect('transform: translate(20px, 30px)'), [20, 30, 30, 40]);
await check('translate one argument', rect('transform: translate(20px)'), [20, 0, 30, 10]);
await check(
  'translateX / translateY',
  rect('transform: translateX(5px) translateY(7px)'),
  [5, 7, 15, 17],
);
await check('rotate(90deg)', rect('transform: rotate(90deg)'), [-10, 0, 0, 10]);
await check('rotate(0.25turn)', rect('transform: rotate(0.25turn)'), [-10, 0, 0, 10]);
await check('rotate(100grad)', rect('transform: rotate(100grad)'), [-10, 0, 0, 10]);
await check(
  'rotate(1.5707963267948966rad)',
  rect('transform: rotate(1.5707963267948966rad)'),
  [-10, 0, 0, 10],
);
await check('scale(2, 3)', rect('transform: scale(2, 3)'), [0, 0, 20, 30]);
await check('scaleX / scaleY', rect('transform: scaleX(2) scaleY(0.5)'), [0, 0, 20, 5]);
await check(
  'matrix(2 0 0 2 5 5) with commas',
  rect('transform: matrix(2, 0, 0, 2, 5, 5)'),
  [5, 5, 25, 25],
);
await check('skewX(45deg)', rect('transform: skewX(45deg)'), [0, 0, 20, 10]);
await check(
  'list order: translate then scale',
  rect('transform: translate(10px, 0) scale(2)'),
  [10, 0, 30, 20],
);
await check(
  'translate in em',
  rect('transform: translate(2em, 0)', 'font-size="5"'),
  [10, 0, 20, 10],
);
await check('percent of the viewBox', rect('transform: translate(50%, 10%)'), [50, 10, 60, 20]);
await check(
  '3D-reducible translate3d',
  rect('transform: translate3d(5px, 6px, 0px)'),
  [5, 6, 15, 16],
);
await check('uppercase function', rect('transform: TranslateX(5px)'), [5, 0, 15, 10]);

// ---- math functions as arguments (calc, min, max, clamp ...) -------------------------------------------------------
await check(
  'calc length with a percentage',
  rect('transform: translate(calc(50% - 10px), 0)'),
  [40, 0, 50, 10],
);
await check(
  'calc two lengths',
  rect('transform: translate(calc(5px + 2em), calc(1px * 3))', 'font-size="5"'),
  [15, 3, 25, 13],
);
await check(
  'min() of a percentage and a length',
  rect('transform: translateX(min(50%, 30px))'),
  [30, 0, 40, 10],
);
await check(
  'max() of a percentage and a length',
  rect('transform: translateX(max(10%, 30px))'),
  [30, 0, 40, 10],
);
await check(
  'clamp() against the reference box',
  rect('transform: translateX(clamp(10px, 80%, 60px))'),
  [60, 0, 70, 10],
);
await check('calc angle', rect('transform: rotate(calc(45deg * 2))'), [-10, 0, 0, 10]);
await check('calc number', rect('transform: scale(calc(1 + 1), calc(3 / 3))'), [0, 0, 20, 10]);
await check(
  'calc inside a list with spaces',
  rect('transform: translate( calc( 10px + 5px ) , 0 ) scale( calc( 1 + 1 ) )'),
  [15, 0, 35, 20],
);
await check(
  'calc in the translate property',
  rect('translate: calc(50% - 10px) calc(10% + 1px)'),
  [40, 11, 50, 21],
);
await check(
  'calc in transform-origin',
  rect('transform: scale(2); transform-origin: calc(50% - 10px) calc(10px + 5px)'),
  [-40, -15, -20, 5],
);
await check(
  'calc percentage of the fill box',
  rect('transform: translateX(calc(50% + 1px)); transform-box: fill-box'),
  [6, 0, 16, 10],
);
await check(
  'an invalid calc is an invalid declaration',
  rect('transform: translateX(calc(1px +))', 'transform="translate(5 5)"'),
  [5, 5, 15, 15],
);
await check(
  'a calc with a unit this parser does not know is invalid',
  rect('transform: translateX(calc(1foo + 2px))', 'transform="translate(5 5)"'),
  [5, 5, 15, 15],
);

// ---- the cascade ------------------------------------------------------------------------------------------------
await check(
  'CSS overrides the attribute',
  rect('transform: translate(1px, 2px)', 'transform="translate(50 50)"'),
  [1, 2, 11, 12],
);
await check(
  'transform: none clears the attribute',
  rect('transform: none', 'transform="translate(50 50)"'),
  [0, 0, 10, 10],
);
await check(
  'an invalid declaration leaves the attribute',
  rect('transform: rotateX(30deg)', 'transform="translate(5 5)"'),
  [5, 5, 15, 15],
);
await check(
  'a rule sets it',
  `<style>.t{transform: translate(7px, 8px)}</style><rect class="t" width="10" height="10" fill="red"/>`,
  [7, 8, 17, 18],
);
await check(
  '!important rule beats inline',
  `<style>rect{transform: translate(7px, 8px) !important}</style>${rect('transform: translate(1px, 1px)')}`,
  [7, 8, 17, 18],
);
await check(
  'the attribute alone is untouched',
  '<rect width="10" height="10" fill="red" transform="rotate(90) translate(1 0)"/>',
  [-10, 1, 0, 11],
);
await check(
  'a group transform applies to its children',
  `<g style="transform: translate(10px, 0)">${rect('transform: translate(0, 20px)')}</g>`,
  [10, 20, 20, 30],
);
await check(
  'use with a CSS transform',
  '<defs><rect id="r" width="10" height="10" fill="red"/></defs><use href="#r" x="5" style="transform: translate(10px, 0)"/>',
  [15, 0, 25, 10],
);

// ---- transform-origin ---------------------------------------------------------------------------------------------
await check(
  'origin lengths',
  rect('transform: rotate(90deg); transform-origin: 15px 15px', '', 10, 10),
  [10, 10, 20, 20],
);
await check(
  'origin 0 0 is the default',
  rect('transform: rotate(90deg)', '', 10, 10),
  [-20, 10, -10, 20],
);
await check(
  'origin right bottom of the viewBox',
  rect('transform: scale(0.5); transform-origin: right bottom'),
  [50, 50, 55, 55],
);
await check(
  'origin percentages of the viewBox',
  rect('transform: scale(2); transform-origin: 50% 50%'),
  [-50, -50, -30, -30],
);
await check(
  'origin center',
  rect('transform: scale(2); transform-origin: center'),
  [-50, -50, -30, -30],
);
await check(
  'origin one keyword (bottom)',
  rect('transform: scale(2); transform-origin: bottom'),
  [-50, -100, -30, -80],
);
await check(
  'origin swapped keywords',
  rect('transform: scale(0.5); transform-origin: bottom right'),
  [50, 50, 55, 55],
);
await check(
  'origin applies to the attribute transform',
  rect('transform-origin: 10px 10px', 'transform="scale(2)"'),
  [-10, -10, 10, 10],
);
await check(
  'origin alone, no transform, changes nothing',
  rect('transform-origin: 30px 30px'),
  [0, 0, 10, 10],
);

// ---- transform-box -----------------------------------------------------------------------------------------------
await check(
  'fill-box default origin is the box corner',
  rect('transform: scale(2); transform-box: fill-box', '', 10, 10),
  [10, 10, 30, 30],
);
await check(
  'fill-box center',
  rect('transform: scale(2); transform-box: fill-box; transform-origin: center', '', 10, 10),
  [5, 5, 25, 25],
);
await check(
  'fill-box percentages',
  rect('transform: rotate(90deg); transform-box: fill-box; transform-origin: 50% 50%', '', 10, 10),
  [10, 10, 20, 20],
);
await check(
  'content-box is the fill box',
  rect('transform: scale(2); transform-box: content-box; transform-origin: center', '', 10, 10),
  [5, 5, 25, 25],
);
await check(
  'stroke-box and border-box are the fill box',
  rect('transform: scale(2); transform-box: stroke-box; transform-origin: center', '', 10, 10),
  [5, 5, 25, 25],
);
await check(
  'an unknown transform-box is view-box',
  rect('transform: scale(2); transform-box: nonsense; transform-origin: center'),
  [-50, -50, -30, -30],
);
{
  // a group: the box is the union of its children (each with its own transform), the group's own transform excluded
  const body =
    '<g style="transform: scale(2); transform-box: fill-box; transform-origin: center">' +
    '<rect width="10" height="10" fill="red"/><rect x="30" width="10" height="10" fill="red"/></g>';
  const b = await imp(wrap(body));
  const r = rows(b)
    .filter(red)
    .map((x) => x.bbox.map((v) => +v.toFixed(3)));
  ok(
    r.length === 2 && near(r[0], [-20, -5, 0, 15], E) && near(r[1], [40, -5, 60, 15], E),
    `fill-box of a group is its children's union: ${JSON.stringify(r)}`,
  );
}
{
  const body =
    '<defs><g id="g"><rect width="10" height="10" fill="red"/></g></defs>' +
    '<use href="#g" x="10" style="transform: scale(2); transform-box: fill-box; transform-origin: center"/>';
  await check('fill-box of a use covers its instance', body, [5, -5, 25, 15]);
}
await check(
  'view-box follows the nested svg viewport',
  `<svg width="40" height="40" viewBox="0 0 20 20">${rect('transform: scale(0.5); transform-origin: right bottom')}</svg>`,
  [20, 20, 30, 30],
  'viewBox="0 0 100 100"',
);

// ---- translate, rotate, scale properties ------------------------------------------------------------------------
await check('translate property', rect('translate: 20px 30px'), [20, 30, 30, 40]);
await check('translate property, one value', rect('translate: 20px'), [20, 0, 30, 10]);
await check('translate property percent', rect('translate: 50% 10%'), [50, 10, 60, 20]);
await check('scale property', rect('scale: 2'), [0, 0, 20, 20]);
await check('scale property, two values', rect('scale: 2 3'), [0, 0, 20, 30]);
await check('rotate property', rect('rotate: 90deg'), [-10, 0, 0, 10]);
await check('rotate property about z', rect('rotate: z 90deg'), [-10, 0, 0, 10]);
await check('rotate property about an x axis is invalid', rect('rotate: x 90deg'), [0, 0, 10, 10]);
await check(
  'spec order: translate, rotate, scale, then transform',
  rect('translate: 10px 0; scale: 2; transform: translate(1px, 0)'),
  [12, 0, 32, 20],
);
await check('rotate then scale', rect('rotate: 90deg; scale: 2'), [-20, 0, 0, 20]);
await check(
  'the properties apply around the origin',
  rect('scale: 2; transform-origin: 10px 10px'),
  [-10, -10, 10, 10],
);
await check(
  'the properties compose with the attribute transform',
  rect('translate: 10px 0', 'transform="scale(2)"'),
  [10, 0, 30, 20],
);
await check(
  'none values',
  rect('translate: none; rotate: none; scale: none; transform: none'),
  [0, 0, 10, 10],
);

// ---- identical output for an element with no CSS transform property ---------------------------------------------
{
  const a = await imp(
    wrap('<rect width="10" height="10" fill="red" transform="translate(5 5) rotate(45)"/>'),
  );
  const c = await imp(
    wrap(
      '<rect width="10" height="10" fill="red" transform="translate(5 5) rotate(45)" style="fill: red"/>',
    ),
  );
  ok(
    Buffer.compare(Buffer.from(a.meta), Buffer.from(c.meta)) === 0,
    'an element with the attribute and unrelated style is unchanged',
  );
}
done();
