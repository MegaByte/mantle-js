// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// convolveOrderPassThroughSmoke -- feConvolveMatrix above the shader's 5x5 passes through with one warning, instead of reading the first 25 values as a different kernel.
//
// A 7x7 identity kernel became a 5x5 with its 1 in the last cell, so the picture shifted, with no warning.
// Pinned: order 7 builds no convolve primitive in either import path and warns once; order 5 still builds one, with its kernel intact.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const warnings = [];
const w0 = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));
const { importSvg } = await import('../../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (order, kernel, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><filter id="f"><feConvolveMatrix order="${order}" kernelMatrix="${kernel}"/>${extra}</filter></defs><path d="M8 8H56V56H8Z" fill="#f00" filter="url(#f)"/></svg>`;
const K = (n, center) => {
  const v = new Array(n * n).fill(0);
  v[center] = 1;
  return v.join(' ');
};
const has = (sec) =>
  /convolve/i.test(JSON.stringify(sec, (k, v) => (ArrayBuffer.isView(v) ? undefined : v)) || '');
console.log('(order 7) passes through, with one warning');
const seven = await importSvg(doc(7, K(7, 24)), { preserveViewport: true });
ok(!has(seven), 'no convolve primitive in the bundle');
const plain = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 8H56V56H8Z" fill="#f00"/></svg>',
  { preserveViewport: true },
);
const bytes = (b) => Buffer.from(b).toString('hex');
ok(
  seven.numShapes === 1 &&
    bytes(seven.curves) === bytes(plain.curves) &&
    bytes(seven.meta) === bytes(plain.meta),
  `the shape is still there and its record is the unfiltered one (${seven.numShapes} shape, ${seven.meta.byteLength} vs ${plain.meta.byteLength} meta bytes)`,
);
const about = () => warnings.filter((x) => /feConvolveMatrix order/.test(x));
ok(about().length === 1, `one warning (${about().length}): ${about()[0] || ''}`);
ok(
  !has(await importSvg(doc('3 9', new Array(27).fill(0).join(' ')), { preserveViewport: true })),
  'a rectangular order with one long axis too',
);
warnings.length = 0;
const f7 = '<feConvolveMatrix order="7" kernelMatrix="' + K(7, 24) + '"/>';
await importSvg(doc(7, K(7, 24), f7), { preserveViewport: true });
ok(about().length === 1, `two such primitives in one document warn once (${about().length})`);
console.log('(order 5) still builds its kernel');
const five = await importSvg(doc(5, K(5, 12)), { preserveViewport: true });
ok(has(five), 'a convolve primitive in the bundle');
console.warn = w0;
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
