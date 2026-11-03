// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFilterCarrySmoke -- a morph between poses where the filter differs on a row (none to a filter, a filter to none, one filter to
// another) carries the filter of the ACTIVE pose through the morph: the source's below the middle, the destination's from there, exactly the
// source's at t = 0 and the destination's at t = 1. A filter id read from the merged source pose only would never show a target-only filter
// (not even at t = 1), and would turn a filtered leaf or <g> that only the target has into an empty destination-only group.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createShapeMorph, createOverrideTable } from '../src/index.js';
console.warn = () => {};

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));
const TS = [0, 0.25, 0.499999, 0.5, 0.75, 1, 0.75, 0.499999, 0.25, 0];
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><filter id="f2"><feGaussianBlur stdDeviation="2"/></filter><filter id="f6"><feGaussianBlur stdDeviation="6"/></filter></defs>${body}</svg>`;
const flt = (f) => (f ? `filter="url(#${f})"` : '');
const LEAF = (x, f) =>
  `<rect id="a" x="${x}" y="10" width="30" height="30" fill="red" stroke="blue" stroke-width="8" ${flt(f)}/>`;
const FILL = (x, f) => `<rect id="a" x="${x}" y="10" width="30" height="30" fill="red" ${flt(f)}/>`;
const GRP = (x, f) =>
  `<g ${flt(f)}><rect id="a" x="${x}" y="10" width="30" height="30" fill="red"/><rect id="b" x="${x}" y="45" width="10" height="10" fill="green"/></g>`;
// What a filter id draws: its record and its graph (a simple blur is a record kind; a graph carries its nodes).
const sigOf = (bundle, id) => {
  if (!(id > 0)) return 'none';
  const tab = new Float32Array(bundle.filterTab || bundle.lastFilterFloats);
  return JSON.stringify([
    [...tab.slice((id - 1) * 24, id * 24)],
    bundle.filterGraphs?.[id - 1] || null,
  ]);
};

// The blur radius a row is drawn with at t: 0 for none.
async function run(name, make, fa, fb) {
  const { gl } = makeFakeWebgl2(64, 64);
  const a = createBundle(gl, await importSvg(doc(make(10, fa))));
  const b = createBundle(gl, await importSvg(doc(make(20, fb))));
  const m = createShapeMorph(gl, a, b, { cpuLerp: true });
  const bundle = m.bundle,
    st = bundle.metaFloatsPerShape;
  const sa = sigOf(a, fa ? 1 : 0),
    sb = sigOf(b, fb ? 1 : 0);
  const rows = [];
  for (let r = 0; r < bundle.numShapes; r++) rows.push(r);
  let bad = '';
  for (const t of TS) {
    m.setT(t);
    const ids = rows.map((r) => Math.round(bundle.metaFloats[r * st + 32]));
    const got = new Set(ids.filter((id) => id > 0).map((id) => sigOf(bundle, id)));
    // The draw list the renderer walks says the same: the ops of the filtered rows name the active filter (graph ops by filterGraphId).
    const opIds = bundle.drawList
      .filter((op) => op.kind !== 'groupEnd')
      .map((op) => op.filterGraphId || op.filterId || 0)
      .filter((id) => id > 0);
    const opSigs = new Set(opIds.map((id) => sigOf(bundle, id)));
    if ([...opSigs].sort().join() !== [...got].sort().join())
      bad += ` t=${t}: draw ops name ${opSigs.size} filter(s), meta ${got.size};`;
    const want = t >= 0.5 ? sb : sa;
    // The filtered rows (the group's begin row, or the leaf row) all wear the active pose's filter; nothing wears another.
    if (want === 'none' ? got.size !== 0 : !(got.size === 1 && got.has(want)))
      bad += ` t=${t}: drew ${got.size ? [...got].map((g) => g.slice(0, 40)) : 'none'};`;
  }
  check(!bad, `${name}: the active pose filter at t = 0, .25, .5, .75, 1 and back${bad}`);
  return { m, bundle };
}
for (const [fa, fb] of [
  [null, 'f2'],
  ['f2', null],
  ['f2', 'f6'],
  ['f2', 'f2'],
]) {
  const tag = `${fa || 'none'} -> ${fb || 'none'}`;
  await run(`fill+stroke leaf ${tag}`, LEAF, fa, fb);
  await run(`fill-only leaf ${tag}`, FILL, fa, fb);
  await run(`<g filter> ${tag}`, GRP, fa, fb);
}

// A shared filter does not become two: identical records in both poses keep the source's id, with no step.
{
  const { gl } = makeFakeWebgl2(64, 64);
  const a = createBundle(gl, await importSvg(doc(FILL(10, 'f2')))),
    b = createBundle(gl, await importSvg(doc(FILL(20, 'f2'))));
  const m = createShapeMorph(gl, a, b, { cpuLerp: true });
  check(
    m.bundle._morphSrc.bindingSteps.length === 0,
    'the same filter in both poses is not a step',
  );
  check(
    new Float32Array(m.bundle.filterTab).length === 24,
    'the same filter in both poses is one record',
  );
}

// The group filter region is stated against the members' boxes; a morph carries the fractions and the rows (re-resolved at draw time).
{
  const { gl } = makeFakeWebgl2(64, 64);
  const a = createBundle(gl, await importSvg(doc(GRP(10, 'f2')))),
    b = createBundle(gl, await importSvg(doc(GRP(20, 'f2'))));
  const m = createShapeMorph(gl, a, b, { cpuLerp: true });
  const rg = m.bundle.filterRegionObb && m.bundle.filterRegionObb[0];
  check(
    rg && rg.length === 5 && Array.isArray(rg[4]) && rg[4].length === 2,
    `a group filter region keeps its fractions and member rows (${JSON.stringify(rg)})`,
  );
}
// Filter boundaries inherit group transforms; their member paints own visibility and tint.
{
  const { gl } = makeFakeWebgl2(64, 64);
  const b = createBundle(
    gl,
    await importSvg(
      doc(
        '<g id="G" filter="url(#f2)"><rect id="a" x="10" y="10" width="30" height="30" fill="red"/></g>',
      ),
    ),
  );
  const table = createOverrideTable(gl, b);
  check(
    table.set('G', { localPosition: [12, 4], visibility: 0.5, tint: [0.5, 1, 1, 0.5] }),
    'filtered group id accepts an override',
  );
  const st = b.metaFloatsPerShape,
    data = table.packedBuffer;
  for (let row = 0; row < b.numShapes; row++) {
    const boundary = (b.metaFloats[row * st + 27] & (64 | 128)) !== 0,
      o = row * 24;
    check(data[o + 4] === 12 && data[o + 5] === 4, 'group transform reaches row ' + row);
    check(
      data[o + 6] === (boundary ? 1 : 0.5) && data[o + 11] === (boundary ? 1 : 0.5),
      'group visual override is applied once for row ' + row,
    );
  }
  table.clear('G');
  check(
    [...data].every(
      (value, index) =>
        value ===
        [1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0][index % 24],
    ),
    'clearing group override restores all boundary and member records',
  );
  table.dispose();
  b.dispose();
}
if (failures) {
  console.error(`morphFilterCarrySmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nmorphFilterCarrySmoke: the active pose filter is carried through the morph');
