// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedSpanBailGroupSmoke — a unified-route bail inside a group closes the group before the
// fallback runs.
//
// The unified route draws a bundle as runs of one vertex stream and interrupts for group brackets,
// blend leaves, COLR glyphs and filters. A run can BAIL: the bound program is not the variant the
// stream was built for (the curve-texture uniform is missing while it links, or on a mismatch), so
// it draws nothing and the route returns false for the classic route to paint the bundle instead.
// A bail after a groupBegin that breaks out of the walk past the groupEnd still to come, leaving
// `_groupStack` as it stood, would open the classic fallback's own groupBegin INSIDE the stale
// group -- a nested accumulator composited into the dead one, so the bundle never reaches the
// canvas -- and a later bundle's shapes, blend leaves and filters would take the stale accumulator
// as their target, the stack growing by one per frame. A bail INSIDE a blend leaf's (or a
// filter's) source render must count as a bail too: otherwise a group holding only that leaf
// reports success with nothing painted, and no fallback runs.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs with every program reporting no
// `uCurveCoefTex` -- so every unified run bails 'no-curvetex-uniform', before anything is painted.
// Per frame, bundle A (a group) then bundle B (a plain shape and a blend leaf, no group):
//   (1) the unified route really opened A's group and bailed (debugStats counters);
//   (2) exactly one group composite reached the canvas -- A's, from the classic fallback;
//   (3) B's fill and B's blend composite landed on the canvas;
//   (4) for a group whose only child is a blend leaf: that leaf's source was drawn somewhere.
// A control arm with the uniform present must take the unified route without bailing.
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
const DEFS = `<filter id="b" ${REGION}><feGaussianBlur stdDeviation="1.5"/></filter>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${DEFS}</defs>${body}</svg>`;
// Paths, not rects or circles: a recognized primitive draws without the curve texture, and every
// run here has to be one that bails.
const RED = '<path d="M10 10 L60 10 L60 100 L10 100 Z" fill="#f00"/>';
const blob = (attr = '') =>
  `<path d="M80 40 C100 40 104 62 92 76 C80 90 58 86 60 64 C62 48 68 40 80 40 Z" fill="#00f" ${attr}/>`;
const B_BODY =
  '<path d="M90 90 L115 90 L115 115 L90 115 Z" fill="#0a0"/>' +
  '<path d="M20 100 C30 95 40 105 50 100 L50 115 L20 115 Z" fill="#c0c" style="mix-blend-mode:multiply"/>';
const CASES = [
  { name: 'an opacity group', a: `<g opacity="0.5">${RED}${blob()}</g>`, groups: 1 },
  {
    name: 'nested groups',
    a: `<g opacity="0.5">${RED}<g opacity="0.5">${blob()}</g></g>`,
    groups: 2,
  },
  {
    name: 'a filtered child in a group',
    a: `<g opacity="0.5">${RED}${blob('filter="url(#b)"')}</g>`,
    groups: 1,
  },
  {
    name: 'a group holding only a blend leaf',
    a: `<g opacity="0.5">${blob('style="mix-blend-mode:multiply"')}</g>`,
    groups: 1,
    leafOnly: true,
  },
];
const FRAMES = 4;
const isKey = (F, e, k) => F.progKeys(e.prog).has(k);

async function run(aBody, bail) {
  const F = createFakeGl({ width: N, height: N, hideUniforms: bail ? ['uCurveCoefTex'] : [] });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route: 'lb', kernel: 'slug' });
  const mk = async (body) => {
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
    return b;
  };
  const A = await mk(aBody),
    B = await mk(B_BODY);
  R.precompileFills();
  R.setViewport(N, N);
  const stats = [],
    marks = [];
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    const s0 = Object.assign({}, R.debugStats);
    R.drawBundle(A);
    const s1 = Object.assign({}, R.debugStats);
    marks.push(F.log.length); // where B's events start
    R.drawBundle(B);
    R.endFrame();
    stats.push({ s0, s1 });
  }
  return { F, stats, marks };
}

for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  for (const bail of [false, true]) {
    const { F, stats, marks } = await run(c.a, bail);
    const tag = bail ? 'every run bails' : 'control (no bail)';
    const bad = [];
    for (let i = 1; i < FRAMES; i++) {
      const { s0, s1 } = stats[i];
      const d = (k) => (s1[k] | 0) - (s0[k] | 0);
      const ev = F.log.filter((e) => e.frame === i);
      const iB = ev.indexOf(F.log[marks[i]]);
      const evA = iB < 0 ? ev : ev.slice(0, iB),
        evB = iB < 0 ? [] : ev.slice(iB);
      if (bail) {
        if (!(d('unifiedCurveTexBail') > 0 && d('unifiedGroupBrackets') > 0)) {
          bad.push(
            `frame ${i}: (1) the unified route did not open the group and bail (brackets +${d('unifiedGroupBrackets')}, ` +
              `curve-tex bails +${d('unifiedCurveTexBail')}, gate ${s1.unifiedFillGate})`,
          );
        }
      } else if (!(d('unifiedFillDraws') > 0 && d('unifiedCurveTexBail') === 0)) {
        bad.push(
          `frame ${i}: the control did not take the unified route (draws +${d('unifiedFillDraws')}, gate ${s1.unifiedFillGate})`,
        );
      }
      const compOnCanvas = evA.filter((e) => e.fbo === null && isGroupComposite(F, e)).length;
      if (compOnCanvas !== 1)
        bad.push(`frame ${i}: (2) ${compOnCanvas} group composites reached the canvas (want 1)`);
      const bFill = evB.filter((e) => e.op === 'draw' && isKey(F, e, 'fillFrag'));
      const bComp = evB.filter((e) => e.op === 'draw' && isKey(F, e, 'compositeFrag'));
      if (!bFill.some((e) => e.fbo === null))
        bad.push(`frame ${i}: (3) none of B's fills reached the canvas`);
      if (!bComp.length || bComp.some((e) => e.fbo !== null)) {
        bad.push(
          `frame ${i}: (3) B's blend composite landed off the canvas (${bComp.filter((e) => e.fbo !== null).length} of ${bComp.length})`,
        );
      }
      if (c.leafOnly) {
        // The leaf renders its source into an isolation target: neither the canvas nor the group's
        // accumulator (the texture the group composite reads).
        const end = evA.filter((e) => e.fbo === null && isGroupComposite(F, e)).pop();
        const acc = end ? F.fboOf(end.units[0]) : undefined;
        const leafSrc = evA.filter(
          (e) => e.op === 'draw' && isKey(F, e, 'fillFrag') && e.fbo !== null && e.fbo !== acc,
        );
        if (!leafSrc.length) bad.push(`frame ${i}: (4) the blend leaf's source was never drawn`);
      }
    }
    ok(
      !bad.length,
      `${tag}: bundle A's group reaches the canvas and bundle B draws on the canvas` +
        (bad.length ? ' -- ' + bad.slice(0, 4).join(' | ') : ''),
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
