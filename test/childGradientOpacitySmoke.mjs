// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// childGradientOpacitySmoke — a gradient inside PATTERN or MASK content keeps its
// opacity and channel opacity.
//
// The importer stores a gradient paint as (1,1,1, opacity x fill-/stroke-opacity) and the main fill
// and stroke paths multiply the ramp by it. The three places that paint a CHILD row -- the
// pattern-tile loop and the inline mask walk in mantle.frag.glsl, and maskBake.frag.glsl -- must do
// the same: sampling the ramp alone draws a gradient in a pattern tile or in mask content at full
// opacity whatever its fill-opacity says. Each multiplies the sample by the row's paint, as the main path does.
//
// Checked here in two halves: what the importer stores for such a child, and that every child-row
// gradient sample in the shipped shader text is multiplied by its row's paint (a CPU emulator of the
// pattern loop does not exist; the render lane's inheritedChannelOpacityRenderSmoke draws both cases
// against Chrome).
import { readFileSync } from 'fs';
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import importSvg from '../src/svg/importer.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import * as M from '../src/bundle/layout.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the importer: a child row's gradient paint carries its alpha -----------------------------------
{
  const b = await importSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>
      <linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
      <pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/></pattern>
      <mask id="m"><rect width="100" height="100" fill="url(#g)" fill-opacity="0.4"/></mask>
    </defs>
    <rect width="50" height="50" fill="url(#p)"/>
    <rect x="50" width="50" height="50" fill="#000" mask="url(#m)"/></svg>`);
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    F = pm.metaFloats,
    alphas = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * pm.floatsPerShape;
    if (F[o + M.META_FILL_GRAD] > 0 && F[o + 4] === 1 && F[o + 5] === 1 && F[o + 6] === 1)
      alphas.push(+F[o + 7].toFixed(4));
  }
  alphas.sort();
  ok(
    alphas.length === 2 && alphas[0] === 0.4 && alphas[1] === 0.5,
    `the pattern child and the mask child store their gradient paint as (1,1,1,alpha): alphas ${alphas.join(', ')}, want 0.4 and 0.5`,
  );
}

// ---- the shaders: every child-row gradient sample is multiplied by its row's paint -----------------
for (const file of ['mantle.frag.glsl', 'maskBake.frag.glsl']) {
  const src = readFileSync(new URL(`../src/shaders/generated/${file}`, import.meta.url), 'utf8');
  const re =
    /sampleGradient\((c(?:Fill|Stroke)GradId),[^;:]*?\)(\s*\*\s*(\w+|texelFetch\([^)]*\)))?/g;
  const sites = [...src.matchAll(re)];
  const bare = sites.filter((m) => !m[2]).map((m) => m[1]);
  ok(
    sites.length > 0 && bare.length === 0,
    `${file}: ${sites.length} child-row gradient samples, ${bare.length} not multiplied by the row's paint${bare.length ? ` (${bare.join(', ')})` : ''}`,
  );
}

console.log(fail ? `childGradientOpacitySmoke FAIL (${fail})` : 'childGradientOpacitySmoke PASS');
process.exit(fail ? 1 : 0);
