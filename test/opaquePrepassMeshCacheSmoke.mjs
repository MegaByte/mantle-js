// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// opaquePrepassMeshCacheSmoke -- the opaque prepass keeps one depth mesh per bundle, so a frame that draws several bundles with a prepass plan
// uploads no plan once each bundle has its mesh. Node, fake GL, the cover pass (Loop-Blinn off), 512 px, bundles of overlapping opaque blobs
// whose plans are built synchronously (occupancyGrid { grid: 24 }):
//   working set   twelve bundles drawn in every frame (more than the bound of one idle mesh, and than the renderer's transient handles): every
//                 frame after the first runs twelve prepasses and uploads no plan; the 'fillStream' bytes are the twelve plans exactly;
//   one bundle    a scene of one bundle holds exactly one plan's bytes, as when every bundle shared one buffer; a shrunken scene returns to it
//                 two frames later; draws outside any frame are held to the bound alone;
//   lifecycle     a rebuilt plan replaces its bundle's mesh (one upload, no bytes added), a disposed bundle's mesh is freed with it, and a
//                 disposed renderer frees every mesh;
//   budget        the memory budget evicts idle meshes ('opaquePrepass' in the eviction order), never one the current frame drew, and refuses
//                 a mesh that does not fit (the prepass is then not drawn), with one warning.
// The output does not depend on the prepass (it writes depth only); opaquePrepassSmoke and opaquePrepassShapeCountSmoke hold the pixels.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const warnings = [];
console.warn = (...a) => {
  warnings.push(a.join(' '));
};
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const { EVICTION_ORDER } = await import('../src/renderer/memoryLedger.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N = 512;
const blob = (x, y, c) =>
  `<path fill="${c}" d="M ${x - 120} ${y} C ${x - 120} ${y - 150} ${x + 120} ${y - 150} ${x + 120} ${y} C ${x + 120} ${y + 150} ${x - 120} ${y + 150} ${x - 120} ${y} Z"/>`;
const svgOf = (k) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">` +
  Array.from({ length: 12 }, (_, i) =>
    blob(
      256 + ((i + k) % 3) * 9,
      256 + ((i + k) % 4) * 7,
      `hsl(${(i * 29 + k * 13) % 360},65%,48%)`,
    ),
  ).join('') +
  '</svg>';

async function make(opts = {}) {
  const F = createFakeGl({ width: N, height: N });
  const gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), { aacPoints: false, ...opts });
  if (R.ready) await R.ready;
  R.setViewport(N, N);
  R.setLoopBlinnFill('off'); // the cover pass, where the prepass lives
  const bundles = [];
  const add = async (k) => {
    const b = createBundle(
      gl,
      await importSvg(svgOf(k), { preserveViewport: true, occupancyGrid: { grid: 24 } }),
    );
    while (b._occlusionCullPending || b._occupancyBuildPending) await sleep(5); // (the plan is final once both have landed)
    bundles.push(b);
    return b;
  };
  // Plan uploads are recognized by their data: a bundle's cached plan vertices.
  const count = { planUploads: 0, buffers: 0 };
  const bd = gl.bufferData;
  gl.bufferData = function (t, d, ...r) {
    for (const b of bundles)
      if (b._opaquePrepassPlan && b._opaquePrepassPlan.verts === d) count.planUploads++;
    return bd.call(this, t, d, ...r);
  };
  const cb = gl.createBuffer;
  gl.createBuffer = function (...a) {
    count.buffers++;
    return cb.apply(this, a);
  };
  const prepasses = () => R.debugStats.opaquePrepassCount | 0;
  /** One frame drawing `list` (bundles); returns its prepasses, plan uploads and created buffers. */
  const frame = (list, between) => {
    count.planUploads = count.buffers = 0;
    const p0 = prepasses();
    R.beginFrame([1, 1, 1, 1]);
    for (const b of list) R.drawBundle(b, {});
    if (between) between();
    R.endFrame();
    return { prepasses: prepasses() - p0, planUploads: count.planUploads, buffers: count.buffers };
  };
  const fillStream = () => {
    const c = R.getMemoryStats({ bundles: false }).gpu.byCategory.fillStream;
    return c ? c.bytes : 0;
  };
  const planBytes = (b) => b._opaquePrepassPlan.verts.byteLength;
  return { F, gl, R, bundles, add, frame, fillStream, planBytes, count, prepasses };
}

const K = 12;

{
  console.log('\n  precondition: the prepass is the only fillStream allocation of this scene');
  const c = await make({ opaquePrepass: false });
  for (let k = 0; k < 3; k++) await c.add(k);
  c.frame(c.bundles);
  c.frame(c.bundles);
  ok(c.fillStream() === 0, `opaquePrepass:false holds no fillStream bytes (${c.fillStream()})`);
  c.R.dispose();
}

{
  console.log('\n  working set:');
  const s = await make();
  for (let k = 0; k < K; k++) await s.add(k);
  const first = s.frame(s.bundles);
  ok(
    first.prepasses === K &&
      s.bundles.every((b) => b._opaquePrepassPlan && b._opaquePrepassPlan.verts),
    `every bundle has a plan and the first frame runs ${K} prepasses (${first.prepasses})`,
  );
  const steady = [];
  for (let i = 0; i < 6; i++) steady.push(s.frame(s.bundles));
  ok(
    steady.every((f) => f.prepasses === K),
    `each later frame runs ${K} prepasses (${steady.map((f) => f.prepasses).join(',')})`,
  );
  ok(
    steady.every((f) => f.planUploads === 0),
    `...and uploads no plan (${steady.map((f) => f.planUploads).join(',')} plan uploads per frame)`,
  );
  const sum = s.bundles.reduce((n, b) => n + s.planBytes(b), 0);
  ok(
    s.fillStream() === sum,
    `the meshes hold the ${K} plans exactly (${s.fillStream()} == ${sum})`,
  );

  console.log('\n  one bundle:');
  const one = s.bundles[0];
  s.frame([one]);
  s.frame([one]);
  ok(
    s.fillStream() === s.planBytes(one),
    `two frames after the scene shrinks to one bundle, one plan's bytes remain (${s.fillStream()} == ${s.planBytes(one)})`,
  );
  const again = s.frame([one]);
  ok(
    again.prepasses === 1 && again.planUploads === 0,
    'and that bundle draws on without an upload',
  );

  console.log('\n  lifecycle:');
  one._cullGen = (one._cullGen | 0) + 1; // the cull moved: the next draw rebuilds the plan
  const rebuilt = s.frame([one]);
  ok(
    rebuilt.prepasses === 1 && rebuilt.planUploads === 1 && s.fillStream() === s.planBytes(one),
    `a rebuilt plan replaces its bundle's mesh: one upload, one plan's bytes (${rebuilt.planUploads}, ${s.fillStream()})`,
  );
  one.dispose();
  ok(s.fillStream() === 0, `disposing the bundle frees its mesh (${s.fillStream()} bytes left)`);
  const two = s.bundles.slice(1, 3);
  s.frame(two);
  s.frame(two);
  const held = s.fillStream();
  s.R.dispose();
  ok(
    held > 0 && s.fillStream() === 0,
    `disposing the renderer frees every mesh (${held} -> ${s.fillStream()})`,
  );
  for (const b of s.bundles.slice(1)) b.dispose();
}

{
  console.log('\n  one bundle on a fresh renderer:');
  const s = await make();
  const b = await s.add(0);
  const f1 = s.frame([b]);
  const f2 = s.frame([b]);
  ok(
    f1.prepasses === 1 && f1.planUploads === 1 && f2.prepasses === 1 && f2.planUploads === 0,
    `one bundle uploads its plan once (${f1.planUploads}, then ${f2.planUploads})`,
  );
  ok(s.fillStream() === s.planBytes(b), `and holds one plan's bytes (${s.fillStream()})`);
  s.R.dispose();
  b.dispose();
}

{
  console.log('\n  draws outside any frame (beginFrame never called):');
  const s = await make();
  for (let k = 0; k < 3; k++) await s.add(k);
  let peak = 0,
    ran = 0;
  for (let round = 0; round < 3; round++)
    for (const x of s.bundles) {
      const p0 = s.prepasses();
      s.R.drawBundle(x, {});
      ran += s.prepasses() - p0;
      peak = Math.max(peak, s.fillStream());
    }
  const maxPlan = Math.max(...s.bundles.map((x) => s.planBytes(x)));
  ok(ran === 9, `every draw runs the prepass (${ran} of 9)`);
  ok(peak <= maxPlan, `the bound alone holds: at most one mesh (${peak} <= ${maxPlan})`);
  s.R.dispose();
  for (const x of s.bundles) x.dispose();
}

{
  // A mount's draw raises the renderer's draw flag without opening a frame, so it must not count as a frame's working set either.
  console.log('\n  mount draws outside any frame (createBundleHandle, beginFrame never called):');
  const s = await make();
  for (let k = 0; k < 3; k++) await s.add(k);
  const handles = s.bundles.map((x) => s.R.createBundleHandle(x));
  let peak = 0,
    ran = 0;
  for (let round = 0; round < 3; round++)
    for (const h of handles) {
      const p0 = s.prepasses();
      h.draw({});
      ran += s.prepasses() - p0;
      peak = Math.max(peak, s.fillStream());
    }
  const maxPlan = Math.max(...s.bundles.map((x) => s.planBytes(x)));
  ok(ran === 9, `every mount draw runs the prepass (${ran} of 9)`);
  ok(
    peak <= maxPlan,
    `the bound alone holds for mount draws: at most one mesh (${peak} <= ${maxPlan})`,
  );
  for (const h of handles) h.dispose && h.dispose();
  s.R.dispose();
  for (const x of s.bundles) x.dispose();
}

{
  console.log('\n  memory budget:');
  ok(
    EVICTION_ORDER.includes('opaquePrepass'),
    `'opaquePrepass' is a stage of the eviction order (${EVICTION_ORDER.join(', ')})`,
  );
  const s = await make();
  for (let k = 0; k < 6; k++) await s.add(k);
  s.frame(s.bundles);
  s.frame(s.bundles);
  const half = s.bundles.slice(0, 3);
  const plan0 = s.planBytes(s.bundles[0]);
  // Inside a frame that drew half the scene, a budget that wants every byte back evicts only the other half's meshes.
  let mid = null;
  s.frame(half, () => {
    const L0 = s.R.getMemoryStats({ bundles: false }).gpu.totalBytes;
    s.R.setMemoryBudget(L0 - 1);
    mid = {
      bytes: s.fillStream(),
      kept: half.reduce((n, b) => n + s.planBytes(b), 0),
      ev: s.R.getMemoryStats({ bundles: false }).policy.evictions.opaquePrepass,
    };
  });
  ok(
    mid && mid.ev && mid.ev.count > 0 && mid.ev.bytes >= plan0,
    `the budget evicted prepass meshes (${JSON.stringify(mid && mid.ev)})`,
  );
  ok(
    mid && mid.bytes >= mid.kept,
    `...never one the current frame drew (${mid && mid.bytes} >= ${mid && mid.kept})`,
  );
  s.R.setMemoryBudget(null);
  const back = s.frame(half);
  ok(back.prepasses === 3 && back.planUploads === 0, 'the kept meshes draw on without an upload');
  // Between frames nothing is in use: a budget below the meshes frees them all, and one that cannot hold a mesh refuses it.
  s.frame([s.bundles[0]]);
  const before = s.fillStream();
  const total = s.R.getMemoryStats({ bundles: false }).gpu.totalBytes;
  warnings.length = 0;
  s.R.setMemoryBudget(total - before + Math.floor(plan0 / 2));
  ok(
    s.fillStream() === 0,
    `between frames every idle mesh is evictable (${before} -> ${s.fillStream()})`,
  );
  const refused = s.frame([s.bundles[0]]);
  const st = s.R.getMemoryStats({ bundles: false });
  const r = st.policy.refusals['opaque prepass mesh'];
  ok(
    refused.prepasses === 0 && r && r.count >= 1 && s.fillStream() === 0,
    `a mesh the budget cannot hold is refused and the prepass is not drawn (${JSON.stringify(r)}, ${refused.prepasses} prepasses)`,
  );
  s.frame([s.bundles[0]]);
  ok(
    warnings.filter((w) => /opaque prepass mesh/.test(w)).length === 1,
    `with one warning (${warnings.filter((w) => /opaque prepass mesh/.test(w)).length})`,
  );
  ok(st.policy.overBudgetBytes === 0, `the budget holds (${st.policy.overBudgetBytes} bytes over)`);
  s.R.setMemoryBudget(null);
  const after = s.frame([s.bundles[0]]);
  ok(
    after.prepasses === 1 && after.planUploads === 1,
    'with the budget lifted the prepass runs again',
  );
  s.R.dispose();
  for (const b of s.bundles) b.dispose();
}

if (fail) {
  console.log(`opaquePrepassMeshCacheSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('opaquePrepassMeshCacheSmoke: ok');
