// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Streaming input and scope refusals preserve published geometry and paint.
import { strict as assert } from 'assert';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

// The guard reads meta rows, so a parsed section stands in for a GL bundle: same floats, same
// stride, same shape count, and no GL context needed.
const bundleOf = async (svg, opts) => {
  const sec = await importSvg(svg, Object.assign({ preserveViewport: true }, opts || {}));
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  return {
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    numShapes: pm.numShapes,
    dashFloats: sec.dashes ? new Float32Array(sec.dashes) : null,
    strokeMesh: sec.strokeMesh || null,
    clipMesh: sec.clipMesh || null,
    maskMesh: sec.maskMesh || null,
  };
};

const DOC = (body, defs = '') =>
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs}${body}</svg>`;

const CASES = [
  [
    'plain fill (the in-scope control)',
    DOC('<rect x="10" y="10" width="40" height="30" fill="#3a6ea5"/>'),
    false,
  ],
  [
    'stroked',
    DOC(
      '<rect x="10" y="10" width="40" height="30" fill="#3a6ea5" stroke="#101418" stroke-width="4"/>',
    ),
    true,
  ],
  [
    'clipped',
    DOC(
      '<rect x="10" y="10" width="40" height="30" fill="#3a6ea5" clip-path="url(#c)"/>',
      '<defs><clipPath id="c"><rect x="20" y="0" width="20" height="100"/></clipPath></defs>',
    ),
    true,
  ],
  [
    'masked',
    DOC(
      '<rect x="10" y="10" width="40" height="30" fill="#3a6ea5" mask="url(#m)"/>',
      '<defs><mask id="m"><rect x="0" y="0" width="60" height="100" fill="#fff"/></mask></defs>',
    ),
    true,
  ],
  [
    'dashed',
    DOC(
      '<path d="M10 10 L60 10" fill="none" stroke="#101418" stroke-width="4" stroke-dasharray="6 3"/>',
    ),
    true,
  ],
  [
    'filtered',
    DOC(
      '<rect x="10" y="10" width="40" height="30" fill="#3a6ea5" filter="url(#f)"/>',
      '<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>',
    ),
    true,
  ],
];

// The guard is module-private on purpose, so exercise it through the entry point that owns it.
const { updateBundleGeometry } = await import('../src/renderer/streamGeometry.js');
if (typeof updateBundleGeometry !== 'function') {
  console.error('FAIL updateBundleGeometry is not exported — this smoke cannot reach the guard');
  process.exit(1);
}

for (const [name, svg, mustRefuse] of CASES) {
  const b = await bundleOf(svg);
  // A null gl and empty update: the scope guard runs before anything touches GL, so a refusal
  // arrives without one. An ACCEPTED bundle will go on to fail for some other reason, and that is
  // the point — "did it get past the guard" is the only question here.
  let res;
  try {
    res = updateBundleGeometry(null, b, new Array(b.numShapes).fill(null), {});
  } catch (e) {
    res = { ok: false, reason: 'threw: ' + e.message, threw: true };
  }
  const refusedByScope = !res.ok && /out of streaming v1's scope/.test(res.reason || '');
  if (mustRefuse && !refusedByScope) {
    fail(
      `${name}: the guard did not refuse it (ok=${res.ok}, reason=${JSON.stringify(res.reason)})` +
        ' — this bundle would stream and be rebuilt as if it had none of that',
    );
  } else if (mustRefuse) {
    ok(`${name}: refused — ${res.reason}`);
  } else if (refusedByScope) {
    fail(
      `${name}: the IN-SCOPE control was refused by the scope guard (${res.reason})` +
        ' — a guard that refuses everything is not a guard',
    );
  } else {
    ok(
      `${name}: not refused by the scope guard (it may still decline for another reason: ` +
        `${res.ok ? 'accepted' : JSON.stringify(res.reason)})`,
    );
  }
}

// A malformed later row must not modify an earlier valid row, in either path.
const { parsePathD } = await import('../src/svg/path.js');
const { updateNativeBundleGeometry } = await import('../src/fallback/nativeStream.js');
const moved = parsePathD('M20 20H80V80H20Z');
for (const lightweight of [false, true, undefined]) {
  for (const kind of [
    'count',
    'row',
    'stride',
    'stroke',
    'stroke-gradient',
    'stroke-image',
    'clip',
    'mask',
    'dash',
    'filter',
  ]) {
    const meta = new Float32Array(96);
    meta.set([0, 0, 1, 1], 4);
    meta.set([0, 0, 1, 1], 52);
    const slots = {
      stroke: [11, 12],
      'stroke-gradient': [29],
      'stroke-image': [47],
      clip: [30],
      mask: [31],
      dash: [15],
      filter: [32],
    };
    for (const at of slots[kind] || []) meta[at] = 1;
    const b = {
      numShapes: 2,
      metaFloatsPerShape: kind === 'stride' ? 24 : 48,
      metaFloats: meta,
      coverQuadFloats: new Float32Array(12),
      _geomGen: 7,
    };
    const before = meta.slice();
    const result = updateBundleGeometry(
      new Proxy(
        {},
        {
          get() {
            throw Error('refusal accessed GL');
          },
        },
      ),
      b,
      kind === 'count' ? [] : kind === 'row' ? [moved, null] : [moved, moved],
      {
        lightweight,
        fills: [
          [1, 0, 0, 0.5],
          [1, 0, 0, 1],
        ],
      },
    );
    assert.equal(result.ok, false, `${kind}/${lightweight}: refusal`);
    assert.deepEqual(meta, before, `${kind}/${lightweight}: all metadata unchanged`);
    assert.equal(b._geomGen, 7);
    assert.equal(b._lbSegPrev, undefined);
    assert.equal(b._lbMeshesRaw, undefined);
  }
}
for (const segs of [[], [moved, null]]) {
  const ds = ['before-0', 'before-1'],
    fills = ['blue', 'blue'];
  const b = { numShapes: 2, __streamPathD: ds, __streamFills: fills, __streamGen: 7 };
  const result = updateNativeBundleGeometry(b, segs, {
    fills: [
      [1, 0, 0, 1],
      [1, 0, 0, 1],
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(ds, ['before-0', 'before-1']);
  assert.deepEqual(fills, ['blue', 'blue']);
  assert.equal(b.__streamGen, 7);
}
ok('30 full/light/automatic refusals and two native refusals preserve state');

if (failures) {
  console.error(`STREAM-SCOPE-GUARD FAIL (${failures})`);
  process.exit(1);
}
console.log('\nSTREAM-SCOPE-GUARD PASS');
