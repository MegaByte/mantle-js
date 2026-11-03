// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Engine pins and the explicit primitive axis govern retained and future meshes.
// CPU checks use actual public setters and a state-only GL recorder.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { engineSelection, analyticAllowed, engineSelKey } from '../src/renderer/engineSwitch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sel = (R) => engineSelection({ opts: {}, ...R });

ok(
  !analyticAllowed(sel({ _lbFillMode: 'off', _forcedCover: true }), 'prim').allow,
  'a forced cover route denies the primitive path',
);
ok(
  analyticAllowed(sel({ _lbFillMode: 'off', _forcedCover: true }), 'prim').reason ===
    'forced-cover',
  '...and names the switch that denied it',
);
ok(
  analyticAllowed(
    sel({ _lbFillMode: 'off', _forcedCover: true, _forcedPrimitivesOn: true }),
    'prim',
  ).allow,
  'primitives: "on" restores the primitive on a forced cover arm',
);
ok(
  analyticAllowed(sel({ _lbFillMode: 'off' }), 'prim').allow,
  'the legacy setLoopBlinnFill("off") (not forced) still leaves primitives on',
);
ok(analyticAllowed(sel({ _lbFillMode: 'auto' }), 'prim').allow, "'auto' keeps the primitive path");
ok(
  analyticAllowed(sel({ _lbFillMode: 'on', _forcedCover: false }), 'prim').allow,
  'an unforced lb mode (legacy setter) keeps its primitive meshes',
);
ok(
  !analyticAllowed(sel({ _lbFillMode: 'on', _forcedCover: true }), 'prim').allow,
  'a forced lb / cpatch route (setFillEngine) denies the primitive path',
);
ok(
  !analyticAllowed(sel({ _lbFillMode: 'auto', _forcedKernel: true }), 'prim').allow,
  'a pinned slug / aac kernel denies the primitive path',
);
ok(
  analyticAllowed(
    sel({ _lbFillMode: 'auto', _forcedKernel: true, _forcedPrimitivesOn: true }),
    'prim',
  ).allow,
  'primitives: "on" restores it under a kernel pin',
);
ok(
  engineSelKey({ opts: {}, _lbFillMode: 'off', _forcedCover: true }) !==
    engineSelKey({ opts: {}, _lbFillMode: 'off' }),
  'the selection key tells the two apart (a baked cache is not replayed across them)',
);
const auto = sel({ _lbFillMode: 'auto', _forcedPrimitivesOn: false });
ok(
  !analyticAllowed(auto, 'prim').allow,
  'explicit primitives off denies SDF without route or kernel pins',
);
ok(
  analyticAllowed(auto, 'stream').allow && analyticAllowed(auto, 'build').allow,
  'primitive off preserves stream and analytic build admission',
);
ok(
  engineSelKey({ opts: {}, _lbFillMode: 'auto', _forcedPrimitivesOn: false }) !==
    engineSelKey({ opts: {}, _lbFillMode: 'auto' }),
  'explicit off changes the raster selection key',
);
// Actual public setters with a state-only GL recorder; no shader evaluation.
const { makeFakeWebgl2 } = await import('./_fakeWebgl2.mjs');
const { createRenderer } = await import('../src/index.js');
const { SHADER_FILENAMES } = await import('../src/shaders/index.js');
const { sdfPrimitivesDisabled } = await import('../src/geom/shapeRecognize.js');
const shaders = Object.fromEntries(
  SHADER_FILENAMES.map(([k, f]) => [
    k,
    readFileSync(path.join(ROOT, 'src/shaders/generated', f), 'utf8'),
  ]),
);
const { gl } = makeFakeWebgl2(32, 32),
  renderer = createRenderer(gl, shaders);
try {
  await renderer.ready;
  renderer.setFillEngine({ route: 'auto', kernel: 'auto', primitives: 'off' });
  ok(sdfPrimitivesDisabled(), 'public auto/auto/off disables subsequent recognition');
  renderer.setFillEngine({ kernel: 'auto' });
  ok(sdfPrimitivesDisabled(), 'omitting the primitive axis preserves off');
  let invalid = false;
  try {
    renderer.setFillEngine({ primitives: 'on', kernel: 'typo' });
  } catch {
    invalid = true;
  }
  ok(invalid && sdfPrimitivesDisabled(), 'invalid selection does not change recognition');
  renderer.setFillEngine({ primitives: true });
  ok(!sdfPrimitivesDisabled(), 'public boolean on restores recognition');
  renderer.setSdfPrimitives(false);
  ok(sdfPrimitivesDisabled(), 'legacy recognition switch remains independent');
} finally {
  renderer.setSdfPrimitives(true);
  renderer.setFillEngine({ route: 'auto', kernel: 'auto', primitives: 'on' });
  renderer.dispose();
}
console.log(fail ? `FORCED-COVER-NO-PRIMITIVE FAIL (${fail})` : 'FORCED-COVER-NO-PRIMITIVE PASS');
process.exit(fail ? 1 : 0);
