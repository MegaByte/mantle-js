// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sceneUnion.js -- the define algebra behind renderer.setSceneUnion. Pure, so it is testable without a GL.
// A fill program is its define list. Bundles whose lists agree on the KERNEL CLASS (what changes the kernel set or the vertex wire) can
// bind one program whose presence defines are the union of theirs and whose omissions are the intersection of theirs: a superset of each
// member's lean program, so every member renders the same pixels.
export const KERNEL_CLASS_DEFS = new Set([
  'MANTLE_AAC',
  'MANTLE_HARD',
  'MANTLE_HARD_TREE',
  'MANTLE_GWN',
  'MANTLE_HARD_MIXED',
  'MANTLE_COVER_KERNEL',
  'MANTLE_LB_FILL',
  'MANTLE_LB_FILL_COV',
  'MANTLE_LB_MORPH',
  'MANTLE_LB_CURVE_TEX',
  'MANTLE_AAC_PAIR_BANDS',
  'MANTLE_ROTATED_MAP',
  'MANTLE_NO_COVER_FILL',
  'MANTLE_COVER_PAINT_ONLY',
  'MANTLE_PRIM_WALK',
]);
// a define that LEAVES CODE OUT or narrows a block (intersect), as against one that puts a kernel in (union)
export const isRestrictive = (d) =>
  /^MANTLE_(NO_|LB_NO_|CPATCH_NO_)/.test(d) ||
  d === 'MANTLE_CPATCH_QUADRATIC_AREA_ONLY' ||
  d === 'MANTLE_COVER_PAINT_ONLY';
export const classSig = (defs) =>
  defs
    .filter((d) => KERNEL_CLASS_DEFS.has(d))
    .sort()
    .join('|');
// The feature blocks whose presence multiplies a program's first pipeline build (a mask, a stroke, a pattern or an image block, with
// the curve kernels inlined into each: 0.1-0.2 s lean, 2.4 s with the four, 8 s with every curve type). A union does NOT cross them: a
// bundle without a mask never binds a program that carries one just because another bundle in the scene masks.
const HEAVY_OMISSIONS = [
  'MANTLE_NO_MASK',
  'MANTLE_NO_STROKE',
  'MANTLE_NO_PATTERN',
  'MANTLE_NO_IMAGE',
  'MANTLE_NO_FILTER',
];
export const heavySig = (defs) =>
  HEAVY_OMISSIONS.map((d) => (defs.includes(d) ? '1' : '0')).join('');
/// own: the defines of the drawn bundle; others: the defines of the scene's other members. Returns the union program's defines
/// (own, when no other member shares its class).
export function mergeSceneDefines(own, others) {
  const sig = classSig(own),
    hsig = heavySig(own);
  const group = [own, ...others.filter((d) => classSig(d) === sig && heavySig(d) === hsig)];
  if (group.length < 2) return own;
  const out = new Set(),
    count = new Map();
  for (const d of group)
    for (const x of d) {
      if (!isRestrictive(x)) out.add(x);
      else count.set(x, (count.get(x) || 0) + 1);
    }
  for (const [x, n] of count) if (n === group.length) out.add(x);
  return [...out];
}

// ---- THE WARM SUPERSET -------------------------------------------------------------------------------------------------------
// A draw whose own program is not ready (still linking, or linked with its Metal pipeline unbuilt) may draw with ANY program that is a
// pure OMISSION SUPERSET of its key and already has a built pipeline: the same kernels, the same wire, only more code left in. The program
// differs from the lean one by blocks the draw never reaches, so the pixels are the lean program's (kernel presence costs time, never
// output -- the rule the scene union and the base-program fallback already rest on).
//
// entry is a superset of want when
//   - their PRESENCE defines agree exactly (every non-omission define: the kernel class, the wire, the footprint), apart from the band
//     layout: a program that reads pair bands needs a pair-band bundle, while a stripe-reading program is still exact on one (it walks
//     each stripe's own part of every segment);
//   - every omission the entry carries, the want carries too (the entry leaves out nothing the want needs).
// A CPatch key is a PASS SELECTOR (area / seam), not a pure omission set, so it never stands in for another.
const PAIR_BANDS = 'MANTLE_AAC_PAIR_BANDS';
const RECOLOR_PARTS = ['MANTLE_NO_CHANNEL_LERP', 'MANTLE_NO_PALETTE', 'MANTLE_NO_COLOR_MATRIX'];
const isOmission = (d) => isRestrictive(d) && !KERNEL_CLASS_DEFS.has(d);
const splitKey = (k) => (k ? k.split('|') : []);
/// THE COVERAGE RELATION, one pure function. A program (its define key) COVERS a draw state (the defines the state needs) iff it includes everything the state
/// needs and omits nothing the state uses:
///   - PRESENCE (the kernels and the wire the state needs): every presence define of the state is in the program, and the program carries no presence define
///     the state lacks -- except, in 'net' mode, the benign extras (the rotated footprint, and the AAC kernel when `allowAacNet`);
///   - OMISSION (the blocks the program leaves out): every omission the program carries, the state carries too (a program never leaves out code the state reaches);
///   - the band layout: a program that reads pair bands needs a pair-band state.
/// Mode 'exact' (the warm superset: the same pixels, only more code left in) wants the presence sets equal; mode 'net' (the strict-play safety net) lets the
/// program carry the benign extras. A CPatch key is a pass selector, not a set of omissions, and never covers or is covered.
/// `isWarmSuperset` and `isNetFor` are this function with the mode fixed; the planner (which warms the maximal programs) and the stand-in selection both ask it.
export function coversDraw(programKey, neededKey, mode = 'exact', allowAacNet = true) {
  const e = splitKey(programKey),
    w = splitKey(neededKey);
  for (const d of e) if (d.startsWith('MANTLE_CPATCH')) return false;
  for (const d of w) if (d.startsWith('MANTLE_CPATCH')) return false;
  const wantSet = new Set(w);
  // NO_RECOLOR leaves out all three parts of the recolor block; a program that leaves out only some of them has more code, never less.
  if (wantSet.has('MANTLE_NO_RECOLOR')) for (const d of RECOLOR_PARTS) wantSet.add(d);
  const ePres = new Set(),
    wPres = new Set();
  for (const d of e) {
    if (isOmission(d)) {
      if (!wantSet.has(d)) return false;
    } else if (d !== PAIR_BANDS) ePres.add(d);
  }
  for (const d of w) if (!isOmission(d) && d !== PAIR_BANDS) wPres.add(d);
  for (const d of wPres) if (!ePres.has(d)) return false;
  for (const d of ePres) {
    if (wPres.has(d)) continue;
    if (mode === 'net' && (d === 'MANTLE_ROTATED_MAP' || (d === 'MANTLE_AAC' && allowAacNet)))
      continue;
    return false;
  }
  if (e.includes(PAIR_BANDS) && !wantSet.has(PAIR_BANDS)) return false;
  return true;
}
export function isWarmSuperset(entryKey, wantKey) {
  if (entryKey === wantKey) return false;
  return coversDraw(entryKey, wantKey, 'exact');
}
/// The SAFETY-NET rule (strictPlay): a net stands in for any want of its kernel family -- the same presence defines, or those plus the rotated
/// footprint (a program that computes the rotated map draws an axis-aligned draw correctly, only slower) -- whatever the want leaves out,
/// because a net leaves out nothing. CPatch keys are pass selectors and never nets.
export function isNetFor(netKey, wantKey, allowAacNet = true) {
  return coversDraw(netKey, wantKey, 'net', allowAacNet);
}
/// The leanest key among `candidates` (an iterable of keys) that is a warm superset of `wantKey`, or null. Leanest = the most omissions; a
/// candidate with the want's own band layout wins a tie.
export function pickWarmSuperset(wantKey, candidates) {
  let best = null,
    bestScore = -1;
  const wantPair = splitKey(wantKey).includes(PAIR_BANDS);
  for (const k of candidates) {
    if (!isWarmSuperset(k, wantKey)) continue;
    const ks = splitKey(k);
    const score = ks.filter(isOmission).length * 2 + (ks.includes(PAIR_BANDS) === wantPair ? 1 : 0);
    if (score > bestScore) {
      best = k;
      bestScore = score;
    }
  }
  return best;
}
