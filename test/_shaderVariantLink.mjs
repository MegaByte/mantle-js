// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _shaderVariantLink.mjs -- every fill-program define set the renderer can build must COMPILE and LINK, and the two stages
// must agree on each shared varying's interpolation qualifier.
//
// scripts/buildShaders.mjs validates each generated file once, with no defines, so a change that breaks only
// MANTLE_LB_FILL or a MANTLE_NO_* lean variant passes the build and blanks at runtime (a shader error falls back
// silently). This compiles generated/mantle.vert.glsl + generated/mantle.frag.glsl under each define set below and links
// them with glslangValidator -l.
//
// glslangValidator does NOT check that interpolation qualifiers match across stages, which GLSL ES 3.00 requires (a
// `flat out` meeting a smooth `in` is a link error on a conformant driver), so that is checked here on the preprocessed
// text: every fragment input that the vertex stage writes must carry the same qualifier.
//
//   node test/_shaderVariantLink.mjs            (exit 0 = all link, 1 = a failure, 77 = no glslangValidator or clang)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { clangPreprocess } from './_glslMainEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (cmd, args) =>
  spawnSync(cmd, args, { stdio: 'ignore' }).error == null &&
  spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
export const hasLinker = () => has('glslangValidator', ['-v']) && has('clang', ['--version']);

const NO_ALL = [
  'MANTLE_NO_CLIP',
  'MANTLE_NO_MASK',
  'MANTLE_NO_EXTCLIP',
  'MANTLE_NO_FILTER',
  'MANTLE_NO_GRADIENT',
  'MANTLE_NO_STROKE',
  'MANTLE_NO_PATTERN',
  'MANTLE_NO_IMAGE',
  'MANTLE_NO_RECOLOR',
];
/// The define sets: every engine, the Loop-Blinn and CPatch unified variants, the composed (morph) programs, instancing,
/// and each MANTLE_NO_* the feature selector can emit (MANTLE_NO_IMAGE only alongside pattern, mask and stroke, as
/// renderer/fillOmit.js omitDefinesFor emits it).
export const DEFINE_SETS = [
  [],
  ['MANTLE_EXACT_EDGE'],
  ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'],
  ['MANTLE_GWN', 'MANTLE_GWN_SDF'],
  ['MANTLE_GWN'],
  ['MANTLE_HARD'],
  ['MANTLE_HARD', 'MANTLE_HARD_TREE'],
  ['MANTLE_HARD_MIXED', 'MANTLE_HARD_TREE'],
  ['MANTLE_HARD_MIXED', 'MANTLE_AAC'],
  ['MANTLE_LB_FILL'],
  ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX'],
  ['MANTLE_LB_FILL', 'MANTLE_CPATCH'],
  ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX', 'MANTLE_CPATCH'],
  ['MANTLE_LB_FILL', 'MANTLE_LB_MORPH', 'MANTLE_LB_CURVE_TEX', 'MANTLE_CPATCH'],
  ['MANTLE_LB_FILL', 'MANTLE_COVER_KERNEL', 'MANTLE_HARD_MIXED', 'MANTLE_HARD_TREE', 'MANTLE_AAC'],
  ['MANTLE_LB_FILL', 'MANTLE_LB_MORPH'],
  ['MANTLE_LB_FILL', 'MANTLE_LB_MORPH', 'MANTLE_LB_CURVE_TEX'],
  ['MANTLE_COMPOSED', 'MANTLE_LB_FILL_COV'],
  ['MANTLE_COMPOSED', 'MANTLE_AAC'],
  ['MANTLE_INSTANCED'],
  ['MANTLE_INSTANCED', ...NO_ALL],
  NO_ALL,
  ['MANTLE_LB_FILL', ...NO_ALL],
  ...NO_ALL.filter((d) => d !== 'MANTLE_NO_IMAGE').map((d) => [d]),
  ['MANTLE_NO_IMAGE', 'MANTLE_NO_PATTERN', 'MANTLE_NO_MASK', 'MANTLE_NO_STROKE'],
  ['MANTLE_COMPOSED', 'MANTLE_NO_EXTCLIP', 'MANTLE_NO_PATTERN', 'MANTLE_LB_FILL_COV'],
  ['MANTLE_COMPOSED', 'MANTLE_NO_EXTCLIP', 'MANTLE_NO_PATTERN'],
  ['MANTLE_NO_CLIP', 'MANTLE_NO_MASK'],
  ['MANTLE_NO_STROKE', 'MANTLE_NO_GRADIENT'],
];

const withDefs = (src, defs) =>
  src.replace(
    /^#version 300 es\n/,
    `#version 300 es\n${defs.map((d) => `#define ${d}\n`).join('')}`,
  );
const pp = (src) =>
  clangPreprocess(src.replace(/^#version[^\n]*\n/, ''), ['-P', '-x', 'c', '-Wno-everything'])
    .stdout;
/// name -> qualifier ('flat' / 'smooth' / 'centroid' / '') for each `kw` (in / out) declaration, comma lists included.
export function stageQualifiers(text, kw) {
  const m = new Map();
  const re = new RegExp(
    `^\\s*(flat\\s+|smooth\\s+|centroid\\s+)?${kw}\\s+(?:(?:highp|mediump|lowp)\\s+)?\\w+\\s+([\\w\\s,]+?)\\s*;`,
    'gm',
  );
  for (const x of text.matchAll(re))
    for (const n of x[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      m.set(n, (x[1] || '').trim());
  return m;
}
/// Shared varyings whose qualifiers differ between a vertex and a fragment text (after preprocessing).
export function qualifierMismatches(vertText, fragText) {
  const vo = stageQualifiers(pp(vertText), 'out'),
    fi = stageQualifiers(pp(fragText), 'in');
  return [...fi]
    .filter(([n, q]) => vo.has(n) && vo.get(n) !== q)
    .map(([n, q]) => `${n}: vert '${vo.get(n)}' frag '${q}'`);
}

/// Compile + link one vertex/fragment pair per define set. Returns [{ defs, ok, errors }].
export function linkVariants({ vert, frag, sets = DEFINE_SETS } = {}) {
  vert = vert ?? readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
  frag = frag ?? readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const dir = path.join(os.tmpdir(), `mantle-variant-link-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const out = [];
  try {
    sets.forEach((defs, i) => {
      const v = path.join(dir, `v${i}.vert`),
        f = path.join(dir, `v${i}.frag`);
      const vt = withDefs(vert, defs),
        ft = withDefs(frag, defs);
      writeFileSync(v, vt);
      writeFileSync(f, ft);
      const r = spawnSync('glslangValidator', ['-l', v, f], { encoding: 'utf8' });
      const errors = (r.stdout + r.stderr)
        .split('\n')
        .filter((l) => /ERROR/.test(l))
        .slice(0, 8);
      const q = qualifierMismatches(vt, ft).map(
        (m) => 'ERROR interpolation qualifiers differ: ' + m,
      );
      out.push({ defs, ok: r.status === 0 && !q.length, errors: [...errors, ...q] });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!hasLinker()) {
    console.log('SKIP _shaderVariantLink: needs glslangValidator and clang');
    process.exit(77);
  }
  const res = linkVariants();
  for (const r of res)
    console.log(
      `${r.ok ? 'ok  ' : 'FAIL'} [${r.defs.join(' ') || 'default'}]${r.ok ? '' : '\n  ' + r.errors.join('\n  ')}`,
    );
  const bad = res.filter((r) => !r.ok).length;
  console.log(
    bad
      ? `${bad} of ${res.length} define sets FAILED`
      : `all ${res.length} define sets compile + link`,
  );
  process.exit(bad ? 1 : 0);
}
