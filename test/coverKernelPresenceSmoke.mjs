// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverKernelPresenceSmoke — under kernel 'auto', a unified draw compiles a COVER kernel only where a
// cover quad needs it.
//
// The program's cover kernel (Slug, AAC, the per-row hard kernel) shades a FILL row's COVER QUAD and
// nothing else: a mesh entry carries its own coverage and a stroke row runs the stroke path. Picking
// AAC for the unified draw from the bundle's size facts whether or not any row draws a cover quad
// costs on the GPU: tiger >= 512 px and lbMemBudget >= 1024 px with MANTLE_AAC bound into frames
// whose tally is lb/sdf/stroke only -- no cover quad anywhere -- are 1.20-1.26x SLOWER for it. So
// fillPass asks unifiedFillDraw which cover kernels the draw can reach (R._unifiedCoverRows) before
// it adds one.
//
// HOW: the real renderer on test/_fakeGl.mjs (no GPU), each arm warmed until a variant is BOUND
// (prewarmBundle + precompileFills), then the bound key read back.
//   (a) every fill row an LB mesh, kernel 'auto', at a size where the policy picks AAC: the bound
//       program carries NO MANTLE_AAC (a size-facts pick would bind it: this is the arm that fails);
//   (b) the same bundle with every row a cover quad (unifiedFill 'force', no meshes): MANTLE_AAC IS bound, so
//       (a) is the gate and not a policy that stopped choosing AAC;
//   (c) a PINNED 'aac' kernel keeps MANTLE_AAC on the all-mesh draw -- the caller asked for it;
//   (d) a per-row mixed bundle, every fill row a mesh: neither MANTLE_COVER_KERNEL nor MANTLE_AAC,
//       and with every row a cover quad the per-row hard kernel comes back (AAC is then the presence
//       model's call, aacPresenceSmoke);
//   (f) a stroke-covered bundle the route DECLINES (no row picks its mesh under 'auto'; the pinned 'lb' veto) is a
//       classic draw, and binds the no-AA kernel it chose, not a key the cover-row count built for a unified draw;
//   (e) the engine ledger is told whether a fill row rode as a cover quad, rather than guessing it
//       from the meshes (which cannot see a row the per-shape policy passed over).
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
const warn = console.warn;
console.warn = () => {};

const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy}` +
  ` C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
// Large cubic fills: at 1024 px each covers ~1e5 device px^2, far past AAC's cubic floor (3e3).
const BIG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${[
  [28, 28],
  [72, 28],
  [28, 72],
  [72, 72],
]
  .map(([x, y], i) => `<path d="${blob(x, y, 18)}" fill="hsl(${i * 80},60%,45%)"/>`)
  .join('')}</svg>`;
// Per-row mixed: fills whose edge a later opaque stroke hides (hard rows) beside fills with none.
const MIXED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${[
  [25, 25],
  [75, 25],
]
  .map(([x, y]) => `<path d="${blob(x, y, 16)}" fill="#c0392b" stroke="#1a1a1a" stroke-width="7"/>`)
  .join('')}${[
  [25, 75],
  [75, 75],
]
  .map(([x, y]) => `<path d="${blob(x, y, 16)}" fill="#2980b9"/>`)
  .join('')}</svg>`;

async function bound(svg, { size = 1024, route = 'lb', kernel = 'auto', force = false } = {}) {
  const F = createFakeGl({ width: size, height: size });
  const R = createRenderer(F.gl, taggedShaderSources(), force ? { unifiedFill: 'force' } : {});
  // 'force' with the route OFF builds no mesh, so every row rides the unified stream as a cover quad.
  R.setFillEngine({ route: force ? 'none' : route, kernel });
  const sec = await importSvg(svg);
  const b = createBundle(F.gl, sec);
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* the key check reports it */
    }
  }
  R.setViewport(size, size);
  R.prewarmBundle(b);
  let key = '';
  for (let i = 0; i < 16; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    R.precompileFills();
    key = R.debugStats.drawnFillVariantKey || '';
    if (i >= 2 && key) break;
  }
  const out = {
    key,
    defs: new Set(key.split('|')),
    gate: R.debugStats.unifiedFillGate,
    kernel: R.debugStats.coverKernel,
    sec,
  };
  try {
    R.dispose();
  } catch {
    /* headless */
  }
  return out;
}
const has = (r, d) => r.defs.has(d);
const show = (r) =>
  [...r.defs]
    .filter((d) =>
      /^MANTLE_(AAC|AAC_PAIR_BANDS|HARD|HARD_MIXED|HARD_TREE|GWN|COVER_KERNEL|LB_FILL)$/.test(d),
    )
    .join('+') || 'none';

{
  const a = await bound(BIG);
  ok(
    a.gate === 'on' && has(a, 'MANTLE_LB_FILL'),
    `(a) the all-mesh bundle draws on the unified route (gate ${a.gate}, ${show(a)})`,
  );
  // MANTLE_AAC_PAIR_BANDS is not a kernel: renderFill uses AAC's walk, so it is the band layout of every program that draws a pair-band
  // bundle (renderFill walks the pixel box's list too), and in a program with no cover fill it changes no code
  ok(
    !has(a, 'MANTLE_AAC'),
    `(a) no fill row draws a cover quad, so 'auto' binds NO AAC kernel (bound: ${show(a)})`,
  );
  const b = await bound(BIG, { force: true });
  ok(
    b.gate === 'on' && has(b, 'MANTLE_AAC'),
    `(b) with every row a cover quad, 'auto' still picks AAC here (bound: ${show(b)})`,
  );
  const c = await bound(BIG, { kernel: 'aac' });
  ok(
    has(c, 'MANTLE_AAC'),
    `(c) a PINNED 'aac' kernel keeps its define on the all-mesh draw (bound: ${show(c)})`,
  );
}
{
  const d = await bound(MIXED);
  ok(
    d.sec.noAaMixed === true && !d.sec.noAaFill,
    `(d) the asset is per-row mixed (noAaMixed ${d.sec.noAaMixed}, noAaFill ${!!d.sec.noAaFill})`,
  );
  ok(
    d.gate === 'on' &&
      !has(d, 'MANTLE_COVER_KERNEL') &&
      !has(d, 'MANTLE_HARD_MIXED') &&
      !has(d, 'MANTLE_AAC'),
    `(d) every fill row a mesh: no per-row hard kernel and no AAC (bound: ${show(d)})`,
  );
  const e = await bound(MIXED, { force: true });
  // AAC does NOT come back here, and that is the presence model (coverKernelPolicy.aacPresenceTerms), not the cover gate: its
  // two AA cover rows are ~2e5 px^2 against ~5e5 of hard rows and stroke quads that would carry its presence.
  ok(
    e.gate === 'on' && has(e, 'MANTLE_COVER_KERNEL') && !has(e, 'MANTLE_AAC'),
    `(d) every row a cover quad: the per-row hard kernel comes back, AAC stays priced out (bound: ${show(e)})`,
  );
}

// (f) A DECLINED BUNDLE IS NOT A UNIFIED DRAW. A built mesh set makes a bundle eligible for the unified route, but the
// route decides: 'auto' declines one whose per-shape policy gave no row its mesh -- a bundle whose every fill an opaque
// stroke covers floors each row out onto the no-AA kernel (lbShapePolicy) -- and a pinned 'lb' vetoes a covered
// bundle with no primitive. It then draws the classic pass, every fill row a cover quad. Counting the declined meshes
// as served would make the cover gate drop the no-AA kernel the selector chose (Slug draws) and MANTLE_NO_COVER_FILL
// hand the classic pass the base program: the covered bundle would choose band-hard and never draw it.
{
  const COVERED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${[
    [28, 28],
    [72, 28],
    [28, 72],
    [72, 72],
  ]
    .map(
      ([x, y]) => `<path d="${blob(x, y, 16)}" fill="#c0392b" stroke="#1a1a1a" stroke-width="6"/>`,
    )
    .join('')}</svg>`;
  for (const route of ['auto', 'lb']) {
    const f = await bound(COVERED, { route });
    ok(
      f.sec.noAaFill === true &&
        f.gate !== 'on' &&
        has(f, 'MANTLE_HARD') &&
        f.kernel === 'hard-band',
      `(f) route '${route}': a stroke-covered bundle the route declines draws the band-hard kernel it chose (gate ${f.gate}, bound ${show(f) || 'the base program'}, kernel ${f.kernel})`,
    );
  }
}

// (e) THE ENGINE LEDGER SEES THOSE COVER QUADS. Deciding "is any fill row a cover quad" from the meshes
// alone cannot see a row 'auto''s policy passed over or one a transform override sends to its cover
// quad -- tiger at 512 px would tally lb/sdf/stroke while AAC shades a passed-over row. So the draw
// hands enginesOfUnifiedDraw the same answer the kernel gate used.
{
  const { enginesOfUnifiedDraw } = await import('../src/renderer/engineLedger.js');
  const mesh = { verts: new Float32Array(24), vertexCount: 3 };
  const meta = new Float32Array(40);
  meta[7] = 1; // one fill row (MT_FILL.a), no stroke
  const b = { _lbMeshes: [mesh], metaFloats: meta, metaFloatsPerShape: 40, numShapes: 1 };
  ok(
    !enginesOfUnifiedDraw(b, 'aac').includes('aac'),
    '(e) with no answer passed, an all-mesh draw reports no cover kernel (the mesh-only scan)',
  );
  ok(
    enginesOfUnifiedDraw(b, 'aac', true).includes('aac'),
    '(e) ...and a draw told a fill row is a cover quad reports the kernel that shaded it',
  );
  ok(
    !enginesOfUnifiedDraw({ ...b, _lbMeshes: [null] }, 'aac', false).includes('aac'),
    '(e) ...and one told none reports none',
  );
}

console.warn = warn;
console.log(fail ? `coverKernelPresenceSmoke FAIL (${fail})` : 'coverKernelPresenceSmoke PASS');
process.exit(fail ? 1 : 0);
