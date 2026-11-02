// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// engineSwitchPathsSmoke — a switch that excludes an engine must hold on every path.
//
// The defect this pins is not one wrong line, it is a shape: a diagnostic switch is honoured on the
// main draw path and quietly ignored on a secondary one, so a run taken with the switch set
// measures the engine it was trying to exclude and the number reads as a result. Nothing catches it
// downstream — the picture stays correct, because every engine here draws the same shape.
//
// A switch like `__MANTLE_FORCE_SLUG` held as a LOCAL BOOLEAN inside the static route's gate,
// where every other engine switch is a predicate asked at each gate, leaks on four paths at once:
// anything reached before that local exists (the morph route), anything that satisfies the gate
// without it (a streamed bundle), anything that sets it back to true afterwards (a bundle whose
// primitives are already built), and anything that takes the draw when the gate declines (the AAC
// point kernel) never sees it. The builders would not see it either, which is what makes the third
// case reachable at all.
//
// So the switch is read in ONE place (src/renderer/engineSwitch.js) and every path NAMES itself
// when it asks. This walks the whole table rather than the one path a reader thinks of, checks that
// nothing reads the flag behind the table's back, and then drives the three BUILD paths for real.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const { DRAW_PATHS, engineSelection, analyticAllowed, engineSelKey } =
  await import('../src/renderer/engineSwitch.js');

// ─── 1. the table, every switch against every path ──────────────────────────
const selAt = (R) => engineSelection(R);
const OFF = { opts: {}, _lbFillMode: 'auto' };
const setForceSlug = (on) => {
  globalThis.__MANTLE_DEBUG__ = on;
  globalThis.__MANTLE_FORCE_SLUG = on;
};

setForceSlug(false);
ok(selAt(OFF).forceSlug === false, 'forceSlug reads false with the globals unset');
// The flag is DEBUG-GATED: __MANTLE_FORCE_SLUG alone must not change shipped pixels.
globalThis.__MANTLE_FORCE_SLUG = true;
globalThis.__MANTLE_DEBUG__ = false;
ok(selAt(OFF).forceSlug === false, '__MANTLE_FORCE_SLUG without __MANTLE_DEBUG__ stays off');

setForceSlug(true);
const forced = selAt(OFF);
ok(forced.forceSlug === true, 'forceSlug reads true behind __MANTLE_DEBUG__');

// every path is named, and every path has an answer. A new draw path that forgets to appear here
// is the defect itself, so the count is asserted rather than the rows walked loosely.
ok(
  DRAW_PATHS.length === 6,
  `DRAW_PATHS names every path that can draw analytically (${DRAW_PATHS.join(', ')})`,
);
console.log('\n  forceSlug ON:');
const deniedByForce = [];
for (const p of DRAW_PATHS) {
  const a = analyticAllowed(forced, p);
  console.log(`    ${p.padEnd(12)} allow=${a.allow ? 'yes' : 'NO '}  reason=${a.reason}`);
  if (!a.allow) deniedByForce.push(p);
}
// Five of six are honoured outright. The sixth CANNOT be — a lightweight geometry stream is built
// without cover quads, so "draw this with Slug" has no geometry and the alternative is a blank
// frame — and the whole point is that it says so instead of taking the route in silence.
for (const p of ['static', 'morph', 'prim', 'build', 'aac-points']) {
  ok(analyticAllowed(forced, p).allow === false, `forceSlug denies the ${p} path`);
}
const stream = analyticAllowed(forced, 'stream');
ok(
  stream.allow === true && stream.reason === 'force-slug-stream',
  'forceSlug cannot be honoured for a stream, and reports that rather than swallowing it',
);

// ...and with the flag off, the route mode alone decides — including the one deliberate asymmetry:
// a recognized primitive is not a Loop-Blinn result, so turning the route off leaves it on.
setForceSlug(false);
const routeOff = selAt({ opts: {}, _lbFillMode: 'off', _lbSlugOnly: true });
ok(analyticAllowed(routeOff, 'static').allow === false, "route 'off' denies the static path");
ok(analyticAllowed(routeOff, 'morph').allow === false, "route 'off' denies the morph path");
ok(analyticAllowed(routeOff, 'build').allow === false, "route 'off' denies the build path");
ok(
  analyticAllowed(routeOff, 'prim').allow === true,
  "route 'off' still allows a recognized primitive (setSdfPrimitives is that switch)",
);
ok(
  analyticAllowed(routeOff, 'stream').allow === true,
  "route 'off' still allows a stream, which has no cover quads to fall back to",
);

// ─── 2. the selection as a cache key ────────────────────────────────────────
// A consumer that CACHES a rendered result instead of re-deciding per draw is the same defect one
// level up: the switch holds on every live path and not on the one replaying a picture.
const base = { opts: { aacFill: 'auto' }, _lbFillMode: 'auto', _lbSlugFallback: true };
const k0 = engineSelKey(base);
setForceSlug(true);
ok(engineSelKey(base) !== k0, 'the cache key moves when forceSlug is set');
setForceSlug(false);
ok(engineSelKey(base) === k0, '...and back when it is cleared');
ok(engineSelKey({ ...base, _lbFillMode: 'on' }) !== k0, 'the cache key moves with the route mode');
ok(
  engineSelKey({ ...base, opts: { aacFill: 'auto', fillKernel: 'hard-band' } }) !== k0,
  'the cache key moves with a pinned cover kernel',
);
ok(
  engineSelKey({ ...base, opts: { aacFill: 'auto', cpatchFill: true } }) !== k0,
  'the cache key moves with the CPatch route',
);

// ─── 3. ONE reader. No path may consult the flag behind the table's back ────
// This is the assertion that generalises: the four leaks are four sites that would each answer the
// question themselves. A fifth would be invisible to any behavioural test that did not already
// know about it, and visible here immediately.
const dirs = ['src/renderer', 'src/core', 'src/svg', 'src/scene', 'src/bundle'];
const readers = [];
for (const d of dirs) {
  for (const f of readdirSync(path.join(ROOT, d))) {
    if (!f.endsWith('.js')) continue;
    const rel = `${d}/${f}`;
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    // Strip comments, and match a READ rather than a mention: the two warnings that say the flag
    // cannot be honoured on their path name it in a string, which is the opposite of ignoring it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    if (/mantleDebugFlag\(\s*'forceSlug'\s*\)|\.__MANTLE_FORCE_SLUG\b/.test(code))
      readers.push(rel);
  }
}
console.log('\n  reads the flag: ' + (readers.join(', ') || '(none)'));
ok(
  readers.length === 2 &&
    readers.includes('src/core/diagnostics.js') &&
    readers.includes('src/renderer/engineSwitch.js'),
  'the flag is read in exactly two places: where it is defined and where the table lives',
);

// ─── 4. the three BUILD paths, driven for real ──────────────────────────────
// A build nobody may draw is pure cost on the run measuring the engine it excludes — and it leaves
// meshes behind, which would let the primitive promotion route a bundle the flag denied. All
// three build paths are reachable from Node with a stub GL, so none of them is taken on trust.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
const LB = await import('../src/renderer/loopBlinn.js');

// A cubic blob: the per-shape policy gives it a mesh at every size, so the build paths below are
// declined by the switch under test and by nothing else.
const SVG =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';

async function makeBundle() {
  const sec = await importSvg(SVG, { preserveViewport: true });
  // bundle.meta carries a 32-BYTE HEADER; wrapping it whole shifts every meta row by eight floats.
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  return {
    curveFloats: new Float32Array(sec.curves),
    curveRangesByShape: sec.curveRangesByShape,
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    numShapes: sec.numShapes,
    segTypeMask: sec.segTypeMask,
    _geomGen: 0,
  };
}

function makeRenderer() {
  // Every GL entry point answers null: attachMorphDraw only reads uniform locations at attach time,
  // and nothing below reaches a draw.
  const gl = new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );
  const R = {
    gl,
    opts: {},
    draw: {},
    _lbFillMode: 'auto',
    _lbSlugOnly: false,
    _lbSlugFallback: true,
  };
  // The pure builders the renderer hangs on itself (renderer.js does the same assignment).
  Object.assign(R, {
    buildLoopBlinnMesh: LB.buildLoopBlinnMesh,
    buildLoopBlinnCDT: LB.buildLoopBlinnCDT,
    refreshLoopBlinnMesh: LB.refreshLoopBlinnMesh,
    packLoopBlinnMesh: LB.packLoopBlinnMesh,
    curveRangeToContours: LB.curveRangeToContours,
    lbCanonicalFrame: LB.lbCanonicalFrame,
    lbCanonicalHash: LB.lbCanonicalHash,
    lbCanonicalHashes: LB.lbCanonicalHashes,
    transformLoopBlinnRaw: LB.transformLoopBlinnRaw,
  });
  attachMorphDraw(R);
  return R;
}

console.log('');
for (const force of [false, true]) {
  setForceSlug(force);
  const tag = force ? 'forceSlug ON ' : 'forceSlug OFF';

  const R1 = makeRenderer(),
    b1 = await makeBundle();
  const prepared = R1.prepareBundle(b1);
  const realMeshes = Array.isArray(b1._lbMeshes)
    ? b1._lbMeshes.filter((m) => m && !m.slug && (m.vertexCount | 0) > 0).length
    : 0;
  ok(
    force ? prepared === false && realMeshes === 0 : prepared === true && realMeshes > 0,
    `${tag}: prepareBundle ${force ? 'builds nothing' : `builds ${realMeshes} mesh(es)`}`,
  );

  const R2 = makeRenderer(),
    b2 = await makeBundle();
  const claimed = R2._lbBuilderFn(b2, false);
  const asked = b2._lbWorkerPendingGen !== undefined;
  ok(
    force ? claimed === false && !asked : asked,
    `${tag}: the off-thread builder ${force ? 'declines without asking the worker' : 'asks the worker'}`,
  );

  const R3 = makeRenderer(),
    b3 = await makeBundle();
  R3._lbPreparerFn(b3);
  const idleBuilt =
    Array.isArray(b3._lbMeshes) &&
    b3._lbMeshes.some((m) => m && !m.slug && (m.vertexCount | 0) > 0);
  ok(
    force ? !idleBuilt : idleBuilt,
    `${tag}: the idle preparer ${force ? 'builds nothing' : 'builds meshes'}`,
  );
}
setForceSlug(false);

console.log(fail ? `\nENGINE-SWITCH-PATHS FAIL (${fail})` : '\nENGINE-SWITCH-PATHS PASS');
process.exit(fail ? 1 : 0);
