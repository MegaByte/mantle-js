// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphClipRunsSmoke -- clip/mask runs whose child count or membership differs between poses.
//
// Policy under test (core/morphBindings.js): matched clip/mask children morph; a destination-only
// painted row binds the destination composition from t = 0 (and fades in as paint); a MATCHED painted
// row keeps its source binding for t < 1 and takes the complete destination run at t = 1, so the
// output at t = 0 is the source composition and at t = 1 the destination composition. Runs are
// complete (all children, correct BEGIN/END markers), nested clip bindings are reproduced, and alias
// rows follow clipper overrides. No painted row is added (the composition is unchanged).
//
// Each case compares the run reached from every painted row's binding, as the shader walks it, against
// the run the source (t = 0) or destination (t = 1) bundle reaches: child count, per-child pose box
// and nested bindings. Both curve-interpolation paths are exercised; the GPU path's t = 1 binding lands
// as one texel patch per bound row, which is recorded and checked against the merged plane.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const { createFakeGl } = await import('./_fakeGl.mjs');
const { createShapeMorph } = await import('../src/animation/shapeMorph.js');
const { createBundle } = await import('../src/renderer/bundle.js');
const L = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const S = L.META_FLOATS_PER_SHAPE;
const BEGIN = 2048,
  END = 4096,
  MBEGIN = 512,
  MEND = 1024;

// ---- fixtures -------------------------------------------------------------------------------------
const kid = (tag, id, x, w, extra = '') =>
  `<${tag} ${id === null ? '' : `id="${id}" `}x="${x}" y="0" width="${w}" height="100"${extra}/>`;
const clipDefs = (spec, name) =>
  `<clipPath id="${name}">${spec.map((k) => kid('rect', k.id, k.x, k.w, k.clip ? ` clip-path="url(#${k.clip})"` : '')).join('')}</clipPath>`;
const maskDefs = (spec, name) =>
  `<mask id="${name}">${spec.map((k) => kid('rect', k.id, k.x, k.w, ' fill="white"')).join('')}</mask>`;
// n children in 80 units, ids cl0.. (named) or none (unnamed).
const even = (n, named = true, ids) =>
  Array.from({ length: n }, (_, i) => ({
    id: named ? (ids ? ids[i] : `cl${i}`) : null,
    x: (100 * i) / n,
    w: 80 / n,
  }));
const doc = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
const paint = (id, attr, ref, color) =>
  `<rect id="${id}" width="100" height="100" fill="${color}" ${attr}="url(#${ref})"/>`;

// ---- run reading, as the fragment shader walks it --------------------------------------------------
function runRows(meta, first, slot) {
  const rows = [],
    begin = slot === L.META_CLIP_ID ? BEGIN : MBEGIN,
    end = slot === L.META_CLIP_ID ? END : MEND;
  const f = (r) => meta[r * S + L.META_FLAGS_SHAPE] | 0;
  const multi = (f(first) & begin) !== 0;
  for (let r = first; r * S < meta.length; r++) {
    if (multi && !(f(r) & L.FS_LAYER)) {
      rows.push('open');
      break;
    }
    rows.push(r);
    if (!multi || f(r) & end) break;
  }
  return rows;
}
// Signature of the run bound at `slot` of `row`: per child, its box (from `pose`) and nested runs.
function signature(bind, pose, row, slot, depth = 0, within = -1) {
  const id = Math.round(bind[row * S + slot]);
  if (id <= 0 || id - 1 === within) return null; // a mask child names its own mask: not a nested binding
  const rows = runRows(bind, id - 1, slot);
  if (rows.includes('open')) return 'unterminated';
  return rows.map((r) => ({
    box: [0, 1, 2, 3].map((k) => Math.round(pose[r * S + k] * 1e3)),
    nested:
      depth < 2
        ? [
            signature(bind, pose, r, L.META_CLIP_ID, depth + 1, id - 1),
            signature(bind, pose, r, L.META_MASK_ID, depth + 1, id - 1),
          ]
        : null,
  }));
}
const gate = (gl, calls) =>
  new Proxy(gl, {
    get: (o, k) =>
      k === 'texSubImage2D'
        ? (...a) => {
            calls.push(a);
            return o.texSubImage2D(...a);
          }
        : o[k],
  });

async function run(name, srcSvg, dstSvg, painted) {
  console.log(`\n-- ${name} --`);
  for (const gpu of [false, true]) {
    const { gl: raw } = createFakeGl(),
      calls = [],
      gl = gate(raw, calls);
    const a = createBundle(gl, await importSvg(srcSvg)),
      b = createBundle(gl, await importSvg(dstSvg));
    const m = createShapeMorph(gl, a, b, { cpuLerp: !gpu });
    if (gpu) m.bundle._morphSrc.gpuSmallPlanes = true;
    const bundle = m.bundle,
      meta = () => bundle.metaFloats;
    const sections = bundle._morphSrc;
    const merged = sections.mergedMetaF32,
      dstPlane = sections.dstMetaF32,
      matched = sections.matchedSrcIdxs;
    const pose = (t) => {
      const o = merged.slice();
      for (const r of matched)
        for (let k = 0; k < 4; k++)
          o[r * S + k] = merged[r * S + k] * (1 - t) + dstPlane[r * S + k] * t;
      return o;
    };
    const tag = gpu ? 'gpu' : 'cpu';
    const paintedRows = (bundle.shapeIds || [])
      .map((id, i) => [id, i])
      .filter(([id]) => painted.includes(id));
    ok(
      paintedRows.length === painted.length,
      `${name} [${tag}]: painted rows present (${paintedRows.map((r) => r[0])})`,
    );
    const nonLayer = Array.from({ length: bundle.numShapes }, (_, i) => i).filter(
      (i) => !((meta()[i * S + L.META_FLAGS_SHAPE] | 0) & L.FS_LAYER),
    ).length;
    const srcPainted = Array.from({ length: a.numShapes }, (_, i) => i).filter(
      (i) => !((a.metaFloats[i * S + L.META_FLAGS_SHAPE] | 0) & L.FS_LAYER),
    ).length;
    const dstPainted = Array.from({ length: b.numShapes }, (_, i) => i).filter(
      (i) => !((b.metaFloats[i * S + L.META_FLAGS_SHAPE] | 0) & L.FS_LAYER),
    ).length;
    ok(
      nonLayer <= srcPainted + dstPainted,
      `${name} [${tag}]: no painted alias rows (${nonLayer} <= ${srcPainted}+${dstPainted})`,
    );

    {
      // Mask children name their own mask (never a foreign run): a foreign id would read as a nested mask.
      let begin = -1,
        foreign = 0;
      for (let r = 0; r < bundle.numShapes; r++) {
        const f = meta()[r * S + L.META_FLAGS_SHAPE] | 0;
        if (!(f & L.FS_LAYER)) {
          begin = -1;
          continue;
        }
        if (f & MBEGIN) begin = r;
        const id = Math.round(meta()[r * S + L.META_MASK_ID]);
        if (begin >= 0 && id > 0 && id - 1 !== begin) foreign++;
        if (f & MEND) begin = -1;
      }
      ok(
        foreign === 0 || !/mask/.test(name),
        `${name} [${tag}]: no mask child references a foreign mask run (${foreign})`,
      );
    }
    for (const t of [0, 0.5, 1]) {
      calls.length = 0;
      m.setT(t);
      const live = meta();
      for (const [id, row] of paintedRows) {
        const dstRow = b.shapeIds.indexOf(id),
          srcRow = a.shapeIds.indexOf(id);
        for (const slot of [L.META_CLIP_ID, L.META_MASK_ID]) {
          const got = signature(live, pose(t), row, slot);
          let want;
          if (srcRow < 0)
            want = signature(b.metaFloats, b.metaFloats, dstRow, slot); // destination-only: its own composition
          else if (t < 1)
            want = signature(a.metaFloats, a.metaFloats, srcRow, slot); // source composition until the endpoint
          else want = signature(b.metaFloats, b.metaFloats, dstRow, slot); // destination composition at t = 1
          if (t < 1 && srcRow < 0) {
            // A destination-only row binds the destination run from the start; matched children inside it keep
            // their source nesting until t = 1, so only the run's child count is pinned before the endpoint.
            const count = (x) => (x === null ? 0 : x === 'unterminated' ? -1 : x.length);
            ok(
              count(got) === count(want),
              `${name} [${tag}] t=${t} ${id} slot ${slot}: destination run length (${count(got)})`,
            );
          } else if (t > 0 && t < 1) {
            // poses between the endpoints are lerped; compare structure (counts and nesting) rather than boxes
            const shape = (s) =>
              s === null
                ? null
                : s === 'unterminated'
                  ? s
                  : s.map((c) => (c.nested ? c.nested.map(shape) : null));
            ok(
              JSON.stringify(shape(got)) === JSON.stringify(shape(want)),
              `${name} [${tag}] t=${t} ${id} slot ${slot}: source run structure holds`,
            );
          } else {
            if (process.env.DBG && JSON.stringify(got) !== JSON.stringify(want))
              console.log(JSON.stringify(got), JSON.stringify(want));
            ok(
              JSON.stringify(got) === JSON.stringify(want),
              `${name} [${tag}] t=${t} ${id} slot ${slot}: ${t === 0 ? 'source' : 'destination'} run (${got === null ? 'none' : got.length ? got.length : got} children)`,
            );
          }
        }
      }
      if (gpu) {
        const patches = calls.filter((c) => c[2] === 7 && c[4] === 1 && c[5] === 1);
        const bound = new Set((sections.bindingSteps || []).map((e) => e.row));
        ok(
          t >= 1 ? patches.length === bound.size : patches.length === 0,
          `${name} [gpu] t=${t}: ${patches.length} binding texel patch(es), expect ${t >= 1 ? bound.size : 0}`,
        );
      }
    }
    m.setT(0.25);
    ok(
      JSON.stringify(signature(meta(), pose(0.25), paintedRows[0][1], L.META_CLIP_ID)) ===
        JSON.stringify(
          signature(
            a.metaFloats,
            pose(0.25),
            a.shapeIds.indexOf(paintedRows[0][0]) < 0 ? 0 : a.shapeIds.indexOf(paintedRows[0][0]),
            L.META_CLIP_ID,
          ),
        ) || paintedRows[0][0] === 'b',
      `${name} [${tag}]: leaving t = 1 restores the source binding`,
    );
    // Alias rows follow clipper overrides on their origin.
    const aliases = bundle._morphBindingAliases;
    if (aliases && aliases.some(Boolean) && a.clipperRows) {
      const id = Object.keys(a.clipperRows)[0];
      if (id && m.overrides.setClipper(id, { localPosition: [3, 4] })) {
        let seen = 0,
          same = true;
        aliases.forEach((list, origin) =>
          (list || []).forEach((al) => {
            seen++;
            const x = m.overrides.get(al),
              y = m.overrides.get(origin);
            same = same && JSON.stringify(x.localPosition) === JSON.stringify(y.localPosition);
          }),
        );
        ok(seen > 0 && same, `${name} [${tag}]: ${seen} alias row(s) mirror the clipper transform`);
        m.overrides.clearClipper(id);
      }
    }
    m.dispose();
    a.dispose();
    b.dispose();
  }
}

// ---- growing, shrinking, equal ----------------------------------------------------------------------
for (const [n0, n1] of [
  [16, 16],
  [16, 20],
  [20, 20],
  [20, 24],
  [24, 16],
  [24, 20],
  [20, 16],
  [1, 2],
  [2, 1],
]) {
  await run(
    `clip ${n0}->${n1} (matched + dst-only paint)`,
    doc(clipDefs(even(n0), 'c'), paint('a', 'clip-path', 'c', 'red')),
    doc(
      clipDefs(even(n1), 'c'),
      paint('a', 'clip-path', 'c', 'red') + paint('b', 'clip-path', 'c', 'blue'),
    ),
    ['a', 'b'],
  );
}
await run(
  'clip 20->24 (matched paint only)',
  doc(clipDefs(even(20), 'c'), paint('a', 'clip-path', 'c', 'red')),
  doc(clipDefs(even(24), 'c'), paint('a', 'clip-path', 'c', 'red')),
  ['a'],
);
await run(
  'clip 24->16 (matched paint only)',
  doc(clipDefs(even(24), 'c'), paint('a', 'clip-path', 'c', 'red')),
  doc(clipDefs(even(16), 'c'), paint('a', 'clip-path', 'c', 'red')),
  ['a'],
);

// ---- split runs: destination children inserted between matched ones ------------------------------------
{
  const ids = [
    ...Array.from({ length: 6 }, (_, i) => `cl${i}`),
    'n0',
    'n1',
    ...Array.from({ length: 6 }, (_, i) => `cl${i + 6}`),
  ];
  await run(
    'clip split run (dst children inserted mid-run)',
    doc(clipDefs(even(12), 'c'), paint('a', 'clip-path', 'c', 'red')),
    doc(
      clipDefs(even(14, true, ids), 'c'),
      paint('a', 'clip-path', 'c', 'red') + paint('b', 'clip-path', 'c', 'blue'),
    ),
    ['a', 'b'],
  );
  await run(
    'clip split run, source-only child removed mid-run',
    doc(clipDefs(even(14, true, ids), 'c'), paint('a', 'clip-path', 'c', 'red')),
    doc(clipDefs(even(12), 'c'), paint('a', 'clip-path', 'c', 'red')),
    ['a'],
  );
}

// ---- unnamed children, masks, nesting -----------------------------------------------------------------------
await run(
  'clip unnamed 6->9',
  doc(clipDefs(even(6, false), 'c'), paint('a', 'clip-path', 'c', 'red')),
  doc(
    clipDefs(even(9, false), 'c'),
    paint('a', 'clip-path', 'c', 'red') + paint('b', 'clip-path', 'c', 'blue'),
  ),
  ['a', 'b'],
);
await run(
  'mask 4->7',
  doc(maskDefs(even(4), 'm'), paint('a', 'mask', 'm', 'red')),
  doc(maskDefs(even(7), 'm'), paint('a', 'mask', 'm', 'red') + paint('b', 'mask', 'm', 'blue')),
  ['a', 'b'],
);
await run(
  'mask 7->4',
  doc(maskDefs(even(7), 'm'), paint('a', 'mask', 'm', 'red')),
  doc(maskDefs(even(4), 'm'), paint('a', 'mask', 'm', 'red')),
  ['a'],
);
{
  const nest = (n, inner) => even(n).map((k, i) => (i === 1 ? { ...k, clip: 'd' } : k));
  await run(
    'nested clip: child clip grows 3->5 while the outer grows 4->6',
    doc(clipDefs(even(3), 'd') + clipDefs(nest(4), 'c'), paint('a', 'clip-path', 'c', 'red')),
    doc(
      clipDefs(even(5), 'd') + clipDefs(nest(6), 'c'),
      paint('a', 'clip-path', 'c', 'red') + paint('b', 'clip-path', 'c', 'blue'),
    ),
    ['a', 'b'],
  );
  await run(
    'nested clip: child clip shrinks 5->3 while the outer shrinks 6->4',
    doc(clipDefs(even(5), 'd') + clipDefs(nest(6), 'c'), paint('a', 'clip-path', 'c', 'red')),
    doc(clipDefs(even(3), 'd') + clipDefs(nest(4), 'c'), paint('a', 'clip-path', 'c', 'red')),
    ['a'],
  );
}
await run(
  'binding removed and added (clip <-> none)',
  doc(
    clipDefs(even(3), 'c'),
    paint('a', 'clip-path', 'c', 'red') + '<rect id="z" width="10" height="10" fill="green"/>',
  ),
  doc(
    clipDefs(even(3), 'c'),
    '<rect id="a" width="100" height="100" fill="red"/>' +
      `<rect id="z" width="10" height="10" fill="green" clip-path="url(#c)"/>`,
  ),
  ['a', 'z'],
);

console.log(
  fail
    ? `\nFAIL (${fail})`
    : '\nmorphClipRunsSmoke: clip/mask runs hold the source composition until t = 1 and the destination composition at t = 1',
);
process.exit(fail ? 1 : 0);
