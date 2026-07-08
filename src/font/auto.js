// font/auto — automatic, tree-shaking-friendly reader/shaper registration.
//
//   import { autoRegisterForFont } from '@kontek/mantle/font/auto';
//   const { bytes, registered } = await autoRegisterForFont(rawFontBytes);
//   const asset = MantleFontAsset.fromBytes(bytes);   // ready to render
//
// Sniffs a font's sfnt table directory (and GSUB/GPOS script list) and
// registers exactly the optional subsystems that font needs — CFF
// outlines, variable-font readers, colour-glyph formats, MATH, AAT,
// legacy kern, vertical / baseline / justification tables, the right
// script shaper(s), and bidi for RTL scripts.
//
// Tree-shakes because every optional subsystem is pulled with a dynamic
// `import()`, so a bundler splits each into its own lazily loaded chunk.
// The initial bundle carries only the always-on core (glyf outlines +
// cmap + GSUB/GPOS + the default OT shaper); optional chunks load on
// demand the first time a font that needs them is registered. The
// `@kontek/mantle/font` barrel instead eagerly registers (and bundles)
// everything.
//
// WOFF2 input is detected and decoded first, so the returned `bytes` are
// always raw sfnt ready for MantleFontAsset.

import { parseTtfTables } from './ttfTables.js';
import { decodeIfWoff2 } from './fontAsset.js';

function _isWoff2(b) {
  return b && b.length >= 4 &&
    b[0] === 0x77 && b[1] === 0x4F && b[2] === 0x46 && b[3] === 0x32; // 'wOF2'
}

// RTL coverage from OS/2 ulUnicodeRange1 (offset 42, u32 big-endian).
// This is GSUB-independent, so it also flags AAT fonts (e.g. GeezaPro)
// that shape Arabic via morx and have no GSUB 'arab' script tag.
//   bit 11 = Hebrew (U+0590–05FF), bit 13 = Arabic (U+0600–06FF).
function _os2HasRtl(view, os2Rec) {
  if (!os2Rec) return false;
  const range1 = view.getUint32(os2Rec[0] + 42, false);
  return (range1 & (1 << 11)) !== 0 || (range1 & (1 << 13)) !== 0;
}

// Enumerate 4-char ScriptList tags from a GSUB/GPOS table record [off,len].
// GSUB/GPOS header: u16 major, u16 minor, u16 scriptListOffset (+4).
function _collectScriptTags(view, rec, out) {
  if (!rec) return;
  const base = rec[0];
  const slOff = base + view.getUint16(base + 4, false);
  const count = view.getUint16(slOff, false);
  for (let i = 0; i < count; i++) {
    const p = slOff + 2 + i * 6;
    out.add(String.fromCharCode(
      view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3)));
  }
}

// OT script tags (incl. the v2 '...2' Indic variants) → shaper subpath.
const _INDIC = new Set([
  'deva', 'dev2', 'beng', 'bng2', 'guru', 'gur2', 'gujr', 'gjr2',
  'orya', 'ory2', 'taml', 'tml2', 'telu', 'tel2', 'knda', 'knd2',
  'mlym', 'mlm2', 'sinh',
]);
// USE (Universal Shaping Engine) scripts — pragmatic common subset.
const _USE = new Set([
  'khmr', 'mymr', 'mym2', 'java', 'bali', 'sund', 'batk', 'tglg',
  'buhd', 'tagb', 'cham', 'tale', 'talu', 'lana', 'cakm', 'bugi',
  'tfng', 'mtei', 'newa', 'gran', 'tibt',
]);
// RTL scripts that need the bidi reorder pass.
const _RTL = new Set([
  'arab', 'hebr', 'syrc', 'thaa', 'nko ', 'adlm', 'rohg', 'yezi',
  'mand', 'samr', 'mend',
]);

/**
 * Sniff `bytes` and return the optional reader/shaper modules the font
 * needs — without registering them. Shared detection layer: the runtime
 * `autoRegisterForFont` dynamic-imports each module, and the build
 * generator (scripts/genFeatureEntry.mjs) emits each as a static import.
 * One sniff drives both, so they never diverge.
 *
 * Each module is `{ pkg, register, label }`: `pkg` is the package-relative
 * subpath (e.g. `font/formats/cff`, resolves to `@kontek/mantle/<pkg>`) and
 * `register` is the registration function it exports.
 *
 * @param {Uint8Array} bytes  Raw font bytes (sfnt, TTC, or WOFF2).
 * @param {object} [opts]
 * @param {number} [opts.faceIndex=0]  TTC face to inspect.
 * @param {boolean} [opts.bidi]  Force-enable (true) or suppress (false) bidi
 *   regardless of script detection. Default: auto (RTL scripts → on).
 * @returns {Promise<{sfnt: Uint8Array, modules: {pkg:string,register:string,label:string}[]}>}
 *   `sfnt` is raw sfnt (WOFF2-decoded if needed; decoding needs the woff2
 *   reader, so that one module is pulled in here to sniff).
 */
export async function detectFontModules(bytes, opts = {}) {
  const faceIndex = opts.faceIndex || 0;
  const modules = [];
  const add = (cond, pkg, register) => { if (cond) modules.push({ pkg, register, label: pkg }); };

  // 1. WOFF2 → must decode to sfnt before the table directory can be
  // sniffed, and decoding needs the woff2 reader registered. This module
  // is imported here; it's still recorded so the build generator emits it
  // (runtime woff2 handling needs it registered too).
  let sfnt = bytes;
  if (_isWoff2(bytes)) {
    add(true, 'font/formats/woff2', 'registerWoff2Reader');
    const m = await import('@kontek/mantle/font/formats/woff2');
    m.registerWoff2Reader();
    sfnt = await decodeIfWoff2(bytes);
  }

  // NFC + grapheme segmentation are universal to text (not font-table-driven),
  // so the auto-resolver always offers the platform-first + table-fallback
  // Unicode layer. It only loads the tables at runtime when the platform is
  // behind/broken (see unicode/capabilities.js).
  add(true, 'font/unicode', 'registerUnicodeFallback');

  // 2. Parse the table directory + decode the GSUB/GPOS script list.
  const t = parseTtfTables(sfnt, faceIndex);
  const view = t.view;

  // 3. Tables → readers.
  add(t.cff || t.cff2, 'font/formats/cff', 'registerCffReader');
  add(t.fvar || t.gvar || t.hvar || t.vvar || t.mvar || t.avar || t.stat,
    'font/variations', 'registerVariableFontReaders');
  add(t.colr || t.cbdt || t.cblc || t.ebdt || t.eblc || t.sbix || t.svg,
    'font/color', 'registerColorEmojiReaders');
  add(t.math, 'font/math', 'registerMathReader');
  add(t.morx || t.mort || t.kerx || t.feat || t.ankr,
    'font/typography/aat', 'registerAatReaders');
  // Register legacy 'kern' whenever the table exists. Can't gate on "GPOS
  // has no kern feature" without parsing GPOS features, and a GPOS *table*
  // can be present with NO pair kerning (mark/cursive only); gating on
  // !t.gpos would wrongly drop legacy kern for those fonts. Runtime
  // preemption stays correct: getPairKerningFu prefers GPOS only when
  // gpos.hasKerning, else falls back to legacy (lazy reader, so cheap for
  // already-GPOS-kerned fonts).
  add(t.kern, 'font/typography/legacyKern', 'registerLegacyKernReader');
  add(t.vorg || t.vhea || t.vmtx, 'font/typography/vertical', 'registerVerticalReader');
  add(t.base, 'font/typography/baseline', 'registerBaselineReader');
  add(t.jstf, 'font/typography/justification', 'registerJustificationReader');

  // 4. GSUB/GPOS script tags → shapers (+ bidi for RTL).
  const tags = new Set();
  _collectScriptTags(view, t.gsub, tags);
  _collectScriptTags(view, t.gpos, tags);

  let wantBidi = false;
  if (tags.has('arab')) { add(true, 'font/scripts/arabic', 'registerArabicShaping'); wantBidi = true; }
  if ([..._INDIC].some((s) => tags.has(s))) add(true, 'font/scripts/indic', 'registerIndicShaping');
  if (tags.has('thai') || tags.has('lao ')) add(true, 'font/scripts/thai', 'registerThaiShaping');
  if (tags.has('hang') || tags.has('jamo')) add(true, 'font/scripts/hangul', 'registerHangulShaping');
  if ([..._USE].some((s) => tags.has(s))) add(true, 'font/scripts/use', 'registerUseShaping');
  if (tags.has('math')) add(true, 'font/scripts/math', 'registerMathStretchy');

  if (!wantBidi && [..._RTL].some((s) => tags.has(s))) wantBidi = true;
  // AAT fonts shape RTL via morx (no GSUB script tags) — fall back to the
  // OS/2 Unicode-range coverage to catch them.
  if (!wantBidi && _os2HasRtl(view, t.os2)) wantBidi = true;
  if (opts.bidi === true) wantBidi = true;
  if (opts.bidi === false) wantBidi = false;
  add(wantBidi, 'font/typography/bidi', 'registerBidi');

  return { sfnt, modules };
}

/**
 * Sniff `bytes` and register the optional subsystems the font needs.
 * Tree-shakes: each module is pulled with a dynamic `import()`, so a bundler
 * splits each into its own lazy chunk; the initial bundle carries only the
 * always-on core. For a known font set, prefer the build generator
 * (scripts/genFeatureEntry.mjs) which emits these as static imports.
 *
 * @param {Uint8Array} bytes  Raw font bytes (sfnt, TTC, or WOFF2).
 * @param {object} [opts]  See {@link detectFontModules}.
 * @returns {Promise<{bytes: Uint8Array, registered: string[]}>}
 *   `bytes` is raw sfnt (WOFF2-decoded if needed); `registered` lists the
 *   subpaths pulled in (for logging / debugging).
 */
export async function autoRegisterForFont(bytes, opts = {}) {
  const { sfnt, modules } = await detectFontModules(bytes, opts);
  const registered = [];
  for (const { pkg, register } of modules) {
    const m = await import('@kontek/mantle/' + pkg);
    m[register]();
    registered.push(pkg);
  }
  return { bytes: sfnt, registered };
}
