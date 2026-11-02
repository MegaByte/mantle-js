// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeWalkSiteBudgetSmoke -- the stroke walk (strokeBandAccum, most of a stroke program) is compiled once per CALL SITE, so a program's
// cold GPU-pipeline cost is linear in the number of sites that survive its defines. Two entries (conformal and stroke-space) would make
// every site two copies, doubling the general fill program's cold build. This guards the budget, on the text a
// program is built from:
//   * every program calls the walk through strokeWalk only (never strokeMinDist / strokeMinDistLocal, which are harness wrappers);
//   * the walk call sites left after the defines, per variant: general program <= 4 (top-level, mask child, two pattern sites),
//     no pattern <= 2, no mask or pattern <= 1, no stroke 0 -- the lean program of a stroked bundle holds ONE copy;
//   * the mask-bake program holds 2 sites, the point-route vertex program 3;
//   * the general fill fragment source stays inside its size budget.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT =
  process.env.MANTLE_SHADER_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(ROOT, 'src/shaders/generated');
const read = (f) => readFileSync(path.join(GEN, f), 'utf8');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

function applyDefines(src, defs) {
  const D = new Set(defs);
  const ev = (e) => {
    try {
      return !!Function(
        'return(' + e.replace(/defined\s*\(\s*(\w+)\s*\)/g, (m, n) => (D.has(n) ? '1' : '0')) + ')',
      )();
    } catch {
      return true;
    }
  };
  const out = [],
    st = [];
  for (const ln of src.split('\n')) {
    let m;
    if ((m = ln.match(/^\s*#ifndef\s+(\w+)/))) {
      st.push(!D.has(m[1]));
      continue;
    }
    if ((m = ln.match(/^\s*#ifdef\s+(\w+)/))) {
      st.push(D.has(m[1]));
      continue;
    }
    if ((m = ln.match(/^\s*#if\s+(.+)/))) {
      st.push(ev(m[1]));
      continue;
    }
    if (/^\s*#else/.test(ln)) {
      st[st.length - 1] = !st[st.length - 1];
      continue;
    }
    if (/^\s*#endif/.test(ln)) {
      st.pop();
      continue;
    }
    if (st.every(Boolean)) out.push(ln);
  }
  return out.join('\n');
}
/// Remove a function definition (brace-matched) so only the CALLERS of what it calls remain.
function dropFn(src, name) {
  const m = new RegExp(`\\bfloat\\s+${name}\\s*\\(`).exec(src);
  if (!m) return src;
  let i = src.indexOf('{', m.index),
    depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(0, m.index) + src.slice(i + 1);
}
const sites = (src, name) =>
  (
    dropFn(dropFn(dropFn(src, 'strokeWalk'), 'strokeMinDist'), 'strokeMinDistLocal').match(
      new RegExp(`\\b${name}\\(`, 'g'),
    ) || []
  ).length;
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const frag = strip(read('mantle.frag.glsl'));
const OMIT = (...f) => f.map((x) => `MANTLE_NO_${x}`);
const variants = [
  ['general program', [], 4],
  ['no pattern', OMIT('PATTERN'), 2],
  ['no mask', OMIT('MASK'), 3],
  ['no mask, no pattern (a stroked bundle)', OMIT('MASK', 'PATTERN'), 1],
  ['no stroke', OMIT('STROKE', 'MASK', 'PATTERN'), 0],
];
for (const [label, defs, budget] of variants) {
  const t = applyDefines(frag, defs);
  const walk = sites(t, 'strokeWalk');
  ok(walk <= budget, `${label}: ${walk} strokeWalk call site(s) (budget ${budget})`);
  ok(
    sites(t, 'strokeMinDist') + sites(t, 'strokeMinDistLocal') === 0,
    `${label}: no direct strokeMinDist / strokeMinDistLocal call`,
  );
}
const bake = strip(read('maskBake.frag.glsl'));
ok(
  sites(bake, 'strokeWalk') <= 2 &&
    sites(bake, 'strokeMinDist') + sites(bake, 'strokeMinDistLocal') === 0,
  `mask bake: ${sites(bake, 'strokeWalk')} strokeWalk site(s) (budget 2), no direct entry call`,
);
const pts = strip(read('aacPoints.vert.glsl'));
const ptsAll = applyDefines(pts, [
  'MANTLE_POINTS_STROKE',
  'MANTLE_POINTS_MASK',
  'MANTLE_POINTS_PATTERN',
]);
ok(
  sites(ptsAll, 'strokeWalk') <= 3 &&
    sites(ptsAll, 'strokeMinDist') + sites(ptsAll, 'strokeMinDistLocal') === 0,
  `point route: ${sites(ptsAll, 'strokeWalk')} strokeWalk site(s) (budget 3), no direct entry call`,
);

const kb = read('mantle.frag.glsl').length / 1024;
ok(kb <= 300, `general fill fragment source ${kb.toFixed(0)} KB (budget 300 KB)`);
if (fail) {
  console.error(`FAIL strokeWalkSiteBudgetSmoke: ${fail}`);
  process.exit(1);
}
console.log('strokeWalkSiteBudgetSmoke PASS');
