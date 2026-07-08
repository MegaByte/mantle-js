// Shader-source loader.
//
// All paths end with a dict like
//   { fillVert, fillFrag, solidVert, solidFrag, … }
// that createRenderer accepts.
//
// 0. **Generated .glsl FILES (RECOMMENDED for production).** The committed,
//    pre-built artifact in `src/shaders/generated/*.glsl` — assembled (markers
//    spliced), VALID standalone GLSL — built by `scripts/buildShaders.mjs`
//    (`npm run build:shaders`). One file per shader. Import the ones a build
//    needs via your bundler's `?raw` (esbuild `--loader:.glsl=text`, Vite
//    `?raw`), which also lets a glsl-minify plugin run on them:
//      import fillVert from '@kontek/mantle/shaders/generated/mantle.vert.glsl?raw';
//      import fillFrag from '@kontek/mantle/shaders/generated/mantle.frag.glsl?raw';
//      const renderer = createRenderer(gl, { fillVert, fillFrag /* needed only */ });
//    Two deliberate properties:
//      • Per FILE, so importing only what you use TREE-SHAKES the rest. Use
//        SHADER_FILENAMES / shaderKeysFor(spec) (below) to map a feature set →
//        which files to import.
//      • Plain .glsl, UNMINIFIED — downstream decides the ultimate minification
//        with its own GLSL tooling (the files are valid GLSL, so any minifier /
//        glslangValidator works on them) or `minifyGlsl` below. Pass `--minify`
//        to buildShaders for the built-in conservative pass.
//    The source .glsl (with @@markers@@) stay the editable input; rerun the
//    build after editing them.
//
// The remaining paths assemble at RUNTIME from the raw .glsl fragments — useful
// for live shader iteration / no-build setups, but they pay a per-startup
// fetch+preprocess the generated module avoids.
//
// 1. **Runtime fetch (browser, no bundler).** Call
//      `await loadShaders(import.meta.url)`
//    to fetch each .glsl file relative to this module's URL.
//
// 2. **Bundler-time inline.** Configure your bundler (esbuild, vite,
//    rollup, webpack, …) to import `.glsl` files as text, then:
//      import fillVert       from './mantle.vert.glsl?raw';
//      import fillFrag       from './mantle.frag.glsl?raw';
//      import _gradientHelp  from './_gradientHelpers.glsl?raw';
//      …
//      import { bundleShaders } from '@kontek/mantle/shaders';
//      const SHADER_SOURCES = bundleShaders(
//        { fillVert, fillFrag, /* …all shaders */ },
//        { '@@GRADIENT_HELPERS@@': _gradientHelp, /* … */ });
//    `bundleShaders` runs the same marker-substitution + comment-strip
//    pipeline as `loadShaders`; you provide the bytes, it provides
//    the expansion. esbuild config: `--loader:.glsl=text`. Vite:
//    `?raw` suffix is built-in.
//
//    Or — even simpler — skip the imports entirely and let Mantle
//    self-locate + fetch its own .glsl files:
//      import { bundleShaders } from '@kontek/mantle/shaders';
//      const SHADER_SOURCES = await bundleShaders.fromPackage();
//    No `?raw` imports, no base URL, no bundler config. Takes the same
//    feature-selection `spec` as loadShaders (see fromPackage below).
//    Tradeoff: it fetches at runtime rather than inlining the source at
//    build time — import the generated module (path 0) or the explicit
//    `bundleShaders({ ... })` form when you want the shaders baked into your
//    JS bundle.
//
// 3. **Inline-in-HTML (no module fetch).** If the consumer is a
//    single-file HTML demo, keep the GLSL inside `<script id="…-src"
//    type="x-shader/…">` blocks and read them via
//    `document.getElementById('…').text`. The consumer is then
//    responsible for running
//    `preprocess(src, helpers)` on each — same substitution as the
//    two paths above.

const SHADER_NAMES = [
  ['fillVert',      'mantle.vert.glsl'],
  ['fillFrag',      'mantle.frag.glsl'],
  ['solidVert',     'solid.vert.glsl'],
  ['solidFrag',     'solid.frag.glsl'],
  ['compositeVert', 'composite.vert.glsl'],
  ['compositeFrag', 'composite.frag.glsl'],
  ['blurFrag',      'blur.frag.glsl'],
  ['boxBlurFrag',   'boxBlur.frag.glsl'],
  ['morphFrag',     'morph.frag.glsl'],
  ['convolveFrag',  'convolve.frag.glsl'],
  ['colorMatrixFrag', 'colorMatrix.frag.glsl'],
  ['feCompositeFrag', 'feComposite.frag.glsl'],
  ['feBlendFrag',     'feBlend.frag.glsl'],
  ['feTileFrag',      'feTile.frag.glsl'],
  ['feTurbulenceFrag', 'feTurbulence.frag.glsl'],
  ['feDisplacementMapFrag', 'feDisplacementMap.frag.glsl'],
  ['feLightingFrag', 'feLighting.frag.glsl'],
  ['feComponentTransferFrag', 'feComponentTransfer.frag.glsl'],
  ['feImageFrag',     'feImage.frag.glsl'],
  // COLRv1 paint dispatch. Loaded unconditionally — the renderer falls
  // back gracefully when a program is null, so font assets without COLR
  // don't pay any GL state. PaintSolid reuses the feFlood clear-color
  // path (no shader); PaintMerge reuses feCompositeFrag with op=over.
  ['paintLinearGradFrag',    'paintLinearGradient.frag.glsl'],
  ['paintRadialGradFrag',    'paintRadialGradient.frag.glsl'],
  ['paintSweepGradFrag',     'paintSweepGradient.frag.glsl'],
  ['paintTransformFrag',     'paintTransform.frag.glsl'],
  ['paintGlyphFrag',         'paintGlyph.frag.glsl'],
  ['paintCompositeFrag',     'paintComposite.frag.glsl'],
  // Multi-shape <mask> bake pass — pre-renders mask children to a
  // TEXTURE_2D_ARRAY layer (a pre-baked R8 RT). One DrawArrays per
  // child; additive blend across children. See renderer's bake pass
  // for the orchestration.
  ['maskBakeVert',           'maskBake.vert.glsl'],
  ['maskBakeFrag',           'maskBake.frag.glsl'],
  // Static-scene cache blit. When the cache RT is valid, this shader
  // draws the cached texture to the canvas in place of the full coverage
  // pipeline. Pulled in unconditionally; renderer.enableStaticCache
  // gates the actual use.
  ['cacheBlitVert',          'cacheBlit.vert.glsl'],
  ['cacheBlitFrag',          'cacheBlit.frag.glsl'],
  // Direct raster blit (renderer.createImage / drawImage). Places a
  // textured quad with dest-rect + optional worldMatrix + uv sub-rect.
  ['drawImageVert',          'drawImage.vert.glsl'],
  ['drawImageFrag',          'drawImage.frag.glsl'],
  // Instanced raster blit (renderer.drawImageInstanced). One bake/upload,
  // N transformed copies in a single drawArraysInstanced. Per-instance
  // dest-rect, mat3, and tint*alpha; shared source texture + uv sub-rect.
  ['drawImageInstancedVert', 'drawImageInstanced.vert.glsl'],
  ['drawImageInstancedFrag', 'drawImageInstanced.frag.glsl'],
  // Additive Loop-Blinn hybrid fill (resolution-independent alternative to
  // the Slug per-fragment ray-cast for solid fills). Two programs: a
  // coverage pass (interior tris + quad u²−v + cubic Bezout implicit, MAX
  // blend) and a fullscreen composite (paint × coverage, OVER blend). The
  // renderer null-gates both, so a dict omitting them degrades to Slug.
  ['loopBlinnVert',          'loopBlinn.vert.glsl'],
  ['loopBlinnFrag',          'loopBlinn.frag.glsl'],
  ['morphStrokeVert',      'morphStroke.vert.glsl'],
  ['morphStrokeFrag',      'morphStroke.frag.glsl'],
  ['loopBlinnCompositeVert', 'loopBlinnComposite.vert.glsl'],
  ['loopBlinnCompositeFrag', 'loopBlinnComposite.frag.glsl'],
];
export const SHADER_FILENAMES = SHADER_NAMES;

// ── Feature → shader-key manifest (for selectable loading) ──────────
//
// loadShaders(baseUrl, { features }) fetches only the .glsl files a
// feature set needs, instead of all of them. The shader analog of
// bundle/featureManifest.js's featuresToModules(), which maps feature
// bits to JS handler subpaths; this maps them to shader source keys.
// The renderer null-gates every optional program, so a dict missing the
// unused keys compiles cleanly.
//
// CORE is always fetched — the non-optional pipeline. Note blurFrag is
// core: the renderer compiles blurProg ungated (drop-shadow / glow
// synthesis leans on it), so it must always be present.
//
// Keys here are SHADER_NAMES keys. Bit positions mirror
// bundle/featureSet.js's Features (kept as plain BigInt literals so this
// module doesn't depend on bundle/ — the two are checked against each
// other in test). If you add a Features bit that needs a shader, add it
// here too.
const CORE_SHADER_KEYS = [
  'fillVert', 'fillFrag',
  'solidVert', 'solidFrag',
  'compositeVert', 'compositeFrag',
  'blurFrag',            // blurProg is compiled ungated — always needed
  'maskBakeVert', 'maskBakeFrag',   // <mask> bake; gated use but cheap to keep
  'cacheBlitVert', 'cacheBlitFrag', // static-scene cache blit
  // Direct raster blit — createImage / drawImage / drawImageInstanced are
  // CODE-driven base renderer APIs, not an SVG asset feature. The feature
  // scan only sees assets, so it can't know a consumer calls drawImage();
  // gating these behind the SVG <image>/<feImage> bit would force every such
  // consumer to hand-include them. Core keeps them always available (the
  // renderer still null-gates the programs, so a hand-built dict that omits
  // them degrades gracefully). feImageFrag stays feature-gated — it IS
  // asset-driven (the <feImage> filter primitive).
  'drawImageVert', 'drawImageFrag',
  'drawImageInstancedVert', 'drawImageInstancedFrag',
  // Loop-Blinn hybrid fill is a CODE-driven base renderer API
  // (renderer.drawLoopBlinnMesh), not an SVG asset feature — keep it in core
  // like the drawImage family so consumers don't have to hand-include it.
  'loopBlinnVert', 'loopBlinnFrag',
  'morphStrokeVert', 'morphStrokeFrag',
  'loopBlinnCompositeVert', 'loopBlinnCompositeFrag',
];

// Feature bit (BigInt, mirrors Features) → extra shader keys beyond CORE.
const FEATURE_SHADER_KEYS = [
  // Filters
  [1n << 16n, ['boxBlurFrag']],                    // FilterBlur (large σ → 3-pass box)
  [1n << 17n, ['colorMatrixFrag']],                // FilterColorMatrix
  [1n << 18n, ['feCompositeFrag']],                // FilterDropShadow (blur is core)
  [1n << 19n, ['feCompositeFrag']],                // FilterGlow
  [1n << 20n, ['feLightingFrag', 'feCompositeFrag']], // FilterBevel
  [1n << 21n, ['morphFrag']],                      // FilterMorphology
  [1n << 22n, ['convolveFrag']],                   // FilterConvolve
  // FilterGraph (1<<15) can use any primitive → pull every filter shader.
  [1n << 15n, [
    'boxBlurFrag', 'morphFrag', 'convolveFrag', 'colorMatrixFrag',
    'feCompositeFrag', 'feBlendFrag', 'feTileFrag', 'feTurbulenceFrag',
    'feDisplacementMapFrag', 'feLightingFrag', 'feComponentTransferFrag',
    'feImageFrag',
  ]],
  // Images (1<<23) — the SVG <feImage> filter source. The direct-blit
  // shaders (drawImage*) are CORE, not here: they back code-driven
  // renderer APIs no asset scan can detect (see CORE_SHADER_KEYS).
  [1n << 23n, ['feImageFrag']],
  // COLRv1 paint graph (1<<25) — all paint shaders (PaintSolid/Merge
  // reuse core paths, so they need no shader of their own).
  [1n << 25n, [
    'paintLinearGradFrag', 'paintRadialGradFrag', 'paintSweepGradFrag',
    'paintTransformFrag', 'paintGlyphFrag', 'paintCompositeFrag',
  ]],
];

/// Resolve a selection spec to the set of shader keys to fetch.
/// `spec` may carry:
///   • features: a BigInt bitfield (from bundle inspect()/inspectAll) —
///     unions CORE with each matching feature's keys.
///   • include: an explicit array of SHADER_NAMES keys to add.
/// CORE is always included. Returns a Set of keys. With no spec, returns
/// null to signal "everything" (back-compat).
export function shaderKeysFor(spec) {
  if (!spec) return null;
  const keys = new Set(CORE_SHADER_KEYS);
  const flags = spec.features;
  if (typeof flags === 'bigint') {
    for (const [bit, extra] of FEATURE_SHADER_KEYS) {
      if ((flags & bit) === bit && bit !== 0n) for (const k of extra) keys.add(k);
    }
  }
  if (Array.isArray(spec.include)) for (const k of spec.include) keys.add(k);
  return keys;
}

/// Resolve a selection spec to the list of GENERATED shader files a build
/// needs — the file-path analog of shaderKeysFor(), and the shader peer of
/// bundle/featureManifest.js's featuresToModules(): featuresToModules maps a
/// feature bitfield → JS handler subpaths to import; this maps the same
/// bitfield → assembled `generated/*.glsl` subpaths to import. Lets the
/// feature-entry generator emit STATIC shader imports next to the handler
/// imports, so the consumer's bundler tree-shakes + minifies the shaders the
/// same way it does the JS — one feature resolution covers both.
///
/// Returns `[[key, subpath], …]` (subpath relative to the package's
/// `shaders/` export, e.g. `generated/mantle.frag.glsl`). With no spec,
/// returns every shader (mirrors shaderKeysFor's "everything" sentinel).
export function shaderFilesFor(spec, opts) {
  const dir = (opts && opts.dir) || 'generated/';
  const keys = shaderKeysFor(spec);   // null → everything
  const out = [];
  for (const [key, file] of SHADER_NAMES) {
    if (keys === null || keys.has(key)) out.push([key, dir + file]);
  }
  return out;
}

// Helper snippets concatenated into shaders via `@@MARKER@@` text
// substitution. Keeps each helper as one source of truth on disk
// while the consuming shader stays self-contained.
const HELPER_INCLUDES = [
  ['@@BUNDLE_LAYOUT@@',      '_bundleLayout.glsl'],
  ['@@GRADIENT_HELPERS@@',    '_gradientHelpers.glsl'],
  ['@@PORTER_DUFF_HELPERS@@', '_porterDuffHelpers.glsl'],
  ['@@BLEND_HELPERS@@',       '_blendHelpers.glsl'],
  // Coverage curve + paint sampling helpers — extracted from
  // mantle.frag.glsl so the maskBake shader can reuse the same
  // renderFill / sampleGradient / sampleChildImage. Must follow
  // @@GRADIENT_HELPERS@@ in the including shader (the coverage
  // helpers call sampleStops from gradient helpers).
  ['@@SLUG_COVERAGE@@',       '_slugCoverage.glsl'],
  // Shared curve coeff/eval + GL-16 arc length (cubicCoeff, evalC/evalCD,
  // slugCubicArcLen). Used by the Slug fill+stroke walk (inside _slugCoverage),
  // the morph stroke FRAG, and the morph stroke VERT (which needs ONLY these — not
  // the stroke-distance math — so it stays light + sampler-free). MUST be AFTER
  // @@SLUG_COVERAGE@@ (so the nested marker in the inlined body resolves in a later
  // pass) and BEFORE @@STROKE_MATH@@ (which calls these).
  ['@@CURVE_ARCLEN@@',        '_curveArcLen.glsl'],
  // Shared analytic stroke-distance math (closest-point + caps/joins/dash) used
  // by the Slug stroke (inside _slugCoverage) and the morph stroke pass. MUST be
  // registered AFTER @@SLUG_COVERAGE@@ + @@CURVE_ARCLEN@@ so the nested markers
  // resolve in later passes of preprocess()'s helper loop. Needs uDashTex declared
  // + @@CURVE_ARCLEN@@ included before it.
  ['@@STROKE_MATH@@',         '_strokeMath.glsl'],
  // Gradient paint sampler (sampleGradient) — shared by the Slug fill (inside
  // _slugCoverage) and the Loop-Blinn direct path. AFTER @@SLUG_COVERAGE@@ (nested
  // marker resolves later); each includer declares gradientSpreadToExtend +
  // @@GRADIENT_HELPERS@@ first.
  ['@@PAINT_SAMPLE@@',        '_paintSample.glsl'],
  // Per-shape override transform (transformClipCoord) — shared by
  // mantle.frag (animated clip coverage) + maskBake.frag (animated <mask>
  // child geometry) so they can't diverge. Needs uOverrideTex/uHasOverrides
  // declared by the including shader.
  ['@@OVERRIDE_TRANSFORM@@',   '_overrideTransform.glsl'],
];
export const HELPER_FILENAMES = HELPER_INCLUDES;

/// Pure substitution: strip `//` line comments, drop leading blank
/// lines (`#version` must be on line 1 per GLSL spec), and splice
/// each `@@MARKER@@` with the matching helper text. Throws on any
/// leftover `@@…@@` so a new helper that someone forgot to register
/// surfaces at build time instead of GL compile time.
///
/// `helpers` is a dict mapping marker string → helper source text,
/// e.g. `{ '@@GRADIENT_HELPERS@@': '...' }`. Use HELPER_FILENAMES
/// (exported) if you want the canonical marker list.
export function preprocess(src, helpers) {
  // Strip `// …` line comments BEFORE the marker substitution.
  // Some shader docstrings reference `@@GRADIENT_HELPERS@@` etc. by
  // name in their comment body; `String.replace` (and `split/join`)
  // would land on that docstring mention and tear the host code in
  // half — line 21's `precision` declaration would end up MERGED
  // with the helper body, losing host uniforms entirely. Stripping
  // host comments first removes the ambiguity.
  let out = src.replace(/\/\/[^\n]*/g, '');
  if (helpers) {
    for (const marker in helpers) {
      // split/join replaces ALL occurrences; String.replace (no /g)
      // would land on the first match only. Each helper's body may
      // itself contain comments referencing other `@@…@@` markers
      // (e.g. `_slugCoverage.glsl` documents that it expects
      // `@@GRADIENT_HELPERS@@` to precede it). We strip those
      // helper-internal comments in a second pass below so they
      // don't trip the leftover-marker guard.
      if (out.includes(marker)) out = out.split(marker).join(helpers[marker]);
    }
  }
  // Second comment-strip pass: helper bodies were inlined raw and
  // can contain comments referencing markers. Strip again so the
  // leftover guard only sees genuine unsubstituted placeholders.
  out = out.replace(/\/\/[^\n]*/g, '');
  // GLSL spec: `#version` must be on line 1. Some .glsl files lead
  // with a comment header that, post-strip, leaves blank lines
  // ahead of `#version`. Strip leading whitespace-only lines so the
  // directive lands first. Without this fix shaders whose source
  // doesn't start with #version (e.g. feImage.frag.glsl) fail to
  // compile.
  out = out.replace(/^[\s\n]+/, '');
  // Belt-and-braces: any leftover @@…@@ marker means a new helper
  // got referenced but not registered. Fail loudly so the consumer
  // sees a stack trace instead of a cryptic GL compile error.
  const leftover = out.match(/@@[A-Z_]+@@/);
  if (leftover) {
    throw new Error(`unsubstituted shader marker: ${leftover[0]}`);
  }
  return out;
}

/// Conservative GLSL minifier for ASSEMBLED shaders (post-preprocess, i.e.
/// valid translation units — never run on the raw marker fragments). Strips
/// block + line comments, drops blank lines, and collapses intra-line
/// whitespace. It deliberately KEEPS one newline per surviving source line so
/// (a) preprocessor directives (`#version`, `#define`, `#extension`, `#if…`)
/// stay isolated on their own line, and (b) adjacent tokens can't merge into a
/// single identifier. GLSL has no string literals, so comment removal is safe.
/// This is the default used by scripts/buildShaders.mjs; an external minifier can
/// be run on the assembled output instead for heavier (identifier-renaming)
/// passes, which is now possible because the assembled shader is valid GLSL.
export function minifyGlsl(src) {
  let s = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments → space
    .replace(/\/\/[^\n]*/g, '');         // line comments
  const lines = s.split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0);
  return lines.join('\n');
}

/// Produce the canonical generated-file content for one shader: splice the
/// @@MARKER@@ helpers (preprocess) → a valid translation unit, then TIDY the
/// blank-line runs that preprocess's `//`-strip leaves behind (cosmetic, NOT
/// minification — real whitespace/indentation is kept). `opts.minify` runs the
/// built-in minifier on top. Shared by scripts/buildShaders.mjs and the
/// freshness test so the committed generated/*.glsl can't drift from source.
export function assembleShader(raw, helpers, opts) {
  let glsl = preprocess(raw, helpers);
  glsl = glsl.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
  return (opts && opts.minify) ? minifyGlsl(glsl) : glsl;
}

/// Optional fill-shader features that can be COMPOSED OUT at compile time. Each
/// is guarded by `#ifndef MANTLE_NO_<FEAT>` in mantle.frag.glsl; defining that
/// macro (createRenderer opts.fillDefines, via fillOmitDefines) drops the code.
/// The fill shader = a fixed CORE (coverage walk + primKind SDF + occupancy +
/// solid/gradient paint + stroke + blend + overrides) plus whichever of these
/// an app uses. WebGL program switches are cheap, so a renderer compiles only
/// what its content needs — smaller compile, fewer samplers/uniforms. Each
/// section only WRITES color/coverage, so omitting one is byte-identical for a
/// draw that doesn't trigger it. Names line up with bundle/featureSet.js.
export const FILL_FEATURES = Object.freeze([
  'recolor',  // per-draw channelLerp/palette/colorMatrix (+ uPalette sampler)
  'gradient', // gradient paint, UNWOVEN from fill/stroke/pattern/mask: each
              //   sampleGradient call falls back to its solid branch (the one
              //   runtime takes when no gradient ids exist), and the shared
              //   sampleGradient def + uGradientTex/uGradientStops drop. Define
              //   MANTLE_NO_GRADIENT only when the content has NO gradients.
  'clip',     // clipPath coverage
  'mask',     // <mask> luminance/alpha (+ uMaskRTArray / uMaskRowToLayerTex)
  'extclip',  // setNodeClip screen-space mask (+ uExtClipTex)
  'filter',   // per-shape feColorMatrix (+ uFilterTex)
  'stroke',   // per-shape stroke band walk (the top-level stroke pass)
  'pattern',  // vector <pattern> tiling (the child-walk block)
  'image',    // <image> / raster pattern fill (+ uImageTex). Its helpers are
              //   shared by pattern/mask/stroke, so MANTLE_NO_IMAGE is only
              //   emitted when those are ALSO omitted (see fillOmitDefines).
]);

/// Map a set of fill features to OMIT → the `#define MANTLE_NO_<FEAT>` names to
/// pass as createRenderer's `opts.fillDefines`. The fill shader guards each
/// optional feature with `#ifndef MANTLE_NO_<FEAT>`, so these defines compile a
/// leaner program (the GLSL preprocessor drops the code → fewer samplers /
/// uniforms, faster compile). This is the idiomatic WebGL shader-variant
/// mechanism: ONE committed shader source, variants selected at COMPILE time by
/// #define — no build step, no text markers.
///   const omit = fillOmitDefines(FILL_FEATURES.filter(f => !used.has(f)));
///   const r = createRenderer(gl, shaders, { fillDefines: omit });
export function fillOmitDefines(omitFeatures) {
  const set = omitFeatures instanceof Set ? omitFeatures : new Set(omitFeatures || []);
  // `image`'s sampleChildImage / sampleTopLevelImage helpers are CALLED from the
  // pattern, mask, and stroke blocks, so dropping uImageTex (MANTLE_NO_IMAGE) is
  // only safe when those blocks are also dropped — otherwise a kept block would
  // reference the removed helper. Honor an `image` omit only if all three are
  // omitted too; otherwise the (inert, never-hit) top-level image branch stays.
  const safe = new Set(set);
  if (safe.has('image') && !(safe.has('pattern') && safe.has('mask') && safe.has('stroke')))
    safe.delete('image');
  return FILL_FEATURES.filter(f => safe.has(f)).map(f => `MANTLE_NO_${f.toUpperCase()}`);
}

/// Build the createRenderer-shaped dict from raw shader sources + a
/// helpers dict. Synchronous; suitable for bundler-time inline use.
///
///   import fillVert from './mantle.vert.glsl?raw';
///   import fillFrag from './mantle.frag.glsl?raw';
///   …
///   import gradHelp from './_gradientHelpers.glsl?raw';
///   …
///   const sources = bundleShaders(
///     { fillVert, fillFrag, /* …all shaders */ },
///     { '@@GRADIENT_HELPERS@@': gradHelp, /* … */ });
///   const renderer = createRenderer(gl, sources);
///
/// `rawSources` is keyed by SHADER_NAMES key (e.g. `fillFrag`).
/// `helpers` is keyed by marker string (e.g. `'@@GRADIENT_HELPERS@@'`).
/// Use SHADER_FILENAMES / HELPER_FILENAMES (exported) as the
/// canonical lists when wiring imports.
export function bundleShaders(rawSources, helpers) {
  const out = {};
  for (const [key /*, _filename */] of SHADER_NAMES) {
    const raw = rawSources[key];
    if (raw == null) continue;  // missing optional shader → renderer gates on null
    out[key] = preprocess(raw, helpers);
  }
  return out;
}

/// One-liner shader loading that needs no consumer wiring: the module
/// self-locates its own .glsl files (they sit next to this index.js in
/// the installed package) and fetches them, returning the
/// createRenderer-shaped dict.
///
///   import { bundleShaders } from '@kontek/mantle/shaders';
///   const SHADER_SOURCES = await bundleShaders.fromPackage();
///   const renderer = createRenderer(gl, SHADER_SOURCES);
///
/// Takes the same `spec` as loadShaders for feature-selection:
///   await bundleShaders.fromPackage({ features: flags })   // core + needed
///   await bundleShaders.fromPackage({ include: [...] })    // core + explicit
///
/// Tradeoff vs. the generated module / explicit `bundleShaders({ ... })`:
/// fromPackage FETCHES at runtime (one request per .glsl), so the shader
/// source isn't inlined into your JS bundle — the `spec` trims the fetch list
/// instead. Import `@kontek/mantle/shaders/generated` (built by
/// `npm run build:shaders`) when you want the shaders inlined + minified at
/// build time. fromPackage is the "I just want it to work" convenience:
/// no ?raw imports, no base URL, no bundler config.
///
/// Requires `fetch` + `import.meta.url` (browser, Deno, Node ≥ 18). In a
/// bundler that rewrites import.meta.url to a built asset path, the .glsl
/// files must be served alongside — most bundlers copy package assets
/// referenced by a stable URL, but if yours doesn't, fall back to the
/// explicit `bundleShaders({ ...?raw imports })` form.
bundleShaders.fromPackage = function fromPackage(spec) {
  // import.meta.url here is this module's URL; the .glsl files are its
  // siblings, so loadShaders' `new URL('./x.glsl', base)` resolves them.
  return loadShaders(import.meta.url, spec);
};

/// Fetch .glsl files relative to a base URL (typically `import.meta.url`)
/// and return them in the dict shape createRenderer expects. Splices any
/// `@@INCLUDE_MARKER@@` placeholders with the matching helper file's text
/// (HELPER_INCLUDES above).
///
/// `spec` (optional) selects which shaders to fetch — the runtime-fetch
/// analog of the bundler-time tree-shaking that bundleShaders enables:
///   loadShaders(import.meta.url)                       // all shaders (back-compat)
///   loadShaders(import.meta.url, { features: flags })  // core + features' shaders
///   loadShaders(import.meta.url, { include: [...] })   // core + explicit keys
/// where `flags` is a bundle inspect()/inspectAll() bitfield. Omitting
/// `spec` keeps the original "fetch everything" behavior so existing
/// callers are unaffected. The renderer null-gates every optional
/// program, so a filtered dict compiles cleanly.
export async function loadShaders(baseUrl, spec) {
  const wanted = shaderKeysFor(spec);   // null = everything
  // Fetch helper snippets first so they're ready for substitution. These
  // are small and shared across core shaders — always fetched.
  const helpers = {};
  for (const [marker, file] of HELPER_INCLUDES) {
    const res = await fetch(new URL(`./${file}`, baseUrl));
    if (!res.ok) throw new Error(`failed to load helper ${file}: ${res.status}`);
    helpers[marker] = await res.text();
  }
  const names = wanted
    ? SHADER_NAMES.filter(([key]) => wanted.has(key))
    : SHADER_NAMES;
  const entries = await Promise.all(
    names.map(async ([key, file]) => {
      const res = await fetch(new URL(`./${file}`, baseUrl));
      if (!res.ok) throw new Error(`failed to load shader ${file}: ${res.status}`);
      const src = await res.text();
      return [key, preprocess(src, helpers)];
    })
  );
  return Object.fromEntries(entries);
}
