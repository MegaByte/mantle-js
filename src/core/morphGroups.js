// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphGroups.js — the composition policy for opacity groups across two morph poses.
//
// A group is a begin row (FS_GROUP_BEGIN, 64) and an end row (FS_GROUP_END, 128) around the rows it composites; the begin row's
// fill alpha (meta slot 7) is the group opacity, and the renderer lerps it for a MATCHED begin row (renderer.js _groupBegin). The
// importer opens a group only when an element needs one (opacity below 1 over a fill AND a stroke, markers, a `<g opacity>`), so two
// poses of the same artwork can differ in whether a leaf is a group at all: opacity .5 in one pose, 1 in the other.
//
// POLICY. A leaf with no group is a group with opacity 1. A pose lacking a group over the same rows therefore gets a NEUTRAL partner:
//
//   * the source has the group, the target does not (.5 -> 1): the source's begin/end rows are matched to two virtual target rows
//     that are copies of them with opacity 1. Nothing is added to the merged bundle; the group keeps its place and its opacity
//     lerps from its own value to 1.
//   * the target has the group, the source does not (1 -> .5): two virtual SOURCE rows (copies of the target's, opacity 1) are
//     appended after the source's rows and matched to the target's begin/end rows. They are rows of the merged bundle like any
//     alias row: stable addresses at the end, scene order from `drawOrder`, which places the begin row before the first member and
//     the end row right after the last.
//   * both poses have it: the pair is matched by CONTENT (the same matched rows inside), not by position, and the opacity lerps.
//
// Rows are paired by what they wrap, never by where they sit, so a group that moved in the document, nested differently or changed
// size still lands around the same shapes. Only groups with opacity and an optional filter take part (no clip, mask or blend mode: those have a
// composition no neutral partner can stand for); every other group keeps the matching buildMorphPlan gave it. A set of groups
// that cannot nest in one scene order (partially overlapping spans) is left to that matching too: planMorphGroups returns false
// and changes nothing.
//
// The result is a plan whose group rows are ordinary matched rows, so every morph route (Slug/AAC GPU or CPU lerp, Loop-Blinn VS
// lerp, CPatch, the native morph) reads group opacity the way it already read a matched pair of groups.
import { curveRangesByShape, resolveLastShapeEnd, extractCurveFloats } from './morphCore.js';

const FS_GROUP_BEGIN = 64,
  FS_GROUP_END = 128,
  FS_LAYER = 256;
const SLOT_OPACITY = 7,
  SLOT_FLAGS = 27,
  SLOT_CLIP = 30,
  SLOT_MASK = 31,
  SLOT_FILTER = 32,
  SLOT_BLEND = 33;

/// The groups of rows lo..hi, outermost first, or null when begin and end rows do not balance inside the span.
/// Each: { b, e, members } where `members` lists every ordinary row inside it (nested groups' rows included), ascending.
export function parseGroups(bundle, lo, hi, stride) {
  const m = bundle.metaFloats,
    out = [],
    stack = [];
  let work = 0;
  for (let r = lo; r <= hi; r++) {
    const f = Math.round(m[r * stride + SLOT_FLAGS]);
    if (f & FS_LAYER) continue;
    if (f & FS_GROUP_BEGIN) {
      const g = { b: r, e: -1, members: [] };
      stack.push(g);
      out.push(g);
    } else if (f & FS_GROUP_END) {
      if (!stack.length) return null;
      stack.pop().e = r;
    } else {
      // Every row is listed in every group around it: a pathologically deep chain of groups over a big document would be quadratic.
      if ((work += stack.length) > MEMBER_BUDGET) return null;
      for (let i = 0; i < stack.length; i++) stack[i].members.push(r);
    }
  }
  return stack.length ? null : out;
}
const MEMBER_BUDGET = 4e6;

/// A group a neutral partner can stand for: opacity and an optional filter. A group with no filter is a group whose filter is none, so the
/// partner of a filtered group is a copy with no filter; the filter itself switches at the middle of the morph (morphFilters.js).
function opacityOnly(m, g, stride) {
  const o = g.b * stride;
  return !(m[o + SLOT_CLIP] > 0) && !(m[o + SLOT_MASK] > 0) && !(Math.round(m[o + SLOT_BLEND]) > 0);
}

const hasMarkers = (bundle, stride) => {
  const m = bundle.metaFloats;
  for (let r = 0, n = bundle.numShapes | 0; r < n; r++)
    if (Math.round(m[r * stride + SLOT_FLAGS]) & (FS_GROUP_BEGIN | FS_GROUP_END)) return true;
  return false;
};

/// `bundle` seen with `rows` (Float32Arrays of one meta row each) appended after its own rows. Appending keeps every existing row
/// address valid; the new rows have no curves, bands or ids. `dom` gives each new row's [shapeDomPath, shapeDomIndex] or null.
function extendBundle(bundle, rows, dom) {
  const n = bundle.numShapes | 0,
    k = rows.length,
    stride = bundle.metaFloatsPerShape || 48;
  const view = Object.create(bundle);
  const def = (key, value) =>
    Object.defineProperty(view, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  def('numShapes', n + k);
  const meta = new Float32Array((n + k) * stride);
  meta.set(bundle.metaFloats.subarray(0, n * stride));
  rows.forEach((r, i) => meta.set(r, (n + i) * stride));
  def('metaFloats', meta);
  const ranges = bundle.curveRangesByShape
    ? bundle.curveRangesByShape.map((r) => ({ begin: r.begin, end: r.end }))
    : curveRangesByShape(bundle);
  resolveLastShapeEnd(ranges, extractCurveFloats(bundle).length);
  for (let i = 0; i < k; i++) ranges.push({ begin: 0, end: 0 });
  def('curveRangesByShape', ranges);
  def(
    'shapeIds',
    (bundle.shapeIds || new Array(n).fill('')).slice(0, n).concat(new Array(k).fill('')),
  );
  if (bundle.shapeHrefs)
    def('shapeHrefs', bundle.shapeHrefs.slice(0, n).concat(new Array(k).fill('')));
  if (bundle.hitBits) {
    const h = new Uint8Array(n + k);
    for (let i = 0; i < n; i++) h[i] = bundle.hitBits[i];
    def('hitBits', h);
  }
  if (bundle.strokeMiterLimits) {
    const l = new Float32Array(n + k);
    for (let i = 0; i < n; i++) l[i] = bundle.strokeMiterLimits[i];
    def('strokeMiterLimits', l);
  }
  if (bundle.shapeDomPaths)
    def(
      'shapeDomPaths',
      Array.from({ length: n + k }, (_, i) =>
        i < n ? bundle.shapeDomPaths[i] : (dom[i - n] && dom[i - n][0]) || null,
      ),
    );
  if (bundle.shapeDomIndex) {
    const d = Array.from({ length: n + k }, (_, i) =>
      i < n ? bundle.shapeDomIndex[i] : dom[i - n] && dom[i - n][1] != null ? dom[i - n][1] : -1,
    );
    def('shapeDomIndex', bundle.shapeDomIndex instanceof Int32Array ? Int32Array.from(d) : d);
  }
  def('__morphInput', null);
  return view;
}

/// Pairs `Gs`/`Gd` that wrap the same matched rows, treats the groups that have no partner, and orders the scene. Mutates `plan`
/// (matched, srcOnly, dstOnly, finalShapeCount) and sets plan.srcView / plan.dstView / plan.sceneOrder when it acts.
/// Returns true when it acted, false (plan untouched) when no opacity group needs the policy or the scene cannot nest.
export function planMorphGroups(src, dst, plan, srcRange, dstRange) {
  const stride = src.metaFloatsPerShape || 48;
  if ((dst.metaFloatsPerShape || 48) !== stride || !src.metaFloats || !dst.metaFloats) return false;
  if (src._drawOrder || dst._drawOrder || src._morphSrc || dst._morphSrc) return false;
  if (!hasMarkers(src, stride) && !hasMarkers(dst, stride)) return false;
  const sm = src.metaFloats,
    dm = dst.metaFloats;
  const sLo = srcRange ? srcRange[0] : 0,
    sHi = srcRange ? srcRange[1] : src.numShapes - 1;
  const dLo = dstRange ? dstRange[0] : 0,
    dHi = dstRange ? dstRange[1] : dst.numShapes - 1;
  const gsAll = parseGroups(src, sLo, sHi, stride),
    gdAll = parseGroups(dst, dLo, dHi, stride);
  if (!gsAll || !gdAll) return false;
  const gs = gsAll.filter((g) => opacityOnly(sm, g, stride)),
    gd = gdAll.filter((g) => opacityOnly(dm, g, stride));
  if (!gs.length && !gd.length) return false;

  const toDst = new Map(),
    toSrc = new Map();
  for (const m of plan.matched) {
    toDst.set(m.srcIdx, m.dstIdx);
    toSrc.set(m.dstIdx, m.srcIdx);
  }

  // Content key of a group: the target rows its source rows match (source side), or its own rows that have a source match.
  const keyOf = (rows) =>
    rows
      .slice()
      .sort((a, b) => a - b)
      .join(',');
  const srcKey = (g) => keyOf(g.members.filter((r) => toDst.has(r)).map((r) => toDst.get(r)));
  const dstKey = (g) => keyOf(g.members.filter((r) => toSrc.has(r)));
  const dstByKey = new Map();
  for (const g of gd) {
    g.key = dstKey(g);
    if (!g.key) continue;
    (dstByKey.get(g.key) || dstByKey.set(g.key, []).get(g.key)).push(g);
  }
  const pairs = [],
    srcLonely = [],
    dstUsed = new Set();
  for (const g of gs) {
    g.key = srcKey(g);
    if (!g.key) continue; // wraps nothing that matched: the buildMorphPlan matching stands
    const list = dstByKey.get(g.key),
      partner = list && list.find((x) => !dstUsed.has(x));
    if (partner) {
      dstUsed.add(partner);
      pairs.push([g, partner]);
    } else srcLonely.push(g);
  }
  const dstLonely = gd.filter((g) => g.key && !dstUsed.has(g));
  // Already as the legacy matching has them, and nothing lonely: no change at all.
  if (
    !srcLonely.length &&
    !dstLonely.length &&
    pairs.every(([a, b]) => toDst.get(a.b) === b.b && toDst.get(a.e) === b.e)
  )
    return false;

  const srcRanges = src.curveRangesByShape || curveRangesByShape(src),
    dstRanges = dst.curveRangesByShape || curveRangesByShape(dst);
  resolveLastShapeEnd(srcRanges, extractCurveFloats(src).length);
  resolveLastShapeEnd(dstRanges, extractCurveFloats(dst).length);
  const n0 = src.numShapes | 0,
    nd0 = dst.numShapes | 0;

  // Virtual rows. A neutral partner is a copy of the real group's rows with opacity 1.
  const copyRow = (meta, row, opacity) => {
    const r = meta.slice(row * stride, (row + 1) * stride);
    if (opacity != null) r[SLOT_OPACITY] = opacity;
    r[SLOT_FILTER] = 0;
    return r;
  };
  const srcVirtual = [],
    srcVirtualDom = [],
    dstVirtual = [];
  const entries = []; // the new matched pairs
  const entry = (srcIdx, dstIdx, sRange, dRange) => ({
    srcIdx,
    dstIdx,
    srcBegin: sRange.begin,
    srcEnd: sRange.end,
    dstBegin: dRange.begin,
    dstEnd: dRange.end,
  });
  const groupOfRow = new Map(); // marker row (merged address) -> group identity, for the nesting check
  let gid = 0;
  for (const [a, b] of pairs) {
    entries.push(
      entry(a.b, b.b, srcRanges[a.b], dstRanges[b.b]),
      entry(a.e, b.e, srcRanges[a.e], dstRanges[b.e]),
    );
    a.id = ++gid;
    groupOfRow.set(a.b, a.id);
    groupOfRow.set(a.e, a.id);
  }
  const NONE = { begin: 0, end: 0 };
  for (const a of srcLonely) {
    const vb = nd0 + dstVirtual.length;
    dstVirtual.push(copyRow(sm, a.b, 1));
    dstVirtual.push(copyRow(sm, a.e, null));
    entries.push(entry(a.b, vb, srcRanges[a.b], NONE), entry(a.e, vb + 1, srcRanges[a.e], NONE));
    a.id = ++gid;
    groupOfRow.set(a.b, a.id);
    groupOfRow.set(a.e, a.id);
  }
  const virtualMembers = new Map(); // virtual begin row -> the source rows it wraps
  const lonelyRows = []; // [Gd, virtual begin row, virtual end row]
  for (const b of dstLonely) {
    const vb = n0 + srcVirtual.length;
    srcVirtual.push(copyRow(dm, b.b, 1), copyRow(dm, b.e, null));
    // The native scene reaches a row's element through these: the first member's.
    const first = toSrc.get(b.members.find((r) => toSrc.has(r)));
    const dom =
      first == null
        ? null
        : [
            src.shapeDomPaths ? src.shapeDomPaths[first] : null,
            src.shapeDomIndex ? src.shapeDomIndex[first] : null,
          ];
    srcVirtualDom.push(dom, dom);
    entries.push(entry(vb, b.b, NONE, dstRanges[b.b]), entry(vb + 1, b.e, NONE, dstRanges[b.e]));
    b.id = ++gid;
    groupOfRow.set(vb, b.id);
    groupOfRow.set(vb + 1, b.id);
    lonelyRows.push([b, vb, vb + 1]);
    virtualMembers.set(
      vb,
      b.members.filter((r) => toSrc.has(r)).map((r) => toSrc.get(r)),
    );
  }
  const treatedSrc = new Set(),
    treatedDst = new Set();
  for (const e of entries) {
    treatedSrc.add(e.srcIdx);
    treatedDst.add(e.dstIdx);
  }

  // The plan without the treated markers, and whatever they were matched to returned to the fades.
  const matched = [],
    srcOnly = plan.srcOnly.filter((s) => !treatedSrc.has(s.srcIdx));
  const dstOnlyIdx = new Set(
    plan.dstOnly.filter((d) => !treatedDst.has(d.dstIdx)).map((d) => d.dstIdx),
  );
  for (const m of plan.matched) {
    const sGone = treatedSrc.has(m.srcIdx),
      dGone = treatedDst.has(m.dstIdx);
    if (!sGone && !dGone) {
      matched.push(m);
      continue;
    }
    if (!sGone) srcOnly.push({ srcIdx: m.srcIdx });
    if (!dGone) dstOnlyIdx.add(m.dstIdx);
  }
  matched.push(...entries);
  const dstOnly = Array.from(dstOnlyIdx)
    .sort((x, y) => x - y)
    .map((dstIdx) => ({ dstIdx }));
  srcOnly.sort((x, y) => x.srcIdx - y.srcIdx);

  // Scene order: the source's rows in order, every row that has no source place (virtual source rows, target-only rows) inserted
  // where the target puts it: before the row of the next target row that has a place, and a virtual END row right after the
  // row of the previous one. Any other group's markers (untreated) ride the same rule as target-only rows.
  const nSrc = n0 + srcVirtual.length,
    total = nSrc + dstOnly.length;
  const toMerged = new Map();
  for (const m of matched) toMerged.set(m.dstIdx, m.srcIdx);
  dstOnly.forEach((d, k) => toMerged.set(d.dstIdx, nSrc + k));
  const next = new Int32Array(total + 1).fill(-2),
    prev = new Int32Array(total + 1).fill(-2),
    END = total;
  for (let i = 0; i < n0; i++) {
    next[i] = i + 1;
    prev[i] = i - 1;
  }
  if (n0) next[n0 - 1] = END;
  let head = n0 ? 0 : END;
  prev[END] = n0 - 1;
  const insertBefore = (row, anchor) => {
    const before = prev[anchor];
    if (before < 0) head = row;
    else next[before] = row;
    prev[row] = before;
    next[row] = anchor;
    prev[anchor] = row;
  };
  const insertAfter = (row, anchor) => {
    if (anchor < 0) {
      insertBefore(row, head);
    } else insertBefore(row, next[anchor]);
  };
  const virtualEnd = new Set(lonelyRows.map((r) => r[2]));
  let anchor = END;
  for (let j = dHi; j >= dLo; j--) {
    const row = toMerged.get(j);
    if (row === undefined) continue;
    if (row >= n0 && !virtualEnd.has(row)) insertBefore(row, anchor);
    if (!virtualEnd.has(row)) anchor = row;
  }
  // Virtual END rows, in target order: right after the previous placed row of the target.
  let last = -1;
  for (let j = dLo; j <= dHi; j++) {
    const row = toMerged.get(j);
    if (row === undefined) continue;
    if (virtualEnd.has(row)) insertAfter(row, last);
    else last = row;
    if (virtualEnd.has(row)) last = row;
  }
  const order = new Int32Array(total);
  {
    let row = head;
    for (let i = 0; i < total; i++) {
      if (row === END || row < 0) return false;
      order[i] = row;
      row = next[row];
    }
  }

  // Nest check: every group's begin and end rows close each other, in the merged scene order. The markers that belong to no treated
  // group keep the identity of the pose group they came from.
  const idOf = new Map(groupOfRow);
  let other = gid;
  for (const g of gsAll)
    if (!idOf.has(g.b)) {
      ++other;
      idOf.set(g.b, other);
      idOf.set(g.e, other);
    }
  for (const g of gdAll) {
    const mb = toMerged.get(g.b),
      me = toMerged.get(g.e);
    if (mb !== undefined && me !== undefined && !idOf.has(mb)) {
      ++other;
      idOf.set(mb, other);
      idOf.set(me, other);
    }
  }
  const stack = [];
  for (let i = 0; i < total; i++) {
    const row = order[i],
      id = idOf.get(row);
    if (id === undefined) continue;
    const f = Math.round(
      row < n0
        ? sm[row * stride + SLOT_FLAGS]
        : row < nSrc
          ? srcVirtual[row - n0][SLOT_FLAGS]
          : dm[dstOnly[row - nSrc].dstIdx * stride + SLOT_FLAGS],
    );
    if (f & FS_GROUP_BEGIN) stack.push(id);
    else if (f & FS_GROUP_END) {
      if (stack.pop() !== id) return false;
    }
  }
  if (stack.length) return false;

  // Commit.
  plan.matched = matched;
  plan.srcOnly = srcOnly;
  plan.dstOnly = dstOnly;
  plan.finalShapeCount = nSrc + dstOnly.length;
  plan.srcView = srcVirtual.length ? extendBundle(src, srcVirtual, srcVirtualDom) : null;
  plan.dstView = dstVirtual.length ? extendBundle(dst, dstVirtual, []) : null;
  plan.sceneOrder = order.every((r, i) => r === i) ? null : order;
  plan.groupPolicy = {
    pairs: pairs.length,
    srcLonely: srcLonely.length,
    dstLonely: dstLonely.length,
    virtualMembers,
  };
  return true;
}
