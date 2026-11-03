// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmQueueGameContextSmoke -- a game on the warm queue, against a scripted executor: the queue's own state machine, no GL.
//
// Pinned: a scene added after gameStart is warmed, not left paused while the promise says warm; gameStart(B) over A opens its own window and answers with B's load; past a gameStart deadline no
// pipelines build in play; focus with a game does not wait for items the game paused, nor gameStart for a shared key in a scene the focus paused; one game's `needed` and `declaredNeeds` do not
// carry into the next; a `needed` key no scene holds still links; idle() settles during a game; a pipeline item that keeps answering 'wait' does not hold up everything behind it; a blocking drain
// does not take the scan limit for 'nothing to do'; gameStart with no viewport honors an earlier onResize; a cancel in release mode leaves no linked programs alive.
import { attachWarmQueue } from '../src/renderer/warmQueue.js';
import { attachWarmManifest } from '../src/renderer/warmManifest.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = 60000; // (each wait ends on its condition; only the defect reaches this)
const race = (p, ms = DEADLINE) =>
  Promise.race([
    p.then((v) => ({ resolved: true, v })),
    sleep(ms).then(() => ({ resolved: false })),
  ]);
const until = async (f) => {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < DEADLINE) await sleep(2);
  return !!f();
};
const VP = [512, 512],
  cls = (w, h) => Math.round(4 * Math.log2(Math.sqrt(w * h)));
function mkQ(o = {}) {
  const log = { link: [], pipe: [], release: [], declared: [] };
  const linked = new Map(),
    built = new Set();
  const ex = {
    has: (k) => linked.has(k),
    link: (k) => {
      log.link.push(k);
      linked.set(k, 'ready');
      return true;
    },
    linked: (k) => linked.get(k) || 'failed',
    built: (k) => built.has(k),
    pipeline: (it) => {
      log.pipe.push(it.k);
      built.add(it.k);
      return 'built';
    },
    bundle: () => 'built',
    release: (k, dropped) => {
      log.release.push([k, !!dropped]);
      return true;
    },
    keyOfBundle: () => null,
    exhaustiveStates: () => [null],
    ...(o.ex || {}),
  };
  const Q = {
    opts: o.opts || {},
    shaderSources: { fillVert: 'v', fillFrag: 'f' },
    _wq: ex,
    _idleNow: () => false,
    _gpuClear: () => true,
    _setDeclaredNeeds: (m) => {
      log.declared.push(m);
      return true;
    },
    ...(o.R || {}),
  };
  attachWarmManifest(Q);
  const warm = attachWarmQueue(Q, (b) => b);
  warm.setInference(false);
  const manifest = (keys, vcs) => ({
    version: 3,
    format: 3,
    minor: 2,
    shaders: Q._wmShaderHash(),
    entries: {},
    variants: keys.map((k) => ({ k, vcs })),
    pipelines: keys.map((k) => ({
      k,
      lay: [[0, 2, 0x1406, 0, 8, 0]],
      tex: true,
      inst: false,
      blend: null,
      cmask: 15,
      vcs,
    })),
    scales: [],
  });
  const pumps = async (n) => {
    const p0 = warm.status().totals.pumps;
    await until(() => warm.status().totals.pumps >= p0 + n);
  }; // (nothing moved over n whole turns of the queue, whatever the machine is doing)
  return { Q, warm, log, manifest, pumps };
}

console.log(
  '(late scene) a scene added after gameStart links in play; the start said no scene was there',
);
{
  const { warm, log, manifest, pumps } = mkQ();
  const r = await warm.gameStart('game', { viewport: VP });
  ok(
    r.state === 'unknown' && r.needed === 0,
    `gameStart with no scene settles at once and says so (${JSON.stringify(r)})`,
  );
  warm.add('game', { manifest: manifest(['A', 'B', 'C']) });
  ok(
    await until(() => log.link.length === 3),
    `the late scene's programs linked (${log.link.length} of 3)`,
  );
  ok(warm._ctx().needed.size === 3, `the needed set has them (${warm._ctx().needed.size})`);
  await pumps(3);
  ok(log.pipe.length === 0, `no pipeline was built in play (${log.pipe.length})`);
  const r2 = await race(warm.gameStart('game', { viewport: VP }));
  ok(
    r2.resolved && r2.v.state === undefined && !r2.v.timeout && log.pipe.length === 3,
    `a second gameStart is a loading moment: its window built them (${log.pipe.length} of 3, ${JSON.stringify(r2.v)})`,
  );
}
{
  const { warm, log, manifest } = mkQ();
  warm.add('game', { manifest: manifest(['A']) });
  const r = await race(warm.gameStart('game', { viewport: VP }));
  ok(
    r.resolved && r.v.state === undefined && r.v.needed === 1 && log.pipe.length === 1,
    `a queued scene answers as before (${JSON.stringify(r.v)})`,
  );
  ok(
    warm.status().window.open === false,
    `status says the window closed with nothing left to pump (${JSON.stringify(warm.status().window)})`,
  );
}

console.log('(start over a game) gameStart(B) with A running opens a window and answers with B');
{
  const { warm, log, manifest } = mkQ();
  warm.add('A', { manifest: manifest(['a1']) });
  warm.add('B', { manifest: manifest(['b1', 'b2']) });
  await race(warm.gameStart('A', { viewport: VP }));
  const r = await race(warm.gameStart('B', { viewport: VP }));
  ok(
    r.resolved && r.v.id === 'B' && r.v.needed === 2,
    `the promise is B's (${JSON.stringify(r.v)})`,
  );
  ok(
    log.pipe.filter((k) => k[0] === 'b').length === 2,
    `B's pipelines were built (${log.pipe.filter((k) => k[0] === 'b').length} of 2)`,
  );
  ok(warm._ctx().loading === false, 'the window closed when B was warm');
}
{
  const { warm, manifest } = mkQ({ ex: { pipeline: () => 'wait' } });
  warm.add('A', { manifest: manifest(['a1']) });
  warm.add('B', { manifest: manifest(['b1']) });
  const a = warm.gameStart('A', { viewport: VP, timeoutMs: Infinity });
  warm.gameStart('B', { viewport: VP, timeoutMs: Infinity });
  const r = await race(a);
  ok(
    r.resolved && r.v.id === 'A' && r.v.ended === true,
    `whoever waited on A's window is told (${JSON.stringify(r.v)})`,
  );
}

console.log(
  '(deadline) past a gameStart timeout the window is closed: no pipeline builds in play, links go on',
);
{
  let behind = true;
  const built = [];
  const { warm, log, manifest, pumps } = mkQ({
    ex: {
      pipeline: (it, canvasOk) => {
        if (behind) return 'wait';
        built.push({ k: it.k, canvasOk });
        return 'built';
      },
    },
  });
  const m = manifest(['a', 'b', 'c']);
  m.pipelines.forEach((p) => {
    p.tex = false;
  });
  warm.add('g', { manifest: m });
  const r = await warm.gameStart('g', { viewport: VP, timeoutMs: 20 });
  ok(r.timeout === true, `the promise says timeout (${JSON.stringify(r)})`);
  ok(warm._ctx().loading === false, `the loading window is closed (${warm._ctx().loading})`);
  behind = false;
  await pumps(3);
  ok(
    warm.status().window.open === false,
    `no window in play (${JSON.stringify(warm.status().window)})`,
  );
  ok(built.length === 0, `nothing built after the promise said go (${JSON.stringify(built)})`);
  const l0 = log.link.length;
  warm.setContext({ needed: ['in-play'] });
  ok(await until(() => log.link.length === l0 + 1), 'a key needed in play still links');
  warm.gameEnd();
  warm.window(true);
  ok(
    await until(() => built.length === 3),
    `the end of the game and a window build them (${built.length} of 3)`,
  );
}
{
  let behind = true;
  const built = [];
  const { warm, manifest } = mkQ({
    ex: {
      pipeline: (it) => {
        if (behind) return 'wait';
        built.push(it.k);
        return 'built';
      },
    },
  });
  warm.add('g', { manifest: manifest(['a']) });
  await warm
    .gameStart('g', { viewport: VP, timeoutMs: 20 })
    .then(() => warm.gameStart('g', { viewport: VP, timeoutMs: 20 })); // (a repeat with work pending opens one again, and its own deadline closes it)
  ok(warm._ctx().loading === false, 'a repeat start is bound by its own deadline');
  const p1 = warm.gameStart('g', { viewport: VP, timeoutMs: 20 }),
    p2 = warm.onResize(1024, 1024, { timeoutMs: Infinity });
  await p1;
  ok(warm._ctx().loading === true, 'the window stays open while another caller still waits on it');
  behind = false;
  ok(
    (await race(p2)).resolved && built.length === 1,
    `and the build finishes in it (${built.length})`,
  );
}
{
  let behind = true;
  const built = [];
  const { warm, manifest, pumps } = mkQ({
    ex: {
      pipeline: (it) => {
        if (behind) return 'wait';
        built.push(it.k);
        return 'built';
      },
    },
  });
  warm.add('g', { manifest: manifest(['a']) });
  warm.focus('g', { timeoutMs: Infinity });
  await warm.gameStart('g', { viewport: VP, timeoutMs: 20 });
  behind = false;
  await pumps(3);
  ok(
    built.length === 0 && warm.status().focus === null,
    `a focus does not hold the window past the game's deadline (${built.length} built)`,
  );
}

console.log('(focus with a game) neither promise waits for items the other paused');
{
  const { warm, manifest } = mkQ();
  const here = cls(...VP),
    there = cls(1024, 1024);
  const m = manifest(['here'], [here]),
    m2 = manifest(['there'], [there]);
  m.variants.push(...m2.variants);
  m.pipelines.push(...m2.pipelines);
  warm.add('A', { manifest: m });
  const f = warm.focus('A', { timeoutMs: Infinity });
  const g = warm.gameStart('A', { viewport: VP });
  ok((await race(g)).resolved, 'gameStart settled');
  const r = await race(f);
  ok(
    r.resolved && r.v.state === 'done' && r.v.paused === 2,
    `focus settled when only paused items remain (${JSON.stringify(r.v)})`,
  );
  ok(
    warm.status().scenes.A.pending === 2 && warm.status().scenes.A.state !== 'done',
    `the paused items are not done (${warm.status().scenes.A.pending} pending)`,
  );
}
{
  const { warm, manifest } = mkQ();
  warm.add('A', { manifest: manifest(['shared']) });
  warm.add('B', { manifest: manifest(['shared', 'b-only']) });
  warm.focus('A', { timeoutMs: Infinity });
  const r = await race(warm.gameStart('A', { viewport: VP, timeoutMs: Infinity }));
  ok(
    r.resolved && !r.v.timeout,
    `focus then gameStart: a shared key in another scene does not hold the window (${JSON.stringify(r.v)})`,
  );
  ok(warm._ctx().loading === false, 'and the window closed');
}
{
  const { warm, manifest } = mkQ();
  warm.pause();
  warm.add('A', { manifest: manifest(['shared']) });
  warm.add('B', { manifest: manifest(['shared', 'b-only']) });
  const g = warm.gameStart('A', { viewport: VP, timeoutMs: Infinity });
  const f = warm.focus('A', { timeoutMs: Infinity }); // (focus also lifts the pause)
  ok((await race(g)).resolved, 'gameStart then focus: gameStart settled');
  ok((await race(f)).resolved, 'gameStart then focus: focus settled');
  warm.resume();
}
{
  const { warm, manifest } = mkQ();
  warm.add('A', { manifest: manifest(['a1']) });
  warm.add('B', { manifest: manifest(['b1']) });
  const f = warm.focus('B', { timeoutMs: Infinity });
  const g = await race(warm.gameStart('A', { viewport: VP, timeoutMs: Infinity }));
  ok(
    g.resolved && g.v.id === 'A' && g.v.needed === 1 && warm.status().scenes.A.state !== 'queued',
    `focus(B) then gameStart(A): the game's items run (${JSON.stringify(g.v)})`,
  );
  const r = await race(f);
  ok(
    r.resolved && r.v.paused === 2,
    `and focus(B) is told its scene is paused (${JSON.stringify(r.v)})`,
  );
}

console.log("(one game's needs) `needed` and `declaredNeeds` do not carry into the next game");
{
  const { warm, log, manifest } = mkQ();
  warm.add('D', { manifest: manifest(['d1']) });
  warm.add('E', { manifest: manifest(['e1']) });
  const needs = { format: 'mantle-needs', version: 1, variants: ['declared-for-A'] };
  warm.gameStart('A', { viewport: VP, needed: ['listed-for-A'], declaredNeeds: needs });
  warm.gameEnd();
  warm.gameStart('D', { viewport: VP });
  ok(
    JSON.stringify([...warm._ctx().needed]) === '["d1"]',
    `after gameEnd: ${JSON.stringify([...warm._ctx().needed])}`,
  );
  ok(
    log.declared[log.declared.length - 1] === null,
    "the renderer's declared needs were cleared with them",
  );
  warm.gameStart('A', { viewport: VP, needed: ['listed-for-A'], declaredNeeds: needs });
  warm.gameStart('E', { viewport: VP });
  ok(
    JSON.stringify([...warm._ctx().needed]) === '["e1"]',
    `a start over a running game: ${JSON.stringify([...warm._ctx().needed])}`,
  );
  warm.gameStart('E', { viewport: VP, needed: ['x'] });
  warm.gameStart('E', { viewport: VP });
  ok(warm._ctx().needed.has('x'), 'a repeat start of the same game keeps them');
  warm.gameEnd();
  warm.setContext({ needed: ['staged'] });
  warm.setContext({ game: 'D', active: true });
  ok(warm._ctx().needed.has('staged'), 'needs staged before the start apply to it');
}
{
  const opt = { format: 'mantle-needs', version: 1, variants: ['from-options'] };
  const { warm, log } = mkQ({ opts: { declaredNeeds: opt } });
  warm.gameStart('A', {
    viewport: VP,
    declaredNeeds: { format: 'mantle-needs', version: 1, variants: ['k'] },
  });
  warm.gameEnd();
  ok(
    log.declared[log.declared.length - 1] === opt,
    "the renderer's own declared needs (the option) come back when the game ends",
  );
}

console.log('(listed keys) a `needed` key no queued scene holds is linked');
{
  const { warm, log, manifest } = mkQ();
  warm.add('game', { manifest: manifest(['a']) });
  const r = await race(warm.gameStart('game', { viewport: VP, needed: ['from-play'] }));
  ok(
    r.resolved && r.v.needed === 2 && log.link.includes('from-play'),
    `linked before the promise settled (${JSON.stringify(log.link)})`,
  );
  ok(
    Object.keys(warm.status().scenes).join() === 'game',
    `status lists only the host's scenes (${Object.keys(warm.status().scenes)})`,
  );
  ok(log.link.filter((k) => k === 'a').length === 1, 'a key a scene holds has no second item');
}
{
  const { warm, log } = mkQ();
  const r = await race(warm.gameStart('nothing-queued', { viewport: VP, needed: ['k'] }));
  ok(
    r.resolved && log.link.includes('k') && r.v.state === 'unknown',
    `with no scene at all too (${JSON.stringify(r.v)})`,
  );
  warm.setContext({ needed: ['k', 'k2'] });
  ok(await until(() => log.link.includes('k2')), 'a key listed in play links');
}
{
  const { warm } = mkQ({ ex: { link: () => true, linked: () => 'linking', has: () => true } });
  const start = warm.gameStart('g', { viewport: VP, needed: ['stuck'], timeoutMs: Infinity });
  warm.gameEnd();
  ok(
    (await race(start)).resolved && !warm.status().running,
    "the game's end drops a listed key still linking",
  );
}

console.log('(idle) idle() settles during a game once only paused items remain');
{
  const { warm, log, manifest } = mkQ();
  warm.add('game', { manifest: manifest(['g']) });
  warm.add('other', { manifest: manifest(['o']) });
  const early = warm.idle();
  await warm.gameStart('game', { viewport: VP });
  ok((await race(early)).resolved, 'an idle() asked before the game settled');
  const r = await race(warm.idle());
  ok(
    r.resolved && !log.pipe.includes('o') && r.v.scenes.other.pending === 2,
    `idle() settled with the other scene paused (${r.v && r.v.scenes.other.pending} pending)`,
  );
}
{
  const { warm, log, manifest } = mkQ();
  warm.add('game', { manifest: manifest(['g']) });
  warm.add('other', { manifest: manifest(['o']) });
  warm.gameStart('game', { viewport: VP });
  const p = warm.idle();
  ok(log.pipe.length === 0, 'with needed work pending idle() does not answer at once');
  ok((await race(p)).resolved && log.pipe.includes('g'), 'it settles when that work is done');
}

console.log(
  "(a waiting item) an item that keeps answering 'wait' does not hold up the ones behind it",
);
{
  const built = [];
  const { warm, manifest } = mkQ({
    ex: {
      pipeline: (it) => {
        if (it.tex === false) return 'wait';
        built.push(it.k);
        return 'built';
      },
    },
  });
  const m = manifest(['canvas-target', 'rt1', 'rt2']);
  m.pipelines[0].tex = false;
  warm.add('s', { manifest: m });
  warm.focus('s');
  ok(
    await until(() => built.length === 2),
    `the render-target pipelines were built (${JSON.stringify(built)})`,
  );
  ok(warm.status().scenes.s.pending === 1, 'the waiting one is still pending');
}
{
  let calls = 0;
  const { warm, manifest, Q } = mkQ({
    ex: {
      pipeline: () => {
        calls++;
        return 'wait';
      },
    },
  });
  warm.pause();
  warm.add('s', { manifest: manifest(['a', 'b', 'c']) });
  warm.resume();
  warm._step(true);
  calls = 0;
  Q._gpuClear = () => false;
  warm._step(true);
  ok(calls === 1, `with the GPU thread behind one refusal ends the step (${calls} calls)`);
}
{
  const many = Array.from({ length: 150 }, (_, i) => 'canvas' + i);
  const built = [];
  const { warm, manifest, pumps } = mkQ({
    opts: { warmQueueMaxLinks: 1000 },
    ex: {
      pipeline: (it) => {
        if (it.tex === false) return 'wait';
        built.push(it.k);
        return 'built';
      },
    },
  });
  const m = manifest([...many, 'rt']);
  m.pipelines.forEach((p) => {
    p.tex = p.k === 'rt';
  });
  warm.add('s', { manifest: m });
  warm.focus('s');
  ok(
    await until(() => built.includes('rt')),
    `past the scan limit too (${built.length} built behind ${many.length} refusals)`,
  );
  await pumps(1);
}

console.log('(scan limit) a blocking drain does not stop at the scan limit with work behind it');
{
  const keys = Array.from({ length: 300 }, (_, i) => 'k' + String(i).padStart(3, '0'));
  const pipes = [];
  const { warm, manifest, Q } = mkQ({
    opts: { warmQueueMaxLinks: 1000 },
    ex: {
      built: (k) => k !== 'k299',
      pipeline: (it) => {
        pipes.push(it.k);
        return 'built';
      },
    },
    R: { _gpuSync: () => {} },
  });
  warm.pause();
  warm.add('g', { manifest: manifest(keys) });
  await warm.gameStart('g', { viewport: VP, timeoutMs: 1 }); // (in play from here: links only)
  warm.resume();
  await until(
    () => warm._items('g').filter((i) => i.kind === 'link' && i.st === 'done').length === 300,
  );
  warm.onResize(1024, 1024, { block: true, maxBlockMs: DEADLINE });
  ok(
    pipes.includes('k299') && Q._warmPolicyStats().neededPending === 0,
    `the drain reached the unbuilt pipeline (pending ${Q._warmPolicyStats().neededPending}, built ${JSON.stringify(pipes)})`,
  );
}

console.log('(viewport) gameStart with no viewport uses the last onResize');
{
  const { warm } = mkQ();
  warm.setDisplay({ width: 1920, height: 1080, dpr: 1 });
  await warm.onResize(640, 360);
  warm.pause();
  warm.gameStart('g');
  ok(warm._ctx().cls === cls(640, 360), `class ${warm._ctx().cls}, onResize said ${cls(640, 360)}`);
  warm.gameEnd();
  warm.setDisplay({ width: 1920, height: 1080, dpr: 1 });
  warm.gameStart('g');
  ok(
    warm._ctx().cls === cls(1920, 1080),
    `a display set after it is the later statement (${warm._ctx().cls})`,
  );
  warm.gameEnd();
  warm.gameStart('g', { viewport: [100, 100] });
  ok(warm._ctx().cls === cls(100, 100), `an explicit viewport wins (${warm._ctx().cls})`);
}

console.log('(release) a cancel in release mode releases what only that scene wanted');
{
  const { warm, log, manifest } = mkQ({
    opts: { warmQueueRelease: true },
    ex: { pipeline: () => 'wait' },
  });
  warm.window(true);
  warm.add('s', { manifest: manifest(['k1', 'k2']) });
  warm.add('t', { manifest: manifest(['k2', 'k3']) });
  await until(
    () => warm._items('s').filter((i) => i.kind === 'link' && i.st === 'done').length === 2,
  );
  warm.cancel('s');
  ok(
    JSON.stringify(log.release) === '[["k1",true]]',
    `k1 was released as dropped, k2 stays for the other scene (${JSON.stringify(log.release)})`,
  );
  warm.cancel('t');
  ok(
    log.release.some(([k]) => k === 'k2') && log.release.some(([k]) => k === 'k3'),
    `the last scene wanting them lets them go (${JSON.stringify(log.release)})`,
  );
}
{
  const { warm, log, manifest } = mkQ({ ex: { pipeline: () => 'wait' } });
  warm.window(true);
  warm.add('s', { manifest: manifest(['k1']) });
  await until(() => warm._items('s').some((i) => i.kind === 'link' && i.st === 'done'));
  warm.cancel('s');
  ok(log.release.length === 0, 'outside release mode a cancel releases nothing');
}

console.log(
  '(a hub) the calls a hub makes behave as they did: declared windows, a game with no manifest, a resize, the end of a game',
);
{
  let running = false;
  const { warm, log, manifest } = mkQ({ R: { _gpuSync: () => {} } });
  warm.setDisplay({ width: 1440, height: 900, dpr: 2 });
  warm.setInference(false);
  warm.window(() => !running);
  warm.add('frog', {
    manifest: manifest(['f1']),
    priority: 1001,
    declaredNeeds: { format: 'mantle-needs', version: 1, variants: ['f-declared'] },
  });
  warm.add('eagle', { manifest: manifest(['e1']), priority: 2 });
  warm.pause();
  running = true;
  warm.resume();
  const r = await race(warm.gameStart('frog', { viewport: [2880, 1800], timeoutMs: 180000 }));
  ok(
    r.resolved &&
      r.v.id === 'frog' &&
      !r.v.timeout &&
      log.pipe.includes('f1') &&
      !log.pipe.includes('e1'),
    `the game's window opens with the hub's window shut, and the other game waits (${JSON.stringify(log.pipe)})`,
  );
  ok(log.link.includes('f-declared'), "the scene's declared needs link");
  const rr = await race(warm.onResize(1440, 900, { block: true, maxBlockMs: 3000 }));
  ok(
    rr.resolved && typeof rr.v.blockMs === 'number',
    `a resize in play answers (${JSON.stringify(rr.v)})`,
  );
  warm.resume(); // (a no-op under a game)
  ok(warm._ctx().active && !log.pipe.includes('e1'), 'resume does not end the game');
  warm.gameEnd();
  running = false;
  ok(
    await until(() => log.pipe.includes('e1')),
    "gameEnd and the hub's window resume the other game",
  );
  const none = await race(
    warm.gameStart('no-manifest', { viewport: [2880, 1800], timeoutMs: 180000 }),
  );
  ok(none.resolved, `a game that ships no manifest does not wait (${JSON.stringify(none.v)})`);
  warm.gameEnd();
  const st = warm.status();
  ok(st.scenes.frog && st.scenes.eagle && st.window && st.totals, 'status keeps its shape');
}

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
