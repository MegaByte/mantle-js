// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// perfRowsSmoke -- paint and image import limits that bound cost.
//   SVG <image> fan-out is bounded by a total document budget, not only by depth (K images per level at depth 8 is K^8 loads).
//   one gradient-record row per gradient has no cap to hit: the table wraps in bands, so 20000 distinct gradients import
//          and fit a device at the 4096 MAX_TEXTURE_SIZE floor.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { tableCapacity, GRAD_COLS } = await import('../src/renderer/tableLayout.js');

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const warnings = [];
const _warn = console.warn;
console.warn = (...a) => {
  warnings.push(a.join(' '));
};
const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

console.log('SVG image fan-out budget');
for (const K of [2, 4]) {
  let calls = 0;
  const loader = async (h) => {
    calls++;
    const lvl = +/l(\d+)/.exec(h)[1];
    return (
      `<svg ${NS} viewBox="0 0 10 10"><rect width="1" height="1" fill="red"/>` +
      Array.from(
        { length: K },
        () => `<image href="l${lvl + 1}.svg" width="10" height="10"/>`,
      ).join('') +
      '</svg>'
    );
  };
  warnings.length = 0;
  const t0 = Date.now();
  const b = await importSvg(
    `<svg ${NS} viewBox="0 0 100 100"><image href="l0.svg" width="100" height="100"/></svg>`,
    { preserveViewport: true, svgTextLoader: loader },
  );
  const ms = Date.now() - t0;
  const budgeted = warnings.some((w) => /more than 4096 SVG <image> documents/.test(w));
  // 255 nested documents still all render (and are all counted against the 4096 budget), but a repeated href is decoded once per import
  // (the decode cache), so the loader runs once per DISTINCT href: one per nesting level here.
  if (K === 2)
    check(
      calls === 8 && b.numShapes >= 255 && !budgeted,
      `K=2 (255 documents) renders them all (${calls} loader calls = one per distinct href, ${b.numShapes} shapes), no budget warning`,
    );
  else
    check(
      calls <= 4096 && budgeted && b.numShapes > 0 && ms < 10000,
      `K=4 (21845 documents) stops at the budget: ${calls} loader calls, ${b.numShapes} shapes, ${ms} ms, warned`,
    );
}
{
  // the same fan-out through data: URLs, which no loader sees
  const mk = (lvl) =>
    lvl === 0
      ? '<rect width="1" height="1" fill="red"/>'
      : `<rect width="1" height="1" fill="red"/>` +
        Array.from(
          { length: 5 },
          () =>
            `<image href="data:image/svg+xml;utf8,${encodeURIComponent(`<svg ${NS} viewBox="0 0 10 10">${mk(lvl - 1)}</svg>`)}" width="10" height="10"/>`,
        ).join('');
  warnings.length = 0;
  const t0 = Date.now();
  const b = await importSvg(`<svg ${NS} viewBox="0 0 100 100">${mk(6)}</svg>`, {
    preserveViewport: true,
  }); // 5^6 = 15625 documents
  check(
    warnings.some((w) => /more than 4096 SVG <image> documents/.test(w)) &&
      b.numShapes > 0 &&
      b.numShapes <= 4096 + 16,
    `data: URL fan-out (15625 documents) is budgeted too: ${b.numShapes} shapes, ${Date.now() - t0} ms`,
  );
}

console.log('gradient table');
{
  const N = 20000;
  let defs = '',
    body = '';
  for (let i = 0; i < N; i++) {
    defs += `<linearGradient id="g${i}"><stop offset="0" stop-color="rgb(${i % 256},0,0)"/><stop offset="1" stop-color="blue"/></linearGradient>`;
    body += `<rect x="${i % 100}" y="${(i / 100) | 0}" width="1" height="1" fill="url(#g${i})"/>`;
  }
  warnings.length = 0;
  const b = await importSvg(`<svg ${NS} viewBox="0 0 100 300"><defs>${defs}</defs>${body}</svg>`, {
    preserveViewport: true,
  });
  const rows = b.gradients.byteLength / 64;
  check(rows === N, `${N} distinct gradients: ${rows} records, none dropped`);
  check(
    tableCapacity(GRAD_COLS, 4096) >= N && tableCapacity(GRAD_COLS, 2048) === 0,
    `the gradient table holds ${tableCapacity(GRAD_COLS, 4096)} rows at the 4096 floor (bands, not rows)`,
  );
  check(!warnings.some((w) => /gradient/i.test(w)), 'no warning for many gradients');
}

console.warn = _warn;
if (failures) {
  console.error(`perfRowsSmoke: ${failures} FAILED`);
  process.exit(1);
}
console.log('perfRowsSmoke: ok');
