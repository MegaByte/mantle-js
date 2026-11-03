// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleCmpBatch — run _zzScaleCmpTrace over the difference rows of a _zzScaleWide OUT file and tally the
// FIRST differing comparison site per (stage, exponent). One trace per row, capped per file so one asset
// cannot dominate.
//
//   node probes/_zzScaleCmpBatch.mjs OUT.json [STAGE] [K]      PER_FILE=2 MAX=60
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
const [out, stageF, kF] = process.argv.slice(2);
const j = JSON.parse(readFileSync(out, 'utf8'));
const PER = +(process.env.PER_FILE || 2),
  MAX = +(process.env.MAX || 60);
const me = fileURLToPath(new URL('./_zzScaleCmpTrace.mjs', import.meta.url));
const seen = new Map(),
  jobs = [];
for (const r of j.rows) {
  if (/half-range|decide|differs/.test(r)) continue;
  const m = /^(\S+) #(\d+) (\S+) 2\^(-?\d+): (.*)$/.exec(r);
  if (!m) continue;
  const [, file, shape, stage, k, what] = m;
  if (stageF && stage !== stageF) continue;
  if (kF && k !== kF) continue;
  const key = `${file}|${stage}|${k}`;
  if ((seen.get(key) || 0) >= PER) continue;
  seen.set(key, (seen.get(key) || 0) + 1);
  jobs.push({ file, shape, stage, k, what });
}
const tally = new Map();
for (const job of jobs.slice(0, MAX)) {
  const p = spawnSync(process.execPath, [me, job.file, job.shape, job.k, job.stage], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  const o = p.stdout || '';
  const site =
    (/at 2\^-?\d+: (\S+) ->/.exec(o) || [])[1] ||
    (/no comparison differs/.test(o) ? '(none)' : '(error)');
  const ops = (/at 2\^-?\d+: \S+ -> \S+\s+\(([^)]*)\)/.exec(o) || [])[1] || '';
  const ref = (/at 1 operands: (.*)/.exec(o) || [])[1] || '';
  console.log(
    `${job.file} #${job.shape} ${job.stage} 2^${job.k}: ${site}  [2^k: ${ops}] [1: ${ref}]  (${job.what.slice(0, 60)})`,
  );
  const t = `${job.stage} 2^${job.k} ${site}`;
  tally.set(t, (tally.get(t) || 0) + 1);
}
console.log('---');
for (const [t, c] of [...tally].sort((a, b) => b[1] - a[1]))
  console.log(`${String(c).padStart(4)}  ${t}`);
