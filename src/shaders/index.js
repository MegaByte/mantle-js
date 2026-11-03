// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shader-source loader.
//
// All paths end with a dict like
//   { fillVert, fillFrag, solidVert, solidFrag, … }
// that createRenderer accepts.
//
// 0. **Default: the bundled module (works under every bundler, in Node, and unbundled).**
//    `await bundleShaders.fromPackage()` (or `loadShaders()` with no URL) imports
//    `./bundledSources.js` - every shader source and helper once, as plain JS strings, spliced on load into
//    exactly the text of `generated/*.glsl`. Nothing to fetch, nothing for a bundler to forget to copy, and no
//    `import.meta.url` to rewrite. The import is a literal dynamic `import('./bundledSources.js')`, so a
//    bundler with code splitting (Vite, webpack, rollup, esbuild `--splitting`) emits the shaders as a
//    lazy chunk that loads on the first call. Without splitting they are inlined into your bundle.
//      import { bundleShaders } from '@kontek/mantle/shaders';
//      const renderer = createRenderer(gl, await bundleShaders.fromPackage());
//    The spec trims the DICT (core + a feature set's shaders), not the chunk. To also trim the bytes,
//    import only the named, already-assembled exports you need from `bundled.js` (they tree-shake):
//      import { fillVert, fillFrag } from '@kontek/mantle/shaders/bundled';
//    `npm run build:shaders` regenerates both modules together with generated/*.glsl.
//
// 1. **Generated .glsl FILES (for a glsl-minify / validator pipeline).** The committed,
//    pre-built artifact in `src/shaders/generated/*.glsl` - assembled (markers
//    spliced), VALID standalone GLSL - built by `scripts/buildShaders.mjs`
//    (`npm run build:shaders`). One file per shader. Import the ones a build
//    needs via your bundler's `?raw` (esbuild `--loader:.glsl=text`, Vite
//    `?raw`), which also lets a glsl-minify plugin run on them:
//      import fillVert from '@kontek/mantle/shaders/generated/mantle.vert.glsl?raw';
//      import fillFrag from '@kontek/mantle/shaders/generated/mantle.frag.glsl?raw';
//      const renderer = createRenderer(gl, { fillVert, fillFrag /* needed only */ });
//    Per FILE, so importing only what you use tree-shakes the rest (SHADER_FILENAMES /
//    shaderKeysFor(spec) / shaderFilesFor(spec) map a feature set to the files), and UNMINIFIED:
//    downstream decides the ultimate minification with its own GLSL tooling or `minifyGlsl` below.
//
// 2. **Opt-in URL fetch (self-hosted .glsl, no bundler).** `await loadShaders(baseUrl)` fetches
//    `<baseUrl>/generated/<file>.glsl` (one request per shader) - for a page that serves the package
//    directory itself. A bundler does NOT emit those files; use path 0 or 1 under a bundler. Every
//    response is checked (status and content), so a 404 or an SPA host answering `index.html` fails
//    loudly instead of reaching the GLSL compiler. A `file:` base reads through `node:fs` in Node.
//    In a source checkout (no generated/) it falls back to the marker-bearing sources next to it.
//
// 3. **Bundler-time inline from raw sources (source checkout).** The marker-bearing
//    `src/shaders/*.glsl` in the repository (not in the npm package):
//      import { bundleShaders } from '@kontek/mantle/shaders';
//      const SHADER_SOURCES = bundleShaders({ fillVert, fillFrag, /* ... */ },
//        { '@@GRADIENT_HELPERS@@': _gradientHelp, /* ... */ });
//    `bundleShaders` runs the same marker substitution + comment strip as `loadShaders`.
//    Applied to the already-assembled generated files it is the identity.
//
// 4. **Inline-in-HTML (no module fetch).** Keep the GLSL inside `<script type="x-shader/...">`
//    blocks and read them with `document.getElementById('...').text`; run `preprocess(src, helpers)`
//    on each when they carry markers.

import { nodeBuiltin } from '../core/nodeBuiltin.js';

/** A createRenderer-shaped dict: shader key (`fillVert`, `fillFrag`, ...) to GLSL source text.
 * @typedef {Record<string, string>} ShaderSources */
/** Which shaders to load. `features` is a bundle inspect()/inspectAll() bitfield; `include` adds explicit keys.
 * @typedef {{ features?: bigint, include?: string[] }} ShaderSpec */

const SHADER_NAMES = [
  ['fillVert', 'mantle.vert.glsl'],
  ['fillFrag', 'mantle.frag.glsl'],
  ['solidVert', 'solid.vert.glsl'],
  ['solidFrag', 'solid.frag.glsl'],
  ['compositeVert', 'composite.vert.glsl'],
  ['compositeFrag', 'composite.frag.glsl'],
  ['blurFrag', 'blur.frag.glsl'],
  ['boxBlurFrag', 'boxBlur.frag.glsl'],
  ['morphFrag', 'morph.frag.glsl'],
  ['convolveFrag', 'convolve.frag.glsl'],
  ['colorMatrixFrag', 'colorMatrix.frag.glsl'],
  ['feCompositeFrag', 'feComposite.frag.glsl'],
  ['feBlendFrag', 'feBlend.frag.glsl'],
  ['feTileFrag', 'feTile.frag.glsl'],
  ['feTurbulenceFrag', 'feTurbulence.frag.glsl'],
  ['feDisplacementMapFrag', 'feDisplacementMap.frag.glsl'],
  ['feLightingFrag', 'feLighting.frag.glsl'],
  ['feComponentTransferFrag', 'feComponentTransfer.frag.glsl'],
  ['feImageFrag', 'feImage.frag.glsl'],
  // FillPaint / StrokePaint as a gradient (Filter Effects 1): the fill shader's own gradient sampler over a filter-graph target.
  ['ownerPaintFrag', 'ownerPaint.frag.glsl'],
  // COLRv1 paint dispatch. Loaded unconditionally — the renderer falls
  // back gracefully when a program is null, so font assets without COLR
  // don't pay any GL state. PaintSolid reuses the feFlood clear-color
  // path (no shader); PaintMerge reuses feCompositeFrag with op=over.
  ['paintLinearGradFrag', 'paintLinearGradient.frag.glsl'],
  ['paintRadialGradFrag', 'paintRadialGradient.frag.glsl'],
  ['paintSweepGradFrag', 'paintSweepGradient.frag.glsl'],
  ['paintTransformFrag', 'paintTransform.frag.glsl'],
  ['paintGlyphFrag', 'paintGlyph.frag.glsl'],
  ['paintCompositeFrag', 'paintComposite.frag.glsl'],
  // Multi-shape <mask> bake pass — pre-renders mask children to a
  // TEXTURE_2D_ARRAY layer (a pre-baked R8 RT). One DrawArrays per
  // child; additive blend across children. See renderer's bake pass
  // for the orchestration.
  ['maskBakeVert', 'maskBake.vert.glsl'],
  ['maskBakeFrag', 'maskBake.frag.glsl'],
  // AAC for SMALL shapes, shaded in the vertex stage as 1-px points (renderer/aacPointsDraw.js). A code-driven
  // route choice by on-screen size, not an asset feature, so it is core.
  ['aacPointsVert', 'aacPoints.vert.glsl'],
  ['aacPointsFrag', 'aacPoints.frag.glsl'],
  // Static-scene cache blit. When the cache RT is valid, this shader
  // draws the cached texture to the canvas in place of the full coverage
  // pipeline. Pulled in unconditionally; renderer.enableStaticCache
  // gates the actual use.
  ['cacheBlitVert', 'cacheBlit.vert.glsl'],
  ['cacheBlitFrag', 'cacheBlit.frag.glsl'],
  ['cacheBlitInstancedVert', 'cacheBlitInstanced.vert.glsl'],
  ['effectMaskFrag', 'effectMask.frag.glsl'],
  // Direct raster blit (renderer.createImage / drawImage). Places a
  // textured quad with dest-rect + optional worldMatrix + uv sub-rect.
  ['drawImageVert', 'drawImage.vert.glsl'],
  ['drawImageFrag', 'drawImage.frag.glsl'],
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
  ['splitStrokeVert', 'splitStroke.vert.glsl'],
  ['splitStrokeFrag', 'splitStroke.frag.glsl'],
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
  'fillVert',
  'fillFrag',
  'solidVert',
  'solidFrag',
  'compositeVert',
  'compositeFrag',
  'blurFrag', // blurProg is compiled ungated — always needed
  'aacPointsVert',
  'aacPointsFrag', // AAC small-shape point route (chosen by on-screen size)
  'cacheBlitVert',
  'cacheBlitFrag',
  'cacheBlitInstancedVert',
  'effectMaskFrag', // texture composites
  // Direct raster blit — createImage / drawImage / drawImageInstanced are
  // CODE-driven base renderer APIs, not an SVG asset feature. The feature
  // scan only sees assets, so it can't know a consumer calls drawImage();
  // gating these behind the SVG <image>/<feImage> bit would force every such
  // consumer to hand-include them. Core keeps them always available (the
  // renderer still null-gates the programs, so a hand-built dict that omits
  // them degrades gracefully). feImageFrag stays feature-gated — it IS
  // asset-driven (the <feImage> filter primitive).
  'drawImageVert',
  'drawImageFrag',
  'drawImageInstancedVert',
  'drawImageInstancedFrag',
  // Loop-Blinn hybrid fill is a CODE-driven base renderer API
  // (renderer.drawLoopBlinnMesh), not an SVG asset feature — keep it in core
  // like the drawImage family so consumers don't have to hand-include it.
  'splitStrokeVert',
  'splitStrokeFrag',
  'loopBlinnCompositeVert',
  'loopBlinnCompositeFrag',
];

// Feature bit (BigInt, mirrors Features) → extra shader keys beyond CORE.
// Annotated because the literal is heterogeneous pairs: without it the
// element type widens to `bigint | string[]` and every use looks ill-typed.
/** @type {[bigint, string[]][]} */
const FEATURE_SHADER_KEYS = [
  // Resource baking is asset-driven. Even an unused bake program compiles
  // the full analytic coverage/paint walk, so keep it out of the core batch.
  // Clips and vector patterns share this pass with masks.
  [1n << 10n, ['maskBakeVert', 'maskBakeFrag']], // Clips
  [1n << 11n, ['maskBakeVert', 'maskBakeFrag']], // Masks
  [1n << 24n, ['maskBakeVert', 'maskBakeFrag']], // VectorPattern
  // Filters
  [1n << 16n, ['boxBlurFrag']], // FilterBlur (large σ → 3-pass box)
  [1n << 17n, ['colorMatrixFrag']], // FilterColorMatrix
  [1n << 18n, ['feCompositeFrag']], // FilterDropShadow (blur is core)
  [1n << 19n, ['feCompositeFrag']], // FilterGlow
  [1n << 20n, ['feLightingFrag', 'feCompositeFrag']], // FilterBevel
  [1n << 21n, ['morphFrag']], // FilterMorphology
  [1n << 22n, ['convolveFrag']], // FilterConvolve
  // FilterGraph (1<<15) can use any primitive → pull every filter shader.
  [
    1n << 15n,
    [
      'boxBlurFrag',
      'morphFrag',
      'convolveFrag',
      'colorMatrixFrag',
      'feCompositeFrag',
      'feBlendFrag',
      'feTileFrag',
      'feTurbulenceFrag',
      'feDisplacementMapFrag',
      'feLightingFrag',
      'feComponentTransferFrag',
      'feImageFrag',
      'ownerPaintFrag',
    ],
  ],
  // Images (1<<23) — the SVG <feImage> filter source. The direct-blit
  // shaders (drawImage*) are CORE, not here: they back code-driven
  // renderer APIs no asset scan can detect (see CORE_SHADER_KEYS).
  [1n << 23n, ['feImageFrag']],
  // COLRv1 paint graph (1<<25) — all paint shaders. PaintSolid is a clear; PaintMerge (every PaintColrLayers)
  // is the feComposite program, which core does not hold, and without it a layered glyph clears to nothing.
  [
    1n << 25n,
    [
      'paintLinearGradFrag',
      'paintRadialGradFrag',
      'paintSweepGradFrag',
      'paintTransformFrag',
      'paintGlyphFrag',
      'paintCompositeFrag',
      'feCompositeFrag',
    ],
  ],
];

/// Resolve a selection spec to the set of shader keys to fetch.
/// `spec` may carry:
///   • features: a BigInt bitfield (from bundle inspect()/inspectAll) —
///     unions CORE with each matching feature's keys.
///   • include: an explicit array of SHADER_NAMES keys to add.
/// CORE is always included. Returns a Set of keys. With no spec, returns
/// null to signal "everything" (back-compat).
/** @param {ShaderSpec} [spec] @returns {Set<string> | null} `null` (no spec) means every shader */
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
/** @param {ShaderSpec} [spec] @param {{ dir?: string }} [opts]  `dir` defaults to `generated/` @returns {[string, string][]} */
export function shaderFilesFor(spec, opts) {
  const dir = (opts && opts.dir) || 'generated/';
  const keys = shaderKeysFor(spec); // null → everything
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
  ['@@BUNDLE_LAYOUT@@', '_bundleLayout.glsl'],
  ['@@GRADIENT_HELPERS@@', '_gradientHelpers.glsl'],
  ['@@PORTER_DUFF_HELPERS@@', '_porterDuffHelpers.glsl'],
  ['@@BLEND_HELPERS@@', '_blendHelpers.glsl'],
  // Coverage curve + paint sampling helpers — extracted from
  // mantle.frag.glsl so the maskBake shader can reuse the same
  // renderFill / sampleGradient / sampleChildImage. Must follow
  // @@GRADIENT_HELPERS@@ in the including shader (the coverage
  // helpers call sampleStops from gradient helpers).
  ['@@COVERAGE@@', '_coverage.glsl'],
  // Shared curve coeff/eval + GL-16 arc length (cubicCoeff, evalC/evalCD,
  // slugCubicArcLen). Used by the Slug fill+stroke walk (inside _coverage),
  // the morph stroke FRAG, and the morph stroke VERT (which needs only these — not
  // the stroke-distance math — so it stays light + sampler-free). MUST be AFTER
  // @@COVERAGE@@ (so the nested marker in the inlined body resolves in a later
  // pass) and BEFORE @@STROKE_MATH@@ (which calls these).
  // Exact half-plane box coverage (exactBoxCov) — the ONE copy, shared by the band engines
  // (Slug's exact-edge branch, GWN's SDF combine) and the Loop-Blinn fragment shader, so LB and
  // Slug cannot disagree at an AA edge. MUST be AFTER @@COVERAGE@@ so the nested marker in the
  // inlined body resolves on a later pass.
  ['@@BOX_COV@@', '_boxCov.glsl'],
  ['@@CURVE_ARCLEN@@', '_curveArcLen.glsl'],
  // Shared analytic stroke-distance math (closest-point + caps/joins/dash) used
  // by the Slug stroke (inside _coverage) and the morph stroke pass. MUST be
  // registered AFTER @@COVERAGE@@ + @@CURVE_ARCLEN@@ so the nested markers
  // resolve in later passes of preprocess()'s helper loop. Needs uDashTex declared
  // + @@CURVE_ARCLEN@@ included before it.
  ['@@STROKE_MATH@@', '_strokeMath.glsl'],
  // Exact point-to-elliptical-arc distance (evalArc / distToEllipse / arcInRange). Nested inside
  // both @@COVERAGE@@ and @@STROKE_MATH@@ so the band walk and the split-stroke pass compute arcs
  // the same way — and registered AFTER both, since a marker inside an inlined body only resolves
  // on a later pass. No shader splices both hosts, so the definitions cannot collide.
  ['@@ARC_MATH@@', '_arcMath.glsl'],
  // Gradient paint sampler (sampleGradient) — shared by the Slug fill (inside
  // _coverage) and the Loop-Blinn direct path. AFTER @@COVERAGE@@ (nested
  // marker resolves later); each includer declares gradientSpreadToExtend +
  // @@GRADIENT_HELPERS@@ first.
  ['@@PAINT_SAMPLE@@', '_paintSample.glsl'],

  ['@@LB_VARYINGS@@', '_lbVaryings.glsl'],
  // The LB vertex stage's per-kind varying setup — the mirror of _lbCoverage on
  // the vertex side. Returns the dilated em position and leaves projection to
  // the includer, which is the split the ubershader needs. MUST follow the
  // includer's emPerPxFor() definition.
  // The unified stream's shared vertex helper: em-per-device-pixel along a direction, folding in
  // the world matrix. Both vertex setups call it, so it precedes both.
  ['@@EM_PER_PX@@', '_emPerPx.glsl'],
  // CPATCH's vertex stage. Its own marker, for the same reason its coverage kernel has one.
  // MUST precede @@LB_VERTEX_SETUP@@, whose kind dispatch calls cpatchVertexSetup().
  ['@@CPATCH_VERTEX_SETUP@@', '_cpatchVertexSetup.glsl'],
  ['@@LB_VERTEX_SETUP@@', '_lbVertexSetup.glsl'],
  // CPATCH's coverage kernel. Its own marker, because CPatch is its own engine and not a
  // Loop-Blinn kind — it shares the unified stream's varyings and cover quads, which is a shared
  // WIRE, not a shared model. MUST precede @@LB_COVERAGE@@, which hands off to cpatchCoverage(),
  // and follow @@LB_VARYINGS@@ + @@BOX_COV@@, which it reads and calls.
  ['@@CPATCH_COVERAGE@@', '_cpatchCoverage.glsl'],
  ['@@LB_COVERAGE@@', '_lbCoverage.glsl'],
  // The analytic SDF stroke's coverage — the stroke-side twin of _lbCoverage,
  // extracted for the same reason: one implementation feeding both the
  // standalone splitStroke pass and the ubershader's stroke seam. MUST follow
  // @@STROKE_MATH@@ (it calls strokeCubicAccum) and @@BOX_COV@@ (exactBoxCov),
  // and reads the includer's flat stroke varyings directly.
  ['@@STROKE_COVERAGE@@', '_strokeCoverage.glsl'],
  // ...and its vertex half: the band-quad corner + the flat varyings the coverage
  // reads. MUST follow @@CURVE_ARCLEN@@ (the dash prefix sum calls
  // cubicCoeff/slugCubicArcLen) and the includer's uPrim/uPrimW declarations.
  ['@@STROKE_VERTEX_SETUP@@', '_strokeVertexSetup.glsl'],
  // Per-shape override transform (transformClipCoord) — shared by
  // mantle.frag (animated clip coverage) + maskBake.frag (animated <mask>
  // child geometry) so they can't diverge. Needs uOverrideTex/uHasOverrides
  // declared by the including shader.
  ['@@OVERRIDE_TRANSFORM@@', '_overrideTransform.glsl'],
  // A <clipPath>'s coverage at a point (evalClipCoverageAtRow, evalClipCoverage) -- shared by mantle.frag (a shape's
  // clip, a mask child's clip in the inline walk) and maskBake.frag (a mask child's own clip-path) so they cannot
  // diverge. MUST follow @@COVERAGE@@ (renderFill) and @@OVERRIDE_TRANSFORM@@ (transformClipCoord).
  ['@@CLIP_WALK@@', '_clipWalk.glsl'],
  // Rect addressing for filter-graph passes (mapIn / sampleIn). Every fe*
  // shader that samples an input includes this: an input RT has its own canvas
  // rect, so its uv is an affine remap of vUV rather than vUV itself.
  ['@@FILTER_RECT@@', '_filterRect.glsl'],
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
/** @param {string} src @param {Record<string, string>} [helpers] @returns {string} */
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
      if (out.includes(marker)) out = out.split(marker).join(helpers[marker]);
    }
  }
  // Second comment-strip pass: helper bodies are inlined raw and
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
/// passes, which is possible because the assembled shader is valid GLSL.
/** @param {string} src @returns {string} */
export function minifyGlsl(src) {
  let s = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments → space
    .replace(/\/\/[^\n]*/g, ''); // line comments
  const lines = s
    .split('\n')
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
/** @param {string} raw @param {Record<string, string>} helpers @param {{ minify?: boolean }} [opts] @returns {string} */
export function assembleShader(raw, helpers, opts) {
  let glsl = preprocess(raw, helpers);
  glsl =
    glsl
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '') + '\n';
  return opts && opts.minify ? minifyGlsl(glsl) : glsl;
}

/// The source text of src/shaders/bundled.js for `entries` = [[key, assembledGlsl], ...]: one string export per
/// shader. Shared by scripts/buildShaders.mjs and the freshness test so the committed module cannot drift.
/** @param {[string, string][]} entries */
export function bundledModuleSource(entries) {
  const lines = [
    '// AUTO-GENERATED by scripts/buildShaders.mjs from src/shaders/generated/*.glsl text - DO NOT EDIT.',
    '// The assembled shaders as plain string exports. `bundleShaders.fromPackage()` / `loadShaders()` import this',
    '// module, so no bundler has to emit or serve .glsl files. Import single names to tree-shake the rest:',
    "//   import { fillVert, fillFrag } from '@kontek/mantle/shaders/bundled';",
    '',
  ];
  for (const [key, glsl] of entries)
    lines.push(`/** @type {string} */ export const ${key} = ${JSON.stringify(glsl)};`);
  return lines.join('\n') + '\n';
}

/// The source text of src/shaders/bundledSources.js: the COMPACT form `bundleShaders.fromPackage()` loads. The
/// assembled shaders repeat the same helper bodies in every program (800 KB, 190 KB gzipped); storing each source and
/// helper once, `//` comments stripped, and splicing them on load (assembleShader, the build's own function) is half
/// the bytes and yields the identical text. `sources` = [[key, rawSource]], `helpers` = [[marker, helperSource]].
/** @param {[string, string][]} sources @param {[string, string][]} helpers */
export function bundledSourcesModuleSource(sources, helpers) {
  const strip = (t) => t.replace(/\/\/[^\n]*/g, '');
  const obj = (pairs) =>
    '{\n' +
    pairs.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(strip(v))},`).join('\n') +
    '\n}';
  return [
    '// AUTO-GENERATED by scripts/buildShaders.mjs - DO NOT EDIT.',
    '// Every shader source and helper once, `//` comments stripped. loadShaders() splices them with assembleShader(),',
    '// which reproduces src/shaders/generated/*.glsl byte for byte (test/shaderGeneratedFreshSmoke.mjs).',
    '',
    '/** @type {Record<string, string>} */',
    `export const SOURCES = ${obj(sources)};`,
    '',
    '/** @type {Record<string, string>} */',
    `export const HELPERS = ${obj(helpers)};`,
    '',
  ].join('\n');
}

/// (Fill-feature omission -- which `MANTLE_NO_<FEAT>` defines a program compiles out -- is the renderer's own
/// business: its fill variants define the features a bundle does not use, renderer/fillOmit.js. The public
/// fillOmitDefines / featuresToFillDefines / FILL_FEATURES that fed createRenderer's `fillDefines` are removed;
/// that option is a debug-only test hook.)

/// Build the createRenderer-shaped dict from raw shader sources + a
/// helpers dict. Synchronous; suitable for bundler-time inline use.
///
///   import fillVert from './mantle.vert.glsl?raw';
///   import fillFrag from './mantle.frag.glsl?raw';
///   ...
///   const sources = bundleShaders(
///     { fillVert, fillFrag, /* ...all shaders */ },
///     { '@@GRADIENT_HELPERS@@': gradHelp, /* ... */ });
///   const renderer = createRenderer(gl, sources);
///
/// `rawSources` is keyed by SHADER_NAMES key (e.g. `fillFrag`).
/// `helpers` is keyed by marker string (e.g. `'@@GRADIENT_HELPERS@@'`).
/// Use SHADER_FILENAMES / HELPER_FILENAMES (exported) as the
/// canonical lists when wiring imports.
/**
 * @param {Record<string, string | null | undefined>} rawSources
 * @param {Record<string, string>} [helpers]
 * @returns {ShaderSources}
 */
export function bundleShaders(rawSources, helpers) {
  /** @type {ShaderSources} */
  const out = {};
  for (const [key /*, _filename */] of SHADER_NAMES) {
    const raw = rawSources[key];
    if (raw == null) continue; // missing optional shader -> renderer gates on null
    out[key] = preprocess(raw, helpers);
  }
  return out;
}

/// One-liner shader loading that needs no consumer wiring and no bundler configuration:
///
///   import { bundleShaders } from '@kontek/mantle/shaders';
///   const renderer = createRenderer(gl, await bundleShaders.fromPackage());
///
/// It imports the package's own bundledSources.js module (see the header, path 0), so it behaves the same
/// unbundled, under Vite / webpack / rollup / esbuild, and in Node. `spec` selects which shaders end up in
/// the dict (same as loadShaders):
///   await bundleShaders.fromPackage({ features: flags })   // core + needed
///   await bundleShaders.fromPackage({ include: [...] })    // core + explicit
///
/// Cost: with a code-splitting bundler the shaders are one lazy chunk loaded by this call; without
/// splitting they are part of your bundle. To ship fewer bytes import the named exports you need from
/// '@kontek/mantle/shaders/bundled'. To fetch .glsl files from your own server instead, call
/// `loadShaders(baseUrl)`.
/**
 * @param {ShaderSpec} [spec]
 * @returns {Promise<ShaderSources>}
 */
bundleShaders.fromPackage = function fromPackage(spec) {
  return loadShaders(undefined, spec);
};

const looksLikeHtml = (text) => /^\s*<(?:!doctype|html|head|body)/i.test(text);

/// GET one text file. `file:` URLs go through node:fs when this is Node (undici's fetch refuses them);
/// everything else uses fetch. Returns { ok, status, text, why } and never throws for a missing file.
async function getText(url) {
  if (url.protocol === 'file:') {
    let fs = null;
    try {
      fs = await nodeBuiltin('fs', 'no fs');
    } catch {
      /* not Node: fetch below */
    }
    if (fs) {
      try {
        return { ok: true, status: 200, text: await fs.promises.readFile(url, 'utf8'), why: '' };
      } catch (e) {
        return { ok: false, status: 404, text: '', why: String((e && e.code) || e) };
      }
    }
  }
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status, text: '', why: `HTTP ${res.status}` };
  const type = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
  const text = await res.text();
  // A static host with an SPA fallback answers any missing path 200 with index.html.
  if (/text\/html/i.test(type) || looksLikeHtml(text)) {
    return {
      ok: false,
      status: res.status,
      text: '',
      why: `answered with HTML (${type || 'no content-type'}), not GLSL`,
    };
  }
  return { ok: true, status: res.status, text, why: '' };
}

const URL_HINT =
  ' loadShaders(baseUrl) fetches .glsl files the host must serve; a bundler does not emit them. ' +
  'Call loadShaders() / bundleShaders.fromPackage() with no URL to use the bundled module instead.';

/// Load the dict from the bundled module (path 0): the compact sources, spliced exactly as the build splices them.
/// Throws if the module is missing a requested key.
async function loadBundled(names) {
  const { SOURCES, HELPERS } = await import('./bundledSources.js');
  /** @type {ShaderSources} */
  const out = {};
  for (const [key, file] of names) {
    const src = SOURCES[key];
    if (typeof src !== 'string') {
      throw new Error(
        `loadShaders: bundledSources.js has no '${key}' (${file}); run \`npm run build:shaders\` in the source tree.`,
      );
    }
    out[key] = assembleShader(src, HELPERS);
  }
  return out;
}

/// Load the shader dict createRenderer expects.
///
///   loadShaders()                    // the bundled module (default, bundler-agnostic)
///   loadShaders(undefined, spec)     // ... a feature subset
///   loadShaders(baseUrl)             // opt-in: fetch <baseUrl>/generated/*.glsl
///   loadShaders(baseUrl, spec)       // ... a feature subset of those
///
/// With a `baseUrl` it fetches `./generated/<file>` relative to it (pre-assembled by
/// `npm run build:shaders`: no helper fetch, no @@marker@@ splice), and falls back to the sibling
/// marker-bearing sources + HELPER_INCLUDES when generated/ is absent (a source checkout). Each response
/// is validated and a failure throws with the URL, the status and a hint.
///
/// `spec` selects which shaders (see ShaderSpec). Omitting it loads everything. The renderer null-gates
/// every optional program, so a filtered dict compiles cleanly. A single object argument is read as the
/// spec: `loadShaders({ features })`.
/**
 * @param {string | URL | ShaderSpec | null} [baseUrl]
 * @param {ShaderSpec} [spec]
 * @returns {Promise<ShaderSources>}
 */
export async function loadShaders(baseUrl, spec) {
  if (baseUrl != null && typeof baseUrl === 'object' && !(baseUrl instanceof URL)) {
    spec = /** @type {ShaderSpec} */ (baseUrl);
    baseUrl = undefined;
  }
  const wanted = shaderKeysFor(spec); // null = everything
  const names = wanted ? SHADER_NAMES.filter(([key]) => wanted.has(key)) : SHADER_NAMES;
  if (baseUrl == null) return loadBundled(names);

  const genBase = new URL('./generated/', /** @type {string | URL} */ (baseUrl));
  const failures = [];

  // Fetch the assembled set once. Fall back as a unit if any requested file is
  // absent, which keeps partially generated development trees usable.
  try {
    const got = await Promise.all(names.map(([, file]) => getText(new URL(file, genBase))));
    const bad = got.findIndex((g) => !g.ok);
    if (bad < 0) return Object.fromEntries(got.map((g, i) => [names[i][0], g.text]));
    failures.push(`${new URL(names[bad][1], genBase).href}: ${got[bad].why}`);
  } catch (e) {
    failures.push(`${genBase.href}: ${(e && e.message) || e}`);
  }

  const helpers = {};
  for (const [marker, file] of HELPER_INCLUDES) {
    const url = new URL(`./${file}`, /** @type {string | URL} */ (baseUrl));
    const g = await getText(url).catch((e) => ({
      ok: false,
      text: '',
      why: String((e && e.message) || e),
    }));
    if (!g.ok)
      throw new Error(
        `loadShaders: cannot load shaders from ${new URL('./', url).href}: ${failures[0]}; ` +
          `then helper ${file}: ${g.why}.${URL_HINT}`,
      );
    helpers[marker] = g.text;
  }
  const entries = await Promise.all(
    names.map(async ([key, file]) => {
      const url = new URL(`./${file}`, /** @type {string | URL} */ (baseUrl));
      const g = await getText(url);
      if (!g.ok)
        throw new Error(
          `loadShaders: failed to load shader ${file} from ${url.href}: ${g.why}.${URL_HINT}`,
        );
      return [key, preprocess(g.text, helpers)];
    }),
  );
  return Object.fromEntries(entries);
}
