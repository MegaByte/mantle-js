// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterLinearBlurImportSmoke -- a lone blur of SourceGraphic in linearRGB (the color-interpolation-filters default) is the single-kind blur
// on linear light (filterTab kind 7, FILT_KIND_BLUR_LINEAR), not a one-node graph. GL-free: reads the parsed record and the emitted sections.
import { imp, wrap, makeChecker } from './_importSemantics.mjs';
import { parseFilters } from '../../src/svg/filter.js';
import { FILT_KIND, FILT_KIND_BLUR, FILT_FLOATS_PER_FILTER } from '../../src/bundle/layout.js';
import { inspect, Features } from '../../src/bundle/featureSet.js';

const { ok, done } = makeChecker('FILTER-LINEAR-BLUR-IMPORT');
const S = 'color-interpolation-filters="sRGB"';
const L = 'color-interpolation-filters="linearRGB"';
const rec = (prims, attrs = '') => {
  const doc = new DOMParser().parseFromString(
    wrap(`<filter id="f" ${attrs}>${prims}</filter>`),
    'image/svg+xml',
  );
  const f = parseFilters(doc.documentElement, null);
  return f && f.f;
};
const R = '<rect x="10" y="10" width="40" height="40" fill="red" filter="url(#f)"/>';
const kindOf = async (prims, attrs = '') => {
  const b = await imp(wrap(`<filter id="f" ${attrs}>${prims}</filter>${R}`));
  const tab = b.filterTab ? new Float32Array(b.filterTab) : null;
  return { tab, kind: tab ? tab[FILT_KIND] : -1, graphs: b.filterGraphs, b };
};

// the parsed record
{
  const r = rec('<feGaussianBlur stdDeviation="3"/>');
  ok(
    r.kind === 'blur' && r.linear === true,
    `a lone blur in linearRGB is a blur record on linear light (${r.kind}, linear ${r.linear})`,
  );
  const s = rec('<feGaussianBlur stdDeviation="3"/>', S);
  ok(s.kind === 'blur' && !s.linear, 'a lone blur in sRGB is the plain blur record');
  const two = rec('<feGaussianBlur stdDeviation="3"/><feGaussianBlur stdDeviation="4"/>', L);
  ok(
    two.kind === 'blur' && two.linear && Math.abs(two.sigmaX - 5) < 1e-9,
    `two blurs compose their sigmas on linear light (${two.sigmaX})`,
  );
  ok(
    rec('<feGaussianBlur stdDeviation="3"/><feColorMatrix type="saturate" values="0.3"/>').kind ===
      'graph',
    'a blur then a matrix in linearRGB is still a graph',
  );
  ok(
    rec('<feColorMatrix type="saturate" values="0.3"/><feGaussianBlur stdDeviation="3"/>').kind ===
      'graph',
    'a matrix then a blur in linearRGB is still a graph',
  );
  ok(
    rec('<feGaussianBlur in="SourceAlpha" stdDeviation="3"/>').kind === 'blur' &&
      !rec('<feGaussianBlur in="SourceAlpha" stdDeviation="3"/>').linear,
    'a blur of the ALPHA has no color to mix: the plain record',
  );
  ok(
    !rec('<feGaussianBlur stdDeviation="0"/>').linear,
    'a zero blur is not a linear blur (it blurs nothing)',
  );
}
// the wire: kind 7 with the identity matrix, kind 1 elsewhere
{
  const a = await kindOf('<feGaussianBlur stdDeviation="3"/>');
  ok(
    a.kind === 7 && !a.graphs?.some(Boolean),
    `a lone linearRGB blur emits filterTab kind 7 and no graph (kind ${a.kind})`,
  );
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  ok(
    id.every((v, i) => a.tab[i] === v),
    'the color matrix texels are the identity',
  );
  ok(
    a.tab[21] === 3 && a.tab[22] === 3,
    `sigma rides in the usual slots (${a.tab[21]}, ${a.tab[22]})`,
  );
  const s = await kindOf('<feGaussianBlur stdDeviation="3"/>', S);
  ok(s.kind === FILT_KIND_BLUR, 'sRGB keeps kind 1');
  const g = await kindOf(
    '<feGaussianBlur stdDeviation="3"/><feColorMatrix type="saturate" values="0.3"/>',
  );
  ok(g.graphs && g.graphs[0] && g.tab[FILT_KIND] === 0, 'a graph keeps its identity record');
  ok(
    (inspect(a.b) & Features.FilterBlur) !== 0n,
    'the feature set names the blur for a kind 7 filter',
  );
}
done();
