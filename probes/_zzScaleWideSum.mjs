// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleWideSum — sum _zzScaleWide OUT files (corpus chunks) into one per-stage, per-exponent table.
//
//   node probes/_zzScaleWideSum.mjs a.json b.json ...     MODES=plain,plain/arcShape  WHY=1
import { readFileSync } from 'fs';
const files = process.argv.slice(2);
const tot = {};
for (const f of files) {
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
const want = process.env.MODES ? process.env.MODES.split(',') : Object.keys(tot).sort();
const order = (ks) =>
  Object.keys(ks)
    .map(Number)
    .sort((a, b) => a - b);
for (const mode of want) {
  if (!tot[mode]) continue;
  console.log(`== ${mode} ==`);
  for (const stage of Object.keys(tot[mode])) {
    const ks = tot[mode][stage];
    console.log(
      `  ${stage.padEnd(9)} n=${String(ks[order(ks)[0]].n).padEnd(5)} ` +
        order(ks)
          .map((k) => `2^${k}:${ks[k].bad}`)
          .join('  '),
    );
    if (process.env.WHY)
      for (const k of order(ks))
        if (ks[k].bad) console.log(`      2^${k} ${JSON.stringify(ks[k].why)}`);
  }
}
