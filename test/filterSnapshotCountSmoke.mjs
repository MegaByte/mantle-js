// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterSnapshotCountSmoke — a filtered shape takes NO backdrop snapshot unless something reads it.
//
// Every filter composite (graph, single-kind, COLR glyph, hit or miss, both routes) hands the
// fixed-function src-over blend the filtered texture alone, so the composite reads the destination
// itself and no backdrop texture. A call site that still took a snapshot would pay, per filtered
// shape per frame, a framebuffer copy (full canvas in a group, on the no-rect path and on every
// unified-route call; rect-sized plus a clear otherwise), and on a tile GPU a copy from the bound
// framebuffer forces a tile resolve -- for a texture nothing reads.
//
// A snapshot is owed where something samples it, and those are pinned here:
//   - a filter graph reading BackgroundImage / BackgroundAlpha (a graph INPUT);
//   - a mix-blend-mode leaf (composite.frag blends against it);
//   - a group (groupEnd composites the accumulator over groupBegin's canvas copy).
// (The in-group single-kind MISS filters in a target of its own, so it costs none -- filtering
// the group accumulator in place would cost two more, a stash of the accumulator and a move of the
// result aside: pinned below.)
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, which records every
// copyTexSubImage2D and blitFramebuffer. Each case is drawn beside a TWIN with the filter (or blend,
// or COLR graph) removed, over the same frame schedule, so the copies a group or anything else
// costs cancel and the difference is what the filter itself costs. Frames 1-2 are static (a
// cacheable filter HITS), frames 3-4 move the world matrix (every filter MISSES); frame 0 is the
// variant warm-up and is not counted. The unified arm asserts it actually took the unified route,
// or it would be measuring the classic route twice.
//
// Pixels are the render lane's (filterCompositeBackdropSmoke compares with Chrome); this pins the
// copy count, which no pixel test can see.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

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
  // A chain the single-kind heuristic cannot fold (a blur and a color matrix, or two blurs, it
  // does), so the importer emits a GRAPH. Neither primitive copies or blits.
  `<filter id="g" ${REGION}><feMorphology operator="dilate" radius="1"/><feGaussianBlur stdDeviation="1.5"/></filter>` +
  // Reads the backdrop: the one filter that still needs a snapshot.
  `<filter id="bg" ${REGION}><feBlend in="SourceGraphic" in2="BackgroundImage" mode="multiply"/></filter>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${DEFS}</defs>${body}</svg>`;
const RECT = '<rect x="10" y="10" width="60" height="100" fill="#f00"/>';
const circle = (attr = '') => `<circle cx="80" cy="60" r="18" fill="#00f" ${attr}/>`;
const group = (inner) => `<g opacity="0.5">${inner}</g>`;
const plain = RECT + circle();

// A synthetic COLRv1 glyph: the circle's op is handed a one-node paint graph. The COLR leaf is the
// same code for a real color font; what matters here is its snapshot, not its paint.
const COLR = {
  nodes: [{ type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } }],
  rootOut: 0,
};
const makeColr = (b) => {
  b.colrGraphs = [COLR];
  const ops = b.drawList.filter((o) => o.kind === 'fillShape');
  ops[ops.length - 1].colrGraphId = 1;
};

const BOTH = ['none', 'lb'];
// `hit` / `miss`: the copies the feature itself may cost per frame, over its twin's.
// `served`: the debugStats counter that proves the unified arm served the feature itself.
const CASES = [
  {
    name: 'single-kind blur',
    body: RECT + circle('filter="url(#b)"'),
    twin: plain,
    routes: BOTH,
    hit: 0,
    miss: 0,
    served: 'unifiedFilterDraws',
  },
  {
    name: 'filter graph',
    body: RECT + circle('filter="url(#g)"'),
    twin: plain,
    routes: BOTH,
    hit: 0,
    miss: 0,
    served: 'unifiedFilterDraws',
  },
  {
    name: 'COLR glyph',
    body: plain,
    twin: plain,
    colr: true,
    routes: BOTH,
    hit: 0,
    miss: 0,
    served: 'unifiedColrLeaves',
  },
  {
    name: 'graph reading BackgroundImage (read: UNCHANGED)',
    body: RECT + circle('filter="url(#bg)"'),
    twin: plain,
    routes: BOTH,
    hit: 1,
    miss: 1,
    served: 'unifiedFilterDraws',
    evalEveryFrame: true,
  },
  {
    name: 'mix-blend-mode leaf (read: UNCHANGED)',
    body: RECT + circle('style="mix-blend-mode:multiply"'),
    twin: plain,
    routes: BOTH,
    hit: 1,
    miss: 1,
    served: 'unifiedBlendLeaves',
  },
  // In a group the classic route is pinned: the unified route's in-group isolation is its own
  // item with its own smoke, and a copy count here must not depend on which route took it.
  {
    name: 'single-kind blur in a group',
    body: group(RECT + circle('filter="url(#b)"')),
    twin: group(plain),
    routes: ['none'],
    hit: 0,
    miss: 0,
  },
  {
    name: 'filter graph in a group',
    body: group(RECT + circle('filter="url(#g)"')),
    twin: group(plain),
    routes: ['none'],
    hit: 0,
    miss: 0,
  },
  {
    name: 'COLR glyph in a group',
    body: group(plain),
    twin: group(plain),
    colr: true,
    routes: BOTH,
    hit: 0,
    miss: 0,
    served: 'unifiedColrLeaves',
  },
  {
    name: 'BackgroundImage graph in a group (read: UNCHANGED)',
    body: group(RECT + circle('filter="url(#bg)"')),
    twin: group(plain),
    routes: ['none'],
    hit: 1,
    miss: 1,
  },
  {
    name: 'mix-blend-mode leaf in a group (read: UNCHANGED)',
    body: group(RECT + circle('style="mix-blend-mode:multiply"')),
    twin: group(plain),
    routes: BOTH,
    hit: 1,
    miss: 1,
    served: 'unifiedBlendLeaves',
  },
];
const FRAMES = 5;
// Frames 3+ translate the bundle a little, so every filter's cache key misses.
const worldFor = (i) => (i >= 3 ? [1, 0, 0, 0, 1, 0, 0.01 * i, 0, 1] : null);

async function run(body, route, colr, expectGraph) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (colr) makeColr(b);
  if (expectGraph && !b.drawList.some((o) => o.filterGraphId)) {
    ok(
      false,
      'the graph fixture imported as a single-kind filter, so the graph path is not covered',
    );
  }
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* reported by the route check */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  const copies = [],
    stats = [];
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    const wm = worldFor(i);
    R.drawBundle(b, wm ? { worldMatrix: wm } : {});
    R.endFrame();
    copies.push(F.log.filter((e) => e.frame === i && (e.op === 'copy' || e.op === 'blit')).length);
    stats.push(Object.assign({}, R.debugStats));
  }
  return { copies, stats };
}

for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  for (const route of c.routes) {
    const got = await run(c.body, route, c.colr, /url\(#(g|bg)\)/.test(c.body));
    const twin = await run(c.twin, route, false);
    const cost = got.copies.map((n, i) => n - twin.copies[i]);
    const hitCost = cost.slice(1, 3),
      missCost = cost.slice(3);
    ok(
      hitCost.every((n) => n === c.hit) && missCost.every((n) => n === c.miss),
      `route ${route}: copies over its twin, static frames [${hitCost}] (want ${c.hit}), ` +
        `moving frames [${missCost}] (want ${c.miss})`,
    );
    if (c.evalEveryFrame) {
      // The snapshot is only worth taking if it is USED: a graph that reads the backdrop must be
      // evaluated against it every frame, never served from the result cache, whose key has no term
      // for what lies underneath. The classic loop refuses to cache it, and so must the unified route,
      // or it composites frame 1's result for every frame after.
      const evals = got.stats
        .slice(1)
        .map((st, i) => st.filterEvalCount - got.stats[i].filterEvalCount);
      ok(
        evals.every((n) => n === 1),
        `route ${route}: the BackgroundImage graph is evaluated every frame, not cached (evals per frame [${evals}])`,
      );
    }
    if (route === 'lb') {
      const first = got.stats[1],
        last = got.stats[FRAMES - 1];
      const n = (last[c.served] | 0) - (first[c.served] | 0);
      ok(
        (last.unifiedFillDraws | 0) > (first.unifiedFillDraws | 0) && n > 0,
        `route lb really is the unified route (${c.served} +${n}, gate ${last.unifiedFillGate})`,
      );
    }
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
