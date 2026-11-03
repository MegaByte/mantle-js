// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nestedGroupSmoke — a group inside a group composites into its PARENT, on both routes.
//
// If every group accumulated in the one shapeFbo over a snapshot of the canvas, an inner
// groupBegin would re-snapshot the canvas and CLEAR shapeFbo inside its rect -- erasing the outer
// group's earlier children there -- and its groupEnd would composite onto the CANVAS; the outer
// group's later children would then draw onto the canvas too, and the outer groupEnd's REPLACE
// would overwrite all of it. Both routes share groupBegin/groupEnd. Against Chrome, on white, for
// <g opacity=".5"> holding a red rect, an inner <g opacity=".5"> holding a blue circle, then a green
// rect, that would read: the red rect under the inner group's rect white instead of
// (255,128,128), the circle at 0.5 instead of 0.25, the green rect white instead of (128,212,128).
// (filterCompositeBackdropSmoke, render lane, asserts those against Chrome.)
//
// A nested group accumulates in a target of its own, with no snapshot at groupBegin (its
// backdrop is its parent's accumulator, which nothing writes while it is open); its groupEnd
// snapshots the parent's accumulator and composites INTO it, and leaves it bound. The outermost
// group takes the single-group path, byte for byte.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs (it records which framebuffer every
// clear and draw hit and which texture every copy wrote). Per frame the checker takes the ONE group
// composite onto the canvas -- the outermost groupEnd -- reads the outer accumulator off it, walks
// back to that accumulator's first clear this frame (the outer groupBegin's), and asserts between them:
//   (1) exactly one group composite reached the canvas all frame, and one that reads a backdrop (a
//       non-normal blend; a normal group blends fixed-function) reads a copy of
//       the canvas taken inside the group;
//   (2) the outer accumulator's color was cleared once (by its own groupBegin);
//   (3) nothing was drawn onto the canvas;
//   (4) an inner group was composited INTO the outer accumulator, from an accumulator of its own;
//   (5) the outer group's child after the inner group was drawn into the outer accumulator.
// On both routes, with the inner group's child plain, blurred (single-kind), graph-filtered, and
// under mix-blend-mode, and three deep. The unified arm must really be the unified route.
import { createFakeGl, taggedShaderSources, isGroupComposite } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');

const N = 120;
const REGION = 'x="-100%" y="-100%" width="300%" height="300%"';
const DEFS =
  `<filter id="b" ${REGION}><feGaussianBlur stdDeviation="1.5"/></filter>` +
  `<filter id="g" ${REGION}><feMorphology operator="dilate" radius="1"/><feGaussianBlur stdDeviation="1.5"/></filter>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${DEFS}</defs>${body}</svg>`;
const RED = '<rect x="10" y="10" width="60" height="100" fill="#f00"/>';
const LATE = '<rect x="88" y="88" width="24" height="24" fill="#0a0"/>';
const circle = (attr = '') => `<circle cx="80" cy="60" r="18" fill="#00f" ${attr}/>`;
const nest = (inner, innerAttr = 'opacity="0.5"') =>
  `<g opacity="0.5">${RED}<g ${innerAttr}>${inner}</g>${LATE}</g>`;
const CASES = [
  { name: 'nested opacity groups, plain children', body: nest(circle()) },
  {
    name: 'a blurred child in the inner group',
    body: nest(circle('filter="url(#b)"')),
    filtered: true,
  },
  {
    name: 'a graph-filtered child in the inner group',
    body: nest(circle('filter="url(#g)"')),
    filtered: true,
  },
  {
    name: 'a multiply group inside an opacity group',
    body: nest(circle('filter="url(#b)"'), 'style="mix-blend-mode:multiply"'),
    filtered: true,
  },
  {
    name: 'three deep',
    body: nest(`<g opacity="0.5">${circle('filter="url(#b)"')}</g>`),
    filtered: true,
  },
];
const FRAMES = 5;
const worldFor = (i) => (i >= 3 ? [1, 0, 0, 0, 1, 0, 0.01 * i, 0, 1] : null);
const COLOR = 0x4000;

async function run(body, route) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* the route check reports it */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  const stats = [];
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    const wm = worldFor(i);
    R.drawBundle(b, wm ? { worldMatrix: wm } : {});
    R.endFrame();
    stats.push(Object.assign({}, R.debugStats));
  }
  return { F, stats, groups: b.drawList.filter((o) => o.kind === 'groupBegin').length };
}

function checkFrame(F, frame) {
  const ev = F.log.filter((e) => e.frame === frame);
  const has = (e, key) => F.progKeys(e.prog).has(key);
  const isComp = (e) => isGroupComposite(F, e);
  const onCanvas = ev.filter((e) => isComp(e) && e.fbo === null);
  if (onCanvas.length !== 1)
    return [`(1) ${onCanvas.length} group composites reached the canvas (want 1: the outermost)`];
  const end = ev.indexOf(onCanvas[0]);
  const outerTex = ev[end].units[0];
  const outer = F.fboOf(outerTex);
  const begin = outer
    ? ev.findIndex((e) => e.op === 'clear' && e.fbo === outer && e.mask & COLOR)
    : -1;
  if (begin < 0 || begin > end) return ['(1) no outer accumulator / groupBegin clear found'];
  const bad = [];
  if (has(ev[end], 'compositeFrag')) {
    const bd = ev[end].units[1];
    let last = -1;
    for (let k = end - 1; k >= 0; k--)
      if (ev[k].op === 'copy' && ev[k].dst === bd) {
        last = k;
        break;
      }
    if (last < 0 || ev[last].src !== null)
      bad.push("(1) the canvas backdrop's last write was not a copy of the canvas");
  }
  const mid = ev.slice(begin + 1, end);
  const clears = mid.filter((e) => e.op === 'clear' && e.fbo === outer && e.mask & COLOR).length;
  if (clears !== 0)
    bad.push(`(2) the outer accumulator's color was cleared ${clears + 1}x (want 1)`);
  const drawn = mid.filter((e) => e.op === 'draw' && e.fbo === null).length;
  if (drawn) bad.push(`(3) ${drawn} draw(s) onto the canvas inside the outer group`);
  const innerEnds = mid.filter(
    (e) => isComp(e) && e.fbo === outer && F.fboOf(e.units[0]) && F.fboOf(e.units[0]) !== outer,
  );
  if (!innerEnds.length)
    bad.push('(4) no inner group composited into the outer accumulator from one of its own');
  else {
    const after = mid.slice(mid.indexOf(innerEnds[innerEnds.length - 1]) + 1);
    if (!after.some((e) => e.op === 'draw' && e.fbo === outer && has(e, 'fillFrag'))) {
      bad.push(
        "(5) the outer group's child after the inner group was not drawn into the outer accumulator",
      );
    }
  }
  return bad;
}

for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  for (const route of ['none', 'lb']) {
    const { F, stats, groups } = await run(c.body, route);
    const first = stats[0],
      last = stats[FRAMES - 1];
    const d = (k) => (last[k] | 0) - (first[k] | 0);
    if (route === 'lb') {
      ok(
        d('unifiedFillDraws') > 0 &&
          d('unifiedGroupBrackets') >= 2 * groups * (FRAMES - 1) &&
          (!c.filtered || d('unifiedFilterDraws') > 0),
        `route lb is the unified route: gate ${last.unifiedFillGate}, group brackets +${d('unifiedGroupBrackets')} ` +
          `(${groups} groups), filter draws +${d('unifiedFilterDraws')}`,
      );
    } else {
      ok(
        d('unifiedFillDraws') === 0,
        `route none is the classic route (unified draws +${d('unifiedFillDraws')})`,
      );
    }
    const perFrame = [];
    for (let i = 1; i < FRAMES; i++) perFrame.push(checkFrame(F, i));
    const badFrames = perFrame
      .map((b, i) => (b.length ? `frame ${i + 1}: ${b.join('; ')}` : null))
      .filter(Boolean);
    ok(
      !badFrames.length,
      `route ${route}: every frame composites the inner group into the outer one` +
        (badFrames.length ? ' -- ' + badFrames.join(' | ') : ''),
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
