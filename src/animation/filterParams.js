// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Mutable filter parameters with bundle-local copy-on-write storage.
// Parameter writes invalidate filter results and cached raster mounts through
// _filterParamGen. Graph consumers must resolve filterGraphs by ID each frame.
// Structural changes, baked transfer LUTs, kernels, inline color matrices, and
// primitives omitted at import require rebuilding the imported asset.
import { unwrapBundle } from '../core/unwrapBundle.js';
import { mantleWarn } from '../core/diagnostics.js';

/// Numeric parameters that reach the GPU as a uniform (or are re-derived from
/// scratch at evaluation time), per primitive type. Anything not listed is
/// either structural, baked into a texture, or wiring.
const TWEENABLE = {
  feGaussianBlur: ['sigmaX', 'sigmaY'],
  feMorphology: ['operator', 'radiusX', 'radiusY'],
  feOffset: ['dx', 'dy'],
  feFlood: ['rgba'],
  feColorMatrix: ['matrix'],
  feComposite: ['op', 'k'],
  feBlend: ['mode'],
  feTurbulence: ['baseFreqX', 'baseFreqY', 'numOctaves', 'seed', 'kind', 'stitch'],
  feDisplacementMap: ['scale', 'xChan', 'yChan'],
  feDiffuseLighting: [
    'surfaceScale',
    'diffuseConstant',
    'specularConstant',
    'specularExponent',
    'lightColor',
    'lightType',
    'lightPos',
    'spotAt',
    'spotExp',
    'spotCosCone',
  ],
  feSpecularLighting: [
    'surfaceScale',
    'diffuseConstant',
    'specularConstant',
    'specularExponent',
    'lightColor',
    'lightType',
    'lightPos',
    'spotAt',
    'spotExp',
    'spotCosCone',
  ],
  feConvolveMatrix: ['divisor', 'bias'],
  feImage: [],
  feMerge: [],
  feTile: [],
  feComponentTransfer: [],
};

/// Why a primitive with no tweenable parameters has none. Stated per type so a
/// caller reading `targets` gets the answer without reading this file.
const WHY_NOT = {
  feComponentTransfer:
    'its transfer functions are baked to a 256x4 LUT at import; changing them is a re-bake, not a number',
  feImage: 'its source is an atlas slot chosen at import',
  feMerge: 'it carries no parameters — its inputs are graph wiring',
  feTile: 'it carries no parameters',
};

/// The single-primitive (non-graph) route keeps its numbers in 24 floats per
/// filter, mirrored on the CPU as `bundle.lastFilterFloats`. Texel 5 is always
/// (kind, sigmaX, sigmaY, _); the first texels are kind-specific. See
/// filterDraw.js `filterRecord`, which is what reads these every frame.
const SINGLE_KIND = {
  0: {
    name: 'colorMatrix',
    slots: null,
    why: 'the ubershader samples this one inline from filterTex; there is no offscreen pass to re-run, so it needs a texture write rather than a number',
  },
  1: { name: 'blur', slots: { sigmaX: 21, sigmaY: 22 } },
  7: { name: 'blur', slots: { sigmaX: 21, sigmaY: 22 } }, // the same blur on linear light (FILT_KIND_BLUR_LINEAR)
  5: { name: 'morphology', slots: { operator: 0, radiusX: 21, radiusY: 22 } },
  6: {
    name: 'convolve',
    slots: { divisor: 4, bias: 5 },
    why: 'the kernel VALUES are a 25-float row of bundle.lastKernelFloats, not a number; only divisor and bias are targets',
  },
};
const FLOATS_PER_FILTER = 24;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/// The domain of every tweenable parameter, from the primitive's own semantics (Filter Effects 1 section 15) and the
/// ranges the importer produces. A value outside it is not written: set() skips that field and warns once, so a
/// per-frame tween with a bad number does not poison the filter. The kinds:
///   finite   any finite number            nonneg  finite and >= 0
///   int:a:b  an integer in [a, b]          range:a:b a finite number in [a, b]
///   vec:n    n finite numbers              unit:n  n numbers in [0, 1]
const DOMAIN = {
  sigmaX: 'nonneg',
  sigmaY: 'nonneg',
  radiusX: 'nonneg',
  radiusY: 'nonneg',
  operator: 'int:0:1',
  dx: 'finite',
  dy: 'finite',
  rgba: 'unit:4',
  matrix: 'vec:20',
  op: 'int:0:5',
  k: 'vec:4',
  mode: 'int:0:15',
  baseFreqX: 'nonneg',
  baseFreqY: 'nonneg',
  numOctaves: 'int:1:6',
  seed: 'finite',
  kind: 'int:0:1',
  stitch: 'int:0:1',
  scale: 'finite',
  xChan: 'int:0:3',
  yChan: 'int:0:3',
  surfaceScale: 'finite',
  diffuseConstant: 'nonneg',
  specularConstant: 'nonneg',
  specularExponent: 'range:1:128',
  lightColor: 'unit:4',
  lightType: 'int:0:2',
  lightPos: 'vec:3',
  spotAt: 'vec:3',
  spotExp: 'finite',
  spotCosCone: 'finite',
  divisor: 'finite',
  bias: 'finite',
};

const isVec = (v) => Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));

/// Whether `v` lies in the parameter's domain (unknown names have none to violate).
function inDomain(name, v) {
  const d = DOMAIN[name];
  if (!d) return true;
  const [kind, a, b] = d.split(':');
  const lo = +a,
    hi = +b;
  switch (kind) {
    case 'finite':
      return isNum(v);
    case 'nonneg':
      return isNum(v) && v >= 0;
    case 'int':
      return isNum(v) && Number.isInteger(v) && v >= lo && v <= hi;
    case 'range':
      return isNum(v) && v >= lo && v <= hi;
    case 'vec':
    case 'unit': {
      if (!isVec(v) || v.length !== lo) return false;
      for (let i = 0; i < v.length; i++)
        if (!isNum(v[i]) || (kind === 'unit' && (v[i] < 0 || v[i] > 1))) return false;
      return true;
    }
    default:
      return true;
  }
}

const _warned = new Set();
/// `patch` reduced to the fields whose values are in their domain; each rejected field warns once per (id, name).
function validPatch(id, names, patch) {
  let out = patch;
  for (const n of names) {
    if (!(n in patch) || inDomain(n, patch[n])) continue;
    if (out === patch) out = { ...patch };
    delete out[n];
    const key = id + ':' + n;
    if (!_warned.has(key)) {
      _warned.add(key);
      mantleWarn(
        '[Mantle] filterParams.set(' +
          id +
          '): ' +
          n +
          ' = ' +
          String(patch[n]) +
          ' is outside its domain (' +
          DOMAIN[n].replace(/:/g, ' ') +
          '); not written.',
      );
    }
  }
  return out;
}

/** @typedef {object} MantleFilterTarget
 *  @property {string} id            address for get/set, e.g. 'f2:0' (graph node) or 'f1' (single)
 *  @property {number} filterId      1-based filter id, as the meta row stores it
 *  @property {number} nodeIndex     index into the graph's node list, or -1 on the single route
 *  @property {string} type          'feGaussianBlur' … , or 'blur' / 'morphology' / 'convolve' / 'colorMatrix'
 *  @property {string[]} tweenable   parameter names `set` accepts
 *  @property {string} [notTweenable] why this primitive has no tweenable parameters
 *  @property {string} [note]        a caveat that applies to this target (e.g. a dropped zero)
 */

/** @typedef {object} MantleFilterParams
 *  @property {MantleFilterTarget[]} targets  every primitive this bundle can tween, in filter order
 *  @property {(id: string) => (object|null)} get   current values (a copy), or null for an unknown id
 *  @property {(id: string, patch: object) => boolean} set  write numeric parameters; true if anything moved
 *  @property {() => boolean} reset   restore every imported value; true if anything moved
 *  @property {number} generation  bumps on every effective write; what the filter caches key on
 */

/**
 * Mutable view over a bundle's filter parameters.
 *
 * Only parameters that reach the GPU as uniforms (or are re-derived per
 * evaluation) are writable. Structural and baked inputs require reimport. The
 * returned object holds no GL state and needs no disposal.
 *
 * @param {object} bundle  createBundle output (or a morph handle's `.bundle`)
 * @returns {MantleFilterParams}
 */
export function createFilterParams(bundle) {
  bundle = unwrapBundle(bundle);
  if (!bundle) throw new TypeError('createFilterParams: a bundle is required');

  /** @type {MantleFilterTarget[]} */
  const targets = [];
  /** @type {Map<string, {filterId: number, nodeIndex: number, names: string[]}>} */
  const byId = new Map();
  /** id -> the imported values, for reset(). */
  const original = new Map();

  const graphs = Array.isArray(bundle.filterGraphs) ? bundle.filterGraphs : [];
  const floats = bundle.lastFilterFloats || null;
  const filterCount = Math.max(
    graphs.length,
    floats ? Math.floor(floats.length / FLOATS_PER_FILTER) : 0,
  );

  const snapshot = (names, src) => {
    const o = {};
    for (const n of names) {
      const v = src[n];
      o[n] = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(/** @type {any} */ (v)) : v;
    }
    return o;
  };

  for (let i = 0; i < filterCount; i++) {
    const filterId = i + 1;
    const g = graphs[i];
    if (g && g.nodes && g.nodes.length) {
      for (let n = 0; n < g.nodes.length; n++) {
        const node = g.nodes[n];
        const type = node && node.type;
        const names = TWEENABLE[type];
        if (names === undefined) continue; // a primitive this build does not know
        const id = `f${filterId}:${n}`;
        const t = {
          id,
          filterId,
          nodeIndex: n,
          type,
          tweenable: names.slice(),
        };
        if (!names.length) t.notTweenable = WHY_NOT[type] || 'this primitive carries no numbers';
        if (type === 'feGaussianBlur') {
          t.note =
            'a blur authored at zero sigma (stdDeviation="0", CSS blur(0)) keeps its node, so it can be tweened up from 0';
        }
        targets.push(t);
        byId.set(id, { filterId, nodeIndex: n, names });
        original.set(id, snapshot(names, (node && node.params) || {}));
      }
      continue;
    }
    if (!floats) continue;
    const off = i * FLOATS_PER_FILTER;
    if (off + FLOATS_PER_FILTER > floats.length) continue;
    const kind = floats[off + 20] | 0;
    const spec = SINGLE_KIND[kind];
    if (!spec) continue;
    const id = `f${filterId}`;
    const names = spec.slots ? Object.keys(spec.slots) : [];
    const t = { id, filterId, nodeIndex: -1, type: spec.name, tweenable: names.slice() };
    if (!names.length) t.notTweenable = spec.why || 'this filter carries no tweenable numbers';
    else if (spec.why) t.note = spec.why;
    if (kind === 1 || kind === 7) {
      t.note =
        'a blur authored at zero sigma (stdDeviation="0", CSS blur(0)) keeps its node on the graph route, so it can be tweened up from 0';
    }
    targets.push(t);
    byId.set(id, { filterId, nodeIndex: -1, names });
    const snap = {};
    for (const nme of names) snap[nme] = floats[off + spec.slots[nme]];
    original.set(id, snap);
  }

  let generation = 0;
  // Imported sections and morph sources can share graphs. Copy each touched
  // path so later writes also preserve peers created after an earlier write.
  const ownNode = (filterId, nodeIndex) => {
    const gi = filterId - 1;
    const g = bundle.filterGraphs[gi];
    const node = g.nodes[nodeIndex];
    const copy = { ...node, params: { ...(node.params || {}) } };
    const graph = { ...g, nodes: g.nodes.slice() };
    graph.nodes[nodeIndex] = copy;
    bundle.filterGraphs = bundle.filterGraphs.slice();
    bundle.filterGraphs[gi] = graph;
    return copy;
  };

  const writeGraph = (filterId, nodeIndex, names, patch) => {
    let moved = false;
    // Check first, copy second: a set() that changes nothing must not fork the
    // graph, or a caller polling every frame forks on frame one for no reason.
    const cur = bundle.filterGraphs[filterId - 1].nodes[nodeIndex].params || {};
    for (const n of names) {
      if (!(n in patch)) continue;
      const v = patch[n];
      const c = cur[n];
      if (isNum(v)) {
        if (v !== c) moved = true;
        continue;
      }
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        const a = /** @type {any} */ (v);
        if (!c || c.length !== a.length) {
          moved = true;
          continue;
        }
        for (let k = 0; k < a.length; k++)
          if ((c instanceof Float32Array ? Math.fround(a[k]) : a[k]) !== c[k]) {
            moved = true;
            break;
          }
      }
    }
    if (!moved) return false;
    const p = ownNode(filterId, nodeIndex).params;
    for (const n of names) {
      if (!(n in patch)) continue;
      const v = patch[n];
      if (isNum(v)) {
        p[n] = v;
        continue;
      }
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        const a = /** @type {any} */ (v);
        // Preserve the importer's vector type without mutating shared storage.
        const prev = p[n];
        const dst =
          ArrayBuffer.isView(prev) && !(prev instanceof DataView)
            ? new prev.constructor(a.length)
            : new Array(a.length);
        for (let k = 0; k < a.length; k++) dst[k] = a[k];
        p[n] = dst;
      }
    }
    return true;
  };

  const writeSingle = (filterId, patch) => {
    let plane = bundle.lastFilterFloats;
    const off = (filterId - 1) * FLOATS_PER_FILTER;
    const kind = plane[off + 20] | 0;
    const slots = SINGLE_KIND[kind] && SINGLE_KIND[kind].slots;
    if (!slots) return false;
    let moved = false;
    for (const n of Object.keys(slots)) {
      if (!(n in patch) || !isNum(patch[n])) continue;
      const at = off + slots[n];
      const value = Math.fround(patch[n]);
      if (!Number.isFinite(value) || plane[at] === value) continue;
      if (!moved) bundle.lastFilterFloats = plane = plane.slice();
      plane[at] = value;
      moved = true;
    }
    return moved;
  };

  // Standalone rather than methods, so a caller that destructures
  // (`const { set } = createFilterParams(b)`) keeps working — reset() calls
  // set() internally and a `this` there would break on the destructured form.
  const get = (id) => {
    const t = byId.get(id);
    if (!t) return null;
    if (t.nodeIndex < 0) {
      const floats = bundle.lastFilterFloats;
      const off = (t.filterId - 1) * FLOATS_PER_FILTER;
      const spec = SINGLE_KIND[floats[off + 20] | 0];
      const slots = (spec && spec.slots) || {};
      const o = {};
      for (const n of t.names) o[n] = floats[off + slots[n]];
      return o;
    }
    const node = bundle.filterGraphs[t.filterId - 1].nodes[t.nodeIndex];
    return snapshot(t.names, (node && node.params) || {});
  };
  const setChecked = (id, patch, trusted) => {
    const t = byId.get(id);
    if (!t || !patch) return false;
    // reset() writes the imported values, which are in the importer's domain by construction.
    if (!trusted) patch = validPatch(id, t.names, patch);
    const moved =
      t.nodeIndex < 0
        ? writeSingle(t.filterId, patch)
        : writeGraph(t.filterId, t.nodeIndex, t.names, patch);
    if (!moved) return false;
    // ONE counter for the whole bundle, not one per filter. Every filter cache
    // entry is already keyed per (filter, shape); a shared counter costs a
    // re-evaluation of filters that did not change, and a per-filter counter
    // would have to reach three key builders and the static cache's draw hash
    // to buy that back. Callers tween one filter at a time.
    bundle._filterParamGen = (bundle._filterParamGen | 0) + 1;
    generation++;
    return true;
  };
  const set = (id, patch) => setChecked(id, patch, false);
  const reset = () => {
    let moved = false;
    for (const [id, snap] of original) if (setChecked(id, snap, true)) moved = true;
    return moved;
  };

  return {
    targets,
    get,
    set,
    reset,
    get generation() {
      return generation;
    },
  };
}
