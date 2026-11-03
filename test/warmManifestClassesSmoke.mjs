// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmManifestClassesSmoke -- the warm manifest on the real renderer, on the driver model. CPU only.
//
// A manifest recorded through two viewport classes lists every class that bound a key (format minor 2); listing only the first would make a game read "needed at this class alone" and pause the
// second class's programs in play. An older manifest's class is not read, so its keys are needed at any size. Also: bundles added to a manifest scene are warmed; under a frame capture pipelines are
// built; a cancel in release mode leaves no linked programs alive; a world map below about 5e-5 is recorded as itself, not a zero map (no scale-dependent tolerance).
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
import { attachWarmManifest, warmStateOf } from '../src/renderer/warmManifest.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = 60000; // (each wait ends on its condition; only the defect reaches this)
const until = async (f) => {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < DEADLINE) await sleep(2);
  return !!f();
};
const clsOf = (w, h) => Math.round(4 * Math.log2(Math.max(1, Math.sqrt(w * h))));
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? '<defs>' + defs + '</defs>' : ''}${body}</svg>`;
const SRC = {
  bg: doc('<rect x="0" y="0" width="100" height="100" fill="#234"/>'),
  fill: doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>'),
  gradient: doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/>',
    '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  ),
  mask: doc(
    '<g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#0a3"/></g>',
    '<mask id="m"><circle cx="40" cy="50" r="25" fill="#fff"/><circle cx="62" cy="50" r="22" fill="#888"/></mask>',
  ),
  stroke: doc(
    '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
  ),
  quad: doc('<path d="M10 80 Q 50 0 90 80 Z" fill="#a40"/>'),
};
const sections = {};
for (const [k, s] of Object.entries(SRC))
  sections[k] = await importSvg(s, { preserveViewport: true });
const strictOpts = {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacPoints: false,
  gpuShedMs: 40,
  standIns: true,
  needMissPolicy: 'defer',
};
async function mk(extra = {}, link = 5, pipe = 5) {
  const W = createPendingGl({ linkMs: link, pipelineMs: pipe });
  const R = createRenderer(W.gl, taggedShaderSources(), { ...strictOpts, ...extra });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 10);
  await R.ready;
  R.setViewport(128, 128);
  return { W, R };
}
const bundlesOf = (W, keys) => keys.map((k) => createBundle(W.gl, sections[k]));
const frame = (R, bs, st) => {
  R.beginFrame([1, 1, 1, 1]);
  for (const b of bs) R.drawBundle(b, st);
  R.endFrame();
};
const vcsOf = (e) => e.vcs || [];
const SET = ['bg', 'fill', 'gradient', 'mask', 'stroke', 'quad'];
const ROT = { worldMatrix: new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]) };
async function rec(sizes, opts, rotatedAtLast, set = SET) {
  const { W, R } = await mk({ recordWarmManifest: true, ...opts });
  const bs = bundlesOf(W, set);
  R.setViewport(sizes[0], sizes[0]);
  await R.precompileFillsAsync({});
  for (const s of sizes) {
    R.setViewport(s, s);
    for (let i = 0; i < 3; i++) {
      frame(R, bs, {});
      await sleep(3);
    }
    if (rotatedAtLast && s === sizes[sizes.length - 1])
      for (let i = 0; i < 3; i++) {
        frame(R, bs, ROT);
        await sleep(3);
      }
  }
  const m = R.exportWarmManifest();
  R.dispose();
  return m;
}

console.log(
  '(classes) a game at the second size of a recording needs what a session at that size binds',
);
for (const [title, small, big, opts, rotated] of [
  ['the size changes the engine', 64, 2048, { aacFill: 'auto', standIns: false }, false],
  ['a new state at the second size', 128, 512, {}, true],
]) {
  const truth = await rec([big], opts, rotated),
    through = await rec([small, big], opts, rotated);
  ok(
    through.minor === 2 &&
      through.variants.every((v) => Array.isArray(v.vcs) && v.vcs.length && !('vc' in v)),
    `${title}: minor 2, every variant lists its classes`,
  );
  ok(
    through.variants.some(
      (v) => vcsOf(v).includes(clsOf(small, small)) && vcsOf(v).includes(clsOf(big, big)),
    ),
    `${title}: a key bound at both sizes lists both (${through.variants.map((v) => vcsOf(v).join('+')).join(' ')})`,
  );
  ok(
    through.pipelines.every((p) => p.vc === undefined),
    `${title}: no pipeline carries the old field`,
  );
  const { W, R } = await mk(opts);
  R.warm.setInference(false);
  R.warm.add('game', { manifest: through });
  const r = await R.warm.gameStart('game', { viewport: [big, big] });
  const need = R.warm._ctx().needed,
    keys = truth.variants.map((v) => v.k),
    missing = keys.filter((k) => !need.has(k));
  ok(
    !r.timeout && missing.length === 0,
    `${title}: of the ${keys.length} keys a ${big} session binds, ${missing.length} are paused (needed ${r.needed})`,
  );
  const onlySmall = through.variants.filter((v) => !vcsOf(v).includes(clsOf(big, big)));
  ok(
    onlySmall.every((v) => !need.has(v.k)),
    `${title}: a key bound only at the other size stays paused (${onlySmall.length})`,
  );
  const st = R.warm
    ._items('game')
    .filter((i) => keys.includes(i.kfull))
    .map((i) => i.st);
  ok(
    st.length > 0 && st.every((s) => s === 'done'),
    `${title}: they were warmed in the window (${[...new Set(st)].join()})`,
  );
  R.warm.gameEnd();
  R.dispose();
}
console.log(
  '(classes) a recording under the default policy of a strict renderer records the program each draw wanted',
);
{
  // Stand-in-free is the default: no draw binds a stand-in, so what a session records is what a session at that size binds. (With { standIns: true } a draw binds the net and the
  // recording holds the net, which is why a recording session keeps the default.)
  const defaults = { aacFill: 'auto', standIns: undefined, needMissPolicy: undefined };
  const truth = await rec([2048], defaults, false),
    through = await rec([64, 2048], defaults, false);
  const held = new Set(through.variants.map((v) => v.k)),
    absent = truth.variants.filter((v) => !held.has(v.k));
  ok(
    truth.variants.length > 0 && absent.length === 0,
    `of the ${truth.variants.length} keys a 2048 session binds, ${absent.length} are absent from a 64-to-2048 recording`,
  );
}
console.log(
  '(classes) older manifests stay readable: a key of a minor below 2 is needed at any size',
);
{
  const through = await rec([128, 512], {}, true);
  const asOld = JSON.parse(JSON.stringify(through));
  const c128 = clsOf(128, 128);
  asOld.minor = 1;
  for (const list of [asOld.variants, asOld.pipelines])
    for (const e of list) {
      if (e.vcs) {
        e.vc = e.vcs[0];
        delete e.vcs;
      }
    }
  const noMinor = JSON.parse(JSON.stringify(asOld));
  delete noMinor.minor;
  for (const list of [noMinor.variants, noMinor.pipelines]) for (const e of list) delete e.vc;
  for (const [title, m] of [
    ['minor 1 through two classes', asOld],
    ['no minor and no classes', noMinor],
  ]) {
    const { R } = await mk();
    R.warm.setInference(false);
    R.warm.add('game', { manifest: m });
    const r = await R.warm.gameStart('game', { viewport: [128, 128] });
    const need = R.warm._ctx().needed;
    ok(
      R.warm.status().scenes.game.manifest === 'ok' &&
        !r.timeout &&
        m.variants.every((v) => need.has(v.k)),
      `${title}: read, and every key is needed at class ${c128} (${need.size} of ${m.variants.length})`,
    );
    R.warm.gameEnd();
    R.dispose();
  }
}

console.log(
  '(late scene) on the real renderer: a manifest added after gameStart links in play and builds nothing',
);
{
  const m = await rec([128], {}, false, ['bg', 'fill', 'gradient']);
  const { W, R } = await mk();
  R.warm.setInference(false);
  await R.warm.gameStart('game', { viewport: [128, 128] });
  const l0 = W.model.links,
    p0 = W.model.pipelines;
  R.warm.add('game', { manifest: m });
  const done = () =>
    R.warm
      ._items('game')
      .filter((i) => i.kind === 'link')
      .every((i) => i.st === 'done');
  ok(await until(done), `its programs linked (${W.model.links - l0})`);
  ok(W.model.pipelines === p0, `no pipeline was built in play (${W.model.pipelines - p0})`);
  R.dispose();
}

console.log(
  '(bundles on a manifest scene) warmed, in their recorded states when the manifest knows them',
);
{
  const m = await rec([128], {}, false, ['bg', 'fill']);
  {
    const { W, R } = await mk();
    R.warm.setInference(false);
    R.warm.window(true);
    const extra = bundlesOf(W, ['mask'])[0],
      key = R._policy.keyOfBundle(extra);
    const res = await R.warm.add('s', { manifest: m, bundles: [extra] }).ready;
    const items = R.warm._items('s');
    ok(
      res.source === 'manifest' &&
        items.some((i) => i.kind === 'bundle') &&
        items.some((i) => i.kfull === key),
      `a bundle the manifest does not know joins the scene (source ${res.source}, ${items.filter((i) => i.kind === 'bundle').length} bundle items)`,
    );
    ok(
      R._policy.has(key) && R._policy.coverage(key) === 'warmed',
      `its program is warmed (${R._policy.coverage(key)})`,
    );
    ok(
      m.pipelines.every((p) => items.some((i) => i.kind === 'pipe' && i.kfull === p.k)),
      "the manifest's own pipelines are still there",
    );
    R.dispose();
  }
  {
    const { W, R } = await mk();
    R.warm.setInference(false);
    R.warm.window(true);
    const known = bundlesOf(W, ['fill'])[0],
      wm = R._policy.wmKeyOf(known);
    ok(
      Array.isArray(m.entries[wm]) && m.entries[wm].length > 0,
      `the manifest records this bundle (${m.entries[wm].length} states)`,
    );
    await R.warm.add('s', { manifest: m, bundles: [known] }).ready;
    const items = R.warm._items('s');
    const replays = items.filter((i) => i.kind === 'bundle').length,
      sizes = 1 + m.scales.length; // (the canvas as it is, and each recorded size)
    ok(
      replays === m.entries[wm].length * sizes,
      `a known bundle replays its recorded states and no others (${replays}: ${m.entries[wm].length} at ${sizes} sizes)`,
    );
    ok(
      !items.some(
        (i) =>
          i.kind === 'link' &&
          !m.variants.some((v) => v.k === i.kfull) &&
          !m.pipelines.some((p) => p.k === i.kfull),
      ),
      'and adds no key the record lacks',
    );
    R.dispose();
    const { W: W2, R: R2 } = await mk();
    R2.warm.setInference(false);
    R2.warm.window(true);
    const never = JSON.parse(JSON.stringify(m));
    const b2 = bundlesOf(W2, ['fill'])[0];
    never.entries[R2._policy.wmKeyOf(b2)] = [];
    await R2.warm.add('s', { manifest: never, bundles: [b2] }).ready;
    ok(
      !R2.warm._items('s').some((i) => i.kind === 'bundle'),
      'a bundle recorded as never drawn builds nothing',
    );
    R2.dispose();
  }
}

console.log(
  '(a capture) the queue builds under a frame capture, and the capture records none of it',
);
{
  const m = await rec([128], {}, false, ['bg', 'fill', 'gradient']);
  for (const captureFrames of [false, true]) {
    const { W, R } = await mk({ captureFrames }, 1, 1);
    R.warm.setInference(false);
    R.warm.add('s', { manifest: m });
    const p0 = W.model.pipelines;
    const r = await R.warm.focus('s', { timeoutMs: DEADLINE });
    ok(
      r.state === 'done' && r.built > 0 && W.model.pipelines - p0 >= r.built,
      `captureFrames ${captureFrames}: ${r.state}, built ${r.built}, GPU pipelines ${W.model.pipelines - p0}`,
    );
    ok(R.frameCaptureEnabled === captureFrames, 'the capture setting is as it was');
    R.dispose();
  }
}

console.log(
  '(release) on the real renderer: a cancel deletes the linked programs, and a later scene starts them again',
);
{
  const m = await rec([128], {}, false, ['bg', 'fill', 'gradient']);
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  let deleted = 0;
  const dp = W.gl.deleteProgram.bind(W.gl);
  W.gl.deleteProgram = (p) => {
    if (p) deleted++;
    return dp(p);
  };
  const R = createRenderer(W.gl, taggedShaderSources(), { ...strictOpts, warmQueueRelease: true });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 10);
  await R.ready;
  R.setViewport(128, 128);
  R.warm.setInference(false);
  R.warm.add('s', { manifest: m });
  await R.warm.gameStart('s', { viewport: [128, 128], timeoutMs: 1 }); // (past the deadline: in play, links only, no pipeline)
  const links = () => R.warm._items('s').filter((i) => i.kind === 'link');
  await until(() => links().every((i) => i.st === 'done'));
  const keys = links().map((i) => i.kfull);
  ok(
    keys.length > 0 && keys.every((k) => R._policy.has(k)),
    `the links finished and their programs are held (${keys.length})`,
  );
  const d0 = deleted,
    l0 = W.model.links;
  R.warm.cancel('s');
  ok(
    keys.every((k) => !R._policy.has(k)),
    `the cancel released them (${keys.filter((k) => !R._policy.has(k)).length} of ${keys.length})`,
  );
  ok(
    await until(() => deleted - d0 >= keys.length),
    `and their programs were deleted (${deleted - d0})`,
  );
  R.warm.gameEnd();
  R.warm.window(true);
  const r = await R.warm.add('s2', { manifest: m }).ready;
  ok(
    r.state === 'done' && r.built > 0 && W.model.links > l0,
    `a dropped key is not "done" for a later scene: linked ${W.model.links - l0} and built ${r.built} again`,
  );
  R.dispose();
}

console.log('(any scale) a recorded world map keeps its scale and rotation');
{
  const record = (s, inst) => {
    const world = new Float32Array([0.8 * s, 0.6 * s, 0, -0.6 * s, 0.8 * s, 0, 3 * s, 4 * s, 1]);
    const Q = {
      opts: { recordWarmManifest: true },
      shaderSources: {},
      draw: { worldM: world },
      viewportSize: () => [512, 512],
    };
    attachWarmManifest(Q);
    const bundle = { curveFloats: new Float32Array([1, 2, 3, 4]), numShapes: 1 };
    Q._handle = { bundle };
    if (inst) Q._wmNoteInst(bundle, [{ worldMatrix: world }]);
    else Q._wmNote();
    return Object.values(Q.exportWarmManifest().entries)[0][0];
  };
  const one = record(1);
  ok(
    JSON.stringify(one.w) === JSON.stringify([0.8, 0.6, -0.6, 0.8, 3, 4]),
    `scale 1 is as before (${JSON.stringify(one.w)})`,
  );
  for (const s of [1e4, 1, 1e-2, 2e-4, 5e-5, 2e-5, 1e-8, 1e-20, 1e-30]) {
    const sig = record(s),
      st = warmStateOf(sig),
      got = Math.hypot(st.world[0], st.world[1]);
    const tilt = Math.atan2(st.world[1], st.world[0]),
      want = Math.atan2(0.6, 0.8);
    ok(
      Math.abs(got / s - 1) < 1e-3 && Math.abs(tilt - want) < 1e-3,
      `scale ${s}: replays |scale| ${got.toPrecision(5)}, rotation ${tilt.toFixed(4)} (asked ${want.toFixed(4)})`,
    );
    ok(
      Math.abs(st.world[6] / (3 * s) - 1) < 1e-3,
      `scale ${s}: the translation scales with it (${st.world[6].toPrecision(5)})`,
    );
  }
  for (const s of [1, 1e-7, 1e-20]) {
    const sig = record(s, true);
    ok(
      sig.w[1] !== 0 && sig.w[2] !== 0,
      `an instanced draw at scale ${s} records the rotated instance (${JSON.stringify(sig.w.slice(0, 4))})`,
    );
  }
  const classes = [1, 1e-2, 1e-5, 1e-8].map((s) => {
    const Q = {
      opts: { recordWarmManifest: true },
      shaderSources: {},
      draw: { worldM: new Float32Array([s, 0, 0, 0, s, 0, 0, 0, 1]) },
      viewportSize: () => [512, 512],
    };
    attachWarmManifest(Q);
    const b = { curveFloats: new Float32Array([1, 2, 3, 4]), numShapes: 1 };
    Q._handle = { bundle: b };
    Q._wmNote();
    return Object.values(Q.exportWarmManifest().entries)[0][0].w[0];
  });
  ok(
    new Set(classes).size === 4 && classes.every((x) => x > 0),
    `distinct scales stay distinct (${JSON.stringify(classes)})`,
  );
}

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
