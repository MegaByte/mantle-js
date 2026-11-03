// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Validate test ownership, browser backends, and the boundary between CPU tests and shader models.
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ACCURACY_DIAGNOSTICS } from '../scripts/accuracyDiagnostics.mjs';
import { MANUAL_CHECKS } from '../scripts/manualChecks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const files = [];
(function scan(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      scan(p);
      continue;
    }
    if (name.endsWith('.mjs')) files.push(p);
  }
})(path.join(ROOT, 'test'));
const src = new Map(files.map((p) => [path.relative(ROOT, p), readFileSync(p, 'utf8')]));
// A file may NAME the flag it must not pass — this one does, at length — so the scans read code,
// not prose: line comments stripped, block comments stripped, everything else kept verbatim.
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
const code = new Map([...src].map(([f, s]) => [f, stripComments(s)]));
// A physical-GPU smoke may spawn a shared probe CLI rather than launch inline.
// Follow the actual literal Node entry point and its imports; naming a probe
// in prose or an unrelated string is not enough to put a test in this lane.
function browserEntries(rel, seen = new Set()) {
  if (seen.has(rel)) return [];
  seen.add(rel);
  let s = code.get(rel);
  if (s === undefined) {
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT + path.sep)) return [];
    try {
      s = stripComments(readFileSync(abs, 'utf8'));
    } catch {
      return [];
    }
  }
  if (
    /from\s+['"][^'"]*_launch\.mjs['"]|import\s*\(\s*['"][^'"]*_launch\.mjs['"]|from\s+['"]puppeteer['"]|require\(['"]puppeteer['"]\)/.test(
      s,
    )
  )
    return [rel];
  const deps = [...s.matchAll(/from\s+['"](\.[^'"]+\.mjs)['"]/g)].map((m) =>
    path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])),
  );
  for (const m of s.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+\.mjs)['"]\s*\)/g))
    deps.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  for (const m of s.matchAll(
    /\bexecFileSync\s*\(\s*process\.execPath\s*,\s*\[\s*path\.join\s*\(\s*root\s*,\s*['"]([^'"]+\.mjs)['"]/g,
  ))
    deps.push(m[1]);
  return deps.flatMap((dep) => browserEntries(dep, seen));
}

// ---- (a) nothing pins the ANGLE backend ---------------------------------------------------------
{
  const pinned = [...code]
    .filter(([, s]) => /--use-angle=(swiftshader|vulkan|gl|d3d11|d3d9)\b/.test(s))
    .map(([f]) => f);
  // The counts are MEASURED and printed, not quoted: a count written in a header goes stale.
  const n = (re) => [...code].filter(([, s]) => re.test(s)).length;
  ok(
    pinned.length === 0,
    `(a) no test pins ANGLE to a backend behind the lane's back${pinned.length ? ': ' + pinned.join(', ') : ''} ` +
      `(${src.size} files: ${n(/MANTLE_TEST_GL === 'swiftshader'/)} read the switch, ` +
      `${n(/--use-angle=metal/)} name metal, ${n(/--enable-unsafe-swiftshader/)} permit the software fallback — ` +
      `permitting it is not selecting it, and --use-angle=metal is the switch's own default arm)`,
  );
  // ...and the two that pin a backend are on the lane's switch, with a software arm still reachable.
  for (const f of ['test/shapeAnimationVisualSmoke.mjs', 'test/overrideVisibilityFadeSmoke.mjs']) {
    const s = src.get(f) || '';
    ok(
      /MANTLE_TEST_GL === 'swiftshader'/.test(s) &&
        /--use-angle=metal/.test(s) &&
        /--enable-unsafe-swiftshader/.test(s),
      `(a) ${f} reads MANTLE_TEST_GL, with both arms`,
    );
  }
}

// ---- (b) every launch goes through the self-cleaning profile (T2) --------------------------------
{
  const direct = [...code]
    .filter(([f, s]) => f !== 'test/_launch.mjs' && /\bpuppeteer\s*\.\s*launch\s*\(/.test(s))
    .map(([f]) => f);
  ok(
    direct.length === 0,
    `(b) no test calls puppeteer.launch directly${direct.length ? ': ' + direct.join(', ') : ''} — ` +
      `every browser gets a mkdtemp profile removed on close, exit and signal`,
  );
  const launchers = [...code].filter(
    ([f, s]) => f !== 'test/_launch.mjs' && /launchBrowser\s*\(/.test(s),
  ).length;
  ok(launchers > 200, `(b) ${launchers} smokes launch through test/_launch.mjs`);
}

// Publishing must preserve the same separation as the validation runners.
const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
const invokesModel = (name, seen = new Set()) => {
  if (seen.has(name)) return false;
  seen.add(name);
  const command = scripts[name] || '';
  return (
    /runAccuracyDiagnostics\.mjs/.test(command) ||
    [...command.matchAll(/\bnpm run ([\w:-]+)/g)].some((m) => invokesModel(m[1], seen))
  );
};
for (const name of ['prepublishOnly', 'test', 'test:render', 'test:lanes'])
  ok(!invokesModel(name), `${name}: shader models remain development diagnostics`);

// Every non-helper has one explicit owner. Model diagnostics are never validation entries.
const registered = (file) =>
  [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/^\s*'(test\/[^']+\.mjs)',/gm)].map(
    (m) => m[1],
  );
const lanes = {
  cpu: registered('scripts/runSmokes.mjs'),
  gpu: registered('scripts/runRenderSmokes.mjs'),
  diagnostics: ACCURACY_DIAGNOSTICS,
  manual: MANUAL_CHECKS,
};
for (const [name, rows] of Object.entries(lanes)) {
  const duplicates = rows.filter((r, i) => rows.indexOf(r) !== i),
    missing = rows.filter((r) => !src.has(r));
  ok(
    !duplicates.length && !missing.length,
    `${name}: ${rows.length} distinct, existing entries${duplicates.length ? '; duplicates ' + duplicates : ''}${missing.length ? '; missing ' + missing : ''}`,
  );
}
const wrongOwner = [...src.keys()].filter(
  (f) =>
    !path.basename(f).startsWith('_') &&
    Object.values(lanes).filter((rows) => rows.includes(f)).length !== 1,
);
ok(
  !wrongOwner.length,
  `every non-helper has exactly one owner${wrongOwner.length ? ': ' + wrongOwner.join(', ') : ''}`,
);
const cpuBrowsers = lanes.cpu.filter((f) => browserEntries(f).length);
ok(
  !cpuBrowsers.length,
  `CPU validation starts no browser${cpuBrowsers.length ? ': ' + cpuBrowsers.join(', ') : ''}`,
);
const quietGpu = lanes.gpu.filter((f) => !browserEntries(f).length);
ok(
  !quietGpu.length,
  `GPU validation starts a browser${quietGpu.length ? ': ' + quietGpu.join(', ') : ''}`,
);
// Inspect transitive test-helper imports. Independent SVG/spec oracles and fake-GL
// call recorders are valid CPU test helpers; shader models and software GPU rasterizers are not.
const model =
  /(?:_cpatchBlendShaderModel|_glslEmu|_glslMainEmu|_fragEmu|_lbPipeEmu|_strokeBandEmu|_lbRaster|_lbStaticDrawEmu|_lbMorphDrawEmu|_synthBoldInkModel)\.mjs$/;
function modelEntries(rel, seen = new Set()) {
  if (seen.has(rel)) return [];
  seen.add(rel);
  if (model.test(rel)) return [rel];
  const s = code.get(rel);
  if (!s) return [];
  const deps = [...s.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)['"](\.[^'"]+\.mjs)['"]/g)].map((m) =>
    path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])),
  );
  const callsPatchModel =
    /(?:import\s*\{|const\s*\{)[^}]*\b(?:patchCoverage|coverageMiss)\b[^}]*\}[^;]*cpatchCov\.js/.test(
      s,
    ) || /path\.join\(ROOT,\s*['"]probes\/cpatchGate\/_rowGateSpill\.mjs/.test(s);
  const callsShaderModel =
    /import\s*\{[^}]*\b(?:minDist|minDistCurve)\b[^}]*\}\s*from\s*['"][^'"]*_stroke(?:Shape|Curve)Ref\.mjs['"]/.test(
      s,
    );
  // Numeric GLSL translated into JavaScript is a model even when it has no shared emulator import.
  // Boolean preprocessor evaluation remains a CPU build check.
  const translatesNumericGLSL =
    /\.glsl['"]/.test(s) &&
    /\bFunction\s*\(\s*['"](?:abs|max|min|sqrt|sin|cos|pow|clamp|mix|cx|cy|rx|ry)['"]\s*,/.test(s);
  const inlineBlendModel = /\bfunction\s+blendPass\s*\(/.test(s) && /\bMath\.fround\b/.test(s);
  return [
    ...(callsShaderModel || callsPatchModel || translatesNumericGLSL || inlineBlendModel
      ? [rel]
      : []),
    ...deps.flatMap((dep) => modelEntries(dep, seen)),
  ];
}
// Classification controls cover an inline model hidden in a call-recorder helper,
// a named model behind another helper, and a pure state/upload recorder.
code.set(
  'test/_classificationInline.mjs',
  ['function', 'blendPass() { return Math.fround(1); }'].join(' '),
);
code.set(
  'test/_classificationBridge.mjs',
  ['import', "'./_cpatchBlendShaderModel.mjs';"].join(' '),
);
code.set(
  'test/_classificationRecorder.mjs',
  'export function record(gl) { return new Float32Array(4); }',
);
ok(
  modelEntries('test/_classificationInline.mjs').length === 1,
  'classification rejects inline shader arithmetic',
);
ok(
  modelEntries('test/_classificationBridge.mjs').length === 1,
  'classification rejects transitive shader-model imports',
);
ok(
  modelEntries('test/_classificationRecorder.mjs').length === 0,
  'classification retains genuine CPU state/upload recorders',
);
for (const name of [
  'test/_classificationInline.mjs',
  'test/_classificationBridge.mjs',
  'test/_classificationRecorder.mjs',
])
  code.delete(name);
const simulated = lanes.cpu.flatMap((f) => modelEntries(f).map((dep) => `${f} -> ${dep}`));
ok(
  !simulated.length,
  `CPU validation imports no GPU emulator or shader distance model${simulated.length ? ': ' + simulated.join(', ') : ''}`,
);
if (fail) {
  console.error(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log('testLaneBackendSmoke: all checks passed');
