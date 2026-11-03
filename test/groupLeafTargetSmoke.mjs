// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupLeafTargetSmoke — inside a group, an isolated leaf renders its source into a target WITH
// depth and stencil, on both routes.
//
// A leaf that must be isolated -- a mix-blend-mode shape, a COLRv1 glyph, a filter graph's
// SourceGraphic -- renders alone into a target of its own before it is composited. Out of a group
// that target is shapeFbo, which carries a DEPTH24_STENCIL8 renderbuffer; the fill pass it runs is
// the ordinary one, and on the unified route that includes the depth claim (a translucent shape's
// pieces share chords the rasterizer hands to both; the claim lets the first one own the pixel).
// In a group shapeFbo is the accumulator, so the classic graph branch, the COLR leaf and the blend
// leaf (the last two shared by both routes) render into the shape-RT cache's canvas-sized entry,
// with depth and stencil, as the unified route's in-group filter does. pingFbo has neither depth nor
// stencil: on it the claim goes inert and a translucent leaf double-paints its seams in a group and
// not out of one.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, which records renderbuffer
// attachments. Per frame the checker takes the group (groupBegin's clear of its accumulator to
// groupEnd's composite, as unifiedFilterInGroupSmoke does) and asserts every fill draw inside it -- into an
// accumulator or into an isolated source target -- lands in a framebuffer with a depth+stencil
// attachment, and that an isolated source render happened. Frames 1-2 static, 3-4 moving (filters miss).
// Pixels are the render lane's: test/groupLeafDepthSmoke.mjs compares a translucent blended leaf in
// a group with the same leaf out of one, and with Chrome.
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
const blob = (attr = '') =>
  `<path d="M80 40 C100 40 104 62 92 76 C80 90 58 86 60 64 C62 48 68 40 80 40 Z" fill="#00f" fill-opacity="0.5" ${attr}/>`;
// A synthetic COLRv1 glyph: the blob's op is handed a one-node paint graph (as filterSnapshotCountSmoke does).
const COLR = {
  nodes: [{ type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } }],
  rootOut: 0,
};
const makeColr = (b) => {
  b.colrGraphs = [COLR];
  const ops = b.drawList.filter((o) => o.kind === 'fillShape');
  ops[ops.length - 1].colrGraphId = 1;
};
const CASES = [
  {
    name: 'a blend leaf in a group',
    body: `<g opacity="0.5">${RED}${blob('style="mix-blend-mode:multiply"')}</g>`,
  },
  { name: 'a COLR glyph in a group', body: `<g opacity="0.5">${RED}${blob()}</g>`, colr: true },
  {
    name: 'a graph-filtered child in a group',
    body: `<g opacity="0.5">${RED}${blob('filter="url(#g)"')}</g>`,
    filtered: true,
  },
  {
    name: 'a blurred child in a group (control)',
    body: `<g opacity="0.5">${RED}${blob('filter="url(#b)"')}</g>`,
    filtered: true,
  },
  {
    name: 'a blend leaf in a nested group',
    body: `<g opacity="0.5">${RED}<g opacity="0.5">${blob('style="mix-blend-mode:multiply"')}</g></g>`,
  },
];
const FRAMES = 5;
const worldFor = (i) => (i >= 3 ? [1, 0, 0, 0, 1, 0, 0.01 * i, 0, 1] : null);

async function run(c, route) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(c.body), { preserveViewport: true }));
  if (c.colr) makeColr(b);
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
  return { F, stats };
}

/// The fill draws inside the outermost group this frame, and which of them are ISOLATED source
/// renders (into a target that is not an accumulator). null when no group was found.
function groupFills(F, frame) {
  const ev = F.log.filter((e) => e.frame === frame);
  const has = (e, k) => F.progKeys(e.prog).has(k);
  let end = -1;
  for (let k = ev.length - 1; k >= 0; k--) {
    if (ev[k].fbo === null && isGroupComposite(F, ev[k])) {
      end = k;
      break;
    }
  }
  if (end < 0) return null;
  const outer = F.fboOf(ev[end].units[0]);
  const begin = outer ? ev.findIndex((e) => e.op === 'clear' && e.fbo === outer) : -1;
  if (begin < 0 || begin > end) return null;
  const mid = ev.slice(begin + 1, end);
  // An accumulator is what a group or blend composite writes INTO (and the outermost one, which
  // groupEnd reads); an isolated target is only ever composited FROM.
  const accs = new Set(
    mid
      .filter(
        (e) => e.fbo && (isGroupComposite(F, e) || (e.op === 'draw' && has(e, 'compositeFrag'))),
      )
      .map((e) => e.fbo),
  );
  accs.add(F.fboOf(ev[end].units[0]));
  const fills = mid.filter((e) => e.op === 'draw' && has(e, 'fillFrag') && e.fbo !== null);
  return { fills, isolated: fills.filter((e) => !accs.has(e.fbo)) };
}

for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  for (const route of ['none', 'lb']) {
    const { F, stats } = await run(c, route);
    const first = stats[0],
      last = stats[FRAMES - 1];
    const d = (k) => (last[k] | 0) - (first[k] | 0);
    if (route === 'lb') {
      const served = c.colr
        ? d('unifiedColrLeaves')
        : c.filtered
          ? d('unifiedFilterDraws')
          : d('unifiedBlendLeaves');
      ok(
        d('unifiedFillDraws') > 0 && d('unifiedGroupBrackets') > 0 && served > 0,
        `route lb is the unified route, and it served the group and the leaf (gate ${last.unifiedFillGate}, ` +
          `brackets +${d('unifiedGroupBrackets')}, leaf +${served})`,
      );
    } else {
      ok(
        d('unifiedFillDraws') === 0,
        `route none is the classic route (unified draws +${d('unifiedFillDraws')})`,
      );
    }
    const bad = [];
    let seen = 0;
    for (let i = 1; i < FRAMES; i++) {
      const g = groupFills(F, i);
      if (!g) {
        bad.push(`frame ${i}: no group found`);
        continue;
      }
      seen += g.isolated.length;
      const noDs = g.fills.filter((e) => !F.hasDepthStencil(e.fbo)).length;
      if (noDs)
        bad.push(
          `frame ${i}: ${noDs} of ${g.fills.length} in-group fill draw(s) into a target with no depth/stencil`,
        );
    }
    if (!seen) bad.push('no isolated source render inside the group in any frame');
    ok(
      !bad.length,
      `route ${route}: every in-group isolated source render has depth and stencil` +
        (bad.length ? ' -- ' + bad.join(' | ') : ` (${seen} renders)`),
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
