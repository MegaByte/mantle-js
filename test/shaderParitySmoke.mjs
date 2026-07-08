// Guard the JS (GLSL) ↔ C# (HLSL) shader constants that MUST stay identical
// for pixel parity. The two coverage/filter shaders are hand-maintained ports
// of each other; a constant changed on one side and not the other silently
// breaks cross-runtime rendering (e.g. coverage-solver Newton iteration count,
// feMorphology kernel cap). Source lint — no GPU, so it runs in CI where the
// Unity batchmode render harness can't.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const GLSL = resolve(here, "../src/shaders/_slugCoverage.glsl");
const HLSL = resolve(here, "../../net.kontek.mantle/Runtime/Shaders/MantleSlug.hlsl");
const MORPH_GLSL = resolve(here, "../src/shaders/morph.frag.glsl");
const MORPH_HLSL = resolve(here, "../../net.kontek.mantle/Runtime/Shaders/MantleFilterFeMorphology.shader");

// Cross-package parity test: it compares this JS package's GLSL against the C#
// package's HLSL, so it needs the net.kontek.mantle sibling. Present in the
// monorepo; ABSENT when this package is split into its own repo — skip cleanly
// there (the parity check only has meaning where both packages coexist).
if (!existsSync(HLSL)) {
  console.log("SHADER-PARITY SKIP — net.kontek.mantle sibling not present (split JS repo); parity is checked in the monorepo.");
  process.exit(0);
}

const glsl = readFileSync(GLSL, "utf8");
const hlsl = readFileSync(HLSL, "utf8");
const mGlsl = readFileSync(MORPH_GLSL, "utf8");
const mHlsl = readFileSync(MORPH_HLSL, "utf8");

let fails = 0;
const check = (name, a, b) => {
  if (String(a) === String(b)) console.log(`  ok ${name}: ${a}`);
  else { console.log(`  FAIL ${name}: GLSL=${a} HLSL=${b}`); fails++; }
};

// The coverage-solver Newton loop starts from the bracket midpoint
// `0.5 * (lo + hi)`; capture the iteration count of the for-loop right after.
function coverageNewtonIters(src) {
  const i = src.indexOf("0.5 * (lo + hi)");
  if (i < 0) return "missing-midpoint-seed";
  const m = src.slice(i).match(/for\s*\(\s*int\s+k\s*=\s*0;\s*k\s*<\s*(\d+)/);
  return m ? m[1] : "no-loop";
}
check("coverage-solver Newton iters", coverageNewtonIters(glsl), coverageNewtonIters(hlsl));

// Apex-on-ray epsilon in the coverage solver.
const apexEps = (src) => (src.match(/const float EPS = (1e-6)/) || [])[1] || "missing";
check("coverage apex EPS", apexEps(glsl), apexEps(hlsl));

// feMorphology kernel cap (px/axis) — must match AND use ceil rounding.
const morphCap = (src) => (/\bmin\b[\s\S]{0,40}\b64\.0\b/.test(src) ? "64" : "?");
check("feMorphology cap", morphCap(mGlsl), morphCap(mHlsl));
const morphCeil = (src) => (/\bceil\b/.test(src) ? "ceil" : "other");
check("feMorphology rounding", morphCeil(mGlsl), morphCeil(mHlsl));

// Gradient stop sampler: the lower_bound binary search must use the SAME
// iteration budget in the GLSL helper and BOTH HLSL ports. Too few iters
// silently mis-brackets large gradients on one runtime only. The budget is
// the `for (int it = 0; it < N; ...)` right after the lo/hi seed.
const GRAD_GLSL = resolve(here, "../src/shaders/_gradientHelpers.glsl");
const GRAD_HLSL_COLR = resolve(here, "../../net.kontek.mantle/Runtime/Shaders/MantleColrHelpers.hlsl");
const GRAD_HLSL_SVG = resolve(here, "../../net.kontek.mantle/Runtime/Shaders/MantleCommon.hlsl");
const gradIters = (src) => {
  const i = src.indexOf("int lo = 0, hi = count - 1");
  if (i < 0) return "missing-binary-search";
  const m = src.slice(i).match(/for\s*\(\s*int\s+it\s*=\s*0;\s*it\s*<\s*(\d+)/);
  return m ? m[1] : "no-loop";
};
const glslGrad = readFileSync(GRAD_GLSL, "utf8");
const colrGrad = readFileSync(GRAD_HLSL_COLR, "utf8");
const svgGrad  = readFileSync(GRAD_HLSL_SVG, "utf8");
const gGlsl = gradIters(glslGrad);
check("gradient binary-search iters (GLSL vs HLSL-COLR)", gGlsl, gradIters(colrGrad));
check("gradient binary-search iters (GLSL vs HLSL-SVG)", gGlsl, gradIters(svgGrad));

// Stop texel layout: all three samplers MUST implement the SIGNED-count fast
// path — negative stopsCount = 1-texel opaque (rgb, offset); positive = 2-texel
// straight RGBA + separate offset. A side stuck on the old unconditional layout
// (or the premult/offset-in-alpha 1-texel layout) breaks JS↔C# parity AND either
// drops per-stop alpha or mis-reads the stride. The tell is the
// `oneTexel = stopsCount < 0` branch that only the signed layout has.
const fastPath = (src) => /oneTexel\s*=\s*stopsCount\s*<\s*0/.test(src) ? "signed-fast-path" : "STALE";
check("gradient stop layout (GLSL)", "signed-fast-path", fastPath(glslGrad));
check("gradient stop layout (HLSL-COLR)", "signed-fast-path", fastPath(colrGrad));
check("gradient stop layout (HLSL-SVG)", "signed-fast-path", fastPath(svgGrad));

if (fails === 0) {
  console.log("SHADER-PARITY PASS");
  process.exit(0);
}
console.log(`SHADER-PARITY FAIL (${fails})`);
process.exit(1);
