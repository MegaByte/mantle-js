// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rendererOptionsListSmoke -- createRenderer's known-option list (contextCheck.js KNOWN_RENDERER_OPTIONS) is the set of options the renderer reads.
//
// The list is written by hand, so it can drift: an option the renderer reads but the list lacks warns "unknown option ... is ignored" on every page, and a
// listed option nothing reads is accepted silently. Every `R.opts.<key>` the source reads is listed, and every
// listed key is read somewhere outside the list.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SRC = new URL('../src', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(SRC);
const listSrc = readFileSync(join(SRC, 'renderer/contextCheck.js'), 'utf8');
const m = listSrc.match(/KNOWN_RENDERER_OPTIONS\s*=\s*new Set\(\s*\(([\s\S]*?)\)\.split/);
ok(!!m, 'the list is found in contextCheck.js');
const known = new Set(
  m
    ? Function('return (' + m[1] + ')')()
        .split(' ')
        .filter(Boolean)
    : [],
);
const others = files
  .filter((f) => !f.endsWith('contextCheck.js'))
  .map((f) => readFileSync(f, 'utf8'));
const reads = new Set();
for (const s of others) for (const x of s.matchAll(/R\.opts\.([A-Za-z_]\w*)/g)) reads.add(x[1]);
const missing = [...reads].filter((k) => !known.has(k)).sort();
ok(
  missing.length === 0,
  `every R.opts.<key> the renderer reads is a known option (${missing.length} missing${missing.length ? ': ' + missing.join(' ') : ''})`,
);
const all = others.join('\n');
const dead = [...known].filter((k) => !new RegExp('\\b' + k + '\\b').test(all)).sort();
ok(
  dead.length === 0,
  `every known option is read somewhere (${dead.length} never read${dead.length ? ': ' + dead.join(' ') : ''})`,
);
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
