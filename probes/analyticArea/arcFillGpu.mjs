// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Actual-GPU scoring of the native-arc fill-rule fixtures (probes/analyticArea/arcFill.mjs) for raw AAC and Slug, before
// (normalizeFill:false: the arc-bearing paint keeps its authored contours, as every release before the arc certificate did) and after,
// against the independent exact-area oracle. Usage: node arcFillGpu.mjs [OUT.json] [points]
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixtures, svgOf, referenceArea, score, SIZE } from './arcFill.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outFile = process.argv[2] && process.argv[2] !== 'points' ? process.argv[2] : null;
const points = process.argv.includes('points');
const only = process.env.ARC_FIXTURES ? process.env.ARC_FIXTURES.split(',') : null;
const list = fixtures.filter((f) => !only || only.includes(f.name));
const arms = [
  { name: 'oldRaw', engine: 'aac', normalizeFill: false },
  { name: 'raw', engine: 'aac' },
  { name: 'oldSlug', engine: 'slug', normalizeFill: false },
  { name: 'slug', engine: 'slug' },
]
  .filter((a) => !points || a.engine === 'aac')
  .map((a) => ({ ...a, allowBlank: true, ...(points ? { unified: false } : {}) }));
const cases = list.map((f) => ({
  name: f.name,
  size: SIZE,
  bbox: [0, 0, SIZE, SIZE],
  svg: svgOf(f),
  savePixels: true,
  comparisonBase: 'raw',
  arms,
}));
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-arc-fill-'));
let rows;
try {
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  writeFileSync(
    input,
    JSON.stringify({
      productionShaders: true,
      sdfRecognition: false,
      initialKernel: 'slug',
      aacPoints: points,
      forceUnified: !points,
      defaults: { rounds: 1, batch: 1, repetitions: 1 },
      cases,
    }),
  );
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: {
      ...process.env,
      MANTLE_GPU_BASELINE_ROOT: '',
      MANTLE_GPU_BURST_MS: '40',
      MANTLE_GPU_WALL_MS: '120000',
    },
    timeout: 140000,
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
  if (!(d.finished && d.sourceStable && d.harnessStable))
    throw new Error('GPU report not finished/stable');
  if (/software|swiftshader|llvmpipe/i.test(d.device.renderer))
    throw new Error('software renderer ' + d.device.renderer);
  rows = d.rows.map((row) => {
    const f = list.find((f) => f.name === row.name),
      ref = referenceArea(f);
    const res = { name: row.name, expect: f.expect, glError: row.glError, arms: {} };
    for (const a of row.arms) {
      const rgba = a.rgba,
        alpha = new Float64Array(SIZE * SIZE);
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++)
          alpha[y * SIZE + x] = rgba[((SIZE - 1 - y) * SIZE + x) * 4 + 3];
      res.arms[a.name] = {
        ...score(alpha, ref),
        hash: a.imageHash,
        ledger: a.pin.ledger,
        routeLedger: a.pin.routeLedger,
      };
    }
    return res;
  });
  rows.device = d.device.renderer;
  rows.commit = d.commit;
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (outFile)
  writeFileSync(
    outFile,
    JSON.stringify({ device: rows.device, commit: rows.commit, points, rows }, null, 1),
  );
export { rows };
if (import.meta.url === 'file://' + process.argv[1]) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('device', rows.device, 'commit', rows.commit, points ? '(aac@points)' : '(cover)');
  console.log(
    pad('fixture', 32),
    ...Object.keys(rows[0].arms).map((n) => pad(n + ' o1/o8/max', 20)),
  );
  for (const r of rows)
    console.log(
      pad(r.name, 32),
      ...Object.values(r.arms).map((a) => pad(`${a.over1}/${a.over8}/${a.max}`, 20)),
    );
}
