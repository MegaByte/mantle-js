// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphGroupOpacitySmoke -- a leaf with opacity below 1 over both a fill and a stroke is one composited group, and a morph
// between two poses where the leaf is a group in one and not in the other composes the groups (src/core/morphGroups.js).
//
// A leaf without a group is a group with opacity 1. For three transitions (.5 -> 1, .5 -> .8, 1 -> .5) the merged
// morph must keep one group around the same two shapes in painter order, and its opacity at t is the lerp of the poses' own: exactly
// the source's at t = 0 and the target's at t = 1. The renderer reads group opacity as mergedMeta * (1 - t) + dstMeta * t for a MATCHED
// begin row (renderer.js _groupBegin), so the proof here is on those arrays, the draw list and the plan; the pixels are proven by
// test/morphGroupOpacityGpuSmoke.mjs (every route) and test/morphGroupOpacityRenderSmoke.mjs (Chrome at 8x).
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createShapeMorph, createSpriteMorph } from '../src/index.js';
console.warn = () => {};

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
const LEAF = (o, x = 10, extra = '', id = ' id="a"') =>
  `<rect${id} x="${x}" y="10" width="30" height="30" fill="red" stroke="blue" stroke-width="8" ${o === 1 ? '' : `opacity="${o}"`} ${extra}/>`;
const TS = [0, 0.25, 0.5, 0.75, 1];

// What the draw list shows: the rows in painter order, by kind.
function scene(bundle) {
  return bundle.drawList.map((op) =>
    op.kind === 'groupBegin' ? 'B' + op.shapeIdx : op.kind === 'groupEnd' ? 'E' : 'f' + op.shapeIdx,
  );
}
const lerpAt = (ms, row, slot, t) =>
  ms.mergedMetaF32[row * ms.metaStride + slot] * (1 - t) +
  ms.dstMetaF32[row * ms.metaStride + slot] * t;

// ---- the static half: when a plain leaf is a group -------------------------------------------------------------------------------
{
  const rows = async (body) => {
    const s = await importSvg(doc(body));
    return { n: s.numShapes, ids: s.shapeIds };
  };
  const one = await rows(LEAF(0.5));
  check(
    one.n === 4 && one.ids[1] === 'a' && one.ids[2] === 'a_stroke',
    `fill+stroke leaf with opacity .5 is [begin, fill, stroke, end] (${one.n} rows: ${JSON.stringify(one.ids)})`,
  );
  check((await rows(LEAF(1))).n === 2, 'the same leaf at opacity 1 keeps two rows (no group)');
  check(
    (await rows('<rect x="10" y="10" width="30" height="30" fill="red" opacity=".5"/>')).n === 1,
    'a fill-only leaf with opacity keeps one row',
  );
  check(
    (
      await rows(
        '<rect x="10" y="10" width="30" height="30" fill="none" stroke="blue" stroke-width="8" opacity=".5"/>',
      )
    ).n === 1,
    'a stroke-only leaf with opacity keeps one row',
  );
  check(
    (
      await rows(
        '<rect x="10" y="10" width="30" height="30" fill="red" fill-opacity="0" stroke="blue" stroke-width="8" opacity=".5"/>',
      )
    ).n === 2,
    'fill-opacity 0 keeps its fill row at alpha 0: two rows, no group',
  );
  check(
    (
      await rows(
        '<rect x="10" y="10" width="30" height="30" fill="red" stroke="blue" stroke-opacity="0" stroke-width="8" opacity=".5"/>',
      )
    ).n === 2,
    'stroke-opacity 0 keeps its stroke row at alpha 0: two rows, no group',
  );
  const sheet = await importSvg(
    doc(LEAF(0.5) + '<circle id="c" cx="50" cy="50" r="5" fill="green"/>'),
  );
  check(
    JSON.stringify(sheet.spriteRanges) === JSON.stringify({ a: [0, 3], c: [4, 4] }),
    `sprite ranges span the group rows ${JSON.stringify(sheet.spriteRanges)}`,
  );
}

// ---- the three transitions: rows in painter order, opacity at t ------------------------------------------------------------------
async function morphOf(oa, ob, opts = {}, id = ' id="a"') {
  const { gl } = makeFakeWebgl2(64, 64);
  const a = createBundle(gl, await importSvg(doc(LEAF(oa, 10, '', id))));
  const b = createBundle(gl, await importSvg(doc(LEAF(ob, 20, '', id))));
  return createShapeMorph(gl, a, b, { cpuLerp: true, ...opts });
}
for (const named of [true, false])
  for (const [oa, ob] of [
    [0.5, 1],
    [0.5, 0.8],
    [1, 0.5],
    [0.8, 0.3],
    [1, 1],
  ]) {
    const m = await morphOf(oa, ob, {}, named ? ' id="a"' : '');
    const bundle = m.bundle,
      ms = bundle._morphSrc;
    const grouped = oa < 1 || ob < 1;
    const list = scene(bundle);
    const name = `${named ? 'named' : 'unnamed'} opacity ${oa} -> ${ob}`;
    if (!grouped) {
      check(list.length === 2 && !list.some((x) => x[0] === 'B'), `${name}: no group, two rows`);
      continue;
    }
    const kinds = list.map((x) => x[0]).join('');
    check(kinds === 'BffE', `${name}: scene order is begin, fill, stroke, end (${list.join(' ')})`);
    const begin = Number(list[0].slice(1));
    check(
      ms.matchedAll === true && bundle.numShapes === 4,
      `${name}: every row is matched (the Loop-Blinn route stays eligible), ${bundle.numShapes} rows`,
    );
    check(
      ms.matchedSrcIdxs.includes(begin),
      `${name}: the begin row is a matched row (the renderer lerps its opacity)`,
    );
    const fillRow = Number(list[1].slice(1)),
      strokeRow = Number(list[2].slice(1));
    check(
      m.plan.matched.length === 4 && m.plan.srcOnly.length === 0 && m.plan.dstOnly.length === 0,
      `${name}: the fill, the stroke and both group rows are matched; nothing fades (${m.plan.matched.length} matched, ${m.plan.srcOnly.length} out, ${m.plan.dstOnly.length} in)`,
    );
    if (named)
      check(
        bundle.shapeIds[fillRow] === 'a' && bundle.shapeIds[strokeRow] === 'a_stroke',
        `${name}: the group wraps the same two shapes (${bundle.shapeIds[fillRow]}, ${bundle.shapeIds[strokeRow]})`,
      );
    for (const t of TS) {
      const want = oa + (ob - oa) * t,
        got = lerpAt(ms, begin, 7, t);
      if (Math.abs(got - want) > 1e-6)
        fail(`${name}: group opacity at t=${t} is ${got}, wanted ${want}`);
      for (const row of [fillRow, strokeRow]) {
        const f = lerpAt(ms, row, row === fillRow ? 7 : 11, t);
        if (Math.abs(f - 1) > 1e-6)
          fail(
            `${name}: row ${row} paint alpha at t=${t} is ${f}; the group carries the opacity, the paint stays 1`,
          );
      }
    }
    check(
      lerpAt(ms, begin, 7, 0) === Math.fround(oa) && lerpAt(ms, begin, 7, 1) === Math.fround(ob),
      `${name}: exactly the source's opacity at t = 0 (${oa}) and the target's at t = 1 (${ob})`,
    );
    m.dispose();
  }

// ---- overrides: the morph's own table still addresses the leaf by id, and a user override rides the group -------------------------
{
  const m = await morphOf(1, 0.5);
  const ov = m.overrides;
  check(
    ov.set('a', { visibility: 0.5 }) === true &&
      ov.set('a_stroke', { tint: [1, 1, 1, 0.5] }) === true,
    'the morph table resolves a and a_stroke (rows appended to the source keep their ids)',
  );
  check(
    scene(m.bundle).join(' ') === scene((await morphOf(1, 0.5)).bundle).join(' '),
    'an override does not change the scene order',
  );
}

// ---- sprites: a whole sheet morphs by sprite id with the group rows inside the range -----------------------------------------------
{
  const { gl } = makeFakeWebgl2(64, 64);
  const sheet = (o, x) => doc(LEAF(o, x) + '<circle id="c" cx="50" cy="50" r="5" fill="green"/>');
  const A = createBundle(gl, await importSvg(sheet(0.5, 10))),
    B = createBundle(gl, await importSvg(sheet(1, 20)));
  const m = createSpriteMorph(
    gl,
    { bundle: A, sprite: 'a' },
    { bundle: B, sprite: 'a' },
    { cpuLerp: true },
  );
  const ms = m.bundle._morphSrc,
    list = scene(m.bundle);
  const sprite = list.filter((x) => Number(x.slice(1)) <= 3 || x === 'E');
  check(
    list.some((x) => x[0] === 'B'),
    'sprite morph a -> a keeps its group',
  );
  const begin = Number(list.find((x) => x[0] === 'B').slice(1));
  check(
    lerpAt(ms, begin, 7, 0) === 0.5 && lerpAt(ms, begin, 7, 1) === 1,
    `sprite morph: group opacity .5 at t = 0 and 1 at t = 1 (${lerpAt(ms, begin, 7, 0)}, ${lerpAt(ms, begin, 7, 1)})`,
  );
  const rev = createSpriteMorph(
    gl,
    { bundle: B, sprite: 'a' },
    { bundle: A, sprite: 'a' },
    { cpuLerp: true },
  );
  const rl = scene(rev.bundle),
    rb = Number(rl.find((x) => x[0] === 'B').slice(1)),
    rms = rev.bundle._morphSrc;
  check(
    rl
      .map((x) => x[0])
      .join('')
      .replace(/f/g, 'f')
      .includes('BffE') &&
      lerpAt(rms, rb, 7, 0) === 1 &&
      lerpAt(rms, rb, 7, 1) === 0.5,
    `sprite morph 1 -> .5: group around both shapes in order, opacity 1 -> .5 (${rl.join(' ')})`,
  );
  check(
    JSON.stringify(rev.bundle.spriteRanges) === JSON.stringify(B.spriteRanges),
    "the source sheet's sprite ranges are carried unchanged",
  );
}

// ---- several leaves, nesting, and unnamed rows whose synthetic numbers all shift -----------------------------------------------------------
{
  const { gl } = makeFakeWebgl2(64, 64);
  const leaf = (x, o, id = '') =>
    `<rect${id} x="${x}" y="10" width="10" height="30" fill="red" stroke="blue" stroke-width="4"${o === 1 ? '' : ` opacity="${o}"`}/>`;
  const mk = async (body) => createBundle(gl, await importSvg(doc(body)));
  const kinds = (b) =>
    scene(b)
      .map((x) => x[0])
      .join('');
  const lerp = (m, k, t) =>
    lerpAt(
      m.bundle._morphSrc,
      Number(
        scene(m.bundle)
          .filter((x) => x[0] === 'B')
          [k].slice(1),
      ),
      7,
      t,
    );
  // two unnamed leaves: the first is a group in A only, the second in B only
  const m1 = createShapeMorph(
    gl,
    await mk(leaf(5, 0.5) + leaf(30, 1)),
    await mk(leaf(8, 1) + leaf(33, 0.4)),
    { cpuLerp: true },
  );
  check(
    kinds(m1.bundle) === 'BffEBffE' &&
      m1.plan.matched.length === m1.bundle.numShapes &&
      m1.plan.srcOnly.length === 0 &&
      m1.plan.dstOnly.length === 0,
    `two leaves, the first grouped only in A and the second only in B: ${kinds(m1.bundle)}, ${m1.plan.matched.length}/${m1.bundle.numShapes} matched, no fades`,
  );
  check(
    near(lerp(m1, 0, 0.5), 0.75) &&
      near(lerp(m1, 1, 0.5), 0.7) &&
      lerp(m1, 0, 0) === 0.5 &&
      lerp(m1, 1, 0) === 1 &&
      lerp(m1, 1, 1) === Math.fround(0.4),
    `... the first group runs .5 -> 1, the second 1 -> .4 (${lerp(m1, 0, 0.5)}, ${lerp(m1, 1, 0.5)})`,
  );
  const ids = m1.bundle.shapeIds;
  // a leaf group inside a <g opacity>, against the bare leaf
  const m2 = createShapeMorph(
    gl,
    await mk(`<g opacity="0.6">${leaf(5, 0.5)}</g>`),
    await mk(leaf(8, 1)),
    { cpuLerp: true },
  );
  check(
    kinds(m2.bundle) === 'BBffEE' && near(lerp(m2, 0, 0.5), 0.8) && near(lerp(m2, 1, 0.5), 0.75),
    `nested source groups both end at 1 (${kinds(m2.bundle)}, outer at .5: ${lerp(m2, 0, 0.5)}, inner: ${lerp(m2, 1, 0.5)})`,
  );
  const m3 = createShapeMorph(
    gl,
    await mk(leaf(8, 1)),
    await mk(`<g opacity="0.6">${leaf(5, 0.5)}</g>`),
    { cpuLerp: true },
  );
  check(
    kinds(m3.bundle) === 'BBffEE' &&
      near(lerp(m3, 0, 0.5), 0.8) &&
      near(lerp(m3, 1, 0.5), 0.75) &&
      lerp(m3, 0, 0) === 1 &&
      lerp(m3, 1, 0) === 1,
    `nested target groups open from 1 (${kinds(m3.bundle)}, outer at .5: ${lerp(m3, 0, 0.5)}, inner: ${lerp(m3, 1, 0.5)})`,
  );
  // a target-only leaf next to a carried group: the new shape fades in, outside the group
  const m4 = createShapeMorph(
    gl,
    await mk(leaf(5, 0.5)),
    await mk(leaf(8, 0.5) + '<circle cx="50" cy="20" r="5" fill="green"/>'),
    { cpuLerp: true },
  );
  check(
    kinds(m4.bundle) === 'BffEf' && m4.plan.dstOnly.length === 1,
    `a target-only shape after a carried group lands after it (${kinds(m4.bundle)})`,
  );
  // groups that cannot nest are left alone (no crash, legacy matching)
  const m5 = createShapeMorph(gl, await mk(leaf(5, 0.5)), await mk(leaf(5, 0.5, ' id="z"')), {
    cpuLerp: true,
  });
  check(kinds(m5.bundle).includes('B'), 'differently named leaves still build a morph');
}

// ---- other groups are not disturbed ------------------------------------------------------------------------------------------------
{
  const { gl } = makeFakeWebgl2(64, 64);
  const mk = async (o, x) =>
    createBundle(
      gl,
      await importSvg(
        doc(
          `<g opacity="${o}"><rect id="r" x="${x}" y="10" width="30" height="30" fill="red"/></g><circle id="c" cx="50" cy="50" r="5" fill="green"/>`,
        ),
      ),
    );
  const m = createShapeMorph(gl, await mk(0.5, 10), await mk(0.9, 20), { cpuLerp: true });
  const ms = m.bundle._morphSrc,
    list = scene(m.bundle),
    begin = Number(list.find((x) => x[0] === 'B').slice(1));
  check(
    list.join(' ') === 'B0 f1 E f3' || list.map((x) => x[0]).join('') === 'BfEf',
    `a <g opacity> morph keeps its scene (${list.join(' ')})`,
  );
  check(
    Math.abs(lerpAt(ms, begin, 7, 0.5) - 0.7) < 1e-6,
    `... and lerps the group opacity .5 -> .9 (at .5: ${lerpAt(ms, begin, 7, 0.5)})`,
  );
  const g1 = await importSvg(
    doc('<g opacity=".5"><rect id="r" x="10" y="10" width="30" height="30" fill="red"/></g>'),
  );
  const g0 = await importSvg(
    doc('<g><rect id="r" x="20" y="10" width="30" height="30" fill="red"/></g>'),
  );
  const m2 = createShapeMorph(gl, createBundle(gl, g1), createBundle(gl, g0), { cpuLerp: true });
  const l2 = scene(m2.bundle),
    b2 = Number(l2.find((x) => x[0] === 'B').slice(1));
  check(
    lerpAt(m2.bundle._morphSrc, b2, 7, 1) === 1,
    `a <g opacity=".5"> against a plain <g> (no group row) ends at opacity 1 (${l2.join(' ')})`,
  );
}

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nmorphGroupOpacitySmoke: leaf opacity groups and the group policy hold on all three transitions, sprites and overrides',
);
