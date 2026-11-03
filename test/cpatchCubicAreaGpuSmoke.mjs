// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Complete cubic paints must composite once, including holes and affine maps.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
      comparisonBase: 'cpatch',
      captureGeometry: true,
      captureOverOne: true,
      captureReferencePixels: !transform || transform.includes('.02'),
      referencePixels: [
        [16, 16],
        [7, 16],
      ],
      arms: [
        { name: 'cpatch', engine: 'cpatch', fallbackKernel: 'aac', cpatchAreaSplit: false },
        { name: 'raw', engine: 'aac' },
      ],
    });
  }
// Independent exact area of four cubic quarter arcs with handle ratio .55.
// The full transformed paint fits in one pixel, so no spatial sampling is needed.
cases.push({
  name: 'whole-cubic-in-pixel',
  size: 32,
  bbox: [0, 0, 32, 32],
  svg: svg(
    `<path transform="matrix(.02 0 0 .02 16.1 16.1)" fill="#d433a9" fill-opacity=".5" d="${outer}"/>`,
  ),
  samples: [
    { x: 16, y: 16, area: 0.5 * 4 * 144 * (0.5 + 0.6 * 0.55 - 0.15 * 0.55 * 0.55) * 0.02 * 0.02 },
  ],
  comparisonBase: 'cpatch',
  captureGeometry: true,
  arms: [
    { name: 'cpatch', engine: 'cpatch', fallbackKernel: 'aac', cpatchAreaSplit: false },
    { name: 'raw', engine: 'aac' },
  ],
});
// More than 64 authored cubics, with a stroke forcing the mixed fill/stroke shader.
// Straight cubic edges retain the native record and give AAC an independent polygon control.
const points = Array.from({ length: 128 }, (_, i) => {
  const a = (i * Math.PI) / 64,
    r = i % 2 ? 8 : 12;
  return [16 + r * Math.cos(a), 16 + r * Math.sin(a)];
});
let longPath = 'M' + points[0].join(' ');
for (let i = 0; i < points.length; i++) {
  const a = points[i],
    b = points[(i + 1) % points.length],
    mix = (t) => a.map((v, j) => v + (b[j] - v) * t).join(' ');
  longPath += 'C' + mix(1 / 3) + ' ' + mix(2 / 3) + ' ' + b.join(' ');
}
longPath += 'Z';
cases.unshift({
  name: 'mixed-128-cubics',
  size: 32,
  bbox: [0, 0, 32, 32],
  svg: svg(
    `<path fill="#d433a9" fill-opacity=".5" d="${longPath}"/><path fill="#348bc4" fill-opacity=".5" stroke="#348bc4" stroke-opacity=".5" stroke-width=".3" d="M9 9H23V23H9Z"/>`,
  ),
  comparisonBase: 'cpatch',
  captureGeometry: true,
  arms: [
    { name: 'cpatch', engine: 'cpatch', fallbackKernel: 'aac', cpatchAreaSplit: false },
    { name: 'raw', engine: 'aac' },
  ],
});
const mixed = cases[0];
cases.push({
  ...mixed,
  name: 'mixed-128-affine',
  drawOptions: { worldMatrix: [0.7, 0.25, 0, -0.15, 0.8, 0, 0.05, -0.05, 1] },
  arms: mixed.arms.slice(),
});
cases.push({
  ...mixed,
  name: 'mixed-128-recolor',
  drawOptions: { colorMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5] },
  arms: mixed.arms.slice(),
});
cases.push({
  ...mixed,
  name: 'mixed-128-alpha-lift',
  drawOptions: { colorMatrixOffset: [0, 0, 0, 0.1] },
  arms: mixed.arms.slice(),
});
for (const c of cases)
  c.arms.push({
    name: 'split',
    engine: 'cpatch',
    fallbackKernel: 'aac',
    cpatchAreaSplit: true,
    requireAreaSplit: c.name.startsWith('mixed-128'),
    captureWarmImages: c.name === 'mixed-128-cubics' || c.name === 'mixed-128-recolor',
    captureDrawCalls: c.name.startsWith('mixed-128'),
  });
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-cpatch-cubic-'));
try {
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  writeFileSync(
    input,
    JSON.stringify({
      productionShaders: true,
      sdfRecognition: false,
      initialKernel: 'aac',
      forceUnified: true,
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
      MANTLE_GPU_WALL_MS: '60000',
    },
    timeout: 70000,
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert(!/software|swiftshader|llvmpipe/i.test(d.device.renderer));
  assert.equal(d.rows.length, cases.length);
  for (const row of d.rows) {
    assert.equal(row.glError, 0);
    const cp = row.arms[0],
      raw = row.arms[1],
      split = row.arms[2];
    if (row.name.startsWith('mixed-128')) {
      const pin = split.pin;
      assert.equal(pin.drawCalls.length, 2, 'actual ordered area/stroke draw count');
      assert(pin.drawCalls[0].defines.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY'));
      assert(pin.drawCalls[1].defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA'));
      assert.equal(pin.drawCalls[0].count, 12, 'two complete paint covers');
      assert.equal(pin.drawCalls[1].count, 6, 'one stroke cover');
      assert.equal(pin.ledger.cpatch, 1, 'only the area run carries CPatch geometry');
      assert.equal(pin.ledger.stroke, 1, 'only the seam run carries stroke geometry');
      assert.equal(
        pin.ledger.aac || 0,
        row.name === 'mixed-128-alpha-lift' ? 1 : 0,
        'only the lifted stroke fill uses AAC',
      );
    }
    assert(split.pin.ledger.cpatch > 0 && !split.pin.ledger.lb && !split.pin.ledger.slug);
    assert(
      row.name === 'mixed-128-alpha-lift' ? split.pin.ledger.aac > 0 : !split.pin.ledger.aac,
      'cover kernel matches actual recolor alpha demand',
    );
    if (row.name === 'mixed-128-cubics' || row.name === 'mixed-128-recolor')
      assert(
        split.warmupImages.length && split.warmupImages.every((f) => f.maxDelta <= 1),
        'first split-use frames remain correct while variants warm',
      );
    assert(
      row.comparisons[1].maxByte <= 1,
      'split parity ' + row.name + ' ' + JSON.stringify(row.comparisons[1]),
    );
    if (row.name.startsWith('mixed-128'))
      assert(
        split.pin.defines.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY') &&
          split.pin.defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA'),
        'both ordered split programs actually drawn',
      );
    assert(cp.pin.ledger.cpatch > 0 && !cp.pin.ledger.lb && !cp.pin.ledger.slug);
    assert(
      row.name === 'mixed-128-alpha-lift' ? cp.pin.ledger.aac > 0 : !cp.pin.ledger.aac,
      'combined cover kernel matches recolor demand',
    );
    const paints =
      row.name === 'whole-cubic-in-pixel' ? 1 : row.name.startsWith('mixed-128') ? 3 : 2;
    assert.equal(cp.preparation.built, paints);
    assert(cp.imageHash && raw.imageHash);
    assert.equal(cp.packed.meshes.length, paints);
    assert(
      cp.packed.meshes.every((m) => m.verts.length === 6 * 24),
      'one cover per authored paint',
    );
    if (row.name.startsWith('mixed-128')) {
      assert(
        !cp.pin.defines.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY'),
        'mixed program was bound',
      );
      assert(
        cp.packed.meshes.some((m) => m.verts[20] > 64),
        'large native cubic paint was packed',
      );
    }
    if (row.name.endsWith('-tiny')) {
      const disc = 0.5 * 4 * 144 * (0.5 + 0.6 * 0.55 - 0.15 * 0.55 * 0.55) * 0.02 * 0.02;
      const hole = 0.5 * 4 * 16 * (0.5 + 0.6 * 0.55 - 0.15 * 0.55 * 0.55) * 0.02 * 0.02;
      const a = disc - (row.name.startsWith('evenodd') ? hole : 0),
        blue = 0.5 * 196 * 0.02 * 0.02;
      const expected = [
        212 * a * (1 - blue) + 52 * blue,
        51 * a * (1 - blue) + 139 * blue,
        169 * a * (1 - blue) + 196 * blue,
        255 * (a + blue * (1 - a)),
      ];
      cp.referencePixels[0].rgba.forEach((v, i) =>
        assert(
          Math.abs(v - expected[i]) <= 1,
          'independent tiny paint ' + row.name + ' channel ' + i,
        ),
      );
      // Raw AAC's winding fold is not a reference for fully subpixel nested contours.
      console.log('raw subpixel diagnostic ' + row.name + ' ' + JSON.stringify(row.comparisons[0]));
    } else
      assert(row.comparisons[0].maxByte <= 1, row.name + ' ' + JSON.stringify(row.comparisons[0]));
    if (row.name === 'whole-cubic-in-pixel')
      assert(cp.quality.maxError * 255 <= 1, 'independent exact whole-cubic area');
    if (row.name.endsWith('identity')) {
      const alpha = cp.referencePixels[0].rgba[3],
        expected = row.name.startsWith('evenodd') ? 128 : 191;
      assert(Math.abs(alpha - expected) <= 1, 'hole and source-over opacity');
      assert(Math.abs(cp.referencePixels[1].rgba[3] - 128) <= 1);
    }
  }
  console.log(
    'cpatchCubicAreaGpuSmoke PASS: ordinary cubic paints and affine maps <=1 RGBA byte; tiny nested paints and a whole cubic match independent exact area on ' +
      d.device.renderer,
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
