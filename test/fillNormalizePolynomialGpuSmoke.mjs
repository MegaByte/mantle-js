// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Actual Metal GPU proof of coverage-only polynomial fill normalization.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pointsOnly = process.env.MANTLE_NORMALIZE_POINTS === '1';
const outer =
  'M28 16C28 22.6 22.6 28 16 28C9.4 28 4 22.6 4 16C4 9.4 9.4 4 16 4C22.6 4 28 9.4 28 16Z';
const inner =
  'M20 16C20 18.2 18.2 20 16 20C13.8 20 12 18.2 12 16C12 13.8 13.8 12 16 12C18.2 12 20 13.8 20 16Z';
const svg = (content) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' + content + '</svg>';
const cases = [];
for (const fillRule of ['nonzero', 'evenodd'])
  for (const transform of ['', 'matrix(.7 .25 -.15 .8 5 1)', 'matrix(.02 0 0 .02 16.1 16.1)']) {
    cases.push({
      name: fillRule + (transform.includes('.02') ? '-tiny' : transform ? '-affine' : '-identity'),
      size: 32,
      bbox: [0, 0, 32, 32],
      svg: svg(
        `<g transform="${transform || 'translate(0)'}"><path fill="#d433a9" fill-opacity=".5" fill-rule="${fillRule}" d="${outer} ${inner}"/><path fill="#348bc4" fill-opacity=".5" d="M9 9H23V23H9Z"/></g>`,
      ),
      comparisonBase: 'raw',
      captureReferencePixels: true,
      referencePixels: [
        [16, 16],
        [7, 16],
      ],
      arms: [
        { name: 'oldRaw', engine: 'aac', normalizeFill: false },
        { name: 'raw', engine: 'aac' },
        { name: 'oldSlug', engine: 'slug', normalizeFill: false },
        { name: 'slug', engine: 'slug' },
      ],
    });
  }
for (const c of cases)
  if (c.name.endsWith('-tiny')) {
    const k = 0.55,
      a =
        0.5 *
        4 *
        (144 - (c.name.startsWith('evenodd') ? 16 : 0)) *
        (0.5 + 0.6 * k - 0.15 * k * k) *
        0.02 ** 2,
      b = 0.5 * 196 * 0.02 ** 2;
    c.colorSamples = [
      {
        x: 16,
        y: 16,
        rgba: [
          212 * a * (1 - b) + 52 * b,
          51 * a * (1 - b) + 139 * b,
          169 * a * (1 - b) + 196 * b,
          255 * (a + b * (1 - a)),
        ],
      },
    ];
  }
// Exact polygon controls: an inner island and two disjoint opposite windings.
for (const [name, d, area] of [
  ['triple-island', 'M0 0H12V12H0Z M2 2V10H10V2Z M4 4V8H8V4Z', 144 - 64 + 16],
  ['opposite-disjoint', 'M0 0H4V4H0Z M8 0V4H12V0Z', 32],
]) {
  const a = 0.5 * area * 0.05 ** 2;
  cases.push({
    name,
    size: 32,
    bbox: [0, 0, 32, 32],
    svg: svg(
      `<path transform="matrix(.05 0 0 .05 16.1 16.1)" fill="#d433a9" fill-opacity=".5" d="${d}"/>`,
    ),
    colorSamples: [{ x: 16, y: 16, rgba: [212 * a, 51 * a, 169 * a, 255 * a] }],
    comparisonBase: 'raw',
    arms: cases[0].arms.map((a) => ({
      ...a,
      allowBlank: name === 'opposite-disjoint' && (a.name === 'oldRaw' || a.name === 'oldSlug'),
    })),
  });
}
// A skewed polygon has one straight cubic and two lines. Mixing two Green
// conventions gives it the wrong orientation, retaining a false boundary.
for (const rule of ['nonzero', 'evenodd']) {
  const outer = 'M0 0H30V40H0Z',
    inner = 'M5 5L15 14L25 33C21.666666666666668 30 18.333333333333332 27 15 24L5 5Z';
  const a = 0.5 * (1200 - (rule === 'evenodd' ? 100 : 0)) * 0.02 ** 2,
    b = 0.5 * 196 * 0.02 ** 2;
  cases.push({
    name: 'mixed-orientation-' + rule,
    size: 32,
    bbox: [0, 0, 32, 32],
    svg: svg(
      `<g transform="matrix(.02 0 0 .02 16.1 16.1)"><path fill="#d433a9" fill-opacity=".5" fill-rule="${rule}" d="${outer} ${inner}"/><path fill="#348bc4" fill-opacity=".5" d="M9 9H23V23H9Z"/></g>`,
    ),
    comparisonBase: 'raw',
    arms: cases[0].arms,
    colorSamples: [
      {
        x: 16,
        y: 16,
        rgba: [
          212 * a * (1 - b) + 52 * b,
          51 * a * (1 - b) + 139 * b,
          169 * a * (1 - b) + 196 * b,
          255 * (a + b * (1 - a)),
        ],
      },
    ],
  });
}
// Static endpoint proofs must not be applied as interval morph proofs. Both
// imports must restore the authored bands and draw the identical current pose.
for (const name of [
  'nonzero-tiny',
  'evenodd-tiny',
  'mixed-orientation-nonzero',
  'mixed-orientation-evenodd',
]) {
  const c = cases.find((c) => c.name === name);
  cases.push({
    ...c,
    name: name + '-morph-authored',
    colorSamples: undefined,
    morphSvgDst: c.svg,
    morphT: 0.5,
    comparisonBase: 'authored',
    arms: [
      { name: 'authored', engine: 'aac', morph: true, normalizeFill: false },
      { name: 'normalizedImport', engine: 'aac', morph: true },
    ],
  });
}
if (pointsOnly) {
  const selected = cases
    .filter((c) => !c.name.endsWith('-morph-authored'))
    .map((c) => ({
      ...c,
      arms: c.arms.filter((a) => a.engine === 'aac').map((a) => ({ ...a, unified: false })),
    }));
  cases.splice(0, cases.length, ...selected);
}
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-raw-normalize-'));
try {
  const input = path.join(dir, 'input.json'),
    output = process.argv[2] || path.join(dir, 'output.json');
  writeFileSync(
    input,
    JSON.stringify({
      productionShaders: true,
      sdfRecognition: false,
      initialKernel: 'slug',
      aacPoints: pointsOnly,
      forceUnified: !pointsOnly,
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
    timeout: 130000,
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert(!/software|swiftshader|llvmpipe/i.test(d.device.renderer));
  assert.equal(d.rows.length, cases.length);
  for (const row of d.rows) {
    assert.equal(row.glError, 0);
    for (const a of row.arms) {
      const expected =
        a.name === 'cpatch' ? 'cpatch' : a.name.toLowerCase().includes('slug') ? 'slug' : 'aac';
      assert(a.pin.ledger[expected] > 0, 'actual route ' + row.name + ' ' + a.name);
      if (pointsOnly)
        assert(
          a.pin.routeLedger['aac@points'] > 0,
          'actual point route ' + row.name + ' ' + a.name,
        );
      assert(
        Object.entries(a.pin.ledger)
          .filter(([k, v]) => v && ['aac', 'slug', 'lb', 'cpatch'].includes(k))
          .every(([k]) => k === expected),
      );
    }
    if (row.name.endsWith('-morph-authored'))
      assert.equal(row.comparisons[0].maxByte, 0, 'authored morph restoration');
    else {
      if (!pointsOnly)
        assert(
          row.comparisons.find((c) => c.arm === 'slug').maxByte <= 1,
          'raw/Slug full-image parity ' + row.name,
        );
      if (!row.arms.find((a) => a.name === 'raw').colorQuality)
        assert(
          row.comparisons.find((c) => c.arm === 'oldRaw').maxByte <= 1,
          'ordinary raw control parity ' + row.name,
        );
      if (row.arms.find((a) => a.name === 'raw').colorQuality) {
        for (const name of pointsOnly ? ['raw'] : ['raw', 'slug'])
          assert(
            row.arms.find((a) => a.name === name).colorQuality.maxByte <= 1,
            'independent exact area ' + row.name + ' ' + name,
          );
        for (const name of pointsOnly ? ['oldRaw'] : ['oldRaw', 'oldSlug'])
          assert(
            row.arms.find((a) => a.name === name).colorQuality.maxByte > 1,
            'negative control ' + row.name + ' ' + name,
          );
      }
    }
  }
  console.log(
    (pointsOnly ? 'fillNormalizePointsGpuSmoke' : 'fillNormalizePolynomialGpuSmoke') +
      ' PASS: ' +
      d.rows.length +
      (pointsOnly
        ? ' cases; actual aac@points <=1 byte independent exact area on '
        : ' cases; raw AAC and Slug <=1 byte independent exact area; authored morph pixels identical on ') +
      d.device.renderer,
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
