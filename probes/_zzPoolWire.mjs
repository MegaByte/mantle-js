// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzPoolWire — does a patch survive the POOL'S WIRE? The worker ships each patch as
// {c: curves, i: inside, t: terminal}, structured clone carries it across, and the main thread rebuilds
// it with framePatch. Structured clone drops Symbol-keyed properties and anything off the object, so
// a patch can come back as a different patch. This runs that exact path in-process -- convert,
// clone the slim form, rehydrate -- and compares what the original and the rebuilt patches cover.
import { readFileSync } from 'fs';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { convertContour, framePatch, inPatch, patchBBox, insideContour } =
  await import('../src/renderer/cpatchConvert.js');

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const bundle = headlessCPatchBundle(sections);
const cf = cpatchCurvePlane(bundle);
const G = +(process.env.G || 40);
let cycles = 0,
  nulls = 0,
  noRebuild = 0,
  diffCycles = 0,
  lostTot = 0,
  gainTot = 0;
let underT = 0,
  overT = 0,
  underCycles = 0;
const symLost = new Map();
for (let s = 0; s < bundle.curveRangesByShape.length; s++) {
  const r = bundle.curveRangesByShape[s];
  if (!r) continue;
  let contours = null;
  try {
    contours = curveRangeToContours(cf, r.begin, r.end);
  } catch {
    continue;
  }
  if (!contours || !contours.length) continue;
  const cs = contoursToConverter(contours, null);
  if (!cs) continue;
  const collected = [];
  try {
    packCPatchShape(cs, 0, { evenOdd: shapeEvenOdd(bundle, s), collect: collected });
  } catch {
    continue;
  }
  for (let ci = 0; ci < collected.length; ci++) {
    const e = collected[ci];
    if (e.holes) continue;
    cycles++;
    let res = null;
    try {
      res = convertContour(e.curves, { maxCurves: 8, holes: null, search: 'full' });
    } catch {
      res = null;
    }
    if (!res || !res.patches) {
      nulls++;
      continue;
    }
    const orig = res.patches;
    for (const p of orig)
      for (const c of p.curves)
        for (const sy of Object.getOwnPropertySymbols(c))
          symLost.set(String(sy), (symLost.get(String(sy)) | 0) + 1);
    const wire = structuredClone(
      orig.map((p) => ({ c: p.curves, i: p.inside, t: p._terminal || 0 })),
    );
    const reh = wire.map((sp) => {
      const f = framePatch(sp.c, sp.i);
      if (f && sp.t) f._terminal = true;
      return f;
    });
    if (reh.some((f) => !f)) {
      noRebuild++;
      continue;
    }
    const bb = patchBBox(e.curves);
    let lost = 0,
      gain = 0,
      under = 0,
      over = 0;
    for (let gy = 0; gy < G; gy++)
      for (let gx = 0; gx < G; gx++) {
        const x = bb[0] + ((bb[2] - bb[0]) * (gx + 0.5)) / G,
          y = bb[1] + ((bb[3] - bb[1]) * (gy + 0.5)) / G;
        const a = orig.some((p) => inPatch(p, x, y)),
          b = reh.some((p) => inPatch(p, x, y));
        if (a && !b) lost++;
        else if (b && !a) gain++;
        // AND AGAINST THE CYCLE ITSELF: the pool converts with its own options, so the question is not only
        // whether the wire preserves a patch but whether the pool's decomposition covers the region at all.
        const t = insideContour(e.curves, x, y);
        if (t && !a) under++;
        else if (a && !t) over++;
      }
    underT += under;
    overT += over;
    if (under > 2) {
      underCycles++;
      if (underCycles <= 8)
        console.log(
          `  UNDER shape ${s} cycle ${ci}: ${e.curves.length} curves -> ${orig.length} patches, under ${under} over ${over} of ${G * G}`,
        );
    }
    if (lost || gain) {
      diffCycles++;
      lostTot += lost;
      gainTot += gain;
      if (diffCycles <= 6) {
        const bad = orig
          .map((p, k) => [
            k,
            inPatch(p, p.inside[0], p.inside[1]),
            inPatch(reh[k], reh[k].inside[0], reh[k].inside[1]),
            (p.impls || []).map((im) => im.s).join(''),
            (reh[k].impls || []).map((im) => im.s).join(''),
          ])
          .filter((q) => q[1] !== q[2] || q[3] !== q[4])
          .slice(0, 3);
        console.log(
          `  shape ${s} cycle ${ci}: ${e.curves.length} curves, ${orig.length} patches  lost ${lost} gained ${gain} of ${G * G}  ` +
            `patches differing (k, origInside, rehInside, origSigns, rehSigns): ${JSON.stringify(bad)}`,
        );
      }
    }
  }
}
console.log(
  `POOL-OPTIONS decomposition vs the cycle: under ${underT} over ${overT} samples; cycles with under>2: ${underCycles}`,
);
console.log(
  `cycles ${cycles}  null ${nulls}  frame-did-not-rebuild ${noRebuild}  cycles whose coverage CHANGED on the wire ${diffCycles}  (lost ${lostTot} / gained ${gainTot} samples)`,
);
console.log(
  `symbol-keyed properties on original curves (dropped by structured clone): ${JSON.stringify([...symLost])}`,
);
