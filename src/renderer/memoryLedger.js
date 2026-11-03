// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// memoryLedger.js -- byte-accurate GPU allocation ledger, one per WebGL context, and the preparation-peak accounting.
//
// WHAT IT COUNTS. Every texture, buffer and renderbuffer the library creates (each goes through trackGlResource) and its
// NOMINAL size: the bytes the allocating call asked for. texImage2D / texImage3D / texStorage2D / texStorage3D:
// width x height x depth x bytes-per-texel of the internal format, per level (generateMipmap adds the rest of the chain);
// bufferData: the size argument, or the data's byteLength (with the srcOffset / length overload); renderbufferStorage:
// width x height x bytes-per-pixel (x samples). Driver padding, alignment and compression are not visible to a page and are
// not counted. A resource the library did not create (the host's own textures on the same context) is never counted.
//
// HOW. The ledger wraps the allocation and delete entry points of the context ONCE (an own property per method; the wrapped
// call is made first and unchanged, then the bound object is read back with getParameter, which browsers answer from
// client-side state). Nothing here wraps a draw, bind or state call. A resource that is dropped without a delete is
// subtracted when it is garbage collected (FinalizationRegistry), so the total never exceeds what the page can still reach.
//
// PREPARATION PEAK. beginPreparation / endPreparation bracket createBundle, importSvg, prepare, createShapeMorph and the
// like. A bracket records the exact GPU high-water inside it, the CPU bytes the builders NOTED as transient
// (notePreparationBytes), and a JS heap high-water sampled at the bracket's edges and checkpoints where the host exposes one.

import { mantleWarn } from '../core/diagnostics.js';
import {
  forEachOpenPreparation,
  beginPreparation as beginPrep,
  withPreparation as withPrep,
} from '../core/preparation.js';
export {
  endPreparation,
  notePreparationBytes,
  preparationCheckpoint,
  preparationStats,
  resetPreparationStats,
} from '../core/preparation.js';

/** The order a budget evicts in: each stage frees only what the current frame is not using. Static-cache bakes and bundle resources are never evicted. */
export const EVICTION_ORDER = Object.freeze([
  'filterCache',
  'pools',
  'opaquePrepass',
  'instancedMeshes',
  'transientHandles',
  'pointLists',
  'atlas',
]);

const GL_NAMES = [
  'TEXTURE_BINDING_2D',
  'TEXTURE_BINDING_3D',
  'TEXTURE_BINDING_2D_ARRAY',
  'TEXTURE_BINDING_CUBE_MAP',
  'ARRAY_BUFFER_BINDING',
  'ELEMENT_ARRAY_BUFFER_BINDING',
  'COPY_READ_BUFFER_BINDING',
  'COPY_WRITE_BUFFER_BINDING',
  'PIXEL_PACK_BUFFER_BINDING',
  'PIXEL_UNPACK_BUFFER_BINDING',
  'UNIFORM_BUFFER_BINDING',
  'TRANSFORM_FEEDBACK_BUFFER_BINDING',
  'RENDERBUFFER_BINDING',
];

const FMT_BYTES = {
  R8: 1,
  R8_SNORM: 1,
  R8UI: 1,
  R8I: 1,
  RG8: 2,
  RG8_SNORM: 2,
  RG8UI: 2,
  RG8I: 2,
  RGB8: 3,
  RGB8_SNORM: 3,
  RGB8UI: 3,
  RGB8I: 3,
  RGBA8: 4,
  RGBA8_SNORM: 4,
  RGBA8UI: 4,
  RGBA8I: 4,
  SRGB8: 3,
  SRGB8_ALPHA8: 4,
  RGB10_A2: 4,
  RGB10_A2UI: 4,
  R11F_G11F_B10F: 4,
  RGB9_E5: 4,
  R16F: 2,
  R16UI: 2,
  R16I: 2,
  RG16F: 4,
  RG16UI: 4,
  RG16I: 4,
  RGB16F: 6,
  RGB16UI: 6,
  RGB16I: 6,
  RGBA16F: 8,
  RGBA16UI: 8,
  RGBA16I: 8,
  R32F: 4,
  R32UI: 4,
  R32I: 4,
  RG32F: 8,
  RG32UI: 8,
  RG32I: 8,
  RGB32F: 12,
  RGB32UI: 12,
  RGB32I: 12,
  RGBA32F: 16,
  RGBA32UI: 16,
  RGBA32I: 16,
  RGB565: 2,
  RGBA4: 2,
  RGB5_A1: 2,
  DEPTH_COMPONENT16: 2,
  DEPTH_COMPONENT24: 4,
  DEPTH_COMPONENT32F: 4,
  DEPTH24_STENCIL8: 4,
  DEPTH32F_STENCIL8: 8,
  STENCIL_INDEX8: 1,
};
const FORMAT_CHANNELS = {
  RGBA: 4,
  RGB: 3,
  RG: 2,
  RED: 1,
  ALPHA: 1,
  LUMINANCE: 1,
  LUMINANCE_ALPHA: 2,
  DEPTH_COMPONENT: 1,
  DEPTH_STENCIL: 1,
  RGBA_INTEGER: 4,
  RGB_INTEGER: 3,
  RG_INTEGER: 2,
  RED_INTEGER: 1,
};
const TYPE_BYTES = {
  UNSIGNED_BYTE: 1,
  BYTE: 1,
  UNSIGNED_SHORT: 2,
  SHORT: 2,
  HALF_FLOAT: 2,
  UNSIGNED_INT: 4,
  INT: 4,
  FLOAT: 4,
};
const PACKED_TYPE_BYTES = {
  UNSIGNED_SHORT_5_6_5: 2,
  UNSIGNED_SHORT_4_4_4_4: 2,
  UNSIGNED_SHORT_5_5_5_1: 2,
  UNSIGNED_INT_2_10_10_10_REV: 4,
  UNSIGNED_INT_10F_11F_11F_REV: 4,
  UNSIGNED_INT_5_9_9_9_REV: 4,
  UNSIGNED_INT_24_8: 4,
  FLOAT_32_UNSIGNED_INT_24_8_REV: 8,
};

const hasWeakRef = typeof WeakRef === 'function';
const wref = (o) => (hasWeakRef ? new WeakRef(o) : { deref: () => o });

const _ledgers = new Set();

const ledgers = new WeakMap();

/** @param {any} gl */
export function peekLedger(gl) {
  return ledgers.get(gl) || null;
}

/**
 * The context's ledger; the first call installs the allocation wrappers.
 * @param {any} gl
 */
export function ledgerFor(gl) {
  let L = ledgers.get(gl);
  if (L) return L;
  L = createLedger(gl);
  ledgers.set(gl, L);
  return L;
}

function createLedger(gl) {
  const meta = new WeakMap(); // resource -> rec
  const live = new Set(); // recs with bytes > 0
  const cats = new Map(); // category -> { bytes, count }
  const scopes = []; // default category stack
  const fmt = new Map(),
    bind = {};
  const registry =
    typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry((rec) => drop(rec))
      : null;
  const L = {
    gl,
    total: 0,
    peak: 0,
    textureBytes: 0,
    bufferBytes: 0,
    renderbufferBytes: 0,
    generation: 0,
    allocations: 0,
    deletions: 0,
    collected: 0,
    uncounted: 0,
    unpatched: /** @type {string[]} */ ([]),
    cats,
    live,
    installed: false,
  };

  function constants() {
    if (fmt.size) return;
    for (const k of Object.keys(FMT_BYTES)) {
      const v = gl[k];
      if (typeof v === 'number') fmt.set(v, FMT_BYTES[k]);
    }
    for (const k of GL_NAMES) {
      const v = gl[k];
      if (typeof v === 'number') bind[k] = v;
    }
  }
  const catOf = (c) => {
    let e = cats.get(c);
    if (!e) {
      e = { bytes: 0, count: 0 };
      cats.set(c, e);
    }
    return e;
  };

  function setBytes(rec, bytes) {
    const delta = bytes - rec.bytes;
    const wasLive = live.has(rec);
    if (!delta && wasLive === bytes > 0) return;
    const c = catOf(rec.cat);
    rec.bytes = bytes;
    L.total += delta;
    c.bytes += delta;
    if (rec.kind === 'texture') L.textureBytes += delta;
    else if (rec.kind === 'buffer') L.bufferBytes += delta;
    else L.renderbufferBytes += delta;
    if (bytes > 0 && !wasLive) {
      live.add(rec);
      c.count++;
    } else if (bytes <= 0 && wasLive) {
      live.delete(rec);
      c.count--;
    }
    if (delta > 0) {
      L.allocations++;
      if (L.total > L.peak) L.peak = L.total;
      forEachOpenPreparation((p) => {
        if (p.ledger === L && L.total - p.startGpu > p.gpuPeakDelta)
          p.gpuPeakDelta = L.total - p.startGpu;
      });
    }
  }
  function drop(rec) {
    if (!live.has(rec)) return;
    setBytes(rec, 0);
    rec.levels.clear();
    L.collected++;
  }
  function recFor(res, kind) {
    if (!res || (typeof res !== 'object' && typeof res !== 'function')) return null;
    const rec = meta.get(res);
    if (!rec) return null; // not created through trackGlResource: the host's, never counted
    if (!rec.kind) {
      rec.kind = kind;
      if (registry) registry.register(res, rec);
    }
    return rec;
  }
  function getBound(name) {
    const p = bind[name];
    if (p === undefined) return null;
    try {
      const o = gl.getParameter(p);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }
  function bpt(internal, format, type) {
    const sized = fmt.get(internal);
    if (sized) return sized;
    const nameOf = (tbl, v) => {
      for (const k of Object.keys(tbl)) if (gl[k] === v) return k;
      return null;
    };
    const pk = nameOf(PACKED_TYPE_BYTES, type);
    if (pk) return PACKED_TYPE_BYTES[pk];
    const ch =
      FORMAT_CHANNELS[nameOf(FORMAT_CHANNELS, format) || nameOf(FORMAT_CHANNELS, internal) || ''] ||
      4;
    const tb = TYPE_BYTES[nameOf(TYPE_BYTES, type) || ''] || 1;
    return ch * tb;
  }
  const texBind = (target) => {
    if (target === gl.TEXTURE_2D) return 'TEXTURE_BINDING_2D';
    if (target === gl.TEXTURE_2D_ARRAY) return 'TEXTURE_BINDING_2D_ARRAY';
    if (target === gl.TEXTURE_3D) return 'TEXTURE_BINDING_3D';
    return 'TEXTURE_BINDING_CUBE_MAP';
  };
  const levelKey = (target, level) =>
    (target === gl.TEXTURE_2D || target === gl.TEXTURE_2D_ARRAY || target === gl.TEXTURE_3D
      ? 0
      : target) +
    ':' +
    level;
  function texLevel(target, level, w, h, d, perTexel) {
    const rec = recFor(getBound(texBind(target)), 'texture');
    if (!rec) {
      L.uncounted++;
      return;
    }
    rec.levels.set(
      levelKey(target, level),
      Math.max(0, w) * Math.max(0, h) * Math.max(1, d) * perTexel,
    );
    rec.base = { w, h, d: Math.max(1, d), perTexel, target };
    let sum = 0;
    for (const b of rec.levels.values()) sum += b;
    setBytes(rec, sum);
  }
  const srcDims = (s) => {
    if (!s) return [0, 0];
    const w = s.naturalWidth || s.videoWidth || s.displayWidth || s.width || 0;
    const h = s.naturalHeight || s.videoHeight || s.displayHeight || s.height || 0;
    return [w, h];
  };
  function install() {
    constants();
    const patch = (name, wrap) => {
      const orig = gl[name];
      if (typeof orig !== 'function') return;
      const wrapper = function (...a) {
        const r = orig.apply(gl, a);
        try {
          wrap(a);
        } catch {
          /* accounting never breaks a GL call */
        }
        return r;
      };
      gl[name] = wrapper;
      // A Proxy (or any object) that answers method reads with its own closure over the target would call the allocation wrapper, which calls that
      // closure again: a loop. If the property does not read back as ours, take it off and leave the method uncounted.
      if (gl[name] !== wrapper) {
        try {
          delete gl[name];
        } catch {
          /* nothing to restore */
        }
        L.unpatched.push(name);
      }
    };
    patch('texImage2D', (a) => {
      if (a.length >= 9) texLevel(a[0], a[1], a[3], a[4], 1, bpt(a[2], a[6], a[7]));
      else if (a.length === 6) {
        const [w, h] = srcDims(a[5]);
        texLevel(a[0], a[1], w, h, 1, bpt(a[2], a[3], a[4]));
      }
    });
    patch('texImage3D', (a) => {
      if (a.length >= 10) texLevel(a[0], a[1], a[3], a[4], a[5], bpt(a[2], a[7], a[8]));
    });
    const storage = (a, depth) => {
      const rec = recFor(getBound(texBind(a[0])), 'texture');
      if (!rec) {
        L.uncounted++;
        return;
      }
      const perTexel = fmt.get(a[2]) || 4;
      let w = a[3],
        h = a[4],
        d = depth ? a[5] : 1;
      const is3D = a[0] === gl.TEXTURE_3D;
      rec.levels.clear();
      for (let l = 0; l < a[1]; l++) {
        rec.levels.set(levelKey(a[0], l), w * h * d * perTexel);
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        if (is3D) d = Math.max(1, d >> 1);
      }
      rec.base = { w: a[3], h: a[4], d: depth ? a[5] : 1, perTexel, target: a[0] };
      let sum = 0;
      for (const b of rec.levels.values()) sum += b;
      setBytes(rec, sum);
    };
    patch('texStorage2D', (a) => storage(a, false));
    patch('texStorage3D', (a) => storage(a, true));
    patch('generateMipmap', (a) => {
      const rec = recFor(getBound(texBind(a[0])), 'texture');
      if (!rec || !rec.base) return;
      let { w, h, d, perTexel, target } = rec.base;
      const is3D = target === gl.TEXTURE_3D;
      for (let l = 1; w > 1 || h > 1 || (is3D && d > 1); l++) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        if (is3D) d = Math.max(1, d >> 1);
        rec.levels.set(levelKey(target, l), w * h * d * perTexel);
      }
      let sum = 0;
      for (const b of rec.levels.values()) sum += b;
      setBytes(rec, sum);
    });
    patch('bufferData', (a) => {
      const names = {
        [gl.ARRAY_BUFFER]: 'ARRAY_BUFFER_BINDING',
        [gl.ELEMENT_ARRAY_BUFFER]: 'ELEMENT_ARRAY_BUFFER_BINDING',
        [gl.COPY_READ_BUFFER]: 'COPY_READ_BUFFER_BINDING',
        [gl.COPY_WRITE_BUFFER]: 'COPY_WRITE_BUFFER_BINDING',
        [gl.PIXEL_PACK_BUFFER]: 'PIXEL_PACK_BUFFER_BINDING',
        [gl.PIXEL_UNPACK_BUFFER]: 'PIXEL_UNPACK_BUFFER_BINDING',
        [gl.UNIFORM_BUFFER]: 'UNIFORM_BUFFER_BINDING',
        [gl.TRANSFORM_FEEDBACK_BUFFER]: 'TRANSFORM_FEEDBACK_BUFFER_BINDING',
      };
      const rec = recFor(getBound(names[a[0]] || 'ARRAY_BUFFER_BINDING'), 'buffer');
      if (!rec) {
        L.uncounted++;
        return;
      }
      const d = a[1];
      let bytes;
      if (typeof d === 'number') bytes = d;
      else if (d == null) bytes = 0;
      else {
        const bpe = d.BYTES_PER_ELEMENT || 1;
        const off = a.length > 3 ? a[3] | 0 : 0;
        const len = a.length > 4 && a[4] ? a[4] : d.byteLength / bpe - off;
        bytes = a.length > 3 && d.BYTES_PER_ELEMENT ? len * bpe : d.byteLength;
      }
      setBytes(rec, Math.max(0, bytes));
    });
    const rbStore = (a, samples) => {
      const rec = recFor(getBound('RENDERBUFFER_BINDING'), 'renderbuffer');
      if (!rec) {
        L.uncounted++;
        return;
      }
      const [w, h, fmtId] = samples ? [a[3], a[4], a[2]] : [a[2], a[3], a[1]];
      setBytes(rec, w * h * (fmt.get(fmtId) || 4) * (samples ? Math.max(1, a[1] | 0) : 1));
    };
    patch('renderbufferStorage', (a) => rbStore(a, false));
    patch('renderbufferStorageMultisample', (a) => rbStore(a, true));
    const noteDeleted = (res) => {
      const rec = res && meta.get(res);
      if (rec && live.has(rec)) {
        setBytes(rec, 0);
        rec.levels.clear();
        L.deletions++;
      }
    };
    L.noteDeleted = noteDeleted;
    const del = (name) => patch(name, (a) => noteDeleted(a[0]));
    del('deleteTexture');
    del('deleteBuffer');
    del('deleteRenderbuffer');
    L.installed = true;
  }

  /** Register a created resource with its category and owner (an object or a string key). */
  L.register = (res, cat, owner) => {
    if (!res || (typeof res !== 'object' && typeof res !== 'function')) return res;
    let rec = meta.get(res);
    if (!rec) {
      rec = {
        ref: wref(res),
        kind: null,
        cat: cat || scopes[scopes.length - 1] || 'other',
        owner: null,
        bytes: 0,
        levels: new Map(),
        base: null,
      };
      meta.set(res, rec);
    } else if (cat) retag(rec, cat);
    if (owner != null) rec.owner = typeof owner === 'object' ? wref(owner) : owner;
    return res;
  };
  function retag(rec, cat) {
    if (rec.cat === cat) return;
    if (live.has(rec)) {
      const a = catOf(rec.cat),
        b = catOf(cat);
      a.bytes -= rec.bytes;
      a.count--;
      b.bytes += rec.bytes;
      b.count++;
    }
    rec.cat = cat;
  }
  /** Re-categorize and re-own an already registered resource (no-op for one the library did not create). */
  L.tag = (res, cat, owner) => {
    const rec = res && meta.get(res);
    if (!rec) return;
    if (cat) retag(rec, cat);
    if (owner != null) rec.owner = typeof owner === 'object' ? wref(owner) : owner;
  };
  /** Bytes of one resource (0 when unknown or not allocated). */
  L.bytesOf = (res) => {
    const rec = res && meta.get(res);
    return rec ? rec.bytes : 0;
  };
  /** Claim every ledger-known resource held directly on `holder` (a bundle, a handle) for `cat` and the holder as owner. */
  L.adopt = (holder, cat) => {
    if (!holder || typeof holder !== 'object') return;
    for (const k of Object.keys(holder)) {
      const v = holder[k];
      if (v && typeof v === 'object') {
        const rec = meta.get(v);
        if (rec) {
          if (cat && (rec.cat === 'bundle' || rec.cat === 'other')) retag(rec, cat);
          rec.owner = wref(holder);
        }
      }
    }
  };
  L.pushScope = (cat) => {
    scopes.push(cat);
  };
  L.popScope = () => {
    scopes.pop();
  };
  L.ownerOf = (rec) => {
    const o = rec.owner;
    return o && typeof o === 'object' && 'deref' in o ? o.deref() : o;
  };
  /** Live resources of one owner (object identity) or category. */
  L.each = (fn) => {
    for (const rec of live) fn(rec, rec.ref.deref());
  };
  L.byOwner = () => {
    const map = new Map();
    for (const rec of live) {
      const o = L.ownerOf(rec);
      if (o == null) continue;
      let e = map.get(o);
      if (!e) {
        e = { owner: o, texture: 0, buffer: 0, renderbuffer: 0, total: 0, count: 0, cats: {} };
        map.set(o, e);
      }
      e[rec.kind] += rec.bytes;
      e.total += rec.bytes;
      e.count++;
      e.cats[rec.cat] = (e.cats[rec.cat] || 0) + rec.bytes;
    }
    return map;
  };
  L.resetPeak = () => {
    L.peak = L.total;
  };

  // ---- budget, eviction, admission -------------------------------------------------------------------------------------------
  const budgets = new Map(); // renderer -> bytes
  const evictors = new Map(); // renderer -> { stage: fn(needBytes) -> freedBytes }
  const policy = {
    evictions: {},
    refusals: {},
    warned: new Set(),
    overBudgetBytes: 0,
    enforcements: 0,
  };
  L.policy = policy;
  L.setBudget = (who, bytes) => {
    if (bytes === Infinity || bytes == null) budgets.delete(who);
    else budgets.set(who, bytes);
  };
  L.dropRenderer = (who) => {
    budgets.delete(who);
    evictors.delete(who);
  };
  L.setEvictors = (who, fns) => {
    evictors.set(who, fns);
  };
  /** The tightest budget of the renderers on this context (Infinity = none). */
  L.budget = () => {
    let b = Infinity;
    for (const v of budgets.values()) if (v < b) b = v;
    return b;
  };
  let evicting = false;
  /** Free bytes, in EVICTION_ORDER, until total + need fits the budget. Returns true when it fits. */
  L.evictFor = (need) => {
    const budget = L.budget();
    if (!(budget < Infinity)) return true;
    if (evicting) return L.total + need <= budget;
    evicting = true;
    try {
      for (const stage of EVICTION_ORDER) {
        for (const fns of evictors.values()) {
          const over = L.total + need - budget;
          if (over <= 0) return true;
          const fn = fns[stage];
          if (!fn) continue;
          const before = L.total;
          fn(over);
          const freed = before - L.total;
          if (freed > 0) {
            const e = policy.evictions[stage] || (policy.evictions[stage] = { count: 0, bytes: 0 });
            e.count++;
            e.bytes += freed;
          }
        }
      }
    } finally {
      evicting = false;
    }
    return L.total + need <= budget;
  };
  const warnOnce = (key, msg) => {
    if (policy.warned.has(key)) return;
    policy.warned.add(key);
    try {
      mantleWarn(msg);
    } catch {
      /* ignore */
    }
  };
  /** Ask to allocate `bytes` more for an OPTIONAL resource (`what` names it). Evicts, then refuses with a warning when it would pass the budget. */
  L.admit = (bytes, what) => {
    const budget = L.budget();
    if (!(budget < Infinity) || !(bytes > 0)) return true;
    // Eviction cannot make an allocation larger than the entire budget fit.
    if (L.total + bytes <= budget || (bytes <= budget && L.evictFor(bytes))) return true;
    const r = policy.refusals[what] || (policy.refusals[what] = { count: 0, bytes: 0 });
    r.count++;
    r.bytes += bytes;
    const key = 'refuse:' + what;
    if (!policy.warned.has(key))
      warnOnce(
        key,
        `[mantle] memory budget: ${what} needs ${bytes} bytes, ${L.total} of the ${budget}-byte budget are in use; ` +
          (what === 'loopBlinn mesh' || what === 'CPatch plane'
            ? 'it is not allocated and this bundle uses the cover/Slug fallback, even when the engine is explicitly pinned. '
            : 'it is not allocated and the scene draws without it (a cheaper route). ') +
          'Raise memoryBudgetBytes or dispose unused bundles. Inspect getMemoryStats().policy.refusals for refused resources.',
      );
    return false;
  };
  /** Safe-point enforcement: evict to fit, and note by how much the in-use set still exceeds the budget. */
  L.enforce = () => {
    const budget = L.budget();
    policy.enforcements++;
    if (!(budget < Infinity)) {
      policy.overBudgetBytes = 0;
      return;
    }
    L.evictFor(0);
    policy.overBudgetBytes = Math.max(0, L.total - budget);
    if (policy.overBudgetBytes > 0 && !policy.warned.has('over'))
      warnOnce(
        'over',
        `[mantle] memory budget: ${L.total} bytes are in use against a ${budget}-byte budget and all of the excess is held by the current frame or by live bundles, ` +
          'which are never evicted. See getMemoryStats().policy.overBudgetBytes.',
      );
  };
  /** Context lost: every resource died with it. */
  L.reset = () => {
    for (const rec of [...live]) {
      setBytes(rec, 0);
      rec.levels.clear();
    }
    L.generation++;
    L.peak = 0;
  };
  L.snapshot = () => {
    const byCategory = {};
    for (const [c, e] of cats)
      if (e.bytes || e.count) byCategory[c] = { bytes: e.bytes, resources: e.count };
    return {
      totalBytes: L.total,
      textureBytes: L.textureBytes,
      bufferBytes: L.bufferBytes,
      renderbufferBytes: L.renderbufferBytes,
      peakBytes: L.peak,
      resources: live.size,
      byCategory,
      unpatched: L.unpatched.slice(),
    };
  };
  install();
  _ledgers.add(L);
  return L;
}

/** @param {any} gl @param {any} res @param {string} [cat] @param {any} [owner] */
export function registerGl(gl, res, cat, owner) {
  return ledgerFor(gl).register(res, cat, owner);
}

/**
 * Open a preparation bracket whose GPU high-water is read from this context's ledger. Close it with endPreparation.
 * @param {string} label @param {any} [gl]
 */
export function beginPreparation(label, gl) {
  return beginPrep(label, gl ? ledgerFor(gl) : null);
}
/** Run `fn` inside a bracket (sync or async) that records this context's GPU high-water. @param {string} label @param {any} gl @param {() => any} fn */
export function withPreparation(label, gl, fn) {
  return withPrep(label, gl ? ledgerFor(gl) : null, fn);
}
