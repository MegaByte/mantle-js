// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Check explicit automatic-build selection, per-shape eligibility, primitive retention,
// skipped-row diagnostics and rebuilding when a prepared bundle switches to a pinned mode.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, contoursArePrimitive, lbMeshCensus, SLUG_WHY } =
  await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
const { lbBuildSkipMask, lbShapeMayPick, lbBundleMayPick, lbShapePicks } =
  await import('../src/renderer/lbShapePolicy.js');
const { shapeSegStats } = await import('../src/renderer/shapeStats.js');
const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
const LB = await import('../src/renderer/loopBlinn.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const f = (v) => v.toFixed(3);
function quadCircle(cx, cy, r, n) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const t0 = (2 * Math.PI * i) / n,
      t1 = (2 * Math.PI * (i + 1)) / n,
      tm = (t0 + t1) / 2;
    const rc = r / Math.cos(Math.PI / n);
    if (i === 0) d = `M${f(cx + r * Math.cos(t0))} ${f(cy + r * Math.sin(t0))}`;
    d += ` Q${f(cx + rc * Math.cos(tm))} ${f(cy + rc * Math.sin(tm))} ${f(cx + r * Math.cos(t1))} ${f(cy + r * Math.sin(t1))}`;
  }
  return d + ' Z';
}

// A cubic blob the policy takes, a straight-edged shape and a stroke-only row it never can, and a
// quadratic circle it declines BY TYPE while taking it as a primitive.
const MIXED =
  '<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/>' +
  '<path fill="#088" d="M200 20 L260 20 L230 90 Z"/>' +
  '<path fill="none" stroke="#c33" stroke-width="6" d="M200 120 L260 120 L230 180 Z"/>' +
  `<path fill="#333" d="${quadCircle(340, 100, 45, 16)}"/></svg>`;

// bundle.meta carries a 32-BYTE HEADER; parseMetaBin strips it. Wrapping it whole shifts every meta
// row by eight floats, which changes the stroke flag and the fill rule every predicate here reads.
async function load(svg) {
  const sec = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const input = {
    curveFloats: new Float32Array(sec.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: sec.curveRangesByShape,
    numShapes: sec.numShapes,
  };
  return {
    input,
    bundle: {
      curveFloats: input.curveFloats,
      curveRangesByShape: input.ranges,
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      numShapes: sec.numShapes,
      segTypeMask: sec.segTypeMask,
      _geomGen: 0,
    },
  };
}

const mixed = await load(MIXED);
const stats = shapeSegStats(mixed.bundle);
const n = mixed.bundle.numShapes;
const skip = lbBuildSkipMask(mixed.bundle);

// ── 1. the mask is exactly the complement of the PER-SHAPE predicate ────────
let agree = true;
for (let s = 0; s < n; s++)
  if (!!(skip && skip[s]) !== !lbShapeMayPick(mixed.bundle, s, stats)) agree = false;
ok(agree, `the skip mask is exactly "not lbShapeMayPick", row by row (${n} rows)`);
ok(
  lbBundleMayPick(mixed.bundle) === true && !!skip && skip.some((v) => v === 1),
  'a bundle the WHOLE-BUNDLE admission passes can still have rows worth skipping — which is the point',
);

// ── 2. gated and ungated builds hand the policy the same meshes ─────────────
const full = buildLbBundle(mixed.input).packed;
const gatedRes = buildLbBundle({ ...mixed.input, skip });
const gated = gatedRes.packed;
const real = (p) => p.filter((m) => m && !m.slug && (m.vertexCount | 0) > 0).length;
ok(real(gated) < real(full), `the gate builds fewer meshes (${real(full)} -> ${real(gated)})`);

const rendererAt = (N) => ({ viewportSize: () => [N, N], arScale: () => [1, 1], draw: {} });
let picksDiffer = 0,
  meshDiffer = 0,
  picked = 0;
for (const N of [128, 512, 2048]) {
  const pf = lbShapePicks(rendererAt(N), { ...mixed.bundle, _lbPickCache: null }, full);
  const pg = lbShapePicks(rendererAt(N), { ...mixed.bundle, _lbPickCache: null }, gated);
  for (let s = 0; s < n; s++) {
    const a = pf ? pf[s] : 0,
      b = pg ? pg[s] : 0;
    if (a !== b) {
      picksDiffer++;
      continue;
    }
    if (!a) continue;
    picked++;
    const mf = full[s],
      mg = gated[s];
    if (!mf || !mg || (mf.vertexCount | 0) !== (mg.vertexCount | 0)) meshDiffer++;
  }
}
ok(picked > 0, `the policy still picks ${picked} shape/size pairs from the gated build`);
ok(picksDiffer === 0, 'the picked SET is identical at 128, 512 and 2048 px');
ok(meshDiffer === 0, 'and every picked shape has the same mesh it had in the ungated build');

// ── 3. a skipped row is NOT BUILT, and is never reported as a decline ───────
// The over-paint gate is judged on a decline count. A gate that made shapes look declined would
// corrupt exactly the statistic that says whether the partition holds.
const cg = lbMeshCensus({ numShapes: n, _lbMeshes: gated, _lbSlugWhy: gatedRes.why });
const cf = lbMeshCensus({
  numShapes: n,
  _lbMeshes: full,
  _lbSlugWhy: buildLbBundle(mixed.input).why,
});
ok(cg.notBuilt > 0, `the gate reports ${cg.notBuilt} row(s) as NOT BUILT`);
ok(
  cg.declined === cf.declined,
  `and the decline count is untouched by the gate (${cf.declined} either way)`,
);

// ── 4. a skipped row that is a PRIMITIVE still builds ───────────────────────
// The policy takes a primitive whatever it says about curve types, so skipping one would lose a
// shape the route draws — and lose it silently, since it falls back to a correct cover quad.
let primRow = -1;
for (let s = 0; s < n; s++) {
  const r = mixed.input.ranges[s];
  if (!r) continue;
  const c = curveRangeToContours(mixed.input.curveFloats, r.begin, r.end);
  if (contoursArePrimitive(c, false)) {
    primRow = s;
    break;
  }
}
ok(primRow >= 0, `the quadratic circle is recognized as a primitive (row ${primRow})`);
ok(
  !!(skip && skip[primRow]),
  '...and the per-shape policy declines it by curve type, so the gate would skip it',
);
ok(
  !!gated[primRow] && !gated[primRow].slug && (gated[primRow].vertexCount | 0) > 0,
  '...but the gated build produces its mesh anyway',
);
ok(
  !!gated[primRow].prim,
  '...and it is a primitive mesh, which lbShapePicks takes unconditionally',
);

// ── 5. only an EXPLICIT 'auto' activates the gate ───────────────────────────
const glStub = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );
function makeRenderer(select) {
  const R = {
    gl: glStub(),
    opts: {},
    draw: {},
    _lbFillMode: 'auto',
    _lbAutoExplicit: false,
    _lbSlugOnly: false,
    _lbSlugFallback: true,
  };
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
  // The renderer's own setter writes both fields; this is what it writes.
  if (select) {
    R._lbFillMode = select === 'on' ? 'on' : select;
    R._lbAutoExplicit = select === 'auto';
  }
  return R;
}

// The DEFAULT is 'auto' too, and it must build everything: the caller has made no commitment about
// what happens after a later pin, and that is the case the parity family is.
const Rdef = makeRenderer(null),
  bDef = (await load(MIXED)).bundle;
Rdef.prepareBundle(bDef);
ok(bDef._lbBuildGated === false, "the DEFAULT 'auto' does not gate — no selection, no commitment");
ok(
  real(bDef._lbMeshes || []) === real(full),
  `...and builds every mesh (${real(bDef._lbMeshes || [])} of ${real(full)})`,
);

const Rauto = makeRenderer('auto'),
  bAuto = (await load(MIXED)).bundle;
Rauto.prepareBundle(bAuto);
ok(bAuto._lbBuildGated === true, "an EXPLICIT 'auto' gates");
ok(
  real(bAuto._lbMeshes || []) === real(gated),
  `...and builds ${real(bAuto._lbMeshes || [])} meshes where the default builds ${real(full)}`,
);

const Ron = makeRenderer('on'),
  bOn = (await load(MIXED)).bundle;
Ron.prepareBundle(bOn);
ok(bOn._lbBuildGated === false, "a pinned 'on' does not gate — it draws every mesh it is given");

// ── 6. a pin after a gated build rebuilds, and says so until it has ─────────
ok(Rauto._lbBuildStale(bAuto) === false, 'a gated bundle is ready while the selection still holds');
Rauto._lbFillMode = 'on';
Rauto._lbAutoExplicit = false;
ok(
  Rauto._lbBuildStale(bAuto) === true,
  '...and reads as NOT READY the instant the selection is pinned — its meshes are real and current, so nothing else would say so',
);
const adoptBefore = bAuto._lbAdoptKey | 0;
Rauto.prepareBundle(bAuto);
ok(
  Rauto._lbBuildStale(bAuto) === false && real(bAuto._lbMeshes || []) === real(full),
  'the pin rebuilds it to the full mesh set',
);
// The geometry did not change, so without this the kind mask keeps the gated set's kinds and the
// variant compiles out the blocks the new meshes need — which paints nothing, for a reason no pixel
// test could name.
ok(
  (bAuto._lbAdoptKey | 0) !== adoptBefore,
  '...and bumps the adoption key, so the kind mask and the unified stream rebuild with it',
);

// ── 7. the WIRING the stub above bypasses ──────────────────────────────────
// makeRenderer writes _lbAutoExplicit by hand, because the real setter lives inside createRenderer
// and needs a GL context. So check that the setter is what writes it and the gate is what reads it:
// a rename on either side would leave every assertion above passing against a field nothing sets,
// and the gate would silently never fire (or always fire).
const { readFileSync } = await import('fs');
const { fileURLToPath } = await import('url');
const pathMod = await import('path');
const SRC = pathMod.resolve(
  pathMod.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);
const rendererSrc = readFileSync(pathMod.join(SRC, 'renderer.js'), 'utf8');
const morphSrc = readFileSync(pathMod.join(SRC, 'morphDraw.js'), 'utf8');
ok(
  /_lbAutoExplicit\s*=\s*\(?m === 'auto'\)?/.test(rendererSrc),
  "setLoopBlinnFill records whether 'auto' was SELECTED, not merely in effect",
);
ok(/_lbAutoExplicit === true/.test(morphSrc), '...and the build gate is what reads it');

// ── 8. the line-only frame that took the lane down the FIRST time ──────────
const FRAME =
  '<svg viewBox="0 0 186 286" xmlns="http://www.w3.org/2000/svg" width="93" height="143">' +
  '<path d="M135.2 10 L176 51 V276 H10 V10 Z  M139.4 0 H0 V286 H186 V46.9 L183.1 44 L142.3 3 Z" fill="#000"/></svg>';
const frame = await load(FRAME);
ok(
  lbBundleMayPick(frame.bundle) === false,
  'the line-only frame is declined by the whole-bundle admission',
);
const Rf = makeRenderer('on'),
  bF = (await load(FRAME)).bundle;
Rf.prepareBundle(bF);
ok(
  real(bF._lbMeshes || []) > 0,
  `...and preparing it under 'on' still builds ${real(bF._lbMeshes || [])} mesh(es) — the lane's lbRouted 0`,
);

console.log(fail ? `\nLB-BUILD-GATE FAIL (${fail})` : '\nLB-BUILD-GATE PASS');
process.exit(fail ? 1 : 0);
