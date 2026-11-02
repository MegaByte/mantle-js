// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedNestedMaskRenderSmoke — a mask nested in a mask draws right on every route (the node half is nestedMaskGateSmoke).
//
// A nested mask taken by the unified route draws blank, where the cover pass draws it right (the corpus case _mask_nested).
// Each cell of test/_nestedMaskCases.mjs is drawn at 256 px on the cover pass (route 'none')
// and on the forced unified route (route 'lb'):
//   1. the forced unified picture equals the cover picture to 1/255 (a nested cell is declined to the cover pass, a single-level
//      cell takes the unified route and draws what the cover pass draws);
//   2. the cover picture is within 0.1 mean of Chrome 8x (all pixels, 0-255 channel units), except the `coverWrong` cells, which the
//      cover pass itself draws wrongly;
//   3. a declined cell's draw count shows no loop-blinn draw; a single-level mask cell's does.
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';
import { nestedMaskCases } from './_nestedMaskCases.mjs';

const W = 256;
let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const ref = await openChrome8Ref(launchBrowser);
try {
  for (const c of nestedMaskCases) {
    const cover = await ref.render(c.svg, { w: W, h: W, route: 'none' });
    const uni = await ref.render(c.svg, { w: W, h: W, route: 'lb' });
    const vs = compare(cover.mantle, cover.chrome, W, W, {});
    const same = compare(uni.mantle, cover.mantle, W, W, { tol: 1 });
    const lbDraws = (uni.drew && uni.drew.lb) | 0;
    let line = `${c.id}: cover vs Chrome 8x mean ${vs.mean.toFixed(3)} (max ${vs.max}); unified vs cover ${same.over} px over 1/255 (max ${same.max}); unified-route draws ${lbDraws}`;
    let bad = same.over > 0;
    if (!c.coverWrong && !(vs.mean < 0.1)) bad = true;
    if (c.nested ? lbDraws > 0 : lbDraws === 0) bad = true;
    if (c.coverWrong)
      line += ' [the cover pass draws this cell wrongly on every release: route agreement only]';
    if (bad) fail(line);
    else console.log('ok ' + line);
  }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nPASS unifiedNestedMaskRenderSmoke');
