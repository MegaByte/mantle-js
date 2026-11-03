// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFilterInGroupSmoke — the unified route filters a shape INSIDE a group, into the group
//.
//
// A group renders its children into an ACCUMULATOR (shapeFbo) and groupEnd composites that over the
// canvas backdrop groupBegin copied into mainCopyTex. The unified route's isolation step,
// `_morphShapeFilter`, must not copy the bound framebuffer -- the accumulator -- over mainCopyTex,
// clear the accumulator to render its source there, and composite the result onto the CANVAS: the
// group would lose its earlier children, the filtered shape escape the group's opacity, and against
// Chrome a white canvas show a transparent hole. The isolation step has the classic loop's
// arrangement -- a source target of its own, the composite INTO the accumulator, mainCopyTex
// untouched -- so such a bundle need not decline ('filter-in-group').
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, which records which framebuffer
// every clear and draw hit and which texture every copy wrote. Per frame the checker finds
// groupEnd's composite (the last group composite onto the canvas: composite.frag over a backdrop copy
// for the multiply group, a fixed-function blit for a normal one --), reads the
// accumulator off it, walks back to the accumulator's first clear this frame (groupBegin's), and
// asserts, between the two:
//   (1) a backdrop the composite reads was last written by a copy of the CANVAS -- nothing overwrote it;
//   (2) the accumulator's color is cleared once, by groupBegin, and never again;
//   (3) nothing is drawn onto the canvas -- nothing escaped the group;
//   (4) a filtered result is composited INTO the accumulator;
//   (5) every fill draw lands in the accumulator or in an isolation target, never the canvas.
// Frames 1-2 are static (the filter cache HITS), 3-4 move the world matrix (every filter MISSES).
// The arm must also really be the unified route, with the filter and the group served on it.
//
// Pixels are the render lane's: filterCompositeBackdropSmoke compares these scenes with Chrome.
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
  `<filter id="g" ${REGION}><feMorphology operator="dilate" radius="1"/><feGaussianBlur stdDeviation="1.5"/></filter>` +
  `<filter id="bg" ${REGION}><feBlend in="SourceGraphic" in2="BackgroundImage" mode="multiply"/></filter>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${DEFS}</defs>${body}</svg>`;
const RECT = '<rect x="10" y="10" width="60" height="100" fill="#f00"/>';
const LATE = '<rect x="90" y="90" width="20" height="20" fill="#0a0"/>';
const circle = (f) => `<circle cx="80" cy="60" r="18" fill="#00f" filter="url(#${f})"/>`;
const CASES = [
  {
    name: 'single-kind blur in an opacity group',
    body: `<g opacity="0.5">${RECT}${circle('b')}</g>`,
  },
  {
    name: 'filter graph in an opacity group',
    body: `<g opacity="0.5">${RECT}${circle('g')}</g>`,
    graph: true,
  },
  {
    name: 'BackgroundImage graph in an opacity group',
    body: `<g opacity="0.5">${RECT}${circle('bg')}</g>`,
    graph: true,
  },
  {
    name: 'blur in a multiply group',
    body:
      `<rect x="0" y="0" width="120" height="120" fill="#ff0"/>` +
      `<g style="mix-blend-mode:multiply">${RECT}${circle('b')}</g>`,
  },
  // A child AFTER the filtered one: the isolation step must leave the accumulator bound, or the
  // runs after it paint the canvas instead.
  {
    name: 'blur between two plain children',
    body: `<g opacity="0.5">${RECT}${circle('b')}${LATE}</g>`,
    late: true,
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
  return { F, stats, b };
}

/// The five dataflow checks for one frame. Returns a list of failures (empty = clean).
function checkFrame(F, frame, wantLate) {
  const ev = F.log.filter((e) => e.frame === frame);
  const has = (e, key) => F.progKeys(e.prog).has(key);
  let end = -1;
  for (let k = ev.length - 1; k >= 0; k--) {
    if (ev[k].fbo === null && isGroupComposite(F, ev[k])) {
      end = k;
      break;
    }
  }
  if (end < 0) return ['no groupEnd composite onto the canvas'];
  const accTex = ev[end].units[0];
  const acc = F.fboOf(accTex);
  if (!acc) return ['groupEnd composite has no accumulator bound'];
  const begin = ev.findIndex((e) => e.op === 'clear' && e.fbo === acc && e.mask & COLOR);
  if (begin < 0 || begin > end) return ['no groupBegin clear of the accumulator this frame'];
  const bad = [];
  if (has(ev[end], 'compositeFrag')) {
    const bdTex = ev[end].units[1];
    let last = -1;
    for (let k = end - 1; k >= 0; k--)
      if (ev[k].op === 'copy' && ev[k].dst === bdTex) {
        last = k;
        break;
      }
    if (last < 0) bad.push("(1) no copy into groupEnd's backdrop this frame");
    else if (ev[last].src !== null)
      bad.push("(1) the backdrop's last write was a copy of the accumulator, not the canvas");
  }
  const mid = ev.slice(begin + 1, end);
  const colorClears = mid.filter((e) => e.op === 'clear' && e.fbo === acc && e.mask & COLOR);
  if (colorClears.length !== 0)
    bad.push(
      `(2) the accumulator's color was cleared ${colorClears.length + 1}x inside the group (want 1: groupBegin)`,
    );
  const onCanvas = mid.filter((e) => e.op === 'draw' && e.fbo === null);
  if (onCanvas.length) bad.push(`(3) ${onCanvas.length} draw(s) onto the canvas inside the group`);
  const into = mid.filter(
    (e) =>
      e.op === 'draw' &&
      e.fbo === acc &&
      has(e, 'cacheBlitFrag') &&
      e.units[0] !== accTex &&
      !isGroupComposite(F, e),
  );
  if (!into.length) bad.push('(4) no filtered result composited into the accumulator');
  const fills = mid.filter((e) => e.op === 'draw' && has(e, 'fillFrag'));
  if (!fills.some((e) => e.fbo === acc)) bad.push('(5) no fill drawn into the accumulator');
  if (fills.some((e) => e.fbo === null))
    bad.push('(5) a fill drawn onto the canvas inside the group');
  if (wantLate) {
    const lastInto = mid.lastIndexOf(into[into.length - 1]);
    if (
      !mid.slice(lastInto + 1).some((e) => e.op === 'draw' && e.fbo === acc && has(e, 'fillFrag'))
    ) {
      bad.push('(5) the child after the filtered one was not drawn into the accumulator');
    }
  }
  return bad;
}

for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  const { F, stats, b } = await run(c.body, 'lb');
  if (c.graph)
    ok(
      b.drawList.some((o) => o.filterGraphId),
      'the fixture imports as a filter GRAPH',
    );
  const first = stats[0],
    last = stats[FRAMES - 1];
  const d = (k) => (last[k] | 0) - (first[k] | 0);
  ok(
    last.unifiedFillGate === 'on' &&
      d('unifiedFillDraws') > 0 &&
      d('unifiedFilterDraws') > 0 &&
      d('unifiedGroupBrackets') > 0,
    `the unified route served it: gate ${last.unifiedFillGate}, filter draws +${d('unifiedFilterDraws')}, ` +
      `group brackets +${d('unifiedGroupBrackets')}`,
  );
  for (let i = 1; i < FRAMES; i++) {
    const bad = checkFrame(F, i, c.late);
    ok(
      !bad.length,
      `frame ${i} (${i < 3 ? 'static' : 'moving'}): the filtered child stays inside the group` +
        (bad.length ? ' -- ' + bad.join('; ') : ''),
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
