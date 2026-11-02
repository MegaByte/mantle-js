// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter owner gradients: linear and radial FillPaint/StrokePaint servers keep an owner-only gradient
// record per owner and role, placed by owner CTM x local box (objectBoundingBox) x authored transform, at
// ordinary, mirrored and 2^-20 / 2^20 scales. The leaf paint rows are untouched. Preparation only; no rendering.
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const { importSvg } = await import('../../src/index.js'),
  errors = [],
  rows = [];
let checks = 0;
const near = (actual, expected, label) => {
  checks++;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 2e-5)
    errors.push({ actual, expected, label });
};
const owners = [
    {
      ctm: [2, 0.25, 0.5, 1.5, 10, 20],
      box: [4, 5, 24, 15],
      child:
        '<rect x="4" y="5" width="20" height="10" fill="orange" stroke="purple" stroke-width="8"/>',
    },
    {
      ctm: [-1, 0.1, 0.2, 0.75, 40, 6],
      box: [6, 8, 26, 18],
      child:
        '<rect x="4" y="5" width="20" height="10" transform="translate(2 3)" fill="orange" stroke="purple" stroke-width="8"/>',
    },
  ],
  authored = [1, 0.2, 0.3, 1.1, 2, 4];
for (const scale of [2 ** -20, 2 ** 20])
  owners.push({ ctm: [scale, 0, 0, scale, 0, 0], box: [4, 5, 24, 15], child: owners[0].child });
const point = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
for (const kind of ['linearGradient', 'radialGradient'])
  for (const units of ['objectBoundingBox', 'userSpaceOnUse']) {
    const body = owners
      .map(
        (o) =>
          `<g transform="matrix(${o.ctm.join(' ')})" color="red" fill="url(#g)" stroke="url(#g)" opacity=".6" fill-opacity=".1" stroke-opacity=".2" filter="url(#f)">${o.child}</g>`,
      )
      .join('');
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs color="blue"><${kind} id="g" gradientUnits="${units}" gradientTransform="matrix(${authored.join(' ')})"><stop stop-color="currentColor" stop-opacity=".5"/><stop offset="1" stop-color="lime"/></${kind}><filter id="f"><feComposite in="FillPaint" in2="StrokePaint" operator="over"/></filter></defs>${body}</svg>`;
    const result = await importSvg(doc, { preserveViewport: true }),
      graphs = result.filterGraphs?.filter(Boolean) || [],
      table = result.gradients ? new Float32Array(result.gradients) : new Float32Array(),
      ids = [];
    near(graphs.length, owners.length, kind + '/' + units + ' independent owners');
    for (let oi = 0; oi < owners.length; oi++)
      for (const role of ['fill', 'stroke']) {
        const paint = graphs[oi]?.ownerPaints?.[role];
        checks++;
        if (paint?.kind !== 'gradient' || !paint.frameKnown || !(paint.gradientId > 0)) {
          errors.push({ kind, units, oi, role, paint, label: 'retained gradient binding' });
          continue;
        }
        ids.push(paint.gradientId);
        const at = (paint.gradientId - 1) * 16;
        near(table[at + 2], 0, 'bound record is in document units');
        for (const uv of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
          [0.25, 0.75],
        ]) {
          let p = point(authored, uv);
          const o = owners[oi],
            bb = o.box;
          if (units === 'objectBoundingBox')
            p = [bb[0] + p[0] * (bb[2] - bb[0]), bb[1] + p[1] * (bb[3] - bb[1])];
          const world = point(o.ctm, p),
            m = Array.from(table.slice(at + 4, at + 10)),
            mapped = point(m, world);
          near(mapped[0], uv[0], kind + '/' + units + '/' + role + ' x');
          near(mapped[1], uv[1], kind + '/' + units + '/' + role + ' y');
        }
      }
    near(new Set(ids).size, owners.length * 2, 'one resource per owner and role');
    const meta = new Float32Array(result.meta, 32);
    for (let row = 0; row < result.numShapes; row++) {
      near(meta[row * 48 + 28], 0, 'owner gradient does not rewrite leaf fill');
      near(meta[row * 48 + 29], 0, 'owner gradient does not rewrite leaf stroke');
    }
    rows.push({
      kind,
      units,
      gradients: table.length / 16,
      ids,
      owners: graphs.map((g) => g.ownerPaints),
    });
  }
assert.equal(errors.length, 0, JSON.stringify(errors.slice(0, 4)));
console.log('filterOwnerGradientImportSmoke PASS', checks, 'checks');
