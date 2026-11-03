// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter routing contracts: linear reductions, source restarts and named inputs.
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const { parseFilters } = await import('../../src/svg/filter.js');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const routeOf = (prims) => {
  const doc = new DP().parseFromString(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      `<filter id="f" color-interpolation-filters="sRGB">${prims}</filter></svg>`,
    'text/xml',
  );
  const f = parseFilters(doc.documentElement, null);
  return (f && f.f && f.f.kind) || 'none';
};

// ---- T1: the drop shadow keeps the fast path -------------------------
{
  const cases = [
    ['<feGaussianBlur in="SourceAlpha" stdDeviation="3"/>', 'blur'],
    ['<feGaussianBlur stdDeviation="3"/>', 'blur'],
    ['<feColorMatrix in="SourceAlpha" type="saturate" values="0"/>', 'colorMatrix'],
  ];
  const bad = [];
  for (const [prims, want] of cases) {
    const got = routeOf(prims);
    if (got !== want) bad.push(`${prims} -> ${got}, want ${want}`);
  }
  if (!bad.length) ok('T1 leading SourceAlpha folds into the matrix, staying on the fast path');
  else for (const b of bad) fail(`T1 ${b}`);
}

// ---- T2: the un-foldable sentinels reach the graph ---------------------
// These carry no matrix to fold a mask into, so the fast path cannot express
// them and must hand off. Anything but 'graph' here means a filter is being
// silently applied to the wrong input.
{
  const cases = [
    '<feConvolveMatrix in="SourceAlpha" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/>',
    '<feMorphology in="SourceAlpha" radius="2"/>',
    '<feGaussianBlur in="BackgroundImage" stdDeviation="3"/>',
    '<feGaussianBlur in="BackgroundAlpha" stdDeviation="3"/>',
  ];
  const bad = [];
  for (const prims of cases) {
    const got = routeOf(prims);
    if (got !== 'graph') bad.push(`${prims} -> ${got}, want graph`);
  }
  if (!bad.length) ok('T2 sentinels the fast path cannot express route to the graph builder');
  else for (const b of bad) fail(`T2 ${b}`);
}

// ---- T3: a mid-chain SourceAlpha is NOT foldable -----------------------
// The fold is only valid as a PREFIX. A SourceAlpha appearing after another
// primitive re-reads the original source, which a linear document-order fold
// cannot represent.
{
  const got = routeOf(
    '<feColorMatrix type="saturate" values="0.5"/>' +
      '<feGaussianBlur in="SourceAlpha" stdDeviation="3"/>',
  );
  if (got === 'graph') ok('T3 a mid-chain SourceAlpha is not folded');
  else fail(`T3 mid-chain SourceAlpha routed as '${got}' — the fold is only valid as a prefix`);
}

// ---- T4: an in= naming the previous result keeps the fast path ---------
// That is exactly what a document-order fold already assumes, so it must not
// be swept up by the sentinel guard.
{
  const got = routeOf(
    '<feColorMatrix type="saturate" values="0" result="a"/>' +
      '<feGaussianBlur in="a" stdDeviation="3"/>',
  );
  if (got === 'blur') ok('T4 in= naming the previous primitive stays on the fast path');
  else fail(`T4 explicit linear chain routed as '${got}', expected blur`);
}

// ---- T5: the guard is doing something -----------------------------------
// If parseFilters returned 'graph' for everything, T2 would pass vacuously.
// T1/T4 already cover that, so this just states it outright.
{
  if (routeOf('<feGaussianBlur stdDeviation="3"/>') === 'blur') {
    ok('T5 control: a plain blur still folds (T2 is not vacuous)');
  } else {
    fail('T5 control: even a plain blur left the fast path');
  }
}

// Explicit source restarts and branches cannot retain an earlier linear fold.
{
  const prefix = '<feColorMatrix type="saturate" values="0" result="a"/>';
  const cases = [
    prefix + '<feColorMatrix in="SourceGraphic" type="saturate" values="1"/>',
    prefix + '<feGaussianBlur in="SourceGraphic" stdDeviation="1"/>',
    prefix +
      '<feComponentTransfer in="SourceGraphic"><feFuncR type="identity"/></feComponentTransfer>',
    prefix +
      '<feColorMatrix result="b" type="saturate" values=".5"/><feGaussianBlur in="a" stdDeviation="1"/>',
    '<feFlood flood-color="red"/>',
    prefix + '<feFlood result="f"/><feComposite in="f" in2="SourceGraphic" operator="in"/>',
    '<feFlood result="f"/><feComposite in="f" operator="in"/>',
  ];
  for (const primitives of cases) {
    if (routeOf(primitives) !== 'graph') fail('T6 source/branch routing: ' + primitives);
  }
  for (const source of ['SourceGraphic', 'SourceAlpha']) {
    const primitives =
      '<feFlood result="f" flood-color="black"/>' +
      `<feComposite in="f" in2="${source}" operator="in"/>`;
    if (routeOf(primitives) !== 'colorMatrix') fail('T6 standalone tint left the fast path');
  }
}

// Missing and invalid-length values preserve the selected input as identity.
{
  const attrs = [
    '',
    'values="1 2"',
    'type="saturate" values="0 0"',
    'type="hueRotate" values="90 180"',
    'type="saturate" values="0junk"',
  ];
  for (const input of ['SourceAlpha', 'FillPaint', 'StrokePaint'])
    for (const attr of attrs) {
      const doc = new DP().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><filter id="f" color-interpolation-filters="sRGB"><feColorMatrix in="' +
          input +
          '" ' +
          attr +
          '/></filter></svg>',
        'text/xml',
      );
      const record = parseFilters(doc.documentElement, null).f;
      const expected = input === 'SourceAlpha' ? -2 : input === 'FillPaint' ? -5 : -6;
      if (input === 'SourceAlpha') {
        if (!record || record.kind === 'unsupported') fail('identity SourceAlpha is supported');
      } else {
        const node = record?.graph?.nodes?.[0];
        if (
          node?.inputs[0] !== expected ||
          node.params.matrix.join(',') !== '1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0'
        )
          fail('default/malformed matrix retains ' + input);
      }
    }
}

console.log();
console.log(failures === 0 ? 'FILTER-ROUTE PASS' : `FILTER-ROUTE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
