// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shapeMorphSourceReleaseSmoke -- a shape morph must not keep its SOURCE bundles alive when they cannot be exported.
//
// createShapeMorph stashes `__exportMorph = { srcBundle, dstBundle, ... }` on the morph bundle so renderer.exportFrameSVG can
// rebuild a native morph. That rebuild needs the sources' retained markup (createNativeMorph throws without `svgSource`), so for
// sources imported WITHOUT retainSource the strong references only pinned both source bundles -- CPU planes and GL textures --
// for the morph's whole life (most of the memory of a scene of several morph pairs). Pins: (1) such a source is
// collectable once the app drops it, (2) createNativeMorph still throws the same error for the stand-in, (3) with retainSource the
// sources are still held (the export keeps working).
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
if (typeof globalThis.gc !== 'function') {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}
import { createFakeGl } from './_fakeGl.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
const { default: importSvg } = await import('../src/svg/importer.js');
const { createBundle } = await import('../src/renderer/bundle.js');
const { createShapeMorph } = await import('../src/animation/shapeMorph.js');
const { createNativeMorph } = await import('../src/fallback/nativeMorph.js');
const A =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M10 10 L60 10 L60 60 Z" fill="#f00"/></svg>';
const B =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M20 20 L80 20 L80 80 Z" fill="#00f"/></svg>';
const { gl } = createFakeGl();
const tick = () => new Promise((r) => setTimeout(r, 20));

// (1) and (2): sources imported without retainSource
let morph;
const freed = [];
const fr = new FinalizationRegistry((tag) => freed.push(tag));
// the sources live only in this frame (a plain function: an async frame's locals can stay on the stack past their block)
const build = (sa, sb) => {
  const a = createBundle(gl, sa),
    b = createBundle(gl, sb);
  fr.register(a, 'a');
  fr.register(b, 'b');
  return createShapeMorph(gl, a, b);
};
morph = build(await importSvg(A), await importSvg(B));
await tick();
globalThis.gc();
await tick();
globalThis.gc();
await tick();
ok(
  freed.includes('a') && freed.includes('b'),
  `both source bundles are collectable after the app drops them (freed: ${freed.join(',') || 'none'})`,
);
const ref = morph.bundle.__exportMorph;
let msg = '';
try {
  createNativeMorph(ref.srcBundle, ref.dstBundle, {});
} catch (e) {
  msg = String(e.message);
}
ok(/srcBundle needs svgSource/.test(msg), `the export still fails with the same error (${msg})`);

// (3): retainSource keeps the export path whole
{
  const a = createBundle(gl, await importSvg(A, { retainSource: true })),
    b = createBundle(gl, await importSvg(B, { retainSource: true }));
  const m = createShapeMorph(gl, a, b);
  const r = m.bundle.__exportMorph;
  ok(
    r.srcBundle.svgSource && r.dstBundle.svgSource,
    'with retainSource the export still holds both sources',
  );
  let built = true;
  try {
    createNativeMorph(r.srcBundle, r.dstBundle, {});
  } catch (e) {
    built = String(e.message);
  }
  ok(built === true, `and createNativeMorph builds from them (${built})`);
}
// Exact fixed ranges must omit composition padding and outlive their endpoints.
{
  const empty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"/>';
  const left = A.replace('<path ', '<path id="left" ');
  const right = B.replace('<path ', '<path id="right" ');
  for (const [source, destination] of [
    [empty, left],
    [left, empty],
    [left, right],
  ]) {
    const a = createBundle(gl, await importSvg(source));
    const b = createBundle(gl, await importSvg(destination));
    const m = createShapeMorph(gl, a, b);
    const ranges = m.bundle._morphSrc.fixedCurveRanges;
    const expected = [
      ...m.plan.srcOnly.map((e) => ({ index: e.srcIdx, bundle: a, original: e.srcIdx })),
      ...m.plan.dstOnly.map((e, i) => ({ index: a.numShapes + i, bundle: b, original: e.dstIdx })),
    ];
    const snapshots = [];
    for (const e of expected) {
      const r = ranges[e.index],
        original = e.bundle.curveRangesByShape[e.original];
      const data = m.bundle._morphSrc.mergedCurveF32.subarray(r.begin, r.end);
      const input = e.bundle.curveFloats.subarray(original.begin, original.end);
      const bits = (v) => new Uint32Array(v.buffer, v.byteOffset, v.length);
      ok(
        data.length === input.length && bits(data).every((v, i) => v === bits(input)[i]),
        'fixed range contains exactly the original native records',
      );
      snapshots.push({ range: r, data: data.slice() });
    }
    a.dispose();
    b.dispose();
    m.setT(0.37);
    ok(
      snapshots.every(({ range, data }) =>
        data.every((v, i) => Object.is(v, m.bundle._morphSrc.mergedCurveF32[range.begin + i])),
      ),
      'fixed native ranges survive endpoint disposal and pose updates',
    );
    m.dispose();
  }
}
process.exit(fail ? 1 : 0);
