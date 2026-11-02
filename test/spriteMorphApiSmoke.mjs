// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteMorphApiSmoke -- the sprite / nine-slice / morph / streaming / override-table API contracts.
//
// CPU proofs of each decision, on the real code and test/_fakeGl.mjs. The behaviors that show in PIXELS are proven again on the GPU in
// test/spriteMorphApiRenderSmoke.mjs, against a literal control.
//
//   hit tests honor nine-slicing (the query point maps back through the cut table)
//   submitBundle copies the options (a reused object, its worldMatrix included) instead of keeping the caller's
//   a repeated top-level sprite id: the first element is the sprite, the later ones are not, one warning
//   a morph built from another morph's bundle starts from that morph's current pose
//   updateBundleGeometry refuses a non-finite coordinate ({ok:false}, no partial state)
//   a lightweight stream draws a zero-area polygon as nothing
//   OverrideTable numeric keys are integers
//   absolute fill / stroke / strokeWidth overrides are sanitized by a stated rule; valid input is stored as given
//   the occlusion cull is retired by the first draw after an override change
//   prepareBundle declines a nine-sliced bundle, and the analytic route never draws one
//   invalid nine-slice options throw before anything is mutated
//   submitBundle zOrder: +-Infinity honored, NaN / non-numbers rejected
//   group opacity: interpolates when both poses have the group; the README says what a missing group means
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I = await import('../src/index.js');
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { attachFrameLoop } = await import('../src/renderer/frameLoop.js');
const { sampleMorphPose } = await import('../src/core/morphPose.js');
const { mkArc } = await import('../src/svg/segment.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sec = async (name, fn) => {
  console.log('\n  ' + name);
  try {
    await fn();
  } catch (e) {
    fail++;
    console.log(
      'FAIL ' +
        name +
        ' threw: ' +
        String((e && e.stack) || e)
          .split('\n')
          .slice(0, 3)
          .join(' | '),
    );
  }
};
const throws = (f, re) => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test(String(e && e.message));
  }
};
const doc = (body, vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
const F = createFakeGl();
const gl = F.gl;
const bun = async (s, o) =>
  I.createBundle(gl, await I.importSvg(s, { preserveViewport: true, ...(o || {}) }));
const warns = [];
I.setDiagnostics({
  onWarn: (...a) => {
    warns.push(a.join(' '));
  },
});

// ── nine-slice hit tests ───────────────────────────────────────────────
await sec('nine-slice hit tests:', async () => {
  // Two 25-wide rects at the ends of a 100x100 frame; [25,75] is empty. Sliced to 200x100 with 25 borders the right rect is at x 175..200.
  const base = await bun(
    doc(
      '<rect id="L" x="0" y="0" width="25" height="100"/><rect id="R" x="75" y="0" width="25" height="100"/>',
    ),
  );
  const inst = base.nineSliceInstance({ border: [25, 25, 25, 25], worldSize: [200, 100] });
  const H = (b, x, y) => I.fillHitShape(b, x, y);
  ok(
    H(inst, 190, 50) === 1,
    'the right rect answers where it is drawn (x 190 of a 200 wide slice)',
  );
  ok(H(inst, 10, 50) === 0, 'the left rect answers in the pinned corner');
  ok(
    H(inst, 120, 50) === -1 && H(inst, 80, 50) === -1,
    'the stretched middle (native 25..75, no shape) misses; the native position of the right rect (80) no longer hits',
  );
  ok(H(inst, 210, 50) === -1 && H(inst, -5, 50) === -1, 'outside the sliced rect misses');
  ok(
    H(base, 80, 50) === 1 && H(base, 190, 50) === -1,
    'the un-sliced base keeps its native answers',
  );
  const ids = I.fillHits(inst, 190, 50).join();
  ok(ids === '1', 'fillHits maps the same way (' + ids + ')');
  ok(I.fillHitId(inst, 190, 50) === 'R', 'fillHitId names the shape');
  const m = I.fillHitShape(inst, 190, 50, { worldMatrix: [2, 0, 0, 0, 2, 0, 0, 0, 1] });
  ok(
    m === -1 && I.fillHitShape(inst, 380, 100, { worldMatrix: [2, 0, 0, 0, 2, 0, 0, 0, 1] }) === 1,
    'a worldMatrix is inverted first, then the cut table (pixel 380 = sliced x 190)',
  );
  // in place, and restored
  const b2 = await bun(
    doc(
      '<rect id="L" x="0" y="0" width="25" height="100"/><rect id="R" x="75" y="0" width="25" height="100"/>',
    ),
  );
  b2.applyNineSlice({ border: [25, 25, 25, 25], worldSize: [200, 100] });
  ok(H(b2, 190, 50) === 1, 'applyNineSlice in place maps too');
  b2.applyNineSlice({ border: [0, 0, 0, 0], worldSize: [200, 100] });
  ok(
    H(b2, 190, 50) === -1 && H(b2, 80, 50) === 1,
    'a zero border restores the native hit geometry',
  );
  // a corner cell and a non-zero origin frame
  const b3 = await bun(
    doc(
      '<rect id="a" x="10" y="20" width="10" height="10"/><rect id="z" x="90" y="90" width="10" height="10"/>',
    ),
  );
  const i3 = b3.nineSliceInstance({
    border: [20, 20, 20, 20],
    worldSize: [300, 300],
    nativeBBox: [10, 20, 100, 100],
  });
  ok(H(i3, 15, 25) === 0, 'a corner shape is pinned at the frame origin (nativeBBox [10,20,..])');
});

// ── the submit queue ────────────────────────────────────────────
await sec('submitBundle:', async () => {
  const mk = () => {
    const seen = [];
    const R = {
      gl: new Proxy(
        {},
        { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
      ),
      opts: {},
      draw: {},
      _inFrame: false,
      _contextLost: false,
      _frameSerial: 0,
      _lastSeenW: 0,
      _lastSeenH: 0,
      _scissor: null,
      _captureFrames: false,
      _frameLog: [],
      viewportSize: () => [256, 256],
      _canvasUnsized: () => false,
      glViewport: () => {},
      glDisable: () => {},
      glEnable: () => {},
      glDepthMask: () => {},
      fillWarmTick: () => {},
      drawBundle: (t, o) => {
        seen.push({
          id: t.id,
          tx: o && o.worldMatrix ? o.worldMatrix[6] : null,
          alpha: o ? o.alpha : undefined,
          keys: o
            ? Object.keys(o)
                .filter((k) => o[k] !== undefined)
                .sort()
                .join()
            : '',
        });
      },
    };
    attachFrameLoop(R);
    return { R, seen };
  };
  {
    const { R, seen } = mk();
    R.beginFrame([0, 0, 0, 0]);
    const o = { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, -0.6, 0, 1]), alpha: 0.5 };
    R.submitBundle({ id: 'a' }, o);
    o.worldMatrix[6] = 0.6;
    delete o.alpha; // the allocation-free reuse pattern
    R.submitBundle({ id: 'b' }, o);
    const wm = [1, 0, 0, 0, 1, 0, 0.1, 0, 1];
    const o2 = { worldMatrix: wm };
    R.submitBundle({ id: 'c' }, o2);
    wm[6] = 0.9; // a plain array mutated in place
    R.endFrame();
    ok(
      seen.map((s) => s.id + ':' + s.tx.toFixed(1)).join() === 'a:-0.6,b:0.6,c:0.1',
      'each submit paints with the values it was submitted with (' +
        seen.map((s) => s.id + ':' + (+s.tx).toFixed(1)).join() +
        ')',
    );
    ok(
      seen[0].alpha === 0.5 && seen[1].alpha === undefined,
      'a key removed between submits is absent from the later entry',
    );
    ok(
      seen[0].keys === 'alpha,worldMatrix' && seen[1].keys === 'worldMatrix',
      'and an entry carries exactly its own keys (' + seen[0].keys + ' | ' + seen[1].keys + ')',
    );
    // the pool must not keep the previous entry's keys either
    R.beginFrame([0, 0, 0, 0]);
    R.submitBundle({ id: 'd' }, null);
    R.submitBundle({ id: 'e' }, { alpha: 0.25 });
    R.endFrame();
    ok(
      seen[3].keys === '' && seen[4].keys === 'alpha',
      'a pooled entry starts clean next frame (' +
        JSON.stringify(seen[3].keys) +
        ', ' +
        JSON.stringify(seen[4].keys) +
        ')',
    );
    ok(
      R._submitEntryAllocs === 3,
      'still allocation-free in steady state (entries ever created ' +
        R._submitEntryAllocs +
        ' for 3 submits a frame)',
    );
  }
  {
    const { R, seen } = mk();
    R.beginFrame([0, 0, 0, 0]);
    R.submitBundle({ id: 'mid' }, { zOrder: 100 });
    R.submitBundle({ id: 'top' }, { zOrder: Infinity });
    R.submitBundle({ id: 'low' }, { zOrder: 0 });
    R.submitBundle({ id: 'bottom' }, { zOrder: -Infinity });
    R.submitBundle({ id: 'zero' }, {});
    R.submitBundle({ id: 'null' }, { zOrder: null });
    R.submitBundle({ id: 'top2' }, { zOrder: Infinity });
    R.endFrame();
    ok(
      seen.map((s) => s.id).join() === 'bottom,low,zero,null,mid,top,top2',
      '+-Infinity are the extremes; absent / null is 0; ties keep submission order (' +
        seen.map((s) => s.id).join() +
        ')',
    );
    R.beginFrame([0, 0, 0, 0]);
    const bad = [NaN, '10', {}, true, [1]];
    const errs = bad.map((z) => {
      try {
        R.submitBundle({ id: 'x' }, { zOrder: z });
        return null;
      } catch (e) {
        return e;
      }
    });
    ok(
      errs.every((e) => e instanceof TypeError && /zOrder/.test(e.message)),
      'NaN and non-numbers throw a TypeError naming zOrder (' + (errs[0] && errs[0].message) + ')',
    );
    R.endFrame();
    ok(seen.length === 7, 'a rejected submit queues nothing');
    ok(
      throws(() => R.submitBundle({ id: 'y' }, { zOrder: NaN }), /zOrder/),
      '...also outside a frame',
    );
  }
});

// ── duplicate sprite ids ───────────────────────────────────────────────
await sec('duplicate sprite ids:', async () => {
  warns.length = 0;
  const b = await bun(
    doc(
      '<g id="a"><rect width="10" height="10"/></g><g id="b"><rect x="20" width="10" height="10"/></g><g id="a"><rect x="40" width="10" height="10"/></g>',
    ),
  );
  ok(
    JSON.stringify(b.spriteRanges) === '{"a":[0,0],"b":[1,1]}',
    'a later element reusing an id is not part of its range (' +
      JSON.stringify(b.spriteRanges) +
      ')',
  );
  ok(b.spriteRangesNonContiguous.length === 0, '...so no range swallows the sprite between');
  ok(
    warns.filter((w) => /top-level id "a"/.test(w)).length === 1,
    'one warning names the id (' + warns.length + ' warnings)',
  );
  warns.length = 0;
  const c = await bun(
    doc(
      '<g id="a"><rect width="10" height="10"/></g><g id="a"><rect x="20" width="10" height="10"/></g><g id="b"><rect x="40" width="10" height="10"/></g>',
    ),
  );
  ok(
    JSON.stringify(c.spriteRanges) === '{"a":[0,0],"b":[2,2]}',
    'adjacent duplicates (a, a, b) no longer merge into one sprite (' +
      JSON.stringify(c.spriteRanges) +
      ')',
  );
  warns.length = 0;
  const d = await bun(
    doc(
      '<g id="a"><rect width="10" height="10"/></g><g id="a"><rect x="20" width="10" height="10"/></g><g id="a"><rect x="40" width="10" height="10"/></g>',
    ),
  );
  ok(warns.length === 1, 'three uses of one id warn once (' + warns.length + ')');
  warns.length = 0;
  const e = await bun(
    doc(
      '<g id="a"><rect width="10" height="10"/></g><g id="b"><g id="a"><rect x="20" width="10" height="10"/></g></g>',
    ),
  );
  ok(
    JSON.stringify(e.spriteRanges) === '{"a":[0,0],"b":[1,1]}' && warns.length === 0,
    'an id reused INSIDE another top-level group is not a top-level sprite id: no warning, ranges as before',
  );
});

// ── chained morph ──────────────────────────────────────────────────────
await sec('morph chain:', async () => {
  const rect = (x, y, f) =>
    bun(doc(`<rect id="s" x="${x}" y="${y}" width="30" height="30" fill="${f}"/>`));
  const A = await rect(10, 10, '#c81e1e'),
    B = await rect(60, 60, '#1e1ec8'),
    C = await rect(10, 60, '#1ec81e');
  for (const cpuLerp of [true, false]) {
    const m = I.createShapeMorph(gl, A, B, { cpuLerp });
    m.setT(0.5);
    const c = I.createShapeMorph(gl, m.bundle, C, { cpuLerp });
    const at = (t) => {
      c.setT(t);
      const p = sampleMorphPose(c.bundle);
      return Array.from(p.curve.slice(8, 12));
    };
    ok(
      at(0).join() === '35,35,65,35',
      `[cpuLerp ${cpuLerp}] t=0 is the pose the source morph was at (x 35..65, not A's 10..40): ${at(0)}`,
    );
    ok(at(1).join() === '10,60,40,60', `[cpuLerp ${cpuLerp}] t=1 is the destination: ${at(1)}`);
    ok(
      at(0.5).join() === '22.5,47.5,52.5,47.5',
      `[cpuLerp ${cpuLerp}] t=.5 is half way from the pose: ${at(0.5)}`,
    );
    const pm = sampleMorphPose(c.bundle);
    c.setT(0);
    ok(
      sampleMorphPose(c.bundle).meta[4] > 0.4 && sampleMorphPose(c.bundle).meta[4] < 0.9,
      `[cpuLerp ${cpuLerp}] the paint is the pose's too (a red/blue mix, r=${sampleMorphPose(c.bundle).meta[4].toFixed(2)})`,
    );
    m.setT(1);
    c.setT(0);
    ok(
      Array.from(sampleMorphPose(c.bundle).curve.slice(8, 12)).join() === '35,35,65,35',
      `[cpuLerp ${cpuLerp}] it is a snapshot: the source morph moving on does not move the chain`,
    );
  }
  const m0 = I.createShapeMorph(gl, A, B); // t = 0: its own base pose, used as is
  const c0 = I.createShapeMorph(gl, m0.bundle, C);
  c0.setT(0);
  ok(
    Array.from(sampleMorphPose(c0.bundle).curve.slice(8, 12)).join() === '10,10,40,10',
    'a source morph at t = 0 chains from its base pose, as before',
  );
  const d = I.createShapeMorph(gl, A, B);
  d.setT(1);
  const into = I.createShapeMorph(gl, C, d.bundle);
  into.setT(1);
  ok(
    Array.from(sampleMorphPose(into.bundle).curve.slice(8, 12)).join() === '60,60,90,60',
    'as the DESTINATION, a morph at t = 1 is its destination pose (60..90)',
  );
  // unsupported: a shape that fades
  const two = await bun(doc('<rect id="s" x="10" y="10" width="30" height="30"/>'));
  const three = await bun(
    doc(
      '<rect id="s" x="10" y="10" width="30" height="30"/><rect id="extra" x="50" y="50" width="20" height="20"/>',
    ),
  );
  const fm = I.createShapeMorph(gl, two, three);
  fm.setT(0.5);
  ok(
    throws(() => I.createShapeMorph(gl, fm.bundle, C), /fade in or out/),
    'a source morph at t > 0 with a fading shape throws instead of starting from the wrong picture',
  );
  fm.setT(0);
  ok(!throws(() => I.createShapeMorph(gl, fm.bundle, C), /./), '...and at t = 0 it chains');
});

// ── streaming input ──────────────────────────────────────────────
const sline = (p) => p.map((q, i) => I.mkLine(q, p[(i + 1) % p.length]));
const smk = (light) =>
  I.createBundle(
    gl,
    I.buildStreamableSections(
      [
        [
          [10, 10],
          [40, 10],
          [40, 40],
          [10, 40],
        ],
        [
          [60, 10],
          [90, 10],
          [90, 40],
          [60, 40],
        ],
      ].map((p, i) => ({ segs: sline(p), fill: i ? [0.1, 0.1, 0.8, 1] : [0.8, 0.1, 0.1, 1] })),
      [0, 0, 100, 100],
      { lightweight: light },
    ),
  );
const sgood = [
  [
    [10, 10],
    [40, 10],
    [40, 40],
    [10, 40],
  ],
  [
    [60, 60],
    [90, 60],
    [90, 90],
    [60, 90],
  ],
];
await sec('streaming input:', async () => {
  const snap = (b) =>
    JSON.stringify([Array.from(b.globalBBox), b._geomGen, Array.from(b.metaFloats.slice(0, 96))]);
  for (const light of [false, true]) {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const b = smk(light);
      I.updateBundleGeometry(gl, b, sgood.map(sline), { lightweight: light });
      const before = snap(b);
      const p0 = [
        [10, 10],
        [bad, 10],
        [40, 40],
        [10, 40],
      ];
      let r;
      try {
        r = I.updateBundleGeometry(gl, b, [p0, sgood[1]].map(sline), { lightweight: light });
      } catch (e) {
        r = { ok: 'threw ' + e.message };
      }
      ok(
        r.ok === false && /non-finite/.test(r.reason || ''),
        `[${light ? 'lightweight' : 'full'}] ${bad} refused: ${r.reason || r.ok}`,
      );
      ok(snap(b) === before, `[${light ? 'lightweight' : 'full'}] ${bad}: the bundle is untouched`);
    }
    const b = smk(light);
    const arc = mkArc(50, 50, 10, NaN, 0, 3, 0, 0, 1);
    let r;
    try {
      r = I.updateBundleGeometry(
        gl,
        b,
        [sgood[0], [arc]].map((x, i) => (i ? x : sline(x))),
        { lightweight: light },
      );
    } catch (e) {
      r = { ok: 'threw' };
    }
    ok(
      r.ok === false,
      `[${light ? 'lightweight' : 'full'}] an arc with a NaN radius is refused too`,
    );
    const okr = I.updateBundleGeometry(gl, b, sgood.map(sline), { lightweight: light });
    ok(
      okr.ok === true,
      `[${light ? 'lightweight' : 'full'}] a valid update after a refusal is accepted`,
    );
  }
});
await sec('zero-area polygon in a lightweight stream:', async () => {
  const b = smk(true);
  const zero = [
    [10, 10],
    [40, 10],
    [40, 10],
    [10, 10],
  ];
  const diag = [
    [10, 10],
    [30, 30],
    [20, 20],
    [40, 40],
  ];
  I.updateBundleGeometry(gl, b, [zero, sgood[1]].map(sline), { lightweight: true });
  ok(
    b._lbMeshes &&
      b._lbMeshes[0] &&
      b._lbMeshes[0].slug === true &&
      b._lbMeshes[1] &&
      !b._lbMeshes[1].slug,
    'a zero-area polygon gets no analytic mesh (a sentinel); its neighbor does',
  );
  I.updateBundleGeometry(gl, b, [diag, sgood[1]].map(sline), { lightweight: true });
  ok(
    b._lbMeshes[0].slug === true,
    'a diagonal line (collinear points off the axes) is zero area too',
  );
  I.updateBundleGeometry(gl, b, sgood.map(sline), { lightweight: true });
  ok(
    b._lbMeshes[0] && !b._lbMeshes[0].slug && b._lbMeshes[0].vertexCount > 0,
    'and the shape draws again once it has area',
  );
  const thin = [
    [10, 10],
    [40, 10],
    [40, 10.001],
    [10, 10.001],
  ];
  I.updateBundleGeometry(gl, b, [thin, sgood[1]].map(sline), { lightweight: true });
  ok(b._lbMeshes[0] && !b._lbMeshes[0].slug, 'a thin sliver that has area keeps its mesh');
});

await sec('override table:', async () => {
  const b = await bun(
    doc(
      '<rect id="a" x="0" width="10" height="10"/><rect id="b" x="20" width="10" height="10"/><rect id="c" x="40" width="10" height="10"/>',
    ),
  );
  const t = I.createOverrideTable(gl, b);
  const row = (i) => Array.from(t.packedBuffer.slice(i * 24, i * 24 + 24));
  ok(
    t.set(1.5, { visibility: 0 }) === false &&
      t.set(1.0000001, { visibility: 0 }) === false &&
      row(1)[6] === 1,
    'a fractional key returns false and changes nothing',
  );
  ok(
    t.set(NaN, {}) === false &&
      t.set(-1, {}) === false &&
      t.set(3, {}) === false &&
      t.set(Infinity, {}) === false,
    'NaN, negative, out-of-range and Infinity keys return false',
  );
  ok(t.set(1, { visibility: 0 }) === true && row(1)[6] === 0, 'a valid integer key still works');
  ok(
    t.set(1.0, { visibility: 0.25 }) === true &&
      row(1)[6] === 0.25 &&
      t.set('c', { visibility: 0.5 }) === true &&
      row(2)[6] === 0.5,
    '1.0 is an integer; string ids still resolve',
  );
  ok(
    t.update(1.5, { visibility: 0 }) === false && t.get(1.5) == null,
    'update / get with a fractional key miss',
  );
  t.clearAll();
  const fill = (o) => {
    t.set(1, o);
    const r = row(1);
    t.clearAll();
    return { fill: r.slice(12, 16), stroke: r.slice(16, 20), sw: r[20], mask: r[7] };
  };
  ok(
    fill({ fill: [0.1, 0.2, 0.3, 0.4] })
      .fill.map((x) => +x.toFixed(2))
      .join() === '0.1,0.2,0.3,0.4',
    'a valid fill is stored as given',
  );
  ok(
    fill({ fill: [0, 1, 0] }).fill.join() === '0,1,0,1',
    'a short fill [0,1,0] is opaque green: the missing alpha is 1',
  );
  ok(
    fill({ fill: [NaN, 1, 0, 1] }).fill.join() === '0,1,0,1',
    'a NaN component takes its default (0 for r, g, b)',
  );
  ok(fill({ fill: [1, 0, 0, NaN] }).fill.join() === '1,0,0,1', '...and 1 for alpha');
  ok(
    fill({ fill: [1, 0, 0, Infinity] }).fill.join() === '1,0,0,1',
    'an infinite component is not finite either',
  );
  ok(
    fill({ fill: [] }).fill.join() === '0,0,0,1' && fill({ fill: [] }).mask === 1,
    'an empty list is opaque black with the override set',
  );
  ok(
    fill({ fill: 5 }).mask === 0 && fill({ fill: true }).mask === 0,
    'a non-list fill sets no override',
  );
  ok(fill({ stroke: [1, 0] }).stroke.join() === '1,0,0,1', 'stroke follows the same rule');
  ok(
    fill({ strokeWidth: 4 }).sw === 4 && fill({ strokeWidth: 4 }).mask === 4,
    'a valid strokeWidth is stored as given',
  );
  ok(
    fill({ strokeWidth: 0 }).mask === 4 &&
      fill({ strokeWidth: -5 }).sw === 0 &&
      fill({ strokeWidth: -5 }).mask === 4,
    'a negative strokeWidth is 0 (the width override stays set)',
  );
  ok(
    fill({ strokeWidth: NaN }).mask === 0 &&
      fill({ strokeWidth: Infinity }).mask === 0 &&
      fill({ strokeWidth: '4' }).mask === 0,
    'NaN, Infinity and non-numbers set no width override',
  );
  t.update(1, { fill: [1, 0] });
  ok(
    row(1).slice(12, 16).join() === '1,0,0,1',
    'update on a row without a fill: missing components take the defaults',
  );
  t.update(1, { fill: [NaN, 0.5] });
  ok(
    row(1).slice(12, 16).join() === '1,0.5,0,1',
    'update on a row WITH a fill: a missing or NaN component keeps the current value',
  );
  t.update(1, { strokeWidth: NaN });
  ok(row(1)[20] === 0 && (row(1)[7] & 4) === 0, 'update with a NaN width sets nothing');
  t.update(1, { strokeWidth: 3 });
  t.update(1, { strokeWidth: Infinity });
  ok(row(1)[20] === 3, 'update with an infinite width keeps the current width');
  t.update(1, { fill: null, strokeWidth: null });
  ok((row(1)[7] & 5) === 0, 'null still clears the override');
});

// ── the cull retire sees the mutation, not the upload ──────────────────
await sec('occlusion cull vs override change:', async () => {
  const R = I.createRenderer(gl, taggedShaderSources(), { staticUnified: true });
  if (R.ready) await R.ready;
  R.setViewport(128, 128);
  const b = await bun(
    doc(
      '<rect id="u" x="40" y="40" width="20" height="20" fill="#1e1ec8"/><rect id="o" x="10" y="10" width="80" height="80" fill="#c81e1e"/>',
    ),
  );
  const t = I.createOverrideTable(gl, b);
  const draw = () => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { overrides: t });
    R.endFrame();
  };
  const full = b.drawList;
  b.drawListUnculled = full;
  b.drawList = full.slice(1); // the state a finished cull leaves: the occluded row is not drawn
  draw();
  draw();
  draw();
  ok(b.drawList !== b.drawListUnculled, 'the cull stays active while nothing is overridden');
  ok(
    typeof t.revision === 'number' && t.generation > 0,
    'the table exposes a numeric revision next to the upload generation (' +
      t.revision +
      ', ' +
      t.generation +
      ')',
  );
  const rev = t.revision,
    gen = t.generation;
  t.set(1, { visibility: 0 });
  ok(
    t.revision > rev && t.generation === gen,
    'set() advances the revision at once; the generation waits for the upload',
  );
  draw();
  ok(
    b.drawList === b.drawListUnculled,
    'the FIRST draw after the override change has retired the cull (not a second draw)',
  );
});

// ── nine-slice vs prepareBundle ───────────────────────────────────────
await sec('prepareBundle on a nine-sliced bundle:', async () => {
  const R = I.createRenderer(gl, taggedShaderSources(), { staticUnified: true });
  if (R.ready) await R.ready;
  R.setViewport(128, 128);
  const art =
    '<rect x="0" y="0" width="100" height="100" rx="20" fill="#c81e1e"/><circle cx="50" cy="50" r="10" fill="#1e1ec8"/>';
  const b = await bun(doc(art));
  const inst = b.nineSliceInstance({ border: [25, 25, 25, 25], worldSize: [160, 100] });
  ok(
    R.prepareBundle(inst) === false && !inst._lbMeshes,
    'prepareBundle(instance) declines and builds no mesh',
  );
  const b2 = await bun(doc(art));
  b2.applyNineSlice({ border: [25, 25, 25, 25], worldSize: [160, 100] });
  ok(R.prepareBundle(b2) === false && !b2._lbMeshes, '...and so does an in-place sliced bundle');
  const b3 = await bun(doc(art));
  const prepared = R.prepareBundle(b3);
  ok(prepared === true && b3._lbMeshes, 'a plain bundle still prepares (meshes built)');
  b3.applyNineSlice({ border: [25, 25, 25, 25], worldSize: [160, 100] });
  // The fake GL never warms the unified variant, so the route itself is proven on the GPU (spriteMorphApiRenderSmoke: prepared, then sliced).
  const md = readFileSync(path.join(ROOT, 'src/renderer/morphDraw.js'), 'utf8');
  ok(
    /function _drawBundleLB\(bundle\) \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(bundle\._nineSliceActive\) return false;/.test(
      md,
    ),
    'the analytic route (_drawBundleLB) declines a nine-sliced bundle before it reads any mesh, however the meshes got there',
  );
  b3.applyNineSlice({ border: [0, 0, 0, 0], worldSize: [160, 100] });
  ok(R.prepareBundle(b3) === true, 'restored to native it prepares again');
});

// ── nine-slice option validation ──────────────────────────────────────
await sec('nine-slice options:', async () => {
  const b = await bun(doc('<rect x="0" y="0" width="100" height="100" fill="#c81e1e"/>'));
  const snap = (x) =>
    JSON.stringify([
      Array.from(x.globalBBox),
      x._nineSliceActive || false,
      x._geomGen | 0,
      x.coverQuadFloats && x.coverQuadFloats.length,
    ]);
  const before = snap(b);
  const good = { border: [25, 25, 25, 25], worldSize: [200, 100] };
  const bads = [
    ['nativeBBox [100,100,0,0]', { ...good, nativeBBox: [100, 100, 0, 0] }],
    ['nativeBBox [50,50,50,50]', { ...good, nativeBBox: [50, 50, 50, 50] }],
    ['negative border', { ...good, border: [-30, 25, 25, 25] }],
    ['Infinity border', { ...good, border: [Infinity, 25, 25, 25] }],
    ['NaN border', { ...good, border: [NaN, 25, 25, 25] }],
    ['Infinity worldSize', { ...good, worldSize: [Infinity, 100] }],
    ['NaN worldSize', { ...good, worldSize: [NaN, 100] }],
    ['string border', { ...good, border: ['25', 25, 25, 25] }],
    ['border not a list', { ...good, border: 25 }],
    ['nativeBBox with NaN', { ...good, nativeBBox: [0, 0, NaN, 100] }],
  ];
  for (const [name, o] of bads) {
    ok(
      throws(() => b.applyNineSlice(o), /nine-slice/) &&
        snap(b) === before &&
        !b._nineSliceBaseline,
      `applyNineSlice: ${name} throws, nothing mutated (not even the baseline)`,
    );
    ok(
      throws(() => b.nineSliceInstance(o), /nine-slice/),
      `nineSliceInstance: ${name} throws`,
    );
  }
  b.applyNineSlice(good);
  const active = snap(b);
  ok(
    throws(() => b.applyNineSlice(bads[2][1]), /nine-slice/) && snap(b) === active,
    'an invalid re-slice leaves the previous slice in force',
  );
  b.applyNineSlice({ border: [0, 0, 0, 0], worldSize: [200, 100] });
  ok(
    b._nineSliceActive === false && b.globalBBox.join() === '0,0,100,100',
    'a zero border restores the native frame',
  );
  b.applyNineSlice({ border: [25, 25, 25, 25], worldSize: [0, 100] });
  ok(
    b._nineSliceActive === false,
    'a worldSize of zero restores it too (collapse is not an error)',
  );
  b.applyNineSlice({ border: [25, 25, 25, 25], worldSize: [200, 100] });
  ok(
    b._nineSliceActive === true && b.globalBBox.join() === '0,0,200,100',
    'valid options are unchanged (frame 0,0,200,100)',
  );
  b.applyNineSlice({ border: [60, 25, 60, 25], worldSize: [50, 100] });
  ok(
    b.globalBBox.join() === '0,0,100,100',
    'a border sum past the frame still clamps (target width = the clamped border sum 100)',
  );
  b.applyNineSlice({});
  ok(b._nineSliceActive === false, 'empty options restore');
});

// ── group opacity ─────────────────────────────────────────────────────
await sec('group opacity in a morph:', async () => {
  const gop = (o) =>
    `<g id="g" opacity="${o}"><rect id="a" x="10" y="10" width="50" height="50" fill="#c81e1e"/><rect id="b" x="40" y="40" width="50" height="50" fill="#1e1ec8"/></g>`;
  const A = await bun(doc(gop(0.8))),
    B = await bun(doc(gop(0.2)));
  const m = I.createShapeMorph(gl, A, B, { cpuLerp: true });
  m.setT(0.5);
  const pose = sampleMorphPose(m.bundle);
  const groupRow = Array.from({ length: m.bundle.numShapes }, (_, i) => i).find(
    (i) => m.bundle.metaFloats[i * 48 + 27] & 64,
  );
  ok(
    Math.abs(pose.meta[groupRow * 48 + 7] - 0.5) < 1e-6,
    'when both poses have the group, its opacity interpolates (0.8 -> 0.2 at t=.5 is ' +
      pose.meta[groupRow * 48 + 7].toFixed(3) +
      ')',
  );
  const plain = await bun(doc(gop(1)));
  ok(
    plain.numShapes === 2,
    'opacity 1 emits NO group at all (2 rows: the two rects), so there is nothing to interpolate from',
  );
  const m2 = I.createShapeMorph(gl, plain, B, { cpuLerp: true });
  ok(
    m2.bundle.drawList.map((o) => o.kind).join() === 'groupBegin,fillShape,fillShape,groupEnd',
    'a morph from a group-less pose wraps the same shapes in the destination group (a pose without a group is a group of opacity 1)',
  );
  const ms2 = m2.bundle._morphSrc,
    gr2 = m2.bundle.drawList[0].shapeIdx,
    at2 = (t) => ms2.mergedMetaF32[gr2 * 48 + 7] * (1 - t) + ms2.dstMetaF32[gr2 * 48 + 7] * t;
  ok(
    at2(0) === 1 && Math.abs(at2(0.5) - 0.6) < 1e-6 && at2(1) === Math.fround(0.2),
    'and its opacity runs 1 -> .2 (at t=.5: ' + at2(0.5).toFixed(3) + ')',
  );
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const at = readme.indexOf('**What interpolates:**');
  const section = readme.slice(at, at + 2600);
  ok(
    at > 0 &&
      /scene group/i.test(section) &&
      /group opacity|`<g opacity>`/.test(section) &&
      /group of opacity 1/.test(section),
    'the README "What interpolates" list says how group opacity behaves, and that a pose without the group counts as opacity 1',
  );
});

await sec('Chained endpoint visibility:', async () => {
  const owned = [],
    save = (value) => {
      owned.push(value);
      return value;
    };
  const load = async (...args) => save(await bun(...args));
  const morph = (...args) => save(I.createShapeMorph(...args));
  try {
    const a = await load(doc('<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/>'));
    const ad = await load(
      doc(
        '<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/><rect id="D" x="50" y="50" width="20" height="20" fill="red"/>',
      ),
    );
    const first = morph(gl, a, ad, { cpuLerp: true });
    const visibility = (m) => m.overrides.packedBuffer[m.bundle.shapeIds.indexOf('D') * 24 + 6];
    ok(
      first.plan.dstOnly.length === 1 && visibility(first) === 0,
      'the first pose has a real invisible destination-only row',
    );
    for (const kind of ['source', 'destination', 'both']) {
      const m = morph(
        gl,
        kind === 'destination' ? ad : first.bundle,
        kind === 'source' ? ad : first.bundle,
        { cpuLerp: true },
      );
      for (const t of [0, 0.5, 1]) {
        m.setT(t);
        const expected = kind === 'source' ? t : kind === 'destination' ? 1 - t : 0;
        ok(visibility(m) === expected, kind + ' endpoint visibility at ' + t);
        for (const mode of Object.values(I.HitMode)) {
          const paintedReference = I.fillHits(ad, 60, 60, { mode }).some(
            (r) => ad.shapeIds[r] === 'D',
          );
          const actual = I.fillHits(m.bundle, 60, 60, { mode }).some(
            (r) => m.bundle.shapeIds[r] === 'D',
          );
          ok(
            actual === (expected > 0 && paintedReference),
            kind + ' ' + mode + ' endpoint hit at ' + t,
          );
        }
      }
      if (kind === 'both') {
        m.setT(0.5);
        const chain = morph(gl, m.bundle, ad, { cpuLerp: true });
        ok(
          visibility(chain) === 0,
          'a constant-hidden nonzero pose retains its visibility in a further chain',
        );
        const update = m.overrides.update;
        let writes = 0;
        m.overrides.update = (...args) => {
          writes++;
          return update(...args);
        };
        m.setT(0.75);
        ok(writes === 0, 'constant-hidden matched rows cause no per-frame override writes');
      } else {
        m.setT(0.5);
        ok(
          throws(() => morph(gl, m.bundle, ad), /fade in or out/),
          'a changing matched visibility is an unsnapshotable intermediate fade',
        );
      }
    }
    const covered = await load(
      doc(
        '<rect id="A" x="10" y="10" width="30" height="30" fill="blue"/><rect id="D" x="0" y="0" width="80" height="80" fill="red"/>',
      ),
    );
    const covering = morph(gl, a, covered, { cpuLerp: true });
    const hiddenCover = morph(gl, covering.bundle, covering.bundle, { cpuLerp: true });
    while (hiddenCover.bundle._morphCullPending)
      await new Promise((resolve) => setTimeout(resolve, 10));
    ok(
      visibility(hiddenCover) === 0 &&
        !(hiddenCover.bundle._culledShapes || new Set()).has(
          hiddenCover.bundle.shapeIds.indexOf('A'),
        ),
      'a constant-hidden matching row cannot occlude a visible row',
    );
    for (const side of ['source', 'destination'])
      for (const visibility of [0, 0.7]) {
        const m = morph(gl, a, a);
        m.setT(0.5);
        m.overrides.set(0, { visibility });
        ok(
          throws(
            () =>
              morph(gl, side === 'source' ? m.bundle : a, side === 'destination' ? m.bundle : a),
            /overrides a chained morph cannot snapshot/,
          ),
          side + ' nonzero user visibility is rejected',
        );
      }
    const neutral = morph(gl, a, a);
    ok(
      !neutral.bundle._morphSrc.initialHiddenRows && !neutral.plan.endpointVisibilityPairs,
      'a neutral endpoint allocates no visibility Set or pair array',
    );
    neutral.overrides.set(0, { localPosition: [3, 0] });
    ok(
      throws(() => morph(gl, neutral.bundle, a), /overrides a chained morph cannot snapshot/),
      'an arbitrary user transform is rejected rather than lost',
    );
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) owned[i].dispose();
  }
});

if (fail) {
  console.error('\n' + fail + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nspriteMorphApiSmoke: the sprite / nine-slice / morph / streaming / override API fixes hold',
);
