// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Bounded, exclusive real-GPU probe. See gpuPage.js for the measurement protocol.
import http from 'node:http';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { launchBrowser } from '../../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../../test/_gpuThrottle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('gpu.mjs CASES.json OUTPUT.json');
const loaded = JSON.parse(readFileSync(input, 'utf8'));
const config = loaded.config || loaded; // A saved result contains a self-contained replay input.
const baselineRoot = process.env.MANTLE_GPU_BASELINE_ROOT
  ? path.resolve(process.env.MANTLE_GPU_BASELINE_ROOT)
  : null;
let browser;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><canvas id="c"></canvas>');
    return;
  }
  const isBaseline = url.pathname.startsWith('/__baseline/');
  const servingRoot = isBaseline ? baselineRoot : root;
  if (!servingRoot) {
    res.writeHead(404).end();
    return;
  }
  const file = path.resolve(
    servingRoot,
    '.' + decodeURIComponent(isBaseline ? url.pathname.slice('/__baseline'.length) : url.pathname),
  );
  if (!file.startsWith(servingRoot + path.sep) || file.includes('/generated/')) {
    res.writeHead(404).end();
    return;
  }
  try {
    let data = readFileSync(file);
    // Measurement-only setter: the public constructor copies opts, so mutating
    // the caller's object cannot switch submission paths. Keep ONE renderer and
    // its GPU resources; expose only the existing force-unified measurement flag.
    // The CPatch arms use the unmodified release route (force flag undefined).
    if (file === path.join(servingRoot, 'src/renderer/renderer.js')) {
      const src = data.toString(),
        needle = '    __setAbDefines: (d) =>';
      if (!src.includes(needle)) throw new Error('Probe hook anchor changed');
      data = Buffer.from(
        src.replace(
          needle,
          '    __setProbeUnified: (on) => { R.opts.unifiedFill = on ? "force" : undefined; },\n    __setProbeCoverAaReach: (on) => { R.coverAaReach = on; },\n' +
            needle,
        ),
      );
    }
    if (!config.productionShaders && file === path.join(root, 'src/renderer/cpatchPack.js'))
      data = Buffer.from(
        data
          .toString()
          .replace(
            'for (const ci of part.idx) {',
            'for (const ci of (globalThis.__CP_PROBE_CUTS_FIRST ? part.idx.slice().sort((a,b)=>Number(!!p.curves[b].cut)-Number(!!p.curves[a].cut)) : part.idx)) {',
          ),
      );
    if (!config.productionShaders && file === path.join(root, 'src/renderer/cpatchMorphBuild.js'))
      data = Buffer.from(
        data
          .toString()
          .replace(
            'const lerpPose = (A, B, t) => A.map((c, i) => ({ t: c.t, cut: c.cut, w: c.w, _bez: c._bez,',
            'const lerpPose = (A, B, t) => A.map((c, i) => ({ t: c.t, cut: c.cut, w: c.w, _bez: c._bez,\n  _srcP: globalThis.__CP_PROBE_WHOLE_ARC && c._srcP && B[i]._srcP ? c._srcP.map((p,k)=>p.map((v,j)=>v+(B[i]._srcP[k][j]-v)*t)) : undefined,',
          ),
      );
    if (!config.productionShaders && file === path.join(root, 'src/renderer/cpatchPack.js'))
      data = Buffer.from(
        data
          .toString()
          .replace(
            'morphArcBounds(c, hi.curves[ci])',
            'morphArcBounds(globalThis.__CP_PROBE_WHOLE_ARC && !c.cut && c._srcP ? {...c,P:c._srcP} : c, globalThis.__CP_PROBE_WHOLE_ARC && !hi.curves[ci].cut && hi.curves[ci]._srcP ? {...hi.curves[ci],P:hi.curves[ci]._srcP} : hi.curves[ci])',
          )
          .replace(
            'const g = arcTexels(seg);',
            'const g = arcTexels(globalThis.__CP_PROBE_WHOLE_ARC && !seg.cut && seg._srcP ? {...seg,P:seg._srcP} : seg);',
          )
          .replace(
            'const bb = segTightBBox(seg);',
            'const outlineArc = globalThis.__CP_PROBE_WHOLE_ARC && !seg.cut && seg._srcP ? {...seg,P:seg._srcP} : seg; const bb = segTightBBox(outlineArc);',
          )
          .replace(
            'const st = comp ? segTightBBox(comp) : chordStrip(seg);',
            'const st = comp ? segTightBBox(comp) : chordStrip(outlineArc);',
          )
          .replace('arcTexels(comp || seg)', 'arcTexels(comp || outlineArc)'),
      );
    res.setHeader(
      'Content-Type',
      /\.m?js$/.test(file)
        ? 'text/javascript'
        : /\.glsl$/.test(file)
          ? 'text/plain'
          : 'application/octet-stream',
    );
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
const stop = async () => {
  if (browser) await browser.close();
  server.close();
};
const cap = capWallTime('analytic-area GPU', stop, +(process.env.MANTLE_GPU_WALL_MS || 60000));
console.log(gpuThrottleBanner());
// Verified source archives have no .git; their caller supplies the revision label.
// The complete source/harness hashes below remain authoritative for every run.
const report = {
  commit:
    process.env.MANTLE_GPU_SOURCE_COMMIT ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  started: new Date().toISOString(),
  inputHash: createHash('sha256').update(readFileSync(input)).digest('hex'),
  config,
  rows: [],
};
const harnessHashes = () =>
  Object.fromEntries(
    [
      'gpu.mjs',
      'gpuPage.js',
      'experimentalShader.js',
      'packedGeometryStats.js',
      'preparation.js',
      'pieceResolve.js',
      'preparePieceResolve.mjs',
      'pieceAtlas.js',
      'rawFillRuleShader.js',
      'morphAtlas.js',
      'morphPreparation.js',
      'morphFanPreparation.js',
      'prepareMorphPieces.mjs',
      'morphPaintScope.js',
      'rootCache.js',
      'morphPreparation.worker.js',
      'morphWorkerProbe.js',
    ].map((f) => [
      f,
      createHash('sha256')
        .update(readFileSync(new URL(f, import.meta.url)))
        .digest('hex'),
    ]),
  );
report.harnessHashes = harnessHashes();
// Include untracked source files too: an integrated importer change is just as
// material to this measurement as a shader change.
function sourceHashes(dir = path.join(root, 'src')) {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => {
        const f = path.join(dir, e.name);
        return e.isDirectory()
          ? Object.entries(sourceHashes(f))
          : /\.(?:js|glsl)$/.test(e.name)
            ? [[path.relative(root, f), createHash('sha256').update(readFileSync(f)).digest('hex')]]
            : [];
      }),
  );
}
report.sourceHashes = sourceHashes();
if (baselineRoot)
  report.baseline = {
    root: baselineRoot,
    commit:
      process.env.MANTLE_GPU_BASELINE_COMMIT ||
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baselineRoot, encoding: 'utf8' }).trim(),
    sourceHashes: sourceHashes(path.join(baselineRoot, 'src')),
  };

mkdirSync(path.dirname(output), { recursive: true });
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
    ...(process.env.MANTLE_CHROME_PATH ? { executablePath: process.env.MANTLE_CHROME_PATH } : {}),
  });
  report.browser = await browser.version();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE', String(e)));
  page.on('console', (m) => {
    if (
      m.text().startsWith('probe:') ||
      m.type() === 'warn' ||
      (m.type() === 'error' && !m.text().includes('404'))
    )
      console.log(m.type() + ': ' + m.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await installGpuThrottle(page);
  report.device = await page.evaluate(
    async (options) => {
      const m = await import('/probes/analyticArea/gpuPage.js');
      window.probe = m;
      return m.init(options);
    },
    {
      initialKernel: config.initialKernel,
      aacPoints: config.aacPoints,
      forceUnified: !!config.forceUnified,
      productionShaders: !!config.productionShaders,
      fastInstancing: config.fastInstancing === true,
      baseline: !!baselineRoot,
      sdfRecognition: config.sdfRecognition === true,
    },
  );
  console.log(JSON.stringify(report.device));
  save();
  if (config.preparation?.inputs) {
    report.preparation = await page.evaluate(
      (c) => window.probe.preparation(c),
      config.preparation,
    );
    save();
  }
  for (const c of config.cases || []) {
    const row = await page.evaluate((c) => window.probe.run(c), { ...config.defaults, ...c });
    for (const a of row.arms)
      if (a.png) {
        const f = path.resolve(
          path.dirname(output),
          `${path.basename(output, '.json')}-${row.size}-${a.name}.png`,
        );
        writeFileSync(f, Buffer.from(a.png, 'base64'));
        delete a.png;
        a.imageFile = f;
      }
    report.rows.push(row);
    save();
    console.log(
      JSON.stringify({
        name: row.name,
        size: row.size,
        arms: row.arms.map((a) => ({
          name: a.name,
          alpha: a.alpha,
          medianGpuMs: a.medianGpuMs,
          medianMs: a.medianMs,
          maxError: a.quality?.maxError,
          maxColorByte: a.colorQuality?.maxByte,
        })),
      }),
    );
  }
  if (JSON.stringify(report.sourceHashes) !== JSON.stringify(sourceHashes()))
    throw new Error('Source changed during GPU measurement; reject run');
  if (JSON.stringify(report.harnessHashes) !== JSON.stringify(harnessHashes()))
    throw new Error('Harness changed during GPU measurement; reject run');
  if (
    baselineRoot &&
    JSON.stringify(report.baseline.sourceHashes) !==
      JSON.stringify(sourceHashes(path.join(baselineRoot, 'src')))
  )
    throw new Error('Baseline source changed during GPU measurement; reject run');
  report.harnessStable = true;
  report.sourceStable = true;
  report.finished = new Date().toISOString();
  save();
  // Render regressions normally own disposable temp directories. An explicit
  // archive keeps their device, pinned draws, source hashes and pixel evidence
  // available for a later audit after those directories are removed.
  if (process.env.MANTLE_GPU_REPORT_DIR) {
    const dir = path.resolve(process.env.MANTLE_GPU_REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    const stem = report.inputHash.slice(0, 20),
      archived = structuredClone(report);
    for (const row of archived.rows)
      for (const arm of row.arms)
        if (arm.imageFile) {
          const file = path.join(dir, stem + '-' + path.basename(arm.imageFile));
          copyFileSync(arm.imageFile, file);
          arm.imageFile = file;
        }
    writeFileSync(path.join(dir, stem + '.json'), JSON.stringify(archived, null, 2) + '\n');
  }
} finally {
  cap.clear();
  await stop();
}
