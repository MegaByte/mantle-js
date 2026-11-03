// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// psoWarmScissorSmoke — a pipeline warm never paints the canvas outside its one-pixel scissor
//.
//
// `_warmBundlePso` builds a bundle's pipeline by DRAWING it -- the whole unified walk, groups,
// filters and blend leaves included -- under `gl.scissor(0, 0, 1, 1)`, so nothing shows. That
// pixel must be something the walk knows about, not only a gl.scissor call: a filter composite
// with a <filter> region, a group with a content rect or a blend leaf with a rect that restores
// SCISSOR_TEST to "off" on its way out would leave every canvas draw after it -- the group
// composite, the filtered result, the blend composite -- unscissored. A warm runs from
// fillWarmTick right after beginFrame's clear (where a bundle not on screen yet would paint its
// group under the frame) or from drawBundle's warmTick in the middle of a frame (over what is
// already drawn). With a caller's scissor set (setScissorRect), bindFb's re-scissor of every
// canvas bind must restore the warm's pixel, not the CALLER's rect, or the warm paints inside
// that rect from its first composite on.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, which records the scissor every
// clear, draw and blit ran under. Each case is warmed twice -- by precompileFills, and by
// fillWarmTick at beginFrame -- with and without a caller's scissor that excludes the warm's
// pixel, on the unified route (the one that walks groups, filters and leaves). Asserted:
//   (1) the warm really walked the unified route's groups / filters / leaves (else the check is vacuous);
//   (2) every canvas clear, draw and blit during the warm ran scissored inside the warm's pixel
//       intersected with the caller's rect (so with a disjoint caller rect: an empty scissor);
//   (3) after the warm the scissor is restored: off, or the caller's rect.
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
  `<filter id="g" ${REGION}><feMorphology operator="dilate" radius="1"/><feGaussianBlur stdDeviation="1.5"/></filter>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${DEFS}</defs>${body}</svg>`;
// Placed away from the warm's pixel (0,0) on purpose: a draw there proves nothing.
const RECT = '<rect x="30" y="30" width="40" height="60" fill="#f00"/>';
const LATE = '<rect x="90" y="90" width="20" height="20" fill="#0a0"/>';
const circle = (attr) => `<circle cx="80" cy="60" r="18" fill="#00f" ${attr}/>`;
const CASES = [
  {
    name: 'a blurred child in an opacity group',
    body: `<g opacity="0.5">${RECT}${circle('filter="url(#b)"')}${LATE}</g>`,
    walked: ['unifiedGroupBrackets', 'unifiedFilterDraws'],
  },
  {
    name: 'a graph-filtered shape',
    body: RECT + circle('filter="url(#g)"') + LATE,
    walked: ['unifiedFilterDraws'],
  },
  {
    name: 'a blend leaf',
    body: RECT + circle('style="mix-blend-mode:multiply"') + LATE,
    walked: ['unifiedBlendLeaves'],
  },
  {
    name: 'a blend leaf in a group, then a blurred child',
    body:
      `<g opacity="0.5">${RECT}${circle('style="mix-blend-mode:multiply"')}` +
      `<circle cx="40" cy="90" r="10" fill="#0a0" filter="url(#b)"/></g>`,
    walked: ['unifiedGroupBrackets', 'unifiedBlendLeaves', 'unifiedFilterDraws'],
  },
  {
    name: 'nested groups with a filtered child',
    body: `<g opacity="0.5">${RECT}<g opacity="0.5">${circle('filter="url(#b)"')}</g>${LATE}</g>`,
    walked: ['unifiedGroupBrackets', 'unifiedFilterDraws'],
  },
];
const WARM = [0, 0, 1, 1];
const USER = [40, 40, 60, 60]; // excludes the warm's pixel: the two intersect in nothing

const inter = (a, b) => {
  const x0 = Math.max(a[0], b[0]),
    y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]),
    y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
};
/// Is the scissor `s` (null = off) inside `allowed`? A zero-area scissor paints nothing.
const inside = (s, allowed) => {
  if (!s) return false;
  if (s[2] <= 0 || s[3] <= 0) return true;
  return (
    s[0] >= allowed[0] &&
    s[1] >= allowed[1] &&
    s[0] + s[2] <= allowed[0] + allowed[2] &&
    s[1] + s[3] <= allowed[1] + allowed[3]
  );
};

/// The LB meshes have LANDED (awaitLbReady's own test), waited for by hand: awaitLbReady
/// finishes by running precompileFills, which is itself a warm, and this smoke must drive the
/// warm it records.
async function meshesLanded(b, ms = 20000) {
  const landed = () => {
    const g = b._geomGen | 0;
    return (
      Array.isArray(b._lbMeshes) &&
      b._lbMeshes.some((m) => m && !m.slug && (m.vertexCount | 0) > 0) &&
      b._lbWorkerPendingGen !== g &&
      b._lbPartialGen !== g
    );
  };
  const t0 = Date.now();
  while (!landed() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 8));
  return landed();
}

async function warm(body, how, user) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(
    F.gl,
    taggedShaderSources(),
    how === 'tick' ? { psoWarmIdle: () => true } : {},
  );
  R.setFillEngine({ route: 'lb', kernel: 'slug' });
  R.setViewport(N, N);
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  await meshesLanded(b);
  R.prewarmBundle(b);
  const before = Object.assign({}, R.debugStats);
  const walked = () => c0.walked.every((k) => (R.debugStats[k] | 0) - (before[k] | 0) > 0);
  let scissorAfter = null;
  // Everything recorded while the warm runs is tagged 'warm'; nothing else draws meanwhile.
  F.setFrame('warm');
  if (how === 'precompile') {
    if (user) R.setScissorRect(USER[0], USER[1], USER[2], USER[3]);
    R.precompileFills();
    scissorAfter = F.scissorNow();
  } else {
    // fillWarmTick at beginFrame: it drains the prewarm queue, promotes the links, then warms, a frame at a time --
    // at a beginFrame that CLEARS, before its clear (beginFrame(null) keeps the canvas and so draws no warm). The frame's own color clear comes after the warm and is not the warm's (see `frameClear`).
    for (let i = 0; i < 60 && !walked(); i++) {
      if (user) R.setScissorRect(USER[0], USER[1], USER[2], USER[3]); // endFrame clears it
      R.beginFrame([0, 0, 0, 0]);
      scissorAfter = F.scissorNow();
      R.endFrame();
    }
  }
  F.setFrame(-1);
  return { F, walked: walked(), after: R.debugStats, before, scissorAfter };
}

let c0 = null;
for (const c of CASES) {
  c0 = c;
  console.log(`\n  ${c.name}:`);
  for (const how of ['precompile', 'tick']) {
    for (const user of [false, true]) {
      const tag = `${how === 'precompile' ? 'precompileFills' : 'fillWarmTick'}, ${user ? 'caller scissor set' : 'no caller scissor'}`;
      const { F, before, after, scissorAfter, walked } = await warm(c.body, how, user);
      const d = (k) => (after[k] | 0) - (before[k] | 0);
      ok(
        walked,
        `${tag}: the warm walked the unified route (${c.walked.map((k) => `${k} +${d(k)}`).join(', ')})`,
      );
      const allowed = user ? inter(WARM, USER) : WARM;
      // the frame's own color clear of the canvas, which follows the warm (the tick runs before it)
      const frameClear = (e) =>
        how === 'tick' && e.op === 'clear' && e.fbo === null && e.mask & F.gl.COLOR_BUFFER_BIT;
      const ev = F.log.filter(
        (e) =>
          e.frame === 'warm' &&
          (e.op === 'draw' || e.op === 'clear' || e.op === 'blit') &&
          !frameClear(e),
      );
      const onCanvas = ev.filter((e) => (e.op === 'blit' ? e.dst : e.fbo) === null);
      const stray = onCanvas.filter((e) => !inside(e.sc, allowed));
      const show = stray
        .slice(0, 3)
        .map((e) => `${e.op} under ${e.sc ? `[${e.sc}]` : 'no scissor'}`)
        .join('; ');
      ok(
        onCanvas.length > 0 && !stray.length,
        `${tag}: ${stray.length} of ${onCanvas.length} canvas clears/draws/blits ran outside [${allowed}]` +
          (stray.length ? ` -- ${show}` : ''),
      );
      const want = user ? USER : null;
      const same = want
        ? scissorAfter && scissorAfter.join() === want.join()
        : scissorAfter === null;
      ok(
        same,
        `${tag}: after the warm the scissor is ${scissorAfter ? `[${scissorAfter}]` : 'off'} (want ${want ? `[${want}]` : 'off'})`,
      );
    }
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
