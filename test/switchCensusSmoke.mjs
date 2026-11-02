// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// switchCensusSmoke — every runtime switch the shipped JS reads is accounted for.
//
// The rule for switches: no ESCAPE switches, every OFF answered, live knobs kept, test hooks gated behind
// __MANTLE_DEBUG__, and diagnostics. An inventory is only true on the day it is taken, and a new
// `globalThis.__X` read is one line in any module, so this is the inventory as a gate. It reads src/ and sorts
// every global a module READS into:
//
//   DEBUG  read only through mantleDebugHook('__X') or mantleDebugFlag('name') (core/diagnostics.js): a
//          test hook or an A/B arm, inert unless __MANTLE_DEBUG__ is set.
//   DIAG   a diagnostic sink or output (workerFlags.js MAIN_THREAD_SINKS / LIBRARY_OUTPUTS, and the
//          main-thread-only sinks below): it records what the library did and changes no output.
//   OFF    an ungated switch with a stated reason -- named here WITH that reason, so the list cannot grow
//          without one.
//
// Anything else FAILS, naming the file and line: gate it (mantleDebugHook) if it is a test hook, or give
// it an OFF entry with its reason if it is an unanswered alternative. It also pins the process.env and
// URL switches the library reads. It does not judge an entry's class beyond its spelling: a sink that
// changed output would pass here, which is another list's job to prevent.
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = await import('../src/renderer/workerFlags.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Main-thread diagnostics outside the worker graphs (workerFlags lists only what a worker can reach).
const DIAG_MAIN = new Set([
  '__CPATCH_TRACE',
  '__CP_CURVE_HIST',
  '__CP_POOL_TAP',
  '__CP_TRACE',
  '__cpTrace',
  '__CP_MISFIT_WHY',
]);
const DIAG = new Set([...W.MAIN_THREAD_SINKS, ...W.LIBRARY_OUTPUTS, ...DIAG_MAIN]);

/// THE OFF SWITCHES: switch -> the reason it stays.
const OFF = {
  __LB_BAND_FOOTPRINT: '(opt-in, off by default)',
};
const ENV_OK = {
  CPATCH_AUDIT_ROOTS: 'DIAG: cpatchImplicit audits closed-form roots against subdivision',
};
// No URL switch: the ?mantleNative query that forced the native backend is deleted.
const URL_OK = {};

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.m?js$/.test(f)) files.push(p);
  }
};
walk(path.join(ROOT, 'src'));
// comments out, string contents kept (a hook name is a string)
const strip = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const raw = new Map(),
  gated = new Set(),
  env = new Map(),
  url = new Set();
const note = (m, n, where) => {
  if (!m.has(n)) m.set(n, []);
  if (!m.get(n).includes(where)) m.get(n).push(where);
};
for (const f of files) {
  const rel = path.relative(path.join(ROOT, 'src'), f);
  if (rel === 'renderer/workerFlags.js') continue; // the lists themselves
  const lines = strip(readFileSync(f, 'utf8')).split('\n');
  lines.forEach((ln, i) => {
    const where = `${rel}:${i + 1}`;
    for (const m of ln.matchAll(
      /globalThis\s*\)?\s*\.\s*(__[A-Za-z]\w*)(\s*(?:=(?!=)|\+\+|\+=|\?\?=|\|\|=))?/g,
    ))
      if (!m[2]) note(raw, m[1], where);
    for (const m of ln.matchAll(/\bG\(\s*'(__\w+)'/g)) note(raw, m[1], where);
    for (const m of ln.matchAll(/mantleDebugHook\(\s*['"](__\w+)['"]/g)) gated.add(m[1]);
    for (const m of ln.matchAll(/process\.env\.(\w+)|process\.env\[['"](\w+)['"]\]/g))
      note(env, m[1] || m[2], where);
    if (/URLSearchParams|location\.search/.test(ln)) url.add(rel);
  });
}
// mantleDebugFlag's switch maps names to globals inside diagnostics.js: those reads are the gate itself.
const diagSrc = readFileSync(path.join(ROOT, 'src/core/diagnostics.js'), 'utf8');
for (const m of diagSrc.matchAll(/case '\w+':\s*return[^;]*?\bg\.(__\w+)/g)) gated.add(m[1]);
raw.delete('__MANTLE_DEBUG__'); // the gate itself
for (const n of gated) {
  const w = raw.get(n);
  if (w)
    raw.set(
      n,
      w.filter((x) => !x.startsWith('core/diagnostics.js')),
    );
  if (raw.get(n) && !raw.get(n).length) raw.delete(n);
}

const classes = { DEBUG: [...gated].sort(), DIAG: [], OFF: [], UNACCOUNTED: [] };
for (const [n, where] of [...raw].sort()) {
  if (DIAG.has(n)) classes.DIAG.push(n);
  else if (OFF[n]) classes.OFF.push(n);
  else
    classes.UNACCOUNTED.push(
      `${n} (${where.slice(0, 3).join(', ')}${where.length > 3 ? ', ...' : ''})`,
    );
}
const both = classes.DEBUG.filter((n) => raw.has(n) && !DIAG.has(n));
console.log(
  `switch census: ${classes.DEBUG.length} DEBUG, ${classes.DIAG.length} DIAG, ${classes.OFF.length} OFF ` +
    `(with reasons), ${classes.UNACCOUNTED.length} unaccounted; ${env.size} process.env, ${url.size} URL`,
);
ok(
  !classes.UNACCOUNTED.length,
  `every ungated global read is a diagnostic or an OFF switch with its reason${
    classes.UNACCOUNTED.length
      ? ':\n      ' +
        classes.UNACCOUNTED.join('\n      ') +
        '\n    gate a test hook (mantleDebugHook), or give an unanswered switch an OFF entry with its reason'
      : ''
  }`,
);
ok(
  !both.length,
  `no hook is read both through the gate and around it${both.length ? ': ' + both.join(', ') : ''}`,
);
const stale = Object.keys(OFF).filter((n) => !raw.has(n));
if (stale.length)
  console.log(`  note: OFF entries no longer read (answered? drop them): ${stale.join(', ')}`);
const envBad = [...env.keys()].filter((k) => !ENV_OK[k]);
ok(
  !envBad.length,
  `process.env switches are the known ones (${[...env.keys()].join(', ') || 'none'})${envBad.length ? '; unknown: ' + envBad.join(', ') : ''}`,
);
const urlBad = [...url].filter((f) => !URL_OK[f]);
ok(
  !urlBad.length,
  `URL switches are the known ones (${[...url].join(', ') || 'none'})${urlBad.length ? '; unknown: ' + urlBad.join(', ') : ''}`,
);
// Every OFF entry states its reason.
ok(
  Object.values(OFF).every((r) => typeof r === 'string' && r.length >= 3),
  'every OFF entry states its reason',
);

console.log(fail ? `\nswitchCensusSmoke FAIL (${fail})` : '\nswitchCensusSmoke PASS');
process.exit(fail ? 1 : 0);
