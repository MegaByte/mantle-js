// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupAlphaExportSmoke -- the export and the no-WebGL native scene give a draw GROUP-opacity alpha, as the GL path does
// (test/groupAlphaSmoke.mjs): a draw's `alpha` is `opacity` on ONE `<g>` wrapped around the
// whole bundle, never on each leaf. Pinned here so the GL path and the export cannot drift apart.
import { mkRenderer, exportDetail, els, check, finish, wrap } from './_exportHarness.mjs';

const TWO =
  '<rect id="a" x="10" y="10" width="60" height="80" fill="#f00"/><rect id="b" x="40" y="40" width="50" height="50" fill="#00f"/>';
const { R, bundle } = await mkRenderer(100, 100);
const b = await bundle(wrap(TWO));

R.beginFrame([0, 0, 0, 0]);
R.drawBundle(b, { alpha: 0.5 });
R.endFrame();
{
  const out = await exportDetail(R);
  const svg = els(out.svg, 'g').filter((g) => g.getAttribute('opacity') === '0.5');
  check('drawBundle alpha .5 -> exactly one <g opacity="0.5">', svg.length === 1, svg.length);
  check(
    '...that group holds both rects',
    svg.length === 1 && svg[0].querySelectorAll('rect').length === 2,
  );
  const leaf = els(out.svg, 'rect').filter(
    (r) => r.getAttribute('opacity') || r.getAttribute('fill-opacity'),
  );
  check('...and no rect carries an opacity of its own', leaf.length === 0, leaf.length);
}

R.beginFrame([0, 0, 0, 0]);
R.drawBundleInstanced(b, [{ alpha: 0.25 }, { alpha: 0.75 }]);
R.endFrame();
{
  const out = await exportDetail(R);
  const ops = els(out.svg, 'g')
    .map((g) => g.getAttribute('opacity'))
    .filter(Boolean);
  check(
    'drawBundleInstanced: one group per instance at its own alpha',
    ops.includes('0.25') && ops.includes('0.75'),
    ops.join(),
  );
}
finish('groupAlphaExportSmoke');
