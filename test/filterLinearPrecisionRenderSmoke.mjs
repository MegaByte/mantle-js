// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// LinearRGB filter targets preserve dark-gradient levels and smooth shadow ramps.
// Compare probe-line level counts, adjacent steps and sRGB differences.
// Single-shape controls also check terminal coverage admission against Chrome8.
//
//   FLP_ONLY=a,b   run only the cells whose id starts with one of the prefixes
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref } from './_chrome8Ref.mjs';

const W = 128,
  H = 128;
const doc = (bg, defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 64 64"><defs>${defs}</defs><rect width="64" height="64" fill="${bg}"/>${body}</svg>`;
const REG = 'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"';
const CIF = (v) => `color-interpolation-filters="${v}"`;
const RAMP_DEFS =
  '<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#303030"/></linearGradient>';
const RAMP = '<rect width="64" height="64" fill="url(#g)"/>';
const CARD = '<rect x="16" y="10" width="32" height="32" rx="3" fill="#fff"';
// [id, (cif) => svg, probe line { axis: 'x'|'y', at (px, the other coordinate), from, to (px) }, { bound, levels }]
const CELLS = [
  // a dark ramp through a lone blur (the kind-7 in-place record) and through the same blur as a graph (a merge after it)
  [
    'ramp-blur',
    (c) =>
      doc(
        '#000',
        RAMP_DEFS + `<filter id="f" ${REG} ${CIF(c)}><feGaussianBlur stdDeviation="0.1"/></filter>`,
        `<g filter="url(#f)">${RAMP}</g>`,
      ),
    { axis: 'x', at: 64, from: 0, to: 128 },
    { bound: 2 },
  ],
  [
    'ramp-graph',
    (c) =>
      doc(
        '#000',
        RAMP_DEFS +
          `<filter id="f" ${REG} ${CIF(c)}><feGaussianBlur stdDeviation="0.1" result="r"/><feMerge><feMergeNode in="r"/></feMerge></filter>`,
        `<g filter="url(#f)">${RAMP}</g>`,
      ),
    { axis: 'x', at: 64, from: 0, to: 128 },
    { bound: 2 },
  ],
  // A card shadow: feDropShadow of #012428 at .4 over a teal ground, read down a column below the card
  [
    'card-shadow',
    (c) =>
      doc(
        '#1c7c7a',
        `<filter id="f" x="-50%" y="-50%" width="200%" height="200%" ${CIF(c)}><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#012428" flood-opacity="0.4"/></filter>`,
        `${CARD} filter="url(#f)"/>`,
      ),
    { axis: 'y', at: 64, from: 86, to: 128 },
    { bound: 2 },
  ],
  [
    'card-shadow-light',
    (c) =>
      doc(
        '#e8f4f2',
        `<filter id="f" x="-50%" y="-50%" width="200%" height="200%" ${CIF(c)}><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#012428" flood-opacity="0.5"/></filter>`,
        `${CARD} filter="url(#f)"/>`,
      ),
    { axis: 'y', at: 64, from: 86, to: 128 },
    { bound: 2 },
  ],
  // a dark shape blurred wide: the lone blur on a light and a mid ground
  [
    'blur-dark-light',
    (c) =>
      doc(
        '#fff',
        `<filter id="f" ${REG} ${CIF(c)}><feGaussianBlur stdDeviation="9"/></filter>`,
        '<rect x="22" y="22" width="20" height="20" fill="#102030" filter="url(#f)"/>',
      ),
    { axis: 'x', at: 64, from: 0, to: 128 },
    { bound: 4 },
  ],
  [
    'blur-black-mid',
    (c) =>
      doc(
        '#8090a0',
        `<filter id="f" ${REG} ${CIF(c)}><feGaussianBlur stdDeviation="9"/></filter>`,
        '<rect x="22" y="22" width="20" height="20" fill="#000" fill-opacity=".6" filter="url(#f)"/>',
      ),
    { axis: 'x', at: 64, from: 0, to: 128 },
    { bound: 4 },
  ],
  // the other shapes of a lone blur: one axis (a lone first-and-last pass), a box blur past the Gaussian table, the default region (a rect-sized target)
  [
    'blur-x-only',
    (c) =>
      doc(
        '#fff',
        `<filter id="f" ${REG} ${CIF(c)}><feGaussianBlur stdDeviation="9 0"/></filter>`,
        '<rect x="22" y="22" width="20" height="20" fill="#102030" filter="url(#f)"/>',
      ),
    { axis: 'x', at: 64, from: 0, to: 128 },
    { bound: 4 },
  ],
  [
    'blur-box',
    (c) =>
      doc(
        '#fff',
        `<filter id="f" ${REG} ${CIF(c)}><feGaussianBlur stdDeviation="30"/></filter>`,
        '<rect x="14" y="14" width="36" height="36" fill="#102030" filter="url(#f)"/>',
      ),
    { axis: 'x', at: 64, from: 0, to: 128 },
    { bound: 4 },
  ],
  [
    'blur-default-region',
    (c) =>
      doc(
        '#fff',
        `<filter id="f" ${CIF(c)}><feGaussianBlur stdDeviation="3"/></filter>`,
        '<rect x="22" y="22" width="20" height="20" fill="#102030" filter="url(#f)"/>',
      ),
    { axis: 'x', at: 64, from: 0, to: 128 },
    { bound: 4 },
  ],
  // a shadow graph: the alpha blurred, offset, faded by a transfer, merged under the source
  [
    'shadow-graph',
    (c) =>
      doc(
        '#dfe8f0',
        `<filter id="f" x="-50%" y="-50%" width="200%" height="200%" ${CIF(c)}><feGaussianBlur in="SourceAlpha" stdDeviation="5"/><feOffset dy="3"/><feComponentTransfer><feFuncA type="linear" slope=".5"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
        '<g filter="url(#f)"><rect x="16" y="10" width="32" height="32" rx="5" fill="#fff"/></g>',
      ),
    { axis: 'y', at: 64, from: 86, to: 128 },
    { bound: 3 },
  ],
];
const LEVEL_FRACTION = 0.85;

const only = process.env.FLP_ONLY ? process.env.FLP_ONLY.split(',') : null;
let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const probe = (img, { axis, at, from, to }, ch) => {
  const v = [];
  for (let k = from; k < to; k++) v.push(img[(axis === 'x' ? at * W + k : k * W + at) * 4 + ch]);
  return v;
};
const stats = (a) => {
  let step = 0;
  for (let i = 1; i < a.length; i++) step = Math.max(step, Math.abs(a[i] - a[i - 1]));
  return { levels: new Set(a).size, step };
};

const ref = await openChrome8Ref(launchBrowser);
try {
  for (const [id, svgOf, line, o] of CELLS) {
    if (only && !only.some((p) => id.startsWith(p))) continue;
    const lin = (await ref.render(svgOf('linearRGB'), { w: W, h: H })).mantle;
    const srgb = (await ref.render(svgOf('sRGB'), { w: W, h: H })).mantle;
    let worst = '',
      ok = true,
      maxd = 0;
    for (const [name, ch] of [
      ['R', 0],
      ['G', 1],
      ['B', 2],
    ]) {
      const a = probe(lin, line, ch),
        b = probe(srgb, line, ch);
      const sa = stats(a),
        sb = stats(b);
      let d = 0;
      for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
      maxd = Math.max(maxd, d);
      const bad = [];
      if (sb.levels >= 8 && sa.levels < Math.floor(sb.levels * LEVEL_FRACTION))
        bad.push(`levels ${sa.levels} < ${LEVEL_FRACTION} x ${sb.levels}`);
      if (sa.step > sb.step + 1) bad.push(`step ${sa.step} > ${sb.step} + 1`);
      if (d > o.bound) bad.push(`diff ${d} > ${o.bound}`);
      if (bad.length) {
        ok = false;
        worst += ` [${name}: ${bad.join('; ')}]`;
      } else if (process.env.FLP_VERBOSE)
        console.log(
          `   ${id} ${name}: levels ${sa.levels} (sRGB ${sb.levels}), step ${sa.step} (${sb.step}), diff ${d}`,
        );
    }
    if (!ok) fail(`${id}:${worst}`);
    else console.log(`ok ${id}: levels/step/diff within bounds (max diff ${maxd})`);
  }
  // Single-owned-shape capture: compare the actual edge with independent Chrome8 coverage.
  // The uniform recorder observes admission without exposing a renderer diagnostic API.
  if (!only || only.some((p) => 'coverage-resolve'.startsWith(p))) {
    await ref.page.evaluate(() => {
      const names = new WeakMap();
      const proto = WebGL2RenderingContext.prototype;
      const get = proto.getUniformLocation,
        set = proto.uniform1i;
      proto.getUniformLocation = function (program, name) {
        const location = get.call(this, program, name);
        if (location) names.set(location, name);
        return location;
      };
      proto.uniform1i = function (location, value) {
        const name = names.get(location);
        if (value === 1 && name === 'uCoverageResolve') window.__coverageAccepted++;
        if (value === 1 && name === 'uCoveragePixelAligned') window.__coverageAligned++;
        return set.call(this, location, value);
      };
    });
    for (const [id, opacity, space, admitted, missingComposite] of [
      ['opaque', 1, 'linearRGB', true],
      ['half', 0.5, 'linearRGB', true],
      ['explicit-srgb', 1, 'sRGB', false],
      ['missing-composite', 0.5, 'linearRGB', false, true],
    ]) {
      await ref.page.evaluate(() => {
        window.__coverageAccepted = 0;
        window.__coverageAligned = 0;
      });
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="${space}"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#603020" flood-opacity=".55"/></filter></defs><rect x="16" y="10.125" width="32" height="31" fill="#fff" fill-opacity="${opacity}" filter="url(#f)"/></svg>`;
      // A partial opt-in registry keeps its existing fallback instead of normalizing the source.
      if (missingComposite)
        await ref.page.evaluate(async () => {
          const { registerSvgFilter } = await import('/src/filterGraph/dispatchRegistry.js');
          registerSvgFilter('feComposite', undefined);
        });
      let result;
      try {
        result = await ref.render(svg, { w: W, h: H, ground: 'white' });
      } finally {
        if (missingComposite)
          await ref.page.evaluate(async () => {
            const { registerSvgFilter } = await import('/src/filterGraph/dispatchRegistry.js');
            const { feComposite } = await import('/src/filterGraph/primitives/composite.js');
            registerSvgFilter('feComposite', feComposite);
          });
      }
      const route = await ref.page.evaluate(() => ({
        accepted: window.__coverageAccepted,
        aligned: window.__coverageAligned,
      }));
      if (admitted ? !(route.accepted > 0 && route.aligned > 0) : route.accepted !== 0)
        fail(`coverage-resolve-${id}: unexpected admission ${JSON.stringify(route)}`);
      // Probe the straight bottom edge at physical y82.25.
      const edge = (82 * W + 64) * 4;
      let max = 0;
      for (let k = 0; k < 4; k++)
        max = Math.max(max, Math.abs(result.mantle[edge + k] - result.chrome[edge + k]));
      if (admitted && max > 3) fail(`coverage-resolve-${id}: Chrome8 edge error ${max} > 3`);
      if (!result.mantle.some((v, i) => i % 4 !== 3 && v < 250))
        fail(`coverage-resolve-${id}: blank image`);
      console.log(
        `coverage-resolve-${id}: ${JSON.stringify({ route, mantle: Array.from(result.mantle.slice(edge, edge + 4)), chrome8: Array.from(result.chrome.slice(edge, edge + 4)), max })}`,
      );
    }
  }
  if (!only || only.some((p) => 'held-filter-binding'.startsWith(p))) {
    const held = await ref.page.evaluate(async () => {
      const M = await import('/src/index.js'),
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true }),
        names = new WeakMap();
      let accepted = 0,
        R,
        a,
        b,
        m;
      const get = gl.getUniformLocation.bind(gl),
        set = gl.uniform1i.bind(gl);
      gl.getUniformLocation = (p, n) => {
        const l = get(p, n);
        if (l) names.set(l, n);
        return l;
      };
      gl.uniform1i = (l, v) => {
        if (v === 1 && names.get(l) === 'uCoverageResolve') accepted++;
        return set(l, v);
      };
      const svg = (sigma, dy) =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="linearRGB"><feDropShadow dy="${dy}" stdDeviation="${sigma}" flood-color="#603020" flood-opacity=".55"/></filter></defs><rect x="16" y="10.125" width="32" height="31" fill="white" fill-opacity=".5" filter="url(#f)"/></svg>`;
      try {
        R = M.createRenderer(gl, await M.loadShaders(new URL('/src/shaders/', location.href).href));
        await R.ready;
        R.setViewport(128, 128);
        gl.viewport(0, 0, 128, 128);
        R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
        const rows = [];
        for (const [name, sigma, dy] of [
          ['blur', 9, 4],
          ['offset', 6, 7],
        ]) {
          a = M.createBundle(
            gl,
            await M.importSvg(svg(6, 4), { preserveViewport: true, retainSource: true }),
          );
          b = M.createBundle(
            gl,
            await M.importSvg(svg(sigma, dy), { preserveViewport: true, retainSource: true }),
          );
          m = M.createShapeMorph(gl, a, b);
          const frames = [],
            admissions = [];
          for (const [target, t] of [[a], [m, 0], [b], [m, 1]]) {
            if (t !== undefined) m.setT(t);
            const draw = () => {
              R.beginFrame([1, 1, 1, 1]);
              R.drawBundle(target);
              R.endFrame();
            };
            accepted = 0;
            const warm = await R.warmScene([{ draw }], { maxPasses: 128, fenceTimeoutMs: 60000 });
            if (!warm.complete) throw Error('Held-filter warming incomplete');
            draw();
            const pixels = new Uint8Array(128 * 128 * 4);
            gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            if (!pixels.some((v, i) => i % 4 !== 3 && v < 250))
              throw Error('Blank held-filter frame');
            frames.push(pixels);
            admissions.push(accepted);
          }
          rows.push({
            name,
            admissions,
            max: [0, 2].map((i) =>
              frames[i].reduce((v, n, k) => Math.max(v, Math.abs(n - frames[i + 1][k])), 0),
            ),
          });
          m.dispose();
          b.dispose();
          a.dispose();
          m = b = a = null;
        }
        if (gl.getError()) throw Error('Held-filter GL error');
        return rows;
      } finally {
        m?.dispose();
        b?.dispose();
        a?.dispose();
        R?.dispose();
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.remove();
      }
    });
    for (const row of held) {
      if (row.max.some((v) => v > 1) || row.admissions.some((v) => v <= 0))
        fail(`held-filter-binding: ${JSON.stringify(row)}`);
      else console.log(`held-filter-binding: ${JSON.stringify(row)}`);
    }
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
console.log(
  '\nfilterLinearPrecisionRenderSmoke: linearRGB shadows and blurs of dark content keep the levels and steps of the sRGB picture',
);
