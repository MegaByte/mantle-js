// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Actual-GPU proof of native-arc coverage normalization: raw AAC and Slug, against the independent exact-area oracle
// (probes/analyticArea/arcFill.mjs), on a physical GPU. Fixtures the certificate normalizes must reach the bound and never be worse
// than the authored paint; fixtures it declines must draw the byte-identical image.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const points = process.env.MANTLE_NORMALIZE_POINTS === '1';
const BOUND = +(process.env.ARC_BOUND || 1.5);
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-arc-smoke-'));
try {
  const out = path.join(dir, 'out.json');
  execFileSync(
    process.execPath,
    [path.join(root, 'probes/analyticArea/arcFillGpu.mjs'), out, ...(points ? ['points'] : [])],
    { cwd: root, timeout: 150000, stdio: 'pipe', env: { ...process.env } },
  );
  const d = JSON.parse(readFileSync(out));
  assert(!/software|swiftshader|llvmpipe/i.test(d.device));
  let improved = 0;
  for (const r of d.rows) {
    assert.equal(r.glError, 0);
    const names = points ? ['raw'] : ['raw', 'slug'];
    for (const [n, a] of Object.entries(r.arms)) {
      const want = n.toLowerCase().includes('slug') ? 'slug' : 'aac';
      assert(a.ledger[want] > 0, 'actual route ' + r.name + ' ' + n);
      assert(
        Object.entries(a.ledger)
          .filter(([k, v]) => v && ['aac', 'slug', 'lb', 'cpatch'].includes(k))
          .every(([k]) => k === want),
        'only the requested engine drew ' + r.name + ' ' + n,
      );
      if (points) assert(a.routeLedger['aac@points'] > 0, 'actual point route ' + r.name + ' ' + n);
    }
    for (const n of names) {
      const nw = r.arms[n],
        old = r.arms['old' + n[0].toUpperCase() + n.slice(1)];
      if (r.expect === 'fix') {
        assert(
          nw.max <= BOUND,
          `${r.name} ${n}: ${nw.max} bytes over the exact area (bound ${BOUND})`,
        );
        assert(
          nw.max <= old.max + 0.5,
          `${r.name} ${n}: not worse than authored (${nw.max} vs ${old.max})`,
        );
        if (old.max > BOUND) improved++;
      } else
        assert.equal(
          nw.hash,
          old.hash,
          `${r.name} ${n}: a declined paint draws the authored image`,
        );
    }
  }
  assert(
    improved >= 8,
    'the negative control: authored arcs are wrong on at least 8 fixtures (' + improved + ')',
  );
  console.log(
    (points ? 'fillNormalizeArcsPointsGpuSmoke' : 'fillNormalizeArcsGpuSmoke') +
      ' PASS: ' +
      d.rows.length +
      ' fixtures, ' +
      improved +
      ' wrong when authored, all within ' +
      BOUND +
      ' bytes when normalized; ' +
      d.device,
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
