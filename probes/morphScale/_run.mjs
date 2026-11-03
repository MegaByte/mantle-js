// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _run — drive _zzMorphScale ONE EXPONENT PER PROCESS, then sum.
//
// The builders memoise implicits and packed forms on the segment objects they are handed, and
// `_setKeyOrigin` leaves the last shape's key origin in module state. A second exponent in the same
// process can therefore read a first one's answer -- which shows up as a divergence that is not one,
// or, worse, hides one. One child per exponent removes the question.
//
// ONE CHILD AT A TIME by default (the parent plus one child is two node processes). J=2 runs two.
//
//   node probes/morphScale/_run.mjs                       KS=-20,-16,... STAGES=lbPair OFFSET=1
//   OUTDIR=/tmp/ms  J=1  KIND=asset,synth,mixed  WHY=1
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KS = (process.env.KS || '-20,-16,-12,-8,8,12,16,20').split(',').map(Number);
const J = Math.max(1, +(process.env.J || 1));
const OUTDIR = process.env.OUTDIR || mkdtempSync(path.join(tmpdir(), 'morphScale-'));
mkdirSync(OUTDIR, { recursive: true });
const env = { ...process.env };
delete env.KS;
delete env.OUT;
delete env.OUTDIR;
delete env.J;

const runOne = (k) =>
  new Promise((res) => {
    const out = path.join(OUTDIR, `k${k}.json`);
    const t0 = Date.now();
    const ch = spawn(process.execPath, [path.join(HERE, '_zzMorphScale.mjs')], {
      env: { ...env, KS: String(k), OUT: out },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    ch.on('close', (code) => {
      console.log(
        `  2^${k} ${code === 0 ? 'ok' : 'exit ' + code} ${Math.round((Date.now() - t0) / 1000)}s`,
      );
      res(code === 0 ? out : null);
    });
  });

const files = [];
for (let i = 0; i < KS.length; i += J)
  files.push(...(await Promise.all(KS.slice(i, i + J).map(runOne))));

const tot = {};
for (const f of files) {
  if (!f) continue;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const [mode, st] of Object.entries(j.stats))
    for (const [stage, ks] of Object.entries(st))
      for (const [k, v] of Object.entries(ks)) {
        const t = (((tot[mode] ||= {})[stage] ||= {})[k] ||= { n: 0, bad: 0, why: {} });
        t.n += v.n;
        t.bad += v.bad;
        for (const [w, c] of Object.entries(v.why)) t.why[w] = (t.why[w] | 0) + c;
      }
}
const order = (ks) =>
  Object.keys(ks)
    .map(Number)
    .sort((a, b) => a - b);
for (const mode of Object.keys(tot).sort()) {
  console.log(`== ${mode} ==`);
  for (const stage of Object.keys(tot[mode])) {
    const ks = tot[mode][stage];
    console.log(
      `  ${stage.padEnd(12)} n=${String(ks[order(ks)[0]].n).padEnd(4)} ` +
        order(ks)
          .map((k) => `2^${k}:${ks[k].bad}`)
          .join('  '),
    );
    if (process.env.WHY)
      for (const k of order(ks))
        if (ks[k].bad) console.log(`      2^${k} ${JSON.stringify(ks[k].why)}`);
  }
}
if (process.env.SUM) writeFileSync(process.env.SUM, JSON.stringify(tot, null, 1));
console.log(`(per-exponent JSON in ${OUTDIR})`);
