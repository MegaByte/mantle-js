// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// memoryStats.js -- renderer.getMemoryStats(), the scene memory budget, and the evictors the budget runs.
//
// The numbers come from the context's allocation ledger (memoryLedger.js): the nominal byte size of every texture, buffer and
// renderbuffer the library holds, by category and by owning bundle. The budget bounds that total. Policy, in order:
//
//   1. OPTIONAL resources ask first (admit): a Loop-Blinn mesh set, a CPatch plane, a static-cache raster, a point list, an opaque prepass
//      mesh (the depth prepass is then not drawn, which changes no pixel). If the budget would
//      be passed, the caches are evicted in a fixed order (below); if that is not enough the request is REFUSED with one warning per kind
//      and the scene draws without it, through a cheaper route (the cover/Slug route, a live draw instead of a cached raster).
//   2. ESSENTIAL resources (bundle textures, the frame's own targets, filter targets a draw is using) are never refused: a draw that
//      needs them cannot be skipped. If they push the total past the budget, the safe point (endFrame, and the end of a preparation call)
//      evicts what it may, and policy.overBudgetBytes reports the remainder honestly.
//   3. EVICTION ORDER: filter-result cache, then idle pools (released filter / coverage targets, idle shape and ping targets),
//      then the opaque prepass's meshes (rebuilt by one upload of the plan the bundle keeps), then the instanced draw's compacted meshes,
//      then the transient handles of bare draws (a bundle's cover mesh, mask table and mask layers, made again by its next draw), then
//      point lists, then the group atlas. Each stage frees least-recently-used first. nothing the current frame has used is evicted (a
//      stamped cache entry, an acquired pool target, a bound handle, an open atlas run), and bundles, createBundleHandle handles with
//      their mask arrays, and static-cache rasters are not evictable at all: dispose a bundle to free it.
import {
  ledgerFor,
  EVICTION_ORDER,
  preparationStats,
  resetPreparationStats,
} from './memoryLedger.js';
import { deleteGlResource } from './contextResources.js';
import { registeredRendererFeatures, getRendererFeature } from './featureRegistry.js';
import { lbPoolStats } from './lbWorkerPool.js';

const nowMs = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/** Unique ArrayBuffer bytes reachable from `root` through plain objects, arrays and typed arrays (a view and its parent count once). */
export function cpuBytesOf(root, maxNodes = 20000) {
  const seenObj = new Set(),
    seenBuf = new Set();
  let bytes = 0,
    nodes = 0;
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || nodes++ > maxNodes) return;
    if (ArrayBuffer.isView(v)) {
      const b = v.buffer;
      if (b && !seenBuf.has(b)) {
        seenBuf.add(b);
        bytes += b.byteLength;
      }
      return;
    }
    if (v instanceof ArrayBuffer) {
      if (!seenBuf.has(v)) {
        seenBuf.add(v);
        bytes += v.byteLength;
      }
      return;
    }
    if (seenObj.has(v) || depth > 4) return;
    seenObj.add(v);
    if (typeof Node !== 'undefined' && v instanceof Node) return;
    if (v instanceof Map) {
      for (const x of v.values()) walk(x, depth + 1);
      return;
    }
    if (v instanceof Set) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && i < 100000; i++) walk(v[i], depth + 1);
      return;
    }
    for (const k of Object.keys(v)) {
      if (k === 'gl' || k === 'canvas' || k === '_gl') continue;
      let x;
      try {
        x = v[k];
      } catch {
        continue;
      }
      if (typeof x === 'object') walk(x, depth + 1);
    }
  };
  walk(root, 0);
  return bytes;
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachMemoryStats(R) {
  const gl = R.gl;
  const L = ledgerFor(gl);
  const who = R;
  let budget = Infinity;
  let disposed = false;
  const stampNow = () => R._frameSerial | 0;
  // IN USE BY THE current FRAME. With frames (beginFrame has run): stamped with the current frame serial while a frame is open, or at the endFrame
  // safe point (the frame just drawn is the working set the next one wants); an API call BETWEEN frames (setMemoryBudget, prepareBundle) finds no
  // frame open, so nothing is in use. Without frames (beginFrame never called): touched in the last 250 ms.
  let endFrameMode = false;
  const inUse = (frame, t) =>
    stampNow() > 0
      ? (R._inFrame || endFrameMode) && frame === stampNow()
      : t != null && nowMs() - t < 250;

  // ---- evictors: each frees at least `need` bytes if it can, never anything in use ------------------------------------------------
  const ev = {
    filterCache(need) {
      const H = R._memHooks;
      if (!H) return 0;
      let freed = 0;
      for (const [k, c] of [...H.filterCache]) {
        if (freed >= need) break;
        if (inUse(c.frameSeen | 0, c._mt)) continue;
        const b = L.bytesOf(c.tex) + L.bytesOf(c.shapeTex);
        H.filterCache.delete(k);
        H.dropFilterEntry(c);
        freed += b;
      }
      return freed;
    },
    pools(need) {
      const H = R._memHooks;
      if (!H) return 0;
      let freed = H.pools.rt.shrink(need);
      if (freed < need) freed += H.pools.coverage.shrink(need - freed);
      for (const map of [H.pingTargets, H.shapeTargets]) {
        for (const [k, e] of [...map]) {
          if (freed >= need) break;
          if (String(k).startsWith('atlas:') || inUse(e.frame | 0, e.used)) continue;
          const b = L.bytesOf(e.tex) + L.bytesOf(e.rb);
          deleteGlResource(gl, 'Texture', e.tex);
          deleteGlResource(gl, 'Framebuffer', e.fbo);
          if (e.rb) deleteGlResource(gl, 'Renderbuffer', e.rb);
          map.delete(k);
          freed += b;
        }
      }
      return freed;
    },
    opaquePrepass(need) {
      return R._memEvictOpaquePrepass ? R._memEvictOpaquePrepass(need, inUse) : 0;
    },
    instancedMeshes(need) {
      return R._memEvictInstCompacts ? R._memEvictInstCompacts(need, inUse) : 0;
    },
    transientHandles(need) {
      return R._memEvictTransientHandles
        ? R._memEvictTransientHandles(need, inUse, () => L.total)
        : 0;
    },
    pointLists(need) {
      return R._memEvictPointLists ? R._memEvictPointLists(need, inUse) : 0;
    },
    atlas(need) {
      const H = R._memHooks;
      if (!H) return 0;
      const a = H.atlas;
      if (a.open || a.pend.length || a.flushing) return 0;
      let freed = 0;
      for (const [k, e] of [...H.shapeTargets]) {
        if (freed >= need) break;
        if (!String(k).startsWith('atlas:') || inUse(e.frame | 0, e.used)) continue;
        const b = L.bytesOf(e.tex) + L.bytesOf(e.rb);
        deleteGlResource(gl, 'Texture', e.tex);
        deleteGlResource(gl, 'Framebuffer', e.fbo);
        if (e.rb) deleteGlResource(gl, 'Renderbuffer', e.rb);
        H.shapeTargets.delete(k);
        if (a.rt === e) {
          a.rt = null;
          a.shelves.length = 0;
          a.shelfEnd = 0;
        }
        freed += b;
      }
      return freed;
    },
  };
  L.setEvictors(who, ev);

  function setMemoryBudget(bytes) {
    if (bytes === null || bytes === undefined) bytes = Infinity;
    if (typeof bytes !== 'number' || !(bytes >= 0))
      throw new Error(
        'setMemoryBudget: bytes must be a number >= 0 (Infinity or null is no limit), got ' +
          (typeof bytes === 'number' ? String(bytes) : typeof bytes),
      );
    budget = Math.floor(bytes);
    L.setBudget(who, budget);
    if (budget < Infinity) L.enforce();
  }
  R.setMemoryBudget = setMemoryBudget;
  R.getMemoryBudget = () => budget;
  /// Called by the optional-allocation sites. False = refuse and degrade.
  R._memAdmit = (bytes, what) => L.admit(bytes, what);
  /// Bytes the budget still has room for, floored to whole megabytes (Infinity with no budget); point lists the frame is not using count as room.
  R._memRoom = () => {
    const b = L.budget();
    if (!(b < Infinity)) return Infinity;
    const pl = R._memPointListStats ? R._memPointListStats().bytes : 0;
    return Math.max(0, Math.floor((b - L.total + pl) / 1048576)) * 1048576;
  };
  /// Safe point (endFrame, end of a preparation call): evict what the budget needs and may.
  R._memEnforce = (between) => {
    if (disposed || !(budget < Infinity)) return;
    endFrameMode = !between;
    try {
      L.enforce();
    } finally {
      endFrameMode = false;
    }
  };
  R._memDispose = () => {
    disposed = true;
    L.dropRenderer(who);
  };

  function bundleRows() {
    const rows = [];
    const owners = L.byOwner();
    const seen = new Set();
    for (const [owner, e] of owners) {
      if (!owner || typeof owner !== 'object') continue;
      seen.add(owner);
    }
    let id = 0;
    for (const [owner, e] of owners) {
      if (!owner || typeof owner !== 'object') continue;
      rows.push({
        id: ++id,
        label:
          [owner.label, owner.name, owner.id, owner.debugLabel].find(
            (x) => typeof x === 'string' && x,
          ) || null,
        shapes: owner.numShapes | 0,
        gpuBytes: e.total,
        textureBytes: e.texture,
        bufferBytes: e.buffer,
        renderbufferBytes: e.renderbuffer,
        byCategory: e.cats,
        cpuBytes: cpuBytesOf(owner),
        disposed: !!owner._disposed,
        bundle: owner,
      });
    }
    return rows;
  }

  /**
   * Byte-accurate memory report for this renderer's context.
   * @param {{ bundles?: boolean }} [opts]  `bundles: false` skips the per-bundle rows (their CPU walk is the only costly part).
   */
  R.getMemoryStats = (opts = {}) => {
    const snap = L.snapshot();
    const H = R._memHooks;
    const fcs = R._filterCacheStats ? R._filterCacheStats() : { entries: 0, bytes: 0 };
    const poolStat = (p) => {
      const [cw, ch] = R.viewportSize();
      return p.stats(cw, ch);
    };
    const pools = H ? { rt: poolStat(H.pools.rt), coverage: poolStat(H.pools.coverage) } : null;
    const sumMap = (m) => {
      let n = 0,
        bytes = 0;
      for (const e of m.values()) {
        n++;
        bytes += L.bytesOf(e.tex) + L.bytesOf(e.rb);
      }
      return { targets: n, bytes };
    };
    let atlasBytes = 0,
      atlasSize = 0;
    if (H)
      for (const [k, e] of H.shapeTargets)
        if (String(k).startsWith('atlas:')) {
          atlasBytes += L.bytesOf(e.tex) + L.bytesOf(e.rb);
          atlasSize = e.size[0];
        }
    const rows = opts.bundles === false ? null : bundleRows();
    const cat = (n) => (snap.byCategory[n] ? snap.byCategory[n].bytes : 0);
    const lb = lbPoolStats();
    // Registered renderer features report what they own through impl.memoryStats(); the core imports none of them.
    const features = {};
    for (const name of registeredRendererFeatures()) {
      const impl = getRendererFeature(name);
      if (impl && typeof impl.memoryStats === 'function') {
        try {
          features[name] = impl.memoryStats();
        } catch {
          features[name] = null;
        }
      }
    }
    const budgetNow = L.budget();
    return {
      disposed,
      budgetBytes: budgetNow,
      gpu: {
        totalBytes: snap.totalBytes,
        textureBytes: snap.textureBytes,
        bufferBytes: snap.bufferBytes,
        renderbufferBytes: snap.renderbufferBytes,
        peakBytes: snap.peakBytes,
        resources: snap.resources,
        byCategory: snap.byCategory,
        unpatched: snap.unpatched, // allocation / delete methods the context would not take a wrapper on (a forwarding Proxy): their bytes are not counted
      },
      caches: {
        filterCache: {
          entries: fcs.entries,
          bytes: cat('filterCache'),
          accountedBytes: fcs.bytes,
          retainBudgetBytes: H ? H.filterBudget.bytes : 0,
        },
        pools: pools && {
          rt: pools.rt,
          coverage: pools.coverage,
          shapeTargets: sumMap(H.shapeTargets),
          pingTargets: sumMap(H.pingTargets),
          categoryBytes: cat('pool'),
        },
        atlas: { bytes: atlasBytes, size: atlasSize },
        pointLists: R._memPointListStats
          ? R._memPointListStats()
          : { lists: 0, bytes: cat('points') },
        staticCache: { bytes: cat('staticCache') },
        loopBlinn: { projectedBytesInUse: R._lbMemUsed | 0, projectedCapBytes: R._lbMemCap },
        frameTargets: { bytes: cat('frameTargets') },
      },
      bundles: rows ? rows.map(({ bundle, ...r }) => r) : null,
      cpu: {
        bundleBytes: rows ? rows.reduce((n, r) => n + r.cpuBytes, 0) : null,
        workers: {
          loopBlinn: { pendingJobs: lb.pending, pendingInputBytes: lb.inputBytes },
        },
      },
      features,
      programs: { created: R._programsCreated | 0 },
      preparation: preparationStats(),
      policy: {
        order: EVICTION_ORDER.slice(),
        overBudgetBytes: L.policy.overBudgetBytes,
        evictions: JSON.parse(JSON.stringify(L.policy.evictions)),
        refusals: JSON.parse(JSON.stringify(L.policy.refusals)),
        enforcements: L.policy.enforcements,
      },
    };
  };
  R.resetMemoryPeaks = () => {
    L.resetPeak();
    resetPreparationStats();
  };
}
