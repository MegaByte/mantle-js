// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphLeafPropsSmoke -- a morph interpolates each CSS property on its own, as an animation of the authored properties does.
//
// A faded fill+stroke leaf is a group (opacity) around a fill row (fill-opacity) and a stroke row (stroke-opacity). When the group's opacity and
// the rows' own opacities all move in one morph, the picture is the product of the lerps -- exactly what CSS gives when `opacity`,
// `fill-opacity` and `stroke-opacity` animate separately (.5625 at the middle of .5 -> 1 against 1 -> .5, not a straight .5). The proof: the rows
// of the morph at t are the rows of the AUTHORED pose whose properties are those lerps, for every t, so what is drawn is that pose.
// Also pinned: a shape only the target has, inside a group both poses have, is a member of that group while it fades in and is exactly the
// target's at t = 1.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
import { makeFakeWebgl2 } from './_fakeWebgl2.mjs';
import { importSvg, createBundle, createShapeMorph } from '../src/index.js';
console.warn = () => {};

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));
const TS = [0, 0.25, 0.5, 0.75, 1];
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
const leaf = (x, o, fo, so) =>
  `<rect id="a" x="${x}" y="10" width="30" height="30" fill="red" stroke="blue" stroke-width="8" opacity="${o}" fill-opacity="${fo}" stroke-opacity="${so}"/>`;
const lerp = (a, b, t) => a * (1 - t) + b * t;
const f32 = Math.fround;

{
  const { gl } = makeFakeWebgl2(64, 64);
  const A = createBundle(gl, await importSvg(doc(leaf(10, 0.5, 1, 1)))),
    B = createBundle(gl, await importSvg(doc(leaf(20, 1, 0.5, 0.5))));
  const m = createShapeMorph(gl, A, B, { cpuLerp: true });
  const ms = m.bundle._morphSrc,
    st = ms.metaStride,
    n = m.bundle.numShapes;
  const rowAt = (r, slot, t) =>
    lerp(ms.mergedMetaF32[r * st + slot], ms.dstMetaF32[r * st + slot], t);
  const groupRow = [...Array(n).keys()].find((r) => Math.round(ms.mergedMetaF32[r * st + 27]) & 64);
  const paintRows = [...Array(n).keys()].filter(
    (r) => !(Math.round(ms.mergedMetaF32[r * st + 27]) & (64 | 128)),
  );
  for (const t of TS) {
    const go = rowAt(groupRow, 7, t),
      expectedGo = lerp(0.5, 1, t);
    check(Math.abs(go - expectedGo) < 1e-6, `group opacity at t=${t} is ${expectedGo} (${go})`);
    // the authored pose at t: opacity, fill-opacity, stroke-opacity each lerped
    const pose = await importSvg(
      doc(leaf(lerp(10, 20, t), lerp(0.5, 1, t), lerp(1, 0.5, t), lerp(1, 0.5, t))),
    );
    const pm = new Float32Array(pose.meta, 32);
    const prow = [...Array(pose.numShapes).keys()];
    const pg = prow.find((r) => Math.round(pm[r * st + 27]) & 64),
      pp = prow.filter((r) => !(Math.round(pm[r * st + 27]) & (64 | 128)));
    const pgo = pg === undefined ? 1 : pm[pg * st + 7]; // opacity 1 is no group at all
    check(
      Math.abs(pgo - go) < 1e-6,
      `t=${t}: the authored pose's group opacity is the morph's (${pgo} / ${go})`,
    );
    const same = pp.every(
      (r, i) =>
        Math.abs(pm[r * st + 7] - rowAt(paintRows[i], 7, t)) < 1e-6 &&
        Math.abs(pm[r * st + 11] - rowAt(paintRows[i], 11, t)) < 1e-6,
    );
    check(
      same,
      `t=${t}: the fill and stroke rows are the authored pose's (fill alpha ${pm[pp[0] * st + 7]}, stroke alpha ${pm[pp[0] * st + 11]} / ${pm[pp[1] * st + 11]})`,
    );
  }
  // the product at the middle is the CSS one
  const mid = rowAt(groupRow, 7, 0.5) * rowAt(paintRows[0], 7, 0.5);
  check(
    Math.abs(mid - 0.5625) < 1e-6,
    `at t=.5 the fill shows ${mid} (opacity .75 x fill-opacity .75: the product of the lerps, as CSS animates them)`,
  );
  check(
    Math.abs(rowAt(groupRow, 7, 0) * rowAt(paintRows[0], 7, 0) - 0.5) < 1e-6 &&
      Math.abs(rowAt(groupRow, 7, 1) * rowAt(paintRows[0], 7, 1) - 0.5) < 1e-6,
    'both ends show .5, the authored poses',
  );
}
{
  // A target-only shape inside a carried group: the group is both poses'; the new shape is a member of it while it fades in.
  const G = (op, extra) =>
    doc(
      `<g opacity="${op}"><rect id="a" x="10" y="10" width="20" height="20" fill="red"/>${extra}</g>`,
    );
  const { gl } = makeFakeWebgl2(64, 64);
  const A = createBundle(gl, await importSvg(G(0.5, ''))),
    B = createBundle(
      gl,
      await importSvg(G(0.8, '<rect id="n" x="34" y="34" width="20" height="20" fill="green"/>')),
    );
  const m = createShapeMorph(gl, A, B, { cpuLerp: true });
  const list = m.bundle.drawList.map((o) => o.kind[0] + (o.shapeIdx ?? '')).join(' ');
  const kinds = m.bundle.drawList.map((o) => o.kind);
  const at = (i) =>
    kinds.slice(0, i).filter((k) => k === 'groupBegin').length -
    kinds.slice(0, i).filter((k) => k === 'groupEnd').length;
  const newIdx = kinds.findIndex(
    (k, i) => k === 'fillShape' && m.bundle.drawList[i].shapeIdx !== 1,
  );
  check(
    newIdx > 0 && at(newIdx) === 1,
    `the target-only shape is drawn inside the carried group (${list})`,
  );
  const ms = m.bundle._morphSrc,
    st = ms.metaStride;
  const gRow = m.bundle.drawList.find((o) => o.kind === 'groupBegin').shapeIdx;
  check(
    Math.abs(lerp(ms.mergedMetaF32[gRow * st + 7], ms.dstMetaF32[gRow * st + 7], 1) - 0.8) < 1e-6,
    "at t=1 the group is the target's (.8), the new shape inside it at full alpha",
  );
}
if (failures) {
  console.error(`morphLeafPropsSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nmorphLeafPropsSmoke: opacity, fill-opacity and stroke-opacity interpolate on their own',
);
