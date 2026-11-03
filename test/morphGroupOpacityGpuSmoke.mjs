// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Forty-two leaf poses cover named/positional matching and all opacity transitions.
// Three leaves share each setup, including overlapping groups; pose cycles, authored
// images and independent premultiplied OVER samples remain checked.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = mkdtempSync(path.join(tmpdir(), 'mantle-morph-group-opacity-'));
const CELL = 128,
  SIZE = 384,
  STROKE = 16;
// The lane tells a test its wall cap (RENDER_TEST_TIMEOUT_MS); the child gets less than that, so a hang is diagnosed, not killed.
const CAP = +process.env.RENDER_TEST_TIMEOUT_MS || 650000;
const doc = (x, t, named, spacing = CELL) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">${TRANSITIONS.map(
    ([oa, ob], i) => {
      const a = oa + (ob - oa) * t;
      return `<path${named ? ' id="a' + i + '"' : ''} d="M${x + i * spacing} 20h64v64h-64Z" fill="#ff0000" stroke="#0000ff" stroke-width="${STROKE}"${a === 1 ? '' : ` opacity="${a}"`}/>`;
    },
  ).join('')}</svg>`;
const XA = 20,
  XB = 40;
const ARMS = [
  { name: 'slugGpu', engine: 'slug', morph: true, morphCpu: false },
  { name: 'slugCpu', engine: 'slug', morph: true, morphCpu: true },
  { name: 'lbGpu', engine: 'lb', morph: true },
  { name: 'lbAA', engine: 'lb', morph: true },
  { name: 'lbCpu', engine: 'lb', morph: true, morphCpu: true },
  { name: 'lbPose', engine: 'lb', pose: true },
  { name: 'cpGpu', engine: 'cpatch', morph: true },
  { name: 'cpAA', engine: 'cpatch', morph: true },
  { name: 'aacGpu', engine: 'aac', morph: true, morphCpu: false },
  { name: 'aacCpu', engine: 'aac', morph: true, morphCpu: true },
  { name: 'slugPose', engine: 'slug', pose: true },
];
const TS = [0, 0.25, 0.5, 0.75, 1];
const TRANSITIONS = [
  [0.5, 1],
  [0.5, 0.8],
  [1, 0.5],
];
const byte = (v) => Math.round(v * 255);
const cases = [],
  oldSamples = {};
for (const named of [false, true])
  for (const t of TS) {
    const x = XA + (XB - XA) * t,
      name = `${named ? 'named' : 'unnamed'}-opacity-transitions-t${t}`;
    const samples = TRANSITIONS.flatMap(([oa, ob], i) => {
      const a = oa + (ob - oa) * t,
        xx = x + i * CELL;
      return [
        [xx + 40, 52, [byte(a), 0, 0, byte(a)]],
        [xx + 4, 52, [0, 0, byte(a), byte(a)]],
        [xx - 4, 52, [0, 0, byte(a), byte(a)]],
      ];
    });
    cases.push({
      name,
      size: SIZE,
      bbox: [0, 0, SIZE, SIZE],
      svg: doc(XA, 0, named),
      morphSvgDst: doc(XB, 1, named),
      poseSvg: doc(x, t, named),
      morphT: t,
      morphWarmTs: [1 - t],
      morphCycle: TS,
      checkMorphRestoration: true,
      morphGpuSmallPlanes: true,
      arms: ARMS,
      comparisonBase: 'slugPose',
      colorSamples: samples.map(([sx, sy, rgba]) => ({ x: Math.round(sx), y: sy, rgba })),
    });
    oldSamples[name] = TRANSITIONS.map(([oa, ob]) => {
      const a = oa + (ob - oa) * t;
      return [byte(a * (1 - a)), 0, byte(a), byte(a + a * (1 - a))];
    });
  }
// Overlapping groups must refresh atlas slots after warming a different pose.
for (const [named, t] of [
  [false, 0.25],
  [true, 0.75],
]) {
  const endX = 120,
    x = XA + (endX - XA) * t,
    alpha = TRANSITIONS.map(([a, b]) => a + (b - a) * t);
  const over = (a, b) => [byte(b), 0, byte(a * (1 - b)), byte(b + a * (1 - b))];
  cases.push({
    name: `overlapping-${named ? 'named' : 'unnamed'}-t${t}`,
    size: SIZE,
    bbox: [0, 0, SIZE, SIZE],
    svg: doc(XA, 0, named, 48),
    morphSvgDst: doc(endX, 1, named, 48),
    poseSvg: doc(x, t, named, 48),
    morphT: t,
    morphWarmTs: [1 - t],
    morphCycle: TS,
    checkMorphRestoration: true,
    morphGpuSmallPlanes: true,
    arms: ARMS,
    comparisonBase: 'slugPose',
    colorSamples: [
      { x: Math.round(x + 24), y: 52, rgba: [byte(alpha[0]), 0, 0, byte(alpha[0])] },
      { x: Math.round(x + 60), y: 52, rgba: over(alpha[0], alpha[1]) },
      { x: Math.round(x + 108), y: 52, rgba: over(alpha[1], alpha[2]) },
    ],
  });
}
// Clip bindings retain the source until t=1; changing bindings must bypass batching.
const clippedDoc = (x, t, clip) =>
  doc(x, t, true)
    .replace(
      '</svg>',
      '<defs><clipPath id="leaf-clip"><rect x="0" y="0" width="70" height="384"/></clipPath></defs></svg>',
    )
    .replace('<path id="a0"', `<path id="a0"${clip ? ' clip-path="url(#leaf-clip)"' : ''}`);
for (const t of [0.5, 1]) {
  const x = XA + (XB - XA) * t;
  const samples = TRANSITIONS.flatMap(([oa, ob], i) => {
    const a = oa + (ob - oa) * t,
      xx = x + i * CELL;
    return [
      [xx + 40, 52, i === 0 && t === 1 ? [0, 0, 0, 0] : [byte(a), 0, 0, byte(a)]],
      [xx + 4, 52, [0, 0, byte(a), byte(a)]],
      [xx - 4, 52, [0, 0, byte(a), byte(a)]],
    ];
  });
  cases.push({
    name: `changing-leaf-clip-t${t}`,
    size: SIZE,
    bbox: [0, 0, SIZE, SIZE],
    svg: clippedDoc(XA, 0, false),
    morphSvgDst: clippedDoc(XB, 1, true),
    poseSvg: clippedDoc(x, t, t === 1),
    morphT: t,
    morphWarmTs: [0, 1],
    morphCycle: TS,
    checkMorphRestoration: true,
    morphGpuSmallPlanes: true,
    arms: ARMS.filter((a) => a.engine === 'slug' || a.engine === 'aac'),
    comparisonBase: 'slugPose',
    colorSamples: samples.map(([x, y, rgba]) => ({ x: Math.round(x), y, rgba })),
  });
}
try {
  const cfg = {
    productionShaders: true,
    sdfRecognition: false,
    forceUnified: false,
    defaults: { rounds: 1, batch: 1, repetitions: 1 },
    cases,
  };
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  writeFileSync(input, JSON.stringify(cfg));
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: { ...process.env, MANTLE_GPU_BURST_MS: '40', MANTLE_GPU_WALL_MS: String(CAP - 30000) },
    timeout: CAP - 20000,
    stdio: 'pipe',
  });
  if (process.env.MANTLE_GPU_REPORT_DIR) {
    mkdirSync(process.env.MANTLE_GPU_REPORT_DIR, { recursive: true });
    copyFileSync(output, path.join(process.env.MANTLE_GPU_REPORT_DIR, 'morph-group-opacity.json'));
  }
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert.equal(d.rows.length, cases.length);
  let draws = 0;
  for (const row of d.rows) {
    const a = Object.fromEntries(row.arms.map((x) => [x.name, x]));
    const configured = new Set(cases.find((c) => c.name === row.name).arms.map((a) => a.name));
    assert.equal(row.arms.length, configured.size);
    for (const [name, engine] of [
      ['lbGpu', 'lb'],
      ['lbAA', 'lb'],
      ['lbCpu', 'lb'],
      ['cpGpu', 'cpatch'],
      ['cpAA', 'cpatch'],
      ['slugGpu', 'slug'],
      ['slugCpu', 'slug'],
      ['aacGpu', 'aac'],
      ['aacCpu', 'aac'],
    ].filter(([name]) => configured.has(name))) {
      const arm = a[name];
      assert(arm.pin.ledger[engine] > 0, `${row.name} ${name}: a real ${engine} draw`);
      if (engine === 'lb' || engine === 'cpatch') assert(arm.preparation.awaitEngineReady);
      assert(arm.morph.matched > 0);
      assert.equal(
        arm.morph.usesGpuCurveLerp,
        !name.endsWith('Cpu'),
        `${row.name} ${name}: curve lerp on ${name.endsWith('Cpu') ? 'the CPU' : 'the GPU'}`,
      );
      assert.equal(
        arm.imageHash,
        arm.finalImageHash,
        `${row.name} ${name}: the pose after the pose cycle is the pose before it`,
      );
      assert(
        arm.colorQuality.maxByte <= 1,
        `${row.name} ${name}: analytic color samples (max byte ${arm.colorQuality.maxByte}, worst ${JSON.stringify(arm.colorQuality.worst)})`,
      );
      draws++;
    }
    if (a.lbGpu) assert.equal(a.lbGpu.imageHash, a.lbAA.imageHash);
    if (a.cpGpu) assert.equal(a.cpGpu.imageHash, a.cpAA.imageHash);
    for (const q of row.comparisons)
      assert(
        q.maxByte <= 1,
        `${row.name} ${q.arm}: full RGBA vs the authored pose of the same t (max byte ${q.maxByte})`,
      );
    // Not vacuous: the overlap sample would read differently if the paints were composited one after the other.
    const c = cases.find((x) => x.name === row.name);
    for (let i = 0; oldSamples[row.name] && i < TRANSITIONS.length; i++) {
      const [oa, ob] = TRANSITIONS[i],
        op = oa + (ob - oa) * c.morphT,
        overlap = c.colorSamples[i * 3 + 1].rgba,
        old = oldSamples[row.name][i];
      if (op < 0.999)
        assert(
          Math.abs(old[0] - overlap[0]) >= 10,
          `${row.name} transition ${i}: independent OVER distinguishes the one-after-the-other picture`,
        );
    }
  }
  console.log(
    `morphGroupOpacityGpuSmoke PASS: ${d.rows.length * TRANSITIONS.length} leaf poses (${draws} morph arms, including raw Slug/AAC changing-clip fallbacks) on LB/CPatch/Slug/AAC, GPU and CPU lerp: the leaf is one group, opacity .5->1, .5->.8 and 1->.5, equal to the authored pose within one byte`,
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
