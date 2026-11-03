// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Queue shader and pipeline preparation by scene. Scenes provide recorded
// manifests, loaded bundles or both; priority and active-game needs determine order.
// Focus and explicit loading windows pause unrelated scenes. Otherwise preparation
// runs only in declared or inferred idle windows, one pipeline build per GPU fence.
// A build in progress finishes when the window closes; no further build starts.
// Missing, stale and failed entries are reported in status. Draw readiness follows
// the renderer's exact-program or stand-in policy.

import { warmStateOf } from './warmManifest.js';
import { keyLikelihood, parseNeeds, sortedKey } from './warmPolicy.js';

const PUMP_BUSY_MS = 6; // after an item was done: the next one is considered after a fence poll
const PUMP_IDLE_MS = 60; // window open, nothing runnable right now (a link in flight, the GPU thread behind)
const PUMP_CLOSED_MS = 200; // window closed: poll for it opening
const SCAN_LIMIT = 96; // items looked at per pump (bounds the work of one timer turn)
const REACH_SCORE = 0.02; // the remainder (keys only a runtime API reaches) ranks below every key a draw is likely to ask for
const ALL_TAGS = [
  'rotate',
  'recolor',
  'palette',
  'channelLerp',
  'strokeWidth',
  'overrides',
  'alpha',
  'typeUnion',
];
const MAX_BLOCK_MS = 3000;
const LOAD_TIMEOUT_MS = 180000; // what a loading window lasts when the host names no deadline
const LISTED = '\0listed'; // the internal scene holding `needed` and declared keys no queued scene holds (status() does not list it)

/** @param {any} R the renderer context */
export function attachWarmQueue(R, unwrap = (b) => b) {
  const opts = R.opts || {};
  const allLayouts = opts.warmQueueAllLayouts === true;
  const maxLinks = opts.warmQueueMaxLinks > 0 ? Math.max(1, opts.warmQueueMaxLinks | 0) : 3;
  const now = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  /** @type {Map<string, any>} */
  const scenes = new Map();
  let seq = 0,
    focusId = null,
    held = false,
    inference = true,
    declared = null,
    display = null,
    timer = null,
    disposed = false,
    lastWindow = { open: false, reason: 'none' };
  const totals = {
    links: 0,
    pipelines: 0,
    bundleWarms: 0,
    skipped: 0,
    waits: 0,
    pumps: 0,
    closedPumps: 0,
    canvasDeferred: 0,
    playLinks: 0,
    resizes: 0,
    gameStarts: 0,
    gameEnds: 0,
    pausedSkips: 0,
  };
  // the game context (setContext / gameStart / onResize / gameEnd)
  const ctx = {
    active: false,
    id: null,
    viewport: null,
    cls: null,
    needed: new Set(),
    explicit: new Set(),
    declared: null,
    loading: false,
    startedAt: 0,
    loadWaiters: [],
    resizeMs: [],
    blockMs: [],
  };
  let order = [],
    ohead = 0,
    orderDirty = true;
  const idleWaiters = [],
    focusWaiters = [];

  const exec = () => R._wq || null;
  const scale = (w, h) =>
    Math.round(4 * Math.log2(Math.max(1, Math.sqrt(Math.max(1, w) * Math.max(1, h)))));

  function newScene(id, o) {
    const sc = {
      id,
      priority: 0,
      seq: seq++,
      state: 'queued',
      manifest: null,
      manifestStatus: 'none',
      manifestShaders: null,
      bundles: [],
      items: [],
      head: 0,
      total: 0,
      done: 0,
      built: 0,
      skipped: 0,
      createdAt: now(),
      startedAt: 0,
      doneAt: 0,
      resolve: null,
      promise: null,
      result: null,
      source: 'empty',
      scales: null,
      entries: null,
    };
    sc.promise = new Promise((res) => {
      sc.resolve = res;
    });
    sc.handle = { id, ready: sc.promise, status: () => sceneStatus(sc) };
    scenes.set(id, sc);
    return sc;
  }

  // ---- expansion: a scene's manifest and bundles become items -------------------------------------------------------------------
  function expand(sc) {
    const items = [];
    const ex = exec();
    sc.linkOf = null;
    const chk = sc.manifest ? R._wmCheck(sc.manifest) : { status: 'none', manifest: null };
    sc.manifestStatus = sc.manifest ? chk.status : 'none';
    const m = chk.manifest;
    let used = false;
    if (m && chk.status === 'ok' && ex) {
      // Variants first (links run in parallel and are what the pipelines wait for), then the pipelines in recorded order (the order the session needed them).
      const keys = [];
      const seen = new Set();
      for (const p of Array.isArray(m.pipelines) ? m.pipelines : []) {
        if (p && typeof p.k === 'string' && !seen.has(p.k)) {
          seen.add(p.k);
          keys.push(p.k);
        }
      }
      for (const v of Array.isArray(m.variants) ? m.variants : []) {
        const k = v && typeof v.k === 'string' ? v.k : null;
        if (k !== null && !seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
      sc.linkOf = new Map();
      // the viewport classes each key was bound at (manifest minor 2). A lower minor's `vc` names only the first class, which says nothing of the others: no class is read from it, and every key is
      // needed at any size (the same answer a recording at one class gives).
      const vcsOf = new Map();
      if ((m.minor | 0) >= 2)
        for (const list of [m.pipelines, m.variants])
          for (const p of Array.isArray(list) ? list : []) {
            if (!p || typeof p.k !== 'string' || !Array.isArray(p.vcs)) continue;
            for (const c of p.vcs)
              if (Number.isFinite(c)) {
                let cs = vcsOf.get(p.k);
                if (!cs) vcsOf.set(p.k, (cs = new Set()));
                cs.add(c);
              }
          }
      for (const k of keys) {
        const li = { kind: 'link', k, st: 'new', vcs: vcsOf.get(k) || null };
        sc.linkOf.set(k, li);
        items.push(li);
      }
      for (const p of Array.isArray(m.pipelines) ? m.pipelines : []) {
        if (!p || typeof p.k !== 'string' || !Array.isArray(p.lay) || !p.lay.length) continue;
        items.push({
          kind: 'pipe',
          k: p.k,
          lay: p.lay,
          tex: !!p.tex,
          inst: !!p.inst,
          blend: Array.isArray(p.blend) ? p.blend : null,
          cmask: p.cmask,
          st: 'new',
          vcs: vcsOf.get(p.k) || null,
        });
      }
      used = items.length > 0;
      sc.scales = Array.isArray(m.scales) ? m.scales.filter((x) => x && typeof x === 'object') : [];
    } else if (m && chk.status === 'unverified' && ex) {
      // an older manifest names fill variants but not their layouts: link them (cheap, parallel); the pipelines come from the bundles when they exist
      const seen = new Set();
      for (const v of Array.isArray(m.variants) ? m.variants : []) {
        const k = v && typeof v.k === 'string' ? v.k : null;
        if (k !== null && !seen.has(k)) {
          seen.add(k);
          items.push({ kind: 'link', k, st: 'new', vcs: null });
        }
      }
    }
    // the scene's DECLARED variants (a needs manifest): keys the assets and the recording do not show; link-only (no layout is known)
    if (sc.declared && ex) {
      const have = new Set(items.filter((it) => it.kind === 'link').map((it) => it.k));
      for (const k of sc.declared.variants)
        if (!have.has(k)) {
          have.add(k);
          const li = { kind: 'link', k, st: 'new', vcs: null, declared: true };
          (sc.linkOf ||= new Map()).set(k, li);
          items.push(li);
        }
    }
    sc.entries = m && m.entries && chk.status !== 'invalid' ? m.entries : null;
    // Bundle-driven items: the fallback when the manifest cannot describe the pipelines (missing, stale, older format) and the bundles exist; also the
    // bundles a manifest scene adds explicitly. A bundle the manifest knows is warmed in its recorded states, any other in every state it could be drawn in.
    const pipelinesFromManifest = used;
    if (sc.bundles.length && ex) {
      // The viewport sizes to warm for: the canvas as it is now, and the largest size this display can reach (a fullscreen toggle or a maximized window picks
      // other engines); the recorded session's scale classes when the manifest has them. At most four.
      const sizes = [null];
      const add = (w, h) => {
        if (
          sizes.length < 4 &&
          w >= 1 &&
          h >= 1 &&
          !sizes.some((q) => q && scale(q[0], q[1]) === scale(w, h))
        )
          sizes.push([w | 0, h | 0]);
      };
      if (display)
        add(Math.round(display.width * display.dpr), Math.round(display.height * display.dpr));
      if (m && Array.isArray(m.scales)) for (const c of m.scales) if (c && c.w >= 1) add(c.w, c.h);
      for (const b of sc.bundles) {
        if (!b || b._disposed) continue;
        let states = null;
        const key = R._wmKeyOf ? R._wmKeyOf(b) : null;
        const rec = key && sc.entries && Array.isArray(sc.entries[key]) ? sc.entries[key] : null;
        const exact = pipelinesFromManifest && !!rec; // the manifest is this bundle's exact record: what it says and no more (no state: never drawn, nothing to build)
        if (exact && !rec.length) continue;
        if (rec) {
          try {
            states = rec.map((sig) => {
              const st = warmStateOf(sig);
              st.inst = sig.i === 1 ? undefined : false;
              return st;
            });
          } catch {
            states = null;
          }
        }
        if (!states || !states.length)
          states = ex.exhaustiveStates ? ex.exhaustiveStates() : [null];
        for (const vp of sizes)
          for (const st of states)
            items.push({ kind: 'bundle', b, state: st, vp, st: 'new', vcs: null });
        if (exact) continue;
        // THE REMAINDER: the keys a runtime API could reach for this bundle (rotate, recolor, palette, channel lerp, stroke width, overrides, alpha, type
        // union). Declared reach (a needs manifest) names exactly which; with none declared every tag is queued. Link-only, the lowest score: they wait
        // behind everything a draw is likely to need, and a game in play pauses them.
        if (R._reachKeys) {
          const tags = declaredTagsFor(sc, b);
          const seenK = new Set(items.map((it) => /** @type {any} */ (it).k).filter(Boolean));
          for (const k of R._reachKeys(b, tags || ALL_TAGS))
            if (!seenK.has(k)) {
              seenK.add(k);
              items.push({ kind: 'link', k, st: 'new', vcs: null, reach: true });
            }
        }
      }
      used = used || items.length > 0;
    }
    sc.source = !items.length
      ? 'empty'
      : pipelinesFromManifest
        ? 'manifest'
        : sc.bundles.length
          ? sc.manifest
            ? 'bundles(fallback)'
            : 'bundles'
          : 'links';
    sc.items = items;
    sc.head = 0;
    sc.total = items.length;
    sc.done = 0;
    sc.built = 0;
    sc.skipped = 0;
    sc.expanded = true;
    orderDirty = true;
  }

  function finish(sc, state) {
    if (sc.state === 'done' || sc.state === 'cancelled') return;
    sc.state = state;
    sc.doneAt = now();
    sc.result = {
      id: sc.id,
      state,
      source: sc.source,
      manifest: sc.manifestStatus,
      total: sc.total,
      built: sc.built,
      skipped: sc.skipped,
      ms: Math.round(sc.doneAt - (sc.startedAt || sc.createdAt)),
    };
    // A finished scene has nothing left to do with its bundles, and no call removes a scene: holding them kept every disposed bundle, with its CPU curves, for the renderer's life.
    for (const it of sc.items) if (it.b) it.b = null;
    sc.bundles = [];
    orderDirty = true;
    sc.resolve(sc.result);
  }

  // ---- the window: when is a build invisible? ---------------------------------------------------------------------------------
  function windowState() {
    if (focusId !== null) return { open: true, reason: 'focus', canvas: true };
    if (ctx.active && ctx.loading)
      return { open: true, reason: ctx.resizing ? 'resize' : 'game-start', canvas: true }; // (the game's own loading window / a resize: its needed items build)
    if (declared !== null) {
      let on = false;
      try {
        on = typeof declared === 'function' ? !!declared() : !!declared;
      } catch {
        on = false;
      }
      if (on) return { open: true, reason: 'declared', canvas: true };
    }
    if (typeof document !== 'undefined' && document.hidden)
      return { open: true, reason: 'hidden', canvas: true };
    if (R._coop) return { open: false, reason: 'loading-call', canvas: false }; // a loading call is running: it is the window's owner
    if (inference && R._idleNow && R._idleNow())
      return { open: true, reason: 'idle', canvas: false };
    return { open: false, reason: 'active', canvas: false };
  }

  function runnable() {
    if (held) return [];
    const list = [];
    for (const sc of scenes.values()) {
      if (sc.state === 'done' || sc.state === 'cancelled') continue;
      // (with a game running, what it needs runs whichever scene holds it, and allowed() pauses the rest: a focus pausing a scene that shares a needed key would hold the game's window to its timeout)
      if (focusId !== null && sc.id !== focusId && !ctx.active) {
        if (sc.state !== 'queued') sc.state = 'paused';
        continue;
      }
      list.push(sc);
    }
    list.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    return list;
  }

  // ---- the order: likelihood across scenes, then the game context ---------------------------------------------------------------
  function declaredTagsFor(sc, bundle) {
    if (!sc.declared || !sc.declared.reach.length) return null;
    const key = R._wmKeyOf ? R._wmKeyOf(bundle) : null;
    const tags = new Set();
    for (const r of sc.declared.reach)
      if (r.bundle === '*' || r.bundle === key) for (const t of r.tags) tags.add(t);
    return tags.size ? [...tags] : null;
  }
  /// Is this item needed by the running game at its current viewport class? (Only meaningful while ctx.active.)
  function isNeeded(it, sc) {
    if (it.kind === 'bundle') return sc.id === ctx.id;
    return ctx.needed.has(it.k);
  }
  const allowed = (it, sc) => !ctx.active || isNeeded(it, sc);
  /// Is there anything left that a pump could run? Items only a window is missing for count; items the game context paused do not. (A scene with nothing pending still has its finish to come.)
  function runnableWork() {
    for (const sc of runnable()) {
      if (!sc.expanded) return true;
      let pending = false;
      for (let i = sc.head; i < sc.items.length; i++) {
        const it = sc.items[i];
        if (it.st === 'done' || it.st === 'skip') continue;
        pending = true;
        if (allowed(it, sc)) return true;
      }
      if (!pending) return true;
    }
    return false;
  }
  /// `needed` and declared keys that no queued scene holds get an item of their own: nothing else would ever link them.
  function holdListed() {
    if (disposed || !exec()) return;
    const listed = [...ctx.explicit, ...(ctx.declared ? ctx.declared.variants : [])];
    if (!listed.length) return;
    const held = new Set();
    for (const sc of scenes.values())
      if (sc.state !== 'cancelled')
        for (const it of sc.items) if (it.kind === 'link' && it.st !== 'skip') held.add(it.k);
    let own = scenes.get(LISTED);
    for (const k of listed) {
      if (held.has(k)) continue;
      held.add(k);
      if (!own || own.state === 'done') {
        own = newScene(LISTED);
        own.hidden = true;
        own.expanded = true;
        own.source = 'links';
      }
      own.items.push({ kind: 'link', k, st: 'new', vcs: null });
      own.total++;
      orderDirty = true;
    }
  }
  /// The needed key set for the game at ctx.cls: the game scene's items recorded at the nearest recorded class (and items with no class), the explicit list,
  /// the declared variants. A game scene with no class information needs all of its items.
  function computeNeeded() {
    const out = new Set(ctx.explicit);
    if (ctx.declared) for (const k of ctx.declared.variants) out.add(k);
    holdListed();
    const sc = ctx.id !== null ? scenes.get(ctx.id) : null;
    if (sc) {
      if (!sc.expanded) expand(sc);
      let best = null,
        bestVc = null;
      if (ctx.cls != null)
        for (const it of sc.items)
          if (it.vcs)
            for (const vc of it.vcs) {
              const d = Math.abs(vc - ctx.cls);
              if (best === null || d < best || (d === best && vc > bestVc)) {
                best = d;
                bestVc = vc;
              }
            }
      for (const it of sc.items) {
        if (it.kind === 'bundle' || it.reach) continue;
        if (!it.vcs || best === null || it.vcs.has(bestVc)) out.add(it.k);
      }
      for (const it of sc.items) if (it.declared) out.add(it.k);
    }
    ctx.needed = out;
    orderDirty = true;
  }
  function neededPending() {
    let n = 0;
    for (const sc of scenes.values()) {
      if (sc.state === 'done' || sc.state === 'cancelled') continue;
      for (let i = sc.head; i < sc.items.length; i++) {
        const it = sc.items[i];
        if (it.st !== 'done' && it.st !== 'skip' && isNeeded(it, sc)) n++;
      }
    }
    return n;
  }
  function itemScore(it, sc, counts, nScenes) {
    if (it.kind === 'bundle') {
      let k = null;
      try {
        k = ex_().keyOfBundle ? ex_().keyOfBundle(it.b) : null;
      } catch {
        k = null;
      }
      return (
        (k ? keyLikelihood(k, { scenes: nScenes, sceneCount: counts.get(k) || 1 }) : 0.3) *
        (it.state ? 0.5 : 1)
      );
    }
    if (it.reach)
      return (
        REACH_SCORE * keyLikelihood(it.k, { scenes: nScenes, sceneCount: counts.get(it.k) || 1 })
      );
    return keyLikelihood(it.k, { scenes: nScenes, sceneCount: counts.get(it.k) || 1 });
  }
  const ex_ = () => exec() || {};
  /// Every pending item of every runnable scene in LIKELIHOOD order: scene priority, then (with a game running) its needed items first, then the key's score,
  /// then queue order. A link and its pipeline share a key, so a pipeline never ranks above its own link.
  function buildOrder(list) {
    const counts = new Map();
    let nScenes = 0;
    for (const sc of scenes.values()) {
      if (sc.state === 'cancelled' || sc.hidden) continue;
      if (!sc.expanded) continue;
      nScenes++;
      const mine = new Set();
      for (const it of sc.items)
        if (it.kind !== 'bundle' && !mine.has(it.k)) {
          mine.add(it.k);
          counts.set(it.k, (counts.get(it.k) || 0) + 1);
        }
    }
    const rows = [];
    let n = 0;
    for (const sc of list)
      for (let i = sc.head; i < sc.items.length; i++) {
        const it = sc.items[i];
        if (it.st === 'done' || it.st === 'skip') continue;
        rows.push({
          sc,
          it,
          score: itemScore(it, sc, counts, nScenes),
          need: ctx.active && isNeeded(it, sc) ? 0 : 1,
          n: n++,
        });
      }
    rows.sort(
      (a, b) =>
        b.sc.priority - a.sc.priority ||
        a.need - b.need ||
        b.score - a.score ||
        a.sc.seq - b.sc.seq ||
        a.n - b.n,
    );
    order = rows;
    ohead = 0;
    orderDirty = false;
    pendingByK.clear();
    for (const r of rows) if (r.it.k) pendingByK.set(r.it.k, (pendingByK.get(r.it.k) || 0) + 1);
    lastScores = rows.slice(0, 2000).map((r) => ({
      k: r.it.k || r.it.kind,
      s: +r.score.toFixed(4),
      sc: r.sc.id,
      kind: r.it.kind,
      reach: !!r.it.reach,
    }));
  }
  let lastScores = [];
  // RELEASE MODE (option warmQueueRelease: a renderer whose only job is to fill the browser's shader caches, the hub's warmer): a program is deleted once
  // every item that needs it is done -- linked, and its pipelines built. The caches keep what the game's context links next; holding the live program
  // would only keep its memory. A released key counts as done for every later scene.
  const release = R.opts.warmQueueRelease === true;
  const pendingByK = new Map();
  function settled(it) {
    if (!it.k) return;
    const n = (pendingByK.get(it.k) || 1) - 1;
    if (n > 0) {
      pendingByK.set(it.k, n);
      return;
    }
    pendingByK.delete(it.k);
    if (release) {
      const ex = exec();
      if (ex && ex.release && ex.release(it.k)) totals.released = (totals.released | 0) + 1;
    }
  }

  /// Drop a scene's pending work. Release mode: a program only this scene still wanted goes with it; that key was not necessarily built, so a later scene that needs it starts it again.
  function cancelScene(sc) {
    const dropped = new Set();
    for (const it of sc.items)
      if (it.st !== 'done' && it.st !== 'skip') {
        it.st = 'skip';
        if (it.k) dropped.add(it.k);
      }
    sc.bundles = [];
    orderDirty = true;
    finish(sc, 'cancelled');
    const ex = exec();
    if (!release || !ex || !ex.release) return;
    for (const k of dropped) {
      let wanted = false;
      for (const s2 of scenes.values())
        if (
          s2.state !== 'done' &&
          s2.state !== 'cancelled' &&
          s2.items.some((it) => it.k === k && it.st !== 'done' && it.st !== 'skip')
        ) {
          wanted = true;
          break;
        }
      if (!wanted && ex.release(k, true)) totals.released = (totals.released | 0) + 1;
    }
  }

  // ---- one step -----------------------------------------------------------------------------------------------------------------
  /// A warm build is not a frame's draw: outside a frame a capture neither refuses it nor records it (the loading call lifts it the same way).
  function warmCall(f) {
    const was = R._captureFrames;
    if (!was || R._inFrame) return f();
    R._captureFrames = false;
    try {
      return f();
    } finally {
      R._captureFrames = was;
    }
  }
  /** Do at most one pipeline-building item (and any number of cheap link starts). Returns 'built' | 'wait' | 'idle' | 'more' (the scan limit stopped it with work behind: go on at once). `linksOnly`: start and poll links, build nothing. */
  function step(canvasOk, linksOnly = false) {
    const ex = exec();
    const list = runnable();
    if (!list.length) return 'idle';
    for (const sc of list) {
      if (!sc.expanded) {
        expand(sc);
        orderDirty = true;
      }
      if (sc.state === 'queued' || sc.state === 'paused') {
        sc.state = 'running';
        if (!sc.startedAt) sc.startedAt = now();
      }
    }
    if (orderDirty) buildOrder(list);
    let waited = false,
      limited = false,
      bundleWaited = false;
    let inflight = 0;
    for (let i = ohead; i < order.length; i++) {
      const it = order[i].it;
      if (it.kind === 'link' && it.st === 'linking') inflight++;
    }
    let scanned = 0;
    const runSet = new Set(list);
    const touched = new Set();
    for (let i = ohead; i < order.length; i++) {
      const { sc, it } = order[i];
      if (it.st === 'done' || it.st === 'skip') {
        if (i === ohead) ohead++;
        continue;
      }
      if (sc.state === 'cancelled' || sc.state === 'done' || !runSet.has(sc)) continue;
      if (!allowed(it, sc)) {
        totals.pausedSkips++;
        continue;
      }
      if (linksOnly && it.kind !== 'link') continue;
      if (++scanned > SCAN_LIMIT) {
        limited = true;
        break;
      }
      touched.add(sc);
      if (it.kind === 'link') {
        if (it.st === 'new') {
          if (inflight >= maxLinks) {
            waited = true;
            continue;
          }
          let ok = false;
          try {
            ok = ex.link(it.k);
          } catch {
            ok = false;
          }
          if (!ok) {
            it.st = 'skip';
            sc.skipped++;
            totals.skipped++;
            settled(it);
            continue;
          }
          it.st = 'linking';
          inflight++;
          totals.links++;
          if (linksOnly) totals.playLinks++;
        }
        if (it.st === 'linking') {
          let r = 'linking';
          try {
            r = ex.linked(it.k);
          } catch {
            r = 'failed';
          }
          if (r === 'ready') {
            it.st = 'done';
            sc.done++;
            settled(it);
          } else if (r === 'failed') {
            it.st = 'skip';
            sc.skipped++;
            totals.skipped++;
            settled(it);
          } else {
            waited = true;
          }
        }
        continue;
      }
      // a pipeline-building item
      if (it.kind === 'pipe') {
        const li = sc.linkOf && sc.linkOf.get(it.k);
        if (li && li.st === 'new') {
          waited = true;
          continue;
        } // its link has not been started yet (links are capped in flight)
        const lk = ex.has(it.k) ? ex.linked(it.k) : 'failed';
        if (lk === 'failed') {
          it.why = 'link-failed';
          it.st = 'skip';
          sc.skipped++;
          totals.skipped++;
          settled(it);
          continue;
        }
        if (lk !== 'ready') {
          waited = true;
          continue;
        }
        if (it.tex === false && !canvasOk) {
          totals.canvasDeferred++;
          waited = true;
          scanned--;
          continue;
        } // (a refusal costs nothing, and a long run of them must not hide what is behind it)
        // (a program that has been drawn once is built: a first draw on another vertex layout or target kind opens no measurable gap;
        // `warmQueueAllLayouts: true` builds every recorded pipeline)
        if (!allLayouts && ex.built(it.k)) {
          it.st = 'done';
          sc.done++;
          settled(it);
          continue;
        }
        let r = 'wait';
        try {
          r = warmCall(() => ex.pipeline(it, canvasOk));
        } catch {
          r = 'skip';
        }
        if (r === 'built') {
          it.st = 'done';
          sc.done++;
          sc.built++;
          totals.pipelines++;
          settled(it);
          return 'built';
        }
        if (r === 'skip') {
          it.why = 'pipeline-skip';
          it.st = 'skip';
          sc.skipped++;
          totals.skipped++;
          settled(it);
          continue;
        }
        waited = true;
        totals.waits++;
        scanned--;
        if (R._gpuClear && !R._gpuClear()) return 'wait'; // the GPU thread is behind: every other build would answer the same; ask again after a fence poll
        continue; // this item cannot go now (a canvas target with no size, say): it does not hold up the ones that can
      }
      if (it.kind === 'bundle') {
        if (it.b && it.b._disposed) {
          it.st = 'skip';
          sc.skipped++;
          continue;
        }
        if (bundleWaited) continue; // (asking the next bundle would start its links past the cap, for the same answer)
        let r = 'wait';
        try {
          r = warmCall(() => ex.bundle(it.b, it.state, canvasOk, it.vp));
        } catch {
          r = 'skip';
        }
        if (r === 'built') {
          it.st = 'done';
          sc.done++;
          sc.built++;
          totals.bundleWarms++;
          return 'built';
        }
        if (r === 'skip') {
          it.st = 'skip';
          sc.skipped++;
          continue;
        }
        waited = true;
        totals.waits++;
        bundleWaited = true;
        if (R._gpuClear && !R._gpuClear()) return 'wait';
      }
    }
    for (const sc of list)
      if (!sc.items.some((it) => it.st !== 'done' && it.st !== 'skip')) finish(sc, 'done');
    return waited ? 'wait' : limited ? 'more' : 'idle';
  }

  function anyPending() {
    for (const sc of scenes.values())
      if (sc.state !== 'done' && sc.state !== 'cancelled') return true;
    return false;
  }

  function pump() {
    timer = null;
    if (disposed || R._disposed) return;
    totals.pumps++;
    if (ctx.active && ctx.loading) checkLoaded();
    settleFocus();
    if (idleWaiters.length && !runnableWork()) notifyIdle();
    const list = runnable();
    if (!list.length) {
      notifyIdle();
      if (anyPending() && !held) schedule(PUMP_CLOSED_MS);
      return;
    }
    const w = windowState();
    lastWindow = w;
    if (R._contextLost) {
      schedule(PUMP_CLOSED_MS);
      return;
    }
    if (!w.open && ctx.active) {
      // GAME IN PLAY: no window, so no pipeline is built; the programs the game needs still LINK (a parallel compile in the GPU process, no main-thread
      // wait), one fence at a time, and everything else stays paused.
      totals.closedPumps++;
      if (R._gpuClear && !R._gpuClear()) {
        schedule(PUMP_BUSY_MS * 3);
        return;
      }
      const was = R._inferSlice;
      R._inferSlice = true;
      let rr = 'idle';
      try {
        rr = step(false, true);
      } finally {
        R._inferSlice = was;
      }
      schedule(rr === 'idle' ? PUMP_CLOSED_MS : PUMP_IDLE_MS);
      return;
    }
    if (!w.open) {
      totals.closedPumps++;
      schedule(PUMP_CLOSED_MS);
      return;
    }
    // one pipeline-building item per fence: the executor refuses while the GPU thread is behind (gpuGate.clear), and so does this
    if (R._gpuClear && !R._gpuClear()) {
      schedule(PUMP_BUSY_MS * 3);
      return;
    }
    const was = R._inferSlice;
    R._inferSlice = true; // (strictPlay: this is a window, not play)
    let r = 'idle';
    try {
      r = step(w.canvas);
    } finally {
      R._inferSlice = was;
    }
    if (ctx.active && ctx.loading) checkLoaded();
    settleFocus();
    if (r === 'built') {
      R._warmQueueBuilds = (R._warmQueueBuilds | 0) + 1;
      schedule(PUMP_BUSY_MS);
      return;
    }
    if (r === 'more') {
      schedule(PUMP_BUSY_MS);
      return;
    }
    if (r === 'wait') {
      schedule(PUMP_IDLE_MS);
      return;
    }
    if (anyPending() && runnable().length) schedule(PUMP_IDLE_MS);
    else notifyIdle();
  }

  function schedule(ms) {
    if (timer !== null || disposed || typeof setTimeout !== 'function') return;
    timer = setTimeout(pump, ms);
  }
  function kick() {
    if (timer === null) schedule(0);
  }
  function notifyIdle() {
    while (idleWaiters.length) idleWaiters.shift()(status());
  }

  // Frame entry (fillPass fillWarmTick, before the clear): a window the library inferred from the frames themselves, with the canvas safe to draw on.
  R._wqFrameTick = (canvasSafe) => {
    if (disposed || (timer === null && !anyPending())) return;
    if (!canvasSafe || held) return;
    const list = runnable();
    if (!list.length || R._coop || R._warmWindow) return;
    if (!inference || !(R._idleNow && R._idleNow())) return;
    if (R._gpuClear && !R._gpuClear()) return;
    const was = R._inferSlice;
    R._inferSlice = true;
    R._inferredWindows = (R._inferredWindows | 0) + 1;
    try {
      if (step(true) === 'built') R._warmQueueBuilds = (R._warmQueueBuilds | 0) + 1;
    } finally {
      R._inferSlice = was;
    }
  };

  // ---- the game context --------------------------------------------------------------------------------------------------------
  const clsOf = (w, h) => scale(w, h);
  function checkLoaded() {
    if (!ctx.active || !ctx.loading) return;
    if (neededPending() > 0) return;
    ctx.loading = false;
    ctx.resizing = false;
    const r = {
      id: ctx.id,
      cls: ctx.cls,
      needed: ctx.needed.size,
      ms: Math.round(now() - ctx.startedAt),
    };
    ctx.lastLoad = r;
    while (ctx.loadWaiters.length) ctx.loadWaiters.shift()(r);
    settleFocus();
  }
  /// The window lasts while someone waits on it. The last deadline to pass closes it: the host has moved on to play, and no pipeline builds in play (the links go on).
  function loadPromise(timeoutMs, unwatched = false) {
    if (!ctx.active || !ctx.loading || neededPending() === 0) {
      checkLoaded();
      return Promise.resolve(
        ctx.lastLoad || { id: ctx.id, cls: ctx.cls, needed: ctx.needed.size, ms: 0 },
      );
    }
    return new Promise((res) => {
      const waiter = (r) => {
        if (t) clearTimeout(t);
        res(r);
      };
      const t =
        timeoutMs < Infinity
          ? setTimeout(() => {
              const i = ctx.loadWaiters.indexOf(waiter);
              if (i >= 0) ctx.loadWaiters.splice(i, 1);
              if (!ctx.loadWaiters.length) {
                ctx.loading = false;
                ctx.resizing = false;
              }
              res({
                id: ctx.id,
                cls: ctx.cls,
                needed: ctx.needed.size,
                ms: timeoutMs,
                timeout: true,
              });
            }, timeoutMs)
          : null;
      const unref = /** @type {any} */ (t);
      if (unwatched && unref && unref.unref) unref.unref();
      ctx.loadWaiters.push(waiter);
    });
  }
  /// A focus waits for the scene's work, and a game pauses part of a scene (the items of another class; for a scene that is not the game, all it does not share): the promise
  /// settles when only those remain. The paused items are not done: `paused` counts them, and gameEnd resumes them.
  function settleFocus() {
    if (!ctx.active || !focusWaiters.length) return;
    for (const w of focusWaiters.slice()) {
      const sc = w.sc;
      if (!sc.expanded) continue;
      let paused = 0,
        runs = false;
      for (let i = sc.head; i < sc.items.length && !runs; i++) {
        const it = sc.items[i];
        if (it.st !== 'done' && it.st !== 'skip') {
          if (allowed(it, sc)) runs = true;
          else paused++;
        }
      }
      if (!runs && paused)
        w.done({
          id: sc.id,
          state: 'done',
          source: sc.source,
          manifest: sc.manifestStatus,
          total: sc.total,
          built: sc.built,
          skipped: sc.skipped,
          paused,
          ms: Math.round(now() - (sc.startedAt || sc.createdAt)),
        });
    }
  }
  /// Synchronous drain of the needed set (a resize, where a stall is allowed): steps until nothing needed is pending, the deadline passes, or a step has
  /// nothing to do. A step that must wait for the GPU thread syncs it (the stall).
  function drainBlocking(maxMs) {
    const t0 = now();
    ctx.loading = true;
    while (neededPending() > 0 && now() - t0 < maxMs && !R._contextLost) {
      // (on a lost context no step can move: it would hold the main thread to the deadline)
      const was = R._inferSlice;
      R._inferSlice = true;
      let r = 'idle';
      try {
        r = step(true);
      } finally {
        R._inferSlice = was;
      }
      if (r === 'built') {
        R._warmQueueBuilds = (R._warmQueueBuilds | 0) + 1;
        continue;
      }
      if (r === 'more') continue;
      if (r === 'idle') break;
      if (R._gpuSync) {
        try {
          R._gpuSync();
        } catch {
          /* best effort */
        }
      }
    }
    checkLoaded();
    return Math.round(now() - t0);
  }
  /// Set (part of) the game context. `game`/`active`: which scene is running; `viewport` [w, h] in drawing-buffer pixels; `needed` extra keys; `declaredNeeds` a
  /// needs manifest (object or JSON; null clears). Unknown fields are ignored.
  /** @param {{ game?: string|null, active?: boolean, viewport?: number[], needed?: string[], declaredNeeds?: any }} [c] */
  function setContext(c = {}) {
    if (!c || typeof c !== 'object') return ctx.active;
    applyContext(c);
    if (ctx.active && ctx.loading && !ctx.loadWaiters.length) loadPromise(LOAD_TIMEOUT_MS, true); // (no caller holds a promise here, and the window still ends)
    return ctx.active;
  }
  /// What one game asked for ends with it: its listed needs do not carry into the next, and whoever waited on its window is told.
  function leaveGame() {
    if (ctx.declared) {
      ctx.declared = null;
      if (R._setDeclaredNeeds)
        R._setDeclaredNeeds(opts.declaredNeeds != null ? opts.declaredNeeds : null);
    }
    ctx.explicit = new Set();
    const own = scenes.get(LISTED);
    if (own) {
      cancelScene(own);
      scenes.delete(LISTED);
    }
    ctx.loading = false;
    ctx.resizing = false;
    ctx.lastLoad = null;
    while (ctx.loadWaiters.length)
      ctx.loadWaiters.shift()({
        id: ctx.id,
        cls: ctx.cls,
        needed: ctx.needed.size,
        ms: Math.round(now() - ctx.startedAt),
        ended: true,
      });
  }
  function applyContext(c) {
    const wasActive = ctx.active;
    const nextId = c.game === undefined ? ctx.id : c.game == null ? null : String(c.game);
    const ending = wasActive && c.active === false,
      changing = wasActive && !ending && nextId !== ctx.id;
    if (ending || changing) leaveGame();
    if (c.declaredNeeds !== undefined) {
      ctx.declared = c.declaredNeeds == null ? null : parseNeeds(c.declaredNeeds);
      if (R._setDeclaredNeeds) R._setDeclaredNeeds(c.declaredNeeds);
    }
    if (Array.isArray(c.needed))
      ctx.explicit = new Set(c.needed.filter((k) => typeof k === 'string').map(sortedKey));
    ctx.id = nextId;
    if (Array.isArray(c.viewport) && c.viewport[0] >= 1 && c.viewport[1] >= 1) {
      ctx.viewport = [c.viewport[0] | 0, c.viewport[1] | 0];
      ctx.cls = clsOf(c.viewport[0], c.viewport[1]);
    }
    if (c.active !== undefined) ctx.active = !!c.active;
    if (ctx.active && (!wasActive || changing)) {
      beginLoad();
      totals.gameStarts++;
    }
    if (!ctx.active && wasActive) {
      totals.gameEnds++;
      for (const sc of scenes.values()) if (sc.state === 'paused') sc.state = 'queued';
    }
    if (ctx.active) computeNeeded();
    orderDirty = true;
    settleFocus();
    kick();
  }
  /// A loading moment opens: the game's window, which takes over from a focus (a focus left open would keep building in play, past the game's own deadline).
  function beginLoad() {
    if (!ctx.loading) ctx.startedAt = now();
    ctx.loading = true;
    ctx.resizing = false;
    ctx.lastLoad = null;
    focusId = null;
  }

  // ---- status -------------------------------------------------------------------------------------------------------------------
  function sceneStatus(sc) {
    const pending = sc.items.length
      ? sc.items.filter((it) => it.st !== 'done' && it.st !== 'skip').length
      : sc.expanded
        ? 0
        : null;
    return {
      id: sc.id,
      state: sc.state,
      priority: sc.priority,
      source: sc.source,
      manifest: sc.manifestStatus,
      bundles: sc.bundles.length,
      total: sc.expanded ? sc.total : null,
      done: sc.done,
      built: sc.built,
      skipped: sc.skipped,
      pending,
      progress: sc.expanded ? (sc.total ? (sc.total - (pending | 0)) / sc.total : 1) : 0,
      scales: scaleReport(sc),
      startedAt: sc.startedAt || null,
      doneAt: sc.doneAt || null,
      result: sc.result,
    };
  }
  /** The live-resize scale classes (quarter octaves of the viewport's linear size): the ones the manifest recorded, the ones this display can reach, and the gap. */
  function scaleReport(sc) {
    const rec = sc.scales ? sc.scales.map((x) => x.c) : [];
    if (!display) return { recorded: rec, reachable: null, missing: null };
    const lo = rec.length
        ? Math.min(...rec)
        : scale(display.width * display.dpr, display.height * display.dpr),
      hi = Math.max(display.maxClass, rec.length ? Math.max(...rec) : 0);
    const reachable = [];
    for (let c = lo; c <= hi; c++) reachable.push(c);
    return { recorded: rec, reachable, missing: reachable.filter((c) => !rec.includes(c)) };
  }
  function status() {
    // (asked now: nothing pumps once nothing is pending, so the last pump's answer can be a window that closed long ago)
    const out = {
      running: !disposed && anyPending() && !held,
      focus: focusId,
      held,
      window: disposed ? lastWindow : windowState(),
      display,
      scenes: {},
      totals: { ...totals },
    };
    for (const sc of scenes.values()) if (!sc.hidden) out.scenes[sc.id] = sceneStatus(sc);
    return out;
  }

  // ---- the API ------------------------------------------------------------------------------------------------------------------
  const warm = {
    /**
     * Queue a scene. `{ manifest }` (an `exportWarmManifest()` object or its JSON) warms exactly the recorded programs and pipelines without the scene's
     * bundles; `{ bundles }` warms loaded bundles (also the fallback when the manifest is missing, stale or from another build). Adding an id again adds its
     * bundles / replaces its manifest and re-queues it. Never throws on content.
     */
    add(id, o = {}) {
      id = String(id);
      let sc = scenes.get(id);
      const wasDone = sc && (sc.state === 'done' || sc.state === 'cancelled');
      if (!sc) sc = newScene(id, o);
      else if (wasDone) {
        sc.state = 'queued';
        sc.promise = new Promise((res) => {
          sc.resolve = res;
        });
        sc.handle.ready = sc.promise;
        sc.result = null;
        sc.expanded = false;
      }
      if (o && typeof o.priority === 'number') sc.priority = o.priority;
      if (o && o.manifest !== undefined) {
        sc.manifest = o.manifest;
        sc.expanded = false;
      }
      if (o && Array.isArray(o.bundles)) {
        for (const b of o.bundles) {
          const u = unwrap(b);
          if (u && !sc.bundles.includes(u)) sc.bundles.push(u);
        }
        sc.expanded = false;
      }
      if (o && o.scales !== undefined) sc.scaleOpt = o.scales;
      if (o && o.declaredNeeds !== undefined) {
        sc.declared = o.declaredNeeds == null ? null : parseNeeds(o.declaredNeeds);
        sc.expanded = false;
      }
      if (sc.state === 'done' || sc.state === 'queued') sc.state = 'queued';
      if (disposed) {
        finish(sc, 'cancelled');
        return sc.handle;
      } // (nothing will ever run it)
      if (!sc.expanded) expand(sc);
      if (!sc.items.length && !sc.items.some((it) => it.st !== 'done' && it.st !== 'skip'))
        finish(sc, 'done'); // nothing to warm: ready at once (a miss is covered by the nets)
      if (ctx.active && id === ctx.id) computeNeeded(); // the running game's scene arrived or changed: what it needs has too
      settleFocus();
      kick();
      return sc.handle;
    },
    /**
     * THE GAME STARTS. Everything it needs at the current resolution keeps linking (its pipelines build in a loading window); every other pending item is
     * paused until `gameEnd()`. `o.viewport` [w, h] (drawing-buffer pixels; default the last `onResize`, else the display set by setDisplay), `o.needed` extra variant keys,
     * `o.declaredNeeds` a needs manifest (both for this game alone), `o.timeoutMs` bounds the returned promise and the loading window (default 180000: past it no pipeline
     * builds in play, and the promise says `timeout: true`). Resolves when the game's needed set is warm; `state: 'unknown'` when no scene is queued under `id`.
     */
    gameStart(id, o = {}) {
      id = String(id);
      let vp = o.viewport;
      if (!(Array.isArray(vp) && vp[0] >= 1))
        vp =
          ctx.viewport ||
          (display
            ? [Math.round(display.width * display.dpr), Math.round(display.height * display.dpr)]
            : undefined);
      applyContext({
        game: id,
        active: true,
        viewport: vp,
        needed: o.needed,
        declaredNeeds: o.declaredNeeds,
      });
      beginLoad();
      const known = scenes.has(id);
      const p = loadPromise(o.timeoutMs != null ? +o.timeoutMs : LOAD_TIMEOUT_MS);
      return known ? p : p.then((r) => ({ ...r, state: 'unknown' }));
    },
    /** The game is over: the paused remainder resumes in likelihood order. */
    gameEnd() {
      setContext({ active: false });
    },
    setContext,
    /**
     * The viewport changed (a window resize, fullscreen, another display). The needed set is recomputed for the new class and warmed now. A main-thread stall is
     * accepted here: `{ block: true }` drains the needed set synchronously (up to `maxBlockMs`, default 3000); otherwise a window opens and the queue drains
     * it, and the promise resolves when it is warm. A resize with no game running only updates the viewport the next gameStart uses.
     */
    onResize(w, h, o = {}) {
      if (!(w >= 1 && h >= 1)) return Promise.resolve({ ignored: true });
      const t0 = now(),
        cls = clsOf(w, h),
        changed = ctx.cls !== cls;
      ctx.viewport = [w | 0, h | 0];
      ctx.cls = cls;
      if (!ctx.active) return Promise.resolve({ active: false, cls });
      totals.resizes++;
      computeNeeded();
      if (!changed && neededPending() === 0)
        return Promise.resolve({ id: ctx.id, cls, needed: ctx.needed.size, ms: 0, same: true });
      ctx.loading = true;
      ctx.resizing = true;
      let blockMs = 0;
      if (o.block) {
        blockMs = drainBlocking(o.maxBlockMs > 0 ? +o.maxBlockMs : MAX_BLOCK_MS);
        ctx.blockMs.push(blockMs);
        if (ctx.blockMs.length > 40) ctx.blockMs.shift();
      }
      kick();
      return loadPromise(o.timeoutMs != null ? +o.timeoutMs : LOAD_TIMEOUT_MS).then((r) => {
        ctx.resizeMs.push(Math.round(now() - t0));
        if (ctx.resizeMs.length > 40) ctx.resizeMs.shift();
        return { ...r, blockMs };
      });
    },
    /** The scene was requested: warm it first, pause every other scene's pending work, treat the time as a loading window. Resolves with the scene's result. */
    focus(id, o = {}) {
      id = String(id);
      let sc = scenes.get(id);
      if (!sc)
        return Promise.resolve({
          id,
          state: 'unknown',
          source: 'empty',
          manifest: 'none',
          total: 0,
          built: 0,
          skipped: 0,
          ms: 0,
        });
      focusId = id;
      held = false;
      orderDirty = true;
      if (sc.state === 'done' || sc.state === 'cancelled')
        return Promise.resolve(sc.result || { id, state: sc.state });
      for (const s2 of scenes.values())
        if (s2.id !== id && s2.state === 'running') s2.state = 'paused';
      kick();
      const timeoutMs = o && o.timeoutMs != null ? +o.timeoutMs : LOAD_TIMEOUT_MS;
      return new Promise((res) => {
        const w = {
          sc,
          done: (r) => {
            if (t) clearTimeout(t);
            const i = focusWaiters.indexOf(w);
            if (i >= 0) focusWaiters.splice(i, 1);
            res(r);
          },
        };
        const t =
          timeoutMs < Infinity
            ? setTimeout(
                () =>
                  w.done({
                    id,
                    state: 'timeout',
                    source: sc.source,
                    manifest: sc.manifestStatus,
                    total: sc.total,
                    built: sc.built,
                    skipped: sc.skipped,
                    ms: timeoutMs,
                  }),
                timeoutMs,
              )
            : null;
        focusWaiters.push(w);
        sc.promise.then(w.done);
        settleFocus();
      });
    },
    /** The focused scene is loaded (or a pause ended): every scene continues in priority order. */
    resume() {
      focusId = null;
      held = false;
      orderDirty = true;
      for (const sc of scenes.values()) if (sc.state === 'paused') sc.state = 'queued';
      kick();
    },
    /** Hold all background work (in-flight builds finish). `resume()` continues. */
    pause() {
      held = true;
      orderDirty = true;
      for (const sc of scenes.values()) if (sc.state === 'running') sc.state = 'paused';
    },
    /** Drop a scene's pending work; its promise resolves with state 'cancelled'. Programs already built stay built. */
    cancel(id) {
      const sc = scenes.get(String(id));
      if (!sc) return false;
      cancelScene(sc);
      if (focusId === sc.id) focusId = null;
      checkLoaded(); // (a game waiting on this scene's items)
      kick(); // (the focus is gone: the other scenes run again, and a quiet pump would not notice)
      return true;
    },
    /** Declare a safe window (a boot or loading screen, a results screen): `true`, `false`, or a function polled for it. `null` clears it. */
    window(on) {
      declared = on === undefined ? true : on;
      kick();
    },
    /**
     * Turn the library's idle inference off (`false`): only focus, a declared window (`window()`) and a hidden tab open one. For a queue on a renderer that does
     * NOT draw the app's frames (a hub's offscreen warmer): it cannot see whether the screen is static, so the app declares its quiet moments itself.
     */
    setInference(on) {
      inference = on !== false;
    },
    /** The screen the hub will play on, for the scale classes a live resize can reach: `{ width, height, dpr }` in CSS pixels. */
    setDisplay(d) {
      if (d && d.width > 0 && d.height > 0) {
        const dpr = d.dpr > 0 ? +d.dpr : 1;
        display = {
          width: +d.width,
          height: +d.height,
          dpr,
          maxClass: scale(d.width * dpr, d.height * dpr),
        };
      } else display = null;
      if (!ctx.active) {
        ctx.viewport = null;
        ctx.cls = null;
      } // (the later statement of where the next game plays wins: an older onResize's size is not it)
    },
    status,
    ready(id) {
      const sc = scenes.get(String(id));
      return sc ? sc.promise : Promise.resolve({ id: String(id), state: 'unknown' });
    },
    /** Resolves when nothing is runnable (everything done, or paused / held). */
    idle() {
      if (!runnableWork()) return Promise.resolve(status());
      kick();
      return new Promise((res) => idleWaiters.push(res));
    },
    /** Test and tool hook: run one step now, ignoring the window (the caller says it is safe). */
    _step(canvasOk = true) {
      const was = R._inferSlice;
      R._inferSlice = true;
      try {
        return step(canvasOk);
      } finally {
        R._inferSlice = was;
      }
    },
  };
  R.warm = warm;
  // a size change at frame entry (frameLoop.js) updates a running game's viewport class and re-evaluates what it needs, with no stall (the explicit onResize can block)
  const prevNote = R._noteViewportChange;
  R._noteViewportChange = (w, h) => {
    if (prevNote) prevNote(w, h);
    if (ctx.active && w >= 1 && h >= 1 && clsOf(w, h) !== ctx.cls) {
      try {
        warm.onResize(w, h);
      } catch {
        /* the queue never throws into a frame */
      }
    }
  };
  /// The policy's own account, for debugStats.warmPolicy and the tests.
  R._warmPolicyStats = () => ({
    game: ctx.active ? ctx.id : null,
    cls: ctx.cls,
    viewport: ctx.viewport,
    loading: ctx.loading,
    resizing: !!ctx.resizing,
    needed: ctx.needed.size,
    neededPending: ctx.active ? neededPending() : 0,
    totals: { ...totals },
    resizeMs: ctx.resizeMs.slice(),
    blockMs: ctx.blockMs.slice(),
    declared: ctx.declared ? ctx.declared.variants.size : 0,
  });
  warm._ctx = () => ctx;
  warm._order = () => {
    const l = runnable();
    for (const sc of l) if (!sc.expanded) expand(sc);
    if (orderDirty) buildOrder(l);
    return lastScores.slice();
  };
  R._warmQueueDispose = () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const sc of scenes.values()) finish(sc, 'cancelled');
    ctx.loading = false;
    ctx.resizing = false;
    while (ctx.loadWaiters.length)
      ctx.loadWaiters.shift()({
        id: ctx.id,
        cls: ctx.cls,
        needed: ctx.needed.size,
        ms: 0,
        disposed: true,
      });
    notifyIdle();
  };
  warm._items = (id) =>
    (scenes.get(String(id)) || { items: [] }).items.map((it) => ({
      kind: it.kind,
      k: it.k && it.k.slice(-40),
      kfull: it.k,
      st: it.st,
      tex: it.tex,
      why: it.why,
    }));
  return warm;
}
