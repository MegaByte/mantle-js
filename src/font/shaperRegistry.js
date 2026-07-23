// shaperRegistry.js — opt-in registry for script-specific shapers.
//
// textRun.js reads from this registry instead of statically importing
// every script shaper at module load. Default state: no scripts
// registered → Latin / Cyrillic / Greek / pure-CJK only (the default
// OT shaper covers them). Consumers enable additional scripts by
// importing the corresponding subpath:
//
//   import { registerArabicShaping }  from '@kontek/mantle/font/scripts/arabic';
//   import { registerIndicShaping }   from '@kontek/mantle/font/scripts/indic';
//   import { registerThaiShaping }    from '@kontek/mantle/font/scripts/thai';
//   import { registerUseShaping }     from '@kontek/mantle/font/scripts/use';
//   import { registerHangulShaping }  from '@kontek/mantle/font/scripts/hangul';
//   import { registerMathStretchy }   from '@kontek/mantle/font/scripts/math';
//   registerArabicShaping();
//   ...
//
// Each script registers a hook object exposing the predicates and
// transforms textRun calls. Hooks the registry doesn't have are
// treated as "no-op" — the corresponding branch in textRun
// short-circuits via the null-check at the call site.
//
// This indirection is what lets tree-shaking + subpath exports drop
// the unused script modules entirely: a Latin-only consumer never
// imports any script subpath, the registry stays empty, and the
// bundler proves the shaper modules are unreachable.

// Each hook is null until its module calls register*. textRun's
// per-script branches check `!== null` before dereferencing.
let _arabic = null;     // { isArabicCodepoint, resolveArabicForms, getArabicJoiningType, ArabicJoiningType }
let _hangul = null;     // { isHangulJamo, classifyHangulJamo }
let _math   = null;     // { isCodepointStretchy, isAlwaysStretchy, targetStretchHeight }
let _indic  = null;     // { isIndicCodepoint, findIndicSyllables, reorderSyllable, reorderSyllableExplicitReph, hasInitialReph }
let _thai   = null;     // { isThaiLaoCodepoint, isThaiLaoMark, decomposeSaraAm }
let _use    = null;     // { isUseCodepoint, findUseClusters, reorderUseCluster }

export function registerArabicShaping(hook)  { _arabic = hook; }
export function registerHangulShaping(hook)  { _hangul = hook; }
export function registerMathStretchy(hook)   { _math   = hook; }
export function registerIndicShaping(hook)   { _indic  = hook; }
export function registerThaiShaping(hook)    { _thai   = hook; }
export function registerUseShaping(hook)     { _use    = hook; }

// Read-only accessors for textRun. Returning the hook (not individual
// functions) lets each branch destructure at the call site without
// re-checking each function for null.
export function getArabicShaping()  { return _arabic; }
export function getHangulShaping()  { return _hangul; }
export function getMathStretchy()   { return _math; }
export function getIndicShaping()   { return _indic; }
export function getThaiShaping()    { return _thai; }
export function getUseShaping()     { return _use; }
