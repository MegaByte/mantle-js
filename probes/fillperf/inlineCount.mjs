// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// inlineCount — how many copies of a function a root inlines: its call sites multiplied through the call tree, on an
// assembled shader's text (every #if branch counted). Node only.
//
//   node probes/fillperf/inlineCount.mjs src/shaders/generated/mantle.frag.glsl aacWalkBand aacSolveC aacTrigSolve
import { readFileSync } from 'fs';
const [file, root, ...targets] = process.argv.slice(2);
let src = readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, '');
const fns = new Map();
const re = /\n[ \t]*(?:highp |mediump |lowp )?\w+[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t\n]*\{/g;
let m;
while ((m = re.exec(src))) {
  let d = 0,
    i = src.indexOf('{', m.index + m[0].length - 1);
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}' && --d === 0) break;
  }
  fns.set(m[1], src.slice(start, i + 1));
}
const memo = new Map();
function count(fn, t) {
  const key = fn + '|' + t;
  if (memo.has(key)) return memo.get(key);
  memo.set(key, 0);
  const body = fns.get(fn) || '';
  let n = 0;
  for (const [g] of fns) {
    if (g === fn) continue;
    const calls = (body.match(new RegExp(`\\b${g}\\s*\\(`, 'g')) || []).length;
    if (!calls) continue;
    n += calls * (g === t ? 1 : count(g, t));
  }
  memo.set(key, n);
  return n;
}
for (const t of targets) console.log(`${t} inlined into ${root}: ${count(root, t)}`);
