// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// useSwitchGroupSmoke -- <use> and <switch> compose their content as one compositing group.
//
// CSS Compositing 1 §3 / SVG 1.1 §14.5: a <use> with opacity below 1, a mix-blend-mode other than normal or
// isolation: isolate composes its whole instance as a group, in addition to the referenced element's own group
// properties; the same holds for the selected child of a <switch>. A group is the row triple B(opacity,blend,isolation),
// the member rows, E. An element with none of those properties adds no group.
//
// GL-free: reads the meta rows back.
import { imp, wrap, rows, sequence, near, makeChecker } from './_importSemantics.mjs';

const { ok, done } = makeChecker('USE-SWITCH-GROUP');
const seq = async (body) => sequence(await imp(wrap(body)));
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const DEFS =
  '<defs><rect id="r" width="10" height="10" fill="red"/>' +
  '<g id="g" opacity=".5"><rect width="10" height="10"/><rect x="5" width="10" height="10"/></g>' +
  '<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></symbol></defs>';

{
  const got = await seq(DEFS + '<use href="#r" opacity=".5"/>');
  ok(same(got, ['B(0.5,0,0)', 'S', 'E']), `use opacity .5 groups its instance: ${got}`);
}
{
  const got = await seq(DEFS + '<use href="#r" style="opacity:.25"/>');
  ok(same(got, ['B(0.25,0,0)', 'S', 'E']), `use opacity from style: ${got}`);
}
{
  const got = await seq('<style>use{opacity:.5}</style>' + DEFS + '<use href="#r"/>');
  ok(same(got, ['B(0.5,0,0)', 'S', 'E']), `use opacity from a rule: ${got}`);
}
{
  const got = await seq(DEFS + '<use href="#r"/>');
  ok(same(got, ['S']), `a plain use adds no group: ${got}`);
}
{
  const got = await seq(DEFS + '<use href="#g" opacity=".5"/>');
  ok(
    same(got, ['B(0.5,0,0)', 'B(0.5,0,0)', 'S', 'S', 'E', 'E']),
    `use of a group with its own opacity: both groups, use outside: ${got}`,
  );
}
{
  const got = await seq(DEFS + '<use href="#g"/>');
  ok(
    same(got, ['B(0.5,0,0)', 'S', 'S', 'E']),
    `use of a group keeps the group's own opacity only: ${got}`,
  );
}
{
  const got = await seq(DEFS + '<use href="#r" style="mix-blend-mode:multiply"/>');
  ok(same(got, ['B(1,1,0)', 'S', 'E']), `use mix-blend-mode multiply groups with blend 1: ${got}`);
}
{
  const got = await seq(DEFS + '<use href="#r" style="isolation:isolate"/>');
  ok(same(got, ['B(1,0,1)', 'S', 'E']), `use isolation isolate groups with isolation 1: ${got}`);
}
{
  const got = await seq(DEFS + '<use href="#s" width="20" height="20" opacity=".5"/>');
  ok(same(got, ['B(0.5,0,0)', 'S', 'E']), `use of a symbol groups its instance: ${got}`);
}
{
  const got = await seq(DEFS + '<g opacity=".5"><use href="#r" opacity=".5"/></g>');
  ok(
    same(got, ['B(0.5,0,0)', 'B(0.5,0,0)', 'S', 'E', 'E']),
    `nested: g group around the use group: ${got}`,
  );
}
{
  // The leaf keeps its own opacity as a fill alpha inside the use's group
  const b = await imp(
    wrap(
      '<defs><rect id="q" width="10" height="10" fill="red" opacity=".5"/></defs><use href="#q" opacity=".5"/>',
    ),
  );
  const s = rows(b).filter((r) => !(r.flags & 192));
  ok(
    same(sequence(b), ['B(0.5,0,0)', 'S', 'E']) && Math.abs(s[0].fill[3] - 0.5) < 1e-6,
    `leaf opacity stays on the shape inside the use group: ${s[0].fill[3]}`,
  );
}
{
  // The inherited-property cascade is unchanged: the use is the parent of the referenced content.
  const b = await imp(
    wrap(
      '<defs><rect id="q" width="10" height="10"/></defs><use href="#q" fill="blue" x="20" opacity=".5"/>',
    ),
  );
  const s = rows(b).filter((r) => !(r.flags & 192));
  ok(
    s.length === 1 && near(s[0].fill, [0, 0, 1, 1], 1e-6) && near(s[0].bbox, [20, 0, 30, 10], 1e-6),
    `use fill and x still reach the instance: ${s[0].fill} ${s[0].bbox}`,
  );
}
{
  const got = await seq(DEFS + '<use href="#r" opacity=".5" display="none"/>');
  ok(same(got, []), `display:none use adds nothing: ${got}`);
}
{
  const got = await seq(DEFS + '<use href="#missing" opacity=".5"/>');
  ok(same(got, []), `a use with a missing target adds no group: ${got}`);
}

// ---- switch -----------------------------------------------------------------------------------------------------
const SW = (attrs, kids) => `<switch ${attrs}>${kids}</switch>`;
const R = (extra = '') => `<rect width="10" height="10" fill="red" ${extra}/>`;
{
  const got = await seq(SW('opacity=".5"', R('systemLanguage="xx"') + R('x="20"')));
  ok(same(got, ['B(0.5,0,0)', 'S', 'E']), `switch opacity groups the selected child: ${got}`);
}
{
  const got = await seq(SW('style="mix-blend-mode:screen"', R('x="20"')));
  ok(same(got, ['B(1,2,0)', 'S', 'E']), `switch mix-blend-mode screen: ${got}`);
}
{
  const got = await seq(SW('', R('x="20"')));
  ok(same(got, ['S']), `a plain switch adds no group: ${got}`);
}
{
  const got = await seq(SW('opacity=".5"', R('systemLanguage="xx"')));
  ok(same(got, []), `a switch with no matching child paints nothing and adds no rows: ${got}`);
}
done();
