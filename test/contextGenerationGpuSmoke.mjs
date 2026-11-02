// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Actual context loss/restoration, shared-resource lifetimes and unchanged pixels.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = {
  ...(process.env.MANTLE_CONTEXT_BASELINE_ROOT
    ? { baseline: path.resolve(process.env.MANTLE_CONTEXT_BASELINE_ROOT) }
    : {}),
  candidate: root,
};
const fixture = 'test/fixtures/context-generation.json';
const fixtureFiles = [
  fixture,
  'test/fixtures/lb-translucent-group-morph.json',
  'test/fixtures/cpatch-morph-readiness.json',
  'test/fixtures/cpatch-occupancy.json',
];
const helperFiles = [
  'test/contextGenerationGpuSmoke.mjs',
  'test/_contextGenerationGpu.js',
  'test/_contextResourceControls.js',
  'test/_contextWorkerReply.js',
  'test/_launch.mjs',
  'test/_gpuThrottle.mjs',
  ...fixtureFiles,
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHashes = (base, files) =>
  Object.fromEntries(files.map((f) => [f, hash(readFileSync(path.join(base, f)))]));
function sourceHashes(base) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : [path.relative(base, path.join(dir, e.name))],
      );
  return fileHashes(base, walk(path.join(base, 'src')));
}
const report = {
  sources: Object.fromEntries(
    Object.entries(roots).map(([name, base]) => [name, sourceHashes(base)]),
  ),
  harness: fileHashes(root, helperFiles),
  rows: [],
  policy: 'Physical GPU correctness; retained caches; no timing claim.',
};
const save = () => {
  if (process.env.MANTLE_CONTEXT_REPORT)
    writeFileSync(process.env.MANTLE_CONTEXT_REPORT, JSON.stringify(report) + '\n');
};
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html>');
      return;
    }
    const [version, ...parts] = decodeURIComponent(url.pathname).slice(1).split('/'),
      base = roots[version],
      file = base && path.resolve(base, parts.join('/'));
    if (!base || !file.startsWith(base + path.sep) || file.includes('/generated/')) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  server.close();
};
const cap = capWallTime('context generation ownership', stop, 300000);
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  report.browser = await browser.version();
  const config = {
    simple: JSON.parse(readFileSync(path.join(root, fixture))),
    lb: JSON.parse(readFileSync(path.join(root, fixtureFiles[1]))).cases[0],
    prepared: JSON.parse(readFileSync(path.join(root, fixtureFiles[2]))).cases[0],
  };
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  for (const version of Object.keys(roots)) {
    const rows = await page.evaluate(
      async (version, config) =>
        (await import('/candidate/test/_contextGenerationGpu.js')).run(version, config),
      version,
      config,
    );
    report.rows.push(...rows);
    save();
  }
  const workerCases = JSON.parse(readFileSync(path.join(root, fixtureFiles[3]))).cases;
  report.workerReplies = await page.evaluate(
    async (config) =>
      (await import('/candidate/test/_contextWorkerReply.js')).run('candidate', config),
    { svg: workerCases[0].svg, cubic: workerCases[8].svg },
  );
  report.controls = await page.evaluate(async () => {
    const html = await (await import('/candidate/test/_contextResourceControls.js')).run();
    const worker = await new Promise((resolve, reject) => {
      const url = new URL('/candidate/test/_contextResourceControls.js', location.href).href;
      const source = `import {run} from ${JSON.stringify(url)}; run(true).then(value=>postMessage({value}),error=>postMessage({error:String(error.stack||error)}));`;
      const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
        worker = new Worker(objectUrl, { type: 'module' });
      const finish = () => {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(objectUrl);
      };
      const timer = setTimeout(() => {
        finish();
        reject(Error('Offscreen worker context controls timeout'));
      }, 30000);
      worker.onmessage = (e) => {
        finish();
        if (e.data.error) reject(Error(e.data.error));
        else resolve(e.data.value);
      };
      worker.onerror = (e) => {
        finish();
        reject(Error(e.message));
      };
    });
    return { html, worker };
  });
  const candidates = report.rows.filter((r) => r.version === 'candidate');
  assert.equal(candidates.length, 15);
  let imageComparisons = 0;
  const baseline = new Map(
    report.rows
      .filter((r) => r.version === 'baseline')
      .map((r) => [JSON.stringify([r.scene, r.order]), r]),
  );
  for (const row of candidates) {
    assert(row.passed, JSON.stringify({ ...row, pixels: undefined }));
    const expected = row.pixels['before-loss'];
    assert.match(expected, /^[0-9a-f]{64}$/);
    for (const [name, image] of Object.entries(row.pixels))
      if (!name.startsWith('old-')) {
        assert.equal(image, expected, JSON.stringify([row.scene, row.order, name]));
        imageComparisons++;
      }
    const counts = new Map();
    for (const entry of row.sharedPassCompiles) {
      const key = JSON.stringify(entry);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    assert(
      [...counts.values()].every((n) => n === 1),
      'Shared pass recreated after owner disposal',
    );
    if (row.scene !== 'shared-group-cache')
      for (const generation of [0, 1])
        assert(
          counts.has(JSON.stringify({ generation, pass: 'lerp' })),
          'GPU curve lerp actually compiled',
        );
    if (row.scene === 'raw-arc-stroke')
      for (const generation of [0, 1])
        assert(
          counts.has(JSON.stringify({ generation, pass: 'fixup' })),
          'Native-arc GPU fixup actually compiled',
        );
    if (row.scene === 'cpatch-cubic')
      for (const generation of [0, 1])
        assert(
          counts.has(JSON.stringify({ generation, pass: 'cpatch' })),
          'CPatch GPU blend actually compiled',
        );
    const base = baseline.get(JSON.stringify([row.scene, row.order]));
    if (base) {
      assert.equal(row.pixels['old-warm3'], base.pixels['old-warm3'], 'Unchanged pre-loss image');
      imageComparisons++;
    }
  }
  assert.equal(report.workerReplies.length, 4);
  for (const reply of report.workerReplies) {
    assert(reply.pending > 0 && reply.jobs > 0 && reply.nonzero > 0 && reply.replyCompleted);
    assert.equal(reply.uploadError, 0);
    assert.deepEqual(reply.uploadErrors, []);
    assert.equal(reply.afterError, null);
    assert.equal(reply.after, reply.freshBefore, 'Real worker arrival preserves the live image');
  }
  for (const mode of ['html', 'worker']) {
    const control = report.controls[mode];
    assert(control.passed);
    assert.equal(control.nativeFreshDeletes, 44);
    assert.equal(control.staleNativeDeletes, 0);
    assert.equal(control.wrongContextError, 1282);
    assert.equal(control.offscreen, mode === 'worker');
  }
  for (const [name, base] of Object.entries(roots))
    assert.deepEqual(sourceHashes(base), report.sources[name]);
  assert.deepEqual(fileHashes(root, helperFiles), report.harness);
  report.sourceStable = report.harnessStable = true;
  report.imageComparisons = imageComparisons;
  report.passed = true;
  save();
  console.log(
    'contextGenerationGpuSmoke PASS: 15 lifecycle cases and 4 real-worker arrival cases, ' +
      imageComparisons +
      ' exact full-image comparisons; fresh/stale allocations on canvas and OffscreenCanvas worker',
  );
} catch (error) {
  report.error = error.stack;
  save();
  throw error;
} finally {
  cap.clear();
  await stop();
}
